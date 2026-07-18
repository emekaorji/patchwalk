import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import process from 'node:process';

import * as vscode from 'vscode';

import type { AgentAdapter, Host, InjectionResult, InjectorIO } from './injector';
import { AGENT_ADAPTERS, buildMcpUrl, runInjection } from './injector';

/**
 * Real filesystem for the injector: writes are atomic (temp + rename) and back up an overwritten
 * file exactly once, so a bad merge can never leave a user's config half-written.
 */
const nodeIo: InjectorIO = {
    exists: (path) => {
        try {
            fs.accessSync(path);
            return true;
        } catch {
            return false;
        }
    },
    isDir: (path) => {
        try {
            return fs.statSync(path).isDirectory();
        } catch {
            return false;
        }
    },
    read: (path) => fs.readFileSync(path, 'utf8'),
    writeAtomic: (path, text, hadExistingFile) => {
        fs.mkdirSync(dirname(path), { recursive: true });
        if (hadExistingFile) {
            const backup = `${path}.patchwalk-bak`;
            if (!nodeIo.exists(backup)) {
                try {
                    fs.copyFileSync(path, backup);
                } catch {
                    // A missing backup is not worth aborting the write over.
                }
            }
        }
        const temporary = `${path}.patchwalk-tmp-${process.pid}`;
        fs.writeFileSync(temporary, text, 'utf8');
        fs.renameSync(temporary, path);
    },
};

type AdapterStatus = 'connected' | 'updated' | 'already' | 'failed' | 'not-installed';

export interface ConnectSummary {
    /** Agents newly wired up (or updated) this run — these need a restart. */
    connected: number;
    /** Agents whose config we couldn't write. */
    failed: number;
    /** Agents already carrying the patchwalk server. */
    already: number;
}

interface AdapterRollup {
    adapter: AgentAdapter;
    status: AdapterStatus;
    results: InjectionResult[];
}

/** Collapse an adapter's per-candidate results (it may have several config paths) into one status. */
const rollup = (results: InjectionResult[]): AdapterRollup[] => {
    return AGENT_ADAPTERS.map((adapter) => {
        const own = results.filter((result) => result.id === adapter.id);
        const has = (outcome: string): boolean => own.some((result) => result.outcome === outcome);
        const status: AdapterStatus = has('connected')
            ? 'connected'
            : has('updated')
              ? 'updated'
              : has('already')
                ? 'already'
                : has('failed')
                  ? 'failed'
                  : 'not-installed';
        return { adapter, status, results: own };
    });
};

/**
 * Connects the Patchwalk MCP server into every installed agent so the user only has to restart it.
 * Runs once on first activation (silent if nothing is installed) and on the `Connect My Agents`
 * command. Always leaves a manual-setup failsafe for anything it can't wire up.
 */
export class PatchwalkAgentConnector {
    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly outputChannel: vscode.OutputChannel,
        private readonly getDaemonPort: () => number,
    ) {}

    /**
     * The `Patchwalk: Connect My Agents` command (and first-run onboarding). Always reports;
     * returns a summary so the caller can decide whether to fall back to a manual-setup nudge.
     */
    public async connect(options: { firstRun?: boolean } = {}): Promise<ConnectSummary> {
        const url = buildMcpUrl(this.getDaemonPort());
        const host: Host = {
            home: homedir(),
            appData: process.env.APPDATA,
            platform: process.platform,
        };

        let results: InjectionResult[];
        try {
            results = runInjection(host, url, nodeIo);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Patchwalk agent connect failed: ${message}`);
            return { connected: 0, failed: 0, already: 0 };
        }

        const groups = rollup(results);
        this.writeDetails(groups, url);
        await this.notify(groups, url, options.firstRun ?? false);
        return {
            connected: groups.filter((g) => g.status === 'connected' || g.status === 'updated')
                .length,
            failed: groups.filter((g) => g.status === 'failed').length,
            already: groups.filter((g) => g.status === 'already').length,
        };
    }

    private async notify(groups: AdapterRollup[], url: string, firstRun: boolean): Promise<void> {
        const newlyConnected = groups.filter(
            (g) => g.status === 'connected' || g.status === 'updated',
        );
        const alreadySet = groups.filter((g) => g.status === 'already');
        const failed = groups.filter((g) => g.status === 'failed');
        const nameList = (list: AdapterRollup[]): string =>
            list.map((g) => g.adapter.name).join(', ');

        // First run with nothing installed: stay silent — no nagging. (Details still go to the log.)
        if (firstRun && newlyConnected.length === 0 && failed.length === 0) {
            return;
        }

        let message: string;
        if (newlyConnected.length > 0) {
            message = `Patchwalk connected ${newlyConnected.length} agent${
                newlyConnected.length === 1 ? '' : 's'
            } (${nameList(newlyConnected)}). Restart ${
                newlyConnected.length === 1 ? 'it' : 'them'
            } to finish.`;
        } else if (alreadySet.length > 0) {
            message = `Patchwalk is already set up in ${nameList(alreadySet)}.`;
        } else {
            message = 'No supported AI agents were detected on this machine.';
        }
        if (failed.length > 0) {
            message += ` Couldn't set up: ${nameList(failed)} — use Manual setup.`;
        }

        const DETAILS = 'Show details';
        const COPY = 'Copy MCP endpoint';
        const choice =
            newlyConnected.length > 0 || failed.length > 0
                ? await vscode.window.showInformationMessage(message, DETAILS, COPY)
                : await vscode.window.showInformationMessage(message, COPY);

        if (choice === DETAILS) {
            this.outputChannel.show(true);
        } else if (choice === COPY) {
            await vscode.env.clipboard.writeText(url);
            await vscode.window.showInformationMessage(`Copied ${url}`);
        }
    }

    private writeDetails(groups: AdapterRollup[], url: string): void {
        const out = this.outputChannel;
        out.appendLine('');
        out.appendLine(`Patchwalk — connecting agents to ${url}`);
        out.appendLine('─'.repeat(60));
        for (const group of groups) {
            const label = {
                'connected': 'CONNECTED',
                'updated': 'UPDATED',
                'already': 'already set up',
                'failed': 'FAILED',
                'not-installed': 'not installed',
            }[group.status];
            out.appendLine(`• ${group.adapter.name.padEnd(20)} ${label}`);
            if (group.status === 'failed') {
                for (const result of group.results.filter((r) => r.outcome === 'failed')) {
                    out.appendLine(`    ${result.path}: ${result.detail ?? 'unknown error'}`);
                }
            }
        }

        const needRestart = groups.filter(
            (g) => g.status === 'connected' || g.status === 'updated',
        );
        if (needRestart.length > 0) {
            out.appendLine('');
            out.appendLine('To finish, restart these:');
            for (const group of needRestart) {
                out.appendLine(`  ${group.adapter.name}: ${group.adapter.restartHint}`);
            }
        }

        const manual = groups.filter((g) => g.status === 'failed' || g.status === 'not-installed');
        if (manual.length > 0) {
            out.appendLine('');
            out.appendLine('Manual setup (only if you use these):');
            for (const group of manual) {
                out.appendLine(`  ${group.adapter.name}: ${group.adapter.manual(url)}`);
            }
        }
        out.appendLine('');
    }
}
