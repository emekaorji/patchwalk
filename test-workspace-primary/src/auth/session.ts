import { Buffer } from 'node:buffer';

import { findUserByEmail, findUserById, type UserRecord } from '../data/mockDatabase.js';

export interface SessionClaims {
    userId: string;
    email: string;
    scopes: string[];
}

export interface SessionContext {
    user: UserRecord;
    claims: SessionClaims;
}

export const parseSessionToken = (authorizationHeader: string | undefined): SessionClaims => {
    if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
        throw new Error('Missing bearer token.');
    }

    const rawToken = authorizationHeader.slice('Bearer '.length);
    const decodedPayload = Buffer.from(rawToken, 'base64url').toString('utf8');
    const parsedClaims = JSON.parse(decodedPayload) as Partial<SessionClaims>;

    if (!parsedClaims.userId || !parsedClaims.email) {
        throw new Error('Session token is missing required claims.');
    }

    return {
        userId: parsedClaims.userId,
        email: parsedClaims.email,
        scopes: parsedClaims.scopes ?? [],
    };
};

export const requireSession = (authorizationHeader: string | undefined): SessionContext => {
    const claims = parseSessionToken(authorizationHeader);
    const user = findUserById(claims.userId) ?? findUserByEmail(claims.email);

    if (!user) {
        throw new Error(`No user found for ${claims.email}.`);
    }

    return { user, claims };
};

export const buildDemoToken = (claims: SessionClaims): string => {
    const encodedClaims = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    return `Bearer ${encodedClaims}`;
};
