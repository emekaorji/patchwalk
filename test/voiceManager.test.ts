import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';

import { resolveSpeechCommand } from '../src/extension/voice/systemVoiceEngine';
import type { TtsEngine } from '../src/extension/voice/ttsEngine';
import { VoiceManager } from '../src/extension/voice/voiceManager';

type SpeakBehavior = 'ok' | 'fail' | 'abort';

const makeEngine = (
    id: string,
    kind: 'system' | 'neural',
    behavior: SpeakBehavior,
    spoken: string[] = [],
): TtsEngine => ({
    id,
    label: `${id} voice`,
    kind,
    async speak(text: string, signal: AbortSignal): Promise<void> {
        if (behavior === 'abort') {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
        }
        if (behavior === 'fail') {
            throw new Error(`${id} has no binary`);
        }
        void signal;
        spoken.push(`${id}:${text}`);
    },
});

const noSignal = (): AbortSignal => new AbortController().signal;

describe('voice manager prefetch (kills per-cue TTS startup)', () => {
    const createSlowEngine = () => {
        const synthesized: string[] = [];
        const played: string[] = [];
        let liveSpeaks = 0;
        return {
            synthesized,
            played,
            get liveSpeaks() {
                return liveSpeaks;
            },
            engine: {
                id: 'system',
                label: 'System voice',
                kind: 'system' as const,
                async speak(text: string): Promise<void> {
                    liveSpeaks += 1; // the SLOW path: synthesis happens on the critical path
                    played.push(text);
                },
                async synthesize(text: string) {
                    synthesized.push(text);
                    return {
                        play: async () => {
                            played.push(text);
                        },
                        dispose: async () => {},
                    };
                },
            },
        };
    };

    it('plays a primed line from the pre-rendered clip, never re-synthesizing it live', async () => {
        const fake = createSlowEngine();
        const manager = new VoiceManager({
            engines: [fake.engine],
            getPreferredId: () => 'system',
        });

        manager.prime('Second line.');
        await manager.speak('Second line.', new AbortController().signal);

        deepStrictEqual(fake.synthesized, ['Second line.']);
        deepStrictEqual(fake.played, ['Second line.']);
        strictEqual(fake.liveSpeaks, 0, 'a primed line must not go through the slow live path');
    });

    it('renders an unprimed line through the same queue (never a second live `say`)', async () => {
        const fake = createSlowEngine();
        const manager = new VoiceManager({
            engines: [fake.engine],
            getPreferredId: () => 'system',
        });

        await manager.speak('Unprimed.', new AbortController().signal);

        // Two speech processes fight over the OS speech service, so EVERY line takes the clip path.
        deepStrictEqual(fake.synthesized, ['Unprimed.']);
        deepStrictEqual(fake.played, ['Unprimed.']);
        strictEqual(fake.liveSpeaks, 0);
    });

    it('falls back to the live voice when pre-rendering fails', async () => {
        let liveSpeaks = 0;
        const manager = new VoiceManager({
            engines: [
                {
                    id: 'system',
                    label: 'System voice',
                    kind: 'system' as const,
                    async speak(): Promise<void> {
                        liveSpeaks += 1;
                    },
                    async synthesize(): Promise<never> {
                        throw new Error('no audio device');
                    },
                },
            ],
            getPreferredId: () => 'system',
        });

        manager.prime('Broken.');
        await manager.speak('Broken.', new AbortController().signal);

        strictEqual(liveSpeaks, 1, 'a failed prefetch must not silence the walk');
    });

    it('disposes pre-rendered clips when a walk ends (no leaked temp files)', async () => {
        let disposed = 0;
        const manager = new VoiceManager({
            engines: [
                {
                    id: 'system',
                    label: 'System voice',
                    kind: 'system' as const,
                    async speak(): Promise<void> {},
                    async synthesize() {
                        return {
                            play: async () => {},
                            dispose: async () => {
                                disposed += 1;
                            },
                        };
                    },
                },
            ],
            getPreferredId: () => 'system',
        });

        manager.prime('One.');
        manager.prime('Two.');
        await new Promise((resolve) => setImmediate(resolve));
        manager.clearPrefetch();
        await new Promise((resolve) => setImmediate(resolve));

        strictEqual(disposed, 2);
    });
});

describe('voice manager', () => {
    it('speaks through the preferred engine and reports it ready', async () => {
        const spoken: string[] = [];
        const manager = new VoiceManager({
            engines: [
                makeEngine('system', 'system', 'ok', spoken),
                makeEngine('kokoro', 'neural', 'ok', spoken),
            ],
            getPreferredId: () => 'kokoro',
        });
        await manager.speak('hello', noSignal());
        deepStrictEqual(spoken, ['kokoro:hello']);
        strictEqual(manager.getStatus().activeEngineId, 'kokoro');
        strictEqual(manager.getStatus().ready, true);
    });

    it('falls back to the system voice when the neural engine fails', async () => {
        const spoken: string[] = [];
        const statuses: string[] = [];
        const manager = new VoiceManager({
            engines: [
                makeEngine('system', 'system', 'ok', spoken),
                makeEngine('kokoro', 'neural', 'fail', spoken),
            ],
            getPreferredId: () => 'kokoro',
            onStatusChange: (status) => statuses.push(`${status.activeEngineId}:${status.ready}`),
        });
        await manager.speak('hi', noSignal());
        deepStrictEqual(spoken, ['system:hi']);
        strictEqual(manager.getStatus().activeEngineId, 'system');
        strictEqual(manager.getStatus().ready, true);
        ok(manager.getStatus().detail?.includes('using the system voice'));
    });

    it('records an honest not-ready status (P6) when nothing can speak, and does not throw', async () => {
        const errors: string[] = [];
        const manager = new VoiceManager({
            engines: [
                makeEngine('system', 'system', 'fail'),
                makeEngine('kokoro', 'neural', 'fail'),
            ],
            getPreferredId: () => 'kokoro',
            reportError: (message) => errors.push(message),
        });
        // Must NOT throw — the visual walk should still proceed.
        await manager.speak('hi', noSignal());
        strictEqual(manager.getStatus().ready, false);
        ok(manager.getStatus().detail?.startsWith('No voice could speak'));
        strictEqual(errors.length, 1);
    });

    it('propagates aborts so stop/pause/next reach the sequencer', async () => {
        const controller = new AbortController();
        controller.abort();
        const manager = new VoiceManager({
            engines: [makeEngine('system', 'system', 'abort')],
            getPreferredId: () => 'system',
        });
        await rejects(
            manager.speak('hi', controller.signal),
            (error: unknown) => error instanceof Error && error.name === 'AbortError',
        );
    });

    it('resolves to the system voice when the preferred id is unknown', async () => {
        const spoken: string[] = [];
        const manager = new VoiceManager({
            engines: [makeEngine('system', 'system', 'ok', spoken)],
            getPreferredId: () => 'does-not-exist',
        });
        await manager.speak('x', noSignal());
        deepStrictEqual(spoken, ['system:x']);
    });

    it('lists the registered voices for the sidebar', () => {
        const manager = new VoiceManager({
            engines: [makeEngine('system', 'system', 'ok'), makeEngine('kokoro', 'neural', 'ok')],
            getPreferredId: () => 'system',
        });
        deepStrictEqual(
            manager.listVoices().map((voice) => `${voice.id}:${voice.kind}`),
            ['system:system', 'kokoro:neural'],
        );
    });
});

describe('voice manager abort safety (the "wonky audio" regressions)', () => {
    it('a stop lands IMMEDIATELY, even while the line is still being synthesized', async () => {
        let synthAborted = false;
        const manager = new VoiceManager({
            engines: [
                {
                    id: 'system',
                    label: 'System voice',
                    kind: 'system' as const,
                    async speak(): Promise<void> {},
                    async synthesize(_text: string, signal?: AbortSignal) {
                        // A slow engine: 5s to render (a real system voice takes seconds).
                        await new Promise((resolve, reject) => {
                            const timer = setTimeout(resolve, 5000);
                            signal?.addEventListener('abort', () => {
                                clearTimeout(timer);
                                synthAborted = true;
                                const error = new Error('aborted');
                                error.name = 'AbortError';
                                reject(error);
                            });
                        });
                        return { play: async () => {}, dispose: async () => {} };
                    },
                },
            ],
            getPreferredId: () => 'system',
        });

        manager.prime('A slow line.');
        const controller = new AbortController();
        const startedAt = Date.now();
        const speaking = manager.speak('A slow line.', controller.signal);
        setTimeout(() => controller.abort(), 20);

        await rejects(speaking, (error: unknown) => (error as Error).name === 'AbortError');
        const elapsed = Date.now() - startedAt;
        ok(elapsed < 1000, `stop must not wait out synthesis (took ${elapsed}ms)`);
        strictEqual(synthAborted, true, 'the abort must reach the synthesizer');
    });

    it('ending a walk kills synthesis that is still running (no orphaned processes)', async () => {
        let aborted = false;
        const manager = new VoiceManager({
            engines: [
                {
                    id: 'system',
                    label: 'System voice',
                    kind: 'system' as const,
                    async speak(): Promise<void> {},
                    async synthesize(_text: string, signal?: AbortSignal) {
                        await new Promise((resolve, reject) => {
                            const timer = setTimeout(resolve, 5000);
                            signal?.addEventListener('abort', () => {
                                clearTimeout(timer);
                                aborted = true;
                                reject(new Error('killed'));
                            });
                        });
                        return { play: async () => {}, dispose: async () => {} };
                    },
                },
            ],
            getPreferredId: () => 'system',
        });

        manager.prime('Still rendering when the walk ends.');
        await new Promise((resolve) => setTimeout(resolve, 20));
        manager.clearPrefetch(); // the walk ended
        await new Promise((resolve) => setTimeout(resolve, 20));

        strictEqual(aborted, true, 'synthesis must not outlive the walk that asked for it');
    });

    it('never runs two synthesizers at once (they fight over the OS speech service)', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const manager = new VoiceManager({
            engines: [
                {
                    id: 'system',
                    label: 'System voice',
                    kind: 'system' as const,
                    async speak(): Promise<void> {},
                    async synthesize() {
                        inFlight += 1;
                        maxInFlight = Math.max(maxInFlight, inFlight);
                        await new Promise((resolve) => setTimeout(resolve, 30));
                        inFlight -= 1;
                        return { play: async () => {}, dispose: async () => {} };
                    },
                },
            ],
            getPreferredId: () => 'system',
        });

        manager.prime('One.');
        manager.prime('Two.');
        manager.prime('Three.');
        await manager.speak('One.', new AbortController().signal);
        await manager.speak('Two.', new AbortController().signal);

        strictEqual(maxInFlight, 1, `synthesis must be serialized, saw ${maxInFlight} at once`);
    });

    it('the kill switch falls back to speaking live', async () => {
        let liveSpeaks = 0;
        let synthCalls = 0;
        const manager = new VoiceManager({
            engines: [
                {
                    id: 'system',
                    label: 'System voice',
                    kind: 'system' as const,
                    async speak(): Promise<void> {
                        liveSpeaks += 1;
                    },
                    async synthesize() {
                        synthCalls += 1;
                        return { play: async () => {}, dispose: async () => {} };
                    },
                },
            ],
            getPreferredId: () => 'system',
            isPrefetchEnabled: () => false,
        });

        manager.prime('Nope.');
        await manager.speak('Nope.', new AbortController().signal);

        strictEqual(synthCalls, 0);
        strictEqual(liveSpeaks, 1);
    });
});

describe('system voice command building', () => {
    it('passes the chosen voice to `say` (the biggest pacing lever on macOS)', () => {
        const spoken = resolveSpeechCommand('darwin', 'Hello.', { voice: 'Daniel' });
        deepStrictEqual(spoken, { command: 'say', args: ['-v', 'Daniel', 'Hello.'] });
    });

    it('synthesizes to a file without playing it (the prefetch path)', () => {
        const synth = resolveSpeechCommand('darwin', 'Hello.', {
            voice: 'Daniel',
            outputFile: '/tmp/clip.aiff',
        });
        deepStrictEqual(synth, {
            command: 'say',
            args: ['-v', 'Daniel', '-o', '/tmp/clip.aiff', 'Hello.'],
        });
    });

    it('falls back to the OS default voice when none is configured', () => {
        deepStrictEqual(resolveSpeechCommand('darwin', 'Hi.'), { command: 'say', args: ['Hi.'] });
    });

    it('writes a wav on windows and linux', () => {
        const windows = resolveSpeechCommand('win32', 'Hi.', { outputFile: String.raw`C:\a.wav` });
        strictEqual(windows.command, 'powershell');
        ok(windows.args[2].includes('SetOutputToWaveFile'));

        const linux = resolveSpeechCommand('linux', 'Hi.', { outputFile: '/tmp/a.wav' });
        deepStrictEqual(linux, { command: 'espeak-ng', args: ['-w', '/tmp/a.wav', 'Hi.'] });
    });
});
