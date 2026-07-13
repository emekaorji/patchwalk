import { randomBytes } from 'node:crypto';
import path from 'node:path';

import * as vscode from 'vscode';

import type {
    PatchwalkPlaybackRun,
    PatchwalkPlaybackRunner,
    PatchwalkWalkStepTarget,
} from '../playback';
import { renderWalkMonitorHtml } from './walkMonitorHtml';
import type {
    WalkMonitorDaemonStatus,
    WalkMonitorViewState,
    WalkMonitorVoicesState,
    WalkMonitorWebviewMessage,
} from './walkMonitorModel';
import {
    applyWalkMonitorProgress,
    idleWalkMonitorState,
    isWalkMonitorWebviewMessage,
    walkMonitorStateFromWalk,
    walkMonitorStateOnEnd,
} from './walkMonitorModel';

/** The voice operations the sidebar's Voices panel needs. Implemented in the extension host. */
export interface VoicePanelController {
    getVoicesState(): Promise<WalkMonitorVoicesState>;
    download(voiceId: string): Promise<void>;
    remove(voiceId: string): Promise<void>;
    select(voiceId: string): Promise<void>;
    onDidChange(listener: () => void): vscode.Disposable;
}

/** Feeds the sidebar's Daemon status line. Implemented by the worker controller. */
export interface DaemonStatusController {
    getStatus(): Promise<WalkMonitorDaemonStatus>;
    onDidChange(listener: () => void): vscode.Disposable;
}

const createNonce = (): string => randomBytes(16).toString('hex');

/**
 * The activity-bar walk monitor. It observes the local {@link PatchwalkPlaybackRunner}, mirrors the
 * live walk into the webview (Now Playing + transport controls + transcript), and routes the
 * webview's control/jump messages back to the run. The transcript persists after a walk ends so the
 * reasoning stays on screen (P4); click-to-jump reveals a step without stealing the run's flow
 * (P5).
 */
export class PatchwalkWalkMonitorProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'patchwalk.walkMonitor';

    private view: vscode.WebviewView | undefined;
    private state: WalkMonitorViewState = idleWalkMonitorState();
    private readonly targetsByIndex = new Map<number, PatchwalkWalkStepTarget>();
    private progressSubscription: vscode.Disposable | undefined;
    private readonly jumpDecoration: vscode.TextEditorDecorationType;
    private readonly disposables: vscode.Disposable[] = [];

    public constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly playbackRunner: PatchwalkPlaybackRunner,
        private readonly outputChannel: vscode.OutputChannel,
        private readonly voicePanel?: VoicePanelController,
        private readonly daemonStatus?: DaemonStatusController,
    ) {
        this.jumpDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.selectionBackground'),
            borderRadius: '2px',
        });
        this.disposables.push(
            this.playbackRunner.onDidChangeActiveRun((run) => this.onActiveRunChange(run)),
        );
        if (this.voicePanel) {
            this.disposables.push(this.voicePanel.onDidChange(() => void this.postVoices()));
        }
        if (this.daemonStatus) {
            this.disposables.push(
                this.daemonStatus.onDidChange(() => void this.postDaemonStatus()),
            );
        }

        // If a walk is already running when the provider is created, mirror it immediately.
        const activeRun = this.playbackRunner.getActiveRun();
        if (activeRun) {
            this.onActiveRunChange(activeRun);
        }
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        const nonce = createNonce();
        webviewView.webview.html = renderWalkMonitorHtml({
            cspSource: webviewView.webview.cspSource,
            nonce,
        });
        webviewView.webview.onDidReceiveMessage(
            (message: unknown) => this.handleWebviewMessage(message),
            undefined,
            this.disposables,
        );
        webviewView.onDidDispose(
            () => {
                if (this.view === webviewView) {
                    this.view = undefined;
                }
            },
            undefined,
            this.disposables,
        );
        this.postState();
        void this.postVoices();
        void this.postDaemonStatus();
    }

    /** Test hook: the current view state the provider would push to the webview. */
    public get currentStateForTest(): WalkMonitorViewState {
        return this.state;
    }

    public dispose(): void {
        this.progressSubscription?.dispose();
        this.jumpDecoration.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private onActiveRunChange(run: PatchwalkPlaybackRun | undefined): void {
        this.progressSubscription?.dispose();
        this.progressSubscription = undefined;

        if (!run) {
            this.state = walkMonitorStateOnEnd(this.state);
            this.postState();
            return;
        }

        this.targetsByIndex.clear();
        for (const target of run.getWalkSteps()) {
            this.targetsByIndex.set(target.stepIndex, target);
        }

        const snapshot = run.getSnapshot();
        this.state = walkMonitorStateFromWalk({
            handoffId: run.handoffId,
            summary: run.getSummary(),
            transcript: run.getTranscript(),
            playbackState: snapshot.state,
            currentStepIndex: snapshot.stepIndex,
        });
        this.progressSubscription = run.onDidProgress((progress) => {
            this.state = applyWalkMonitorProgress(this.state, {
                stepIndex: progress.stepIndex,
                playbackState: progress.state,
            });
            this.postState();
        });
        this.postState();
    }

    private postState(): void {
        void this.view?.webview.postMessage({ type: 'state', state: this.state });
    }

    private async postVoices(): Promise<void> {
        if (!this.voicePanel || !this.view) {
            return;
        }
        const voices = await this.voicePanel.getVoicesState();
        void this.view.webview.postMessage({ type: 'voices', voices });
    }

    private async postDaemonStatus(): Promise<void> {
        if (!this.daemonStatus || !this.view) {
            return;
        }
        const status = await this.daemonStatus.getStatus();
        void this.view.webview.postMessage({ type: 'daemonStatus', status });
    }

    private async handleVoiceMessage(
        message: Extract<
            WalkMonitorWebviewMessage,
            { type: 'downloadVoice' | 'removeVoice' | 'selectVoice' }
        >,
    ): Promise<void> {
        if (!this.voicePanel) {
            return;
        }
        try {
            if (message.type === 'downloadVoice') {
                await this.voicePanel.download(message.voiceId);
            } else if (message.type === 'removeVoice') {
                await this.voicePanel.remove(message.voiceId);
            } else {
                await this.voicePanel.select(message.voiceId);
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Patchwalk voice action failed: ${detail}`);
        }
        await this.postVoices();
    }

    private handleWebviewMessage(raw: unknown): void {
        if (!isWalkMonitorWebviewMessage(raw)) {
            return;
        }
        const message: WalkMonitorWebviewMessage = raw;

        if (message.type === 'ready') {
            this.postState();
            void this.postVoices();
            void this.postDaemonStatus();
            return;
        }

        if (
            message.type === 'downloadVoice' ||
            message.type === 'removeVoice' ||
            message.type === 'selectVoice'
        ) {
            void this.handleVoiceMessage(message);
            return;
        }

        if (message.type === 'control') {
            const run = this.playbackRunner.getActiveRun();
            switch (message.action) {
                case 'stop':
                    void this.playbackRunner.stopActivePlayback();
                    return;
                case 'pause':
                    run?.pause();
                    return;
                case 'resume':
                    run?.resume();
                    return;
                case 'next':
                    run?.next();
                    return;
                case 'previous':
                    run?.previous();
                    return;
                case 'replay':
                    run?.replay();
                    return;
            }
            return;
        }

        if (
            message.type === 'jump' && // A click on the transcript PLAYS from that cue — it jumps a running walk, or replays a
            // finished one from there. present() then makes the real editor selection for us.
            !this.playbackRunner.jumpToCue(message.stepIndex)
        ) {
            // Nothing to play (no walk has run in this window): just reveal + select the code.
            void this.revealStep(message.stepIndex);
        }
    }

    private async revealStep(stepIndex: number): Promise<void> {
        const target = this.targetsByIndex.get(stepIndex);
        if (!target) {
            return;
        }

        const fileUri = path.isAbsolute(target.path)
            ? vscode.Uri.file(target.path)
            : vscode.Uri.file(path.resolve(target.basePath, target.path));

        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            // An explicit click SHOULD move focus to the code the user asked to see. Pin the main
            // column so the jump never opens over the Beside overview editor.
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
            editor.setDecorations(this.jumpDecoration, [
                new vscode.Range(startLine, 0, endLine, endCharacter),
            ]);
        } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Patchwalk could not open step target: ${messageText}`);
        }
    }
}
