import type { IncomingMessage } from 'node:http';

import { requireSession } from '../auth/session.js';
import { getProjectOverview, listVisibleProjects, renameProject } from '../services/projectService.js';
import { badRequest, json, type JsonResponse, readJsonBody } from '../utils/http.js';

export const handleProjectIndexRequest = (request: IncomingMessage): JsonResponse => {
    const session = requireSession(request.headers.authorization);

    return json(200, {
        projects: listVisibleProjects(session),
    });
};

export const handleProjectDetailsRequest = (
    request: IncomingMessage,
    projectSlug: string,
): JsonResponse => {
    const session = requireSession(request.headers.authorization);

    return json(200, {
        project: getProjectOverview(session, projectSlug),
    });
};

export const handleProjectRenameRequest = async (
    request: IncomingMessage,
    projectSlug: string,
): Promise<JsonResponse> => {
    const session = requireSession(request.headers.authorization);
    const body = await readJsonBody(request);
    const nextName = body.name;

    if (typeof nextName !== 'string' || nextName.trim().length < 3) {
        return badRequest('Project name must be at least 3 characters long.');
    }

    return json(200, {
        project: renameProject(session, projectSlug, nextName),
    });
};
