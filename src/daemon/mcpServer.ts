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
    PatchwalkPlaybackProgressMessage,
    PatchwalkPlaybackReadyMessage,
    PatchwalkPlaybackStartedMessage,
    PatchwalkPlaybackState,
    PatchwalkWalkOwnerMessage,
    PatchwalkWorkerHeartbeatMessage,
    PatchwalkWorkerRegisterMessage,
    PatchwalkWorkerUpdateMessage,
} from '../lib/controlProtocol';
import {
    PATCHWALK_DEFAULT_READY_TIMEOUT_MS,
    PATCHWALK_DEFAULT_STOP_TIMEOUT_MS,
    PATCHWALK_WORKER_SOCKET_PATH,
    patchwalkWorkerToDaemonMessageSchema,
} from '../lib/controlProtocol';
import * as logger from '../lib/logger';
import type {
    PatchwalkActiveHandoffStatusResource,
    PatchwalkDispatchStatusResource,
    PatchwalkStatusResource,
    PatchwalkStatusResult,
    PatchwalkStopResult,
    PatchwalkWorkerStatusResource,
} from '../lib/mcpCatalog';
import {
    createPatchwalkAuthoringGuide,
    createPatchwalkComposePromptText,
    createPatchwalkExampleHandoff,
    createPatchwalkExpandWalkthroughPromptText,
    createPatchwalkOnboardingPromptText,
    createPatchwalkOperatorManual,
    createPatchwalkPlayInputShape,
    createPatchwalkPlayPayloadSchema,
    createPatchwalkPlayToolDescription,
    PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI,
    PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
    PATCHWALK_COMPOSE_ONBOARDING_PROMPT_NAME,
    PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
    PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME,
    PATCHWALK_MCP_SERVER_INFO,
    PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
    PATCHWALK_PLAY_TOOL_NAME,
    PATCHWALK_STATUS_RESOURCE_URI,
    PATCHWALK_STATUS_TOOL_NAME,
    PATCHWALK_STOP_TOOL_NAME,
    patchwalkPlayResultShape,
    patchwalkStatusResultShape,
    patchwalkStopResultSchema,
    patchwalkStopResultShape,
} from '../lib/mcpCatalog';
import { normalizeAbsolutePath } from '../lib/pathUtils';
import type { PatchwalkWorkerRoutingCandidate } from '../lib/routing';
import { compareWorkerRoutingCandidates, matchBasePathToWorkspaceRoots } from '../lib/routing';
import type { PatchwalkHandoffPayload, PatchwalkNarrationStyle } from '../lib/schema';
import { formatPatchwalkValidationIssues, PATCHWALK_DEFAULT_NARRATION_STYLE } from '../lib/schema';

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

interface DispatchLaunchResult {
    workerId: string;
    matchedRoot: string;
    walkId: string;
    stepCount: number;
}

interface ActiveDispatch {
    dispatchId: string;
    walkId: string;
    payload: PatchwalkHandoffPayload;
    createdAt: string;
    state: 'preparing' | 'executing' | 'playing' | 'stopping';
    selectedWorkerId?: string;
    selectedMatchedRoot?: string;
    stepCount?: number;
    currentStepIndex?: number;
    /** Transient per-attempt handshake resolvers (positive acks replace silence-means-success). */
    readyResolve?: () => void;
    readyReject?: (error: Error) => void;
    startedResolve?: (stepCount: number) => void;
    startedReject?: (error: Error) => void;
    stopAcknowledgeResolve?: () => void;
    stopAcknowledgeReject?: (error: Error) => void;
}

const HEALTH_PATH = '/health';
const STATUS_PATH = '/status';
const MCP_PATH = '/mcp';
const DAEMON_SHUTDOWN_PATH = '/daemon/shutdown';
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const STALE_WORKER_TIMEOUT_MS = 20_000;

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

const patchwalkOnboardingPromptArgsSchema = {
    codebasePath: z
        .string()
        .describe('Absolute path to the codebase root; used as the walk basePath.'),
    area: z.string().optional().describe('Optional subsystem or area to focus the onboarding on.'),
    depth: z
        .string()
        .optional()
        .describe('Optional depth, e.g. "quick tour" or "in-depth guided walk".'),
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
    /**
     * The narration style the daemon hands to authoring agents. It is MACHINE-WIDE (the VS Code
     * setting is `scope: "application"`, so every window reports the same value) and reaches the
     * daemon over the worker socket. New MCP sessions pick up the current style; a session already
     * open keeps the tool schema it was created with, so an agent sees a consistent contract.
     */
    private narrationStyle: PatchwalkNarrationStyle = PATCHWALK_DEFAULT_NARRATION_STYLE;

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
            const shutdownError = new Error('Patchwalk daemon stopped before the walk completed.');
            this.activeDispatch.readyReject?.(shutdownError);
            this.activeDispatch.startedReject?.(shutdownError);
            this.activeDispatch.stopAcknowledgeReject?.(shutdownError);
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
        // The tool contract is built from the style ACTIVE WHEN THE SESSION IS CREATED, so an agent
        // always sees a self-consistent schema + description + guide + prompts for one connection.
        const sessionStyle = this.narrationStyle;

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
                            text: `${JSON.stringify(createPatchwalkExampleHandoff(sessionStyle), null, 2)}\n`,
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
                            text: `${createPatchwalkAuthoringGuide(sessionStyle)}\n`,
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
                                text: createPatchwalkComposePromptText(args, sessionStyle),
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
                                text: createPatchwalkExpandWalkthroughPromptText(
                                    args,
                                    sessionStyle,
                                ),
                            },
                        },
                    ],
                };
            },
        );

        server.registerPrompt(
            PATCHWALK_COMPOSE_ONBOARDING_PROMPT_NAME,
            {
                title: 'Compose Patchwalk Onboarding Walk',
                description:
                    'Draft a spoken Patchwalk walk that onboards a newcomer to a whole codebase (or an area) — architecture, entrypoints, core modules, data flow, and conventions — the WHAT and the WHY, written to be heard.',
                argsSchema: patchwalkOnboardingPromptArgsSchema,
            },
            async (args) => {
                return {
                    messages: [
                        {
                            role: 'user' as const,
                            content: {
                                type: 'text' as const,
                                text: createPatchwalkOnboardingPromptText(args, sessionStyle),
                            },
                        },
                    ],
                };
            },
        );

        server.registerTool(
            PATCHWALK_PLAY_TOOL_NAME,
            {
                title: 'Patchwalk Play Walk',
                description: createPatchwalkPlayToolDescription(sessionStyle),
                inputSchema: createPatchwalkPlayInputShape(sessionStyle),
                outputSchema: patchwalkPlayResultShape,
                annotations: {
                    openWorldHint: false,
                    readOnlyHint: false,
                },
            },
            async (argumentsValue, extra) => {
                // Validate against the ACTIVE STYLE's walk schema so a malformed or over-long payload
                // gets a clear, actionable message instead of a cryptic transport error.
                const validation =
                    createPatchwalkPlayPayloadSchema(sessionStyle).safeParse(argumentsValue);
                if (!validation.success) {
                    // Report EVERY problem at once. Surfacing them one at a time turns a strict
                    // schema into a guessing game and makes the tool feel like a fight.
                    const problems = formatPatchwalkValidationIssues(validation.error);
                    const listed = problems.slice(0, 25);
                    const remaining = problems.length - listed.length;
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text' as const,
                                text: [
                                    `Patchwalk rejected this walk (${problems.length} problem${
                                        problems.length === 1 ? '' : 's'
                                    }). Fix ALL of them in one pass, then call ${PATCHWALK_PLAY_TOOL_NAME} again:`,
                                    '',
                                    ...listed.map((problem) => `- ${problem}`),
                                    ...(remaining > 0 ? [`- ...and ${remaining} more.`] : []),
                                    '',
                                    'Length limits are a hard gate, not a suggestion: the walk is SPOKEN ALOUD to a human who cannot skim it. Cut to the signal — what changed, why, what it risks — and delete filler, hedging, and anything that restates the code.',
                                    'See patchwalk://handoff/authoring-guide and patchwalk://handoff/example.',
                                ].join('\n'),
                            },
                        ],
                    };
                }
                const payload = await this.normalizePayload(validation.data);
                const session = getSession();

                logger.info('MCP tool call requested a walk launch.', {
                    handoffId: payload.handoffId,
                    basePath: payload.basePath,
                    sessionId: extra.sessionId ?? null,
                });

                try {
                    // Launch + ack (P2): resolve as soon as the window has STARTED the walk, never
                    // when it finishes. The developer drives the running walk from the sidebar.
                    const launch = await this.dispatchPlayback(payload);
                    await server.sendLoggingMessage(
                        {
                            level: 'info',
                            data: `Launched Patchwalk walk ${payload.handoffId} in worker ${launch.workerId}`,
                        },
                        extra.sessionId,
                    );

                    return {
                        structuredContent: {
                            status: 'launched' as const,
                            walkId: launch.walkId,
                            handoffId: payload.handoffId,
                            workerId: launch.workerId,
                            matchedRoot: launch.matchedRoot,
                            steps: launch.stepCount,
                        },
                        content: [
                            {
                                type: 'text' as const,
                                text: `Patchwalk launched the walk for ${payload.handoffId} in window ${launch.workerId} (${launch.stepCount} segments). The developer drives it from the Patchwalk sidebar; call ${PATCHWALK_STATUS_TOOL_NAME} to check progress or ${PATCHWALK_STOP_TOOL_NAME} to end it.`,
                            },
                            ...(session
                                ? [
                                      {
                                          type: 'text' as const,
                                          text: `MCP session ${session.id} · ${session.requestCount} request(s).`,
                                      },
                                  ]
                                : []),
                        ],
                    };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.error('MCP tool call failed to launch a walk.', {
                        handoffId: payload.handoffId,
                        sessionId: extra.sessionId ?? null,
                        error: message,
                    });

                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text' as const,
                                text: `Patchwalk could not launch the walk for ${payload.handoffId}: ${message}`,
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
                outputSchema: patchwalkStopResultShape,
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

        server.registerTool(
            PATCHWALK_STATUS_TOOL_NAME,
            {
                title: 'Patchwalk Walk Status',
                description:
                    'Report the single active Patchwalk walk on this machine — window, step index/total, and state — or that nothing is playing.',
                inputSchema: {},
                outputSchema: patchwalkStatusResultShape,
                annotations: {
                    openWorldHint: false,
                    readOnlyHint: true,
                },
            },
            async () => {
                const status = this.createStatusToolResult();
                return {
                    structuredContent: status,
                    content: [
                        {
                            type: 'text' as const,
                            text: status.active
                                ? `Patchwalk is playing walk ${
                                      status.handoffId ?? '(unknown)'
                                  } in worker ${status.workerId ?? '(unknown)'} — segment ${
                                      (status.stepIndex ?? 0) + 1
                                  }/${status.stepCount ?? '?'} (${status.state ?? 'playing'}).`
                                : 'No active Patchwalk walk.',
                        },
                    ],
                };
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
            `Use ${PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME} or ${PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME} to draft a change walk, or ${PATCHWALK_COMPOSE_ONBOARDING_PROMPT_NAME} to draft a whole-codebase onboarding walk.`,
            `Call ${PATCHWALK_PLAY_TOOL_NAME} with a Patchwalk handoff payload that includes basePath and meaningful developer-facing narration.`,
            `Call ${PATCHWALK_STOP_TOOL_NAME} to stop the one active Patchwalk narration.`,
            `Call ${PATCHWALK_STATUS_TOOL_NAME} to check the active walk's window, progress, and state.`,
            `${PATCHWALK_PLAY_TOOL_NAME} returns as soon as the walk is launched; it does not block until narration finishes.`,
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
                PATCHWALK_COMPOSE_ONBOARDING_PROMPT_NAME,
            ],
            resources: [
                PATCHWALK_STATUS_RESOURCE_URI,
                PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
                PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
                PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI,
            ],
            tools: [PATCHWALK_PLAY_TOOL_NAME, PATCHWALK_STOP_TOOL_NAME, PATCHWALK_STATUS_TOOL_NAME],
        };
    }

    private createStatusToolResult(): PatchwalkStatusResult {
        const active = this.createActiveHandoffStatusResource();
        if (!active) {
            return { active: false };
        }
        return {
            active: true,
            walkId: this.activeDispatch?.walkId,
            handoffId: active.handoffId ?? undefined,
            workerId: active.workerId ?? undefined,
            state: active.state,
            stepIndex: this.activeDispatch?.currentStepIndex,
            stepCount: this.activeDispatch?.stepCount,
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
            case 'playback.ready':
                this.handlePlaybackReady(message);
                return;
            case 'playback.started':
                this.handlePlaybackStarted(message);
                return;
            case 'playback.progress':
                this.handlePlaybackProgress(message);
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
            case 'playback.paused':
            case 'playback.resumed':
                // Pause/resume are reported to the daemon via playback.progress state; these
                // explicit acks are reserved for future use and need no dispatch action today.
                return;
        }
    }

    private async handleWorkerRegister(
        socket: WebSocket,
        message: PatchwalkWorkerRegisterMessage,
    ): Promise<void> {
        const workspaceRoots = await normalizeWorkspaceRoots(message.workspaceRoots);
        const existingWorker = this.workers.get(message.workerId);
        this.applyNarrationStyle(message.narrationStyle);

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

        // A window that connects mid-walk still learns which window is currently playing.
        this.trySendWorkerMessage(
            registeredWorker.workerId,
            this.buildWalkOwnerMessage(registeredWorker.workerId),
        );
    }

    /**
     * Adopt the machine-wide narration style reported by a window. Sessions opened AFTER this point
     * get the new tool schema, description, guide and prompts; sessions already open keep the
     * contract they were created with, so an agent never sees the rules change mid-connection.
     */
    private applyNarrationStyle(style: PatchwalkNarrationStyle | undefined): void {
        if (!style || style === this.narrationStyle) {
            return;
        }
        logger.info('Narration style changed.', { from: this.narrationStyle, to: style });
        this.narrationStyle = style;
    }

    private async handleWorkerUpdate(message: PatchwalkWorkerUpdateMessage): Promise<void> {
        const worker = this.workers.get(message.workerId);
        this.applyNarrationStyle(message.narrationStyle);
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

    private isForActiveDispatch(dispatchId: string, workerId: string): boolean {
        return (
            this.activeDispatch !== undefined &&
            this.activeDispatch.dispatchId === dispatchId &&
            this.activeDispatch.selectedWorkerId === workerId
        );
    }

    private clearActiveDispatch(dispatchId: string): void {
        if (this.activeDispatch?.dispatchId === dispatchId) {
            this.activeDispatch = undefined;
            // The machine-wide walk ended; tell every window to drop its "playing" signal.
            this.broadcastWalkOwner();
        }
    }

    private handlePlaybackReady(message: PatchwalkPlaybackReadyMessage): void {
        if (this.isForActiveDispatch(message.dispatchId, message.workerId)) {
            this.activeDispatch?.readyResolve?.();
        }
    }

    private handlePlaybackStarted(message: PatchwalkPlaybackStartedMessage): void {
        const worker = this.workers.get(message.workerId);
        if (worker) {
            worker.playbackState = 'playing';
            worker.activeHandoffId = message.handoffId;
        }

        if (this.isForActiveDispatch(message.dispatchId, message.workerId) && this.activeDispatch) {
            this.activeDispatch.state = 'playing';
            this.activeDispatch.stepCount = message.stepCount;
            this.activeDispatch.currentStepIndex = 0;
            this.activeDispatch.startedResolve?.(message.stepCount);
            // Tell every window which one is now playing (Problem 4: which-window signal).
            this.broadcastWalkOwner();
        }
    }

    private handlePlaybackProgress(message: PatchwalkPlaybackProgressMessage): void {
        const worker = this.workers.get(message.workerId);
        if (worker) {
            worker.playbackState = message.playbackState;
            worker.activeHandoffId = message.playbackState === 'idle' ? null : message.handoffId;
        }

        if (this.isForActiveDispatch(message.dispatchId, message.workerId) && this.activeDispatch) {
            this.activeDispatch.currentStepIndex = message.stepIndex;
            this.activeDispatch.stepCount = message.stepCount;
        }
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

        if (!this.isForActiveDispatch(message.dispatchId, message.workerId)) {
            return;
        }

        logger.info('Worker reported completed walk.', {
            workerId: message.workerId,
            dispatchId: message.dispatchId,
            handoffId: message.handoffId,
            stepsPlayed: message.stepsPlayed,
        });
        this.clearActiveDispatch(message.dispatchId);
    }

    private handlePlaybackFailed(message: PatchwalkPlaybackFailedMessage): void {
        const worker = this.workers.get(message.workerId);
        if (worker && message.phase !== 'prepare') {
            worker.playbackState = 'idle';
            worker.activeHandoffId = null;
        }

        if (!this.isForActiveDispatch(message.dispatchId, message.workerId)) {
            return;
        }
        const dispatch = this.activeDispatch;
        if (!dispatch) {
            return;
        }

        if (message.phase === 'prepare') {
            // Negative prepare ack → the dispatch fails over to the next ranked window.
            dispatch.readyReject?.(new Error(message.error));
            return;
        }

        if (message.phase === 'stop') {
            dispatch.stopAcknowledgeReject?.(new Error(message.error));
            return;
        }

        // Execute-phase failure. If it happens before the launch ack, unblock the launch as a
        // hard failure (we already committed this window, so we do NOT silently retry another).
        if (dispatch.startedReject) {
            dispatch.startedReject(new Error(message.error));
        }
        logger.error('Worker reported failed walk.', {
            workerId: message.workerId,
            dispatchId: message.dispatchId,
            handoffId: message.handoffId,
            error: message.error,
        });
        this.clearActiveDispatch(message.dispatchId);
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

        if (!this.isForActiveDispatch(message.dispatchId, message.workerId)) {
            return;
        }

        this.activeDispatch?.stopAcknowledgeResolve?.();
        this.clearActiveDispatch(message.dispatchId);
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

        this.teardownDispatchForLostWorker(worker.workerId);
    }

    /**
     * Release the active dispatch (and any pending handshake) when the window it was dispatched to
     * is gone. Shared by the socket-close path and the stale-worker prune so a window that vanishes
     * WITHOUT a clean close event (hang / half-open socket / sleep-wake) can never wedge the
     * machine-wide walk lock or leave every other window's "playing elsewhere" badge stuck.
     */
    private teardownDispatchForLostWorker(workerId: string): void {
        const dispatch = this.activeDispatch;
        if (!dispatch || dispatch.selectedWorkerId !== workerId) {
            return;
        }

        if (dispatch.state === 'preparing') {
            // Failover to the next candidate: the prepare handshake never completed.
            dispatch.readyReject?.(
                new Error(`Worker ${workerId} disconnected before it became ready.`),
            );
            return;
        }

        if (dispatch.state === 'executing') {
            dispatch.startedReject?.(
                new Error(`Worker ${workerId} disconnected before starting the walk.`),
            );
            this.clearActiveDispatch(dispatch.dispatchId);
            return;
        }

        if (dispatch.state === 'stopping') {
            dispatch.stopAcknowledgeResolve?.();
            this.clearActiveDispatch(dispatch.dispatchId);
            return;
        }

        // 'playing': the walk was lost with its window; release the machine-wide lock + badges.
        this.clearActiveDispatch(dispatch.dispatchId);
    }

    private async dispatchPlayback(
        payload: PatchwalkHandoffPayload,
    ): Promise<DispatchLaunchResult> {
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

        const dispatch: ActiveDispatch = {
            dispatchId: randomUUID(),
            walkId: randomUUID(),
            payload,
            createdAt: new Date().toISOString(),
            state: 'preparing',
        };
        this.activeDispatch = dispatch;
        logger.info('Dispatch created for walk launch.', {
            dispatchId: dispatch.dispatchId,
            walkId: dispatch.walkId,
            handoffId: payload.handoffId,
            basePath: payload.basePath,
            registeredWorkerCount: this.workers.size,
        });

        try {
            // Resolves once a window has STARTED the walk. The dispatch intentionally stays active
            // afterwards so later completed/stopped messages release the machine-wide lock; we only
            // clear it here when the launch itself fails (no window could start the walk).
            return await this.tryDispatchCandidate(dispatch, rankedCandidates, 0);
        } catch (error) {
            this.clearActiveDispatch(dispatch.dispatchId);
            throw error;
        }
    }

    private async tryDispatchCandidate(
        dispatch: ActiveDispatch,
        rankedCandidates: PatchwalkWorkerRoutingCandidate[],
        index: number,
    ): Promise<DispatchLaunchResult> {
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
            // P3: proceed only on a POSITIVE ready ack. A window that is wedged, busy, or gone
            // cannot silently swallow the walk — the timeout/failure fails over to the next one.
            await this.waitForReady(dispatch, candidate.workerId);
        } catch (error) {
            logger.warn('Worker was not ready; failing over to the next candidate.', {
                workerId: candidate.workerId,
                dispatchId: dispatch.dispatchId,
                error: error instanceof Error ? error.message : String(error),
            });
            return this.tryDispatchCandidate(dispatch, rankedCandidates, index + 1);
        }

        dispatch.state = 'executing';
        this.sendWorkerMessage(candidate.workerId, {
            type: 'playback.execute',
            messageId: randomUUID(),
            workerId: candidate.workerId,
            sentAt: new Date().toISOString(),
            dispatchId: dispatch.dispatchId,
            payload: dispatch.payload,
        });

        // Once execute is sent we are committed to this window: a missing start ack is a hard
        // failure, not a failover (failing over could make two windows play the same walk).
        const stepCount = await this.waitForStarted(dispatch, candidate.workerId);

        dispatch.state = 'playing';
        return {
            workerId: candidate.workerId,
            matchedRoot: candidate.matchedRoot,
            walkId: dispatch.walkId,
            stepCount,
        };
    }

    private async stopActivePlayback(): Promise<PatchwalkStopResult> {
        const dispatch = this.activeDispatch;
        if (!dispatch) {
            // No dispatch, but a window may still be PLAYING (e.g. its socket blipped and the
            // dispatch was released while local playback continued). Stop it by worker state so the
            // stop tool never falsely reports idle while a walk is audibly running.
            return this.stopPlayingWorkerWithoutDispatch();
        }

        if (!dispatch.selectedWorkerId) {
            this.clearActiveDispatch(dispatch.dispatchId);
            return { status: 'stopped', handoffId: dispatch.payload.handoffId };
        }

        const worker = this.workers.get(dispatch.selectedWorkerId);
        if (!worker) {
            this.clearActiveDispatch(dispatch.dispatchId);
            return {
                status: 'stopped',
                handoffId: dispatch.payload.handoffId,
                workerId: dispatch.selectedWorkerId,
            };
        }

        dispatch.state = 'stopping';
        const stopAcknowledged = new Promise<void>((resolve, reject) => {
            dispatch.stopAcknowledgeResolve = resolve;
            dispatch.stopAcknowledgeReject = reject;
        });

        this.sendWorkerMessage(worker.workerId, {
            type: 'playback.stop',
            messageId: randomUUID(),
            workerId: worker.workerId,
            sentAt: new Date().toISOString(),
            dispatchId: dispatch.dispatchId,
            handoffId: dispatch.payload.handoffId,
            reason: 'Patchwalk stop tool requested cancellation.',
        });

        await withTimeout(
            stopAcknowledged,
            PATCHWALK_DEFAULT_STOP_TIMEOUT_MS,
            `Worker ${worker.workerId} did not acknowledge stop in time.`,
        );

        this.clearActiveDispatch(dispatch.dispatchId);
        return {
            status: 'stopped',
            handoffId: dispatch.payload.handoffId,
            workerId: worker.workerId,
        };
    }

    /**
     * Last-resort stop when the daemon has no tracked dispatch but a window still reports playing
     * (e.g. its socket blipped mid-walk and the dispatch was released while local playback
     * continued). Sends the stop directly to that window's runner so the stop tool is never a
     * silent no-op.
     */
    private stopPlayingWorkerWithoutDispatch(): PatchwalkStopResult {
        const playingWorker = [...this.workers.values()].find(
            (worker) => worker.playbackState !== 'idle',
        );
        if (!playingWorker) {
            return { status: 'idle' };
        }

        const handoffId = playingWorker.activeHandoffId ?? undefined;
        try {
            this.sendWorkerMessage(playingWorker.workerId, {
                type: 'playback.stop',
                messageId: randomUUID(),
                workerId: playingWorker.workerId,
                sentAt: new Date().toISOString(),
                dispatchId: randomUUID(),
                handoffId: handoffId ?? 'unknown-handoff',
                reason: 'Patchwalk stop tool requested cancellation (no active dispatch).',
            });
        } catch {
            // The socket is already gone, so the walk is unreachable; report it stopped anyway.
        }
        playingWorker.playbackState = 'idle';
        playingWorker.activeHandoffId = null;
        this.broadcastWalkOwner();
        return {
            status: 'stopped',
            workerId: playingWorker.workerId,
            ...(handoffId ? { handoffId } : {}),
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

    /** Best-effort send that silently skips a closed socket (used for owner broadcasts). */
    private trySendWorkerMessage(workerId: string, message: PatchwalkDaemonToWorkerMessage): void {
        const worker = this.workers.get(workerId);
        if (!worker || worker.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        worker.socket.send(JSON.stringify(message));
    }

    private buildWalkOwnerMessage(workerId: string): PatchwalkWalkOwnerMessage {
        const dispatch = this.activeDispatch;
        // A walk "owns" a window only once it is actually PLAYING. Broadcasts fire on the started
        // transition, so gating on 'playing' keeps a mid-prepare register message consistent with
        // what already-connected windows were told (they get nothing until 'started').
        const active = Boolean(
            dispatch && dispatch.state === 'playing' && dispatch.selectedWorkerId,
        );
        return {
            type: 'walk.owner',
            messageId: randomUUID(),
            workerId,
            sentAt: new Date().toISOString(),
            active,
            ...(active && dispatch
                ? {
                      ownerWorkerId: dispatch.selectedWorkerId,
                      handoffId: dispatch.payload.handoffId,
                      revealPath: dispatch.selectedMatchedRoot ?? dispatch.payload.basePath,
                  }
                : {}),
        };
    }

    /** Tell every connected window which window currently owns the active walk (or that none does). */
    private broadcastWalkOwner(): void {
        for (const workerId of this.workers.keys()) {
            this.trySendWorkerMessage(workerId, this.buildWalkOwnerMessage(workerId));
        }
    }

    private waitForReady(dispatch: ActiveDispatch, workerId: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // cleanup() has to clear a timer that does not exist yet, so the handle lives in a box.
            const timeout: { handle?: NodeJS.Timeout } = {};
            const cleanup = (): void => {
                clearTimeout(timeout.handle);
                dispatch.readyResolve = undefined;
                dispatch.readyReject = undefined;
            };
            timeout.handle = setTimeout(() => {
                cleanup();
                reject(createTimeoutError(`Worker ${workerId} did not become ready in time.`));
            }, PATCHWALK_DEFAULT_READY_TIMEOUT_MS);
            dispatch.readyResolve = () => {
                cleanup();
                resolve();
            };
            dispatch.readyReject = (error: Error) => {
                cleanup();
                reject(error);
            };
        });
    }

    private waitForStarted(dispatch: ActiveDispatch, workerId: string): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            // cleanup() has to clear a timer that does not exist yet, so the handle lives in a box.
            const timeout: { handle?: NodeJS.Timeout } = {};
            const cleanup = (): void => {
                clearTimeout(timeout.handle);
                dispatch.startedResolve = undefined;
                dispatch.startedReject = undefined;
            };
            timeout.handle = setTimeout(() => {
                cleanup();
                reject(
                    createTimeoutError(`Worker ${workerId} accepted but never started the walk.`),
                );
            }, PATCHWALK_DEFAULT_READY_TIMEOUT_MS);
            dispatch.startedResolve = (stepCount: number) => {
                cleanup();
                resolve(stepCount);
            };
            dispatch.startedReject = (error: Error) => {
                cleanup();
                reject(error);
            };
        });
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
                // The socket 'close' event fires asynchronously (after this delete), so
                // handleWorkerDisconnect would no longer find the worker. Tear down the dispatch
                // here so a hung/half-open playing window cannot wedge the walk lock (P: prune-wedge).
                this.teardownDispatchForLostWorker(worker.workerId);
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
