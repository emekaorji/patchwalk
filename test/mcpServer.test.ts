import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';

import { PatchwalkMcpServer } from '../src/daemon/mcpServer';
import { PatchwalkDaemonClient } from '../src/extension/daemonClient';
import type {
    PatchwalkDaemonToWorkerMessage,
    PatchwalkPlaybackExecuteMessage,
    PatchwalkPlaybackStopMessage,
} from '../src/lib/controlProtocol';
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
    PATCHWALK_STOP_TOOL_NAME,
} from '../src/lib/mcpCatalog';
import { matchBasePathToWorkspaceRoots } from '../src/lib/routing';
import type { PatchwalkHandoffPayload } from '../src/lib/schema';

interface PatchwalkHealthResponse {
    ok: boolean;
    endpointUrl: string | null;
    daemonPid: number;
    activeSessionCount: number;
    workerCount: number;
    activeDispatchCount: number;
}

interface FakePatchwalkWorkerOptions {
    holdExecutionUntilStopped?: boolean;
    disconnectOnStop?: boolean;
}

class FakePatchwalkWorker {
    public readonly workerId = randomUUID();
    public readonly executedPayloads: PatchwalkHandoffPayload[] = [];
    public readonly startedExecution = this.createDeferred<void>();
    public readonly stoppedExecution = this.createDeferred<void>();
    private socket: WebSocket | undefined;
    private stopped = false;

    public constructor(
        private readonly daemonClient: PatchwalkDaemonClient,
        private readonly workspaceRoots: string[],
        private readonly extensionVersion = 'test-extension',
        private readonly options: FakePatchwalkWorkerOptions = {},
    ) {}

    public async start(options: { lastSeenAt?: string } = {}): Promise<void> {
        this.socket = new WebSocket(this.daemonClient.workerSocketUrl);
        await new Promise<void>((resolve, reject) => {
            this.socket!.once('open', resolve);
            this.socket!.once('error', reject);
        });

        this.socket.on('message', (rawData) => {
            this.handleMessage(rawData).catch((error: unknown) => {
                throw error;
            });
        });

        this.sendMessage({
            type: 'worker.register',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            processId: process.pid,
            extensionVersion: this.extensionVersion,
            workspaceRoots: this.workspaceRoots,
            lastSeenAt: options.lastSeenAt ?? new Date().toISOString(),
            apiVersion: PATCHWALK_WORKER_API_VERSION,
            playbackState: 'idle',
        });

        await new Promise((resolve) => {
            setTimeout(resolve, 25);
        });
    }

    public async stop(): Promise<void> {
        this.stopped = true;
        if (!this.socket) {
            return;
        }

        await new Promise<void>((resolve) => {
            this.socket!.once('close', () => {
                resolve();
            });
            this.socket!.close();
        });
        this.socket = undefined;
    }

    private async handleMessage(rawData: WebSocket.RawData): Promise<void> {
        const message = JSON.parse(String(rawData)) as PatchwalkDaemonToWorkerMessage;
        switch (message.type) {
            case 'playback.prepare':
                await this.handlePrepareMessage(message);
                return;
            case 'playback.execute':
                await this.handleExecuteMessage(message);
                return;
            case 'playback.stop':
                await this.handleStopMessage(message);
                return;
            case 'worker.reconcile':
                this.sendHeartbeat('idle');
                return;
        }
    }

    private async handlePrepareMessage(message: {
        dispatchId: string;
        handoffId: string;
        basePath: string;
    }): Promise<void> {
        const matchForWorker = matchBasePathToWorkspaceRoots(message.basePath, this.workspaceRoots);
        if (matchForWorker) {
            return;
        }

        this.sendMessage({
            type: 'playback.failed',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            dispatchId: message.dispatchId,
            handoffId: message.handoffId,
            phase: 'prepare',
            reasonCode: 'unavailable',
            error: 'Worker does not own the requested base path anymore.',
        });
    }

    private async handleExecuteMessage(message: PatchwalkPlaybackExecuteMessage): Promise<void> {
        this.executedPayloads.push(message.payload);
        this.sendHeartbeat('playing', message.payload.handoffId);
        this.startedExecution.resolve();

        if (this.options.holdExecutionUntilStopped) {
            return;
        }

        this.sendMessage({
            type: 'playback.completed',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            dispatchId: message.dispatchId,
            handoffId: message.payload.handoffId,
            stepsPlayed: message.payload.walkthrough.length,
        });
        this.sendHeartbeat('idle');
    }

    private async handleStopMessage(message: PatchwalkPlaybackStopMessage): Promise<void> {
        if (this.options.disconnectOnStop) {
            await this.stop();
            this.stoppedExecution.resolve();
            return;
        }

        this.sendHeartbeat('stopping', message.handoffId);
        this.sendMessage({
            type: 'playback.stopped',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            dispatchId: message.dispatchId,
            handoffId: message.handoffId,
        });
        this.sendHeartbeat('idle');
        this.stoppedExecution.resolve();
    }

    private sendHeartbeat(
        playbackState: 'idle' | 'playing' | 'stopping',
        activeHandoffId?: string,
    ): void {
        this.sendMessage({
            type: 'worker.heartbeat',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            playbackState,
            activeHandoffId,
        });
    }

    private sendMessage(message: Record<string, unknown>): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }

        this.socket.send(JSON.stringify(message));
    }

    private createDeferred<T>() {
        const state = {} as {
            resolve?: (value: T | PromiseLike<T>) => void;
            reject?: (reason?: unknown) => void;
        };

        const promise = new Promise<T>((resolve, reject) => {
            state.resolve = resolve;
            state.reject = reject;
        });

        return {
            promise,
            resolve: state.resolve!,
            reject: state.reject!,
        };
    }
}

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

        const statusUrl = endpointUrl.replace(/\/mcp$/, '/status');
        const statusResponse = await fetch(statusUrl);
        const status = (await statusResponse.json()) as PatchwalkStatusResource;
        strictEqual(statusResponse.status, 200);
        strictEqual(status.configuredPort, server.listeningPort);

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
        strictEqual(
            tools.tools.some((tool) => tool.name === PATCHWALK_STOP_TOOL_NAME),
            true,
        );
    });

    it('allows daemon status reads without opening extra MCP sessions', async () => {
        const sessionCountBefore = server.activeSessionCount;
        const status = await daemonClient.readStatusResource();

        strictEqual(status.configuredPort, server.listeningPort);
        strictEqual(server.activeSessionCount, sessionCountBefore);
    });

    it('reports worker and active-handoff status through the status resource', async () => {
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
        strictEqual(statusResource.workers[0]?.connectionState, 'connected');
        strictEqual(statusResource.workers[0]?.playbackState, 'idle');
        strictEqual(statusResource.activeHandoff, null);
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

    it('rejects a second playback while one handoff is active and allows stop', async () => {
        const worker = new FakePatchwalkWorker(
            daemonClient,
            ['/tmp/patchwalk-project'],
            'test-extension',
            {
                holdExecutionUntilStopped: true,
            },
        );
        workers.push(worker);
        await worker.start();

        const firstPlayPromise = client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/patchwalk-project'),
        });

        await worker.startedExecution.promise;

        const secondPlayResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/patchwalk-project'),
        });
        const secondContent = secondPlayResult.content as Array<{ type: string; text?: string }>;

        strictEqual(secondPlayResult.isError, true);
        match(secondContent[0]?.text ?? '', /already has an active handoff/);

        const stopResult = await client.callTool({
            name: PATCHWALK_STOP_TOOL_NAME,
            arguments: {},
        });
        const stopContent = stopResult.structuredContent as
            | {
                  status?: string;
                  handoffId?: string;
                  workerId?: string;
              }
            | undefined;

        strictEqual(stopResult.isError ?? false, false);
        strictEqual(stopContent?.status, 'stopped');
        strictEqual(stopContent?.workerId, worker.workerId);

        const firstPlayResult = await firstPlayPromise;
        strictEqual(firstPlayResult.isError, true);

        const statusResource = JSON.parse(
            await readTextResource(client, PATCHWALK_STATUS_RESOURCE_URI),
        ) as PatchwalkStatusResource;
        strictEqual(statusResource.activeHandoff, null);
    });

    it('returns an idle stop result when no handoff is active', async () => {
        const stopResult = await client.callTool({
            name: PATCHWALK_STOP_TOOL_NAME,
            arguments: {},
        });
        const stopContent = stopResult.structuredContent as
            | {
                  status?: string;
              }
            | undefined;

        strictEqual(stopResult.isError ?? false, false);
        strictEqual(stopContent?.status, 'idle');
    });

    it('clears active state when the worker disconnects during stop', async () => {
        const worker = new FakePatchwalkWorker(
            daemonClient,
            ['/tmp/patchwalk-project'],
            'test-extension',
            {
                holdExecutionUntilStopped: true,
                disconnectOnStop: true,
            },
        );
        workers.push(worker);
        await worker.start();

        const firstPlayPromise = client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/patchwalk-project'),
        });

        await worker.startedExecution.promise;

        const stopResult = await client.callTool({
            name: PATCHWALK_STOP_TOOL_NAME,
            arguments: {},
        });
        const stopContent = stopResult.structuredContent as
            | {
                  status?: string;
              }
            | undefined;

        strictEqual(stopResult.isError ?? false, false);
        strictEqual(stopContent?.status, 'stopped');

        const firstPlayResult = await firstPlayPromise;
        strictEqual(firstPlayResult.isError, true);

        const statusResource = JSON.parse(
            await readTextResource(client, PATCHWALK_STATUS_RESOURCE_URI),
        ) as PatchwalkStatusResource;
        strictEqual(statusResource.activeHandoff, null);
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
        match(operatorManual, /exactly one active handoff/);
        match(operatorManual, /patchwalk.stop/);

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
