/**
 * The voice layer. `TtsEngine` is the pluggable narration backend: the system voice is always
 * available; downloadable neural engines (Phase 2) implement the same interface, so swapping voices
 * never touches the playback runner. Everything here is VS Code-free so the selection/fallback
 * logic is unit-testable without a real editor or audio device.
 */

/** Audio that has already been synthesized and is ready to play the instant it is asked to. */
export interface SpeechClip {
    /** Play the ready audio. Aborting `signal` must stop it promptly. */
    play(signal: AbortSignal): Promise<void>;
    /** Release the underlying temp file. Safe to call more than once. */
    dispose(): Promise<void>;
}

export interface TtsEngine {
    /** Stable id, e.g. `system` or `kokoro-en-us-heart`. */
    readonly id: string;
    /** Human label for the Voices panel. */
    readonly label: string;
    readonly kind: 'system' | 'neural';
    /** Speak one utterance. Aborting `signal` must stop audio promptly (drives stop/pause/next). */
    speak(text: string, signal: AbortSignal): Promise<void>;
    /**
     * Synthesize AHEAD of time, off the critical path.
     *
     * Speech engines are slow to start: spawning `say` per cue costs seconds (voice load +
     * synthesis) BEFORE any audio is heard, which is dead air between every segment. An engine that
     * implements this lets the VoiceManager synthesize the NEXT cue while the current one is still
     * playing, so the only latency left is starting the player.
     */
    synthesize?(text: string, signal?: AbortSignal): Promise<SpeechClip>;
    dispose?(): void;
}

export interface VoiceDescriptor {
    id: string;
    label: string;
    kind: 'system' | 'neural';
}

export interface VoiceStatus {
    activeEngineId: string;
    activeLabel: string;
    /** Whether the active engine actually produced audio for the last utterance. */
    ready: boolean;
    /** Honest note when no audio could play (P6) — surfaced to the sidebar / a one-time notice. */
    detail?: string;
}

export const isAbortLike = (error: unknown, signal: AbortSignal): boolean => {
    return signal.aborted || (error instanceof Error && error.name === 'AbortError');
};
