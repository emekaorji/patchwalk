import * as vscode from 'vscode';

import { PatchwalkPlaybackRunner } from './playback';
import { validatePatchwalkPayload } from './schema';
import { PatchwalkWorkerController } from './workerController';

/**
 * The extension process is now a worker and UI shell. It no longer hosts MCP directly; instead it
 * keeps one local daemon healthy and executes playback only when the daemon routes a handoff to
 * this window.
 */
function readDaemonPort(): number {
    const configuration = vscode.workspace.getConfiguration('patchwalk');
    return configuration.get<number>('daemonPort', configuration.get<number>('mcpPort', 7357));
}

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Patchwalk');
    const playbackRunner = new PatchwalkPlaybackRunner(outputChannel);
    const daemonPort = readDaemonPort();
    const workerController = new PatchwalkWorkerController({
        context,
        daemonPort,
        outputChannel,
        playbackRunner,
    });

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
                    `Invalid handoff payload in clipboard: ${validation.error}`,
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
        restartDaemonCommand,
        showDaemonStatusCommand,
        stopDaemonCommand,
        playFromClipboardCommand,
    );

    runInBackground(workerController.start(), 'Failed to start Patchwalk worker');
}

export function deactivate() {
    // Disposables on the extension context perform cleanup.
}
