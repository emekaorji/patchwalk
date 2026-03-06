import path from 'node:path';

import { globSync } from 'glob';
import Mocha from 'mocha';

/**
 * !: must be synchronized
 */
export function run(testsRoot: string, cb: (error: any, failures?: number) => void): void {
    const mocha = new Mocha({ color: true });

    try {
        const files = globSync('**/**.test.js', { cwd: testsRoot });
        for (const f of files) mocha.addFile(path.resolve(testsRoot, f));

        mocha.run((failures) => {
            cb(null, failures);
        });
    } catch (error) {
        cb(error);
    }
}
