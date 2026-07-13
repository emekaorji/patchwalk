import * as vscode from 'vscode';

import type {
    PatchwalkPlaybackRun,
    PatchwalkPlaybackRunner,
    PatchwalkTranscriptEntry,
} from './playback';

/**
 * The per-window status-bar signal (Problem 4a). Every Patchwalk window carries one status-bar
 * item; the window actually playing shows a loud "megaphone" badge (the reliable, settings-free
 * which-window cue), and every other window shows a quiet "playing elsewhere" badge that reveals
 * the playing window when clicked. Idle windows hide it.
 */

/** Snapshot of the machine-wide walk as seen from ANOTHER window (never the local one). */
export interface RemoteWalkState {
    active: boolean;
    revealPath?: string;
}

/** Pushes remote-walk changes (fed by the daemon's `walk.owner` broadcast). */
export interface RemoteWalkSource {
    getRemoteWalk(): RemoteWalkState;
    onDidChangeRemoteWalk(listener: () => void): vscode.Disposable;
}

export const FOCUS_WALK_MONITOR_COMMAND = 'patchwalk.walkMonitor.focus';
export const REVEAL_PLAYING_WINDOW_COMMAND = 'patchwalk.revealPlayingWindow';

export class PatchwalkStatusSignal implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private runProgressSubscription: vscode.Disposable | undefined;
    private activeRun: PatchwalkPlaybackRun | undefined;
    private transcript: PatchwalkTranscriptEntry[] = [];

    public constructor(
        private readonly playbackRunner: PatchwalkPlaybackRunner,
        private readonly remoteSource: RemoteWalkSource,
    ) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
        this.item.name = 'Patchwalk';
        this.disposables.push(
            this.item,
            this.playbackRunner.onDidChangeActiveRun((run) => this.onActiveRunChange(run)),
            this.remoteSource.onDidChangeRemoteWalk(() => this.render()),
        );
        this.onActiveRunChange(this.playbackRunner.getActiveRun());
    }

    private onActiveRunChange(run: PatchwalkPlaybackRun | undefined): void {
        this.runProgressSubscription?.dispose();
        this.runProgressSubscription = undefined;
        this.activeRun = run;
        this.transcript = run ? run.getTranscript() : [];
        if (run) {
            this.runProgressSubscription = run.onDidProgress(() => this.render());
        }
        this.render();
    }

    private render(): void {
        const run = this.activeRun;
        if (run) {
            this.renderLocal(run);
            return;
        }
        if (this.remoteSource.getRemoteWalk().active) {
            this.renderRemote();
            return;
        }
        this.item.hide();
    }

    private renderLocal(run: PatchwalkPlaybackRun): void {
        const snapshot = run.getSnapshot();
        const title = this.transcript[snapshot.stepIndex]?.title ?? 'Patchwalk';
        const icon = snapshot.state === 'playing' ? '$(sync~spin)' : '$(megaphone)';
        const position =
            snapshot.stepCount > 0 ? ` ${snapshot.stepIndex + 1}/${snapshot.stepCount}` : '';
        this.item.text = `${icon} Patchwalk ▸ ${title}${position}`;
        this.item.tooltip = new vscode.MarkdownString(
            `**Patchwalk is playing in this window**\n\n${title} — segment ${
                snapshot.stepIndex + 1
            } of ${snapshot.stepCount} (${snapshot.state}).\n\nClick to open the Patchwalk sidebar.`,
        );
        // The only prominent background VS Code honors for extension items — a loud "this one".
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.command = FOCUS_WALK_MONITOR_COMMAND;
        this.item.show();
    }

    private renderRemote(): void {
        this.item.text = '$(broadcast) Patchwalk playing elsewhere';
        this.item.tooltip = new vscode.MarkdownString(
            'A Patchwalk walk is playing in **another window**.\n\nClick to reveal it.',
        );
        this.item.backgroundColor = undefined;
        this.item.command = REVEAL_PLAYING_WINDOW_COMMAND;
        this.item.show();
    }

    public dispose(): void {
        this.runProgressSubscription?.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}
