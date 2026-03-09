import {
    findUserById,
    listRecentActivityForProject,
} from '../data/mockDatabase.js';

export interface ActivityFeedItem {
    id: string;
    actorName: string;
    summary: string;
    createdAt: string;
}

export const listActivityFeed = (projectId: string): ActivityFeedItem[] => {
    return listRecentActivityForProject(projectId).map((activity) => {
        const actor = findUserById(activity.actorUserId);

        return {
            id: activity.id,
            actorName: actor?.displayName ?? 'Unknown teammate',
            summary: activity.summary,
            createdAt: activity.createdAt,
        };
    });
};
