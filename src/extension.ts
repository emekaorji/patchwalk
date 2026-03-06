import * as vscode from 'vscode';

import { PatchwalkMcpServer } from './mcpServer';
import { PatchwalkPlaybackRunner } from './playback';
import { validatePatchwalkPayload } from './schema';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Patchwalk');
    const playbackRunner = new PatchwalkPlaybackRunner(outputChannel);
    let mcpServer: PatchwalkMcpServer | undefined;

    const runInBackground = (promise: Promise<unknown>, contextMessage: string): void => {
        promise.catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`${contextMessage}: ${message}`);
        });
    };

    const startServer = async () => {
        if (mcpServer) {
            return;
        }

        const port = vscode.workspace.getConfiguration('patchwalk').get<number>('mcpPort', 7357);
        mcpServer = new PatchwalkMcpServer({
            port,
            outputChannel,
            onPlayPayload: async (payload) => {
                await playbackRunner.play(payload);
            },
        });

        try {
            await mcpServer.start();
            outputChannel.appendLine(
                `Patchwalk MCP server listening on http://127.0.0.1:${port}/mcp`,
            );
            await vscode.window.showInformationMessage(
                `Patchwalk MCP server started on port ${port}.`,
            );
        } catch (error) {
            mcpServer = undefined;
            const message = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`Failed to start MCP server: ${message}`);
            await vscode.window.showErrorMessage(
                `Patchwalk MCP server failed to start: ${message}`,
            );
        }
    };

    const stopServer = async () => {
        if (!mcpServer) {
            return;
        }

        await mcpServer.stop();
        mcpServer = undefined;
        outputChannel.appendLine('Patchwalk MCP server stopped.');
        await vscode.window.showInformationMessage('Patchwalk MCP server stopped.');
    };

    const startServerCommand = vscode.commands.registerCommand(
        'patchwalk.startMcpServer',
        async () => {
            await startServer();
        },
    );

    const stopServerCommand = vscode.commands.registerCommand(
        'patchwalk.stopMcpServer',
        async () => {
            await stopServer();
        },
    );

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

            await playbackRunner.play(validation.value);
        },
    );

    context.subscriptions.push(
        outputChannel,
        playbackRunner,
        startServerCommand,
        stopServerCommand,
        playFromClipboardCommand,
        {
            dispose: () => {
                if (mcpServer) {
                    runInBackground(stopServer(), 'Failed to stop MCP server during dispose');
                }
            },
        },
    );

    const shouldAutoStart = vscode.workspace
        .getConfiguration('patchwalk')
        .get<boolean>('autoStartMcpServer', true);
    if (shouldAutoStart) {
        runInBackground(startServer(), 'Failed to auto-start MCP server');
    }
}

export function deactivate() {
    // Disposables on the extension context perform cleanup.
}
