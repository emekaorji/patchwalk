/**
 * Pure, VS Code-free model for the walk-monitor sidebar: the view state the webview renders, the
 * message protocol between the webview and the extension, and small reducers. Keeping this out of
 * the webview glue makes the sidebar's logic unit-testable without a real editor.
 */

export type WalkMonitorPlaybackState = 'idle' | 'playing' | 'paused' | 'stopping';

export type WalkMonitorStepKind = 'summary' | 'step' | 'segment';

export interface WalkMonitorStep {
    stepIndex: number;
    stepId: string;
    title: string;
    narration: string;
    isSummary: boolean;
    /** 'summary' | 'step' | 'segment' — drives the transcript's step→sub-segment nesting. */
    kind: WalkMonitorStepKind;
    /** True for sub-segments (rendered indented under their parent step). */
    isSubSegment: boolean;
    /** For sub-segments, the owning step's id. */
    parentStepId?: string;
    /** 1-based line range being highlighted for this cue, when it targets code. */
    startLine?: number;
    endLine?: number;
}

export interface WalkMonitorViewState {
    active: boolean;
    handoffId: string | null;
    summary: string | null;
    steps: WalkMonitorStep[];
    currentStepIndex: number;
    stepCount: number;
    playbackState: WalkMonitorPlaybackState;
}

export interface WalkMonitorVoiceOption {
    id: string;
    label: string;
    kind: 'system' | 'neural';
    installed: boolean;
    downloading: boolean;
}

export interface WalkMonitorVoicesState {
    options: WalkMonitorVoiceOption[];
    activeId: string;
    /** Honest P6 note surfaced from the VoiceManager (e.g. "no voice could speak"). */
    detail?: string;
}

export const idleVoicesState = (): WalkMonitorVoicesState => ({ options: [], activeId: 'system' });

export interface WalkMonitorDaemonStatus {
    connected: boolean;
    detail: string;
    activeWalkElsewhere: boolean;
}

export const idleDaemonStatus = (): WalkMonitorDaemonStatus => ({
    connected: false,
    detail: 'Not connected',
    activeWalkElsewhere: false,
});

/** Extension → webview */
export type WalkMonitorHostMessage =
    | { type: 'state'; state: WalkMonitorViewState }
    | { type: 'voices'; voices: WalkMonitorVoicesState }
    | { type: 'daemonStatus'; status: WalkMonitorDaemonStatus };

/** Webview → extension */
export type WalkMonitorControlAction = 'pause' | 'resume' | 'next' | 'previous' | 'stop' | 'replay';

export type WalkMonitorWebviewMessage =
    | { type: 'ready' }
    | { type: 'control'; action: WalkMonitorControlAction }
    | { type: 'jump'; stepIndex: number }
    | { type: 'downloadVoice'; voiceId: string }
    | { type: 'removeVoice'; voiceId: string }
    | { type: 'selectVoice'; voiceId: string };

const CONTROL_ACTIONS: ReadonlySet<WalkMonitorControlAction> = new Set([
    'pause',
    'resume',
    'next',
    'previous',
    'stop',
    'replay',
]);

export const idleWalkMonitorState = (): WalkMonitorViewState => ({
    active: false,
    handoffId: null,
    summary: null,
    steps: [],
    currentStepIndex: -1,
    stepCount: 0,
    playbackState: 'idle',
});

export interface WalkMonitorTranscriptInput {
    stepIndex: number;
    stepId: string;
    title: string;
    narration: string;
    kind?: WalkMonitorStepKind;
    isSubSegment?: boolean;
    parentStepId?: string;
    startLine?: number;
    endLine?: number;
}

/** Build the initial state for a freshly launched walk (transcript shown, nothing played yet). */
export const walkMonitorStateFromWalk = (input: {
    handoffId: string;
    summary: string;
    transcript: WalkMonitorTranscriptInput[];
    playbackState?: WalkMonitorPlaybackState;
    currentStepIndex?: number;
}): WalkMonitorViewState => {
    const steps: WalkMonitorStep[] = input.transcript.map((entry) => {
        const kind: WalkMonitorStepKind =
            entry.kind ?? (entry.stepId === 'summary' ? 'summary' : 'step');
        return {
            stepIndex: entry.stepIndex,
            stepId: entry.stepId,
            title: entry.title,
            narration: entry.narration,
            isSummary: kind === 'summary',
            kind,
            isSubSegment: entry.isSubSegment ?? kind === 'segment',
            parentStepId: entry.parentStepId,
            startLine: entry.startLine,
            endLine: entry.endLine,
        };
    });
    return {
        active: true,
        handoffId: input.handoffId,
        summary: input.summary,
        steps,
        currentStepIndex: input.currentStepIndex ?? 0,
        stepCount: steps.length,
        playbackState: input.playbackState ?? 'playing',
    };
};

/** Apply a progress update (step advanced or state changed) to the current view state. */
export const applyWalkMonitorProgress = (
    state: WalkMonitorViewState,
    progress: { stepIndex: number; playbackState: WalkMonitorPlaybackState },
): WalkMonitorViewState => {
    return {
        ...state,
        currentStepIndex: progress.stepIndex,
        playbackState: progress.playbackState,
    };
};

/** Mark the walk finished but keep the transcript on screen so the reasoning persists (P4). */
export const walkMonitorStateOnEnd = (state: WalkMonitorViewState): WalkMonitorViewState => {
    return {
        ...state,
        active: false,
        playbackState: 'idle',
        currentStepIndex: -1,
    };
};

export const isWalkMonitorWebviewMessage = (value: unknown): value is WalkMonitorWebviewMessage => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const message = value as Record<string, unknown>;
    if (message.type === 'ready') {
        return true;
    }
    if (message.type === 'control') {
        return CONTROL_ACTIONS.has(message.action as WalkMonitorControlAction);
    }
    if (message.type === 'jump') {
        return typeof message.stepIndex === 'number' && Number.isInteger(message.stepIndex);
    }
    if (
        message.type === 'downloadVoice' ||
        message.type === 'removeVoice' ||
        message.type === 'selectVoice'
    ) {
        return typeof message.voiceId === 'string' && message.voiceId.length > 0;
    }
    return false;
};
