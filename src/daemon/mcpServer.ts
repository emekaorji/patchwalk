import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import process from 'node:process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';

import type {
    PatchwalkDaemonToWorkerMessage,
    PatchwalkPlaybackFailedMessage,
    PatchwalkPlaybackState,
    PatchwalkWorkerHeartbeatMessage,
    PatchwalkWorkerRegisterMessage,
    PatchwalkWorkerUpdateMessage,
} from '../lib/controlProtocol';
import {
    PATCHWALK_DEFAULT_PREPARE_TIMEOUT_MS,
    PATCHWALK_DEFAULT_STOP_TIMEOUT_MS,
    PATCHWALK_WORKER_SOCKET_PATH,
    patchwalkWorkerToDaemonMessageSchema,
} from '../lib/controlProtocol';
import * as logger from '../lib/logger';
import type {
    PatchwalkActiveHandoffStatusResource,
    PatchwalkDispatchStatusResource,
    PatchwalkStatusResource,
    PatchwalkStopResult,
    PatchwalkWorkerStatusResource,
} from '../lib/mcpCatalog';
import {
    createPatchwalkAuthoringGuide,
    createPatchwalkComposePromptText,
    createPatchwalkExampleHandoff,
    createPatchwalkExpandWalkthroughPromptText,
    createPatchwalkOperatorManual,
    normalizePatchwalkPlayPayload,
    PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI,
    PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
    PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
    PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME,
    PATCHWALK_MCP_SERVER_INFO,
    PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
    PATCHWALK_PLAY_TOOL_NAME,
    PATCHWALK_STATUS_RESOURCE_URI,
    PATCHWALK_STOP_TOOL_NAME,
    patchwalkPlayArgumentsSchema,
    patchwalkPlayResultSchema,
    patchwalkStopResultSchema,
} from '../lib/mcpCatalog';
import { normalizeAbsolutePath } from '../lib/pathUtils';
import type { PatchwalkWorkerRoutingCandidate } from '../lib/routing';
import { compareWorkerRoutingCandidates, matchBasePathToWorkspaceRoots } from '../lib/routing';
import type { PatchwalkHandoffPayload } from '../lib/schema';

interface PatchwalkMcpServerOptions {
    port: number;
}

interface JsonRpcErrorResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    error: {
        code: number;
        message: string;
    };
}

interface PatchwalkMcpSession {
    id: string;
    createdAt: string;
    requestCount: number;
    disposed: boolean;
    server: McpServer;
    transport: StreamableHTTPServerTransport;
}

interface RegisteredWorker {
    workerId: string;
    processId: number;
    extensionVersion: string;
    workspaceRoots: string[];
    registeredAt: string;
    registeredSequence: number;
    lastSeenAt: string;
    connectionState: 'connected';
    playbackState: PatchwalkPlaybackState;
    activeHandoffId: string | null;
    socket: WebSocket;
}

interface DispatchExecutionResult {
    workerId: string;
    matchedRoot: string;
    handoffId: string;
    stepsPlayed: number;
}

interface ActiveDispatch {
    dispatchId: string;
    payload: PatchwalkHandoffPayload;
    createdAt: string;
    state: 'preparing' | 'executing' | 'stopping';
    selectedWorkerId?: string;
    selectedMatchedRoot?: string;
    resultPromise: Promise<DispatchExecutionResult>;
    resolveResult: (value: DispatchExecutionResult) => void;
    rejectResult: (error: Error) => void;
    prepareFailureReject?: (error: Error) => void;
    stopAcknowledgeResolve?: () => void;
    stopAcknowledgeReject?: (error: Error) => void;
}

const HEALTH_PATH = '/health';
const STATUS_PATH = '/status';
const MCP_PATH = '/mcp';
const DAEMON_SHUTDOWN_PATH = '/daemon/shutdown';
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const STALE_WORKER_TIMEOUT_MS = 20_000;
const EXECUTION_TIMEOUT_MS = 5 * 60_000;

const createJsonRpcErrorResponse = (
    code: number,
    message: string,
    id: number | string | null = null,
): JsonRpcErrorResponse => {
    return {
        jsonrpc: '2.0',
        id,
        error: {
            code,
            message,
        },
    };
};

const getRequestUrl = (request: IncomingMessage): URL => {
    return new URL(request.url ?? '/', 'http://127.0.0.1');
};

const getRequestPath = (request: IncomingMessage): string => {
    return getRequestUrl(request).pathname;
};

const getSessionId = (request: IncomingMessage): string | undefined => {
    const headerValue = request.headers['mcp-session-id'];
    return typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : undefined;
};

const createStoppedError = (): Error => {
    const error = new Error('Patchwalk playback was stopped.');
    error.name = 'PatchwalkPlaybackStoppedError';
    return error;
};

const createTimeoutError = (message: string): Error => {
    const timeoutError = new Error(message);
    timeoutError.name = 'TimeoutError';
    return timeoutError;
};

const withTimeout = async <T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
): Promise<T> => {
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
        setTimeout(() => {
            reject(createTimeoutError(message));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
};

const patchwalkComposePromptArgsSchema = {
    changeSummary: z.string().describe('High-level summary of the change.'),
    changedFiles: z
        .string()
        .optional()
        .describe('Optional newline-separated changed files or modules.'),
    focusAreas: z
        .string()
        .optional()
        .describe('Optional implementation details that deserve deeper narration.'),
};

const patchwalkExpandWalkthroughPromptArgsSchema = {
    summary: z.string().describe('Short summary of the change or feature.'),
    files: z.string().describe('Relevant files, one per line or as grouped bullets.'),
    detailLevel: z
        .string()
        .optional()
        .describe('Optional detail preference such as concise, detailed, or exhaustive.'),
};

const normalizeWorkspaceRoots = async (workspaceRoots: string[]): Promise<string[]> => {
    const normalizedRoots = await Promise.all(
        workspaceRoots.map((workspaceRoot) => normalizeAbsolutePath(workspaceRoot)),
    );
    return [...new Set(normalizedRoots)].sort((leftRoot, rightRoot) =>
        leftRoot.localeCompare(rightRoot),
    );
};

export class PatchwalkMcpServer {
    private server: Server | undefined;
    private workerSocketServer: WebSocketServer | undefined;
    private readonly sessions = new Map<string, PatchwalkMcpSession>();
    private readonly workers = new Map<string, RegisteredWorker>();
    private workerSequence = 0;
    private startedAt: string | null = null;
    private activeDispatch: ActiveDispatch | undefined;

    public constructor(private readonly options: PatchwalkMcpServerOptions) {}

    public get endpointUrl(): string | undefined {
        const port = this.listeningPort;
        if (port === undefined) {
            return undefined;
        }

        return `http://127.0.0.1:${port}${MCP_PATH}`;
    }

    public get listeningPort(): number | undefined {
        const address = this.server?.address();
        if (!address || typeof address === 'string') {
            return undefined;
        }

        return (address as AddressInfo).port;
    }

    public get activeSessionCount(): number {
        return this.sessions.size;
    }

    public async start(): Promise<void> {
        if (this.server) {
            logger.info('Patchwalk daemon start skipped because the server is already running.');
            return;
        }

        this.workerSocketServer = new WebSocketServer({
            noServer: true,
        });

        this.server = createServer(async (request, response) => {
            await this.handleHttpRequestSafely(request, response);
        });

        this.server.on('upgrade', (request, socket, head) => {
            if (
                getRequestPath(request) !== PATCHWALK_WORKER_SOCKET_PATH ||
                !this.workerSocketServer
            ) {
                socket.destroy();
                return;
            }

            this.workerSocketServer.handleUpgrade(
                request,
                socket,
                head,
                (workerSocket: WebSocket) => {
                    this.handleWorkerSocket(workerSocket);
                },
            );
        });

        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
                this.server?.off('error', onError);
                reject(error);
            };

            this.server!.once('error', onError);
            this.server!.listen(this.options.port, '127.0.0.1', () => {
                this.server?.off('error', onError);
                resolve();
            });
        });

        this.startedAt = new Date().toISOString();
        logger.info('Patchwalk daemon server started.', {
            listeningPort: this.listeningPort ?? this.options.port,
            endpointUrl: this.endpointUrl ?? null,
        });
    }

    public async stop(): Promise<void> {
        logger.info('Patchwalk daemon server shutdown started.');
        const sessionIds = [...this.sessions.keys()];
        await Promise.allSettled(sessionIds.map((sessionId) => this.disposeSession(sessionId)));

        if (this.activeDispatch) {
            this.activeDispatch.rejectResult(
                new Error('Patchwalk daemon stopped before the dispatch completed.'),
            );
            this.activeDispatch = undefined;
        }

        for (const worker of this.workers.values()) {
            worker.socket.close();
        }
        this.workers.clear();

        this.workerSocketServer?.close();
        this.workerSocketServer = undefined;

        if (!this.server) {
            this.startedAt = null;
            logger.info('Patchwalk daemon stop skipped because no HTTP server was active.');
            return;
        }

        await new Promise<void>((resolve, reject) => {
            this.server!.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });

        this.server = undefined;
        this.startedAt = null;
        logger.info('Patchwalk daemon server shutdown finished.');
    }

    private async handleHttpRequestSafely(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const method = request.method ?? 'UNKNOWN';
        const requestPath = getRequestPath(request);
        const requestStartedAt = Date.now();
        const isOauthDiscoveryPath =
            requestPath === '/.well-known/oauth-authorization-server/mcp' ||
            requestPath === '/mcp/.well-known/oauth-authorization-server' ||
            requestPath === '/.well-known/oauth-authorization-server';
        const shouldLogRequest =
            requestPath !== HEALTH_PATH &&
            requestPath !== STATUS_PATH &&
            requestPath !== MCP_PATH &&
            !isOauthDiscoveryPath;

        if (shouldLogRequest) {
            logger.info('Incoming daemon HTTP request.', {
                method,
                path: requestPath,
            });
            response.once('finish', () => {
                logger.info('Completed daemon HTTP request.', {
                    method,
                    path: requestPath,
                    statusCode: response.statusCode,
                    durationMs: Date.now() - requestStartedAt,
                });
            });
        }

        try {
            await this.handleHttpRequest(request, response);
        } catch (error) {
            if (!response.headersSent) {
                this.writeJsonResponse(
                    response,
                    500,
                    createJsonRpcErrorResponse(-32603, 'Internal server error'),
                );
                return;
            }

            if (!response.writableEnded) {
                response.end();
            }

            if (error instanceof Error) {
                logger.error('Unhandled daemon HTTP request failure.', {
                    method,
                    path: requestPath,
                    error: error.stack ?? error.message,
                });
                console.error(error);
            }
        }
    }

    private async handleHttpRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        this.pruneStaleWorkers();

        const requestPath = getRequestPath(request);

        if (request.method === 'GET' && requestPath === HEALTH_PATH) {
            this.writeJsonResponse(response, 200, {
                ok: true,
                serverKind: 'patchwalk-daemon',
                apiVersion: '1.0.0',
                workerTransport: 'websocket',
                workerSocketPath: PATCHWALK_WORKER_SOCKET_PATH,
                endpointUrl: this.endpointUrl ?? null,
                daemonPid: process.pid,
                activeSessionCount: this.activeSessionCount,
                workerCount: this.workers.size,
                activeDispatchCount: this.activeDispatch ? 1 : 0,
            });
            return;
        }

        if (request.method === 'GET' && requestPath === STATUS_PATH) {
            this.writeJsonResponse(response, 200, this.createStatusResource());
            return;
        }

        if (request.method === 'POST' && requestPath === DAEMON_SHUTDOWN_PATH) {
            logger.info('Received daemon shutdown HTTP request.');
            this.writeJsonResponse(response, 202, {
                ok: true,
                message: 'Patchwalk daemon shutdown requested.',
            });

            setImmediate(() => {
                this.stop().catch((error: unknown) => {
                    logger.error('Daemon shutdown endpoint failed to stop the server.', error);
                    console.error(error);
                });
            });
            return;
        }

        if (requestPath === MCP_PATH) {
            await this.handleMcpRequest(request, response);
            return;
        }

        this.writeJsonResponse(response, 404, { error: 'Not found' });
    }

    private async handleMcpRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        switch (request.method) {
            case 'POST':
                await this.handlePostRequest(request, response);
                return;
            case 'GET':
            case 'DELETE':
                await this.handleSessionBoundRequest(request, response);
                return;
            default:
                response.setHeader('Allow', 'GET, POST, DELETE');
                this.writeJsonResponse(
                    response,
                    405,
                    createJsonRpcErrorResponse(-32000, 'Method not allowed.'),
                );
                return;
        }
    }

    private async handlePostRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        let parsedBody: unknown;
        try {
            parsedBody = await this.readJsonBody(request);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'Request body could not be parsed.';
            logger.warn('Rejected MCP POST request because JSON parsing failed.', {
                reason: message,
            });
            this.writeJsonResponse(
                response,
                400,
                createJsonRpcErrorResponse(-32700, `Parse error: ${message}`),
            );
            return;
        }

        const sessionId = getSessionId(request);
        if (sessionId) {
            const session = this.sessions.get(sessionId);
            if (!session) {
                this.writeJsonResponse(
                    response,
                    400,
                    createJsonRpcErrorResponse(-32000, 'Bad Request: No valid session ID provided'),
                );
                return;
            }

            session.requestCount += 1;
            await this.forwardToTransport(session, request, response, parsedBody);
            return;
        }

        if (!isInitializeRequest(parsedBody)) {
            this.writeJsonResponse(
                response,
                400,
                createJsonRpcErrorResponse(-32000, 'Bad Request: No valid session ID provided'),
            );
            return;
        }

        const session = await this.createSession();
        session.requestCount += 1;
        await this.forwardToTransport(session, request, response, parsedBody);

        if (!session.id) {
            await this.disposeOrphanedSession(session);
        }
    }

    private async handleSessionBoundRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const sessionId = getSessionId(request);
        if (!sessionId) {
            this.writeJsonResponse(
                response,
                400,
                createJsonRpcErrorResponse(-32000, 'Bad Request: No valid session ID provided'),
            );
            return;
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
            this.writeJsonResponse(
                response,
                400,
                createJsonRpcErrorResponse(-32000, 'Bad Request: No valid session ID provided'),
            );
            return;
        }

        session.requestCount += 1;
        await this.forwardToTransport(session, request, response);
    }

    private async forwardToTransport(
        session: PatchwalkMcpSession,
        request: IncomingMessage,
        response: ServerResponse,
        parsedBody?: unknown,
    ): Promise<void> {
        try {
            await session.transport.handleRequest(request, response, parsedBody);
        } catch {
            logger.error('MCP transport failed to handle a request.', {
                sessionId: session.id || null,
                method: request.method ?? 'UNKNOWN',
                path: getRequestPath(request),
            });
            if (!response.headersSent) {
                this.writeJsonResponse(
                    response,
                    500,
                    createJsonRpcErrorResponse(-32603, 'Internal server error'),
                );
            }
        }
    }

    private async createSession(): Promise<PatchwalkMcpSession> {
        const sessionRef: {
            current: PatchwalkMcpSession | undefined;
        } = {
            current: undefined,
        };

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                if (!sessionRef.current) {
                    return;
                }

                sessionRef.current.id = sessionId;
                this.sessions.set(sessionId, sessionRef.current);
                logger.info('MCP session initialized.', {
                    sessionId,
                    activeSessionCount: this.sessions.size,
                });
            },
            onsessionclosed: (sessionId) => {
                logger.info('MCP session closed by transport.', { sessionId });
                return this.disposeSession(sessionId);
            },
        });

        const server = this.createMcpServer(() => sessionRef.current);
        await server.connect(transport);

        const session: PatchwalkMcpSession = {
            id: '',
            createdAt: new Date().toISOString(),
            requestCount: 0,
            disposed: false,
            server,
            transport,
        };
        sessionRef.current = session;
        logger.info('MCP session created and awaiting initialize handshake.');

        return session;
    }

    private createMcpServer(getSession: () => PatchwalkMcpSession | undefined): McpServer {
        const server = new McpServer(PATCHWALK_MCP_SERVER_INFO, {
            capabilities: {
                logging: {},
            },
            instructions: this.createServerInstructions(),
        });

        server.registerResource(
            'patchwalk-status',
            PATCHWALK_STATUS_RESOURCE_URI,
            {
                title: 'Patchwalk Server Status',
                description: 'Runtime information for the local Patchwalk daemon.',
                mimeType: 'application/json',
            },
            async () => {
                return {
                    contents: [
                        {
                            uri: PATCHWALK_STATUS_RESOURCE_URI,
                            mimeType: 'application/json',
                            text: `${JSON.stringify(this.createStatusResource(), null, 2)}\n`,
                        },
                    ],
                };
            },
        );

        server.registerResource(
            'patchwalk-operator-manual',
            PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
            {
                title: 'Patchwalk Operator Manual',
                description:
                    'Operational guidance for tools, prompts, resources, daemon recovery, and routing.',
                mimeType: 'text/markdown',
            },
            async () => {
                return {
                    contents: [
                        {
                            uri: PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
                            mimeType: 'text/markdown',
                            text: `${createPatchwalkOperatorManual(this.endpointUrl ?? MCP_PATH)}\n`,
                        },
                    ],
                };
            },
        );

        server.registerResource(
            'patchwalk-example-handoff',
            PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
            {
                title: 'Patchwalk Example Handoff',
                description: 'A valid example Patchwalk handoff payload.',
                mimeType: 'application/json',
            },
            async () => {
                return {
                    contents: [
                        {
                            uri: PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
                            mimeType: 'application/json',
                            text: `${JSON.stringify(createPatchwalkExampleHandoff(), null, 2)}\n`,
                        },
                    ],
                };
            },
        );

        server.registerResource(
            'patchwalk-authoring-guide',
            PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI,
            {
                title: 'Patchwalk Handoff Authoring Guide',
                description: 'Developer-grade guidance for constructing useful Patchwalk payloads.',
                mimeType: 'text/markdown',
            },
            async () => {
                return {
                    contents: [
                        {
                            uri: PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI,
                            mimeType: 'text/markdown',
                            text: `${createPatchwalkAuthoringGuide()}\n`,
                        },
                    ],
                };
            },
        );

        server.registerPrompt(
            PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
            {
                title: 'Compose Patchwalk Handoff',
                description:
                    'Draft a developer-grade Patchwalk handoff with semantic explanation, risk analysis, blast radius, and meaningful before-vs-after behavior.',
                argsSchema: patchwalkComposePromptArgsSchema,
            },
            async (args) => {
                return {
                    messages: [
                        {
                            role: 'user' as const,
                            content: {
                                type: 'text' as const,
                                text: createPatchwalkComposePromptText(args),
                            },
                        },
                    ],
                };
            },
        );

        server.registerPrompt(
            PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME,
            {
                title: 'Expand Patchwalk Walkthrough',
                description:
                    'Turn a change summary and file list into a strong engineer-facing walkthrough with intent, consequences, and reviewer-significant signals.',
                argsSchema: patchwalkExpandWalkthroughPromptArgsSchema,
            },
            async (args) => {
                return {
                    messages: [
                        {
                            role: 'user' as const,
                            content: {
                                type: 'text' as const,
                                text: createPatchwalkExpandWalkthroughPromptText(args),
                            },
                        },
                    ],
                };
            },
        );

        server.registerTool(
            PATCHWALK_PLAY_TOOL_NAME,
            {
                title: 'Patchwalk Playback',
                description:
                    'Route a Patchwalk handoff to the best matching live editor window and play it there. Rejects immediately when another Patchwalk narration is already active anywhere on the machine.',
                inputSchema: patchwalkPlayArgumentsSchema,
                outputSchema: patchwalkPlayResultSchema,
                annotations: {
                    openWorldHint: false,
                    readOnlyHint: false,
                },
            },
            async (argumentsValue, extra) => {
                const payload = await this.normalizePayload(
                    normalizePatchwalkPlayPayload(argumentsValue),
                );
                const session = getSession();

                logger.info('MCP tool call started playback routing.', {
                    handoffId: payload.handoffId,
                    basePath: payload.basePath,
                    sessionId: extra.sessionId ?? null,
                });

                try {
                    const dispatchResult = await this.dispatchPlayback(payload);
                    await server.sendLoggingMessage(
                        {
                            level: 'info',
                            data: `Completed Patchwalk playback for ${payload.handoffId} via worker ${dispatchResult.workerId}`,
                        },
                        extra.sessionId,
                    );

                    return {
                        structuredContent: {
                            handoffId: payload.handoffId,
                            status: 'completed' as const,
                            stepsPlayed: dispatchResult.stepsPlayed,
                            workerId: dispatchResult.workerId,
                            matchedRoot: dispatchResult.matchedRoot,
                        },
                        content: [
                            {
                                type: 'text' as const,
                                text: `Patchwalk playback completed for ${payload.handoffId}.`,
                            },
                            {
                                type: 'text' as const,
                                text: session
                                    ? `Session ${session.id} handled ${session.requestCount} MCP request(s).`
                                    : `Worker ${dispatchResult.workerId} handled the playback.`,
                            },
                        ],
                    };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.error('MCP tool call failed during playback routing.', {
                        handoffId: payload.handoffId,
                        sessionId: extra.sessionId ?? null,
                        error: message,
                    });

                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text' as const,
                                text: `Patchwalk playback failed for ${payload.handoffId}: ${message}`,
                            },
                        ],
                    };
                }
            },
        );

        server.registerTool(
            PATCHWALK_STOP_TOOL_NAME,
            {
                title: 'Stop Patchwalk Playback',
                description:
                    'Stop the single active Patchwalk narration running anywhere on the local machine.',
                inputSchema: {},
                outputSchema: patchwalkStopResultSchema,
                annotations: {
                    openWorldHint: false,
                    readOnlyHint: false,
                },
            },
            async (_argumentsValue, extra) => {
                try {
                    const stopResult = await this.stopActivePlayback();
                    return {
                        structuredContent: patchwalkStopResultSchema.parse(stopResult),
                        content: [
                            {
                                type: 'text' as const,
                                text:
                                    stopResult.status === 'idle'
                                        ? 'Patchwalk was already idle.'
                                        : `Stopped Patchwalk playback for ${stopResult.handoffId}.`,
                            },
                        ],
                    };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.error('MCP stop tool failed.', {
                        sessionId: extra.sessionId ?? null,
                        error: message,
                    });
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text' as const,
                                text: `Patchwalk stop failed: ${message}`,
                            },
                        ],
                    };
                }
            },
        );

        return server;
    }

    private createServerInstructions(): string {
        return [
            'Patchwalk replays narrated code handoffs inside live editor windows.',
            `Read ${PATCHWALK_STATUS_RESOURCE_URI} for daemon, worker, and active handoff status.`,
            `Read ${PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI} for a valid payload example.`,
            `Read ${PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI} before generating payloads for non-trivial changes.`,
            `Use ${PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME} or ${PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME} to draft handoff content.`,
            `Call ${PATCHWALK_PLAY_TOOL_NAME} with a Patchwalk handoff payload that includes basePath and meaningful developer-facing narration.`,
            `Call ${PATCHWALK_STOP_TOOL_NAME} to stop the one active Patchwalk narration.`,
        ].join(' ');
    }

    private createStatusResource(): PatchwalkStatusResource {
        const endpointUrl = this.endpointUrl ?? MCP_PATH;
        const workers: PatchwalkWorkerStatusResource[] = [...this.workers.values()].map(
            (worker) => ({
                workerId: worker.workerId,
                processId: worker.processId,
                extensionVersion: worker.extensionVersion,
                workspaceRoots: worker.workspaceRoots,
                registeredAt: worker.registeredAt,
                lastSeenAt: worker.lastSeenAt,
                connectionState: worker.connectionState,
                playbackState: worker.playbackState,
                activeHandoffId: worker.activeHandoffId,
            }),
        );

        const activeDispatches: PatchwalkDispatchStatusResource[] = this.activeDispatch
            ? [
                  {
                      dispatchId: this.activeDispatch.dispatchId,
                      handoffId: this.activeDispatch.payload.handoffId,
                      basePath: this.activeDispatch.payload.basePath,
                      state: this.activeDispatch.state,
                      createdAt: this.activeDispatch.createdAt,
                      selectedWorkerId: this.activeDispatch.selectedWorkerId,
                  },
              ]
            : [];

        return {
            endpointUrl,
            healthUrl: endpointUrl.replace(/\/mcp$/, '/health'),
            startedAt: this.startedAt,
            daemonPid: process.pid,
            configuredPort: this.listeningPort ?? this.options.port,
            activeSessionCount: this.activeSessionCount,
            workerCount: workers.length,
            workers,
            activeDispatchCount: activeDispatches.length,
            activeDispatches,
            activeHandoff: this.createActiveHandoffStatusResource(),
            prompts: [
                PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
                PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME,
            ],
            resources: [
                PATCHWALK_STATUS_RESOURCE_URI,
                PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
                PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
                PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI,
            ],
            tools: [PATCHWALK_PLAY_TOOL_NAME, PATCHWALK_STOP_TOOL_NAME],
        };
    }

    private createActiveHandoffStatusResource(): PatchwalkActiveHandoffStatusResource | null {
        if (this.activeDispatch) {
            return {
                dispatchId: this.activeDispatch.dispatchId,
                handoffId: this.activeDispatch.payload.handoffId,
                basePath: this.activeDispatch.payload.basePath,
                workerId: this.activeDispatch.selectedWorkerId ?? null,
                state: this.activeDispatch.state,
                source: 'daemon-dispatch',
            };
        }

        const activeWorker = [...this.workers.values()].find(
            (worker) => worker.playbackState !== 'idle',
        );
        if (!activeWorker) {
            return null;
        }

        return {
            dispatchId: null,
            handoffId: activeWorker.activeHandoffId,
            basePath: null,
            workerId: activeWorker.workerId,
            state: activeWorker.playbackState === 'playing' ? 'playing' : 'stopping',
            source: 'worker-state',
        };
    }

    private handleWorkerSocket(socket: WebSocket): void {
        socket.on('message', (rawData: WebSocket.RawData) => {
            this.handleWorkerMessage(socket, rawData).catch((error: unknown) => {
                logger.error('Worker socket message handling failed.', error);
                socket.close();
            });
        });

        socket.on('close', () => {
            this.handleWorkerDisconnect(socket);
        });

        socket.on('error', (error: Error) => {
            logger.error('Worker WebSocket emitted an error.', error);
        });
    }

    private async handleWorkerMessage(
        socket: WebSocket,
        rawData: WebSocket.RawData,
    ): Promise<void> {
        let parsedValue: unknown;
        try {
            parsedValue = JSON.parse(String(rawData));
        } catch {
            socket.close();
            return;
        }

        const parsedMessage = patchwalkWorkerToDaemonMessageSchema.safeParse(parsedValue);
        if (!parsedMessage.success) {
            logger.warn('Worker message rejected because the payload was invalid.', {
                reason: parsedMessage.error.issues[0]?.message ?? 'Invalid worker socket payload.',
            });
            socket.close();
            return;
        }

        const message = parsedMessage.data;
        switch (message.type) {
            case 'worker.register':
                await this.handleWorkerRegister(socket, message);
                return;
            case 'worker.update':
                await this.handleWorkerUpdate(message);
                return;
            case 'worker.heartbeat':
                this.handleWorkerHeartbeat(message);
                return;
            case 'playback.completed':
                this.handlePlaybackCompleted(message);
                return;
            case 'playback.failed':
                this.handlePlaybackFailed(message);
                return;
            case 'playback.stopped':
                this.handlePlaybackStopped(message);
                return;
        }
    }

    private async handleWorkerRegister(
        socket: WebSocket,
        message: PatchwalkWorkerRegisterMessage,
    ): Promise<void> {
        const workspaceRoots = await normalizeWorkspaceRoots(message.workspaceRoots);
        const existingWorker = this.workers.get(message.workerId);

        if (existingWorker && existingWorker.socket !== socket) {
            existingWorker.socket.close();
        }

        const registeredWorker: RegisteredWorker = existingWorker
            ? {
                  ...existingWorker,
                  processId: message.processId,
                  extensionVersion: message.extensionVersion,
                  workspaceRoots,
                  lastSeenAt: message.lastSeenAt,
                  connectionState: 'connected',
                  playbackState: message.playbackState,
                  activeHandoffId: message.activeHandoffId ?? null,
                  socket,
              }
            : {
                  workerId: message.workerId,
                  processId: message.processId,
                  extensionVersion: message.extensionVersion,
                  workspaceRoots,
                  registeredAt: new Date().toISOString(),
                  registeredSequence: ++this.workerSequence,
                  lastSeenAt: message.lastSeenAt,
                  connectionState: 'connected',
                  playbackState: message.playbackState,
                  activeHandoffId: message.activeHandoffId ?? null,
                  socket,
              };

        this.workers.set(message.workerId, registeredWorker);
        logger.info('Worker registration accepted.', {
            workerId: registeredWorker.workerId,
            processId: registeredWorker.processId,
            workspaceRootCount: registeredWorker.workspaceRoots.length,
            playbackState: registeredWorker.playbackState,
        });
    }

    private async handleWorkerUpdate(message: PatchwalkWorkerUpdateMessage): Promise<void> {
        const worker = this.workers.get(message.workerId);
        if (!worker) {
            return;
        }

        worker.workspaceRoots = await normalizeWorkspaceRoots(message.workspaceRoots);
        worker.lastSeenAt = message.lastSeenAt;
        worker.playbackState = message.playbackState;
        worker.activeHandoffId = message.activeHandoffId ?? null;
    }

    private handleWorkerHeartbeat(message: PatchwalkWorkerHeartbeatMessage): void {
        const worker = this.workers.get(message.workerId);
        if (!worker) {
            return;
        }

        worker.lastSeenAt = message.lastSeenAt;
        worker.playbackState = message.playbackState;
        worker.activeHandoffId = message.activeHandoffId ?? null;
    }

    private handlePlaybackCompleted(message: {
        dispatchId: string;
        handoffId: string;
        stepsPlayed: number;
        workerId: string;
    }): void {
        const worker = this.workers.get(message.workerId);
        if (worker) {
            worker.playbackState = 'idle';
            worker.activeHandoffId = null;
        }

        if (
            !this.activeDispatch ||
            this.activeDispatch.dispatchId !== message.dispatchId ||
            this.activeDispatch.selectedWorkerId !== message.workerId
        ) {
            return;
        }

        logger.info('Worker reported completed playback.', {
            workerId: message.workerId,
            dispatchId: message.dispatchId,
            handoffId: message.handoffId,
            stepsPlayed: message.stepsPlayed,
        });

        this.activeDispatch.resolveResult({
            workerId: message.workerId,
            matchedRoot:
                this.activeDispatch.selectedMatchedRoot ?? this.activeDispatch.payload.basePath,
            handoffId: message.handoffId,
            stepsPlayed: message.stepsPlayed,
        });
    }

    private handlePlaybackFailed(message: PatchwalkPlaybackFailedMessage): void {
        const worker = this.workers.get(message.workerId);
        if (worker && message.phase !== 'prepare') {
            worker.playbackState = 'idle';
            worker.activeHandoffId = null;
        }

        if (
            !this.activeDispatch ||
            this.activeDispatch.dispatchId !== message.dispatchId ||
            this.activeDispatch.selectedWorkerId !== message.workerId
        ) {
            return;
        }

        if (message.phase === 'prepare') {
            this.activeDispatch.prepareFailureReject?.(new Error(message.error));
            return;
        }

        if (message.phase === 'stop') {
            this.activeDispatch.stopAcknowledgeReject?.(new Error(message.error));
            return;
        }

        logger.error('Worker reported failed playback.', {
            workerId: message.workerId,
            dispatchId: message.dispatchId,
            handoffId: message.handoffId,
            error: message.error,
        });
        this.activeDispatch.rejectResult(new Error(message.error));
    }

    private handlePlaybackStopped(message: {
        dispatchId: string;
        handoffId: string;
        workerId: string;
    }): void {
        const worker = this.workers.get(message.workerId);
        if (worker) {
            worker.playbackState = 'idle';
            worker.activeHandoffId = null;
        }

        if (
            !this.activeDispatch ||
            this.activeDispatch.dispatchId !== message.dispatchId ||
            this.activeDispatch.selectedWorkerId !== message.workerId
        ) {
            return;
        }

        this.activeDispatch.rejectResult(createStoppedError());
        this.activeDispatch.stopAcknowledgeResolve?.();
    }

    private handleWorkerDisconnect(socket: WebSocket): void {
        const worker = [...this.workers.values()].find((candidate) => candidate.socket === socket);
        if (!worker) {
            return;
        }

        this.workers.delete(worker.workerId);
        logger.info('Worker removed from daemon registry.', {
            workerId: worker.workerId,
            remainingWorkerCount: this.workers.size,
        });

        if (
            this.activeDispatch &&
            this.activeDispatch.selectedWorkerId === worker.workerId &&
            this.activeDispatch.state === 'preparing'
        ) {
            this.activeDispatch.prepareFailureReject?.(
                new Error(`Worker ${worker.workerId} disconnected before execution started.`),
            );
        }

        if (
            this.activeDispatch &&
            this.activeDispatch.selectedWorkerId === worker.workerId &&
            this.activeDispatch.state === 'stopping'
        ) {
            this.activeDispatch.rejectResult(createStoppedError());
            this.activeDispatch.stopAcknowledgeResolve?.();
        }

        if (
            this.activeDispatch &&
            this.activeDispatch.selectedWorkerId === worker.workerId &&
            this.activeDispatch.state === 'executing'
        ) {
            this.activeDispatch.rejectResult(
                new Error(`Worker ${worker.workerId} disconnected during playback.`),
            );
        }
    }

    private async dispatchPlayback(
        payload: PatchwalkHandoffPayload,
    ): Promise<DispatchExecutionResult> {
        this.pruneStaleWorkers();

        if (this.hasAnyActiveHandoff()) {
            throw new Error(
                'Patchwalk already has an active handoff on this machine. Stop it before starting another one.',
            );
        }

        const rankedCandidates = this.rankWorkersForBasePath(payload.basePath);
        if (rankedCandidates.length === 0) {
            throw new Error(
                `No live Patchwalk window matched the requested basePath: ${payload.basePath}`,
            );
        }

        const resultState = {} as {
            resolve?: (value: DispatchExecutionResult) => void;
            reject?: (error: Error) => void;
        };
        const resultPromise = new Promise<DispatchExecutionResult>((resolve, reject) => {
            resultState.resolve = resolve;
            resultState.reject = reject;
        });

        const dispatch: ActiveDispatch = {
            dispatchId: randomUUID(),
            payload,
            createdAt: new Date().toISOString(),
            state: 'preparing',
            resultPromise,
            resolveResult: resultState.resolve!,
            rejectResult: resultState.reject!,
        };
        this.activeDispatch = dispatch;
        logger.info('Dispatch created for playback request.', {
            dispatchId: dispatch.dispatchId,
            handoffId: payload.handoffId,
            basePath: payload.basePath,
            registeredWorkerCount: this.workers.size,
        });

        try {
            return await this.tryDispatchCandidate(dispatch, rankedCandidates, 0);
        } finally {
            if (this.activeDispatch?.dispatchId === dispatch.dispatchId) {
                this.activeDispatch = undefined;
                logger.info('Dispatch removed from active registry.', {
                    dispatchId: dispatch.dispatchId,
                    remainingActiveDispatches: this.activeDispatch ? 1 : 0,
                });
            }
        }
    }

    private async tryDispatchCandidate(
        dispatch: ActiveDispatch,
        rankedCandidates: PatchwalkWorkerRoutingCandidate[],
        index: number,
    ): Promise<DispatchExecutionResult> {
        const candidate = rankedCandidates[index];
        if (!candidate) {
            throw new Error(
                `No live Patchwalk window matched the requested basePath: ${dispatch.payload.basePath}`,
            );
        }

        const selectedWorker = this.workers.get(candidate.workerId);
        if (!selectedWorker || selectedWorker.socket.readyState !== WebSocket.OPEN) {
            return this.tryDispatchCandidate(dispatch, rankedCandidates, index + 1);
        }

        dispatch.selectedWorkerId = candidate.workerId;
        dispatch.selectedMatchedRoot = candidate.matchedRoot;
        dispatch.state = 'preparing';
        selectedWorker.activeHandoffId = dispatch.payload.handoffId;

        this.sendWorkerMessage(candidate.workerId, {
            type: 'playback.prepare',
            messageId: randomUUID(),
            workerId: candidate.workerId,
            sentAt: new Date().toISOString(),
            dispatchId: dispatch.dispatchId,
            handoffId: dispatch.payload.handoffId,
            basePath: dispatch.payload.basePath,
        });

        try {
            await this.waitForPrepareWindow(dispatch, candidate.workerId);
        } catch (error) {
            selectedWorker.activeHandoffId = null;
            logger.warn('Worker rejected or lost prepare phase.', {
                workerId: candidate.workerId,
                dispatchId: dispatch.dispatchId,
                error: error instanceof Error ? error.message : String(error),
            });
            return this.tryDispatchCandidate(dispatch, rankedCandidates, index + 1);
        }

        dispatch.state = 'executing';
        selectedWorker.playbackState = 'playing';
        selectedWorker.activeHandoffId = dispatch.payload.handoffId;

        this.sendWorkerMessage(candidate.workerId, {
            type: 'playback.execute',
            messageId: randomUUID(),
            workerId: candidate.workerId,
            sentAt: new Date().toISOString(),
            dispatchId: dispatch.dispatchId,
            payload: dispatch.payload,
        });

        return withTimeout(
            dispatch.resultPromise,
            EXECUTION_TIMEOUT_MS,
            `Worker ${candidate.workerId} did not complete playback in time.`,
        );
    }

    private async stopActivePlayback(): Promise<PatchwalkStopResult> {
        const activeDispatch = this.activeDispatch;
        if (!activeDispatch) {
            return {
                status: 'idle',
            };
        }

        if (!activeDispatch.selectedWorkerId) {
            activeDispatch.rejectResult(createStoppedError());
            this.activeDispatch = undefined;
            return {
                status: 'stopped',
                handoffId: activeDispatch.payload.handoffId,
            };
        }

        const worker = this.workers.get(activeDispatch.selectedWorkerId);
        if (!worker) {
            activeDispatch.rejectResult(createStoppedError());
            this.activeDispatch = undefined;
            return {
                status: 'stopped',
                handoffId: activeDispatch.payload.handoffId,
                workerId: activeDispatch.selectedWorkerId,
            };
        }

        activeDispatch.state = 'stopping';
        const stopAcknowledged = new Promise<void>((resolve, reject) => {
            activeDispatch.stopAcknowledgeResolve = resolve;
            activeDispatch.stopAcknowledgeReject = reject;
        });

        this.sendWorkerMessage(worker.workerId, {
            type: 'playback.stop',
            messageId: randomUUID(),
            workerId: worker.workerId,
            sentAt: new Date().toISOString(),
            dispatchId: activeDispatch.dispatchId,
            handoffId: activeDispatch.payload.handoffId,
            reason: 'Patchwalk stop tool requested cancellation.',
        });

        await withTimeout(
            stopAcknowledged,
            PATCHWALK_DEFAULT_STOP_TIMEOUT_MS,
            `Worker ${worker.workerId} did not acknowledge stop in time.`,
        );

        if (this.activeDispatch?.dispatchId === activeDispatch.dispatchId) {
            this.activeDispatch = undefined;
        }

        return {
            status: 'stopped',
            handoffId: activeDispatch.payload.handoffId,
            workerId: worker.workerId,
        };
    }

    private rankWorkersForBasePath(basePath: string): PatchwalkWorkerRoutingCandidate[] {
        return [...this.workers.values()]
            .filter((worker) => worker.connectionState === 'connected')
            .map((worker) => {
                const match = matchBasePathToWorkspaceRoots(basePath, worker.workspaceRoots);
                if (!match) {
                    return null;
                }

                return {
                    workerId: worker.workerId,
                    matchedRoot: match.matchedRoot,
                    matchKind: match.matchKind,
                    registeredSequence: worker.registeredSequence,
                } satisfies PatchwalkWorkerRoutingCandidate;
            })
            .filter((candidate): candidate is PatchwalkWorkerRoutingCandidate => candidate !== null)
            .sort(compareWorkerRoutingCandidates);
    }

    private sendWorkerMessage(workerId: string, message: PatchwalkDaemonToWorkerMessage): void {
        const worker = this.workers.get(workerId);
        if (!worker || worker.socket.readyState !== WebSocket.OPEN) {
            throw new Error(`Worker ${workerId} is not connected.`);
        }

        worker.socket.send(JSON.stringify(message));
    }

    private async waitForPrepareWindow(dispatch: ActiveDispatch, workerId: string): Promise<void> {
        try {
            await Promise.race([
                new Promise<void>((_resolve, reject) => {
                    dispatch.prepareFailureReject = reject;
                }),
                new Promise<void>((resolve) => {
                    setTimeout(resolve, PATCHWALK_DEFAULT_PREPARE_TIMEOUT_MS);
                }),
            ]);
        } finally {
            dispatch.prepareFailureReject = undefined;
        }

        if (dispatch.selectedWorkerId !== workerId) {
            throw new Error(`Worker ${workerId} lost prepare ownership.`);
        }
    }

    private hasAnyActiveHandoff(): boolean {
        if (this.activeDispatch) {
            return true;
        }

        return [...this.workers.values()].some((worker) => worker.playbackState !== 'idle');
    }

    private pruneStaleWorkers(): void {
        const now = Date.now();
        for (const worker of this.workers.values()) {
            const ageMs = now - new Date(worker.lastSeenAt).getTime();
            if (ageMs > STALE_WORKER_TIMEOUT_MS) {
                logger.warn('Pruning stale worker from daemon registry.', {
                    workerId: worker.workerId,
                    ageMs,
                });
                worker.socket.close();
                this.workers.delete(worker.workerId);
            }
        }
    }

    private async normalizePayload(
        payload: PatchwalkHandoffPayload,
    ): Promise<PatchwalkHandoffPayload> {
        return {
            ...payload,
            basePath: await normalizeAbsolutePath(payload.basePath),
        };
    }

    private async disposeSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session || session.disposed) {
            return;
        }

        session.disposed = true;
        this.sessions.delete(sessionId);
        await Promise.allSettled([session.server.close(), session.transport.close()]);
        logger.info('MCP session resources disposed.', {
            sessionId,
            activeSessionCount: this.sessions.size,
        });
    }

    private async disposeOrphanedSession(session: PatchwalkMcpSession): Promise<void> {
        if (session.disposed) {
            return;
        }

        session.disposed = true;
        await Promise.allSettled([session.server.close(), session.transport.close()]);
        logger.warn('Disposed orphaned MCP session before session id assignment.');
    }

    private async readJsonBody(request: IncomingMessage): Promise<unknown> {
        const bodyChunks: Uint8Array[] = [];
        let bodyLength = 0;

        for await (const chunk of request) {
            const chunkBytes =
                typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
            bodyLength += chunkBytes.byteLength;

            if (bodyLength > MAX_REQUEST_BODY_BYTES) {
                throw new Error('Request body exceeded the maximum supported size.');
            }

            bodyChunks.push(chunkBytes);
        }

        if (bodyChunks.length === 0) {
            return {};
        }

        const bodyText = Buffer.concat(bodyChunks).toString('utf8').trim();
        if (!bodyText) {
            return {};
        }

        return JSON.parse(bodyText) as unknown;
    }

    private writeJsonResponse(
        response: ServerResponse,
        statusCode: number,
        payload: unknown,
    ): void {
        response.statusCode = statusCode;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(payload));
    }
}
