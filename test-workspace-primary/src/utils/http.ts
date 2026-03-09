import type { IncomingMessage } from 'node:http';

export interface JsonResponse {
    statusCode: number;
    body: Record<string, unknown>;
}

export const json = (
    statusCode: number,
    body: Record<string, unknown>,
): JsonResponse => {
    return { statusCode, body };
};

export const notFound = (message: string): JsonResponse => {
    return json(404, { error: message });
};

export const badRequest = (message: string): JsonResponse => {
    return json(400, { error: message });
};

export const readJsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const rawBodyChunks: Uint8Array[] = [];

    for await (const chunk of request) {
        const normalizedChunk =
            typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
        rawBodyChunks.push(normalizedChunk);
    }

    const rawBody = Buffer.concat(rawBodyChunks).toString('utf8').trim();
    if (!rawBody) {
        return {};
    }

    const parsedBody = JSON.parse(rawBody) as unknown;
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
        throw new Error('Expected a JSON object payload.');
    }

    return parsedBody as Record<string, unknown>;
};
