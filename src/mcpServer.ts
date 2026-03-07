import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type * as vscode from 'vscode';
import { z } from 'zod';

import type { PatchwalkStatusResource } from './mcpCatalog';
import {
    createPatchwalkComposePromptText,
    createPatchwalkExampleHandoff,
    createPatchwalkExpandWalkthroughPromptText,
    createPatchwalkOperatorManual,
    normalizePatchwalkPlayPayload,
    PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
    PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
    PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME,
    PATCHWALK_MCP_SERVER_INFO,
    PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
    PATCHWALK_PLAY_TOOL_NAME,
    PATCHWALK_STATUS_RESOURCE_URI,
    patchwalkPlayArgumentsSchema,
    patchwalkPlayResultSchema,
} from './mcpCatalog';
import type { PatchwalkHandoffPayload } from './schema';

interface PatchwalkMcpServerOptions {
    port: number;
    outputChannel: vscode.OutputChannel;
    onPlayPayload: (payload: PatchwalkHandoffPayload) => Promise<void>;
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

const HEALTH_PATH = '/health';
const MCP_PATH = '/mcp';
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

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

const getRequestPath = (request: IncomingMessage): string => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    return url.pathname;
};

const getSessionId = (request: IncomingMessage): string | undefined => {
    const headerValue = request.headers['mcp-session-id'];
    return typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : undefined;
};

const createPromptArgsSchema = <Shape extends z.ZodRawShape>(shape: Shape): Shape => shape;

export class PatchwalkMcpServer {
    private server: Server | undefined;
    private readonly sessions = new Map<string, PatchwalkMcpSession>();
    private startedAt: string | null = null;

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
            return;
        }

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
    }

    public async stop(): Promise<void> {
        const sessionIds = [...this.sessions.keys()];
        await Promise.allSettled(sessionIds.map((sessionId) => this.disposeSession(sessionId)));

        if (!this.server) {
            this.startedAt = null;
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
    }

    private async handleHttpRequestSafely(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        try {
            await this.handleHttpRequest(request, response);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.options.outputChannel.appendLine(
                `Patchwalk MCP request ${request.method ?? 'UNKNOWN'} ${getRequestPath(request)} failed: ${message}`,
            );

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
        }
    }

    private async handleHttpRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const requestPath = getRequestPath(request);

        if (request.method === 'GET' && requestPath === HEALTH_PATH) {
            this.writeJsonResponse(response, 200, {
                ok: true,
                endpointUrl: this.endpointUrl ?? null,
                activeSessionCount: this.activeSessionCount,
            });
            return;
        }

        if (requestPath !== MCP_PATH) {
            this.writeJsonResponse(response, 404, { error: 'Not found' });
            return;
        }

        switch (request.method) {
            case 'POST':
                await this.handlePostRequest(request, response);
                return;
            case 'GET':
                await this.handleSessionBoundRequest(request, response);
                return;
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

        // A failed initialize request can exit before the transport assigns a session id.
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
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.options.outputChannel.appendLine(
                `Patchwalk MCP session ${session.id} request failed: ${message}`,
            );

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
                this.options.outputChannel.appendLine(
                    `Patchwalk MCP session started: ${sessionId}`,
                );
            },
            onsessionclosed: (sessionId) => {
                this.options.outputChannel.appendLine(
                    `Patchwalk MCP session closing: ${sessionId}`,
                );
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
                description: 'Runtime information for the local Patchwalk MCP server.',
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
                    'Operational guidance for tools, prompts, resources, and transport use.',
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

        server.registerPrompt(
            PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
            {
                title: 'Compose Patchwalk Handoff',
                description: 'Draft a full Patchwalk handoff payload from a change summary.',
                argsSchema: createPromptArgsSchema({
                    changeSummary: z.string().describe('High-level summary of the change.'),
                    changedFiles: z
                        .string()
                        .optional()
                        .describe('Optional newline-separated changed files or modules.'),
                    focusAreas: z
                        .string()
                        .optional()
                        .describe('Optional implementation details that deserve deeper narration.'),
                }),
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
                description: 'Turn a summary and file list into narrated walkthrough steps.',
                argsSchema: createPromptArgsSchema({
                    summary: z.string().describe('Short summary of the change or feature.'),
                    files: z
                        .string()
                        .describe('Relevant files, one per line or as grouped bullets.'),
                    detailLevel: z
                        .string()
                        .optional()
                        .describe(
                            'Optional detail preference such as concise, detailed, or exhaustive.',
                        ),
                }),
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
                    'Play a Patchwalk handoff payload inside VS Code with file navigation, highlighting, and narration.',
                inputSchema: patchwalkPlayArgumentsSchema,
                outputSchema: patchwalkPlayResultSchema,
                annotations: {
                    openWorldHint: false,
                    readOnlyHint: false,
                },
            },
            async (argumentsValue, extra) => {
                const payload = normalizePatchwalkPlayPayload(argumentsValue);
                const session = getSession();

                await server.sendLoggingMessage(
                    {
                        level: 'info',
                        data: `Starting Patchwalk playback for ${payload.handoffId}`,
                    },
                    extra.sessionId,
                );

                this.options.outputChannel.appendLine(
                    `Received handoff ${payload.handoffId} via ${PATCHWALK_PLAY_TOOL_NAME}`,
                );

                try {
                    await this.options.onPlayPayload(payload);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.options.outputChannel.appendLine(
                        `Patchwalk playback failed for ${payload.handoffId}: ${message}`,
                    );

                    await server.sendLoggingMessage(
                        {
                            level: 'error',
                            data: `Patchwalk playback failed for ${payload.handoffId}: ${message}`,
                        },
                        extra.sessionId,
                    );
                    throw error;
                }

                this.options.outputChannel.appendLine(
                    `Completed handoff ${payload.handoffId} via ${PATCHWALK_PLAY_TOOL_NAME}`,
                );

                await server.sendLoggingMessage(
                    {
                        level: 'info',
                        data: `Completed Patchwalk playback for ${payload.handoffId}`,
                    },
                    extra.sessionId,
                );

                return {
                    structuredContent: {
                        handoffId: payload.handoffId,
                        status: 'completed' as const,
                        stepsPlayed: payload.walkthrough.length,
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
                                : 'Playback completed without a recorded session.',
                        },
                    ],
                };
            },
        );

        return server;
    }

    private createServerInstructions(): string {
        return [
            'Patchwalk replays narrated code handoffs inside VS Code.',
            `Read ${PATCHWALK_STATUS_RESOURCE_URI} for runtime status.`,
            `Read ${PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI} for a valid payload example.`,
            `Use ${PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME} or ${PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME} to draft handoff content.`,
            `Call ${PATCHWALK_PLAY_TOOL_NAME} with a Patchwalk handoff payload to start playback.`,
        ].join(' ');
    }

    private createStatusResource(): PatchwalkStatusResource {
        const endpointUrl = this.endpointUrl ?? MCP_PATH;

        return {
            endpointUrl,
            healthUrl: endpointUrl.replace(/\/mcp$/, '/health'),
            startedAt: this.startedAt,
            activeSessionCount: this.activeSessionCount,
            prompts: [
                PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
                PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME,
            ],
            resources: [
                PATCHWALK_STATUS_RESOURCE_URI,
                PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
                PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
            ],
            tools: [PATCHWALK_PLAY_TOOL_NAME],
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

        this.options.outputChannel.appendLine(
            'Patchwalk MCP session failed before a session ID was assigned. Cleaning up orphaned session.',
        );
        await this.closeSession(session);
    }

    private async closeSession(session: PatchwalkMcpSession): Promise<void> {
        if (session.disposed) {
            return;
        }

        session.disposed = true;
        if (session.id) {
            this.sessions.delete(session.id);
        }

        await Promise.allSettled([session.transport.close(), session.server.close()]);
        this.options.outputChannel.appendLine(
            `Patchwalk MCP session stopped: ${session.id || '<pending>'}`,
        );
    }

    private async readJsonBody(request: IncomingMessage): Promise<unknown> {
        const bodyChunks: Uint8Array[] = [];
        let totalSize = 0;

        for await (const chunk of request) {
            const chunkBuffer =
                typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
            totalSize += chunkBuffer.byteLength;

            if (totalSize > MAX_REQUEST_BODY_BYTES) {
                throw new Error('Request body is too large.');
            }

            bodyChunks.push(chunkBuffer);
        }

        const rawBody = Buffer.concat(bodyChunks).toString('utf8');
        if (!rawBody.trim()) {
            throw new Error('Request body is empty.');
        }

        return JSON.parse(rawBody);
    }

    private writeJsonResponse(response: ServerResponse, statusCode: number, body: unknown): void {
        response.writeHead(statusCode, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
    }
}
