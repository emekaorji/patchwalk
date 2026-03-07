import path from 'node:path';

import * as vscode from 'vscode';

import type { PatchwalkHandoffPayload, PatchwalkWalkthroughStep } from './schema';
import { speakWithSystemVoice } from './tts';

/**
 * The playback runner owns every editor-side side effect: opening files, revealing ranges,
 * highlighting code, and narrating the handoff.
 */
export class PatchwalkPlaybackRunner implements vscode.Disposable {
    private readonly highlightDecoration: vscode.TextEditorDecorationType;
    /**
     * Serialize playbacks so overlapping MCP requests do not fight over the editor.
     */
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

        // Walkthrough order matters because the payload is authored as a guided explanation.
        await payload.walkthrough.reduce<Promise<void>>(async (queue, step) => {
            await queue;
            await this.playStep(payload, step);
        }, Promise.resolve());

        this.outputChannel.appendLine(`Finished Patchwalk handoff: ${payload.handoffId}`);
    }

    private async playStep(
        payload: PatchwalkHandoffPayload,
        step: PatchwalkWalkthroughStep,
    ): Promise<void> {
        const fileUri = this.resolveFileUri(payload.basePath, step.path);
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

        // Reveal the first line, but highlight the full step range so the speaker can narrate context.
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

    private resolveFileUri(basePath: string, filePath: string): vscode.Uri | undefined {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }

        // Relative walkthrough paths are anchored to the routed project root, not the active tab.
        if (!path.isAbsolute(basePath)) {
            return undefined;
        }

        return vscode.Uri.file(path.resolve(basePath, filePath));
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
