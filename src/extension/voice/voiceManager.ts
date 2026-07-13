import type { SpeechClip, TtsEngine, VoiceDescriptor, VoiceStatus } from './ttsEngine';
import { isAbortLike } from './ttsEngine';

/**
 * Picks the active voice engine (preferred → system → first), speaks through it, and falls back to
 * the system voice when a neural engine can't produce audio. When nothing can speak it records an
 * HONEST status (P6) instead of pretending the narration happened, and still lets the visual walk
 * proceed. VS Code-free so selection/fallback/status are unit-testable.
 */
const SYSTEM_ENGINE_ID = 'system';
/** At most a couple of cues are ever in flight; anything more just wastes synthesis and temp files. */
const MAX_PREFETCHED_CLIPS = 3;

interface PrefetchedClip {
    engineId: string;
    clip: Promise<SpeechClip>;
    /** Cancels just THIS render — abandoning a cue must not block the queue for the next one. */
    abort: AbortController;
}

export interface VoiceManagerOptions {
    engines: TtsEngine[];
    getPreferredId: () => string;
    /** Kill switch for pre-rendering. When false, every line is spoken live (slower, but simplest). */
    isPrefetchEnabled?: () => boolean;
    onStatusChange?: (status: VoiceStatus) => void;
    reportError?: (message: string) => void;
}

const createAbortError = (): Error => {
    const error = new Error('Narration was aborted.');
    error.name = 'AbortError';
    return error;
};

/**
 * Await a promise, but give up the moment the signal aborts.
 *
 * Without this, a stop/pause/next issued WHILE a line is still being synthesized would sit and wait
 * for that synthesis to finish (seconds) before it took effect — the walk would feel wedged.
 */
const untilAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) {
        return Promise.reject(createAbortError());
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(createAbortError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error as Error);
            },
        );
    });
};

export class VoiceManager {
    private status: VoiceStatus;
    /**
     * Audio synthesized ahead of time, keyed by the exact text. A system voice costs SECONDS to
     * load and synthesize; paying that between every cue is the dead air the walk was suffering
     * from. The playback runner primes the next cue while the current one is still being heard, so
     * by the time we need it, the audio is already sitting here ready to play.
     */
    private readonly prefetched = new Map<string, PrefetchedClip>();
    /** Aborted as a group when a walk ends, so no synthesis outlives the walk that asked for it. */
    private synthesisAbort = new AbortController();
    /**
     * Synthesis runs ONE AT A TIME. Two `say` processes fight over the OS speech service, which
     * makes the audio stutter and every line slower — the exact "wonky" behaviour a naive prefetch
     * causes.
     */
    private synthesisQueue: Promise<unknown> = Promise.resolve();

    public constructor(private readonly options: VoiceManagerOptions) {
        const engine = this.resolveEngine();
        this.status = { activeEngineId: engine.id, activeLabel: engine.label, ready: true };
    }

    public listVoices(): VoiceDescriptor[] {
        return this.options.engines.map((engine) => ({
            id: engine.id,
            label: engine.label,
            kind: engine.kind,
        }));
    }

    /** Register a downloaded neural engine (idempotent by id). */
    public registerEngine(engine: TtsEngine): void {
        if (!this.options.engines.some((existing) => existing.id === engine.id)) {
            this.options.engines.push(engine);
        }
    }

    public unregisterEngine(engineId: string): void {
        const index = this.options.engines.findIndex((engine) => engine.id === engineId);
        if (index >= 0) {
            this.options.engines[index].dispose?.();
            this.options.engines.splice(index, 1);
        }
    }

    public getStatus(): VoiceStatus {
        return this.status;
    }

    private prefetchEnabled(): boolean {
        return this.options.isPrefetchEnabled?.() ?? true;
    }

    /** Queue a synthesis so only one ever runs at a time (no two `say` processes fighting). */
    private enqueueSynthesis(engine: TtsEngine, text: string): PrefetchedClip {
        // Two levels of cancellation: this one render, and the whole walk.
        const abort = new AbortController();
        const walkSignal = this.synthesisAbort.signal;
        if (walkSignal.aborted) {
            abort.abort();
        } else {
            walkSignal.addEventListener('abort', () => abort.abort(), { once: true });
        }

        const render = () => engine.synthesize!(text, abort.signal);
        const clip = this.synthesisQueue.then(render, render);
        // Keep the chain alive even when one synthesis fails, and never leave it unhandled.
        this.synthesisQueue = clip.then(
            () => {},
            () => {},
        );
        clip.catch(() => {});
        return { engineId: engine.id, clip, abort };
    }

    /**
     * Pre-render an upcoming line so its audio can start immediately. Fire-and-forget: a failure
     * here is never fatal, because `speak` falls back to rendering (or speaking) it on the spot.
     */
    public readonly prime = (text: string): void => {
        if (!text?.trim() || !this.prefetchEnabled()) {
            return;
        }
        let engine: TtsEngine;
        try {
            engine = this.resolveEngine();
        } catch {
            return;
        }
        if (!engine.synthesize) {
            return; // This engine cannot pre-render; speak() will do it inline.
        }
        if (this.prefetched.get(text)?.engineId === engine.id) {
            return;
        }

        this.prefetched.set(text, this.enqueueSynthesis(engine, text));
        this.evictOldestPrefetch();
    };

    /**
     * Drop every pre-rendered clip AND kill any synthesis still running. Called when a walk ends or
     * is stopped — without this, `say -o` processes outlive their walk, pile up, and fight over the
     * audio device with whatever plays next.
     */
    public readonly clearPrefetch = (): void => {
        this.synthesisAbort.abort();
        this.synthesisAbort = new AbortController();
        this.synthesisQueue = Promise.resolve();
        for (const entry of this.prefetched.values()) {
            entry.abort.abort();
            void entry.clip.then((clip) => clip.dispose()).catch(() => {});
        }
        this.prefetched.clear();
    };

    private evictOldestPrefetch(): void {
        while (this.prefetched.size > MAX_PREFETCHED_CLIPS) {
            const oldestKey = this.prefetched.keys().next().value as string | undefined;
            if (oldestKey === undefined) {
                return;
            }
            const entry = this.prefetched.get(oldestKey);
            this.prefetched.delete(oldestKey);
            entry?.abort.abort();
            void entry?.clip.then((clip) => clip.dispose()).catch(() => {});
        }
    }

    /** WalkSpeakFn-compatible: narrate one utterance through the selected engine, with fallback. */
    public readonly speak = async (text: string, signal: AbortSignal): Promise<void> => {
        const engine = this.resolveEngine();

        if (this.prefetchEnabled() && engine.synthesize) {
            // Either it was primed while the previous line played, or we render it now — but always
            // through the same serialized queue, so we never run two synthesizers at once.
            let entry = this.prefetched.get(text);
            if (!entry || entry.engineId !== engine.id) {
                entry = this.enqueueSynthesis(engine, text);
            }
            this.prefetched.delete(text);

            try {
                // untilAbort: a stop/pause/next lands IMMEDIATELY, even mid-synthesis.
                const clip = await untilAbort(entry.clip, signal);
                try {
                    await clip.play(signal);
                } finally {
                    void clip.dispose();
                }
                this.setStatus({
                    activeEngineId: engine.id,
                    activeLabel: engine.label,
                    ready: true,
                });
                return;
            } catch (error) {
                if (isAbortLike(error, signal)) {
                    // Nobody will hear this line now, so stop rendering it — otherwise the abandoned
                    // `say -o` keeps running and holds up the queue for the cue we ARE about to play.
                    entry.abort.abort();
                    void entry.clip.then((clip) => clip.dispose()).catch(() => {});
                    throw error;
                }
                // Pre-rendering failed (no player, bad temp dir, ...) — fall through and speak live.
            }
        }

        try {
            await engine.speak(text, signal);
            this.setStatus({ activeEngineId: engine.id, activeLabel: engine.label, ready: true });
            return;
        } catch (error) {
            // stop / pause / next abort the utterance — those must propagate to the sequencer.
            if (isAbortLike(error, signal)) {
                throw error;
            }
            const detail = error instanceof Error ? error.message : String(error);

            // A neural engine that failed to synthesize/play → try the always-present system voice.
            if (engine.id !== SYSTEM_ENGINE_ID) {
                const systemEngine = this.options.engines.find((e) => e.id === SYSTEM_ENGINE_ID);
                if (systemEngine) {
                    try {
                        await systemEngine.speak(text, signal);
                        this.setStatus({
                            activeEngineId: systemEngine.id,
                            activeLabel: systemEngine.label,
                            ready: true,
                            detail: `${engine.label} unavailable; using the system voice.`,
                        });
                        return;
                    } catch (fallbackError) {
                        if (isAbortLike(fallbackError, signal)) {
                            throw fallbackError;
                        }
                    }
                }
            }

            // No engine could produce audio. Be honest (P6) and let the visual walk continue.
            this.setStatus({
                activeEngineId: engine.id,
                activeLabel: engine.label,
                ready: false,
                detail: `No voice could speak (${detail}).`,
            });
            this.options.reportError?.(`Patchwalk narration produced no audio: ${detail}`);
        }
    };

    private resolveEngine(): TtsEngine {
        const preferredId = this.options.getPreferredId();
        const preferred = this.options.engines.find((engine) => engine.id === preferredId);
        if (preferred) {
            return preferred;
        }
        const systemEngine = this.options.engines.find((engine) => engine.id === SYSTEM_ENGINE_ID);
        if (systemEngine) {
            return systemEngine;
        }
        if (this.options.engines.length > 0) {
            return this.options.engines[0];
        }
        throw new Error('VoiceManager has no engines registered.');
    }

    private setStatus(status: VoiceStatus): void {
        const changed =
            this.status.activeEngineId !== status.activeEngineId ||
            this.status.ready !== status.ready ||
            this.status.detail !== status.detail;
        this.status = status;
        if (changed) {
            this.options.onStatusChange?.(status);
        }
    }
}
