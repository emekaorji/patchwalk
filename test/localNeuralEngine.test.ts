/* eslint-disable no-await-in-loop -- polling loop: each tick must observe the state left by the previous one. */
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AudioPlayer } from '../src/extension/voice/killableAudioPlayer';
import { LocalNeuralEngine, splitIntoSentences } from '../src/extension/voice/localNeuralEngine';
import type { NeuralSynth, SynthResult } from '../src/extension/voice/neuralSynth';

const flushOnce = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
        if (predicate()) {
            return;
        }
        await flushOnce();
    }
    throw new Error('waitFor timed out');
};

class FakeSynth implements NeuralSynth {
    public readonly requested: string[] = [];
    public async synthesize(text: string): Promise<SynthResult> {
        this.requested.push(text);
        return { samples: new Float32Array([0.1, -0.1]), sampleRate: 22_050 };
    }
}

class FakePlayer implements AudioPlayer {
    public readonly played: string[] = [];
    public mode: 'immediate' | 'block' = 'immediate';
    private release: (() => void) | undefined;

    public play(filePath: string, signal: AbortSignal): Promise<void> {
        this.played.push(filePath);
        if (this.mode === 'immediate') {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            };
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            this.release = (): void => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            };
        });
    }

    public releaseOne(): void {
        const release = this.release;
        this.release = undefined;
        release?.();
    }
}

describe('splitIntoSentences', () => {
    it('splits on sentence-final punctuation and keeps it', () => {
        deepStrictEqual(splitIntoSentences('Hello world. How are you?! Fine'), [
            'Hello world.',
            'How are you?!',
            'Fine',
        ]);
    });
    it('returns the whole text when there is no punctuation', () => {
        deepStrictEqual(splitIntoSentences('just one line'), ['just one line']);
    });
    it('returns nothing for blank text', () => {
        deepStrictEqual(splitIntoSentences('   '), []);
    });
});

describe('local neural engine', () => {
    let tmp: string;
    beforeEach(async () => {
        tmp = await mkdtemp(join(tmpdir(), 'pw-neural-'));
    });
    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    const makeEngine = (synth: FakeSynth, player: FakePlayer): LocalNeuralEngine =>
        new LocalNeuralEngine({ id: 'kokoro', label: 'Kokoro', synth, player, tmpDir: tmp });

    it('synthesizes and plays each sentence in order', async () => {
        const synth = new FakeSynth();
        const player = new FakePlayer();
        await makeEngine(synth, player).speak('One. Two. Three.', new AbortController().signal);

        deepStrictEqual(synth.requested, ['One.', 'Two.', 'Three.']);
        strictEqual(player.played.length, 3);
    });

    it('prefetches the next sentence while the current one plays', async () => {
        const synth = new FakeSynth();
        const player = new FakePlayer();
        player.mode = 'block';
        const promise = makeEngine(synth, player).speak(
            'One. Two. Three.',
            new AbortController().signal,
        );

        // While the first utterance is playing, the second is already being synthesized.
        await waitFor(() => player.played.length === 1);
        await waitFor(() => synth.requested.length >= 2);
        deepStrictEqual(synth.requested.slice(0, 2), ['One.', 'Two.']);

        player.releaseOne();
        await waitFor(() => player.played.length === 2);
        player.releaseOne();
        await waitFor(() => player.played.length === 3);
        player.releaseOne();
        await promise;
    });

    it('aborts mid-utterance and does not play the rest', async () => {
        const synth = new FakeSynth();
        const player = new FakePlayer();
        player.mode = 'block';
        const controller = new AbortController();
        const promise = makeEngine(synth, player).speak('One. Two.', controller.signal);

        await waitFor(() => player.played.length === 1);
        controller.abort();

        await rejects(
            promise,
            (error: unknown) => error instanceof Error && error.name === 'AbortError',
        );
        strictEqual(player.played.length, 1);
    });

    it('cleans up its scratch WAV files', async () => {
        const synth = new FakeSynth();
        const player = new FakePlayer();
        await makeEngine(synth, player).speak('Only one.', new AbortController().signal);
        const { readdir } = await import('node:fs/promises');
        const leftover = (await readdir(tmp)).filter((name) => name.endsWith('.wav'));
        ok(leftover.length === 0, `expected no leftover wavs, found ${leftover.join(', ')}`);
    });
});
