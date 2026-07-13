/* eslint-disable no-await-in-loop -- sentences are spoken in order — synthesis is pipelined, but playback is strictly sequential. */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AudioPlayer } from './killableAudioPlayer';
import type { NeuralSynth, SynthResult } from './neuralSynth';
import type { TtsEngine } from './ttsEngine';
import { encodeWav } from './wav';

/**
 * Split narration into sentence-sized utterances. sherpa-onnx synthesizes per-utterance (non-
 * streaming), so chunking is what lets pause/stop/next land at natural boundaries. Pure →
 * testable.
 */
export const splitIntoSentences = (text: string): string[] => {
    const normalized = text.replaceAll(/\s+/g, ' ').trim();
    if (!normalized) {
        return [];
    }
    const parts = normalized.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
    const sentences = (parts ?? [normalized]).map((part) => part.trim()).filter(Boolean);
    return sentences.length > 0 ? sentences : [normalized];
};

const createAbortError = (): Error => {
    const error = new Error('Neural narration was aborted.');
    error.name = 'AbortError';
    return error;
};

export interface LocalNeuralEngineOptions {
    id: string;
    label: string;
    synth: NeuralSynth;
    player: AudioPlayer;
    /** Directory for scratch WAV files (e.g. the extension's globalStorage tmp). */
    tmpDir: string;
}

/**
 * A downloadable neural voice: synthesize each sentence, play it through a killable player, and
 * PREFETCH the next sentence's synthesis while the current one plays (Kokoro is ~1x realtime, so
 * the overlap keeps narration gapless). Aborting stops the current audio immediately (the P1 fix
 * reaches real audio through the killable player). VS Code-free and dependency-injected → fully
 * testable.
 */
export class LocalNeuralEngine implements TtsEngine {
    public readonly id: string;
    public readonly label: string;
    public readonly kind = 'neural' as const;
    private counter = 0;

    public constructor(private readonly options: LocalNeuralEngineOptions) {
        this.id = options.id;
        this.label = options.label;
    }

    public async speak(text: string, signal: AbortSignal): Promise<void> {
        const sentences = splitIntoSentences(text);
        if (sentences.length === 0) {
            return;
        }
        if (signal.aborted) {
            throw createAbortError();
        }

        let pending: Promise<SynthResult> = this.options.synth.synthesize(sentences[0]);
        try {
            for (let index = 0; index < sentences.length; index += 1) {
                if (signal.aborted) {
                    throw createAbortError();
                }
                const result = await pending;

                // Kick off synthesis of the next sentence before playing the current one.
                if (index + 1 < sentences.length) {
                    pending = this.options.synth.synthesize(sentences[index + 1]);
                }

                if (signal.aborted) {
                    throw createAbortError();
                }

                const wav = encodeWav(result.samples, result.sampleRate);
                this.counter += 1;
                const wavPath = join(this.options.tmpDir, `pw-${this.id}-${this.counter}.wav`);
                await writeFile(wavPath, wav);
                try {
                    await this.options.player.play(wavPath, signal);
                } finally {
                    await rm(wavPath, { force: true });
                }
            }
        } finally {
            // Never leave a prefetched synthesis floating unhandled (e.g. when aborted mid-walk).
            void pending.catch(() => {});
        }
    }

    public dispose(): void {
        this.options.synth.dispose?.();
    }
}
