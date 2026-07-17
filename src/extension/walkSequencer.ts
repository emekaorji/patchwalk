/* eslint-disable no-await-in-loop -- a walk is heard one cue at a time — the whole point is that each cue finishes (or is interrupted) before the next begins. */
/**
 * The walk sequencer owns the _ordering and control_ of a walk — advancing through cues, and
 * responding to pause/resume/next/previous/stop — with zero dependency on VS Code or TTS. Those
 * side effects are injected (`present`, `speak`), which keeps this state machine unit-testable
 * headlessly. This is deliberate: the P1 fix (stop/pause must interrupt a running walk) lives here,
 * so it must be verifiable without a real editor or an audio device.
 */

export type PatchwalkPlaybackState = 'idle' | 'playing' | 'paused' | 'stopping';

/** What a cue represents: the opening overview, a step overview, or a step sub-segment. */
export type WalkCueKind = 'summary' | 'step' | 'segment';

export interface WalkCueRange {
    startLine: number;
    endLine: number;
}

export interface WalkCue {
    /** 0-based segment index across the whole flattened walk. Index 0 is always the summary. */
    index: number;
    /**
     * `'summary'` for the overview, the walkthrough step id for a step overview, or a composite
     * `${stepId}::${segmentId}` for a sub-segment — always unique so it can be a jump target.
     */
    stepId: string;
    title: string;
    narration: string;
    isSummary: boolean;
    kind: WalkCueKind;
    /** True for sub-segment cues (a tighter selection under a parent step). */
    isSubSegment: boolean;
    /** For sub-segments, the owning step's id (so the sidebar can nest them). */
    parentStepId?: string;
    /** File to open + range to highlight while this cue is narrated. Absent for the summary. */
    path?: string;
    range?: WalkCueRange;
}

export interface WalkProgress {
    stepIndex: number;
    stepCount: number;
    stepId: string;
    state: PatchwalkPlaybackState;
}

type ResumeAction = 'resume' | 'next' | 'previous' | 'stop' | 'jump';

export interface WalkSequencerOptions {
    cues: WalkCue[];
    /** Begin at this cue instead of the opening one (used to replay a finished walk from a click). */
    startIndex?: number;
    /** Reveal/highlight the cue in the editor. Aborts when `signal` fires. Summary cues may no-op. */
    present: (cue: WalkCue, signal: AbortSignal) => Promise<void>;
    /** Speak the cue narration. Aborting `signal` must stop audio promptly. */
    speak: (text: string, signal: AbortSignal) => Promise<void>;
    /**
     * Silence (ms) held before this cue is spoken — the beat between cues. The walk should sound
     * like one continuous passage, so this is normally short (a comma between sub-segments, a
     * breath between steps). Never applied before the very first cue. Must be interruptible.
     */
    gapMsForCue?: (cue: WalkCue) => number;
    onProgress?: (progress: WalkProgress) => void;
    onTranscript?: (cue: WalkCue) => void;
    onStateChange?: (state: PatchwalkPlaybackState) => void;
}

const createAbortError = (): Error => {
    const error = new Error('Patchwalk playback gap was interrupted.');
    error.name = 'AbortError';
    return error;
};

/** An abortable sleep: stop/pause/next must cut through the gap, not wait it out. */
const delay = (durationMs: number, signal: AbortSignal): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(createAbortError());
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, durationMs);
        function onAbort(): void {
            clearTimeout(timer);
            reject(createAbortError());
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
};

export class PatchwalkPlaybackStoppedError extends Error {
    public constructor() {
        super('Patchwalk playback was stopped.');
        this.name = 'PatchwalkPlaybackStoppedError';
    }
}

export const isPlaybackStoppedError = (error: unknown): boolean => {
    return error instanceof Error && error.name === 'PatchwalkPlaybackStoppedError';
};

/**
 * Drives one walk to completion. `run()` resolves when the walk finishes and rejects with a
 * {@link PatchwalkPlaybackStoppedError} when stopped. Control methods are safe to call from any
 * context (e.g. a WS message handler) at any time — they never block, and they interrupt the
 * currently-playing cue immediately instead of waiting for it to finish.
 */
export class WalkSequencer {
    private index = 0;
    private state: PatchwalkPlaybackState = 'idle';
    private stopped = false;
    private started = false;
    /** No gap before the walk's very first spoken line — it would just be dead air on launch. */
    private hasSpoken = false;
    private segmentAbort: AbortController | undefined;
    private pendingAction: 'pause' | 'next' | 'previous' | 'stop' | 'jump' | undefined;
    private pendingJumpIndex: number | undefined;
    private resumeGate:
        | { promise: Promise<ResumeAction>; resolve: (action: ResumeAction) => void }
        | undefined;

    public constructor(private readonly options: WalkSequencerOptions) {
        this.index = this.clampIndex(options.startIndex ?? 0);
    }

    private clampIndex(index: number): number {
        if (!Number.isInteger(index)) {
            return 0;
        }
        return Math.min(Math.max(index, 0), Math.max(this.options.cues.length - 1, 0));
    }

    public get currentState(): PatchwalkPlaybackState {
        return this.state;
    }

    public get currentIndex(): number {
        return this.index;
    }

    public get stepCount(): number {
        return this.options.cues.length;
    }

    public async run(): Promise<void> {
        if (this.started) {
            throw new Error('WalkSequencer.run() may only be called once.');
        }
        this.started = true;
        this.setState('playing');

        while (!this.stopped && this.index >= 0 && this.index < this.options.cues.length) {
            const cue = this.options.cues[this.index];
            this.emitProgress(cue);
            this.options.onTranscript?.(cue);

            const abortController = new AbortController();
            this.segmentAbort = abortController;
            let finishedNormally = false;
            try {
                await this.options.present(cue, abortController.signal);
                // The beat between cues. present() is prefetched, so this gap IS the silence the
                // listener hears — which is what makes it worth exposing as a setting.
                const gapMs = this.hasSpoken ? (this.options.gapMsForCue?.(cue) ?? 0) : 0;
                if (gapMs > 0) {
                    await delay(gapMs, abortController.signal);
                }
                await this.options.speak(cue.narration, abortController.signal);
                this.hasSpoken = true;
                finishedNormally = true;
            } catch (error) {
                // A genuine error (not one of our deliberate aborts) must surface.
                if (!abortController.signal.aborted && !isPlaybackStoppedError(error)) {
                    throw error;
                }
            } finally {
                this.segmentAbort = undefined;
            }

            if (this.stopped) {
                break;
            }

            const action = this.pendingAction;
            this.pendingAction = undefined;

            if (finishedNormally && !action) {
                this.index += 1;
                continue;
            }

            if (action === 'jump' && this.pendingJumpIndex !== undefined) {
                this.index = this.pendingJumpIndex;
                this.pendingJumpIndex = undefined;
                continue;
            }
            if (action === 'next') {
                this.index = Math.min(this.index + 1, this.options.cues.length);
                continue;
            }
            if (action === 'previous') {
                this.index = Math.max(this.index - 1, 0);
                continue;
            }
            if (action === 'pause') {
                this.setState('paused');
                this.emitProgress(cue);
                const resumed = await this.waitForResume();
                if (this.stopped || resumed === 'stop') {
                    break;
                }
                this.setState('playing');
                if (resumed === 'jump' && this.pendingJumpIndex !== undefined) {
                    this.index = this.pendingJumpIndex;
                    this.pendingJumpIndex = undefined;
                } else if (resumed === 'next') {
                    this.index = Math.min(this.index + 1, this.options.cues.length);
                } else if (resumed === 'previous') {
                    this.index = Math.max(this.index - 1, 0);
                }
                // 'resume' replays the current cue from the start.
                continue;
            }

            // Aborted with no recognized action: replay the current cue defensively.
        }

        if (this.stopped) {
            this.setState('idle');
            throw new PatchwalkPlaybackStoppedError();
        }

        this.setState('idle');
    }

    public pause(): void {
        if (this.state === 'playing') {
            this.pendingAction = 'pause';
            this.segmentAbort?.abort();
        }
    }

    public resume(): void {
        if (this.state === 'paused') {
            this.settleResume('resume');
        }
    }

    public next(): void {
        if (this.state === 'paused') {
            this.settleResume('next');
        } else if (this.state === 'playing') {
            this.pendingAction = 'next';
            this.segmentAbort?.abort();
        }
    }

    public previous(): void {
        if (this.state === 'paused') {
            this.settleResume('previous');
        } else if (this.state === 'playing') {
            this.pendingAction = 'previous';
            this.segmentAbort?.abort();
        }
    }

    /** Restart the current cue from the beginning (re-reveal + re-narrate). */
    public replay(): void {
        if (this.state === 'paused') {
            this.settleResume('resume');
        } else if (this.state === 'playing') {
            // Abort with no pending action → the run loop replays the current cue.
            this.pendingAction = undefined;
            this.segmentAbort?.abort();
        }
    }

    /**
     * Move playback to an arbitrary cue and play from there — the transcript/agenda click target.
     * Works while playing (interrupts the current line) and while paused (resumes at the new cue).
     */
    public jumpTo(index: number): void {
        const target = this.clampIndex(index);
        if (this.state === 'paused') {
            this.pendingJumpIndex = target;
            this.settleResume('jump');
            return;
        }
        if (this.state === 'playing') {
            this.pendingJumpIndex = target;
            this.pendingAction = 'jump';
            this.segmentAbort?.abort();
        }
    }

    public stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.setState('stopping');
        this.pendingAction = 'stop';
        this.segmentAbort?.abort();
        if (this.resumeGate) {
            this.settleResume('stop');
        }
    }

    private waitForResume(): Promise<ResumeAction> {
        let resolveGate!: (action: ResumeAction) => void;
        const promise = new Promise<ResumeAction>((resolve) => {
            resolveGate = resolve;
        });
        this.resumeGate = { promise, resolve: resolveGate };
        return promise;
    }

    private settleResume(action: ResumeAction): void {
        const gate = this.resumeGate;
        this.resumeGate = undefined;
        gate?.resolve(action);
    }

    private setState(state: PatchwalkPlaybackState): void {
        if (this.state === state) {
            return;
        }
        this.state = state;
        this.options.onStateChange?.(state);
    }

    private emitProgress(cue: WalkCue): void {
        this.options.onProgress?.({
            stepIndex: cue.index,
            stepCount: this.options.cues.length,
            stepId: cue.stepId,
            state: this.state,
        });
    }
}

/** A step as understood by {@link buildWalkCues}: the broad target plus optional sub-segments. */
export interface WalkCueStepInput {
    id: string;
    title: string;
    narration: string;
    path?: string;
    range?: WalkCueRange;
    segments?: Array<{ id?: string; narration: string; range: WalkCueRange }>;
}

/**
 * Flatten a walk into an ordered cue list: a summary overview cue, then for each step a
 * step-overview cue (broad range + step narration), then one cue per sub-segment (its own tighter
 * range + short narration). Sub-segments follow their parent step so the highlight narrows
 * progressively — a subtitle synced to the code — which is the whole point of the sub-segment
 * model. A step with no `segments` yields exactly one cue, so older single-range walks behave
 * identically.
 */
export const buildWalkCues = (summary: string, steps: WalkCueStepInput[]): WalkCue[] => {
    const cues: WalkCue[] = [
        {
            index: 0,
            stepId: 'summary',
            title: 'Overview',
            narration: summary,
            isSummary: true,
            kind: 'summary',
            isSubSegment: false,
        },
    ];
    for (const step of steps) {
        cues.push({
            index: cues.length,
            stepId: step.id,
            title: step.title,
            narration: step.narration,
            isSummary: false,
            kind: 'step',
            isSubSegment: false,
            path: step.path,
            range: step.range,
        });
        (step.segments ?? []).forEach((segment, segmentPosition) => {
            const segmentId = segment.id ?? `segment-${segmentPosition + 1}`;
            cues.push({
                index: cues.length,
                stepId: `${step.id}::${segmentId}`,
                title: step.title,
                narration: segment.narration,
                isSummary: false,
                kind: 'segment',
                isSubSegment: true,
                parentStepId: step.id,
                // Sub-segments live in the same file as their parent step.
                path: step.path,
                range: segment.range,
            });
        });
    }
    return cues;
};
