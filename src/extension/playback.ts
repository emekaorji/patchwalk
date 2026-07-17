import { Buffer } from 'node:buffer';
import path from 'node:path';

import * as vscode from 'vscode';

import type { PatchwalkHandoffPayload } from '../lib/schema';
import { speakWithSystemVoice } from './voice/systemVoiceEngine';
import type { PatchwalkPlaybackState, WalkCue, WalkCueKind, WalkProgress } from './walkSequencer';
import { buildWalkCues, isPlaybackStoppedError, WalkSequencer } from './walkSequencer';

export type { PatchwalkPlaybackState } from './walkSequencer';

/**
 * Narration side effect, injectable so playback can be driven with a fake voice in tests and, in
 * Phase 2, swapped for a pluggable neural engine. Defaults to the system voice.
 */
export type WalkSpeakFn = (text: string, signal: AbortSignal) => Promise<void>;

/**
 * The narration backend. `prime` is the important one: speech engines cost SECONDS to start (voice
 * load + synthesis), and paying that between every cue is dead air. Priming the next cue while the
 * current one is still being heard moves that cost off the critical path entirely.
 */
export interface WalkNarrator {
    speak: WalkSpeakFn;
    prime?: (text: string) => void;
    clearPrefetch?: () => void;
}

const toNarrator = (speak: WalkSpeakFn | WalkNarrator): WalkNarrator =>
    typeof speak === 'function' ? { speak } : speak;

export interface PatchwalkPlaybackStateSnapshot {
    state: PatchwalkPlaybackState;
    activeHandoffId: string | null;
}

export interface PatchwalkTranscriptEntry {
    stepIndex: number;
    stepCount: number;
    stepId: string;
    title: string;
    narration: string;
    kind: WalkCueKind;
    isSubSegment: boolean;
    parentStepId?: string;
    path?: string;
    startLine?: number;
    endLine?: number;
}

/** A navigable target for a walkthrough cue, used by the sidebar's/overview's click-to-jump. */
export interface PatchwalkWalkStepTarget {
    stepIndex: number;
    stepId: string;
    title: string;
    basePath: string;
    path: string;
    startLine: number;
    endLine: number;
}

/** One sub-segment inside a step, as shown on the overview editor's agenda. */
export interface PatchwalkOverviewSegment {
    stepIndex: number;
    stepId: string;
    narration: string;
    startLine: number;
    endLine: number;
}

/** One top-level step (with its sub-segments) on the overview editor's agenda. */
export interface PatchwalkOverviewStep {
    stepIndex: number;
    stepId: string;
    title: string;
    narration: string;
    path: string;
    startLine: number;
    endLine: number;
    segments: PatchwalkOverviewSegment[];
}

/** The agenda + stats the overview editor renders while a walk plays. */
export interface PatchwalkOverviewData {
    handoffId: string;
    summary: string;
    producer: { agent: string; agentVersion?: string; model?: string };
    fileCount: number;
    stepCount: number;
    segmentCount: number;
    cueCount: number;
    /** Rough spoken length estimate (~150 words/minute over all narration). */
    estimatedSeconds: number;
    steps: PatchwalkOverviewStep[];
}

/**
 * A live, controllable walk in this window. Returned synchronously by
 * {@link PatchwalkPlaybackRunner.play} so the caller never blocks on completion — control methods
 * interrupt the running walk immediately, which is the whole point of the Phase 0 rewrite.
 */
export interface PatchwalkPlaybackRun {
    readonly handoffId: string;
    readonly completion: Promise<void>;
    readonly onDidProgress: vscode.Event<WalkProgress>;
    readonly onDidEmitTranscript: vscode.Event<PatchwalkTranscriptEntry>;
    getSnapshot(): {
        state: PatchwalkPlaybackState;
        stepIndex: number;
        stepCount: number;
        handoffId: string;
    };
    /** All cues (summary + steps + sub-segments) as transcript entries, ready for the sidebar. */
    getTranscript(): PatchwalkTranscriptEntry[];
    /** Navigable targets for every code cue (steps + sub-segments; excludes the summary cue). */
    getWalkSteps(): PatchwalkWalkStepTarget[];
    /** The hierarchical agenda + stats the overview editor renders. */
    getOverview(): PatchwalkOverviewData;
    getSummary(): string;
    pause(): void;
    resume(): void;
    next(): void;
    previous(): void;
    replay(): void;
    /** Play from an arbitrary cue — the transcript/agenda click target. */
    jumpTo(cueIndex: number): void;
    stop(): Promise<void>;
}

const resolveFileUri = (basePath: string, filePath: string): vscode.Uri | undefined => {
    if (path.isAbsolute(filePath)) {
        return vscode.Uri.file(filePath);
    }
    if (!path.isAbsolute(basePath)) {
        return undefined;
    }
    return vscode.Uri.file(path.resolve(basePath, filePath));
};

/** No added beat by default: the walk must sound like ONE continuous passage, not a list. */
const DEFAULT_STEP_GAP_MS = 0;
const DEFAULT_SUB_SEGMENT_GAP_MS = 0;
const MAXIMUM_GAP_MS = 5_000;

/**
 * Silence held before a cue is spoken. Sub-segments get a comma; a new step gets a breath. Read
 * live (not cached) so a change to the setting applies to the walk that is already playing.
 */
const readCueGapMs = (cue: WalkCue): number => {
    const configuration = vscode.workspace.getConfiguration('patchwalk');
    const configured = cue.isSubSegment
        ? configuration.get<number>('pacing.subSegmentGapMs', DEFAULT_SUB_SEGMENT_GAP_MS)
        : configuration.get<number>('pacing.stepGapMs', DEFAULT_STEP_GAP_MS);
    if (typeof configured !== 'number' || Number.isNaN(configured)) {
        return cue.isSubSegment ? DEFAULT_SUB_SEGMENT_GAP_MS : DEFAULT_STEP_GAP_MS;
    }
    return Math.min(Math.max(configured, 0), MAXIMUM_GAP_MS);
};

/**
 * Owns every editor-side side effect for one walk and adapts the vscode-free {@link WalkSequencer}
 * to VS Code: opening files, revealing/highlighting ranges (without stealing focus), narration via
 * TTS, and surfacing progress/transcript events for the sidebar.
 */
class PatchwalkPlaybackRunImpl implements PatchwalkPlaybackRun {
    public readonly handoffId: string;
    private readonly sequencer: WalkSequencer;
    private readonly progressEmitter = new vscode.EventEmitter<WalkProgress>();
    private readonly transcriptEmitter = new vscode.EventEmitter<PatchwalkTranscriptEntry>();
    public readonly onDidProgress = this.progressEmitter.event;
    public readonly onDidEmitTranscript = this.transcriptEmitter.event;

    private readonly cues: WalkCue[];
    private runState: PatchwalkPlaybackState = 'idle';
    private runStepIndex = 0;
    private completionPromise: Promise<void> = Promise.resolve();
    /**
     * The decorations for the cue currently being narrated. Decorations are per-visible-editor and
     * clear when the editor changes, so we re-apply them whenever the set of visible editors
     * changes (e.g. the user switches tabs mid-walk).
     */
    private activeDecoration:
        | { fsPath: string; highlight: vscode.Range; marker: vscode.Range }
        | undefined;

    private readonly visibleEditorsSubscription: vscode.Disposable;
    /**
     * Documents already opened for this walk, plus the ones we know we cannot open. Cues are opened
     * once and reused, and the NEXT cue's file is prefetched while the current one narrates, so the
     * silence a listener hears between cues is the configured gap rather than file I/O.
     */
    private readonly documentCache = new Map<string, vscode.TextDocument>();
    private readonly unopenablePaths = new Set<string>();
    private readonly startIndex: number;

    public constructor(
        private readonly payload: PatchwalkHandoffPayload,
        private readonly outputChannel: vscode.OutputChannel,
        private readonly highlightDecoration: vscode.TextEditorDecorationType,
        private readonly nowSpeakingDecoration: vscode.TextEditorDecorationType,
        private readonly narrator: WalkNarrator,
        startIndex = 0,
    ) {
        this.startIndex = startIndex;
        this.handoffId = payload.handoffId;
        this.cues = buildWalkCues(
            payload.summary,
            payload.walkthrough.map((step) => ({
                id: step.id,
                title: step.title,
                narration: step.narration,
                path: step.path,
                range: step.range,
                segments: step.segments,
            })),
        );
        this.visibleEditorsSubscription = vscode.window.onDidChangeVisibleTextEditors(() => {
            this.refreshDecorations();
        });
        this.sequencer = new WalkSequencer({
            cues: this.cues,
            startIndex,
            present: (cue, signal) => this.present(cue, signal),
            speak: (text, signal) => this.speak(text, signal),
            gapMsForCue: (cue) => readCueGapMs(cue),
            onProgress: (progress) => {
                this.runState = progress.state;
                this.runStepIndex = progress.stepIndex;
                this.progressEmitter.fire(progress);
            },
            onTranscript: (cue) => {
                this.transcriptEmitter.fire(this.toTranscriptEntry(cue));
            },
            onStateChange: (state) => {
                this.runState = state;
            },
        });
    }

    /** Begin playback in the background. Idempotent per instance. */
    public start(): void {
        this.outputChannel.appendLine(`Starting Patchwalk walk: ${this.handoffId}`);
        // Prime the OPENING line first, so it is first in the synthesis queue. Every cue then takes
        // the same pre-rendered path, which means a live `say` never runs alongside a `say -o` — two
        // speech processes fight over the OS speech service and make the audio stutter.
        this.narrator.prime?.(this.cues[this.startIndex]?.narration ?? '');
        // Defer the first tick so a caller that subscribes to onDidProgress/onDidEmitTranscript
        // synchronously after play() does not miss the first cue's events (the sidebar and worker
        // both subscribe right after play()).
        this.completionPromise = Promise.resolve()
            .then(() => this.sequencer.run())
            .then(() => {
                this.outputChannel.appendLine(`Finished Patchwalk walk: ${this.handoffId}`);
            })
            .finally(() => {
                this.clearHighlight();
            });
    }

    public get completion(): Promise<void> {
        return this.completionPromise;
    }

    public getSnapshot() {
        return {
            state: this.runState,
            stepIndex: this.runStepIndex,
            stepCount: this.cues.length,
            handoffId: this.handoffId,
        };
    }

    public getTranscript(): PatchwalkTranscriptEntry[] {
        return this.cues.map((cue) => this.toTranscriptEntry(cue));
    }

    public getWalkSteps(): PatchwalkWalkStepTarget[] {
        // Every code cue (step overview + each sub-segment) is independently jumpable.
        return this.cues
            .filter((cue) => !cue.isSummary && cue.path && cue.range)
            .map((cue) => ({
                stepIndex: cue.index,
                stepId: cue.stepId,
                title: cue.title,
                basePath: this.payload.basePath,
                path: cue.path!,
                startLine: cue.range!.startLine,
                endLine: cue.range!.endLine,
            }));
    }

    public getOverview(): PatchwalkOverviewData {
        const steps: PatchwalkOverviewStep[] = [];
        let current: PatchwalkOverviewStep | undefined;
        for (const cue of this.cues) {
            if (cue.kind === 'step' && cue.path && cue.range) {
                current = {
                    stepIndex: cue.index,
                    stepId: cue.stepId,
                    title: cue.title,
                    narration: cue.narration,
                    path: cue.path,
                    startLine: cue.range.startLine,
                    endLine: cue.range.endLine,
                    segments: [],
                };
                steps.push(current);
            } else if (cue.kind === 'segment' && current && cue.range) {
                current.segments.push({
                    stepIndex: cue.index,
                    stepId: cue.stepId,
                    narration: cue.narration,
                    startLine: cue.range.startLine,
                    endLine: cue.range.endLine,
                });
            }
        }
        const segmentCount = steps.reduce((total, step) => total + step.segments.length, 0);
        const fileCount = new Set(steps.map((step) => step.path)).size;
        const wordCount = this.cues.reduce(
            (total, cue) => total + cue.narration.trim().split(/\s+/).filter(Boolean).length,
            0,
        );
        return {
            handoffId: this.payload.handoffId,
            summary: this.payload.summary,
            producer: this.payload.producer,
            fileCount,
            stepCount: steps.length,
            segmentCount,
            cueCount: this.cues.length,
            estimatedSeconds: Math.round((wordCount / 150) * 60),
            steps,
        };
    }

    public getSummary(): string {
        return this.payload.summary;
    }

    private toTranscriptEntry(cue: WalkCue): PatchwalkTranscriptEntry {
        return {
            stepIndex: cue.index,
            stepCount: this.cues.length,
            stepId: cue.stepId,
            title: cue.title,
            narration: cue.narration,
            kind: cue.kind,
            isSubSegment: cue.isSubSegment,
            parentStepId: cue.parentStepId,
            path: cue.path,
            startLine: cue.range?.startLine,
            endLine: cue.range?.endLine,
        };
    }

    public pause(): void {
        this.sequencer.pause();
    }

    public resume(): void {
        this.sequencer.resume();
    }

    public next(): void {
        this.sequencer.next();
    }

    public replay(): void {
        this.sequencer.replay();
    }

    public jumpTo(cueIndex: number): void {
        this.sequencer.jumpTo(cueIndex);
    }

    public previous(): void {
        this.sequencer.previous();
    }

    public async stop(): Promise<void> {
        this.sequencer.stop();
        try {
            await this.completionPromise;
        } catch (error) {
            if (!isPlaybackStoppedError(error)) {
                throw error;
            }
        }
    }

    public dispose(): void {
        this.visibleEditorsSubscription.dispose();
        this.narrator.clearPrefetch?.();
        this.progressEmitter.dispose();
        this.transcriptEmitter.dispose();
    }

    private async present(cue: WalkCue, signal: AbortSignal): Promise<void> {
        this.clearHighlight();
        // Render the NEXT line's audio now, so it plays the instant this one ends. This is what
        // removes the seconds of TTS startup that used to sit between every cue.
        this.primeNextNarration(cue.index);
        // The overview cue (and any cue lacking a code target) has no file: the overview editor is
        // the active surface for it, so there is nothing to open or highlight here.
        if (cue.isSummary || !cue.path || !cue.range) {
            return;
        }

        const document = await this.loadDocument(cue.path, cue.stepId);
        if (!document || signal.aborted) {
            return;
        }

        let editor: vscode.TextEditor;
        try {
            // preview:true reuses one tab instead of littering; preserveFocus:true keeps the user's
            // cursor where it was (P5 fix) — the walk drives the editor without hijacking it.
            // viewColumn:One pins code to the main column so an auto-advancing cue never buries the
            // overview editor (which lives in the Beside column).
            editor = await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.One,
                preview: true,
                preserveFocus: true,
            });
        } catch (error) {
            // Degrade gracefully: log and skip this cue rather than throwing out of the sequencer
            // and killing the whole walk.
            if (signal.aborted) {
                return;
            }
            const messageText = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `Unable to show file for cue ${cue.stepId}: ${messageText}`,
            );
            return;
        }

        const maximumLine = Math.max(document.lineCount - 1, 0);
        const startLine = Math.min(Math.max(cue.range.startLine - 1, 0), maximumLine);
        const endLine = Math.min(Math.max(cue.range.endLine - 1, startLine), maximumLine);
        const revealRange = new vscode.Range(startLine, 0, startLine, 0);
        const endLineCharacter = document.lineAt(endLine).range.end.character;
        const highlightRange = new vscode.Range(startLine, 0, endLine, endLineCharacter);
        // The "now speaking" marker (gutter icon + overview-ruler tick) sits on the first line of
        // the range being narrated — a moving locator distinct from the range band.
        const markerRange = new vscode.Range(startLine, 0, startLine, 0);

        this.activeDecoration = {
            fsPath: document.uri.fsPath,
            highlight: highlightRange,
            marker: markerRange,
        };
        // Make it a REAL selection, exactly as if the developer had dragged over the block: the code
        // is genuinely selected (they can copy it), not just faintly shaded. The decoration on top
        // keeps it vivid even while the editor is unfocused, where a native selection would dim.
        editor.selection = new vscode.Selection(startLine, 0, endLine, endLineCharacter);
        editor.revealRange(revealRange, vscode.TextEditorRevealType.InCenter);
        editor.setDecorations(this.highlightDecoration, [highlightRange]);
        editor.setDecorations(this.nowSpeakingDecoration, [markerRange]);

        // Warm the NEXT cue's file while this one narrates, so the silence between cues is the
        // configured gap and not file I/O.
        this.prefetchNextDocument(cue.index);
    }

    /**
     * Open a cue's file once and reuse it. Unopenable paths (missing, a directory, binary, too
     * large) are remembered so the walk degrades gracefully instead of retrying and stalling on
     * every cue.
     */
    private async loadDocument(
        relativePath: string,
        cueId: string,
    ): Promise<vscode.TextDocument | undefined> {
        const fileUri = resolveFileUri(this.payload.basePath, relativePath);
        if (!fileUri) {
            this.outputChannel.appendLine(
                `Unable to resolve file path for cue ${cueId}: ${relativePath}`,
            );
            return undefined;
        }

        const key = fileUri.fsPath;
        if (this.unopenablePaths.has(key)) {
            return undefined;
        }
        const cached = this.documentCache.get(key);
        // A cached document can be closed out from under us; reopen rather than fail the cue.
        if (cached && !cached.isClosed) {
            return cached;
        }

        try {
            await vscode.workspace.fs.stat(fileUri);
            const document = await vscode.workspace.openTextDocument(fileUri);
            this.documentCache.set(key, document);
            return document;
        } catch (error) {
            this.unopenablePaths.add(key);
            const messageText = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `Unable to open file for cue ${cueId}: ${key} (${messageText})`,
            );
            return undefined;
        }
    }

    private primeNextNarration(currentIndex: number): void {
        const next = this.cues[currentIndex + 1];
        if (next) {
            this.narrator.prime?.(next.narration);
        }
    }

    private prefetchNextDocument(currentIndex: number): void {
        const next = this.cues[currentIndex + 1];
        if (!next?.path) {
            return;
        }
        void this.loadDocument(next.path, next.stepId);
    }

    /**
     * Keep decorations in sync with the visible editors: the current target file shows the
     * highlight
     *
     * - Gutter marker, and every OTHER visible editor is cleared. This also removes a previous cue's
     *   decorations from a tab that the user backgrounded and later brought forward mid-walk.
     */
    private refreshDecorations(): void {
        const target = this.activeDecoration;
        for (const editor of vscode.window.visibleTextEditors) {
            const matches = target !== undefined && editor.document.uri.fsPath === target.fsPath;
            editor.setDecorations(this.highlightDecoration, matches ? [target.highlight] : []);
            editor.setDecorations(this.nowSpeakingDecoration, matches ? [target.marker] : []);
        }
    }

    private async speak(text: string, signal: AbortSignal): Promise<void> {
        try {
            await this.narrator.speak(text, signal);
        } catch (error) {
            // Aborts (stop/pause/next) must propagate so the sequencer can react.
            if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
                throw error;
            }
            // A missing/failed TTS engine degrades gracefully: the walk keeps moving through the
            // editor rather than dying. Phase 2 surfaces this honestly in the sidebar/tool result.
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`TTS unavailable for one utterance: ${message}`);
        }
    }

    private clearHighlight(): void {
        this.activeDecoration = undefined;
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.highlightDecoration, []);
            editor.setDecorations(this.nowSpeakingDecoration, []);
        }
    }
}

/**
 * Owns the single active walk in this window and hands out {@link PatchwalkPlaybackRun} handles.
 */
/**
 * A small amber "now speaking" dot rendered in the gutter of the line currently being narrated.
 * Gutter icons cannot reference a ThemeColor, so we pick a warm tone readable on light and dark.
 */
const NOW_SPEAKING_GUTTER_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="5" fill="#e5a50a"/>' +
    '<circle cx="8" cy="8" r="2.25" fill="#fff8e1"/></svg>';

const nowSpeakingGutterUri = vscode.Uri.parse(
    `data:image/svg+xml;base64,${Buffer.from(NOW_SPEAKING_GUTTER_SVG).toString('base64')}`,
);

export class PatchwalkPlaybackRunner implements vscode.Disposable {
    private readonly highlightDecoration: vscode.TextEditorDecorationType;
    private readonly nowSpeakingDecoration: vscode.TextEditorDecorationType;
    private readonly idleCleanupSubscription: vscode.Disposable;
    private activeRun: PatchwalkPlaybackRunImpl | undefined;
    /**
     * The last walk played in this window. The sidebar keeps its transcript on screen after a walk
     * ends (P4), so a click on it must still be able to play from that cue — which means replaying
     * this payload from the clicked index.
     */
    private lastPayload: PatchwalkHandoffPayload | undefined;
    private readonly activeRunChangeEmitter = new vscode.EventEmitter<
        PatchwalkPlaybackRun | undefined
    >();

    /** Fires with the new run when a walk starts, and with `undefined` when it ends. */
    public readonly onDidChangeActiveRun = this.activeRunChangeEmitter.event;

    private readonly narrator: WalkNarrator;

    public constructor(
        private readonly outputChannel: vscode.OutputChannel,
        speak: WalkSpeakFn | WalkNarrator = speakWithSystemVoice,
    ) {
        this.narrator = toNarrator(speak);
        // Paint the narrated block as a SELECTION, not a faint band. A slight shade is easy to miss —
        // the developer should see exactly which lines are being talked about. `present()` also sets
        // the editor's real selection; this decoration keeps it vivid while the editor is unfocused
        // (where a native selection dims to `inactiveSelectionBackground`).
        this.highlightDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.selectionBackground'),
            borderRadius: '2px',
        });
        this.nowSpeakingDecoration = vscode.window.createTextEditorDecorationType({
            gutterIconPath: nowSpeakingGutterUri,
            gutterIconSize: 'contain',
            overviewRulerLane: vscode.OverviewRulerLane.Full,
            overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
        });
        // VS Code only lets us clear decorations on VISIBLE editors, so a tab backgrounded mid-walk
        // could keep a stale highlight/marker after the walk ends. When no walk is active, clear our
        // decorations from any editor that (re)appears — the run manages them while one IS active.
        this.idleCleanupSubscription = vscode.window.onDidChangeVisibleTextEditors((editors) => {
            if (this.activeRun) {
                return;
            }
            for (const editor of editors) {
                editor.setDecorations(this.highlightDecoration, []);
                editor.setDecorations(this.nowSpeakingDecoration, []);
            }
        });
    }

    /** Start a walk and return its control handle immediately (does not block on completion). */
    public play(
        payload: PatchwalkHandoffPayload,
        options: { startIndex?: number } = {},
    ): PatchwalkPlaybackRun {
        if (this.activeRun) {
            throw new Error(
                `Patchwalk is already playing walk ${this.activeRun.handoffId} in this window.`,
            );
        }

        this.lastPayload = payload;
        const run = new PatchwalkPlaybackRunImpl(
            payload,
            this.outputChannel,
            this.highlightDecoration,
            this.nowSpeakingDecoration,
            this.narrator,
            options.startIndex ?? 0,
        );
        this.activeRun = run;
        // start() FIRST so `run.completion` is the real walk promise; only then attach the
        // cleanup, or it would bind to the initial resolved placeholder and clear activeRun early.
        run.start();
        run.completion
            .catch(() => {
                // Terminal errors are surfaced to the daemon by the worker via the run completion.
            })
            .finally(() => {
                if (this.activeRun === run) {
                    this.activeRun = undefined;
                    // eslint-disable-next-line unicorn/no-useless-undefined
                    this.activeRunChangeEmitter.fire(undefined);
                }
                run.dispose();
            });
        this.activeRunChangeEmitter.fire(run);
        return run;
    }

    public getActiveRun(): PatchwalkPlaybackRun | undefined {
        return this.activeRun;
    }

    /**
     * Play from a clicked cue. If a walk is running, it jumps (interrupting the current line); if
     * the last walk has already finished, its transcript is still on screen, so the click REPLAYS
     * that walk from the clicked cue. Returns false only when there is nothing to play at all.
     */
    public jumpToCue(cueIndex: number): boolean {
        if (this.activeRun) {
            this.activeRun.jumpTo(cueIndex);
            return true;
        }
        if (this.lastPayload) {
            this.play(this.lastPayload, { startIndex: cueIndex });
            return true;
        }
        return false;
    }

    public getStateSnapshot(): PatchwalkPlaybackStateSnapshot {
        return {
            state: this.activeRun?.getSnapshot().state ?? 'idle',
            activeHandoffId: this.activeRun?.handoffId ?? null,
        };
    }

    /** Stop the active walk (used by the global stop path). Resolves once playback has torn down. */
    public async stopActivePlayback(): Promise<boolean> {
        const run = this.activeRun;
        if (!run) {
            return false;
        }
        await run.stop();
        return true;
    }

    public dispose(): void {
        void this.activeRun?.stop();
        this.idleCleanupSubscription.dispose();
        this.highlightDecoration.dispose();
        this.nowSpeakingDecoration.dispose();
        this.activeRunChangeEmitter.dispose();
    }
}
