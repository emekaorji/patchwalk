/* eslint-disable no-await-in-loop -- polling loop: each tick must observe the state left by the previous one. */
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';

import type { WalkCue } from '../src/extension/walkSequencer';
import {
    buildWalkCues,
    isPlaybackStoppedError,
    WalkSequencer,
} from '../src/extension/walkSequencer';

/**
 * These tests exercise the Phase 0 P1 fix — stop/pause/next must interrupt a _running_ utterance,
 * not wait for it to finish — entirely headlessly, by injecting a controllable fake TTS.
 */

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

interface Harness {
    present: (cue: WalkCue, signal: AbortSignal) => Promise<void>;
    speak: (text: string, signal: AbortSignal) => Promise<void>;
    readonly spoken: string[];
    readonly presented: string[];
    readonly pendingText: string | undefined;
    finishCurrent: () => void;
    waitForSpeakStart: () => Promise<void>;
}

const createHarness = (): Harness => {
    const spoken: string[] = [];
    const presented: string[] = [];
    let pending: { text: string; resolve: () => void } | undefined;
    const startWaiters: Array<() => void> = [];

    const speak = (text: string, signal: AbortSignal): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
                signal.removeEventListener('abort', onAbort);
                if (pending?.text === text) {
                    pending = undefined;
                }
                const abortError = new Error('aborted');
                abortError.name = 'AbortError';
                reject(abortError);
            };
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            pending = {
                text,
                resolve: () => {
                    signal.removeEventListener('abort', onAbort);
                    spoken.push(text);
                    pending = undefined;
                    resolve();
                },
            };
            startWaiters.splice(0).forEach((notify) => notify());
        });

    return {
        speak,
        present: async (cue: WalkCue): Promise<void> => {
            presented.push(cue.stepId);
        },
        spoken,
        presented,
        get pendingText() {
            return pending?.text;
        },
        finishCurrent: () => pending?.resolve(),
        waitForSpeakStart: () =>
            new Promise<void>((resolve) => {
                if (pending) {
                    resolve();
                    return;
                }
                startWaiters.push(resolve);
            }),
    };
};

const CUES: WalkCue[] = buildWalkCues('Overview narration.', [
    { id: 'step-1', title: 'One', narration: 'First step.' },
    { id: 'step-2', title: 'Two', narration: 'Second step.' },
]);

const drainToCompletion = async (harness: Harness, completion: Promise<void>): Promise<void> => {
    let done = false;
    completion.then(
        () => {
            done = true;
        },
        () => {
            done = true;
        },
    );
    for (let attempt = 0; attempt < 2000 && !done; attempt += 1) {
        if (harness.pendingText) {
            harness.finishCurrent();
        }
        await flushOnce();
    }
    await completion;
};

describe('walk sequencer', () => {
    it('builds a summary cue followed by one cue per step', () => {
        deepStrictEqual(
            CUES.map((cue) => cue.stepId),
            ['summary', 'step-1', 'step-2'],
        );
        strictEqual(CUES[0].isSummary, true);
        strictEqual(CUES[1].isSummary, false);
    });

    it('expands a step with sub-segments into overview + one cue per sub-segment', () => {
        const cues = buildWalkCues('Overview.', [
            {
                id: 'step-1',
                title: 'A function',
                narration: 'Whole function.',
                path: 'src/thing.ts',
                range: { startLine: 1, endLine: 30 },
                segments: [
                    { narration: 'Setup.', range: { startLine: 2, endLine: 6 } },
                    { id: 'core', narration: 'Core.', range: { startLine: 8, endLine: 24 } },
                ],
            },
            {
                id: 'step-2',
                title: 'Tail',
                narration: 'A leaf step.',
                path: 'src/thing.ts',
                range: { startLine: 31, endLine: 33 },
            },
        ]);

        // summary, step-1 overview, 2 sub-segments, step-2 (leaf) → 5 cues with sequential indices.
        deepStrictEqual(
            cues.map((cue) => cue.stepId),
            ['summary', 'step-1', 'step-1::segment-1', 'step-1::core', 'step-2'],
        );
        deepStrictEqual(
            cues.map((cue) => cue.index),
            [0, 1, 2, 3, 4],
        );
        deepStrictEqual(
            cues.map((cue) => cue.kind),
            ['summary', 'step', 'segment', 'segment', 'step'],
        );
        // Sub-segments carry the parent step id, their own range, and inherit the file path.
        strictEqual(cues[2].parentStepId, 'step-1');
        strictEqual(cues[2].isSubSegment, true);
        deepStrictEqual(cues[2].range, { startLine: 2, endLine: 6 });
        strictEqual(cues[2].path, 'src/thing.ts');
        strictEqual(cues[4].isSubSegment, false);
    });

    it('plays every cue in order when uninterrupted', async () => {
        const harness = createHarness();
        const sequencer = new WalkSequencer({
            cues: CUES,
            present: harness.present,
            speak: async (text: string) => {
                harness.spoken.push(text);
            },
        });

        await sequencer.run();

        deepStrictEqual(harness.presented, ['summary', 'step-1', 'step-2']);
        deepStrictEqual(harness.spoken, ['Overview narration.', 'First step.', 'Second step.']);
        strictEqual(sequencer.currentState, 'idle');
    });

    it('stop() interrupts the current utterance and rejects with a stopped error', async () => {
        const harness = createHarness();
        const sequencer = new WalkSequencer({
            cues: CUES,
            present: harness.present,
            speak: harness.speak,
        });

        const completion = sequencer.run();
        await harness.waitForSpeakStart();
        strictEqual(sequencer.currentState, 'playing');

        sequencer.stop();

        await rejects(completion, (error: unknown) => isPlaybackStoppedError(error));
        // The summary was interrupted mid-utterance, so nothing finished speaking.
        deepStrictEqual(harness.spoken, []);
    });

    it('pause() halts immediately and resume() replays the current cue', async () => {
        const harness = createHarness();
        const sequencer = new WalkSequencer({
            cues: CUES,
            present: harness.present,
            speak: harness.speak,
        });

        const completion = sequencer.run();
        await harness.waitForSpeakStart();

        sequencer.pause();
        await waitFor(() => sequencer.currentState === 'paused');
        deepStrictEqual(harness.spoken, []); // summary was aborted, not completed

        sequencer.resume();
        await waitFor(() => sequencer.currentState === 'playing');
        await drainToCompletion(harness, completion);

        // Summary is replayed after resume, then the two steps play.
        deepStrictEqual(harness.spoken, ['Overview narration.', 'First step.', 'Second step.']);
    });

    it('next() skips the current cue and advances', async () => {
        const harness = createHarness();
        const sequencer = new WalkSequencer({
            cues: CUES,
            present: harness.present,
            speak: harness.speak,
        });

        const completion = sequencer.run();
        await harness.waitForSpeakStart(); // summary is speaking
        sequencer.next(); // abort summary, jump to step-1

        await drainToCompletion(harness, completion);

        // Summary was skipped (aborted, never completed); the two steps played in order.
        deepStrictEqual(harness.spoken, ['First step.', 'Second step.']);
    });

    it("holds a gap between cues, but never before the walk's first spoken line", async () => {
        const harness = createHarness();
        const gapped: string[] = [];
        const sequencer = new WalkSequencer({
            cues: CUES,
            present: harness.present,
            speak: async (text: string) => {
                harness.spoken.push(text);
            },
            gapMsForCue: (cue) => {
                gapped.push(cue.stepId);
                return 1;
            },
        });

        await sequencer.run();

        // The opening line plays immediately — a leading gap would just be dead air on launch.
        deepStrictEqual(gapped, ['step-1', 'step-2']);
    });

    it('stop() cuts through the gap instead of waiting it out', async () => {
        const harness = createHarness();
        const sequencer = new WalkSequencer({
            cues: CUES,
            present: harness.present,
            speak: async (text: string) => {
                harness.spoken.push(text);
            },
            gapMsForCue: () => 60_000,
        });

        const completion = sequencer.run();
        await waitFor(() => harness.spoken.length === 1); // summary spoken; now inside the long gap

        const startedAt = Date.now();
        sequencer.stop();
        await rejects(completion, (error: unknown) => isPlaybackStoppedError(error));

        ok(Date.now() - startedAt < 2000, 'stop must interrupt the gap, not wait it out');
    });

    it('jumpTo() interrupts the current line and plays from the clicked cue', async () => {
        const harness = createHarness();
        const sequencer = new WalkSequencer({
            cues: CUES,
            present: harness.present,
            speak: harness.speak,
        });

        const completion = sequencer.run();
        await harness.waitForSpeakStart(); // the summary is speaking
        sequencer.jumpTo(2); // click 'step-2' in the transcript

        await drainToCompletion(harness, completion);

        // The summary was cut off mid-line; playback resumed at the clicked cue.
        deepStrictEqual(harness.spoken, ['Second step.']);
        strictEqual(harness.presented.at(-1), 'step-2');
    });

    it('jumpTo() while PAUSED resumes at the clicked cue', async () => {
        const harness = createHarness();
        const sequencer = new WalkSequencer({
            cues: CUES,
            present: harness.present,
            speak: harness.speak,
        });

        const completion = sequencer.run();
        await harness.waitForSpeakStart();
        sequencer.pause();
        await waitFor(() => sequencer.currentState === 'paused');

        sequencer.jumpTo(1);
        await waitFor(() => sequencer.currentState === 'playing');
        await drainToCompletion(harness, completion);

        deepStrictEqual(harness.spoken, ['First step.', 'Second step.']);
    });

    it('startIndex replays a finished walk from a clicked cue', async () => {
        const harness = createHarness();
        const sequencer = new WalkSequencer({
            cues: CUES,
            startIndex: 2,
            present: harness.present,
            speak: async (text: string) => {
                harness.spoken.push(text);
            },
        });

        await sequencer.run();

        deepStrictEqual(harness.spoken, ['Second step.']);
        deepStrictEqual(harness.presented, ['step-2']);
    });

    it('jumpTo() clamps an out-of-range cue index instead of derailing the walk', async () => {
        const harness = createHarness();
        const sequencer = new WalkSequencer({
            cues: CUES,
            present: harness.present,
            speak: harness.speak,
        });

        const completion = sequencer.run();
        await harness.waitForSpeakStart();
        sequencer.jumpTo(999);

        await drainToCompletion(harness, completion);

        deepStrictEqual(harness.spoken, ['Second step.']); // clamped to the last cue
    });

    it('previous() returns to the prior cue', async () => {
        const harness = createHarness();
        const sequencer = new WalkSequencer({
            cues: CUES,
            present: harness.present,
            speak: harness.speak,
        });

        const completion = sequencer.run();
        await harness.waitForSpeakStart();
        harness.finishCurrent(); // summary completes
        await harness.waitForSpeakStart(); // step-1 speaking
        sequencer.previous(); // back to summary

        await drainToCompletion(harness, completion);

        // summary (finished) → previous replays summary → step-1 → step-2
        deepStrictEqual(harness.spoken, [
            'Overview narration.',
            'Overview narration.',
            'First step.',
            'Second step.',
        ]);
        ok(harness.presented.filter((id) => id === 'summary').length >= 2);
    });
});
