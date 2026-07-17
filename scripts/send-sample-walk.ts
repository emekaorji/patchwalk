#!/usr/bin/env tsx
import path from 'node:path';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Manual smoke test for the Patchwalk daemon MCP surface. It launches a tiny walk and exercises the
 * new control plane end to end: `patchwalk.play` returns immediately (launch + ack),
 * `patchwalk.status` reports the active walk, and `patchwalk.stop` interrupts it.
 *
 * Usage: pnpm play:sample [basePath] PATCHWALK_DAEMON_PORT=7357 pnpm play:sample
 * /abs/path/to/an/open/vscode/workspace
 *
 * A Patchwalk-enabled VS Code / Cursor window must be open on `basePath` (or a parent) for routing
 * to find a live window; otherwise `patchwalk.play` returns an error explaining no window matched.
 */
const port = Number(process.env.PATCHWALK_DAEMON_PORT ?? '7357');
const basePath = path.resolve(process.argv[2] ?? process.cwd());

const sampleWalk = {
    specVersion: '1.0.0',
    handoffId: `sample-walk-${new Date().toISOString()}`,
    createdAt: new Date().toISOString(),
    basePath,
    producer: { agent: 'send-sample-walk', model: 'n/a' },
    summary: 'A tiny sample walk that exercises launch + ack and the stop control.',
    walkthrough: [
        {
            id: 'step-1',
            title: 'Project manifest',
            narration:
                'This sample walk exists to prove the control plane. It launches, reports status, then stops — all without blocking the caller.',
            path: 'package.json',
            range: { startLine: 1, endLine: 3 },
        },
    ],
};

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

async function main(): Promise<void> {
    const client = new Client({ name: 'patchwalk-sample-walk', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);

    try {
        console.log(`Launching a sample walk for basePath: ${basePath}`);
        const launch = await client.callTool({ name: 'patchwalk.play', arguments: sampleWalk });
        if (launch.isError) {
            console.error('patchwalk.play returned an error:');
            console.error(asJson(launch.content));
            console.error('\nIs a Patchwalk window open on this basePath (or a parent)?');
            process.exitCode = 1;
            return;
        }
        console.log('Launched (launch + ack, returned before narration finished):');
        console.log(asJson(launch.structuredContent));

        const status = await client.callTool({ name: 'patchwalk.status', arguments: {} });
        console.log('\npatchwalk.status:');
        console.log(asJson(status.structuredContent));

        const stop = await client.callTool({ name: 'patchwalk.stop', arguments: {} });
        console.log('\npatchwalk.stop:');
        console.log(asJson(stop.structuredContent));
    } finally {
        await Promise.allSettled([transport.terminateSession(), transport.close()]);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
