import path from 'node:path';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import * as logger from '../src/lib/logger';
import {
    PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
    PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
    PATCHWALK_PLAY_TOOL_NAME,
    PATCHWALK_STATUS_RESOURCE_URI,
} from '../src/lib/mcpCatalog';
import type { PatchwalkHandoffPayload } from '../src/lib/schema';

/**
 * Manual smoke test for the full daemon flow: inspect the MCP surface, then send a long narrated
 * walkthrough into the dedicated test workspace.
 */
type WalkthroughTargetType = 'line' | 'range' | 'symbol';

const port = Number(process.env.PATCHWALK_DAEMON_PORT ?? process.env.PATCHWALK_MCP_PORT ?? '7357');
const baseUrl = `http://127.0.0.1:${port}`;
const endpointUrl = `${baseUrl}/mcp`;
const sampleBasePath = path.resolve(__dirname, '../test-workspace-secondary');

interface SampleWalkthroughStep {
    id: string;
    title: string;
    narration: string;
    path: string;
    type?: WalkthroughTargetType;
    symbol?: string;
    range: {
        startLine: number;
        endLine: number;
    };
}

/**
 * Helper keeps the hand-authored walkthrough readable without sacrificing stable ids.
 */
const createStep = (
    stepNumber: number,
    title: string,
    narration: string,
    path: string,
    startLine: number,
    endLine: number,
    options: {
        type?: WalkthroughTargetType;
        symbol?: string;
    } = {},
): SampleWalkthroughStep => {
    return {
        id: `step-${String(stepNumber).padStart(2, '0')}`,
        title,
        narration,
        path,
        type: options.type ?? 'range',
        symbol: options.symbol,
        range: {
            startLine,
            endLine,
        },
    };
};

const walkthrough: SampleWalkthroughStep[] = [
    createStep(
        4,
        'Entry Imports',
        'The runtime entry point stays thin. It imports the token builder and the server bootstrap so startup logic is easy to scan.',
        'src/index.ts',
        1,
        2,
    ),
    createStep(
        5,
        'Build Demo Token',
        'Before the server starts, the entry point prepares a realistic bearer token for a maintainer with read and write project scopes.',
        'src/index.ts',
        4,
        8,
    ),
    createStep(
        6,
        'Boot Sequence',
        'Startup logs the demo token for manual testing and then kicks off the HTTP server. There is no framework here, just a deliberate bare Node bootstrap.',
        'src/index.ts',
        10,
        13,
    ),
];

// Route the sample walkthrough into the dedicated manual-test workspace.
const samplePayload: PatchwalkHandoffPayload = {
    specVersion: '1.0.0',
    handoffId: `sample-demo-${new Date().toISOString()}`,
    createdAt: new Date().toISOString(),
    basePath: sampleBasePath,
    producer: {
        agent: 'codex',
        agentVersion: '1.0.0',
        model: 'gpt-5',
    },
    summary: `Patchwalk is about to run a ${walkthrough.length}-step walkthrough of the demo workspace, from package metadata through auth, data access, services, routing, and server startup.`,
    walkthrough,
};

logger.info('PAYLOAD', samplePayload);

const fetchJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(input, init);
    const bodyText = await response.text();

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${bodyText}`);
    }

    return bodyText ? (JSON.parse(bodyText) as T) : (undefined as T);
};

const main = async (): Promise<void> => {
    const health = await fetchJson<{ ok: boolean }>(`${baseUrl}/health`);
    console.log('health:', health);

    const client = new Client({
        name: 'patchwalk-sample-client',
        version: '1.0.0',
    });
    const transport = new StreamableHTTPClientTransport(new URL(endpointUrl));

    try {
        await client.connect(transport);

        // Print the whole surface first so manual testers can spot protocol regressions quickly.
        console.log('serverInfo:', client.getServerVersion());
        console.log('capabilities:', client.getServerCapabilities());
        console.log('sessionId:', transport.sessionId ?? null);

        const resources = await client.listResources();
        console.log(
            'resources:',
            resources.resources.map((resource) => resource.uri),
        );

        const statusResource = await client.readResource({ uri: PATCHWALK_STATUS_RESOURCE_URI });
        console.log('status:', statusResource.contents[0]);

        const exampleHandoff = await client.readResource({
            uri: PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
        });
        console.log('example-handoff:', exampleHandoff.contents[0]);

        const prompts = await client.listPrompts();
        console.log(
            'prompts:',
            prompts.prompts.map((prompt) => prompt.name),
        );

        const composePrompt = await client.getPrompt({
            name: PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
            arguments: {
                changeSummary: 'Walk through the sample workspace in detail.',
                changedFiles: 'test-workspace/src/**/*',
                focusAreas: 'Explain the architecture from entrypoint through routes and services.',
            },
        });
        console.log('compose-prompt:', composePrompt.messages[0]);

        const tools = await client.listTools();
        console.log(
            'tools:',
            tools.tools.map((tool) => tool.name),
        );

        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: samplePayload,
        });
        console.log('play-result:', playResult);
    } finally {
        await Promise.allSettled([transport.terminateSession(), transport.close()]);
    }
};

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Sample MCP call failed: ${message}`);
    process.exitCode = 1;
});
