/**
 * Auto-inject the Patchwalk MCP server into the config files of popular AI agents, so a user only
 * has to restart their agent instead of hand-editing config. Every schema here was verified against
 * the agent's current docs (2026); the fields differ in ways that silently break a connection if
 * you get them wrong — `url` vs `serverUrl` vs `httpUrl`, `type`
 * present/absent/`http`/`streamableHttp`/ `streamable-http`, VS Code's `servers` key, Continue's
 * YAML list, Codex TOML, Claude Desktop's stdio-only config (bridged via `mcp-remote`).
 *
 * This module is deliberately VS Code-free and does all merging in memory so it can be unit-tested:
 * IO is injected. Merges are surgical (only the `patchwalk` entry changes) and idempotent.
 */
import { basename, dirname, join } from 'node:path';

import type { ParseError } from 'jsonc-parser';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { Document, parseDocument, YAMLSeq } from 'yaml';

export const PATCHWALK_MCP_SERVER_NAME = 'patchwalk';

export interface Host {
    home: string;
    /** %APPDATA% on Windows. */
    appData?: string;
    platform: NodeJS.Platform;
}

export const buildMcpUrl = (port: number): string => `http://127.0.0.1:${port}/mcp`;

/** A single config file to try, plus the directory whose existence proves the tool is installed. */
export interface CandidatePath {
    path: string;
    markerDir: string;
}

export type MergeResult = { changed: false } | { changed: true; wasPresent: boolean; text: string };

export interface AgentAdapter {
    id: string;
    name: string;
    /** What the user must do after we write, e.g. "fully quit and reopen Claude Desktop". */
    restartHint: string;
    /** Human-readable one-liner of what we wrote, shown in the manual-setup failsafe. */
    manual: (url: string) => string;
    candidates: (host: Host) => CandidatePath[];
    merge: (existing: string | undefined, url: string) => MergeResult;
    /** Throws if `text` is not valid content for this format (guards against writing garbage). */
    verify: (text: string) => void;
}

// ── small value helpers ─────────────────────────────────────────────────────

const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) {
        return true;
    }
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
        return false;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false;
        }
        return a.every((item, index) => deepEqual(item, b[index]));
    }
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    return aKeys.every((key) =>
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
};

const valueAtPath = (root: unknown, path: Array<string | number>): unknown => {
    let node: unknown = root;
    for (const key of path) {
        if (typeof node !== 'object' || node === null) {
            return undefined;
        }
        node = (node as Record<string | number, unknown>)[key];
    }
    return node;
};

// ── format writers ──────────────────────────────────────────────────────────

const JSONC_FORMAT = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;

/** Set `keyPath` to `value` in a JSON/JSONC document, preserving everything else. */
const mergeJsonMap = (
    existing: string | undefined,
    keyPath: Array<string | number>,
    value: unknown,
): MergeResult => {
    const source = existing && existing.trim() ? existing : '{}';
    const current = parseJsonc(source, [], { allowTrailingComma: true }) ?? {};
    const before = valueAtPath(current, keyPath);
    if (before !== undefined && deepEqual(before, value)) {
        return { changed: false };
    }
    const edits = modify(source, keyPath, value, { formattingOptions: JSONC_FORMAT });
    return { changed: true, wasPresent: before !== undefined, text: applyEdits(source, edits) };
};

const verifyJson = (text: string): void => {
    const errors: ParseError[] = [];
    parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
        throw new Error('Produced invalid JSON.');
    }
};

/** Append or replace the `[mcp_servers.patchwalk]` TOML table without disturbing other tables. */
const mergeTomlTable = (existing: string | undefined, url: string): MergeResult => {
    const block = `[mcp_servers.patchwalk]\nurl = "${url}"`;
    const source = existing ?? '';
    // The table runs from its header up to the next table header (line starting with "[") or EOF.
    const tableRegex = /\[mcp_servers\.patchwalk\][\s\S]*?(?=\n\[|$)/;
    const match = source.match(tableRegex);
    if (match) {
        if (match[0].trim() === block) {
            return { changed: false };
        }
        return { changed: true, wasPresent: true, text: source.replace(tableRegex, block) };
    }
    const separator = source.length === 0 ? '' : source.endsWith('\n') ? '\n' : '\n\n';
    return { changed: true, wasPresent: false, text: `${source}${separator}${block}\n` };
};

const verifyToml = (text: string): void => {
    if (!/\[mcp_servers\.patchwalk\]\s*\nurl = "/.test(text)) {
        throw new Error('TOML table was not written correctly.');
    }
};

/** Upsert the patchwalk entry in Continue's YAML `mcpServers` list, keeping the doc's header + rest. */
const mergeYamlList = (existing: string | undefined, url: string): MergeResult => {
    const doc = existing && existing.trim() ? parseDocument(existing) : new Document({});
    // Continue rejects the whole file without these header fields, so ensure them when creating.
    if (doc.get('name') == null) {
        doc.set('name', 'patchwalk-generated');
    }
    if (doc.get('version') == null) {
        doc.set('version', '0.0.1');
    }
    if (doc.get('schema') == null) {
        doc.set('schema', 'v1');
    }
    let seq = doc.get('mcpServers');
    if (!(seq instanceof YAMLSeq)) {
        seq = new YAMLSeq();
        doc.set('mcpServers', seq);
    }
    const desired = { name: PATCHWALK_MCP_SERVER_NAME, type: 'streamable-http', url };
    const sequence = seq as YAMLSeq;
    for (const item of sequence.items) {
        const node = item as {
            get?: (k: string) => unknown;
            set?: (k: string, v: unknown) => void;
        };
        if (node.get?.('name') === PATCHWALK_MCP_SERVER_NAME) {
            if (node.get('type') === desired.type && node.get('url') === desired.url) {
                return { changed: false };
            }
            node.set?.('type', desired.type);
            node.set?.('url', desired.url);
            return { changed: true, wasPresent: true, text: doc.toString() };
        }
    }
    sequence.add(desired);
    return { changed: true, wasPresent: false, text: doc.toString() };
};

const verifyYaml = (text: string): void => {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) {
        throw new Error('Produced invalid YAML.');
    }
};

// ── per-OS path helpers ─────────────────────────────────────────────────────

const winAppData = (host: Host): string => host.appData ?? join(host.home, 'AppData', 'Roaming');

/** The `<Product>/User` config dir for a VS Code-family app (Code, Cursor, VSCodium, …). */
const vscodeUserDir = (host: Host, product: string): string => {
    if (host.platform === 'darwin') {
        return join(host.home, 'Library', 'Application Support', product, 'User');
    }
    if (host.platform === 'win32') {
        return join(winAppData(host), product, 'User');
    }
    return join(host.home, '.config', product, 'User');
};

const VSCODE_HOSTS = ['Code', 'Code - Insiders', 'Cursor', 'VSCodium'];

/** GlobalStorage config for a VS Code extension, across every VS Code-family app it might run in. */
const extensionSettingsCandidates = (
    host: Host,
    publisherId: string,
    fileName: string,
): CandidatePath[] =>
    VSCODE_HOSTS.map((product) => {
        const publisherDir = join(vscodeUserDir(host, product), 'globalStorage', publisherId);
        return { path: join(publisherDir, 'settings', fileName), markerDir: publisherDir };
    });

const claudeDesktopConfig = (host: Host): string => {
    if (host.platform === 'darwin') {
        return join(
            host.home,
            'Library',
            'Application Support',
            'Claude',
            'claude_desktop_config.json',
        );
    }
    if (host.platform === 'win32') {
        return join(winAppData(host), 'Claude', 'claude_desktop_config.json');
    }
    return join(host.home, '.config', 'Claude', 'claude_desktop_config.json');
};

// ── the 10 adapters ─────────────────────────────────────────────────────────

export const AGENT_ADAPTERS: AgentAdapter[] = [
    {
        id: 'claude-code',
        name: 'Claude Code',
        restartHint: 'restart your `claude` session (or run `/mcp`)',
        manual: (url) =>
            `~/.claude.json → mcpServers.patchwalk = { "type": "http", "url": "${url}" }`,
        candidates: (host) => [
            { path: join(host.home, '.claude.json'), markerDir: join(host.home, '.claude') },
        ],
        merge: (existing, url) =>
            mergeJsonMap(existing, ['mcpServers', PATCHWALK_MCP_SERVER_NAME], {
                type: 'http',
                url,
            }),
        verify: verifyJson,
    },
    {
        id: 'cursor',
        name: 'Cursor',
        restartHint: 'restart Cursor (or enable it in Settings → MCP)',
        manual: (url) => `~/.cursor/mcp.json → mcpServers.patchwalk = { "url": "${url}" }`,
        candidates: (host) => [
            { path: join(host.home, '.cursor', 'mcp.json'), markerDir: join(host.home, '.cursor') },
        ],
        merge: (existing, url) =>
            mergeJsonMap(existing, ['mcpServers', PATCHWALK_MCP_SERVER_NAME], { url }),
        verify: verifyJson,
    },
    {
        id: 'vscode',
        name: 'VS Code (Copilot)',
        restartHint: 'run "Developer: Reload Window"',
        manual: (url) =>
            `Code/User/mcp.json → servers.patchwalk = { "type": "http", "url": "${url}" }`,
        candidates: (host) =>
            ['Code', 'Code - Insiders'].map((product) => {
                const userDir = vscodeUserDir(host, product);
                return { path: join(userDir, 'mcp.json'), markerDir: userDir };
            }),
        merge: (existing, url) =>
            mergeJsonMap(existing, ['servers', PATCHWALK_MCP_SERVER_NAME], { type: 'http', url }),
        verify: verifyJson,
    },
    {
        id: 'windsurf',
        name: 'Windsurf',
        restartHint: 'restart Windsurf (or Refresh in Cascade → MCP)',
        manual: (url) =>
            `~/.codeium/windsurf/mcp_config.json → mcpServers.patchwalk = { "serverUrl": "${url}" }`,
        candidates: (host) => {
            const dir = join(host.home, '.codeium', 'windsurf');
            return [{ path: join(dir, 'mcp_config.json'), markerDir: dir }];
        },
        merge: (existing, url) =>
            mergeJsonMap(existing, ['mcpServers', PATCHWALK_MCP_SERVER_NAME], { serverUrl: url }),
        verify: verifyJson,
    },
    {
        id: 'claude-desktop',
        name: 'Claude Desktop',
        restartHint: 'fully quit and reopen Claude Desktop',
        manual: (url) =>
            `claude_desktop_config.json → mcpServers.patchwalk = { "command": "npx", "args": ["-y","mcp-remote","${url}"] } (needs Node.js)`,
        candidates: (host) => {
            const path = claudeDesktopConfig(host);
            return [{ path, markerDir: dirname(path) }];
        },
        // Claude Desktop's config is stdio-only, so reach the HTTP daemon through the mcp-remote bridge.
        merge: (existing, url) =>
            mergeJsonMap(existing, ['mcpServers', PATCHWALK_MCP_SERVER_NAME], {
                command: 'npx',
                args: ['-y', 'mcp-remote', url],
            }),
        verify: verifyJson,
    },
    {
        id: 'cline',
        name: 'Cline',
        restartHint: 'reload the VS Code window',
        manual: (url) =>
            `Cline settings → mcpServers.patchwalk = { "type": "streamableHttp", "url": "${url}" }`,
        candidates: (host) =>
            extensionSettingsCandidates(host, 'saoudrizwan.claude-dev', 'cline_mcp_settings.json'),
        // Cline uses camelCase "streamableHttp"; the hyphenated form makes it fall back to SSE and 405.
        merge: (existing, url) =>
            mergeJsonMap(existing, ['mcpServers', PATCHWALK_MCP_SERVER_NAME], {
                type: 'streamableHttp',
                url,
                disabled: false,
                autoApprove: [],
                timeout: 60,
            }),
        verify: verifyJson,
    },
    {
        id: 'roo-code',
        name: 'Roo Code',
        restartHint: 'reload the VS Code window',
        manual: (url) =>
            `Roo settings → mcpServers.patchwalk = { "type": "streamable-http", "url": "${url}" }`,
        candidates: (host) =>
            extensionSettingsCandidates(host, 'rooveterinaryinc.roo-cline', 'mcp_settings.json'),
        // Roo uses the hyphenated "streamable-http" and "alwaysAllow" (not Cline's "autoApprove").
        merge: (existing, url) =>
            mergeJsonMap(existing, ['mcpServers', PATCHWALK_MCP_SERVER_NAME], {
                type: 'streamable-http',
                url,
                alwaysAllow: [],
                disabled: false,
            }),
        verify: verifyJson,
    },
    {
        id: 'codex',
        name: 'Codex',
        restartHint: 'restart your `codex` session',
        manual: (url) => `~/.codex/config.toml → [mcp_servers.patchwalk] url = "${url}"`,
        candidates: (host) => {
            const dir = join(host.home, '.codex');
            return [{ path: join(dir, 'config.toml'), markerDir: dir }];
        },
        merge: (existing, url) => mergeTomlTable(existing, url),
        verify: verifyToml,
    },
    {
        id: 'gemini-cli',
        name: 'Gemini CLI',
        restartHint: 'restart your `gemini` session',
        manual: (url) => `~/.gemini/settings.json → mcpServers.patchwalk = { "httpUrl": "${url}" }`,
        candidates: (host) => {
            const dir = join(host.home, '.gemini');
            return [{ path: join(dir, 'settings.json'), markerDir: dir }];
        },
        // Gemini picks the transport by field name: httpUrl = streamable HTTP (url = SSE).
        merge: (existing, url) =>
            mergeJsonMap(existing, ['mcpServers', PATCHWALK_MCP_SERVER_NAME], { httpUrl: url }),
        verify: verifyJson,
    },
    {
        id: 'continue',
        name: 'Continue',
        restartHint: 'reload the Continue extension / restart the IDE',
        manual: (url) =>
            `~/.continue/config.yaml → mcpServers: [ { name: patchwalk, type: streamable-http, url: ${url} } ]`,
        candidates: (host) => {
            const dir = join(host.home, '.continue');
            return [{ path: join(dir, 'config.yaml'), markerDir: dir }];
        },
        merge: (existing, url) => mergeYamlList(existing, url),
        verify: verifyYaml,
    },
];

// ── orchestrator ────────────────────────────────────────────────────────────

export type InjectionOutcome = 'connected' | 'updated' | 'already' | 'not-installed' | 'failed';

export interface InjectionResult {
    id: string;
    name: string;
    outcome: InjectionOutcome;
    path: string;
    restartHint: string;
    detail?: string;
}

/** Injected filesystem, so the orchestrator is testable and its writes are safe (atomic + backup). */
export interface InjectorIO {
    exists: (path: string) => boolean;
    isDir: (path: string) => boolean;
    read: (path: string) => string;
    /** Write atomically (temp + rename), backing up an overwritten file exactly once. */
    writeAtomic: (path: string, text: string, hadExistingFile: boolean) => void;
}

/**
 * Try to connect every supported agent that is installed. Never throws — each agent's failure is
 * isolated and reported, so one broken config can't stop the rest.
 */
export const runInjection = (host: Host, url: string, io: InjectorIO): InjectionResult[] => {
    const results: InjectionResult[] = [];
    for (const adapter of AGENT_ADAPTERS) {
        for (const candidate of adapter.candidates(host)) {
            const base = {
                id: adapter.id,
                name: adapter.name,
                path: candidate.path,
                restartHint: adapter.restartHint,
            };
            const fileThere = io.exists(candidate.path);
            const installed = fileThere || io.isDir(candidate.markerDir);
            if (!installed) {
                results.push({ ...base, outcome: 'not-installed' });
                continue;
            }
            try {
                const existing = fileThere ? io.read(candidate.path) : undefined;
                const merged = adapter.merge(existing, url);
                if (!merged.changed) {
                    results.push({ ...base, outcome: 'already' });
                    continue;
                }
                adapter.verify(merged.text); // never write content we can't parse back
                io.writeAtomic(candidate.path, merged.text, fileThere);
                results.push({ ...base, outcome: merged.wasPresent ? 'updated' : 'connected' });
            } catch (error) {
                results.push({
                    ...base,
                    outcome: 'failed',
                    detail: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    return results;
};

/** The label used for a candidate path in UI (the file's basename with a little parent context). */
export const shortPath = (path: string): string => `${basename(dirname(path))}/${basename(path)}`;
