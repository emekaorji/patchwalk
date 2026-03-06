import { Buffer } from 'node:buffer';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import type * as vscode from 'vscode';

import type { PatchwalkHandoffPayload } from './schema';
import { patchwalkHandoffJsonSchema, validatePatchwalkPayload } from './schema';

interface PatchwalkMcpServerOptions {
    port: number;
    outputChannel: vscode.OutputChannel;
    onPlayPayload: (payload: PatchwalkHandoffPayload) => Promise<void>;
}

interface JsonRpcSuccessResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    result: unknown;
}

interface JsonRpcErrorResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    error: {
        code: number;
        message: string;
        data?: unknown;
    };
}

class RpcError extends Error {
    public constructor(
        public readonly code: number,
        message: string,
        public readonly data?: unknown,
    ) {
        super(message);
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const createErrorResponse = (id: number | string | null, error: RpcError): JsonRpcErrorResponse => {
    return {
        jsonrpc: '2.0',
        id,
        error: {
            code: error.code,
            message: error.message,
            data: error.data,
        },
    };
};

export class PatchwalkMcpServer {
    private server: Server | undefined;

    public constructor(private readonly options: PatchwalkMcpServerOptions) {}

    public async start(): Promise<void> {
        if (this.server) {
            return;
        }

        this.server = createServer(async (request, response) => {
            await this.handleHttpRequest(request, response);
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
    }

    public async stop(): Promise<void> {
        if (!this.server) {
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
    }

    private async handleHttpRequest(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        if (request.method === 'GET' && request.url === '/health') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: true }));
            return;
        }

        if (request.method !== 'POST' || request.url !== '/mcp') {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        let parsedBody: unknown;
        try {
            parsedBody = await this.readJsonBody(request);
        } catch (error) {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(
                JSON.stringify({
                    error:
                        error instanceof Error
                            ? error.message
                            : 'Request body could not be parsed.',
                }),
            );
            return;
        }

        const rpcResponse = await this.handleRpcRequest(parsedBody);
        if (!rpcResponse) {
            response.writeHead(204);
            response.end();
            return;
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(rpcResponse));
    }

    private async readJsonBody(request: IncomingMessage): Promise<unknown> {
        const bodyChunks: Uint8Array[] = [];
        let totalSize = 0;
        const maxBytes = 2 * 1024 * 1024;

        for await (const chunk of request) {
            const chunkBuffer =
                typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
            totalSize += chunkBuffer.byteLength;

            if (totalSize > maxBytes) {
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

    private async handleRpcRequest(
        body: unknown,
    ): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse | undefined> {
        if (!isRecord(body)) {
            return createErrorResponse(
                null,
                new RpcError(-32600, 'Invalid Request: expected JSON-RPC object.'),
            );
        }

        const hasId = Object.prototype.hasOwnProperty.call(body, 'id');
        const rawId = body.id;
        if (hasId && rawId !== null && typeof rawId !== 'number' && typeof rawId !== 'string') {
            return createErrorResponse(
                null,
                new RpcError(-32600, 'Invalid Request: id must be a string, number, or null.'),
            );
        }

        const id = hasId ? (rawId as number | string | null) : null;
        const jsonrpc = body.jsonrpc;
        if (jsonrpc !== '2.0') {
            return createErrorResponse(
                id,
                new RpcError(-32600, 'Invalid Request: jsonrpc must be "2.0".'),
            );
        }

        const method = body.method;
        if (typeof method !== 'string' || method.trim().length === 0) {
            return createErrorResponse(
                id,
                new RpcError(-32600, 'Invalid Request: method must be a string.'),
            );
        }

        if (!hasId) {
            return undefined;
        }

        try {
            const result = await this.dispatchRpcMethod(method, body.params);
            return {
                jsonrpc: '2.0',
                id,
                result,
            };
        } catch (error) {
            if (error instanceof RpcError) {
                return createErrorResponse(id, error);
            }

            const message = error instanceof Error ? error.message : String(error);
            return createErrorResponse(id, new RpcError(-32603, message));
        }
    }

    private async dispatchRpcMethod(method: string, params: unknown): Promise<unknown> {
        if (method === 'initialize') {
            return {
                protocolVersion: '2024-11-05',
                capabilities: {
                    tools: {},
                },
                serverInfo: {
                    name: 'patchwalk-mcp',
                    version: '1.0.0',
                },
            };
        }

        if (method === 'tools/list') {
            return {
                tools: [
                    {
                        name: 'patchwalk.play',
                        description:
                            'Play a Patchwalk handoff payload inside VS Code with file navigation and narration.',
                        inputSchema: patchwalkHandoffJsonSchema,
                    },
                ],
            };
        }

        if (method === 'tools/call') {
            if (!isRecord(params)) {
                throw new RpcError(-32602, 'Invalid params for tools/call.');
            }

            const toolName = params.name;
            if (typeof toolName !== 'string' || toolName.trim().length === 0) {
                throw new RpcError(-32602, 'tools/call params.name must be a string.');
            }

            if (toolName !== 'patchwalk.play') {
                throw new RpcError(-32601, `Unknown tool: ${toolName}`);
            }

            const rawArguments = params.arguments;
            const payloadCandidate =
                isRecord(rawArguments) && rawArguments.payload !== undefined
                    ? rawArguments.payload
                    : rawArguments;

            const validation = validatePatchwalkPayload(payloadCandidate);
            if (!validation.ok) {
                throw new RpcError(-32602, `Invalid patchwalk payload: ${validation.error}`);
            }

            this.options.outputChannel.appendLine(
                `Received handoff ${validation.value.handoffId} via patchwalk.play`,
            );
            await this.options.onPlayPayload(validation.value);

            return {
                content: [
                    {
                        type: 'text',
                        text: `Patchwalk playback completed for ${validation.value.handoffId}.`,
                    },
                ],
            };
        }

        if (method === 'ping') {
            return { ok: true };
        }

        throw new RpcError(-32601, `Method not found: ${method}`);
    }
}
