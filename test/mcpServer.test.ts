import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { PatchwalkMcpServer } from '../src/daemon/mcpServer';
import { PatchwalkDaemonClient } from '../src/extension/daemonClient';
import { PATCHWALK_WORKER_API_VERSION } from '../src/lib/controlProtocol';
import type { PatchwalkStatusResource } from '../src/lib/mcpCatalog';
import {
    PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI,
    PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
    PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
    PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME,
    PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
    PATCHWALK_PLAY_TOOL_NAME,
    PATCHWALK_STATUS_RESOURCE_URI,
} from '../src/lib/mcpCatalog';
import { matchBasePathToWorkspaceRoots } from '../src/lib/routing';
import type { PatchwalkHandoffPayload } from '../src/lib/schema';

// Health checks come from the daemon side-channel endpoint rather than MCP resources.
interface PatchwalkHealthResponse {
    ok: boolean;
    endpointUrl: string | null;
    daemonPid: number;
    activeSessionCount: number;
    workerCount: number;
    activeDispatchCount: number;
}

/**
 * The fake worker speaks the same private daemon protocol as the real extension window, but strips
 * out editor integration so the daemon can be tested deterministically in-process.
 */
class FakePatchwalkWorker {
    public readonly workerId = randomUUID();
    public readonly executedPayloads: PatchwalkHandoffPayload[] = [];
    private stopped = false;
    private pollPromise: Promise<void> | undefined;

    public constructor(
        private readonly daemonClient: PatchwalkDaemonClient,
        private readonly workspaceRoots: string[],
        private readonly extensionVersion = 'test-extension',
    ) {}

    public async start(options: { lastSeenAt?: string } = {}): Promise<void> {
        await this.daemonClient.registerWorker({
            workerId: this.workerId,
            processId: process.pid,
            extensionVersion: this.extensionVersion,
            workspaceRoots: this.workspaceRoots,
            lastSeenAt: options.lastSeenAt ?? new Date().toISOString(),
            apiVersion: PATCHWALK_WORKER_API_VERSION,
        });

        this.pollPromise = this.poll();
    }

    public async stop(): Promise<void> {
        this.stopped = true;
        await Promise.race([
            this.pollPromise ?? Promise.resolve(),
            new Promise((resolve) => {
                setTimeout(resolve, 700);
            }),
        ]);
    }

    private async poll(): Promise<void> {
        if (this.stopped) {
            return;
        }

        try {
            const events = await this.daemonClient.pollEvents(this.workerId, 500);
            // Preserve event order so claim/execute semantics match the real worker loop.
            await events.reduce<Promise<void>>(async (queue, event) => {
                await queue;

                switch (event.type) {
                    case 'playback.claim': {
                        const matchForWorker = matchBasePathToWorkspaceRoots(
                            event.basePath,
                            this.workspaceRoots,
                        );
                        if (!matchForWorker) {
                            await this.daemonClient.submitClaim(this.workerId, {
                                dispatchId: event.dispatchId,
                                accepted: false,
                            });
                            return;
                        }

                        await this.daemonClient.submitClaim(this.workerId, {
                            dispatchId: event.dispatchId,
                            accepted: true,
                            matchedRoot: matchForWorker.matchedRoot,
                            matchKind: matchForWorker.matchKind,
                        });
                        return;
                    }
                    case 'playback.execute':
                        this.executedPayloads.push(event.payload);
                        await this.daemonClient.submitResult(this.workerId, {
                            dispatchId: event.dispatchId,
                            handoffId: event.payload.handoffId,
                            status: 'completed',
                            stepsPlayed: event.payload.walkthrough.length,
                        });
                        return;
                    case 'playback.cancel':
                    case 'worker.reconcile':
                        return;
                }
            }, Promise.resolve());
        } catch (error) {
            if (!this.stopped) {
                throw error;
            }
        }

        if (!this.stopped) {
            await this.poll();
        }
    }
}

/**
 * Keep routing payloads intentionally small so each test isolates one daemon behavior.
 */
const createPayload = (basePath: string): PatchwalkHandoffPayload => {
    return {
        specVersion: '1.0.0',
        handoffId: `mcp-server-test-${randomUUID()}`,
        createdAt: '2026-03-07T10:00:00Z',
        basePath,
        producer: {
            agent: 'codex',
            model: 'gpt-5',
        },
        summary: 'Exercise the MCP playback tool.',
        walkthrough: [
            {
                id: 'step-1',
                title: 'Open extension entry',
                narration: 'Patchwalk should open the extension entry file for this test.',
                path: 'src/extension/index.ts',
                range: {
                    startLine: 1,
                    endLine: 20,
                },
            },
        ],
    };
};

const readTextResource = async (client: Client, uri: string): Promise<string> => {
    const result = await client.readResource({ uri });
    const firstContent = result.contents[0];

    if (!firstContent || !('text' in firstContent)) {
        throw new Error(`Resource ${uri} did not return text content.`);
    }

    return firstContent.text;
};

// These integration tests exercise the daemon end to end: HTTP, MCP, and worker routing.
describe('patchwalk mcp server', () => {
    let server: PatchwalkMcpServer;
    let endpointUrl: string;
    let client: Client;
    let transport: StreamableHTTPClientTransport;
    let daemonClient: PatchwalkDaemonClient;
    let workers: FakePatchwalkWorker[];

    beforeEach(async () => {
        server = new PatchwalkMcpServer({
            port: 0,
        });

        await server.start();
        ok(server.endpointUrl, 'Expected the MCP server to expose an endpoint URL.');
        endpointUrl = server.endpointUrl;

        client = new Client({
            name: 'patchwalk-test-client',
            version: '1.0.0',
        });
        transport = new StreamableHTTPClientTransport(new URL(endpointUrl));
        await client.connect(transport);

        daemonClient = new PatchwalkDaemonClient({
            daemonEntryPath: '/unused/in-tests',
            port: server.listeningPort!,
        });
        workers = [];
    });

    afterEach(async () => {
        await Promise.allSettled(workers.map(async (worker) => worker.stop()));
        await Promise.allSettled([transport.terminateSession(), transport.close(), server.stop()]);
    });

    it('serves health checks and MCP capabilities from the daemon', async () => {
        const healthUrl = endpointUrl.replace(/\/mcp$/, '/health');
        const response = await fetch(healthUrl);
        const health = (await response.json()) as PatchwalkHealthResponse;

        strictEqual(response.status, 200);
        strictEqual(health.ok, true);
        strictEqual(health.endpointUrl, endpointUrl);
        strictEqual(health.activeSessionCount, 1);
        strictEqual(health.daemonPid > 0, true);

        const resources = await client.listResources();
        const resourceUris = resources.resources.map((resource) => resource.uri).sort();
        deepStrictEqual(resourceUris, [
            PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI,
            PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
            PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
            PATCHWALK_STATUS_RESOURCE_URI,
        ]);

        const prompts = await client.listPrompts();
        const promptNames = prompts.prompts.map((prompt) => prompt.name).sort();
        deepStrictEqual(promptNames, [
            PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
            PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME,
        ]);

        const tools = await client.listTools();
        strictEqual(
            tools.tools.some((tool) => tool.name === PATCHWALK_PLAY_TOOL_NAME),
            true,
        );

        const playTool = tools.tools.find((tool) => tool.name === PATCHWALK_PLAY_TOOL_NAME);
        match(playTool?.description ?? '', /semantic patch explanations/);
    });

    it('reports worker and dispatch status through the status resource', async () => {
        const projectRoot = '/tmp/patchwalk-project';
        const worker = new FakePatchwalkWorker(daemonClient, [projectRoot]);
        workers.push(worker);
        await worker.start();

        const statusResource = JSON.parse(
            await readTextResource(client, PATCHWALK_STATUS_RESOURCE_URI),
        ) as PatchwalkStatusResource;

        strictEqual((statusResource.daemonPid ?? 0) > 0, true);
        strictEqual(statusResource.configuredPort, server.listeningPort);
        strictEqual(statusResource.workerCount, 1);
        strictEqual(statusResource.activeDispatchCount, 0);
        deepStrictEqual(statusResource.workers[0]?.workspaceRoots, [projectRoot]);
    });

    it('routes playback to the exact matching worker', async () => {
        const parentWorker = new FakePatchwalkWorker(daemonClient, ['/tmp']);
        const exactWorker = new FakePatchwalkWorker(daemonClient, ['/tmp/patchwalk-project']);
        workers.push(parentWorker, exactWorker);

        await parentWorker.start();
        await exactWorker.start();

        const payload = createPayload('/tmp/patchwalk-project');
        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: payload,
        });
        const structuredContent = playResult.structuredContent as
            | {
                  handoffId?: string;
                  status?: string;
                  stepsPlayed?: number;
                  workerId?: string;
                  matchedRoot?: string;
              }
            | undefined;

        strictEqual(playResult.isError ?? false, false);
        strictEqual(parentWorker.executedPayloads.length, 0);
        strictEqual(exactWorker.executedPayloads.length, 1);
        strictEqual(structuredContent?.status, 'completed');
        strictEqual(structuredContent?.workerId, exactWorker.workerId);
        strictEqual(structuredContent?.matchedRoot, '/tmp/patchwalk-project');
    });

    it('uses the deepest parent-path match when no exact worker exists', async () => {
        const shallowWorker = new FakePatchwalkWorker(daemonClient, ['/tmp/patchwalk']);
        const deepWorker = new FakePatchwalkWorker(daemonClient, ['/tmp/patchwalk/project']);
        workers.push(shallowWorker, deepWorker);

        await shallowWorker.start();
        await deepWorker.start();

        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/patchwalk/project/service'),
        });
        const structuredContent = playResult.structuredContent as
            | {
                  workerId?: string;
                  matchedRoot?: string;
              }
            | undefined;

        strictEqual(playResult.isError ?? false, false);
        strictEqual(shallowWorker.executedPayloads.length, 0);
        strictEqual(deepWorker.executedPayloads.length, 1);
        strictEqual(structuredContent?.workerId, deepWorker.workerId);
        strictEqual(structuredContent?.matchedRoot, '/tmp/patchwalk/project');
    });

    it('uses earliest registration as the final tie-breaker', async () => {
        const firstWorker = new FakePatchwalkWorker(daemonClient, ['/tmp/shared-root']);
        const secondWorker = new FakePatchwalkWorker(daemonClient, ['/tmp/shared-root']);
        workers.push(firstWorker, secondWorker);

        await firstWorker.start();
        await secondWorker.start();

        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/shared-root/project'),
        });
        const structuredContent = playResult.structuredContent as
            | {
                  workerId?: string;
              }
            | undefined;

        strictEqual(playResult.isError ?? false, false);
        strictEqual(firstWorker.executedPayloads.length, 1);
        strictEqual(secondWorker.executedPayloads.length, 0);
        strictEqual(structuredContent?.workerId, firstWorker.workerId);
    });

    it('returns a tool error when no live worker matches the base path', async () => {
        const worker = new FakePatchwalkWorker(daemonClient, ['/tmp/unrelated-root']);
        workers.push(worker);
        await worker.start();

        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/expected-root'),
        });
        const content = playResult.content as Array<{ type: string; text?: string }>;

        strictEqual(playResult.isError, true);
        strictEqual(worker.executedPayloads.length, 0);
        match(content[0]?.text ?? '', /No live Patchwalk window matched/);
    });

    it('drops stale workers on the next request cycle', async () => {
        await daemonClient.registerWorker({
            workerId: randomUUID(),
            processId: process.pid,
            extensionVersion: 'stale-worker',
            workspaceRoots: ['/tmp/stale-root'],
            lastSeenAt: '2020-01-01T00:00:00Z',
            apiVersion: PATCHWALK_WORKER_API_VERSION,
        });

        const health = await daemonClient.fetchHealth();
        strictEqual(health.workerCount, 0);
    });

    it('still serves the example payload and operator manual resources', async () => {
        const exampleHandoff = JSON.parse(
            await readTextResource(client, PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI),
        ) as PatchwalkHandoffPayload;
        strictEqual(exampleHandoff.basePath, '/Users/example/project');

        const operatorManual = await readTextResource(
            client,
            PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
        );
        match(operatorManual, /basePath/);
        match(operatorManual, /longest parent-path match/);

        const authoringGuide = await readTextResource(
            client,
            PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI,
        );
        match(authoringGuide, /semantic patch explanation/);
        match(authoringGuide, /Risk analysis/);
        match(authoringGuide, /Blast radius/);

        const composePrompt = await client.getPrompt({
            name: PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
            arguments: {
                changeSummary: 'Refactor the authentication flow.',
                changedFiles: 'src/auth.ts\nsrc/session.ts',
                focusAreas: 'Emphasize behavior change and security implications.',
            },
        });
        if (composePrompt.messages[0]?.content.type !== 'text') {
            throw new Error('Expected text compose prompt content.');
        }

        match(composePrompt.messages[0].content.text, /behavior change/);
        match(composePrompt.messages[0].content.text, /risk signals/);
    });
});
