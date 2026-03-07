import path from 'node:path';

import { globSync } from 'glob';
import Mocha from 'mocha';

/**
 * This bootstrap mirrors the compiled out/test layout. If the emitted test path changes, the glob
 * here has to change with it.
 */
export function run(testsRoot: string, cb: (error: any, failures?: number) => void): void {
    const mocha = new Mocha({ color: true });

    try {
        const files = globSync('**/**.test.js', { cwd: testsRoot });
        // Mocha runs compiled JavaScript, not the TypeScript sources in the repo.
        for (const f of files) mocha.addFile(path.resolve(testsRoot, f));

        mocha.run((failures) => {
            cb(null, failures);
        });
    } catch (error) {
        cb(error);
    }
}
