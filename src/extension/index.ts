import path from 'node:path';

import * as vscode from 'vscode';

import { validatePatchwalkPayload } from '../lib/schema';
import { PatchwalkOverviewController } from './overview/overviewPanel';
import { PatchwalkPlaybackRunner } from './playback';
import { PatchwalkWalkMonitorProvider } from './sidebar/walkMonitorView';
import { PatchwalkStatusSignal, REVEAL_PLAYING_WINDOW_COMMAND } from './statusSignal';
import { SystemVoiceEngine } from './voice/systemVoiceEngine';
import { VoiceDownloadManager } from './voice/voiceDownloadManager';
import { VoiceManager } from './voice/voiceManager';
import { PatchwalkVoicePanelController } from './voice/voicePanelController';
import { httpFetchBytes, registerInstalledNeuralVoices } from './voice/voiceSetup';
import type { TintConfigStore, TintCustomizations, TintMemento } from './windowTint';
import { PatchwalkWindowTint } from './windowTint';
import { PatchwalkWorkerController } from './workerController';

const isSettingEnabled = (key: string, fallback: boolean): boolean =>
    vscode.workspace.getConfiguration('patchwalk').get<boolean>(key, fallback);

/**
 * The extension process is now a worker and UI shell. It no longer hosts MCP directly; instead it
 * keeps one local daemon healthy and executes playback only when the daemon routes a handoff to
 * this window.
 */
function readDaemonPort(): number {
    // Keep reading the legacy setting during migration so older user settings do not break startup.
    const configuration = vscode.workspace.getConfiguration('patchwalk');
    return configuration.get<number>('daemonPort', configuration.get<number>('mcpPort', 7357));
}

export function activate(context: vscode.ExtensionContext) {
    // Activation wires together the local UX layer: output, playback, and daemon worker control.
    const outputChannel = vscode.window.createOutputChannel('Patchwalk');

    // Voice layer: the system voice is always available; neural engines register here in Phase 2.
    const voiceManager = new VoiceManager({
        engines: [
            new SystemVoiceEngine({
                tmpDir: path.join(context.globalStorageUri.fsPath, 'tts'),
                getVoiceName: () =>
                    vscode.workspace.getConfiguration('patchwalk').get<string>('systemVoice', ''),
            }),
        ],
        getPreferredId: () =>
            vscode.workspace.getConfiguration('patchwalk').get<string>('voice', 'system'),
        isPrefetchEnabled: () =>
            vscode.workspace.getConfiguration('patchwalk').get<boolean>('prefetchAudio', true),
        reportError: (message) => outputChannel.appendLine(message),
    });
    const voiceDownloadManager = new VoiceDownloadManager({
        rootDir: path.join(context.globalStorageUri.fsPath, 'voices'),
        fetchBytes: httpFetchBytes,
    });
    // Pass the manager itself (not just `speak`) so playback can PRIME the next cue's audio while the
    // current one is still being heard — that is what removes the seconds of TTS startup between cues.
    const playbackRunner = new PatchwalkPlaybackRunner(outputChannel, voiceManager);
    const daemonPort = readDaemonPort();
    const workerController = new PatchwalkWorkerController({
        context,
        daemonPort,
        outputChannel,
        playbackRunner,
    });

    // The activity-bar walk monitor observes this window's playback runner directly.
    const voicePanelController = new PatchwalkVoicePanelController({
        voiceManager,
        downloadManager: voiceDownloadManager,
        tmpDir: path.join(context.globalStorageUri.fsPath, 'tmp'),
        log: (message) => outputChannel.appendLine(message),
    });
    const walkMonitorProvider = new PatchwalkWalkMonitorProvider(
        context.extensionUri,
        playbackRunner,
        outputChannel,
        voicePanelController,
        workerController,
    );
    const walkMonitorRegistration = vscode.window.registerWebviewViewProvider(
        PatchwalkWalkMonitorProvider.viewType,
        walkMonitorProvider,
    );

    // Problem 4a: the per-window status-bar "which window is playing" signal.
    const statusSignal = new PatchwalkStatusSignal(playbackRunner, workerController);

    // Problem 5: the overview editor — the agenda/stats surface that keeps the opening segment alive.
    const overviewController = new PatchwalkOverviewController(
        context.extensionUri,
        playbackRunner,
        outputChannel,
        () => isSettingEnabled('overviewEditor', true),
    );

    // Problem 4d: the opt-in, crash-safe chrome tint (the closest honest version of a window "glow").
    const tintStore: TintConfigStore = {
        inspectWorkspaceValue: () =>
            vscode.workspace
                .getConfiguration('workbench')
                .inspect<TintCustomizations>('colorCustomizations')?.workspaceValue,
        update: async (value) => {
            await vscode.workspace
                .getConfiguration('workbench')
                .update('colorCustomizations', value, vscode.ConfigurationTarget.Workspace);
        },
    };
    const tintMemento: TintMemento = {
        get: (key) => context.workspaceState.get(key),
        update: (key, value) => Promise.resolve(context.workspaceState.update(key, value)),
    };
    const windowTint = new PatchwalkWindowTint(tintStore, tintMemento, (message) =>
        outputChannel.appendLine(message),
    );
    // If a prior process died mid-walk with the tint applied, self-heal on activation.
    windowTint.recover().catch((error: unknown) => {
        outputChannel.appendLine(
            `Patchwalk tint recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    });

    // Problem 4b/4d: on local walk start/stop, tint this window (opt-in) and reveal the sidebar.
    const walkPresenceSubscription = playbackRunner.onDidChangeActiveRun((run) => {
        if (run) {
            if (isSettingEnabled('tintWindowDuringPlayback', false)) {
                windowTint.apply().catch((error: unknown) => {
                    outputChannel.appendLine(
                        `Patchwalk tint failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                });
            }
            if (isSettingEnabled('autoRevealSidebar', true)) {
                void vscode.commands.executeCommand(
                    `${PatchwalkWalkMonitorProvider.viewType}.focus`,
                );
            }
        } else {
            windowTint.revert().catch(() => {
                // Best-effort revert; recover() self-heals on next activation if this fails.
            });
        }
    });

    // Problem 4c: reveal (raise) the window currently playing a walk.
    const revealPlayingWindowCommand = vscode.commands.registerCommand(
        REVEAL_PLAYING_WINDOW_COMMAND,
        () => workerController.revealPlayingWindow(),
    );

    /**
     * Extension activation should stay resilient: command registration should survive background
     * failures so the user can still inspect and recover the daemon.
     */
    const runInBackground = (promise: Promise<unknown>, contextMessage: string): void => {
        promise.catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`${contextMessage}: ${message}`);
        });
    };

    const restartDaemonCommand = vscode.commands.registerCommand(
        'patchwalk.restartDaemon',
        async () => {
            await workerController.restartDaemon();
            await vscode.window.showInformationMessage('Patchwalk daemon restarted.');
        },
    );

    const showDaemonStatusCommand = vscode.commands.registerCommand(
        'patchwalk.showDaemonStatus',
        async () => {
            await workerController.showStatus();
        },
    );

    const stopDaemonCommand = vscode.commands.registerCommand('patchwalk.stopDaemon', async () => {
        await workerController.stopDaemon();
        await vscode.window.showInformationMessage('Patchwalk daemon stopped.');
    });

    const playFromClipboardCommand = vscode.commands.registerCommand(
        'patchwalk.playFromClipboard',
        async () => {
            // Clipboard playback stays useful for manual testing and must validate exactly like MCP.
            const clipboardText = await vscode.env.clipboard.readText();
            if (!clipboardText.trim()) {
                await vscode.window.showErrorMessage('Clipboard is empty.');
                return;
            }

            let parsedPayload: unknown;
            try {
                parsedPayload = JSON.parse(clipboardText);
            } catch {
                await vscode.window.showErrorMessage('Clipboard text is not valid JSON.');
                return;
            }

            const validation = validatePatchwalkPayload(parsedPayload);
            if (!validation.ok) {
                await vscode.window.showErrorMessage(
                    `Invalid walk payload in clipboard: ${validation.error}`,
                );
                return;
            }

            await workerController.routeClipboardPlayback(validation.value);
        },
    );

    context.subscriptions.push(
        outputChannel,
        playbackRunner,
        workerController,
        voicePanelController,
        walkMonitorProvider,
        walkMonitorRegistration,
        statusSignal,
        overviewController,
        walkPresenceSubscription,
        revealPlayingWindowCommand,
        // Best-effort tint revert on shutdown; recover() self-heals on next activation regardless.
        { dispose: () => void windowTint.revert() },
        restartDaemonCommand,
        showDaemonStatusCommand,
        stopDaemonCommand,
        playFromClipboardCommand,
    );

    runInBackground(workerController.start(), 'Failed to start Patchwalk worker');
    runInBackground(
        registerInstalledNeuralVoices({
            downloadManager: voiceDownloadManager,
            voiceManager,
            tmpDir: path.join(context.globalStorageUri.fsPath, 'tmp'),
            log: (message) => outputChannel.appendLine(message),
        }),
        'Failed to register Patchwalk neural voices',
    );
}

export function deactivate() {
    // VS Code disposes registered resources for us, so there is no separate teardown logic here.
}
