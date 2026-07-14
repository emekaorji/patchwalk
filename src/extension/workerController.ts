import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import * as vscode from 'vscode';
import WebSocket from 'ws';

import type {
    PatchwalkPlaybackExecuteMessage,
    PatchwalkPlaybackFailedMessage,
    PatchwalkPlaybackNextMessage,
    PatchwalkPlaybackPauseMessage,
    PatchwalkPlaybackPrepareMessage,
    PatchwalkPlaybackPreviousMessage,
    PatchwalkPlaybackProgressMessage,
    PatchwalkPlaybackReadyMessage,
    PatchwalkPlaybackResumeMessage,
    PatchwalkPlaybackStartedMessage,
    PatchwalkPlaybackStopMessage,
    PatchwalkWalkOwnerMessage,
    PatchwalkWorkerHeartbeatMessage,
    PatchwalkWorkerRegisterMessage,
    PatchwalkWorkerToDaemonMessage,
    PatchwalkWorkerUpdateMessage,
} from '../lib/controlProtocol';
import {
    MAXIMUM_RECONNECT_DELAY_MS,
    PATCHWALK_DEFAULT_HEARTBEAT_INTERVAL_MS,
    PATCHWALK_DEFAULT_RECONNECT_DELAY_MS,
    PATCHWALK_WORKER_API_VERSION,
    patchwalkDaemonToWorkerMessageSchema,
} from '../lib/controlProtocol';
import { normalizeAbsolutePath } from '../lib/pathUtils';
import { matchBasePathToWorkspaceRoots } from '../lib/routing';
import type { PatchwalkHandoffPayload, PatchwalkNarrationStyle } from '../lib/schema';
import { PATCHWALK_DEFAULT_NARRATION_STYLE } from '../lib/schema';
import { PatchwalkDaemonClient } from './daemonClient';
import type { PatchwalkPlaybackRun, PatchwalkPlaybackRunner } from './playback';
import { revealWindowForPath } from './revealWindow';
import type { WalkMonitorDaemonStatus } from './sidebar/walkMonitorModel';
import type { DaemonStatusController } from './sidebar/walkMonitorView';
import type { RemoteWalkSource, RemoteWalkState } from './statusSignal';
import type { WalkProgress } from './walkSequencer';

interface ActivePlaybackHandle {
    run: PatchwalkPlaybackRun;
    dispatchId: string;
    handoffId: string;
    progressSubscription: { dispose(): void };
}

interface PatchwalkWorkerControllerOptions {
    context: vscode.ExtensionContext;
    daemonPort: number;
    outputChannel: vscode.OutputChannel;
    playbackRunner: PatchwalkPlaybackRunner;
}

/**
 * The worker controller is the extension-side control plane. It keeps the daemon alive, maintains
 * one persistent worker socket, and translates daemon messages into local playback actions.
 */
export class PatchwalkWorkerController
    implements vscode.Disposable, DaemonStatusController, RemoteWalkSource
{
    private readonly workerId = randomUUID();
    private readonly daemonClient: PatchwalkDaemonClient;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly statusChangeEmitter = new vscode.EventEmitter<void>();
    private readonly remoteWalkChangeEmitter = new vscode.EventEmitter<void>();
    private heartbeatTimer: NodeJS.Timeout | undefined;
    private reconnectTimer: NodeJS.Timeout | undefined;
    private socket: WebSocket | undefined;
    private connectionPromise: Promise<void> | undefined;
    private messageQueue: Promise<void> = Promise.resolve();
    private stopping = false;
    private reconnectAttempts = 0;
    private portConflictReported = false;
    private daemonManagementEnabled = true;
    private heartbeatIntervalMs = PATCHWALK_DEFAULT_HEARTBEAT_INTERVAL_MS;
    private activePlayback: ActivePlaybackHandle | undefined;
    /** The active walk as seen from THIS window — only set when it plays in a DIFFERENT window. */
    private remoteWalk: RemoteWalkState = { active: false };

    public constructor(private readonly options: PatchwalkWorkerControllerOptions) {
        this.daemonClient = new PatchwalkDaemonClient({
            daemonEntryPath: path.join(
                options.context.extensionPath,
                'out',
                'src',
                'daemon',
                'index.js',
            ),
            port: options.daemonPort,
        });
    }

    public onDidChange(listener: () => void): vscode.Disposable {
        return this.statusChangeEmitter.event(listener);
    }

    public onDidChangeRemoteWalk(listener: () => void): vscode.Disposable {
        return this.remoteWalkChangeEmitter.event(listener);
    }

    /** The active walk as seen from this window (active only when it plays elsewhere). */
    public getRemoteWalk(): RemoteWalkState {
        return this.remoteWalk;
    }

    /** Raise the window currently playing a walk (best-effort; there is no window-focus API). */
    public async revealPlayingWindow(): Promise<void> {
        if (!this.remoteWalk.active || !this.remoteWalk.revealPath) {
            await vscode.window.showInformationMessage(
                'No Patchwalk walk is playing in another window.',
            );
            return;
        }
        const revealed = revealWindowForPath(this.remoteWalk.revealPath, (message) =>
            this.options.outputChannel.appendLine(message),
        );
        if (!revealed) {
            await vscode.window.showInformationMessage(
                `Patchwalk is playing in the window for ${this.remoteWalk.revealPath}.`,
            );
        }
    }

    /** Daemon/connection summary for the sidebar's Daemon status line. */
    public async getStatus(): Promise<WalkMonitorDaemonStatus> {
        const connected = this.isSocketOpen();
        const workspaceRoots = await this.collectWorkspaceRoots();
        // The daemon pushes ownership via `walk.owner`, so this stays live without a status round-trip.
        const activeWalkElsewhere = this.remoteWalk.active;

        const detail = connected
            ? workspaceRoots.length > 0
                ? `Connected · ${workspaceRoots.length} workspace root${
                      workspaceRoots.length === 1 ? '' : 's'
                  }`
                : 'Connected'
            : this.daemonManagementEnabled
              ? 'Reconnecting…'
              : 'Daemon stopped';
        return { connected, detail, activeWalkElsewhere };
    }

    public async start(): Promise<void> {
        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.refreshRegistration().catch((error: unknown) => {
                    this.reportError('Patchwalk workspace registration refresh failed', error);
                });
            }),
            // The narration style rewrites the daemon's instructions to authoring agents, so the
            // daemon must be told the moment it changes — not on the next reload.
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (!event.affectsConfiguration('patchwalk.narrationStyle')) {
                    return;
                }
                this.refreshRegistration().catch((error: unknown) => {
                    this.reportError('Patchwalk narration-style refresh failed', error);
                });
            }),
        );

        try {
            await this.ensureConnected();
        } catch (error) {
            this.reportError('Patchwalk worker failed initial connection', error);
            this.scheduleReconnect();
        }
    }

    public async restartDaemon(): Promise<void> {
        this.daemonManagementEnabled = true;
        this.clearReconnectTimer();
        this.closeSocket();

        try {
            await this.daemonClient.shutdown();
        } catch {
            // The daemon may already be down. The next ensureConnected call repairs it.
        }

        await this.ensureConnected();
    }

    public async showStatus(): Promise<void> {
        const status = await this.daemonClient.readStatusResource();
        this.options.outputChannel.clear();
        this.options.outputChannel.appendLine(JSON.stringify(status, null, 2));
        this.options.outputChannel.show(true);

        // Status reads should still opportunistically heal a disconnected worker socket.
        if (!this.isSocketOpen()) {
            this.scheduleReconnect();
        }
    }

    public async stopDaemon(): Promise<void> {
        this.daemonManagementEnabled = false;
        this.clearReconnectTimer();
        this.closeSocket();
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        await this.daemonClient.shutdown();
    }

    public async routeClipboardPlayback(payload: PatchwalkHandoffPayload): Promise<void> {
        await this.ensureConnected();
        await this.daemonClient.dispatchPlayback(payload);
    }

    public dispose(): void {
        this.stopping = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        this.clearReconnectTimer();
        this.closeSocket();
        this.statusChangeEmitter.dispose();
        this.remoteWalkChangeEmitter.dispose();

        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private async ensureConnected(): Promise<void> {
        if (!this.daemonManagementEnabled) {
            return;
        }

        if (this.isSocketOpen()) {
            return;
        }

        if (this.connectionPromise) {
            await this.connectionPromise;
            return;
        }

        this.connectionPromise = this.ensureConnectedInternal().finally(() => {
            this.connectionPromise = undefined;
        });
        await this.connectionPromise;
    }

    private async ensureConnectedInternal(): Promise<void> {
        await this.daemonClient.ensureServerRunning();
        await this.connectSocket();
        this.startHeartbeatLoop();
        this.statusChangeEmitter.fire();
    }

    private async connectSocket(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(this.daemonClient.workerSocketUrl);
            const handleError = (error: Error) => {
                socket.off('error', handleError);
                reject(error);
            };

            const handleOpen = () => {
                socket.off('open', handleOpen);
                socket.off('error', handleError);
                this.bindSocket(socket);
                this.sendMessage(this.createRegisterMessage()).then(resolve).catch(reject);
            };

            socket.once('open', handleOpen);
            socket.once('error', handleError);
        });
    }

    private bindSocket(socket: WebSocket): void {
        this.closeSocket();
        this.socket = socket;

        socket.on('message', (rawData: WebSocket.RawData) => {
            this.messageQueue = this.messageQueue
                .catch(() => {
                    // Keep the serial message queue alive after a failed handler.
                })
                .then(async () => {
                    await this.handleSocketMessage(rawData);
                });
        });

        socket.on('close', () => {
            if (this.socket === socket) {
                this.socket = undefined;
            }
            // We can no longer trust who owns the walk until the daemon re-informs us on reconnect.
            if (this.remoteWalk.active) {
                this.remoteWalk = { active: false };
                this.remoteWalkChangeEmitter.fire();
            }
            this.statusChangeEmitter.fire();

            if (!this.stopping && this.daemonManagementEnabled) {
                this.scheduleReconnect();
            }
        });

        socket.on('error', (error: Error) => {
            this.reportError('Patchwalk worker socket error', error);
        });
    }

    private closeSocket(): void {
        if (!this.socket) {
            return;
        }

        this.socket.removeAllListeners();
        this.socket.close();
        this.socket = undefined;
    }

    private startHeartbeatLoop(): void {
        if (!this.daemonManagementEnabled) {
            return;
        }

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        this.heartbeatTimer = setInterval(() => {
            if (this.stopping) {
                return;
            }

            this.sendHeartbeat().catch((error: unknown) => {
                this.reportError('Patchwalk heartbeat failed', error);
            });
        }, this.heartbeatIntervalMs);
    }

    private async sendHeartbeat(): Promise<void> {
        if (!this.daemonManagementEnabled) {
            return;
        }

        if (!this.isSocketOpen()) {
            await this.ensureConnected();
        }

        await this.sendMessage(this.createHeartbeatMessage());
    }

    private async refreshRegistration(): Promise<void> {
        await this.ensureConnected();
        await this.sendMessage(this.createUpdateMessage());
    }

    /**
     * Back off on repeated failures. A fixed 1s retry against an unreachable daemon is a hot loop:
     * every attempt shells out to `lsof`, so a permanently-blocked port turns into a process storm
     * that the user never sees and never gets told about.
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimer || !this.daemonManagementEnabled) {
            return;
        }

        const delayMs = Math.min(
            PATCHWALK_DEFAULT_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
            MAXIMUM_RECONNECT_DELAY_MS,
        );
        this.reconnectAttempts += 1;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.ensureConnected()
                .then(() => {
                    this.reconnectAttempts = 0;
                })
                .catch((error: unknown) => {
                    if (this.isPortBlockedError(error)) {
                        // Someone else owns the port. Retrying can never fix that, so stop and say so.
                        this.reportPortConflict(error);
                        return;
                    }
                    this.reportError('Patchwalk worker reconnect failed', error);
                    this.scheduleReconnect();
                });
        }, delayMs);
    }

    private isPortBlockedError(error: unknown): boolean {
        return error instanceof Error && /held by a non-Patchwalk process/.test(error.message);
    }

    /** Terminal: stop retrying, tell the user once, and offer the only two things that help. */
    private reportPortConflict(error: unknown): void {
        this.daemonManagementEnabled = false;
        this.clearReconnectTimer();
        if (this.portConflictReported) {
            return;
        }
        this.portConflictReported = true;

        const message = error instanceof Error ? error.message : String(error);
        this.options.outputChannel.appendLine(message);
        void vscode.window
            .showErrorMessage(
                `Patchwalk could not start: port ${this.options.daemonPort} is in use by another program.`,
                'Change port',
                'Retry',
            )
            .then((choice) => {
                if (choice === 'Change port') {
                    void vscode.commands.executeCommand(
                        'workbench.action.openSettings',
                        'patchwalk.daemonPort',
                    );
                    return;
                }
                if (choice === 'Retry') {
                    this.portConflictReported = false;
                    this.daemonManagementEnabled = true;
                    this.reconnectAttempts = 0;
                    this.scheduleReconnect();
                }
            });
    }

    private clearReconnectTimer(): void {
        if (!this.reconnectTimer) {
            return;
        }

        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
    }

    private async handleSocketMessage(rawData: WebSocket.RawData): Promise<void> {
        let parsedValue: unknown;
        try {
            parsedValue = JSON.parse(String(rawData));
        } catch {
            this.options.outputChannel.appendLine(
                'Patchwalk worker received non-JSON daemon message.',
            );
            return;
        }

        const parsedMessage = patchwalkDaemonToWorkerMessageSchema.safeParse(parsedValue);
        if (!parsedMessage.success) {
            this.options.outputChannel.appendLine(
                `Patchwalk worker received invalid daemon message: ${
                    parsedMessage.error.issues[0]?.message ?? 'Unknown error'
                }`,
            );
            return;
        }

        const message = parsedMessage.data;
        switch (message.type) {
            case 'playback.prepare':
                await this.handlePrepareMessage(message);
                return;
            case 'playback.execute':
                await this.handleExecuteMessage(message);
                return;
            case 'playback.stop':
                await this.handleStopMessage(message);
                return;
            case 'playback.pause':
                this.handlePauseMessage(message);
                return;
            case 'playback.resume':
                this.handleResumeMessage(message);
                return;
            case 'playback.next':
                this.handleNextMessage(message);
                return;
            case 'playback.previous':
                this.handlePreviousMessage(message);
                return;
            case 'worker.reconcile':
                await this.refreshRegistration();
                return;
            case 'walk.owner':
                this.handleWalkOwnerMessage(message);
                return;
        }
    }

    private handleWalkOwnerMessage(message: PatchwalkWalkOwnerMessage): void {
        // "Remote" means the walk is playing in a DIFFERENT window; the local window shows its own
        // rich badge from the playback runner, so we suppress the "elsewhere" signal for ourselves.
        const isLocal = message.ownerWorkerId === this.workerId;
        const next: RemoteWalkState =
            message.active && !isLocal
                ? { active: true, revealPath: message.revealPath }
                : { active: false };

        if (
            next.active === this.remoteWalk.active &&
            next.revealPath === this.remoteWalk.revealPath
        ) {
            return;
        }
        this.remoteWalk = next;
        this.remoteWalkChangeEmitter.fire();
        // The sidebar's Daemon line also reflects "a walk is playing in another window".
        this.statusChangeEmitter.fire();
    }

    private async handlePrepareMessage(message: PatchwalkPlaybackPrepareMessage): Promise<void> {
        const workspaceRoots = await this.collectWorkspaceRoots();
        const match = matchBasePathToWorkspaceRoots(message.basePath, workspaceRoots);
        const playbackState = this.options.playbackRunner.getStateSnapshot();

        // Positive ack: the daemon proceeds only when it receives this, so a wedged or busy window
        // can never silently swallow a walk (P3). Availability requires an idle runner and a match.
        if (match && playbackState.state === 'idle' && !this.activePlayback) {
            await this.sendMessage(
                this.createPlaybackReadyMessage(message.dispatchId, message.handoffId),
            );
            return;
        }

        await this.sendMessage(
            this.createPlaybackFailedMessage(
                message.dispatchId,
                message.handoffId,
                'prepare',
                'unavailable',
                'Worker can no longer serve the requested basePath.',
            ),
        );
    }

    private async handleExecuteMessage(message: PatchwalkPlaybackExecuteMessage): Promise<void> {
        const dispatchId = message.dispatchId;
        const handoffId = message.payload.handoffId;

        if (this.activePlayback) {
            await this.sendMessage(
                this.createPlaybackFailedMessage(
                    dispatchId,
                    handoffId,
                    'execute',
                    'execution_failed',
                    'Worker already has an active walk.',
                ),
            );
            return;
        }

        let run: PatchwalkPlaybackRun;
        try {
            // NOTE: play() returns a control handle synchronously and runs the walk in the
            // background. The message queue is therefore NOT held for the walk's duration, which
            // is what lets stop/pause/next messages interrupt it (P1).
            run = this.options.playbackRunner.play(message.payload);
        } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            await this.sendMessage(
                this.createPlaybackFailedMessage(
                    dispatchId,
                    handoffId,
                    'execute',
                    'execution_failed',
                    messageText,
                ),
            );
            return;
        }

        const stepsPlayed = message.payload.walkthrough.length;
        const progressSubscription = run.onDidProgress((progress) => {
            this.emitToDaemon(this.createProgressMessage(dispatchId, handoffId, progress));
        });
        this.activePlayback = { run, dispatchId, handoffId, progressSubscription };

        // Launch ack (P2): the daemon resolves patchwalk.play on THIS, never on completion.
        await this.sendMessage(
            this.createPlaybackStartedMessage(dispatchId, handoffId, run.getSnapshot().stepCount),
        );

        run.completion
            .then(() => {
                this.emitToDaemon({
                    type: 'playback.completed',
                    messageId: randomUUID(),
                    workerId: this.workerId,
                    sentAt: new Date().toISOString(),
                    dispatchId,
                    handoffId,
                    stepsPlayed,
                });
            })
            .catch((error: unknown) => {
                // The run's completion is the single source of the terminal message, so a walk
                // stopped from the sidebar (locally) still notifies the daemon and releases the
                // machine-wide lock — not only walks stopped via the daemon's stop tool.
                if (error instanceof Error && error.name === 'PatchwalkPlaybackStoppedError') {
                    this.emitToDaemon({
                        type: 'playback.stopped',
                        messageId: randomUUID(),
                        workerId: this.workerId,
                        sentAt: new Date().toISOString(),
                        dispatchId,
                        handoffId,
                    });
                    return;
                }
                const messageText = error instanceof Error ? error.message : String(error);
                this.emitToDaemon(
                    this.createPlaybackFailedMessage(
                        dispatchId,
                        handoffId,
                        'execute',
                        'execution_failed',
                        messageText,
                    ),
                );
            })
            .finally(() => {
                progressSubscription.dispose();
                if (this.activePlayback?.run === run) {
                    this.activePlayback = undefined;
                }
            });
    }

    private handlePauseMessage(message: PatchwalkPlaybackPauseMessage): void {
        if (this.activePlayback?.dispatchId === message.dispatchId) {
            this.activePlayback.run.pause();
        }
    }

    private handleResumeMessage(message: PatchwalkPlaybackResumeMessage): void {
        if (this.activePlayback?.dispatchId === message.dispatchId) {
            this.activePlayback.run.resume();
        }
    }

    private handleNextMessage(message: PatchwalkPlaybackNextMessage): void {
        if (this.activePlayback?.dispatchId === message.dispatchId) {
            this.activePlayback.run.next();
        }
    }

    private handlePreviousMessage(message: PatchwalkPlaybackPreviousMessage): void {
        if (this.activePlayback?.dispatchId === message.dispatchId) {
            this.activePlayback.run.previous();
        }
    }

    private emitToDaemon(message: PatchwalkWorkerToDaemonMessage): void {
        this.sendMessage(message).catch((error: unknown) => {
            this.reportError('Patchwalk worker failed to send message', error);
        });
    }

    private async handleStopMessage(message: PatchwalkPlaybackStopMessage): Promise<void> {
        try {
            // The run's completion handler emits `playback.stopped`; here we only need to trigger
            // the stop and report when there was nothing to stop.
            const stopped = await this.options.playbackRunner.stopActivePlayback();
            if (!stopped) {
                await this.sendMessage(
                    this.createPlaybackFailedMessage(
                        message.dispatchId,
                        message.handoffId,
                        'stop',
                        'unavailable',
                        'No active Patchwalk walk was running in this worker.',
                    ),
                );
            }
        } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            await this.sendMessage(
                this.createPlaybackFailedMessage(
                    message.dispatchId,
                    message.handoffId,
                    'stop',
                    'stop_failed',
                    messageText,
                ),
            );
        }
    }

    private createRegisterMessage(): PatchwalkWorkerRegisterMessage {
        return {
            type: 'worker.register',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            processId: process.pid,
            extensionVersion: this.options.context.extension.packageJSON.version,
            workspaceRoots: [],
            lastSeenAt: new Date().toISOString(),
            apiVersion: PATCHWALK_WORKER_API_VERSION,
            narrationStyle: this.readNarrationStyle(),
            ...this.createWorkerRuntimeState(),
        };
    }

    private createUpdateMessage(): PatchwalkWorkerUpdateMessage {
        return {
            type: 'worker.update',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            workspaceRoots: [],
            lastSeenAt: new Date().toISOString(),
            ...this.createWorkerRuntimeState(),
        };
    }

    private createHeartbeatMessage(): PatchwalkWorkerHeartbeatMessage {
        return {
            type: 'worker.heartbeat',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            ...this.createWorkerRuntimeState(),
        };
    }

    private createPlaybackFailedMessage(
        dispatchId: string,
        handoffId: string,
        phase: PatchwalkPlaybackFailedMessage['phase'],
        reasonCode: PatchwalkPlaybackFailedMessage['reasonCode'],
        error: string,
    ): PatchwalkPlaybackFailedMessage {
        return {
            type: 'playback.failed',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            dispatchId,
            handoffId,
            phase,
            reasonCode,
            error,
        };
    }

    private createPlaybackReadyMessage(
        dispatchId: string,
        handoffId: string,
    ): PatchwalkPlaybackReadyMessage {
        return {
            type: 'playback.ready',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            dispatchId,
            handoffId,
        };
    }

    private createPlaybackStartedMessage(
        dispatchId: string,
        handoffId: string,
        stepCount: number,
    ): PatchwalkPlaybackStartedMessage {
        return {
            type: 'playback.started',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            dispatchId,
            handoffId,
            stepCount,
        };
    }

    private createProgressMessage(
        dispatchId: string,
        handoffId: string,
        progress: WalkProgress,
    ): PatchwalkPlaybackProgressMessage {
        return {
            type: 'playback.progress',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            dispatchId,
            handoffId,
            stepIndex: progress.stepIndex,
            stepCount: progress.stepCount,
            stepId: progress.stepId,
            playbackState: progress.state,
        };
    }

    private createWorkerRuntimeState() {
        const playbackState = this.options.playbackRunner.getStateSnapshot();
        return {
            playbackState: playbackState.state,
            ...(playbackState.activeHandoffId
                ? { activeHandoffId: playbackState.activeHandoffId }
                : {}),
        };
    }

    /**
     * The narration style the daemon should hand to authoring agents. The setting is
     * application-scoped (global only), so every window reports the same value and the daemon can
     * trust whichever report arrives last.
     */
    private readNarrationStyle(): PatchwalkNarrationStyle {
        const configured = vscode.workspace
            .getConfiguration('patchwalk')
            .get<string>('narrationStyle', PATCHWALK_DEFAULT_NARRATION_STYLE);
        return configured === 'grounded' ? 'grounded' : 'terse';
    }

    private async collectWorkspaceRoots(): Promise<string[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const normalizedRoots = await Promise.all(
            workspaceFolders.map((workspaceFolder) =>
                normalizeAbsolutePath(workspaceFolder.uri.fsPath),
            ),
        );

        return [...new Set(normalizedRoots)].sort((leftRoot, rightRoot) =>
            leftRoot.localeCompare(rightRoot),
        );
    }

    private async sendMessage(message: PatchwalkWorkerToDaemonMessage): Promise<void> {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error('Patchwalk worker socket is not connected.');
        }

        let enrichedMessage: PatchwalkWorkerToDaemonMessage = message;
        if (message.type === 'worker.register' || message.type === 'worker.update') {
            enrichedMessage = {
                ...message,
                workspaceRoots: await this.collectWorkspaceRoots(),
                lastSeenAt: new Date().toISOString(),
                narrationStyle: this.readNarrationStyle(),
                ...this.createWorkerRuntimeState(),
            };
        } else if (message.type === 'worker.heartbeat') {
            enrichedMessage = {
                ...message,
                lastSeenAt: new Date().toISOString(),
                ...this.createWorkerRuntimeState(),
            };
        }

        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error('Patchwalk worker socket disconnected before the message was sent.');
        }

        this.socket.send(JSON.stringify(enrichedMessage));
    }

    private isSocketOpen(): boolean {
        return this.socket?.readyState === WebSocket.OPEN;
    }

    private reportError(contextMessage: string, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.options.outputChannel.appendLine(`${contextMessage}: ${message}`);
    }
}
