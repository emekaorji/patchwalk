import type { ProjectRecord, UserRecord } from '../data/mockDatabase.js';

const hasScope = (scopes: string[], scope: string): boolean => {
    return scopes.includes(scope);
};

export const canViewProject = (
    user: UserRecord,
    project: ProjectRecord,
    scopes: string[],
): boolean => {
    if (user.role === 'owner') {
        return true;
    }

    return hasScope(scopes, 'projects:read')
        && (project.ownerUserId === user.id || project.contributorUserIds.includes(user.id));
};

export const canRenameProject = (
    user: UserRecord,
    project: ProjectRecord,
    scopes: string[],
): boolean => {
    return user.role !== 'viewer'
        && hasScope(scopes, 'projects:write')
        && (project.ownerUserId === user.id || project.contributorUserIds.includes(user.id));
};

export const canManageBilling = (user: UserRecord, scopes: string[]): boolean => {
    return user.role === 'owner' && hasScope(scopes, 'billing:write');
};
