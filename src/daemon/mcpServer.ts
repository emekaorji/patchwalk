import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import process from 'node:process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type {
    PatchwalkWorkerEvent,
    PatchwalkWorkerHeartbeat,
    PatchwalkWorkerRegistration,
} from '../lib/controlProtocol';
import {
    PATCHWALK_DEFAULT_HEARTBEAT_INTERVAL_MS,
    PATCHWALK_DEFAULT_POLL_INTERVAL_MS,
    patchwalkWorkerClaimSchema,
    patchwalkWorkerHeartbeatSchema,
    patchwalkWorkerRegistrationResponseSchema,
    patchwalkWorkerRegistrationSchema,
    patchwalkWorkerResultSchema,
} from '../lib/controlProtocol';
import * as logger from '../lib/logger';
import type {
    PatchwalkDispatchStatusResource,
    PatchwalkStatusResource,
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
    patchwalkPlayArgumentsSchema,
    patchwalkPlayResultSchema,
} from '../lib/mcpCatalog';
import { normalizeAbsolutePath } from '../lib/pathUtils';
import type { PatchwalkWorkerClaimSummary } from '../lib/routing';
import { compareWorkerClaims } from '../lib/routing';
import type { PatchwalkHandoffPayload } from '../lib/schema';

/**
 * The daemon owns two related protocols:
 *
 * 1. The public MCP surface exposed to AI clients
 * 2. The private worker-control API used by live editor windows
 *
 * This file intentionally keeps both in one place because dispatch routing needs full visibility
 * into MCP calls, registered workers, and playback completion signals.
 */
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

interface PendingWorkerPoll {
    resolve: (events: PatchwalkWorkerEvent[]) => void;
    timeout: NodeJS.Timeout;
}

// Workers are tracked entirely in-memory because live windows can always re-register after reconnects.
interface RegisteredWorker {
    workerId: string;
    processId: number;
    extensionVersion: string;
    workspaceRoots: string[];
    registeredAt: string;
    registeredSequence: number;
    lastSeenAt: string;
    pendingEvents: PatchwalkWorkerEvent[];
    pendingPoll?: PendingWorkerPoll;
}

// Dispatch results are normalized before they are returned to the MCP tool caller.
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
    state: 'claiming' | 'executing';
    claims: PatchwalkWorkerClaimSummary[];
    selectedWorkerId?: string;
    selectedMatchedRoot?: string;
    resultPromise: Promise<DispatchExecutionResult>;
    resolveResult: (value: DispatchExecutionResult) => void;
    rejectResult: (error: Error) => void;
}

const HEALTH_PATH = '/health';
const MCP_PATH = '/mcp';
const WORKERS_PATH = '/workers';
const DAEMON_SHUTDOWN_PATH = '/daemon/shutdown';
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 25_000;
const MAX_LONG_POLL_TIMEOUT_MS = 30_000;
// The claim window is short so MCP callers do not pay a large routing penalty.
const CLAIM_WINDOW_MS = 600;
const EXECUTION_TIMEOUT_MS = 5 * 60_000;
const STALE_WORKER_TIMEOUT_MS = 20_000;

/**
 * MCP transport helpers stay local so protocol failures never leak raw implementation details.
 */
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
    // Request URLs are resolved against localhost because the daemon only serves local traffic.
    return new URL(request.url ?? '/', 'http://127.0.0.1');
};

const getRequestPath = (request: IncomingMessage): string => {
    return getRequestUrl(request).pathname;
};

const getSessionId = (request: IncomingMessage): string | undefined => {
    // MCP session ids travel in a header after initialize negotiates them with the SDK transport.
    const headerValue = request.headers['mcp-session-id'];
    return typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : undefined;
};

/**
 * Claim windows are short on purpose so one routed playback still feels immediate.
 */
const createDelay = (durationMs: number): Promise<void> => {
    return new Promise((resolve) => {
        setTimeout(resolve, durationMs);
    });
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

const normalizeWorkspaceRoots = async (workspaceRoots: string[]): Promise<string[]> => {
    // Worker roots are normalized up front so routing never depends on symlinks or trailing slashes.
    const normalizedRoots = await Promise.all(
        workspaceRoots.map((workspaceRoot) => normalizeAbsolutePath(workspaceRoot)),
    );
    return [...new Set(normalizedRoots)].sort((leftRoot, rightRoot) =>
        leftRoot.localeCompare(rightRoot),
    );
};

/**
 * Worker sub-routes all follow /workers/:workerId/:action.
 */
const getWorkerPathParts = (requestPath: string): string[] | undefined => {
    if (!requestPath.startsWith(`${WORKERS_PATH}/`)) {
        return undefined;
    }

    return requestPath
        .slice(WORKERS_PATH.length + 1)
        .split('/')
        .filter(Boolean);
};

export class PatchwalkMcpServer {
    private server: Server | undefined;
    private readonly sessions = new Map<string, PatchwalkMcpSession>();
    private readonly workers = new Map<string, RegisteredWorker>();
    private readonly activeDispatches = new Map<string, ActiveDispatch>();
    private workerSequence = 0;
    private startedAt: string | null = null;

    public constructor(private readonly options: PatchwalkMcpServerOptions) {}

    public get endpointUrl(): string | undefined {
        // Expose the resolved port because tests may boot the daemon on an ephemeral port.
        const port = this.listeningPort;
        if (port === undefined) {
            return undefined;
        }

        return `http://127.0.0.1:${port}${MCP_PATH}`;
    }

    public get listeningPort(): number | undefined {
        // Node returns either a pipe string or an address object; Patchwalk only uses TCP.
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
            // Starting twice is harmless and keeps daemon recovery idempotent.
            logger.info('Patchwalk daemon start skipped because the server is already running.');
            return;
        }

        // One HTTP server handles MCP and worker traffic so both sides share runtime state.
        this.server = createServer(async (request, response) => {
            await this.handleHttpRequestSafely(request, response);
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
        // Stop sessions, workers, and in-flight dispatches in that order so callers fail deterministically.
        const sessionIds = [...this.sessions.keys()];
        await Promise.allSettled(sessionIds.map((sessionId) => this.disposeSession(sessionId)));

        const workers = [...this.workers.values()];
        for (const worker of workers) {
            this.disposeWorker(worker.workerId);
        }

        const dispatches = [...this.activeDispatches.values()];
        for (const dispatch of dispatches) {
            dispatch.rejectResult(
                new Error('Patchwalk daemon stopped before the dispatch completed.'),
            );
            this.activeDispatches.delete(dispatch.dispatchId);
        }

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
        const shouldLogRequest =
            requestPath !== HEALTH_PATH &&
            !(requestPath.startsWith(`${WORKERS_PATH}/`) && requestPath.endsWith('/events'));

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
            // The daemon always prefers a structured failure response over a hung connection.
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
        // Opportunistic pruning keeps the registry honest without a separate cleanup loop.
        this.pruneStaleWorkers();

        const requestPath = getRequestPath(request);

        if (request.method === 'GET' && requestPath === HEALTH_PATH) {
            // Health is intentionally tiny and does not require MCP negotiation.
            this.writeJsonResponse(response, 200, {
                ok: true,
                serverKind: 'patchwalk-daemon',
                apiVersion: '1.0.0',
                endpointUrl: this.endpointUrl ?? null,
                daemonPid: process.pid,
                activeSessionCount: this.activeSessionCount,
                workerCount: this.workers.size,
                activeDispatchCount: this.activeDispatches.size,
            });
            return;
        }

        if (request.method === 'POST' && requestPath === DAEMON_SHUTDOWN_PATH) {
            logger.info('Received daemon shutdown HTTP request.');
            this.writeJsonResponse(response, 202, {
                ok: true,
                message: 'Patchwalk daemon shutdown requested.',
            });

            setImmediate(() => {
                // Respond first so callers do not race the process shutdown path.
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

        if (requestPath === WORKERS_PATH && request.method === 'POST') {
            // Worker registration is a plain local HTTP endpoint, not an MCP tool.
            await this.handleWorkerRegistration(request, response);
            return;
        }

        if (requestPath.startsWith(`${WORKERS_PATH}/`)) {
            await this.handleWorkerRequest(request, response);
            return;
        }

        this.writeJsonResponse(response, 404, { error: 'Not found' });
    }

    private async handleMcpRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        // Streamable HTTP uses POST for messages and GET/DELETE for session lifecycle.
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

    private async handleWorkerRegistration(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        // Registration is validated before any worker touches the daemon registry.
        const parsedBody = patchwalkWorkerRegistrationSchema.safeParse(
            await this.readJsonBody(request),
        );
        if (!parsedBody.success) {
            logger.warn('Worker registration rejected because the payload was invalid.', {
                reason:
                    parsedBody.error.issues[0]?.message ?? 'Invalid worker registration payload.',
            });
            this.writeJsonResponse(response, 400, {
                error:
                    parsedBody.error.issues[0]?.message ?? 'Invalid worker registration payload.',
            });
            return;
        }

        const normalizedRegistration = await this.normalizeWorkerRegistration(parsedBody.data);
        const registeredWorker = this.upsertWorker(normalizedRegistration);

        // The daemon publishes cadence so workers do not hardcode lifecycle assumptions.
        const registrationResponse = patchwalkWorkerRegistrationResponseSchema.parse({
            workerId: registeredWorker.workerId,
            daemonPid: process.pid,
            pollIntervalMs: PATCHWALK_DEFAULT_POLL_INTERVAL_MS,
            heartbeatIntervalMs: PATCHWALK_DEFAULT_HEARTBEAT_INTERVAL_MS,
        });
        logger.info('Worker registration accepted.', {
            workerId: registeredWorker.workerId,
            processId: registeredWorker.processId,
            workspaceRootCount: registeredWorker.workspaceRoots.length,
        });
        this.writeJsonResponse(response, 200, registrationResponse);
    }

    private async handleWorkerRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        // Worker routes are intentionally narrow so the private protocol stays easy to audit.
        const pathParts = getWorkerPathParts(getRequestPath(request));
        if (!pathParts || pathParts.length !== 2) {
            this.writeJsonResponse(response, 404, { error: 'Unknown worker endpoint.' });
            return;
        }

        const [workerId, action] = pathParts;
        const worker = this.workers.get(workerId);
        if (!worker) {
            this.writeJsonResponse(response, 404, { error: 'Worker not registered.' });
            return;
        }

        switch (action) {
            case 'heartbeat':
                if (request.method !== 'POST') {
                    this.writeJsonResponse(response, 405, { error: 'Method not allowed.' });
                    return;
                }

                await this.handleWorkerHeartbeat(worker, request, response);
                return;
            case 'events':
                if (request.method !== 'GET') {
                    this.writeJsonResponse(response, 405, { error: 'Method not allowed.' });
                    return;
                }

                await this.handleWorkerEvents(worker, request, response);
                return;
            case 'claims':
                if (request.method !== 'POST') {
                    this.writeJsonResponse(response, 405, { error: 'Method not allowed.' });
                    return;
                }

                await this.handleWorkerClaim(worker, request, response);
                return;
            case 'results':
                if (request.method !== 'POST') {
                    this.writeJsonResponse(response, 405, { error: 'Method not allowed.' });
                    return;
                }

                await this.handleWorkerResult(worker, request, response);
                return;
            default:
                this.writeJsonResponse(response, 404, { error: 'Unknown worker endpoint.' });
                return;
        }
    }

    private async handleWorkerHeartbeat(
        worker: RegisteredWorker,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        // Heartbeats double as workspace-root refreshes for already-registered windows.
        const parsedBody = patchwalkWorkerHeartbeatSchema.safeParse(
            await this.readJsonBody(request),
        );
        if (!parsedBody.success) {
            logger.warn('Worker heartbeat rejected because the payload was invalid.', {
                workerId: worker.workerId,
                reason: parsedBody.error.issues[0]?.message ?? 'Invalid worker heartbeat payload.',
            });
            this.writeJsonResponse(response, 400, {
                error: parsedBody.error.issues[0]?.message ?? 'Invalid worker heartbeat payload.',
            });
            return;
        }

        const heartbeat = await this.normalizeWorkerHeartbeat(parsedBody.data);
        // Workers can add or remove workspace roots during their lifetime.
        worker.workspaceRoots = heartbeat.workspaceRoots;
        worker.lastSeenAt = heartbeat.lastSeenAt;

        this.writeJsonResponse(response, 200, { ok: true });
    }

    private async handleWorkerEvents(
        worker: RegisteredWorker,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        // Workers are allowed to suggest a wait time, but the daemon clamps it to sane bounds.
        const waitMsValue = Number(getRequestUrl(request).searchParams.get('waitMs') ?? '');
        const waitMs = Number.isFinite(waitMsValue)
            ? Math.min(Math.max(waitMsValue, 1), MAX_LONG_POLL_TIMEOUT_MS)
            : DEFAULT_LONG_POLL_TIMEOUT_MS;

        const events = await this.waitForWorkerEvents(worker, waitMs);
        this.writeJsonResponse(response, 200, {
            events,
            pollIntervalMs: PATCHWALK_DEFAULT_POLL_INTERVAL_MS,
        });
    }

    private async handleWorkerClaim(
        worker: RegisteredWorker,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        // Claims arrive during the short claim window after a playback request is broadcast.
        const parsedBody = patchwalkWorkerClaimSchema.safeParse(await this.readJsonBody(request));
        if (!parsedBody.success) {
            logger.warn('Worker claim rejected because the payload was invalid.', {
                workerId: worker.workerId,
                reason: parsedBody.error.issues[0]?.message ?? 'Invalid worker claim payload.',
            });
            this.writeJsonResponse(response, 400, {
                error: parsedBody.error.issues[0]?.message ?? 'Invalid worker claim payload.',
            });
            return;
        }

        const claim = parsedBody.data;
        const dispatch = this.activeDispatches.get(claim.dispatchId);
        if (!dispatch || dispatch.state !== 'claiming' || !claim.accepted) {
            // Late or rejected claims are not fatal; they simply miss the claim window.
            this.writeJsonResponse(response, 202, { ok: true });
            return;
        }

        // One worker can refresh its claim while the window is still open, so replace by worker id.
        dispatch.claims = [
            ...dispatch.claims.filter(
                (existingClaim) => existingClaim.workerId !== worker.workerId,
            ),
            {
                workerId: worker.workerId,
                matchedRoot: claim.matchedRoot!,
                matchKind: claim.matchKind!,
                registeredSequence: worker.registeredSequence,
            },
        ];

        logger.info('Worker claim accepted for active dispatch.', {
            workerId: worker.workerId,
            dispatchId: dispatch.dispatchId,
            matchKind: claim.matchKind,
            matchedRoot: claim.matchedRoot,
        });

        this.writeJsonResponse(response, 202, { ok: true });
    }

    private async handleWorkerResult(
        worker: RegisteredWorker,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        // Results arrive only from the single selected worker once playback succeeds or fails.
        const parsedBody = patchwalkWorkerResultSchema.safeParse(await this.readJsonBody(request));
        if (!parsedBody.success) {
            logger.warn('Worker result rejected because the payload was invalid.', {
                workerId: worker.workerId,
                reason: parsedBody.error.issues[0]?.message ?? 'Invalid worker result payload.',
            });
            this.writeJsonResponse(response, 400, {
                error: parsedBody.error.issues[0]?.message ?? 'Invalid worker result payload.',
            });
            return;
        }

        const result = parsedBody.data;
        const dispatch = this.activeDispatches.get(result.dispatchId);
        if (!dispatch || dispatch.selectedWorkerId !== worker.workerId) {
            logger.warn('Worker result rejected because no matching active dispatch was found.', {
                workerId: worker.workerId,
                dispatchId: result.dispatchId,
            });
            this.writeJsonResponse(response, 404, {
                error: 'Dispatch not found for worker result.',
            });
            return;
        }

        // Results are the handoff between editor-side playback and the MCP tool response.
        if (result.status === 'completed') {
            logger.info('Worker reported completed playback.', {
                workerId: worker.workerId,
                dispatchId: result.dispatchId,
                handoffId: result.handoffId,
                stepsPlayed: result.stepsPlayed,
            });
            dispatch.resolveResult({
                workerId: worker.workerId,
                matchedRoot: dispatch.selectedMatchedRoot ?? dispatch.payload.basePath,
                handoffId: result.handoffId,
                stepsPlayed: result.stepsPlayed!,
            });
        } else {
            logger.error('Worker reported failed playback.', {
                workerId: worker.workerId,
                dispatchId: result.dispatchId,
                handoffId: result.handoffId,
                error: result.error,
            });
            dispatch.rejectResult(new Error(result.error));
        }

        this.writeJsonResponse(response, 202, { ok: true });
    }

    private async handlePostRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        // POST is the only MCP route that can create sessions and deliver client messages.
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
                logger.warn('Rejected MCP POST request because the session id was unknown.', {
                    sessionId,
                });
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
            // Clients must initialize before making any session-bound MCP requests.
            logger.warn('Rejected MCP POST request because initialize was not called first.');
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

        // Initialization can fail before the SDK assigns a session id.
        if (!session.id) {
            await this.disposeOrphanedSession(session);
        }
    }

    private async handleSessionBoundRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        // GET and DELETE requests are meaningful only after a session already exists.
        const sessionId = getSessionId(request);
        if (!sessionId) {
            logger.warn('Rejected MCP session-bound request without a session id header.');
            this.writeJsonResponse(
                response,
                400,
                createJsonRpcErrorResponse(-32000, 'Bad Request: No valid session ID provided'),
            );
            return;
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.warn('Rejected MCP session-bound request with an unknown session id.', {
                sessionId,
            });
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
            // Keep SDK transport failures inside the daemon boundary.
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
        // Session setup is slightly circular because the transport provides the id after initialize.
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

                // Session ids are only known after the transport finishes initialize negotiation.
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
        // Each MCP session gets its own SDK server instance, but all instances share daemon state.
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
                // Status is generated live so it reflects current workers and dispatches.
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
                    'Route a Patchwalk handoff to the best matching live editor window and play it there. Construct payloads as semantic patch explanations for engineers: explain behavior change, why it matters, risk signals, blast radius, before-vs-after behavior, tests, and architecture where relevant; filter out formatting and import-order noise.',
                inputSchema: patchwalkPlayArgumentsSchema,
                outputSchema: patchwalkPlayResultSchema,
                annotations: {
                    openWorldHint: false,
                    readOnlyHint: false,
                },
            },
            async (argumentsValue, extra) => {
                // Normalize the payload once so routing, status, and playback all see the same basePath.
                const payload = await this.normalizePayload(
                    normalizePatchwalkPlayPayload(argumentsValue),
                );
                const session = getSession();

                // Logging messages give MCP-aware clients progress visibility during long playbacks.
                logger.info('MCP tool call started playback routing.', {
                    handoffId: payload.handoffId,
                    basePath: payload.basePath,
                    sessionId: extra.sessionId ?? null,
                });
                await server.sendLoggingMessage(
                    {
                        level: 'info',
                        data: `Starting Patchwalk routing for ${payload.handoffId}`,
                    },
                    extra.sessionId,
                );

                try {
                    const dispatchResult = await this.dispatchPlayback(payload);

                    logger.info('MCP tool call completed playback routing.', {
                        handoffId: payload.handoffId,
                        workerId: dispatchResult.workerId,
                        matchedRoot: dispatchResult.matchedRoot,
                        sessionId: extra.sessionId ?? null,
                    });
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

                    await server.sendLoggingMessage(
                        {
                            level: 'error',
                            data: `Patchwalk playback failed for ${payload.handoffId}: ${message}`,
                        },
                        extra.sessionId,
                    );

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

        return server;
    }

    private createServerInstructions(): string {
        // Keep server instructions short and action-oriented because MCP clients may surface them verbatim.
        return [
            'Patchwalk replays narrated code handoffs inside live editor windows.',
            `Read ${PATCHWALK_STATUS_RESOURCE_URI} for daemon, worker, and dispatch status.`,
            `Read ${PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI} for a valid payload example.`,
            `Read ${PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI} before generating payloads for non-trivial changes.`,
            `Use ${PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME} or ${PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME} to draft handoff content.`,
            `Call ${PATCHWALK_PLAY_TOOL_NAME} with a Patchwalk handoff payload that includes basePath and meaningful developer-facing narration.`,
        ].join(' ');
    }

    private createStatusResource(): PatchwalkStatusResource {
        const endpointUrl = this.endpointUrl ?? MCP_PATH;
        // Status resources flatten internal maps into plain JSON so clients can render them directly.
        const workers: PatchwalkWorkerStatusResource[] = [...this.workers.values()].map(
            (worker) => ({
                workerId: worker.workerId,
                processId: worker.processId,
                extensionVersion: worker.extensionVersion,
                workspaceRoots: worker.workspaceRoots,
                registeredAt: worker.registeredAt,
                lastSeenAt: worker.lastSeenAt,
            }),
        );
        const activeDispatches: PatchwalkDispatchStatusResource[] = [
            ...this.activeDispatches.values(),
        ].map((dispatch) => ({
            dispatchId: dispatch.dispatchId,
            handoffId: dispatch.payload.handoffId,
            basePath: dispatch.payload.basePath,
            state: dispatch.state,
            createdAt: dispatch.createdAt,
            selectedWorkerId: dispatch.selectedWorkerId,
        }));

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
            tools: [PATCHWALK_PLAY_TOOL_NAME],
        };
    }

    private async dispatchPlayback(
        payload: PatchwalkHandoffPayload,
    ): Promise<DispatchExecutionResult> {
        // Prune before dispatch so a dead window cannot win an otherwise valid route.
        this.pruneStaleWorkers();

        if (this.workers.size === 0) {
            throw new Error('No live Patchwalk editor windows are registered.');
        }

        // Promise plumbing lives on the dispatch so worker results can resolve it from a different route.
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
            state: 'claiming',
            claims: [],
            resultPromise,
            resolveResult: resultState.resolve!,
            rejectResult: resultState.reject!,
        };
        this.activeDispatches.set(dispatch.dispatchId, dispatch);
        logger.info('Dispatch created for playback request.', {
            dispatchId: dispatch.dispatchId,
            handoffId: payload.handoffId,
            basePath: payload.basePath,
            registeredWorkerCount: this.workers.size,
        });

        try {
            // Broadcast only the minimal claim payload first; the full handoff waits for the winner.
            const claimEvent: PatchwalkWorkerEvent = {
                type: 'playback.claim',
                eventId: randomUUID(),
                dispatchId: dispatch.dispatchId,
                handoffId: payload.handoffId,
                basePath: payload.basePath,
            };
            for (const worker of this.workers.values()) {
                // Broadcast one lightweight claim request to every live worker.
                this.enqueueWorkerEvent(worker.workerId, claimEvent);
            }

            await createDelay(CLAIM_WINDOW_MS);

            // Winner selection is deterministic and centralized in the daemon.
            const selectedClaim = [...dispatch.claims].sort(compareWorkerClaims)[0];
            if (!selectedClaim) {
                logger.warn('Dispatch failed because no worker claimed the requested base path.', {
                    dispatchId: dispatch.dispatchId,
                    handoffId: payload.handoffId,
                    basePath: payload.basePath,
                });
                throw new Error(
                    `No live Patchwalk window matched the requested basePath: ${payload.basePath}`,
                );
            }

            dispatch.state = 'executing';
            dispatch.selectedWorkerId = selectedClaim.workerId;
            dispatch.selectedMatchedRoot = selectedClaim.matchedRoot;
            logger.info('Dispatch selected worker claim.', {
                dispatchId: dispatch.dispatchId,
                workerId: selectedClaim.workerId,
                matchedRoot: selectedClaim.matchedRoot,
                matchKind: selectedClaim.matchKind,
            });

            // Let losing workers clear any pending local state for this dispatch.
            for (const claim of dispatch.claims) {
                if (claim.workerId === selectedClaim.workerId) {
                    continue;
                }

                this.enqueueWorkerEvent(claim.workerId, {
                    type: 'playback.cancel',
                    eventId: randomUUID(),
                    dispatchId: dispatch.dispatchId,
                    reason: `Worker ${selectedClaim.workerId} won the routing decision.`,
                });
            }

            // Only the winner receives the full payload and performs editor-side work.
            this.enqueueWorkerEvent(selectedClaim.workerId, {
                type: 'playback.execute',
                eventId: randomUUID(),
                dispatchId: dispatch.dispatchId,
                payload,
            });

            return await withTimeout(
                dispatch.resultPromise,
                EXECUTION_TIMEOUT_MS,
                `Worker ${selectedClaim.workerId} did not complete playback in time.`,
            );
        } finally {
            // Dispatches are purely in-memory and disappear once the tool call resolves.
            this.activeDispatches.delete(dispatch.dispatchId);
            logger.info('Dispatch removed from active registry.', {
                dispatchId: dispatch.dispatchId,
                remainingActiveDispatches: this.activeDispatches.size,
            });
        }
    }

    private enqueueWorkerEvent(workerId: string, event: PatchwalkWorkerEvent): void {
        const worker = this.workers.get(workerId);
        if (!worker) {
            return;
        }

        // Events queue in memory until the worker's next long-poll returns.
        worker.pendingEvents.push(event);
        if (!worker.pendingPoll) {
            return;
        }

        const pendingPoll = worker.pendingPoll;
        worker.pendingPoll = undefined;
        clearTimeout(pendingPoll.timeout);
        // Flush immediately if the worker is already waiting on a long-poll response.
        const events = worker.pendingEvents.splice(0, worker.pendingEvents.length);
        pendingPoll.resolve(events);
    }

    private async waitForWorkerEvents(
        worker: RegisteredWorker,
        timeoutMs: number,
    ): Promise<PatchwalkWorkerEvent[]> {
        if (worker.pendingEvents.length > 0) {
            // Flush immediately if work is already queued instead of waiting for the timeout.
            return worker.pendingEvents.splice(0, worker.pendingEvents.length);
        }

        if (worker.pendingPoll) {
            // A second poll means the worker likely restarted its event loop; force reconciliation.
            clearTimeout(worker.pendingPoll.timeout);
            worker.pendingPoll.resolve([
                {
                    type: 'worker.reconcile',
                    eventId: randomUUID(),
                },
            ]);
            worker.pendingPoll = undefined;
        }

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                if (worker.pendingPoll?.resolve === resolve) {
                    worker.pendingPoll = undefined;
                }

                // Empty event batches are normal and tell the worker to long-poll again.
                resolve([]);
            }, timeoutMs);

            worker.pendingPoll = {
                resolve,
                timeout,
            };
        });
    }

    private disposeWorker(workerId: string): void {
        const worker = this.workers.get(workerId);
        if (!worker) {
            return;
        }

        if (worker.pendingPoll) {
            clearTimeout(worker.pendingPoll.timeout);
            // Resolve the hanging poll so worker shutdown does not leak promises.
            worker.pendingPoll.resolve([]);
            worker.pendingPoll = undefined;
        }

        this.workers.delete(workerId);
        logger.info('Worker removed from daemon registry.', {
            workerId,
            remainingWorkerCount: this.workers.size,
        });
    }

    private pruneStaleWorkers(): void {
        // Liveness is heartbeat-based; stale workers are treated as gone without any graceful handshake.
        const now = Date.now();
        for (const worker of this.workers.values()) {
            const ageMs = now - new Date(worker.lastSeenAt).getTime();
            if (ageMs > STALE_WORKER_TIMEOUT_MS) {
                logger.warn('Pruning stale worker from daemon registry.', {
                    workerId: worker.workerId,
                    ageMs,
                });
                this.disposeWorker(worker.workerId);
            }
        }
    }

    private upsertWorker(registration: PatchwalkWorkerRegistration): RegisteredWorker {
        const existingWorker = this.workers.get(registration.workerId);
        if (existingWorker) {
            // Re-registration is normal after a daemon restart or workspace-folder change.
            existingWorker.processId = registration.processId;
            existingWorker.extensionVersion = registration.extensionVersion;
            existingWorker.workspaceRoots = registration.workspaceRoots;
            existingWorker.lastSeenAt = registration.lastSeenAt;
            logger.info('Worker registration refreshed existing worker record.', {
                workerId: existingWorker.workerId,
                workspaceRootCount: existingWorker.workspaceRoots.length,
            });
            return existingWorker;
        }

        const registeredWorker: RegisteredWorker = {
            workerId: registration.workerId,
            processId: registration.processId,
            extensionVersion: registration.extensionVersion,
            workspaceRoots: registration.workspaceRoots,
            registeredAt: new Date().toISOString(),
            registeredSequence: ++this.workerSequence,
            lastSeenAt: registration.lastSeenAt,
            pendingEvents: [],
        };
        // Registration sequence becomes the final deterministic tie-break when paths are otherwise equal.
        this.workers.set(registeredWorker.workerId, registeredWorker);
        logger.info('Worker registration created new worker record.', {
            workerId: registeredWorker.workerId,
            processId: registeredWorker.processId,
            registrationSequence: registeredWorker.registeredSequence,
        });
        return registeredWorker;
    }

    private async normalizeWorkerRegistration(
        registration: PatchwalkWorkerRegistration,
    ): Promise<PatchwalkWorkerRegistration> {
        return {
            ...registration,
            workspaceRoots: await normalizeWorkspaceRoots(registration.workspaceRoots),
        };
    }

    private async normalizeWorkerHeartbeat(
        heartbeat: PatchwalkWorkerHeartbeat,
    ): Promise<PatchwalkWorkerHeartbeat> {
        return {
            ...heartbeat,
            workspaceRoots: await normalizeWorkspaceRoots(heartbeat.workspaceRoots),
        };
    }

    private async normalizePayload(
        payload: PatchwalkHandoffPayload,
    ): Promise<PatchwalkHandoffPayload> {
        return {
            ...payload,
            // Normalize once here so routing and status never disagree about path identity.
            basePath: await normalizeAbsolutePath(payload.basePath),
        };
    }

    private async disposeSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session || session.disposed) {
            return;
        }

        await this.closeSession(session);
    }

    private async disposeOrphanedSession(session: PatchwalkMcpSession): Promise<void> {
        if (session.disposed || session.id) {
            return;
        }

        await this.closeSession(session);
    }

    private async closeSession(session: PatchwalkMcpSession): Promise<void> {
        if (session.disposed) {
            return;
        }

        // Mark disposed first so repeated close paths cannot double-close the same transport.
        session.disposed = true;
        if (session.id) {
            this.sessions.delete(session.id);
        }

        await Promise.allSettled([session.transport.close(), session.server.close()]);
        logger.info('MCP session resources disposed.', {
            sessionId: session.id || null,
            activeSessionCount: this.sessions.size,
        });
    }

    private async readJsonBody(request: IncomingMessage): Promise<unknown> {
        const bodyChunks: Uint8Array[] = [];
        let totalSize = 0;

        for await (const chunk of request) {
            // Convert every chunk to Uint8Array so Node's current Buffer.concat typing stays satisfied.
            const chunkBuffer =
                typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
            totalSize += chunkBuffer.byteLength;

            if (totalSize > MAX_REQUEST_BODY_BYTES) {
                throw new Error('Request body is too large.');
            }

            bodyChunks.push(chunkBuffer);
        }

        // Read the whole body before parsing so every route gets the same size and emptiness checks.
        const rawBody = Buffer.concat(bodyChunks).toString('utf8');
        if (!rawBody.trim()) {
            throw new Error('Request body is empty.');
        }

        return JSON.parse(rawBody);
    }

    private writeJsonResponse(response: ServerResponse, statusCode: number, body: unknown): void {
        // Every non-streaming daemon route returns plain JSON for easy local debugging.
        response.writeHead(statusCode, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
    }
}
