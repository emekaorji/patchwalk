import { execFile, spawn } from 'node:child_process';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import type {
    PatchwalkWorkerClaim,
    PatchwalkWorkerEvent,
    PatchwalkWorkerHeartbeat,
    PatchwalkWorkerRegistration,
    PatchwalkWorkerRegistrationResponse,
    PatchwalkWorkerResult,
} from '../lib/controlProtocol';
import {
    patchwalkWorkerClaimSchema,
    patchwalkWorkerEventsResponseSchema,
    patchwalkWorkerRegistrationResponseSchema,
} from '../lib/controlProtocol';
import type { PatchwalkStatusResource } from '../lib/mcpCatalog';
import { PATCHWALK_PLAY_TOOL_NAME, PATCHWALK_STATUS_RESOURCE_URI } from '../lib/mcpCatalog';
import type { PatchwalkHandoffPayload } from '../lib/schema';

/**
 * The extension talks to the daemon through this small client wrapper so the worker controller does
 * not have to know about raw fetch calls or MCP client lifecycle details.
 */
interface PatchwalkDaemonClientOptions {
    daemonEntryPath: string;
    port: number;
}

const patchwalkDaemonHealthSchema = z.strictObject({
    ok: z.literal(true),
    endpointUrl: z.string().nullable(),
    daemonPid: z.number().int().gte(1),
    activeSessionCount: z.number().int().gte(0),
    workerCount: z.number().int().gte(0),
    activeDispatchCount: z.number().int().gte(0),
    serverKind: z.literal('patchwalk-daemon'),
    apiVersion: z.literal('1.0.0'),
});

type PatchwalkHealthResponse = z.infer<typeof patchwalkDaemonHealthSchema>;

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

const executeFile = async (
    file: string,
    args: string[],
): Promise<{
    stdout: string;
    stderr: string;
}> => {
    return new Promise((resolve, reject) => {
        execFile(file, args, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }

            resolve({
                stdout,
                stderr,
            });
        });
    });
};

const getPortListenerArgs = (port: number): string[] => {
    return ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'];
};

export class PatchwalkDaemonClient {
    private startupPromise: Promise<void> | undefined;

    public constructor(private readonly options: PatchwalkDaemonClientOptions) {}

    public get baseUrl(): string {
        // All extension-to-daemon traffic stays on localhost so no external broker is required.
        return `http://127.0.0.1:${this.options.port}`;
    }

    public get endpointUrl(): string {
        return `${this.baseUrl}/mcp`;
    }

    public async ensureServerRunning(): Promise<void> {
        if (this.startupPromise) {
            await this.startupPromise;
            return;
        }

        this.startupPromise = this.ensureServerRunningInternal().finally(() => {
            this.startupPromise = undefined;
        });
        await this.startupPromise;
    }

    public async fetchHealth(): Promise<PatchwalkHealthResponse> {
        // Health is the cheapest possible probe and avoids opening a full MCP session.
        return patchwalkDaemonHealthSchema.parse(
            await this.requestJson<unknown>('/health', {
                method: 'GET',
            }),
        );
    }

    public async shutdown(): Promise<void> {
        // Shutdown is used only by operator commands and tests.
        try {
            await this.requestJson('/daemon/shutdown', {
                method: 'POST',
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/404 Not Found/.test(message)) {
                throw error;
            }

            await this.terminateIncompatibleProcessOnPort();
        }
    }

    public async readStatusResource(): Promise<PatchwalkStatusResource> {
        await this.ensureServerRunning();
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
        await this.ensureServerRunning();
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

    private async ensureServerRunningInternal(): Promise<void> {
        const health = await this.fetchCompatibleHealth();
        if (health) {
            return;
        }

        await this.terminateIncompatibleProcessOnPort();

        // Windows race safely here: only one process can bind the port and the rest reconnect.
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

    private async fetchCompatibleHealth(): Promise<PatchwalkHealthResponse | undefined> {
        try {
            return await this.fetchHealth();
        } catch {
            return undefined;
        }
    }

    private async terminateIncompatibleProcessOnPort(): Promise<void> {
        if (process.platform === 'win32') {
            return;
        }

        let stdout = '';
        try {
            const result = await executeFile('lsof', getPortListenerArgs(this.options.port));
            stdout = result.stdout.trim();
        } catch {
            return;
        }

        const processIds = stdout
            .split(/\s+/)
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
        if (processIds.length === 0) {
            return;
        }

        for (const processId of processIds) {
            try {
                process.kill(Number(processId), 'SIGTERM');
            } catch {
                // If a process exits between lsof and kill, continue.
            }
        }

        await this.waitForPortToClear(Date.now() + 3_000);
    }

    private async waitForPortToClear(deadlineAt: number): Promise<void> {
        if (Date.now() > deadlineAt) {
            throw new Error(
                `Patchwalk could not reclaim port ${this.options.port} from an incompatible process.`,
            );
        }

        if (!(await this.fetchCompatibleHealth()) && !(await this.isPortOccupied())) {
            return;
        }

        await new Promise((resolve) => {
            setTimeout(resolve, 100);
        });

        await this.waitForPortToClear(deadlineAt);
    }

    private async isPortOccupied(): Promise<boolean> {
        if (process.platform === 'win32') {
            return false;
        }

        try {
            const result = await executeFile('lsof', getPortListenerArgs(this.options.port));
            return result.stdout.trim().length > 0;
        } catch {
            return false;
        }
    }

    private async isHealthy(): Promise<boolean> {
        return (await this.fetchCompatibleHealth()) !== undefined;
    }

    private async waitForHealthy(deadlineAt: number): Promise<void> {
        if (Date.now() > deadlineAt) {
            throw new Error('Patchwalk daemon did not become healthy after startup.');
        }

        if (await this.isHealthy()) {
            return;
        }

        // Keep retry intervals short so activation feels immediate after a cold start.
        await new Promise((resolve) => {
            setTimeout(resolve, 150);
        });

        await this.waitForHealthy(deadlineAt);
    }

    public async registerWorker(
        registration: PatchwalkWorkerRegistration,
    ): Promise<PatchwalkWorkerRegistrationResponse> {
        await this.ensureServerRunning();
        // Registration establishes worker ownership metadata and refreshes it after reconnects.
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
        await this.ensureServerRunning();
        await this.requestJson(`/workers/${workerId}/heartbeat`, {
            method: 'POST',
            body: JSON.stringify(heartbeat),
        });
    }

    public async pollEvents(workerId: string, waitMs: number): Promise<PatchwalkWorkerEvent[]> {
        await this.ensureServerRunning();
        // Long-polling keeps the control protocol simple without requiring a separate socket transport.
        const response = await this.requestJson(`/workers/${workerId}/events?waitMs=${waitMs}`, {
            method: 'GET',
        });
        return patchwalkWorkerEventsResponseSchema.parse(response).events;
    }

    public async submitClaim(workerId: string, claim: PatchwalkWorkerClaim): Promise<void> {
        await this.ensureServerRunning();
        const parsedClaim = patchwalkWorkerClaimSchema.parse(claim);
        await this.requestJson(`/workers/${workerId}/claims`, {
            method: 'POST',
            body: JSON.stringify(parsedClaim),
        });
    }

    public async submitResult(workerId: string, result: PatchwalkWorkerResult): Promise<void> {
        await this.ensureServerRunning();
        await this.requestJson(`/workers/${workerId}/results`, {
            method: 'POST',
            body: JSON.stringify(result),
        });
    }

    private async requestJson<T = unknown>(
        requestPath: string,
        options: {
            method: string;
            body?: string;
        },
    ): Promise<T> {
        // Every daemon call gets a timeout so broken local networking does not wedge the extension host.
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
