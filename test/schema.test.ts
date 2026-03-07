import { match, strictEqual } from 'node:assert';

import { patchwalkHandoffPayloadSchema, validatePatchwalkPayload } from '../src/schema';

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
                    path: 'src/extension.ts',
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
                    path: 'src/extension.ts',
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
                    path: 'src/extension.ts',
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
                    path: 'src/extension.ts',
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
