import path from 'node:path';

import * as vscode from 'vscode';

import type { PatchwalkHandoffPayload, PatchwalkWalkthroughStep } from './schema';
import { speakWithSystemVoice } from './tts';

export class PatchwalkPlaybackRunner implements vscode.Disposable {
    private readonly highlightDecoration: vscode.TextEditorDecorationType;
    private playbackQueue: Promise<void> = Promise.resolve();

    public constructor(private readonly outputChannel: vscode.OutputChannel) {
        this.highlightDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
        });
    }

    public dispose() {
        this.highlightDecoration.dispose();
    }

    public play(payload: PatchwalkHandoffPayload): Promise<void> {
        this.playbackQueue = this.playbackQueue
            .catch(() => {
                // Keep queue operational after a failed playback.
            })
            .then(async () => {
                await this.playInternal(payload);
            });

        return this.playbackQueue;
    }

    private async playInternal(payload: PatchwalkHandoffPayload): Promise<void> {
        this.outputChannel.appendLine(`Starting Patchwalk handoff: ${payload.handoffId}`);
        await this.speak(payload.summary);

        await payload.walkthrough.reduce<Promise<void>>(async (queue, step) => {
            await queue;
            await this.playStep(step);
        }, Promise.resolve());

        this.outputChannel.appendLine(`Finished Patchwalk handoff: ${payload.handoffId}`);
    }

    private async playStep(step: PatchwalkWalkthroughStep): Promise<void> {
        const fileUri = this.resolveFileUri(step.path);
        if (!fileUri) {
            this.outputChannel.appendLine(
                `Unable to resolve file path for step ${step.id}: ${step.path}`,
            );
            await vscode.window.showWarningMessage(
                `Patchwalk could not resolve file for step ${step.id}: ${step.path}`,
            );
            return;
        }

        try {
            await vscode.workspace.fs.stat(fileUri);
        } catch {
            const readablePath = fileUri.fsPath || step.path;
            this.outputChannel.appendLine(
                `File does not exist for step ${step.id}: ${readablePath}`,
            );
            await vscode.window.showWarningMessage(
                `Patchwalk file not found for step ${step.id}: ${readablePath}`,
            );
            return;
        }

        const document = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false,
        });

        const maximumLine = Math.max(document.lineCount - 1, 0);
        const startLine = Math.min(Math.max(step.range.startLine - 1, 0), maximumLine);
        const endLine = Math.min(Math.max(step.range.endLine - 1, startLine), maximumLine);

        const revealRange = new vscode.Range(startLine, 0, startLine, 0);
        const endLineCharacter = document.lineAt(endLine).range.end.character;
        const highlightRange = new vscode.Range(startLine, 0, endLine, endLineCharacter);

        editor.selection = new vscode.Selection(startLine, 0, startLine, 0);
        editor.revealRange(revealRange, vscode.TextEditorRevealType.InCenter);
        editor.setDecorations(this.highlightDecoration, [highlightRange]);

        try {
            await this.speak(step.narration);
        } finally {
            editor.setDecorations(this.highlightDecoration, []);
        }
    }

    private resolveFileUri(filePath: string): vscode.Uri | undefined {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }

        const activeWorkspaceFolder =
            vscode.window.activeTextEditor?.document.uri &&
            vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);

        const fallbackWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workspaceFolder = activeWorkspaceFolder ?? fallbackWorkspaceFolder;

        if (!workspaceFolder) {
            return undefined;
        }

        return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    }

    private async speak(text: string): Promise<void> {
        try {
            await speakWithSystemVoice(text);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`TTS error: ${message}`);
            await vscode.window.showWarningMessage(
                `Patchwalk TTS unavailable, skipping narration: ${message}`,
            );
        }
    }
}
