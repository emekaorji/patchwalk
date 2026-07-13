import { ok, strictEqual } from 'node:assert';

import { resolveEditorCliBinName, resolveEditorCliPath } from '../src/extension/revealWindow';

describe('reveal window CLI resolution', () => {
    it('maps the product name to its CLI shim', () => {
        strictEqual(resolveEditorCliBinName('Visual Studio Code'), 'code');
        strictEqual(resolveEditorCliBinName('Visual Studio Code - Insiders'), 'code-insiders');
        strictEqual(resolveEditorCliBinName('Cursor'), 'cursor');
        strictEqual(resolveEditorCliBinName('VSCodium'), 'codium');
        strictEqual(resolveEditorCliBinName('Windsurf'), 'windsurf');
        strictEqual(resolveEditorCliBinName('Some Unknown Fork'), 'code');
    });

    it('derives the CLI path from appRoot per platform', () => {
        // `path.join` uses the HOST separator, so assert host-agnostically: the bin name + suffix.
        const posix = resolveEditorCliPath(
            '/Applications/Cursor.app/Contents/Resources/app',
            'Cursor',
            'darwin',
        );
        ok(posix.endsWith('cursor'), `expected a cursor shim, got ${posix}`);
        ok(posix.includes('bin'), 'the shim should live in a bin folder');

        // The win32 branch adds the `.cmd` suffix regardless of host separator.
        const win = resolveEditorCliPath('/Prog/app', 'Visual Studio Code', 'win32');
        ok(win.endsWith('code.cmd'), `expected a code.cmd shim, got ${win}`);
    });
});
