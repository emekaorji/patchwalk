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
    createPatchwalkExampleHandoff,
    PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI,
    PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
    PATCHWALK_COMPOSE_ONBOARDING_PROMPT_NAME,
    PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
    PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME,
    PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
    PATCHWALK_PLAY_TOOL_NAME,
    PATCHWALK_STATUS_RESOURCE_URI,
    PATCHWALK_STOP_TOOL_NAME,
} from '../src/lib/mcpCatalog';
import { matchBasePathToWorkspaceRoots } from '../src/lib/routing';
import type { PatchwalkHandoffPayload } from '../src/lib/schema';
import { patchwalkHandoffPayloadSchema } from '../src/lib/schema';

interface PatchwalkHealthResponse {
    ok: boolean;
    endpointUrl: string | null;
    daemonPid: number;
    activeSessionCount: number;
    workerCount: number;
    activeDispatchCount: number;
}

interface FakePatchwalkWorkerOptions {
    narrationStyle?: 'terse' | 'grounded';
    holdExecutionUntilStopped?: boolean;
    disconnectOnStop?: boolean;
    /** Simulate a wedged/zombie window: it matches routing but never sends playback.ready. */
    neverReady?: boolean;
}

interface WalkOwnerCapture {
    active: boolean;
    ownerWorkerId?: string;
    revealPath?: string;
}

class FakePatchwalkWorker {
    public readonly workerId = randomUUID();
    public readonly executedPayloads: PatchwalkHandoffPayload[] = [];
    public readonly ownerMessages: WalkOwnerCapture[] = [];
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
            ...(this.options.narrationStyle ? { narrationStyle: this.options.narrationStyle } : {}),
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
            case 'walk.owner':
                this.ownerMessages.push({
                    active: message.active,
                    ownerWorkerId: message.ownerWorkerId,
                    revealPath: message.revealPath,
                });
                return;
        }
    }

    private async handlePrepareMessage(message: {
        dispatchId: string;
        handoffId: string;
        basePath: string;
    }): Promise<void> {
        if (this.options.neverReady) {
            // A wedged window: it received prepare but never positively acks. The daemon must
            // time out and fail over rather than hang.
            return;
        }

        const matchForWorker = matchBasePathToWorkspaceRoots(message.basePath, this.workspaceRoots);
        if (matchForWorker) {
            this.sendMessage({
                type: 'playback.ready',
                messageId: randomUUID(),
                workerId: this.workerId,
                sentAt: new Date().toISOString(),
                dispatchId: message.dispatchId,
                handoffId: message.handoffId,
            });
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
        // Launch ack: the daemon resolves patchwalk.play on this.
        this.sendMessage({
            type: 'playback.started',
            messageId: randomUUID(),
            workerId: this.workerId,
            sentAt: new Date().toISOString(),
            dispatchId: message.dispatchId,
            handoffId: message.payload.handoffId,
            stepCount: message.payload.walkthrough.length + 1,
        });
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

    it('shuts itself down once no editor window is left (it must not outlive the editor)', async function () {
        this.timeout(10_000);
        // A detached daemon that lingers after the editor closes — and survives an uninstall — is
        // exactly what users find running on their machine weeks later.
        let exited = false;
        const idleServer = new PatchwalkMcpServer({
            port: 0,
            idleShutdownMs: 60,
            idleCheckIntervalMs: 20,
            onIdleShutdown: () => {
                exited = true;
            },
        });
        await idleServer.start();
        ok(idleServer.listeningPort, 'the idle server should be listening');

        // No worker ever attaches → it should give up and exit.
        await new Promise((resolve) => setTimeout(resolve, 600));
        strictEqual(exited, true, 'the daemon must exit when it has no editor windows to serve');

        await idleServer.stop().catch(() => {});
    });

    it('stays alive while an editor window is attached', async function () {
        this.timeout(10_000);
        let exited = false;
        const busyServer = new PatchwalkMcpServer({
            port: 0,
            idleShutdownMs: 60,
            idleCheckIntervalMs: 20,
            onIdleShutdown: () => {
                exited = true;
            },
        });
        await busyServer.start();
        const busyClient = new PatchwalkDaemonClient({
            daemonEntryPath: '/unused/in-tests',
            port: busyServer.listeningPort!,
        });
        const attached = new FakePatchwalkWorker(busyClient, ['/tmp/keep-alive']);
        await attached.start();

        await new Promise((resolve) => setTimeout(resolve, 400));
        strictEqual(exited, false, 'a daemon serving a live window must not shut down');

        await attached.stop();
        await busyServer.stop().catch(() => {});
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
            PATCHWALK_COMPOSE_ONBOARDING_PROMPT_NAME,
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

    it('advertises only API-legal property keys on every tool (no `$schema`, no 400)', async () => {
        // Model providers require tool input property keys to match this pattern. A single illegal
        // key (e.g. a leading `$`) makes the provider reject the WHOLE tools list with a 400, which
        // breaks every turn for the user — not just this tool. Guard all tools, not just play.
        const legalKeyPattern = /^[\w.-]{1,64}$/;
        const tools = await client.listTools();

        for (const tool of tools.tools) {
            const properties = (tool.inputSchema as { properties?: Record<string, unknown> })
                .properties;
            for (const key of Object.keys(properties ?? {})) {
                ok(
                    legalKeyPattern.test(key),
                    `tool ${tool.name} advertises an illegal property key: "${key}"`,
                );
            }
        }

        const playTool = tools.tools.find((tool) => tool.name === PATCHWALK_PLAY_TOOL_NAME);
        const playProperties = (playTool?.inputSchema as { properties?: Record<string, unknown> })
            .properties;
        // `$schema` must not be advertised...
        strictEqual('$schema' in (playProperties ?? {}), false);
        // ...but must still be ACCEPTED by the payload validator when an agent sends it.
        const withSchemaPointer = {
            ...createPayload('/tmp/schema-pointer'),
            $schema: 'https://patchwalk.dev/handoff.schema.json',
        };
        strictEqual(patchwalkHandoffPayloadSchema.safeParse(withSchemaPointer).success, true);
    });

    it('publishes the brevity gate to the agent as maxLength in the tool schema', async () => {
        // The strongest gate is the one the model sees WHILE it writes. Guidance alone did not hold.
        const tools = await client.listTools();
        const playTool = tools.tools.find((tool) => tool.name === PATCHWALK_PLAY_TOOL_NAME);
        const properties = (playTool?.inputSchema as { properties?: Record<string, any> })
            .properties;

        strictEqual(properties?.summary?.maxLength, 350);
        const step = properties?.walkthrough?.items?.properties;
        strictEqual(step?.narration?.maxLength, 220);
        strictEqual(step?.title?.maxLength, 60);
        strictEqual(step?.segments?.items?.properties?.narration?.maxLength, 150);
    });

    it('rebuilds the agent contract when a window reports the GROUNDED style', async () => {
        // The style is machine-wide and reaches the daemon over the worker socket. A session opened
        // AFTER the daemon learns it must serve the grounded caps.
        const worker = new FakePatchwalkWorker(
            daemonClient,
            ['/tmp/style-root'],
            'test-extension',
            {
                narrationStyle: 'grounded',
            },
        );
        workers.push(worker);
        await worker.start();

        const styledClient = new Client({ name: 'styled', version: '1.0.0' });
        const styledTransport = new StreamableHTTPClientTransport(new URL(endpointUrl));
        await styledClient.connect(styledTransport);
        try {
            const tools = await styledClient.listTools();
            const playTool = tools.tools.find((tool) => tool.name === PATCHWALK_PLAY_TOOL_NAME);
            const properties = (playTool?.inputSchema as { properties?: Record<string, any> })
                .properties;

            strictEqual(properties?.summary?.maxLength, 700);
            const step = properties?.walkthrough?.items?.properties;
            strictEqual(step?.narration?.maxLength, 500);
            strictEqual(step?.segments?.items?.properties?.narration?.maxLength, 320);
            match(playTool?.description ?? '', /GROUNDED/);

            const guide = await readTextResource(
                styledClient,
                PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI,
            );
            match(guide, /GROUNDED/);
        } finally {
            await Promise.allSettled([styledTransport.terminateSession(), styledTransport.close()]);
        }
    });

    it('ships an example handoff that MODELS high-signal density (not just under the cap)', () => {
        const example = createPatchwalkExampleHandoff();
        // The example is what agents copy, so it must demonstrate the target density.
        ok(example.summary.length <= 120, `example summary is ${example.summary.length} chars`);
        for (const step of example.walkthrough) {
            ok(step.narration.length <= 150, `step narration is ${step.narration.length} chars`);
            for (const segment of step.segments ?? []) {
                ok(
                    segment.narration.length <= 110,
                    `example sub-segment should be 40-110 chars, got ${segment.narration.length}: "${segment.narration}"`,
                );
            }
        }
    });

    it('advertises a fully-typed play tool JSON Schema (nested fields, not degenerate)', async () => {
        // Regression guard for the schema bug: registering with a Zod union/object instead of a
        // ZodRawShape emitted `properties: {}`, which made agent CLIs string-coerce nested fields.
        const tools = await client.listTools();
        const playTool = tools.tools.find((tool) => tool.name === PATCHWALK_PLAY_TOOL_NAME);
        ok(playTool, 'the play tool should be listed');
        const schema = playTool.inputSchema as {
            type?: string;
            properties?: Record<string, { type?: string }>;
            required?: string[];
        };
        strictEqual(schema.type, 'object');
        strictEqual(schema.properties?.walkthrough?.type, 'array');
        strictEqual(schema.properties?.producer?.type, 'object');
        strictEqual(schema.properties?.basePath?.type, 'string');
        ok(schema.required?.includes('walkthrough'), 'walkthrough must be required');
        ok(schema.required?.includes('producer'), 'producer must be required');
        ok(schema.required?.includes('basePath'), 'basePath must be required');
    });

    it('accepts and routes a nested walk that carries sub-segments', async () => {
        const worker = new FakePatchwalkWorker(daemonClient, ['/tmp/segmented-root']);
        workers.push(worker);
        await worker.start();

        const payload = createPayload('/tmp/segmented-root');
        payload.walkthrough[0].segments = [
            {
                id: 'a',
                narration: 'The first beat of the step.',
                range: { startLine: 5, endLine: 8 },
            },
            { narration: 'The second, narrower beat.', range: { startLine: 9, endLine: 12 } },
        ];

        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: payload,
        });

        strictEqual(playResult.isError ?? false, false);
        strictEqual(worker.executedPayloads.length, 1);
        deepStrictEqual(worker.executedPayloads[0]?.walkthrough[0]?.segments?.length, 2);
    });

    it('ships an example handoff that models the sub-segment shape', async () => {
        const example = JSON.parse(
            await readTextResource(client, PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI),
        ) as PatchwalkHandoffPayload;
        const firstStep = example.walkthrough[0];
        ok(firstStep, 'the example should have at least one step');
        ok(
            Array.isArray(firstStep.segments) && firstStep.segments.length > 0,
            'the example step should include a segments array agents can copy',
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
        strictEqual(structuredContent?.status, 'launched');
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

    it('launches, then rejects a second walk while one is active, and allows stop', async () => {
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

        // launch+ack: patchwalk.play returns immediately even though the worker holds the walk open.
        const firstPlayResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/patchwalk-project'),
        });
        strictEqual(firstPlayResult.isError ?? false, false);
        strictEqual((firstPlayResult.structuredContent as { status?: string })?.status, 'launched');
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

        const statusResource = JSON.parse(
            await readTextResource(client, PATCHWALK_STATUS_RESOURCE_URI),
        ) as PatchwalkStatusResource;
        strictEqual(statusResource.activeHandoff, null);
    });

    it('broadcasts walk ownership (with the matched root as reveal path) and clears it on stop', async () => {
        // The playing window's workspace root is a PARENT of the walk basePath, so the reveal path
        // must be the matched ROOT, not the deeper basePath — a stricter assertion than exact match.
        const playing = new FakePatchwalkWorker(
            daemonClient,
            ['/tmp/owner-root'],
            'test-extension',
            { holdExecutionUntilStopped: true },
        );
        const bystander = new FakePatchwalkWorker(daemonClient, ['/tmp/other-root']);
        workers.push(playing, bystander);
        await playing.start();
        await bystander.start();

        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/owner-root/service/deep'),
        });
        strictEqual((playResult.structuredContent as { status?: string })?.status, 'launched');
        await playing.startedExecution.promise;
        await new Promise((resolve) => setTimeout(resolve, 50));

        const latest = bystander.ownerMessages.at(-1);
        ok(latest, 'the bystander should have received a walk.owner broadcast');
        strictEqual(latest.active, true);
        strictEqual(latest.ownerWorkerId, playing.workerId);
        // Distinguishes selectedMatchedRoot from the basePath fallback.
        strictEqual(latest.revealPath, '/tmp/owner-root');

        await client.callTool({ name: PATCHWALK_STOP_TOOL_NAME, arguments: {} });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const afterStop = bystander.ownerMessages.at(-1);
        strictEqual(afterStop?.active, false);
    });

    it('clears walk ownership everywhere when a walk completes naturally', async () => {
        // No holdExecutionUntilStopped → the worker starts then immediately completes, exercising the
        // handlePlaybackCompleted -> clearActiveDispatch -> broadcast(active:false) path.
        const playing = new FakePatchwalkWorker(daemonClient, ['/tmp/complete-root']);
        const bystander = new FakePatchwalkWorker(daemonClient, ['/tmp/other-root']);
        workers.push(playing, bystander);
        await playing.start();
        await bystander.start();

        await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/complete-root'),
        });
        await new Promise((resolve) => setTimeout(resolve, 80));

        // The walk started and finished; the bystander's final view is "nobody is playing".
        const active = bystander.ownerMessages.filter((message) => message.active);
        ok(active.length > 0, 'ownership should have been announced while playing');
        strictEqual(
            bystander.ownerMessages.at(-1)?.active,
            false,
            'ownership should be cleared after natural completion',
        );
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

        const firstPlayResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/patchwalk-project'),
        });
        strictEqual((firstPlayResult.structuredContent as { status?: string })?.status, 'launched');
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
        // The guide is voice-first: it must push spoken, what+why narration, not diff paraphrase.
        match(authoringGuide, /SPOKEN ALOUD/);
        match(authoringGuide, /the what and the WHY/i);
        match(authoringGuide, /never the diff/i);
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

        match(composePrompt.messages[0].content.text, /SPOKEN ALOUD/);
        match(composePrompt.messages[0].content.text, /risk signals/);

        const onboardingPrompt = await client.getPrompt({
            name: PATCHWALK_COMPOSE_ONBOARDING_PROMPT_NAME,
            arguments: { codebasePath: '/tmp/project' },
        });
        if (onboardingPrompt.messages[0]?.content.type !== 'text') {
            throw new Error('Expected text onboarding prompt content.');
        }
        match(onboardingPrompt.messages[0].content.text, /ONBOARDS a newcomer/);
        match(onboardingPrompt.messages[0].content.text, /\/tmp\/project/);
    });

    it('launch+ack returns before the walk completes', async () => {
        const worker = new FakePatchwalkWorker(
            daemonClient,
            ['/tmp/held-project'],
            'test-extension',
            { holdExecutionUntilStopped: true },
        );
        workers.push(worker);
        await worker.start();

        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/held-project'),
        });
        const content = playResult.structuredContent as
            | { status?: string; walkId?: string; workerId?: string; steps?: number }
            | undefined;

        strictEqual(playResult.isError ?? false, false);
        strictEqual(content?.status, 'launched');
        strictEqual(content?.workerId, worker.workerId);
        ok((content?.walkId?.length ?? 0) > 0, 'launched result should carry a walkId');
        strictEqual(content?.steps, 2); // one summary segment + one walkthrough step

        await worker.startedExecution.promise;
        const statusResource = JSON.parse(
            await readTextResource(client, PATCHWALK_STATUS_RESOURCE_URI),
        ) as PatchwalkStatusResource;
        ok(statusResource.activeHandoff, 'the walk should still be active after launch');
    });

    it('fails over to the next window when the top candidate never becomes ready', async function () {
        this.timeout(10_000);
        const wedged = new FakePatchwalkWorker(
            daemonClient,
            ['/tmp/failover-root'],
            'test-extension',
            { neverReady: true },
        );
        const healthy = new FakePatchwalkWorker(
            daemonClient,
            ['/tmp/failover-root'],
            'test-extension',
        );
        workers.push(wedged, healthy);
        await wedged.start(); // earliest registration → ranked first, but never acks
        await healthy.start();

        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/failover-root/project'),
        });
        const content = playResult.structuredContent as
            | { status?: string; workerId?: string }
            | undefined;

        strictEqual(playResult.isError ?? false, false);
        strictEqual(content?.status, 'launched');
        strictEqual(content?.workerId, healthy.workerId);
        strictEqual(wedged.executedPayloads.length, 0);
        strictEqual(healthy.executedPayloads.length, 1);
    });

    it('a single wedged window fails fast instead of hanging (P3 guard)', async function () {
        this.timeout(10_000);
        const wedged = new FakePatchwalkWorker(
            daemonClient,
            ['/tmp/zombie-root'],
            'test-extension',
            { neverReady: true },
        );
        workers.push(wedged);
        await wedged.start();

        const startedAt = Date.now();
        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: createPayload('/tmp/zombie-root'),
        });
        const elapsedMs = Date.now() - startedAt;

        strictEqual(playResult.isError, true);
        strictEqual(wedged.executedPayloads.length, 0);
        ok(elapsedMs < 8_000, `expected a fast failover, but it took ${elapsedMs}ms`);
    });
});
