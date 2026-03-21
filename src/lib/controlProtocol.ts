import { z } from 'zod';

import { patchwalkHandoffPayloadSchema } from './schema';

/**
 * The daemon and every editor worker speak this private protocol over WebSocket. The MCP surface
 * remains public HTTP, while this contract stays focused on routing, liveness, and playback state.
 */
const nonEmptyStringSchema = z.string().min(1).regex(/\S/, 'must not be blank.');
const positiveIntegerSchema = z.number().int().gte(1);

export const PATCHWALK_WORKER_API_VERSION = '2.0.0';
export const PATCHWALK_DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
export const PATCHWALK_DEFAULT_RECONNECT_DELAY_MS = 1_000;
export const PATCHWALK_DEFAULT_PREPARE_TIMEOUT_MS = 300;
export const PATCHWALK_DEFAULT_STOP_TIMEOUT_MS = 10_000;
export const PATCHWALK_WORKER_SOCKET_PATH = '/workers/connect';

export const patchwalkPlaybackStateSchema = z.enum(['idle', 'playing', 'stopping']);
export const patchwalkPlaybackFailurePhaseSchema = z.enum(['prepare', 'execute', 'stop']);
export const patchwalkPlaybackFailureReasonCodeSchema = z.enum([
    'stale',
    'unavailable',
    'execution_failed',
    'stop_failed',
]);

const patchwalkWorkerPlaybackStateFieldsSchema = z
    .strictObject({
        playbackState: patchwalkPlaybackStateSchema,
        activeHandoffId: nonEmptyStringSchema.optional(),
    })
    .superRefine((value, context) => {
        if (value.playbackState === 'idle' && value.activeHandoffId) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Idle worker state must not include activeHandoffId.',
                path: ['activeHandoffId'],
            });
        }

        if (value.playbackState !== 'idle' && !value.activeHandoffId) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Active playback states must include activeHandoffId.',
                path: ['activeHandoffId'],
            });
        }
    });

const patchwalkWorkerMessageBaseSchema = z.strictObject({
    messageId: nonEmptyStringSchema,
    workerId: nonEmptyStringSchema,
    sentAt: z.iso.datetime({ offset: true }),
});

const patchwalkDaemonMessageBaseSchema = z.strictObject({
    messageId: nonEmptyStringSchema,
    workerId: nonEmptyStringSchema,
    sentAt: z.iso.datetime({ offset: true }),
});

export const patchwalkWorkerRegisterMessageSchema = patchwalkWorkerMessageBaseSchema
    .extend({
        type: z.literal('worker.register'),
        processId: positiveIntegerSchema,
        extensionVersion: nonEmptyStringSchema,
        workspaceRoots: z.array(nonEmptyStringSchema),
        lastSeenAt: z.iso.datetime({ offset: true }),
        apiVersion: z.literal(PATCHWALK_WORKER_API_VERSION),
    })
    .merge(patchwalkWorkerPlaybackStateFieldsSchema);

export const patchwalkWorkerUpdateMessageSchema = patchwalkWorkerMessageBaseSchema
    .extend({
        type: z.literal('worker.update'),
        workspaceRoots: z.array(nonEmptyStringSchema),
        lastSeenAt: z.iso.datetime({ offset: true }),
    })
    .merge(patchwalkWorkerPlaybackStateFieldsSchema);

export const patchwalkWorkerHeartbeatMessageSchema = patchwalkWorkerMessageBaseSchema
    .extend({
        type: z.literal('worker.heartbeat'),
        lastSeenAt: z.iso.datetime({ offset: true }),
    })
    .merge(patchwalkWorkerPlaybackStateFieldsSchema);

export const patchwalkPlaybackCompletedMessageSchema = patchwalkWorkerMessageBaseSchema.extend({
    type: z.literal('playback.completed'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    stepsPlayed: positiveIntegerSchema,
});

export const patchwalkPlaybackFailedMessageSchema = patchwalkWorkerMessageBaseSchema.extend({
    type: z.literal('playback.failed'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    phase: patchwalkPlaybackFailurePhaseSchema,
    reasonCode: patchwalkPlaybackFailureReasonCodeSchema,
    error: nonEmptyStringSchema,
});

export const patchwalkPlaybackStoppedMessageSchema = patchwalkWorkerMessageBaseSchema.extend({
    type: z.literal('playback.stopped'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
});

export const patchwalkWorkerToDaemonMessageSchema = z.discriminatedUnion('type', [
    patchwalkWorkerRegisterMessageSchema,
    patchwalkWorkerUpdateMessageSchema,
    patchwalkWorkerHeartbeatMessageSchema,
    patchwalkPlaybackCompletedMessageSchema,
    patchwalkPlaybackFailedMessageSchema,
    patchwalkPlaybackStoppedMessageSchema,
]);

export const patchwalkPlaybackPrepareMessageSchema = patchwalkDaemonMessageBaseSchema.extend({
    type: z.literal('playback.prepare'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    basePath: nonEmptyStringSchema,
});

export const patchwalkPlaybackExecuteMessageSchema = patchwalkDaemonMessageBaseSchema.extend({
    type: z.literal('playback.execute'),
    dispatchId: nonEmptyStringSchema,
    payload: patchwalkHandoffPayloadSchema,
});

export const patchwalkPlaybackStopMessageSchema = patchwalkDaemonMessageBaseSchema.extend({
    type: z.literal('playback.stop'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
});

export const patchwalkWorkerReconcileMessageSchema = patchwalkDaemonMessageBaseSchema.extend({
    type: z.literal('worker.reconcile'),
    reason: nonEmptyStringSchema,
});

export const patchwalkDaemonToWorkerMessageSchema = z.discriminatedUnion('type', [
    patchwalkPlaybackPrepareMessageSchema,
    patchwalkPlaybackExecuteMessageSchema,
    patchwalkPlaybackStopMessageSchema,
    patchwalkWorkerReconcileMessageSchema,
]);

export type PatchwalkPlaybackState = z.infer<typeof patchwalkPlaybackStateSchema>;
export type PatchwalkPlaybackFailurePhase = z.infer<typeof patchwalkPlaybackFailurePhaseSchema>;
export type PatchwalkPlaybackFailureReasonCode = z.infer<
    typeof patchwalkPlaybackFailureReasonCodeSchema
>;
export type PatchwalkWorkerRegisterMessage = z.infer<typeof patchwalkWorkerRegisterMessageSchema>;
export type PatchwalkWorkerUpdateMessage = z.infer<typeof patchwalkWorkerUpdateMessageSchema>;
export type PatchwalkWorkerHeartbeatMessage = z.infer<typeof patchwalkWorkerHeartbeatMessageSchema>;
export type PatchwalkPlaybackCompletedMessage = z.infer<
    typeof patchwalkPlaybackCompletedMessageSchema
>;
export type PatchwalkPlaybackFailedMessage = z.infer<typeof patchwalkPlaybackFailedMessageSchema>;
export type PatchwalkPlaybackStoppedMessage = z.infer<typeof patchwalkPlaybackStoppedMessageSchema>;
export type PatchwalkWorkerToDaemonMessage = z.infer<typeof patchwalkWorkerToDaemonMessageSchema>;
export type PatchwalkPlaybackPrepareMessage = z.infer<typeof patchwalkPlaybackPrepareMessageSchema>;
export type PatchwalkPlaybackExecuteMessage = z.infer<typeof patchwalkPlaybackExecuteMessageSchema>;
export type PatchwalkPlaybackStopMessage = z.infer<typeof patchwalkPlaybackStopMessageSchema>;
export type PatchwalkWorkerReconcileMessage = z.infer<typeof patchwalkWorkerReconcileMessageSchema>;
export type PatchwalkDaemonToWorkerMessage = z.infer<typeof patchwalkDaemonToWorkerMessageSchema>;
