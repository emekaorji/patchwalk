import { match, ok, strictEqual } from 'node:assert';

import {
    createPatchwalkHandoffPayloadSchema,
    formatPatchwalkValidationIssues,
    PATCHWALK_NARRATION_LIMITS,
    patchwalkHandoffPayloadSchema,
    patchwalkNarrationLimits,
    validatePatchwalkPayload,
} from '../src/lib/schema';

// The style gate lives at the AUTHORING boundary (the play tool), so assert against that schema.
const terseSchema = createPatchwalkHandoffPayloadSchema(patchwalkNarrationLimits('terse'));
const TERSE = PATCHWALK_NARRATION_LIMITS.terse;

// The public handoff schema is shared across MCP callers, the daemon, and workers.
describe('patchwalk schema', () => {
    it('accepts a valid handoff payload', () => {
        const payload = {
            specVersion: '1.0.0',
            handoffId: 'demo-1',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: '/Users/example/project',
            producer: {
                agent: 'codex',
                agentVersion: '1.0.0',
                model: 'gpt-5',
            },
            summary: 'Demo walkthrough.',
            walkthrough: [
                {
                    id: 'step-1',
                    title: 'Open file',
                    narration: 'Patchwalk is highlighting this range.',
                    path: 'src/extension/index.ts',
                    type: 'symbol',
                    symbol: 'activate',
                    range: {
                        startLine: 1,
                        endLine: 20,
                    },
                },
            ],
        };

        const parsedPayload = patchwalkHandoffPayloadSchema.safeParse(payload);
        strictEqual(parsedPayload.success, true);

        const result = validatePatchwalkPayload(payload);

        strictEqual(result.ok, true);
        if (result.ok) {
            strictEqual(result.value.walkthrough[0]?.symbol, 'activate');
        }
    });

    it('accepts a step with sub-segments', () => {
        const result = validatePatchwalkPayload({
            specVersion: '1.0.0',
            handoffId: 'demo-seg',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: '/Users/example/project',
            producer: { agent: 'codex' },
            summary: 'Sub-segmented walkthrough.',
            walkthrough: [
                {
                    id: 'step-1',
                    title: 'A function',
                    narration: 'Overview of the whole function.',
                    path: 'src/thing.ts',
                    range: { startLine: 1, endLine: 30 },
                    segments: [
                        { narration: 'The setup lines.', range: { startLine: 2, endLine: 6 } },
                        {
                            id: 'core',
                            narration: 'The core work.',
                            range: { startLine: 8, endLine: 24 },
                        },
                    ],
                },
            ],
        });

        strictEqual(result.ok, true);
        if (result.ok) {
            strictEqual(result.value.walkthrough[0]?.segments?.length, 2);
            strictEqual(result.value.walkthrough[0]?.segments?.[1]?.id, 'core');
        }
    });

    it('rejects an empty segments array and reversed sub-segment ranges', () => {
        const emptySegments = validatePatchwalkPayload({
            specVersion: '1.0.0',
            handoffId: 'demo-seg-empty',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: '/Users/example/project',
            producer: { agent: 'codex' },
            summary: 'Bad sub-segments.',
            walkthrough: [
                {
                    id: 'step-1',
                    title: 'A function',
                    narration: 'Overview.',
                    path: 'src/thing.ts',
                    range: { startLine: 1, endLine: 30 },
                    segments: [],
                },
            ],
        });
        strictEqual(emptySegments.ok, false);

        const reversedSegment = validatePatchwalkPayload({
            specVersion: '1.0.0',
            handoffId: 'demo-seg-reversed',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: '/Users/example/project',
            producer: { agent: 'codex' },
            summary: 'Bad sub-segments.',
            walkthrough: [
                {
                    id: 'step-1',
                    title: 'A function',
                    narration: 'Overview.',
                    path: 'src/thing.ts',
                    range: { startLine: 1, endLine: 30 },
                    segments: [{ narration: 'Reversed.', range: { startLine: 10, endLine: 4 } }],
                },
            ],
        });
        strictEqual(reversedSegment.ok, false);
        if (!reversedSegment.ok) {
            match(reversedSegment.error, /endLine/);
        }
    });

    it('gates rambling narration: over-long spoken text is rejected, not played', () => {
        const overLongSegment = 'x'.repeat(TERSE.segment + 1);
        const parsed = terseSchema.safeParse({
            specVersion: '1.0.0',
            handoffId: 'demo-verbose',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: '/Users/example/project',
            producer: { agent: 'codex' },
            summary: 'Terse enough.',
            walkthrough: [
                {
                    id: 'step-1',
                    title: 'A function',
                    narration: 'Terse enough.',
                    path: 'src/thing.ts',
                    range: { startLine: 1, endLine: 30 },
                    segments: [{ narration: overLongSegment, range: { startLine: 2, endLine: 6 } }],
                },
            ],
        });
        strictEqual(parsed.success, false);
        if (!parsed.success) {
            match(
                formatPatchwalkValidationIssues(parsed.error).join('\n'),
                new RegExp(`at most ${TERSE.segment} characters`),
            );
        }
    });

    it('the GROUNDED style allows the longer narration that terse rejects', () => {
        const groundedSchema = createPatchwalkHandoffPayloadSchema(
            patchwalkNarrationLimits('grounded'),
        );
        const longerLine = 'x'.repeat(TERSE.segment + 1);
        const payload = {
            specVersion: '1.0.0',
            handoffId: 'demo-grounded',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: '/Users/example/project',
            producer: { agent: 'codex' },
            summary: 'Grounded.',
            walkthrough: [
                {
                    id: 'step-1',
                    title: 'A function',
                    narration: 'Grounded overview.',
                    path: 'src/thing.ts',
                    range: { startLine: 1, endLine: 30 },
                    segments: [{ narration: longerLine, range: { startLine: 2, endLine: 6 } }],
                },
            ],
        };
        strictEqual(terseSchema.safeParse(payload).success, false);
        strictEqual(groundedSchema.safeParse(payload).success, true);
        // The WIRE schema is the permissive one, so a grounded walk survives the daemon->worker hop.
        strictEqual(patchwalkHandoffPayloadSchema.safeParse(payload).success, true);
    });

    it('reports EVERY violation at once so the agent fixes the walk in one pass', () => {
        const parsed = terseSchema.safeParse({
            specVersion: '1.0.0',
            handoffId: 'demo-many',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: '/Users/example/project',
            producer: { agent: 'codex' },
            summary: 'y'.repeat(TERSE.summary + 1),
            walkthrough: [
                {
                    id: 'step-1',
                    title: 't'.repeat(TERSE.title + 1),
                    narration: 'n'.repeat(TERSE.step + 1),
                    path: 'src/thing.ts',
                    range: { startLine: 1, endLine: 30 },
                },
            ],
        });
        strictEqual(parsed.success, false);
        if (!parsed.success) {
            const problems = formatPatchwalkValidationIssues(parsed.error);
            // summary + title + step narration — all surfaced together, not one at a time.
            strictEqual(problems.length >= 3, true);
            ok(problems.some((problem) => /summary/.test(problem)));
            ok(problems.some((problem) => /title/.test(problem)));
            ok(problems.some((problem) => /narration/.test(problem)));
        }
    });

    it('rejects a sub-segment range that falls outside its parent step range', () => {
        const result = validatePatchwalkPayload({
            specVersion: '1.0.0',
            handoffId: 'demo-seg-outside',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: '/Users/example/project',
            producer: { agent: 'codex' },
            summary: 'Out-of-range sub-segment.',
            walkthrough: [
                {
                    id: 'step-1',
                    title: 'A function',
                    narration: 'Overview.',
                    path: 'src/thing.ts',
                    range: { startLine: 1, endLine: 30 },
                    // Sits well past the step's endLine — the highlight would jump outside the step.
                    segments: [{ narration: 'Outside.', range: { startLine: 900, endLine: 905 } }],
                },
            ],
        });
        strictEqual(result.ok, false);
        if (!result.ok) {
            match(result.error, /within the parent step range/);
        }
    });

    it('rejects reversed ranges', () => {
        const result = validatePatchwalkPayload({
            specVersion: '1.0.0',
            handoffId: 'demo-2',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: '/Users/example/project',
            producer: {
                agent: 'codex',
            },
            summary: 'Bad walkthrough.',
            walkthrough: [
                {
                    id: 'step-1',
                    title: 'Broken range',
                    narration: 'This should fail validation.',
                    path: 'src/extension/index.ts',
                    range: {
                        startLine: 10,
                        endLine: 5,
                    },
                },
            ],
        });

        strictEqual(result.ok, false);
        if (!result.ok) {
            match(result.error, /endLine/);
        }
    });

    it('rejects unexpected fields because the zod objects are strict', () => {
        const result = validatePatchwalkPayload({
            specVersion: '1.0.0',
            handoffId: 'demo-3',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: '/Users/example/project',
            producer: {
                agent: 'codex',
                extra: 'nope',
            },
            summary: 'Bad walkthrough.',
            walkthrough: [
                {
                    id: 'step-1',
                    title: 'Open file',
                    narration: 'Patchwalk is highlighting this range.',
                    path: 'src/extension/index.ts',
                    range: {
                        startLine: 1,
                        endLine: 20,
                    },
                },
            ],
        });

        strictEqual(result.ok, false);
        if (!result.ok) {
            match(result.error, /Unexpected field/);
        }
    });

    it('rejects empty walkthroughs', () => {
        const result = validatePatchwalkPayload({
            specVersion: '1.0.0',
            handoffId: 'demo-4',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: '/Users/example/project',
            producer: {
                agent: 'codex',
            },
            summary: 'Bad walkthrough.',
            walkthrough: [],
        });

        strictEqual(result.ok, false);
        if (!result.ok) {
            match(result.error, /walkthrough/);
        }
    });

    it('rejects relative base paths', () => {
        const result = validatePatchwalkPayload({
            specVersion: '1.0.0',
            handoffId: 'demo-5',
            createdAt: '2026-03-06T00:00:00Z',
            basePath: 'project',
            producer: {
                agent: 'codex',
            },
            summary: 'Bad walkthrough.',
            walkthrough: [
                {
                    id: 'step-1',
                    title: 'Open file',
                    narration: 'Patchwalk is highlighting this range.',
                    path: 'src/extension/index.ts',
                    range: {
                        startLine: 1,
                        endLine: 20,
                    },
                },
            ],
        });

        strictEqual(result.ok, false);
        if (!result.ok) {
            match(result.error, /basePath/);
        }
    });
});
