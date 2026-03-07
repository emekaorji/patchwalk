import { deepStrictEqual, strictEqual } from 'node:assert';

import { compareWorkerClaims, matchBasePathToWorkspaceRoots } from '../src/routing';

// These tests lock the deterministic winner-selection policy used by the daemon.
describe('patchwalk routing', () => {
    it('prefers exact matches over parent matches', () => {
        const match = matchBasePathToWorkspaceRoots('/tmp/project', ['/tmp', '/tmp/project']);

        deepStrictEqual(match, {
            matchKind: 'exact',
            matchedRoot: '/tmp/project',
        });
    });

    it('prefers the deepest parent match when no exact workspace exists', () => {
        const match = matchBasePathToWorkspaceRoots('/tmp/project/service', [
            '/tmp',
            '/tmp/project',
        ]);

        deepStrictEqual(match, {
            matchKind: 'parent',
            matchedRoot: '/tmp/project',
        });
    });

    it('sorts claims by match quality and then registration order', () => {
        const claims = [
            {
                workerId: 'later-parent',
                matchKind: 'parent' as const,
                matchedRoot: '/tmp/project',
                registeredSequence: 3,
            },
            {
                workerId: 'earlier-parent',
                matchKind: 'parent' as const,
                matchedRoot: '/tmp/project',
                registeredSequence: 1,
            },
            {
                workerId: 'exact',
                matchKind: 'exact' as const,
                matchedRoot: '/tmp/project/service',
                registeredSequence: 2,
            },
        ];

        claims.sort(compareWorkerClaims);

        strictEqual(claims[0]?.workerId, 'exact');
        strictEqual(claims[1]?.workerId, 'earlier-parent');
        strictEqual(claims[2]?.workerId, 'later-parent');
    });
});
