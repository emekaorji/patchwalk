import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type * as vscode from 'vscode';

import type { PatchwalkStatusResource } from '../src/mcpCatalog';
import {
    PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
    PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
    PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME,
    PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
    PATCHWALK_PLAY_TOOL_NAME,
    PATCHWALK_STATUS_RESOURCE_URI,
} from '../src/mcpCatalog';
import { PatchwalkMcpServer } from '../src/mcpServer';
import type { PatchwalkHandoffPayload } from '../src/schema';

const createPayload = (): PatchwalkHandoffPayload => {
    return {
        specVersion: '1.0.0',
        handoffId: 'mcp-server-test',
        createdAt: '2026-03-07T10:00:00Z',
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
                path: 'src/extension.ts',
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

const createInitializeRequest = () => {
    return {
        jsonrpc: '2.0' as const,
        id: 'initialize-test',
        method: 'initialize' as const,
        params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
                name: 'patchwalk-raw-http-test',
                version: '1.0.0',
            },
        },
    };
};

const postJson = async (url: string, body: unknown): Promise<Response> => {
    return fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });
};

const assertInternalServerErrorResponse = async (response: Response): Promise<void> => {
    strictEqual(response.status, 500);
    deepStrictEqual(await response.json(), {
        jsonrpc: '2.0',
        id: null,
        error: {
            code: -32603,
            message: 'Internal server error',
        },
    });
};

const createOutputChannelStub = (): vscode.OutputChannel => {
    return {
        name: 'Patchwalk MCP Test',
        append: () => {},
        appendLine: () => {},
        clear: () => {},
        show: () => {},
        hide: () => {},
        replace: () => {},
        dispose: () => {},
    };
};

describe('patchwalk mcp server', () => {
    let outputChannel: vscode.OutputChannel;
    let playbackRequests: PatchwalkHandoffPayload[];
    let server: PatchwalkMcpServer;
    let endpointUrl: string;
    let client: Client;
    let transport: StreamableHTTPClientTransport;

    beforeEach(async () => {
        outputChannel = createOutputChannelStub();
        playbackRequests = [];
        server = new PatchwalkMcpServer({
            port: 0,
            outputChannel,
            onPlayPayload: async (payload) => {
                playbackRequests.push(payload);
            },
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
    });

    afterEach(async () => {
        await Promise.allSettled([transport.terminateSession(), transport.close(), server.stop()]);
        outputChannel.dispose();
    });

    it('serves health checks on the side channel endpoint', async () => {
        const healthUrl = endpointUrl.replace(/\/mcp$/, '/health');
        const response = await fetch(healthUrl);

        strictEqual(response.status, 200);
        deepStrictEqual(await response.json(), {
            ok: true,
            endpointUrl,
            activeSessionCount: 1,
        });
    });

    it('exposes resources, prompts, and tools through the MCP client', async () => {
        ok(transport.sessionId, 'Expected the MCP transport to negotiate a session ID.');

        const resources = await client.listResources();
        const resourceUris = resources.resources.map((resource) => resource.uri);
        deepStrictEqual(resourceUris.sort(), [
            PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
            PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI,
            PATCHWALK_STATUS_RESOURCE_URI,
        ]);

        const statusResource = JSON.parse(
            await readTextResource(client, PATCHWALK_STATUS_RESOURCE_URI),
        ) as PatchwalkStatusResource;
        strictEqual(statusResource.endpointUrl, endpointUrl);
        strictEqual(statusResource.activeSessionCount, 1);
        deepStrictEqual(statusResource.tools, [PATCHWALK_PLAY_TOOL_NAME]);

        const exampleHandoff = JSON.parse(
            await readTextResource(client, PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI),
        ) as PatchwalkHandoffPayload;
        strictEqual(exampleHandoff.handoffId, 'patchwalk-example-handoff');

        const prompts = await client.listPrompts();
        const promptNames = prompts.prompts.map((prompt) => prompt.name).sort();
        deepStrictEqual(promptNames, [
            PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
            PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME,
        ]);

        const composePrompt = await client.getPrompt({
            name: PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
            arguments: {
                changeSummary: 'Rewrite the local MCP server.',
                changedFiles: 'src/mcpServer.ts\nREADME.md',
            },
        });
        strictEqual(composePrompt.messages[0]?.role, 'user');
        if (composePrompt.messages[0]?.content.type !== 'text') {
            throw new Error('Expected text prompt content.');
        }
        match(composePrompt.messages[0].content.text, /Patchwalk handoff JSON payload/);

        const tools = await client.listTools();
        strictEqual(
            tools.tools.some((tool) => tool.name === PATCHWALK_PLAY_TOOL_NAME),
            true,
        );
    });

    it('plays a handoff payload through the official MCP tool flow', async () => {
        const payload = createPayload();
        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: payload,
        });
        const structuredContent = playResult.structuredContent as
            | {
                  handoffId?: string;
                  status?: string;
                  stepsPlayed?: number;
              }
            | undefined;
        const content = playResult.content as Array<{ type: string; text?: string }>;

        strictEqual(playbackRequests.length, 1);
        deepStrictEqual(playbackRequests[0], payload);
        strictEqual(structuredContent?.handoffId, payload.handoffId);
        strictEqual(structuredContent?.status, 'completed');
        strictEqual(structuredContent?.stepsPlayed, payload.walkthrough.length);
        strictEqual(content[0]?.type, 'text');
        if (content[0]?.type !== 'text') {
            throw new Error('Expected text tool content.');
        }
        strictEqual(content[0].text, `Patchwalk playback completed for ${payload.handoffId}.`);
    });

    it('rejects empty walkthroughs before playback starts', async () => {
        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: {
                ...createPayload(),
                handoffId: 'empty-walkthrough',
                walkthrough: [],
            },
        });
        const content = playResult.content as Array<{ type: string; text?: string }>;

        strictEqual(playbackRequests.length, 0);
        strictEqual(playResult.isError, true);
        strictEqual(content[0]?.type, 'text');
        if (content[0]?.type !== 'text') {
            throw new Error('Expected text tool content.');
        }
        match(content[0].text ?? '', /Input validation error/);
    });

    it('keeps backward compatibility for the legacy payload wrapper', async () => {
        const payload = createPayload();
        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: {
                payload,
            },
        });
        const structuredContent = playResult.structuredContent as
            | {
                  handoffId?: string;
              }
            | undefined;

        strictEqual(playbackRequests.length, 1);
        deepStrictEqual(playbackRequests[0], payload);
        strictEqual(structuredContent?.handoffId, payload.handoffId);
    });

    it('returns an HTTP 500 when session creation fails before request handling begins', async () => {
        const serverWithInternals = server as unknown as {
            createSession: () => Promise<never>;
        };

        serverWithInternals.createSession = async () => {
            throw new Error('session init exploded');
        };

        const response = await postJson(endpointUrl, createInitializeRequest());

        await assertInternalServerErrorResponse(response);
        strictEqual(server.activeSessionCount, 1);
    });

    it('cleans up orphaned sessions when the initial MCP request fails', async () => {
        const closed: string[] = [];
        const serverWithInternals = server as unknown as {
            createSession: () => Promise<{
                id: string;
                createdAt: string;
                requestCount: number;
                disposed: boolean;
                server: { close: () => Promise<void> };
                transport: {
                    close: () => Promise<void>;
                    handleRequest: (
                        request: unknown,
                        response: unknown,
                        parsedBody?: unknown,
                    ) => Promise<void>;
                };
            }>;
        };

        serverWithInternals.createSession = async () => {
            return {
                id: '',
                createdAt: new Date().toISOString(),
                requestCount: 0,
                disposed: false,
                server: {
                    close: async () => {
                        closed.push('server');
                    },
                },
                transport: {
                    close: async () => {
                        closed.push('transport');
                    },
                    handleRequest: async () => {
                        throw new Error('transport failure');
                    },
                },
            };
        };

        const response = await postJson(endpointUrl, createInitializeRequest());

        await assertInternalServerErrorResponse(response);
        deepStrictEqual(closed.sort(), ['server', 'transport']);
        strictEqual(server.activeSessionCount, 1);
    });
});
