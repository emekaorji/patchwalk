import { randomBytes } from 'node:crypto';
import path from 'node:path';

import * as vscode from 'vscode';

import type { PatchwalkPlaybackRun, PatchwalkPlaybackRunner } from '../playback';
import { renderOverviewHtml } from './overviewHtml';

/**
 * Owns the Patchwalk overview editor — a long-lived webview panel opened beside the code when a
 * walk launches. It renders the agenda + stats of everything about to be explained and lights up
 * the segment being narrated, so the opening overview no longer feels like dead air. The panel
 * stays alive for the whole walk as a live progress map; closing it does not stop the walk.
 */

const createNonce = (): string => randomBytes(16).toString('hex');

interface OverviewProgressSnapshot {
    stepIndex: number;
    playbackState: string;
}

export class PatchwalkOverviewController implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private run: PatchwalkPlaybackRun | undefined;
    private progressSubscription: vscode.Disposable | undefined;
    private panelDisposables: vscode.Disposable[] = [];
    private lastProgress: OverviewProgressSnapshot = { stepIndex: 0, playbackState: 'playing' };
    private readonly disposables: vscode.Disposable[] = [];

    public constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly playbackRunner: PatchwalkPlaybackRunner,
        private readonly outputChannel: vscode.OutputChannel,
        private readonly isEnabled: () => boolean,
    ) {
        this.disposables.push(
            this.playbackRunner.onDidChangeActiveRun((run) => this.onActiveRunChange(run)),
        );
        const active = this.playbackRunner.getActiveRun();
        if (active) {
            this.onActiveRunChange(active);
        }
    }

    private onActiveRunChange(run: PatchwalkPlaybackRun | undefined): void {
        this.progressSubscription?.dispose();
        this.progressSubscription = undefined;

        if (!run) {
            this.run = undefined;
            this.closePanel();
            return;
        }

        this.run = run;
        this.lastProgress = {
            stepIndex: run.getSnapshot().stepIndex,
            playbackState: run.getSnapshot().state,
        };
        if (!this.isEnabled()) {
            return;
        }
        this.openPanel();
        this.progressSubscription = run.onDidProgress((progress) => {
            this.lastProgress = { stepIndex: progress.stepIndex, playbackState: progress.state };
            this.postProgress();
        });
    }

    private openPanel(): void {
        if (this.panel) {
            this.postOverview();
            this.postProgress();
            return;
        }

        // Open BESIDE the code, without stealing focus, and keep it alive while hidden so switching to
        // a code tab never resets the agenda animation.
        const panel = vscode.window.createWebviewPanel(
            'patchwalk.overview',
            'Patchwalk Walk',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionUri],
            },
        );
        const nonce = createNonce();
        panel.webview.html = renderOverviewHtml({ cspSource: panel.webview.cspSource, nonce });

        this.panelDisposables.push(
            panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message)),
            panel.onDidChangeViewState(() => {
                if (panel.visible) {
                    // Re-hydrate on re-show so the map is always in sync with playback.
                    this.postOverview();
                    this.postProgress();
                }
            }),
        );
        // Not registered into the controller-lifetime `disposables`: that array is never pruned, so
        // it would retain one closure (and the disposed panel it captures) per walk. VS Code holds
        // the subscription until the panel's dispose emitter fires, which is exactly its lifetime.
        panel.onDidDispose(() => {
            // The user closed the map — drop the reference but let the walk keep playing.
            if (this.panel === panel) {
                this.panel = undefined;
            }
            for (const disposable of this.panelDisposables) {
                disposable.dispose();
            }
            this.panelDisposables = [];
        });

        this.panel = panel;
        this.postOverview();
        this.postProgress();
    }

    private postOverview(): void {
        if (this.panel && this.run) {
            void this.panel.webview.postMessage({ type: 'overview', data: this.run.getOverview() });
        }
    }

    private postProgress(): void {
        if (this.panel) {
            void this.panel.webview.postMessage({
                type: 'progress',
                stepIndex: this.lastProgress.stepIndex,
                playbackState: this.lastProgress.playbackState,
            });
        }
    }

    private handleMessage(message: unknown): void {
        if (typeof message !== 'object' || message === null) {
            return;
        }
        const parsed = message as { type?: unknown; stepIndex?: unknown };
        if (parsed.type === 'ready') {
            this.postOverview();
            this.postProgress();
            return;
        }
        if (
            parsed.type === 'jump' &&
            typeof parsed.stepIndex === 'number' &&
            Number.isInteger(parsed.stepIndex) && // Clicking the agenda PLAYS from that cue (jump a live walk, or replay a finished one).
            !this.playbackRunner.jumpToCue(parsed.stepIndex)
        ) {
            void this.revealStep(parsed.stepIndex);
        }
    }

    private async revealStep(stepIndex: number): Promise<void> {
        const target = this.run?.getWalkSteps().find((step) => step.stepIndex === stepIndex);
        if (!target) {
            return;
        }

        const fileUri = path.isAbsolute(target.path)
            ? vscode.Uri.file(target.path)
            : vscode.Uri.file(path.resolve(target.basePath, target.path));

        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            // A click on the agenda should take the developer to that code (in the main column).
            const editor = await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.One,
                preview: true,
                preserveFocus: false,
            });
            const maximumLine = Math.max(document.lineCount - 1, 0);
            const startLine = Math.min(Math.max(target.startLine - 1, 0), maximumLine);
            const endLine = Math.min(Math.max(target.endLine - 1, startLine), maximumLine);
            const endCharacter = document.lineAt(endLine).range.end.character;
            // A real selection, exactly as if the developer had dragged over the block themselves.
            editor.selection = new vscode.Selection(startLine, 0, endLine, endCharacter);
            editor.revealRange(
                new vscode.Range(startLine, 0, startLine, 0),
                vscode.TextEditorRevealType.InCenter,
            );
        } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `Patchwalk overview could not open a segment: ${messageText}`,
            );
        }
    }

    private closePanel(): void {
        if (this.panel) {
            const panel = this.panel;
            this.panel = undefined;
            panel.dispose();
        }
    }

    public dispose(): void {
        this.progressSubscription?.dispose();
        this.closePanel();
        for (const disposable of this.panelDisposables) {
            disposable.dispose();
        }
        this.panelDisposables = [];
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}
