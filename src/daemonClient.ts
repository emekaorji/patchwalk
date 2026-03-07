import { spawn } from 'node:child_process';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type {
    PatchwalkWorkerClaim,
    PatchwalkWorkerEvent,
    PatchwalkWorkerHeartbeat,
    PatchwalkWorkerRegistration,
    PatchwalkWorkerRegistrationResponse,
    PatchwalkWorkerResult,
} from './controlProtocol';
import {
    patchwalkWorkerClaimSchema,
    patchwalkWorkerEventsResponseSchema,
    patchwalkWorkerRegistrationResponseSchema,
} from './controlProtocol';
import type { PatchwalkStatusResource } from './mcpCatalog';
import { PATCHWALK_PLAY_TOOL_NAME, PATCHWALK_STATUS_RESOURCE_URI } from './mcpCatalog';
import type { PatchwalkHandoffPayload } from './schema';

/**
 * The extension talks to the daemon through this small client wrapper so the worker controller does
 * not have to know about raw fetch calls or MCP client lifecycle details.
 */
interface PatchwalkDaemonClientOptions {
    daemonEntryPath: string;
    port: number;
}

interface PatchwalkHealthResponse {
    ok: boolean;
    endpointUrl: string | null;
    daemonPid: number;
    activeSessionCount: number;
    workerCount: number;
    activeDispatchCount: number;
}

/**
 * All daemon requests are short-lived; aborted requests are treated as failures.
 */
const createTimeoutController = (timeoutMs: number): AbortController => {
    const controller = new AbortController();
    setTimeout(() => {
        controller.abort();
    }, timeoutMs);
    return controller;
};

export class PatchwalkDaemonClient {
    public constructor(private readonly options: PatchwalkDaemonClientOptions) {}

    public get baseUrl(): string {
        return `http://127.0.0.1:${this.options.port}`;
    }

    public get endpointUrl(): string {
        return `${this.baseUrl}/mcp`;
    }

    public async ensureServerRunning(): Promise<void> {
        if (await this.isHealthy()) {
            return;
        }

        // Spawn detached so the daemon survives extension-host restarts and reloads.
        const childProcess = spawn(
            process.execPath,
            [this.options.daemonEntryPath, '--port', String(this.options.port)],
            {
                detached: true,
                stdio: 'ignore',
                env: {
                    ...process.env,
                    PATCHWALK_DAEMON_PORT: String(this.options.port),
                },
            },
        );
        childProcess.unref();

        await this.waitForHealthy(Date.now() + 5_000);
    }

    public async fetchHealth(): Promise<PatchwalkHealthResponse> {
        return this.requestJson<PatchwalkHealthResponse>('/health', {
            method: 'GET',
        });
    }

    public async registerWorker(
        registration: PatchwalkWorkerRegistration,
    ): Promise<PatchwalkWorkerRegistrationResponse> {
        const response = await this.requestJson('/workers', {
            method: 'POST',
            body: JSON.stringify(registration),
        });
        return patchwalkWorkerRegistrationResponseSchema.parse(response);
    }

    public async sendHeartbeat(
        workerId: string,
        heartbeat: PatchwalkWorkerHeartbeat,
    ): Promise<void> {
        await this.requestJson(`/workers/${workerId}/heartbeat`, {
            method: 'POST',
            body: JSON.stringify(heartbeat),
        });
    }

    public async pollEvents(workerId: string, waitMs: number): Promise<PatchwalkWorkerEvent[]> {
        const response = await this.requestJson(`/workers/${workerId}/events?waitMs=${waitMs}`, {
            method: 'GET',
        });
        return patchwalkWorkerEventsResponseSchema.parse(response).events;
    }

    public async submitClaim(workerId: string, claim: PatchwalkWorkerClaim): Promise<void> {
        const parsedClaim = patchwalkWorkerClaimSchema.parse(claim);
        await this.requestJson(`/workers/${workerId}/claims`, {
            method: 'POST',
            body: JSON.stringify(parsedClaim),
        });
    }

    public async submitResult(workerId: string, result: PatchwalkWorkerResult): Promise<void> {
        await this.requestJson(`/workers/${workerId}/results`, {
            method: 'POST',
            body: JSON.stringify(result),
        });
    }

    public async shutdown(): Promise<void> {
        await this.requestJson('/daemon/shutdown', {
            method: 'POST',
        });
    }

    public async readStatusResource(): Promise<PatchwalkStatusResource> {
        const client = new Client({
            name: 'patchwalk-extension-client',
            version: '1.0.0',
        });
        const transport = new StreamableHTTPClientTransport(new URL(this.endpointUrl));

        try {
            await client.connect(transport);
            // Use the daemon's own status resource so one source of truth drives UI and tests.
            const result = await client.readResource({
                uri: PATCHWALK_STATUS_RESOURCE_URI,
            });
            const firstContent = result.contents[0];
            if (!firstContent || !('text' in firstContent)) {
                throw new Error('Patchwalk status resource did not return text content.');
            }

            return JSON.parse(firstContent.text) as PatchwalkStatusResource;
        } finally {
            await Promise.allSettled([transport.terminateSession(), transport.close()]);
        }
    }

    public async dispatchPlayback(payload: PatchwalkHandoffPayload): Promise<void> {
        const client = new Client({
            name: 'patchwalk-extension-client',
            version: '1.0.0',
        });
        const transport = new StreamableHTTPClientTransport(new URL(this.endpointUrl));

        try {
            await client.connect(transport);
            // Clipboard playback intentionally goes through MCP so it exercises the same routing path.
            const result = await client.callTool({
                name: PATCHWALK_PLAY_TOOL_NAME,
                arguments: payload,
            });
            if (result.isError) {
                const textContent = (result.content as Array<{ type: string; text?: string }>).find(
                    (contentBlock) => contentBlock.type === 'text',
                );
                throw new Error(
                    textContent?.text ?? 'Patchwalk daemon rejected the playback request.',
                );
            }
        } finally {
            await Promise.allSettled([transport.terminateSession(), transport.close()]);
        }
    }

    private async isHealthy(): Promise<boolean> {
        try {
            const health = await this.fetchHealth();
            return health.ok;
        } catch {
            return false;
        }
    }

    private async waitForHealthy(deadlineAt: number): Promise<void> {
        if (Date.now() > deadlineAt) {
            throw new Error('Patchwalk daemon did not become healthy after startup.');
        }

        if (await this.isHealthy()) {
            return;
        }

        await new Promise((resolve) => {
            setTimeout(resolve, 150);
        });

        await this.waitForHealthy(deadlineAt);
    }

    private async requestJson<T = unknown>(
        requestPath: string,
        options: {
            method: string;
            body?: string;
        },
    ): Promise<T> {
        const controller = createTimeoutController(10_000);
        const response = await fetch(`${this.baseUrl}${requestPath}`, {
            method: options.method,
            headers: {
                'content-type': 'application/json',
            },
            body: options.body,
            signal: controller.signal,
        });

        if (!response.ok) {
            const responseBody = await response.text();
            throw new Error(
                `Patchwalk daemon request failed (${response.status} ${response.statusText}): ${responseBody}`,
            );
        }

        return (await response.json()) as T;
    }
}
