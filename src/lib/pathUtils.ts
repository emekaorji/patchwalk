import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Path normalization has to be consistent between the daemon and workers or routing decisions
 * become nondeterministic across windows.
 */
const trimTrailingSeparators = (value: string): string => {
    // Preserve filesystem roots exactly as-is so `/` and drive roots do not collapse to empty strings.
    if (value === path.parse(value).root) {
        return value;
    }

    return value.replace(/[\\/]+$/, '');
};

export const normalizeAbsolutePath = async (value: string): Promise<string> => {
    // Every shared path enters the routing layer through this guard.
    if (!path.isAbsolute(value)) {
        throw new Error(`Expected an absolute filesystem path, received "${value}".`);
    }

    const resolvedPath = path.resolve(value);

    try {
        // Prefer realpath so symlinked workspaces and payloads normalize to the same identity.
        return trimTrailingSeparators(await fs.realpath(resolvedPath));
    } catch {
        // Non-existent paths still need stable matching for payload validation and comparisons.
        return trimTrailingSeparators(resolvedPath);
    }
};

export const isEqualOrParentPath = (candidateParentPath: string, targetPath: string): boolean => {
    // Routing treats an exact match as a valid parent match because the exact-project window should win.
    if (candidateParentPath === targetPath) {
        return true;
    }

    // Node's relative result gives us a platform-safe parent check without manual separator logic.
    const relativePath = path.relative(candidateParentPath, targetPath);
    return (
        relativePath.length > 0 && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
    );
};
