import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as vscode from 'vscode';

/**
 * There is NO VS Code API to focus another window (or even to raise your own). The only mechanism
 * is spawning the editor's CLI on a folder that is already open in some window — the editor then
 * raises that existing window instead of opening a new one. This module derives the right CLI for
 * the running product (VS Code / Insiders / Cursor / VSCodium / Windsurf) and spawns it
 * best-effort.
 */

/** Map the product's `vscode.env.appName` to its CLI shim's base name. */
export const resolveEditorCliBinName = (appName: string): string => {
    const normalized = appName.toLowerCase();
    if (normalized.includes('insiders')) {
        return 'code-insiders';
    }
    if (normalized.includes('cursor')) {
        return 'cursor';
    }
    if (normalized.includes('codium')) {
        return 'codium';
    }
    if (normalized.includes('windsurf')) {
        return 'windsurf';
    }
    return 'code';
};

/**
 * Best-effort absolute path to the bundled CLI shim, derived from `vscode.env.appRoot`. On desktop
 * `appRoot` is the installed app's `resources/app`, and the shim lives in a sibling `bin/` folder.
 */
export const resolveEditorCliPath = (
    appRoot: string,
    appName: string,
    platform: NodeJS.Platform = process.platform,
): string => {
    const binName = resolveEditorCliBinName(appName);
    const fileName = platform === 'win32' ? `${binName}.cmd` : binName;
    return path.join(appRoot, 'bin', fileName);
};

/**
 * Raise the window that has `revealPath` open by spawning the product CLI on that folder. Prefers
 * the CLI derived from `appRoot`; falls back to the bare CLI name on PATH. Never throws — reveal is
 * a convenience, so failures are logged and swallowed.
 */
export const revealWindowForPath = (
    revealPath: string,
    log: (message: string) => void,
): boolean => {
    try {
        const folderUri = vscode.Uri.file(revealPath).toString();
        const derivedCli = resolveEditorCliPath(vscode.env.appRoot, vscode.env.appName);
        const cli = existsSync(derivedCli)
            ? derivedCli
            : resolveEditorCliBinName(vscode.env.appName);

        const child = spawn(cli, ['--folder-uri', folderUri], {
            detached: true,
            stdio: 'ignore',
            shell: process.platform === 'win32',
        });
        child.on('error', (error) => {
            log(`Patchwalk could not reveal the playing window: ${error.message}`);
        });
        child.unref();
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Patchwalk could not reveal the playing window: ${message}`);
        return false;
    }
};
