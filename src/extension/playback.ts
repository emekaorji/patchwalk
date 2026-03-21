import path from 'node:path';

import * as vscode from 'vscode';

import type { PatchwalkHandoffPayload, PatchwalkWalkthroughStep } from '../lib/schema';
import { speakWithSystemVoice } from './tts';

export type PatchwalkPlaybackState = 'idle' | 'playing' | 'stopping';

export interface PatchwalkPlaybackStateSnapshot {
    state: PatchwalkPlaybackState;
    activeHandoffId: string | null;
}

interface ActivePlaybackRun {
    handoffId: string;
    abortController: AbortController;
    completion: Promise<void>;
    resolveCompletion: () => void;
    rejectCompletion: (error: Error) => void;
}

const createStoppedError = (): Error => {
    const error = new Error('Patchwalk playback was stopped.');
    error.name = 'PatchwalkPlaybackStoppedError';
    return error;
};

const isStoppedError = (error: unknown): boolean => {
    return error instanceof Error && error.name === 'PatchwalkPlaybackStoppedError';
};

/**
 * The playback runner owns every editor-side side effect: opening files, revealing ranges,
 * highlighting code, narration, and stop handling for the active handoff.
 */
export class PatchwalkPlaybackRunner implements vscode.Disposable {
    private readonly highlightDecoration: vscode.TextEditorDecorationType;
    private activeRun: ActivePlaybackRun | undefined;
    private state: PatchwalkPlaybackState = 'idle';

    public constructor(private readonly outputChannel: vscode.OutputChannel) {
        this.highlightDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
        });
    }

    public dispose(): void {
        this.highlightDecoration.dispose();
    }

    public getStateSnapshot(): PatchwalkPlaybackStateSnapshot {
        return {
            state: this.state,
            activeHandoffId: this.activeRun?.handoffId ?? null,
        };
    }

    public async play(payload: PatchwalkHandoffPayload): Promise<void> {
        if (this.activeRun) {
            throw new Error(
                `Patchwalk is already playing handoff ${this.activeRun.handoffId} in this window.`,
            );
        }

        const abortController = new AbortController();
        const completionState = {} as {
            resolve?: () => void;
            reject?: (error: Error) => void;
        };
        const completion = new Promise<void>((resolve, reject) => {
            completionState.resolve = resolve;
            completionState.reject = reject;
        });

        this.activeRun = {
            handoffId: payload.handoffId,
            abortController,
            completion,
            resolveCompletion: completionState.resolve!,
            rejectCompletion: completionState.reject!,
        };
        this.state = 'playing';

        this.playInternal(payload, abortController.signal)
            .then(() => {
                this.activeRun?.resolveCompletion();
            })
            .catch((error) => {
                this.activeRun?.rejectCompletion(
                    error instanceof Error ? error : new Error(String(error)),
                );
            })
            .finally(() => {
                this.activeRun = undefined;
                this.state = 'idle';
            });

        return completion;
    }

    public async stopActivePlayback(): Promise<boolean> {
        const activeRun = this.activeRun;
        if (!activeRun) {
            return false;
        }

        this.state = 'stopping';
        activeRun.abortController.abort();

        try {
            await activeRun.completion;
            return true;
        } catch (error) {
            if (isStoppedError(error)) {
                return true;
            }

            throw error;
        }
    }

    private async playInternal(
        payload: PatchwalkHandoffPayload,
        abortSignal: AbortSignal,
    ): Promise<void> {
        this.outputChannel.appendLine(`Starting Patchwalk handoff: ${payload.handoffId}`);
        this.throwIfStopped(abortSignal);
        await this.speak(payload.summary, abortSignal);

        await payload.walkthrough.reduce<Promise<void>>(async (queue, step) => {
            await queue;
            this.throwIfStopped(abortSignal);
            await this.playStep(payload, step, abortSignal);
        }, Promise.resolve());

        this.outputChannel.appendLine(`Finished Patchwalk handoff: ${payload.handoffId}`);
    }

    private async playStep(
        payload: PatchwalkHandoffPayload,
        step: PatchwalkWalkthroughStep,
        abortSignal: AbortSignal,
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

        this.throwIfStopped(abortSignal);
        const document = await vscode.workspace.openTextDocument(fileUri);
        this.throwIfStopped(abortSignal);
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
            this.throwIfStopped(abortSignal);
            await this.speak(step.narration, abortSignal);
        } finally {
            editor.setDecorations(this.highlightDecoration, []);
        }
    }

    private resolveFileUri(basePath: string, filePath: string): vscode.Uri | undefined {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }

        if (!path.isAbsolute(basePath)) {
            return undefined;
        }

        return vscode.Uri.file(path.resolve(basePath, filePath));
    }

    private async speak(text: string, abortSignal: AbortSignal): Promise<void> {
        try {
            await speakWithSystemVoice(text, abortSignal);
        } catch (error) {
            if (abortSignal.aborted) {
                throw createStoppedError();
            }

            if (error instanceof Error && error.name === 'AbortError') {
                throw createStoppedError();
            }

            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`TTS error: ${message}`);
            await vscode.window.showWarningMessage(
                `Patchwalk TTS unavailable, skipping narration: ${message}`,
            );
        }
    }

    private throwIfStopped(abortSignal: AbortSignal): void {
        if (abortSignal.aborted) {
            throw createStoppedError();
        }
    }
}
