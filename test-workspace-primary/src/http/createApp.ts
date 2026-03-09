import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleProjectDetailsRequest, handleProjectIndexRequest, handleProjectRenameRequest } from '../routes/projectRoutes.js';
import { appConfig } from '../config/env.js';
import { json, notFound } from '../utils/http.js';

const sendJson = (response: ServerResponse, statusCode: number, body: Record<string, unknown>) => {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body, null, 2));
};

export const createApp = () => {
    return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
        const pathname = requestUrl.pathname;

        try {
            if (request.method === 'GET' && pathname === '/health') {
                sendJson(response, 200, {
                    ok: true,
                    environment: appConfig.environment,
                });
                return;
            }

            if (request.method === 'GET' && pathname === '/projects') {
                const result = handleProjectIndexRequest(request);
                sendJson(response, result.statusCode, result.body);
                return;
            }

            const projectMatch = /^\/projects\/(?<projectSlug>[a-z0-9-]+)$/.exec(pathname);
            if (request.method === 'GET' && projectMatch?.groups?.projectSlug) {
                const result = handleProjectDetailsRequest(request, projectMatch.groups.projectSlug);
                sendJson(response, result.statusCode, result.body);
                return;
            }

            const renameMatch = /^\/projects\/(?<projectSlug>[a-z0-9-]+)\/rename$/.exec(pathname);
            if (request.method === 'POST' && renameMatch?.groups?.projectSlug) {
                const result = await handleProjectRenameRequest(
                    request,
                    renameMatch.groups.projectSlug,
                );
                sendJson(response, result.statusCode, result.body);
                return;
            }

            const missingRoute = notFound(`No route registered for ${request.method} ${pathname}`);
            sendJson(response, missingRoute.statusCode, missingRoute.body);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown request failure.';
            const result = json(500, { error: message });
            sendJson(response, result.statusCode, result.body);
        }
    };
};
