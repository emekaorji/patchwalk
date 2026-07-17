/* eslint-disable no-await-in-loop -- polling loop: each tick must observe the state left by the previous one. */
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { PatchwalkPlaybackRunner } from '../src/extension/playback';
import type { PatchwalkHandoffPayload } from '../src/lib/schema';

/**
 * These tests drive the real playback runner inside the VS Code extension host (the layer the
 * mocked daemon tests never touch). They inject a fake voice so no audio plays and timing is
 * deterministic, and they are the regression guard for P1 (stop must interrupt a live walk).
 */

const flushOnce = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 4000; attempt += 1) {
        if (predicate()) {
            return;
        }
        await flushOnce();
    }
    throw new Error('waitFor timed out');
};

const abortError = (): Error => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
};

describe('patchwalk playback (real editor)', () => {
    let tempDir: string;
    let outputChannel: vscode.OutputChannel;
    let runner: PatchwalkPlaybackRunner | undefined;
    let counter = 0;

    before(() => {
        // Create once: rapid create/dispose of output channels trips VS Code's disposable store.
        outputChannel = vscode.window.createOutputChannel('Patchwalk Test');
    });

    after(() => {
        outputChannel.dispose();
    });

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'patchwalk-itest-'));
        await writeFile(
            join(tempDir, 'sample.ts'),
            Array.from({ length: 40 }, (_, index) => `const line${index} = ${index};`).join('\n'),
        );
    });

    afterEach(async () => {
        runner?.dispose();
        runner = undefined;
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await rm(tempDir, { recursive: true, force: true });
    });

    const createPayload = (): PatchwalkHandoffPayload => {
        counter += 1;
        return {
            specVersion: '1.0.0',
            handoffId: `itest-${counter}`,
            createdAt: '2026-03-07T00:00:00Z',
            basePath: tempDir,
            producer: { agent: 'integration-test' },
            summary: 'Overview of the sample change.',
            walkthrough: [
                {
                    id: 'step-1',
                    title: 'Sample step',
                    narration: 'This narrates the sample file.',
                    path: 'sample.ts',
                    range: { startLine: 5, endLine: 12 },
                },
            ],
        };
    };

    it('opens the step file during playback and returns to idle', async () => {
        runner = new PatchwalkPlaybackRunner(outputChannel, async () => {
            // instant fake narration
        });
        const run = runner.play(createPayload());
        await run.completion;

        const opened = vscode.workspace.textDocuments.some((document) =>
            document.uri.fsPath.endsWith('sample.ts'),
        );
        ok(opened, 'the step file should have been opened during playback');
        strictEqual(runner.getStateSnapshot().state, 'idle');
    });

    it('stop() interrupts a running walk promptly and rejects completion (P1 guard)', async () => {
        // Narration that only ends when aborted — simulates a long utterance.
        runner = new PatchwalkPlaybackRunner(
            outputChannel,
            (_text, signal) =>
                new Promise<void>((_resolve, reject) => {
                    if (signal.aborted) {
                        reject(abortError());
                        return;
                    }
                    signal.addEventListener('abort', () => reject(abortError()), { once: true });
                }),
        );

        const run = runner.play(createPayload());
        await waitFor(() => runner?.getStateSnapshot().state === 'playing');

        const startedAt = Date.now();
        await run.stop();
        const elapsedMs = Date.now() - startedAt;

        ok(elapsedMs < 3000, `stop should be prompt, took ${elapsedMs}ms`);
        strictEqual(runner.getStateSnapshot().state, 'idle');
        await rejects(
            run.completion,
            (error: unknown) =>
                error instanceof Error && error.name === 'PatchwalkPlaybackStoppedError',
        );
    });

    it('flattens a step with sub-segments into ordered cues that walk each sub-range', async () => {
        const progressIndices: number[] = [];
        runner = new PatchwalkPlaybackRunner(outputChannel, async () => {
            await flushOnce();
        });
        const payload = createPayload();
        payload.walkthrough[0].range = { startLine: 1, endLine: 30 };
        payload.walkthrough[0].segments = [
            { narration: 'The setup lines.', range: { startLine: 2, endLine: 6 } },
            { id: 'core', narration: 'The core work.', range: { startLine: 8, endLine: 20 } },
        ];
        const run = runner.play(payload);
        run.onDidProgress((progress) => progressIndices.push(progress.stepIndex));

        // Transcript: summary + step overview + 2 sub-segments = 4 cues, in order.
        const transcript = run.getTranscript();
        strictEqual(transcript.length, 4);
        strictEqual(transcript[1].kind, 'step');
        strictEqual(transcript[2].kind, 'segment');
        strictEqual(transcript[2].isSubSegment, true);
        deepStrictEqual([transcript[2].startLine, transcript[2].endLine], [2, 6]);

        // Overview agenda groups the sub-segments under their step.
        const overview = run.getOverview();
        strictEqual(overview.steps.length, 1);
        strictEqual(overview.steps[0].segments.length, 2);
        strictEqual(overview.segmentCount, 2);

        // Every code cue (step + both sub-segments) is a jump target.
        strictEqual(run.getWalkSteps().length, 3);

        await run.completion;
        // Playback advanced through every cue index, ending on the last sub-segment.
        ok(progressIndices.includes(3), 'playback should reach the final sub-segment cue');
        strictEqual(runner.getStateSnapshot().state, 'idle');
    });

    it('a transcript click replays a FINISHED walk from that cue (real selection)', async () => {
        runner = new PatchwalkPlaybackRunner(outputChannel, async () => {
            await flushOnce();
        });
        const run = runner.play(createPayload());
        await run.completion;
        strictEqual(runner.getStateSnapshot().state, 'idle');

        // The transcript is still on screen after the walk ends, so a click must still play.
        const replayed = runner.jumpToCue(1); // the step cue
        ok(replayed, 'clicking a cue on a finished walk should replay it');

        const second = runner.getActiveRun();
        ok(second, 'a new run should have started');
        await second!.completion;

        // The narrated block ends up genuinely SELECTED, not just shaded.
        const editor = vscode.window.visibleTextEditors.find((candidate) =>
            candidate.document.uri.fsPath.endsWith('sample.ts'),
        );
        ok(editor, 'the step file should be open');
        strictEqual(editor!.selection.isEmpty, false, 'the cue range should be really selected');
        strictEqual(editor!.selection.start.line, 4); // startLine 5 (1-based) -> 4
        strictEqual(editor!.selection.end.line, 11); // endLine 12 (1-based) -> 11
    });

    it('emits progress and transcript events for the walk cues', async () => {
        const progressStates: string[] = [];
        const transcriptTitles: string[] = [];
        runner = new PatchwalkPlaybackRunner(outputChannel, async () => {
            await flushOnce();
        });
        const run = runner.play(createPayload());
        run.onDidProgress((progress) => progressStates.push(progress.state));
        run.onDidEmitTranscript((entry) => transcriptTitles.push(entry.title));
        await run.completion;

        ok(transcriptTitles.includes('Overview'), 'summary transcript should be emitted');
        ok(transcriptTitles.includes('Sample step'), 'step transcript should be emitted');
        ok(progressStates.length >= 2, 'progress should be reported for each cue');
    });
});
