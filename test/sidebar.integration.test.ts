/* eslint-disable no-await-in-loop -- polling loop: each tick must observe the state left by the previous one. */
import { ok, strictEqual } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { PatchwalkPlaybackRunner } from '../src/extension/playback';
import { PatchwalkWalkMonitorProvider } from '../src/extension/sidebar/walkMonitorView';
import type { PatchwalkHandoffPayload } from '../src/lib/schema';

/**
 * Verifies the sidebar provider's glue (the part the pure model tests can't reach): it must mirror
 * the active run into view state as the walk progresses, and keep the transcript after it ends.
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

describe('walk monitor provider (real editor glue)', () => {
    let tempDir: string;
    let outputChannel: vscode.OutputChannel;
    let runner: PatchwalkPlaybackRunner | undefined;
    let provider: PatchwalkWalkMonitorProvider | undefined;

    before(() => {
        outputChannel = vscode.window.createOutputChannel('Patchwalk Sidebar Test');
    });
    after(() => outputChannel.dispose());

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'patchwalk-sidebar-'));
        await writeFile(join(tempDir, 'sample.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    });

    afterEach(async () => {
        provider?.dispose();
        runner?.dispose();
        provider = undefined;
        runner = undefined;
        // Windows can briefly lock files the editor just opened; retry, and never let a
        // cleanup EBUSY fail the test (a leaked temp dir in CI is harmless).
        await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
            () => {},
        );
    });

    const createPayload = (): PatchwalkHandoffPayload => ({
        specVersion: '1.0.0',
        handoffId: 'sidebar-itest',
        createdAt: '2026-03-07T00:00:00Z',
        basePath: tempDir,
        producer: { agent: 'integration-test' },
        summary: 'Overview.',
        walkthrough: [
            {
                id: 'step-1',
                title: 'First step',
                narration: 'Explains sample.ts.',
                path: 'sample.ts',
                range: { startLine: 1, endLine: 2 },
            },
        ],
    });

    it('mirrors the active run into view state and keeps the transcript after it ends', async () => {
        runner = new PatchwalkPlaybackRunner(outputChannel, async () => {
            await flushOnce();
        });
        provider = new PatchwalkWalkMonitorProvider(
            vscode.Uri.file(tempDir),
            runner,
            outputChannel,
        );

        strictEqual(provider.currentStateForTest.active, false);

        const run = runner.play(createPayload());
        await waitFor(() => provider!.currentStateForTest.active === true);

        const active = provider.currentStateForTest;
        strictEqual(active.handoffId, run.handoffId);
        // summary cue + one step cue
        strictEqual(active.steps.length, 2);
        strictEqual(active.steps[0].isSummary, true);
        strictEqual(active.steps[1].title, 'First step');

        await run.completion;
        await waitFor(() => provider!.currentStateForTest.active === false);

        // Transcript persists after the walk ends (P4).
        const ended = provider.currentStateForTest;
        strictEqual(ended.active, false);
        ok(ended.steps.length === 2, 'transcript should remain after the walk ends');
    });
});
