import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import * as vscode from 'vscode';

import type {
    PatchwalkPlaybackCancelEvent,
    PatchwalkPlaybackClaimEvent,
    PatchwalkPlaybackExecuteEvent,
    PatchwalkWorkerEvent,
} from '../lib/controlProtocol';
import {
    PATCHWALK_DEFAULT_HEARTBEAT_INTERVAL_MS,
    PATCHWALK_DEFAULT_POLL_INTERVAL_MS,
    PATCHWALK_WORKER_API_VERSION,
} from '../lib/controlProtocol';
import { normalizeAbsolutePath } from '../lib/pathUtils';
import { matchBasePathToWorkspaceRoots } from '../lib/routing';
import type { PatchwalkHandoffPayload } from '../lib/schema';
import { PatchwalkDaemonClient } from './daemonClient';
import type { PatchwalkPlaybackRunner } from './playback';

/**
 * The worker controller is the extension-side control plane. It keeps the daemon alive, registers
 * this window's workspace roots, and translates daemon events into local playback actions.
 */
interface PatchwalkWorkerControllerOptions {
    context: vscode.ExtensionContext;
    daemonPort: number;
    outputChannel: vscode.OutputChannel;
    playbackRunner: PatchwalkPlaybackRunner;
}

export class PatchwalkWorkerController implements vscode.Disposable {
    /**
     * Every window gets its own stable worker id so the daemon can track it across heartbeats.
     */
    private readonly workerId = randomUUID();
    private readonly daemonClient: PatchwalkDaemonClient;
    private readonly disposables: vscode.Disposable[] = [];
    private heartbeatTimer: NodeJS.Timeout | undefined;
    private connectionPromise: Promise<void> | undefined;
    private pollLoop: Promise<void> | undefined;
    private stopping = false;
    /**
     * This flag lets the debug stop command keep the daemon down until the user opts back in.
     */
    private daemonManagementEnabled = true;
    private heartbeatIntervalMs = PATCHWALK_DEFAULT_HEARTBEAT_INTERVAL_MS;
    private pollIntervalMs = PATCHWALK_DEFAULT_POLL_INTERVAL_MS;

    public constructor(private readonly options: PatchwalkWorkerControllerOptions) {
        // The extension always spawns the bundled daemon artifact rather than assuming a global install.
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
        // Registration happens first so the window can participate in routing before polling starts.
        await this.ensureConnected();

        this.disposables.push(
            // Workspace ownership can change while the window is open, so keep the daemon updated.
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.refreshRegistration().catch((error: unknown) => {
                    this.reportError('Patchwalk workspace registration refresh failed', error);
                });
            }),
        );

        this.startHeartbeatLoop();
        this.startPollLoop();
    }

    public async restartDaemon(): Promise<void> {
        this.daemonManagementEnabled = true;
        try {
            await this.daemonClient.shutdown();
        } catch {
            // The daemon may already be down. The next ensureConnected call repairs it.
        }

        await this.ensureConnected();
        this.startPollLoop();
    }

    public async showStatus(): Promise<void> {
        await this.ensureConnected();
        // Surface the daemon's own status resource so debugging uses the same truth as MCP clients.
        const status = await this.daemonClient.readStatusResource();
        this.options.outputChannel.clear();
        this.options.outputChannel.appendLine(JSON.stringify(status, null, 2));
        this.options.outputChannel.show(true);
    }

    public async stopDaemon(): Promise<void> {
        // This is a deliberate debug escape hatch, so also pause the self-healing behavior.
        this.daemonManagementEnabled = false;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        await this.daemonClient.shutdown();
    }

    public async routeClipboardPlayback(payload: PatchwalkHandoffPayload): Promise<void> {
        await this.ensureConnected();
        // Clipboard playback intentionally goes through the daemon so manual tests exercise routing.
        await this.daemonClient.dispatchPlayback(payload);
    }

    public dispose(): void {
        // Disposal only needs to stop timers and listeners; the daemon keeps running independently.
        this.stopping = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private startHeartbeatLoop(): void {
        if (!this.daemonManagementEnabled) {
            return;
        }

        if (this.heartbeatTimer) {
            // Timer cadence can change after registration, so replace any older interval.
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

    private startPollLoop(): void {
        if (!this.daemonManagementEnabled || this.pollLoop) {
            return;
        }

        // Keep one outstanding long-poll at a time per window to avoid duplicate event handling.
        this.pollLoop = this.pollForEvents().finally(() => {
            this.pollLoop = undefined;
        });
    }

    private async ensureConnected(): Promise<void> {
        if (!this.daemonManagementEnabled) {
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
        // Health-check and auto-spawn are centralized inside the daemon client.
        await this.daemonClient.ensureServerRunning();

        const registration = await this.daemonClient.registerWorker({
            workerId: this.workerId,
            processId: process.pid,
            extensionVersion: this.options.context.extension.packageJSON.version,
            workspaceRoots: await this.collectWorkspaceRoots(),
            lastSeenAt: new Date().toISOString(),
            apiVersion: PATCHWALK_WORKER_API_VERSION,
        });

        // The daemon is allowed to tune worker cadence over time without changing extension code.
        this.heartbeatIntervalMs = registration.heartbeatIntervalMs;
        this.pollIntervalMs = registration.pollIntervalMs;
        this.startHeartbeatLoop();
    }

    private async refreshRegistration(): Promise<void> {
        try {
            // Re-registering is cheap and doubles as a daemon-reconnect path.
            await this.ensureConnected();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.options.outputChannel.appendLine(
                `Patchwalk worker registration refresh failed: ${message}`,
            );
        }
    }

    private async sendHeartbeat(): Promise<void> {
        if (!this.daemonManagementEnabled) {
            return;
        }

        try {
            await this.daemonClient.sendHeartbeat(this.workerId, {
                workspaceRoots: await this.collectWorkspaceRoots(),
                lastSeenAt: new Date().toISOString(),
            });
        } catch {
            // Missing heartbeats usually mean the daemon restarted; reconnect instead of surfacing noise.
            await this.ensureConnected();
        }
    }

    private async pollForEvents(): Promise<void> {
        if (this.stopping || !this.daemonManagementEnabled) {
            return;
        }

        try {
            const events = await this.daemonClient.pollEvents(
                this.workerId,
                Math.max(this.pollIntervalMs * 25, 10_000),
            );

            // Preserve event order so claim/execute/cancel flow stays deterministic.
            await events.reduce<Promise<void>>(async (queue, event) => {
                await queue;
                await this.handleEvent(event);
            }, Promise.resolve());
        } catch (error) {
            this.reportError('Patchwalk worker poll failed', error);

            try {
                await this.ensureConnected();
            } catch (reconnectError) {
                this.reportError('Patchwalk worker reconnect failed', reconnectError);
            }

            await new Promise((resolve) => {
                setTimeout(resolve, this.pollIntervalMs);
            });
        }

        if (!this.stopping && this.daemonManagementEnabled) {
            await this.pollForEvents();
        }
    }

    private async collectWorkspaceRoots(): Promise<string[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const normalizedRoots = await Promise.all(
            workspaceFolders.map((workspaceFolder) =>
                normalizeAbsolutePath(workspaceFolder.uri.fsPath),
            ),
        );

        // Sort roots so duplicate registrations are stable and easy to compare server-side.
        return [...new Set(normalizedRoots)].sort((leftRoot, rightRoot) =>
            leftRoot.localeCompare(rightRoot),
        );
    }

    private async handleEvent(event: PatchwalkWorkerEvent): Promise<void> {
        // Worker events are intentionally exhaustive so unexpected daemon messages fail at the type level.
        switch (event.type) {
            case 'playback.claim':
                await this.handleClaimEvent(event);
                return;
            case 'playback.execute':
                await this.handleExecuteEvent(event);
                return;
            case 'playback.cancel':
                this.handleCancelEvent(event);
                return;
            case 'worker.reconcile':
                await this.refreshRegistration();
                return;
        }
    }

    private async handleClaimEvent(event: PatchwalkPlaybackClaimEvent): Promise<void> {
        // Workers decide only whether they can serve the base path, never whether they should win.
        const workspaceRoots = await this.collectWorkspaceRoots();
        const match = matchBasePathToWorkspaceRoots(event.basePath, workspaceRoots);

        if (!match) {
            await this.daemonClient.submitClaim(this.workerId, {
                dispatchId: event.dispatchId,
                accepted: false,
            });
            return;
        }

        // The daemon still chooses the winner; the worker only reports the best local match it sees.
        await this.daemonClient.submitClaim(this.workerId, {
            dispatchId: event.dispatchId,
            accepted: true,
            matchedRoot: match.matchedRoot,
            matchKind: match.matchKind,
        });
    }

    private async handleExecuteEvent(event: PatchwalkPlaybackExecuteEvent): Promise<void> {
        try {
            // The actual editor-side side effects stay isolated inside the playback runner.
            await this.options.playbackRunner.play(event.payload);
            await this.daemonClient.submitResult(this.workerId, {
                dispatchId: event.dispatchId,
                handoffId: event.payload.handoffId,
                status: 'completed',
                stepsPlayed: event.payload.walkthrough.length,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Report execution failures back to the daemon so the MCP caller receives a real error.
            await this.daemonClient.submitResult(this.workerId, {
                dispatchId: event.dispatchId,
                handoffId: event.payload.handoffId,
                status: 'failed',
                error: message,
            });
        }
    }

    private handleCancelEvent(event: PatchwalkPlaybackCancelEvent): void {
        this.options.outputChannel.appendLine(
            `Patchwalk dispatch ${event.dispatchId} was cancelled: ${event.reason}`,
        );
    }

    private reportError(contextMessage: string, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.options.outputChannel.appendLine(`${contextMessage}: ${message}`);
    }
}
