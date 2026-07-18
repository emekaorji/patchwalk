import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert';

import { parse as parseYaml } from 'yaml';

import type { AgentAdapter, Host, InjectorIO } from '../src/extension/mcpInject/injector';
import { AGENT_ADAPTERS, buildMcpUrl, runInjection } from '../src/extension/mcpInject/injector';

const URL = 'http://127.0.0.1:7357/mcp';
const adapter = (id: string): AgentAdapter => {
    const found = AGENT_ADAPTERS.find((a) => a.id === id);
    if (!found) {
        throw new Error(`no adapter ${id}`);
    }
    return found;
};
const freshText = (id: string): string => {
    const result = adapter(id).merge(undefined, URL);
    if (!result.changed) {
        throw new Error('expected a change on a fresh file');
    }
    return result.text;
};
const server = (id: string, key = 'mcpServers'): Record<string, unknown> =>
    (JSON.parse(freshText(id))[key] as Record<string, Record<string, unknown>>).patchwalk;

describe('mcp injector — per-agent field shape (the traps that silently break connections)', () => {
    it('Claude Code: mcpServers.patchwalk = { type: http, url }', () => {
        deepStrictEqual(server('claude-code'), { type: 'http', url: URL });
    });
    it('Cursor: url (not serverUrl), no type', () => {
        deepStrictEqual(server('cursor'), { url: URL });
    });
    it('VS Code: key is `servers` (not mcpServers), type http', () => {
        deepStrictEqual(server('vscode', 'servers'), { type: 'http', url: URL });
        // and it must NOT write an mcpServers key
        strictEqual('mcpServers' in JSON.parse(freshText('vscode')), false);
    });
    it('Windsurf: serverUrl (not url)', () => {
        deepStrictEqual(server('windsurf'), { serverUrl: URL });
    });
    it('Claude Desktop: stdio bridge via mcp-remote (no native http)', () => {
        deepStrictEqual(server('claude-desktop'), {
            command: 'npx',
            args: ['-y', 'mcp-remote', URL],
        });
    });
    it('Cline: type is camelCase streamableHttp', () => {
        const s = server('cline');
        strictEqual(s.type, 'streamableHttp');
        strictEqual(s.url, URL);
    });
    it('Roo Code: type is hyphenated streamable-http, uses alwaysAllow', () => {
        const s = server('roo-code');
        strictEqual(s.type, 'streamable-http');
        ok(Array.isArray(s.alwaysAllow));
        strictEqual('autoApprove' in s, false);
    });
    it('Gemini CLI: httpUrl (not url)', () => {
        deepStrictEqual(server('gemini-cli'), { httpUrl: URL });
    });
    it('Codex: TOML [mcp_servers.patchwalk] with url', () => {
        const text = freshText('codex');
        match(text, /\[mcp_servers\.patchwalk\]/);
        match(text, /url = "http:\/\/127\.0\.0\.1:7357\/mcp"/);
    });
    it('Continue: YAML mcpServers LIST with streamable-http + required header', () => {
        const doc = parseYaml(freshText('continue')) as {
            name?: string;
            version?: string;
            schema?: string;
            mcpServers?: Array<{ name: string; type: string; url: string }>;
        };
        strictEqual(doc.schema, 'v1');
        ok(doc.name && doc.version, 'header fields present');
        ok(Array.isArray(doc.mcpServers));
        deepStrictEqual(doc.mcpServers?.[0], {
            name: 'patchwalk',
            type: 'streamable-http',
            url: URL,
        });
    });
});

describe('mcp injector — safe merge (never clobber the user)', () => {
    it('preserves other servers and top-level keys (JSON)', () => {
        const existing = JSON.stringify({
            mcpServers: { other: { url: 'http://x' } },
            somethingElse: 42,
        });
        const result = adapter('cursor').merge(existing, URL);
        ok(result.changed);
        if (result.changed) {
            const parsed = JSON.parse(result.text);
            deepStrictEqual(parsed.mcpServers.other, { url: 'http://x' });
            strictEqual(parsed.somethingElse, 42);
            deepStrictEqual(parsed.mcpServers.patchwalk, { url: URL });
        }
    });

    it('is idempotent — re-running makes no change', () => {
        for (const id of ['claude-code', 'cursor', 'vscode', 'gemini-cli', 'codex', 'continue']) {
            const first = freshText(id);
            const second = adapter(id).merge(first, URL);
            strictEqual(second.changed, false, `${id} should be idempotent`);
        }
    });

    it('updates an existing patchwalk entry to the new url (wasPresent=true)', () => {
        const existing = JSON.stringify({
            mcpServers: { patchwalk: { url: 'http://127.0.0.1:9999/mcp' } },
        });
        const result = adapter('cursor').merge(existing, URL);
        ok(result.changed && result.wasPresent);
        if (result.changed) {
            strictEqual(JSON.parse(result.text).mcpServers.patchwalk.url, URL);
        }
    });

    it('TOML: appends without duplicating [mcp_servers] and keeps other tables', () => {
        const existing = '[model]\nname = "gpt"\n\n[mcp_servers.other]\ncommand = "y"\n';
        const result = adapter('codex').merge(existing, URL);
        ok(result.changed);
        if (result.changed) {
            match(result.text, /\[model\]/);
            match(result.text, /\[mcp_servers\.other\]/);
            match(result.text, /\[mcp_servers\.patchwalk\]/);
            strictEqual(result.text.match(/\[mcp_servers\.patchwalk\]/g)?.length, 1);
            // idempotent second pass
            strictEqual(adapter('codex').merge(result.text, URL).changed, false);
        }
    });

    it('YAML: appends to an existing Continue list, keeping other servers + header', () => {
        const existing =
            'name: mine\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: other\n    type: stdio\n    command: foo\n';
        const result = adapter('continue').merge(existing, URL);
        ok(result.changed);
        if (result.changed) {
            const doc = parseYaml(result.text) as {
                name: string;
                mcpServers: Array<{ name: string }>;
            };
            strictEqual(doc.name, 'mine');
            deepStrictEqual(doc.mcpServers.map((s) => s.name).sort(), ['other', 'patchwalk']);
        }
    });

    it('verify() rejects content it cannot parse back', () => {
        throws(() => adapter('cursor').verify('{ not json'));
        throws(() => adapter('codex').verify('nothing here'));
        throws(() => adapter('continue').verify('a: [unterminated'));
    });
});

describe('mcp injector — orchestration', () => {
    const host: Host = { home: '/Users/u', appData: undefined, platform: 'darwin' };

    const fakeIo = (init: { files?: Record<string, string>; dirs?: string[] }) => {
        const files = new Map(Object.entries(init.files ?? {}));
        const dirs = new Set(init.dirs ?? []);
        const writes: Array<{ path: string; hadExisting: boolean }> = [];
        const io: InjectorIO = {
            exists: (p) => files.has(p),
            isDir: (p) => dirs.has(p),
            read: (p) => {
                const v = files.get(p);
                if (v === undefined) {
                    throw new Error('no file');
                }
                return v;
            },
            writeAtomic: (p, text, had) => {
                writes.push({ path: p, hadExisting: had });
                files.set(p, text);
            },
        };
        return { io, files, writes };
    };

    it('connects an installed agent and skips uninstalled ones', () => {
        // Only Cursor "installed" (its marker dir exists); nothing else.
        const { io, writes } = fakeIo({ dirs: ['/Users/u/.cursor'] });
        const results = runInjection(host, URL, io);

        const cursor = results.find((r) => r.id === 'cursor');
        strictEqual(cursor?.outcome, 'connected');
        strictEqual(writes.length, 1);
        strictEqual(writes[0].path, '/Users/u/.cursor/mcp.json');
        strictEqual(writes[0].hadExisting, false);

        // Everything else is reported not-installed, and nothing else was written.
        ok(results.filter((r) => r.id !== 'cursor').every((r) => r.outcome === 'not-installed'));
    });

    it('reports already when the server is present and correct', () => {
        const existing = JSON.stringify({ mcpServers: { patchwalk: { url: URL } } });
        const { io } = fakeIo({
            dirs: ['/Users/u/.cursor'],
            files: { '/Users/u/.cursor/mcp.json': existing },
        });
        const results = runInjection(host, URL, io);
        strictEqual(results.find((r) => r.id === 'cursor')?.outcome, 'already');
    });

    it('isolates a failure — a broken write for one agent never stops the rest', () => {
        const files = new Map<string, string>();
        const io: InjectorIO = {
            exists: (p) => files.has(p),
            isDir: (p) => p === '/Users/u/.cursor' || p === '/Users/u/.gemini',
            read: (p) => files.get(p) ?? '',
            writeAtomic: (p, text) => {
                if (p.includes('.cursor')) {
                    throw new Error('disk on fire');
                }
                files.set(p, text);
            },
        };
        const results = runInjection(host, URL, io);
        strictEqual(results.find((r) => r.id === 'cursor')?.outcome, 'failed');
        strictEqual(results.find((r) => r.id === 'gemini-cli')?.outcome, 'connected');
    });

    it('builds the endpoint from the daemon port', () => {
        strictEqual(buildMcpUrl(7358), 'http://127.0.0.1:7358/mcp');
    });
});
