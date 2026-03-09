import { canRenameProject, canViewProject } from '../auth/permissions.js';
import type { SessionContext } from '../auth/session.js';
import {
    findProjectBySlug,
    listProjectsForUser,
    renameProject as persistProjectRename,
} from '../data/mockDatabase.js';
import { listActivityFeed } from './activityFeedService.js';

export interface ProjectSummary {
    id: string;
    slug: string;
    name: string;
    status: 'active' | 'paused';
    monthlySpendUsd: number;
}

export interface ProjectOverview extends ProjectSummary {
    activityFeed: ReturnType<typeof listActivityFeed>;
    canRename: boolean;
}

export const listVisibleProjects = (session: SessionContext): ProjectSummary[] => {
    return listProjectsForUser(session.user.id).map((project) => ({
        id: project.id,
        slug: project.slug,
        name: project.name,
        status: project.status,
        monthlySpendUsd: project.monthlySpendUsd,
    }));
};

export const getProjectOverview = (
    session: SessionContext,
    slug: string,
): ProjectOverview => {
    const project = findProjectBySlug(slug);
    if (!project) {
        throw new Error(`Project not found: ${slug}`);
    }

    if (!canViewProject(session.user, project, session.claims.scopes)) {
        throw new Error(`User ${session.user.email} cannot access project ${slug}.`);
    }

    return {
        id: project.id,
        slug: project.slug,
        name: project.name,
        status: project.status,
        monthlySpendUsd: project.monthlySpendUsd,
        activityFeed: listActivityFeed(project.id),
        canRename: canRenameProject(session.user, project, session.claims.scopes),
    };
};

export const renameProject = (
    session: SessionContext,
    slug: string,
    nextName: string,
): ProjectOverview => {
    const project = findProjectBySlug(slug);
    if (!project) {
        throw new Error(`Project not found: ${slug}`);
    }

    if (!canRenameProject(session.user, project, session.claims.scopes)) {
        throw new Error(`User ${session.user.email} cannot rename project ${slug}.`);
    }

    const renamedProject = persistProjectRename(project.id, nextName);
    return getProjectOverview(session, renamedProject.slug);
};
