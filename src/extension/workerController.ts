import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import * as vscode from 'vscode';
import WebSocket from 'ws';

import type {
    PatchwalkPlaybackExecuteMessage,
    PatchwalkPlaybackFailedMessage,
    PatchwalkPlaybackPrepareMessage,
    PatchwalkPlaybackStopMessage,
    PatchwalkWorkerHeartbeatMessage,
    PatchwalkWorkerRegisterMessage,
    PatchwalkWorkerToDaemonMessage,
    PatchwalkWorkerUpdateMessage,
} from '../lib/controlProtocol';
import {
    PATCHWALK_DEFAULT_HEARTBEAT_INTERVAL_MS,
    PATCHWALK_DEFAULT_RECONNECT_DELAY_MS,
    PATCHWALK_WORKER_API_VERSION,
    patchwalkDaemonToWorkerMessageSchema,
} from '../lib/controlProtocol';
import { normalizeAbsolutePath } from '../lib/pathUtils';
import { matchBasePathToWorkspaceRoots } from '../lib/routing';
import type { PatchwalkHandoffPayload } from '../lib/schema';
import { PatchwalkDaemonClient } from './daemonClient';
import type { PatchwalkPlaybackRunner } from './playback';

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
export class PatchwalkWorkerController implements vscode.Disposable {
    private readonly workerId = randomUUID();
    private readonly daemonClient: PatchwalkDaemonClient;
    private readonly disposables: vscode.Disposable[] = [];
    private heartbeatTimer: NodeJS.Timeout | undefined;
    private reconnectTimer: NodeJS.Timeout | undefined;
    private socket: WebSocket | undefined;
    private connectionPromise: Promise<void> | undefined;
    private messageQueue: Promise<void> = Promise.resolve();
    private stopping = false;
    private daemonManagementEnabled = true;
    private heartbeatIntervalMs = PATCHWALK_DEFAULT_HEARTBEAT_INTERVAL_MS;

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

    public async start(): Promise<void> {
        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.refreshRegistration().catch((error: unknown) => {
                    this.reportError('Patchwalk workspace registration refresh failed', error);
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

    private scheduleReconnect(): void {
        if (this.reconnectTimer || !this.daemonManagementEnabled) {
            return;
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.ensureConnected().catch((error: unknown) => {
                this.reportError('Patchwalk worker reconnect failed', error);
                this.scheduleReconnect();
            });
        }, PATCHWALK_DEFAULT_RECONNECT_DELAY_MS);
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
            case 'worker.reconcile':
                await this.refreshRegistration();
                return;
        }
    }

    private async handlePrepareMessage(message: PatchwalkPlaybackPrepareMessage): Promise<void> {
        const workspaceRoots = await this.collectWorkspaceRoots();
        const match = matchBasePathToWorkspaceRoots(message.basePath, workspaceRoots);
        const playbackState = this.options.playbackRunner.getStateSnapshot();

        if (!match || playbackState.state !== 'idle') {
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
    }

    private async handleExecuteMessage(message: PatchwalkPlaybackExecuteMessage): Promise<void> {
        try {
            await this.options.playbackRunner.play(message.payload);
            await this.sendMessage({
                type: 'playback.completed',
                messageId: randomUUID(),
                workerId: this.workerId,
                sentAt: new Date().toISOString(),
                dispatchId: message.dispatchId,
                handoffId: message.payload.handoffId,
                stepsPlayed: message.payload.walkthrough.length,
            });
        } catch (error) {
            if (error instanceof Error && error.name === 'PatchwalkPlaybackStoppedError') {
                return;
            }

            const messageText = error instanceof Error ? error.message : String(error);
            await this.sendMessage(
                this.createPlaybackFailedMessage(
                    message.dispatchId,
                    message.payload.handoffId,
                    'execute',
                    'execution_failed',
                    messageText,
                ),
            );
        }
    }

    private async handleStopMessage(message: PatchwalkPlaybackStopMessage): Promise<void> {
        try {
            const stopped = await this.options.playbackRunner.stopActivePlayback();
            if (!stopped) {
                await this.sendMessage(
                    this.createPlaybackFailedMessage(
                        message.dispatchId,
                        message.handoffId,
                        'stop',
                        'unavailable',
                        'No active Patchwalk playback was running in this worker.',
                    ),
                );
                return;
            }

            await this.sendMessage({
                type: 'playback.stopped',
                messageId: randomUUID(),
                workerId: this.workerId,
                sentAt: new Date().toISOString(),
                dispatchId: message.dispatchId,
                handoffId: message.handoffId,
            });
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

    private createWorkerRuntimeState() {
        const playbackState = this.options.playbackRunner.getStateSnapshot();
        return {
            playbackState: playbackState.state,
            ...(playbackState.activeHandoffId
                ? { activeHandoffId: playbackState.activeHandoffId }
                : {}),
        };
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
