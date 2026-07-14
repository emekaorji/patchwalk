import { z } from 'zod';

import { patchwalkHandoffPayloadSchema } from './schema';

/**
 * The daemon and every editor worker speak this private protocol over WebSocket. The MCP surface
 * remains public HTTP, while this contract stays focused on routing, liveness, and playback state.
 *
 * Protocol v2.1 makes the prepare handshake POSITIVE (`playback.ready`), makes playback launch
 * observable without blocking (`playback.started` + `playback.progress`), and adds interactive
 * transport controls (`pause`/`resume`/`next`/`previous`) so the sidebar can drive a live walk.
 */
const nonEmptyStringSchema = z.string().min(1).regex(/\S/, 'must not be blank.');
const positiveIntegerSchema = z.number().int().gte(1);
const nonNegativeIntegerSchema = z.number().int().gte(0);

export const PATCHWALK_WORKER_API_VERSION = '2.1.0';
export const PATCHWALK_DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
export const PATCHWALK_DEFAULT_RECONNECT_DELAY_MS = 1_000;
/** Ceiling for the reconnect backoff — a blocked port must not become a retry storm. */
export const MAXIMUM_RECONNECT_DELAY_MS = 30_000;
/** @deprecated Superseded by the positive `playback.ready` ack; kept for compatibility. */
export const PATCHWALK_DEFAULT_PREPARE_TIMEOUT_MS = 300;
/** How long the daemon waits for a positive `playback.ready` before failing over to the next window. */
export const PATCHWALK_DEFAULT_READY_TIMEOUT_MS = 2_000;
export const PATCHWALK_DEFAULT_STOP_TIMEOUT_MS = 10_000;
export const PATCHWALK_WORKER_SOCKET_PATH = '/workers/connect';

export const patchwalkPlaybackStateSchema = z.enum(['idle', 'playing', 'paused', 'stopping']);
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

/**
 * The narration style is a MACHINE-WIDE (application-scoped) setting, but the daemon is a separate
 * process that cannot read VS Code settings. Windows report it here, and the daemon uses it to
 * build the instructions + tool schema it hands to authoring agents. Every window reports the same
 * value (the setting cannot be workspace-scoped), so whichever reports last is authoritative.
 */
export const patchwalkNarrationStyleSchema = z.enum(['terse', 'grounded']);

export const patchwalkWorkerRegisterMessageSchema = patchwalkWorkerMessageBaseSchema
    .extend({
        type: z.literal('worker.register'),
        processId: positiveIntegerSchema,
        extensionVersion: nonEmptyStringSchema,
        workspaceRoots: z.array(nonEmptyStringSchema),
        lastSeenAt: z.iso.datetime({ offset: true }),
        apiVersion: z.literal(PATCHWALK_WORKER_API_VERSION),
        narrationStyle: patchwalkNarrationStyleSchema.optional(),
    })
    .merge(patchwalkWorkerPlaybackStateFieldsSchema);

export const patchwalkWorkerUpdateMessageSchema = patchwalkWorkerMessageBaseSchema
    .extend({
        type: z.literal('worker.update'),
        workspaceRoots: z.array(nonEmptyStringSchema),
        lastSeenAt: z.iso.datetime({ offset: true }),
        narrationStyle: patchwalkNarrationStyleSchema.optional(),
    })
    .merge(patchwalkWorkerPlaybackStateFieldsSchema);

export const patchwalkWorkerHeartbeatMessageSchema = patchwalkWorkerMessageBaseSchema
    .extend({
        type: z.literal('worker.heartbeat'),
        lastSeenAt: z.iso.datetime({ offset: true }),
    })
    .merge(patchwalkWorkerPlaybackStateFieldsSchema);

/** Positive prepare acknowledgement: this window can serve the requested basePath right now. */
export const patchwalkPlaybackReadyMessageSchema = patchwalkWorkerMessageBaseSchema.extend({
    type: z.literal('playback.ready'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
});

/** Launch acknowledgement: the window accepted the walk and playback has begun. */
export const patchwalkPlaybackStartedMessageSchema = patchwalkWorkerMessageBaseSchema.extend({
    type: z.literal('playback.started'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    stepCount: positiveIntegerSchema,
});

/** Emitted whenever the active step (or playback state) changes; drives sidebars and status. */
export const patchwalkPlaybackProgressMessageSchema = patchwalkWorkerMessageBaseSchema.extend({
    type: z.literal('playback.progress'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    stepIndex: nonNegativeIntegerSchema,
    stepCount: positiveIntegerSchema,
    stepId: nonEmptyStringSchema,
    playbackState: patchwalkPlaybackStateSchema,
});

export const patchwalkPlaybackPausedMessageSchema = patchwalkWorkerMessageBaseSchema.extend({
    type: z.literal('playback.paused'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    stepIndex: nonNegativeIntegerSchema,
});

export const patchwalkPlaybackResumedMessageSchema = patchwalkWorkerMessageBaseSchema.extend({
    type: z.literal('playback.resumed'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    stepIndex: nonNegativeIntegerSchema,
});

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
    patchwalkPlaybackReadyMessageSchema,
    patchwalkPlaybackStartedMessageSchema,
    patchwalkPlaybackProgressMessageSchema,
    patchwalkPlaybackPausedMessageSchema,
    patchwalkPlaybackResumedMessageSchema,
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

export const patchwalkPlaybackPauseMessageSchema = patchwalkDaemonMessageBaseSchema.extend({
    type: z.literal('playback.pause'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
});

export const patchwalkPlaybackResumeMessageSchema = patchwalkDaemonMessageBaseSchema.extend({
    type: z.literal('playback.resume'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
});

export const patchwalkPlaybackNextMessageSchema = patchwalkDaemonMessageBaseSchema.extend({
    type: z.literal('playback.next'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
});

export const patchwalkPlaybackPreviousMessageSchema = patchwalkDaemonMessageBaseSchema.extend({
    type: z.literal('playback.previous'),
    dispatchId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
});

export const patchwalkWorkerReconcileMessageSchema = patchwalkDaemonMessageBaseSchema.extend({
    type: z.literal('worker.reconcile'),
    reason: nonEmptyStringSchema,
});

/**
 * Broadcast to EVERY connected worker whenever the machine's single active walk starts or ends, so
 * every window can show which one is playing. `ownerWorkerId` identifies the playing window
 * (compare to your own id); `revealPath` is the matched workspace root a non-playing window can use
 * to raise the playing window via the editor CLI. When `active` is false the fields are cleared.
 */
export const patchwalkWalkOwnerMessageSchema = patchwalkDaemonMessageBaseSchema.extend({
    type: z.literal('walk.owner'),
    active: z.boolean(),
    ownerWorkerId: nonEmptyStringSchema.optional(),
    handoffId: nonEmptyStringSchema.optional(),
    revealPath: nonEmptyStringSchema.optional(),
});

export const patchwalkDaemonToWorkerMessageSchema = z.discriminatedUnion('type', [
    patchwalkPlaybackPrepareMessageSchema,
    patchwalkPlaybackExecuteMessageSchema,
    patchwalkPlaybackStopMessageSchema,
    patchwalkPlaybackPauseMessageSchema,
    patchwalkPlaybackResumeMessageSchema,
    patchwalkPlaybackNextMessageSchema,
    patchwalkPlaybackPreviousMessageSchema,
    patchwalkWorkerReconcileMessageSchema,
    patchwalkWalkOwnerMessageSchema,
]);

export type PatchwalkPlaybackState = z.infer<typeof patchwalkPlaybackStateSchema>;
export type PatchwalkPlaybackFailurePhase = z.infer<typeof patchwalkPlaybackFailurePhaseSchema>;
export type PatchwalkPlaybackFailureReasonCode = z.infer<
    typeof patchwalkPlaybackFailureReasonCodeSchema
>;
export type PatchwalkWorkerRegisterMessage = z.infer<typeof patchwalkWorkerRegisterMessageSchema>;
export type PatchwalkWorkerUpdateMessage = z.infer<typeof patchwalkWorkerUpdateMessageSchema>;
export type PatchwalkWorkerHeartbeatMessage = z.infer<typeof patchwalkWorkerHeartbeatMessageSchema>;
export type PatchwalkPlaybackReadyMessage = z.infer<typeof patchwalkPlaybackReadyMessageSchema>;
export type PatchwalkPlaybackStartedMessage = z.infer<typeof patchwalkPlaybackStartedMessageSchema>;
export type PatchwalkPlaybackProgressMessage = z.infer<
    typeof patchwalkPlaybackProgressMessageSchema
>;
export type PatchwalkPlaybackPausedMessage = z.infer<typeof patchwalkPlaybackPausedMessageSchema>;
export type PatchwalkPlaybackResumedMessage = z.infer<typeof patchwalkPlaybackResumedMessageSchema>;
export type PatchwalkPlaybackCompletedMessage = z.infer<
    typeof patchwalkPlaybackCompletedMessageSchema
>;
export type PatchwalkPlaybackFailedMessage = z.infer<typeof patchwalkPlaybackFailedMessageSchema>;
export type PatchwalkPlaybackStoppedMessage = z.infer<typeof patchwalkPlaybackStoppedMessageSchema>;
export type PatchwalkWorkerToDaemonMessage = z.infer<typeof patchwalkWorkerToDaemonMessageSchema>;
export type PatchwalkPlaybackPrepareMessage = z.infer<typeof patchwalkPlaybackPrepareMessageSchema>;
export type PatchwalkPlaybackExecuteMessage = z.infer<typeof patchwalkPlaybackExecuteMessageSchema>;
export type PatchwalkPlaybackStopMessage = z.infer<typeof patchwalkPlaybackStopMessageSchema>;
export type PatchwalkPlaybackPauseMessage = z.infer<typeof patchwalkPlaybackPauseMessageSchema>;
export type PatchwalkPlaybackResumeMessage = z.infer<typeof patchwalkPlaybackResumeMessageSchema>;
export type PatchwalkPlaybackNextMessage = z.infer<typeof patchwalkPlaybackNextMessageSchema>;
export type PatchwalkPlaybackPreviousMessage = z.infer<
    typeof patchwalkPlaybackPreviousMessageSchema
>;
export type PatchwalkWorkerReconcileMessage = z.infer<typeof patchwalkWorkerReconcileMessageSchema>;
export type PatchwalkWalkOwnerMessage = z.infer<typeof patchwalkWalkOwnerMessageSchema>;
export type PatchwalkDaemonToWorkerMessage = z.infer<typeof patchwalkDaemonToWorkerMessageSchema>;
