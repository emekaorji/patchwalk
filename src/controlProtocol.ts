import { z } from 'zod';

import { patchwalkHandoffPayloadSchema } from './schema';

/**
 * The daemon and every live editor window speak this local control protocol. Keeping it in one file
 * makes it obvious which messages belong to the extension-facing transport and which belong to the
 * public MCP surface.
 */
const nonEmptyStringSchema = z.string().min(1).regex(/\S/, 'must not be blank.');
const positiveIntegerSchema = z.number().int().gte(1);

// Version the private worker protocol separately from the public handoff schema.
export const PATCHWALK_WORKER_API_VERSION = '1.0.0';
export const PATCHWALK_DEFAULT_POLL_INTERVAL_MS = 1_000;
export const PATCHWALK_DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

// Workers describe who they are and which workspace roots they currently own.
export const patchwalkWorkerRegistrationSchema = z.strictObject({
    workerId: nonEmptyStringSchema,
    processId: positiveIntegerSchema,
    extensionVersion: nonEmptyStringSchema,
    workspaceRoots: z.array(nonEmptyStringSchema),
    lastSeenAt: z.iso.datetime({ offset: true }),
    apiVersion: z.literal(PATCHWALK_WORKER_API_VERSION),
});

// The daemon controls poll/heartbeat cadence so it can be tuned centrally later.
export const patchwalkWorkerRegistrationResponseSchema = z.strictObject({
    workerId: nonEmptyStringSchema,
    daemonPid: positiveIntegerSchema.optional(),
    pollIntervalMs: positiveIntegerSchema,
    heartbeatIntervalMs: positiveIntegerSchema,
});

// Heartbeats refresh liveness and let workers publish workspace root changes.
export const patchwalkWorkerHeartbeatSchema = z.strictObject({
    workspaceRoots: z.array(nonEmptyStringSchema),
    lastSeenAt: z.iso.datetime({ offset: true }),
});

// Claim events are intentionally small because they fan out to every live worker.
export const patchwalkPlaybackClaimEventSchema = z.strictObject({
    type: z.literal('playback.claim'),
    eventId: nonEmptyStringSchema,
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    basePath: nonEmptyStringSchema,
});

// Execute events carry the validated payload only after one worker wins routing.
export const patchwalkPlaybackExecuteEventSchema = z.strictObject({
    type: z.literal('playback.execute'),
    eventId: nonEmptyStringSchema,
    dispatchId: nonEmptyStringSchema,
    payload: patchwalkHandoffPayloadSchema,
});

export const patchwalkPlaybackCancelEventSchema = z.strictObject({
    type: z.literal('playback.cancel'),
    eventId: nonEmptyStringSchema,
    dispatchId: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
});

// Reconcile tells workers to discard long-poll state and resynchronize.
export const patchwalkWorkerReconcileEventSchema = z.strictObject({
    type: z.literal('worker.reconcile'),
    eventId: nonEmptyStringSchema,
});

// The worker event stream is closed-world on purpose so unexpected messages fail fast.
export const patchwalkWorkerEventSchema = z.discriminatedUnion('type', [
    patchwalkPlaybackClaimEventSchema,
    patchwalkPlaybackExecuteEventSchema,
    patchwalkPlaybackCancelEventSchema,
    patchwalkWorkerReconcileEventSchema,
]);

export const patchwalkWorkerEventsResponseSchema = z.strictObject({
    events: z.array(patchwalkWorkerEventSchema),
    pollIntervalMs: positiveIntegerSchema,
});

// Accepted claims must be specific enough for deterministic winner selection.
export const patchwalkWorkerClaimSchema = z
    .strictObject({
        dispatchId: nonEmptyStringSchema,
        accepted: z.boolean(),
        matchedRoot: nonEmptyStringSchema.optional(),
        matchKind: z.enum(['exact', 'parent']).optional(),
    })
    .superRefine((value, context) => {
        if (value.accepted && (!value.matchedRoot || !value.matchKind)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Accepted claims must include matchedRoot and matchKind.',
                path: ['accepted'],
            });
        }

        if (!value.accepted && (value.matchedRoot || value.matchKind)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Rejected claims must not include matchedRoot or matchKind.',
                path: ['accepted'],
            });
        }
    });

// Worker results are the only thing that can complete an in-flight dispatch.
export const patchwalkWorkerResultSchema = z
    .strictObject({
        dispatchId: nonEmptyStringSchema,
        handoffId: nonEmptyStringSchema,
        status: z.enum(['completed', 'failed']),
        stepsPlayed: positiveIntegerSchema.optional(),
        error: nonEmptyStringSchema.optional(),
    })
    .superRefine((value, context) => {
        if (value.status === 'completed' && value.stepsPlayed === undefined) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Completed results must include stepsPlayed.',
                path: ['stepsPlayed'],
            });
        }

        if (value.status === 'failed' && !value.error) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Failed results must include error.',
                path: ['error'],
            });
        }
    });

export type PatchwalkWorkerRegistration = z.infer<typeof patchwalkWorkerRegistrationSchema>;
export type PatchwalkWorkerRegistrationResponse = z.infer<
    typeof patchwalkWorkerRegistrationResponseSchema
>;
export type PatchwalkWorkerHeartbeat = z.infer<typeof patchwalkWorkerHeartbeatSchema>;
export type PatchwalkPlaybackClaimEvent = z.infer<typeof patchwalkPlaybackClaimEventSchema>;
export type PatchwalkPlaybackExecuteEvent = z.infer<typeof patchwalkPlaybackExecuteEventSchema>;
export type PatchwalkPlaybackCancelEvent = z.infer<typeof patchwalkPlaybackCancelEventSchema>;
export type PatchwalkWorkerReconcileEvent = z.infer<typeof patchwalkWorkerReconcileEventSchema>;
export type PatchwalkWorkerEvent = z.infer<typeof patchwalkWorkerEventSchema>;
export type PatchwalkWorkerEventsResponse = z.infer<typeof patchwalkWorkerEventsResponseSchema>;
export type PatchwalkWorkerClaim = z.infer<typeof patchwalkWorkerClaimSchema>;
export type PatchwalkWorkerResult = z.infer<typeof patchwalkWorkerResultSchema>;
