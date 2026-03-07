import { resolve } from 'node:path';

import { runTests } from '@vscode/test-electron';

/**
 * Run the extension inside VS Code's real extension-host harness so daemon and worker behavior are
 * exercised with the same runtime the user gets.
 */
(async function go() {
    const projectPath = resolve(__dirname, '../../');
    const extensionDevelopmentPath = projectPath;
    const extensionTestsPath = resolve(projectPath, './out/test');
    const testWorkspace = resolve(projectPath, './test-workspace');

    await runTests({
        version: 'insiders',
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: ['--disable-extensions', testWorkspace],
    });
})();
