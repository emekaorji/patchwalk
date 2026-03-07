import { isEqualOrParentPath } from './pathUtils';

/**
 * Routing is intentionally simple and deterministic: match the requested base path against each
 * worker's workspace roots, then rank the claims.
 */
export type PatchwalkMatchKind = 'exact' | 'parent';

export interface PatchwalkWorkerMatch {
    matchKind: PatchwalkMatchKind;
    matchedRoot: string;
}

export interface PatchwalkWorkerClaimSummary extends PatchwalkWorkerMatch {
    workerId: string;
    registeredSequence: number;
}

export const matchBasePathToWorkspaceRoots = (
    basePath: string,
    workspaceRoots: string[],
): PatchwalkWorkerMatch | undefined => {
    let bestMatch: PatchwalkWorkerMatch | undefined;

    for (const workspaceRoot of workspaceRoots) {
        if (!isEqualOrParentPath(workspaceRoot, basePath)) {
            continue;
        }

        // Exact wins over parent; among parent matches we keep the deepest workspace root.
        const candidateMatch: PatchwalkWorkerMatch = {
            matchKind: workspaceRoot === basePath ? 'exact' : 'parent',
            matchedRoot: workspaceRoot,
        };

        if (!bestMatch) {
            bestMatch = candidateMatch;
            continue;
        }

        if (candidateMatch.matchKind === 'exact' && bestMatch.matchKind !== 'exact') {
            bestMatch = candidateMatch;
            continue;
        }

        if (
            candidateMatch.matchKind === bestMatch.matchKind &&
            candidateMatch.matchedRoot.length > bestMatch.matchedRoot.length
        ) {
            bestMatch = candidateMatch;
        }
    }

    return bestMatch;
};

export const compareWorkerClaims = (
    leftClaim: PatchwalkWorkerClaimSummary,
    rightClaim: PatchwalkWorkerClaimSummary,
): number => {
    // Rank exact matches first, then the most specific parent, then registration order.
    if (leftClaim.matchKind !== rightClaim.matchKind) {
        return leftClaim.matchKind === 'exact' ? -1 : 1;
    }

    if (leftClaim.matchedRoot.length !== rightClaim.matchedRoot.length) {
        return rightClaim.matchedRoot.length - leftClaim.matchedRoot.length;
    }

    return leftClaim.registeredSequence - rightClaim.registeredSequence;
};
