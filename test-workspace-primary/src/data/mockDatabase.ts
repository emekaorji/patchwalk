export type UserRole = 'viewer' | 'maintainer' | 'owner';

export interface UserRecord {
    id: string;
    email: string;
    displayName: string;
    role: UserRole;
}

export interface ProjectRecord {
    id: string;
    slug: string;
    name: string;
    status: 'active' | 'paused';
    ownerUserId: string;
    contributorUserIds: string[];
    monthlySpendUsd: number;
}

export interface ActivityRecord {
    id: string;
    projectId: string;
    actorUserId: string;
    summary: string;
    createdAt: string;
}

const users: UserRecord[] = [
    { id: 'user_1', email: 'ada@jungaria.dev', displayName: 'Ada Nnaji', role: 'owner' },
    { id: 'user_2', email: 'milo@jungaria.dev', displayName: 'Milo Kareem', role: 'maintainer' },
    { id: 'user_3', email: 'ruth@jungaria.dev', displayName: 'Ruth Okafor', role: 'viewer' },
];

const projects: ProjectRecord[] = [
    {
        id: 'project_1',
        slug: 'apollo',
        name: 'Apollo Billing',
        status: 'active',
        ownerUserId: 'user_1',
        contributorUserIds: ['user_2'],
        monthlySpendUsd: 18240,
    },
    {
        id: 'project_2',
        slug: 'harbor',
        name: 'Harbor Mobile API',
        status: 'paused',
        ownerUserId: 'user_1',
        contributorUserIds: ['user_2', 'user_3'],
        monthlySpendUsd: 6420,
    },
];

const activities: ActivityRecord[] = [
    {
        id: 'activity_1',
        projectId: 'project_1',
        actorUserId: 'user_2',
        summary: 'Rotated webhook signing keys for the billing service.',
        createdAt: '2026-03-05T08:15:00Z',
    },
    {
        id: 'activity_2',
        projectId: 'project_1',
        actorUserId: 'user_1',
        summary: 'Approved the March cost forecast.',
        createdAt: '2026-03-05T14:00:00Z',
    },
    {
        id: 'activity_3',
        projectId: 'project_2',
        actorUserId: 'user_3',
        summary: 'Prepared release notes for the paused migration branch.',
        createdAt: '2026-03-04T17:20:00Z',
    },
];

export const findUserById = (userId: string): UserRecord | undefined => {
    return users.find((user) => user.id === userId);
};

export const findUserByEmail = (email: string): UserRecord | undefined => {
    return users.find((user) => user.email.toLowerCase() === email.toLowerCase());
};

export const listProjectsForUser = (userId: string): ProjectRecord[] => {
    return projects.filter((project) => {
        return project.ownerUserId === userId || project.contributorUserIds.includes(userId);
    });
};

export const findProjectBySlug = (slug: string): ProjectRecord | undefined => {
    return projects.find((project) => project.slug === slug);
};

export const listRecentActivityForProject = (
    projectId: string,
    limit = 5,
): ActivityRecord[] => {
    return activities
        .filter((activity) => activity.projectId === projectId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit);
};

export const renameProject = (projectId: string, nextName: string): ProjectRecord => {
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) {
        throw new Error(`Unknown project: ${projectId}`);
    }

    project.name = nextName.trim();
    return project;
};
