import path from 'node:path';

import { z } from 'zod';

/**
 * The public handoff payload is intentionally strict because it crosses process boundaries and
 * eventually drives editor navigation and narration.
 */
const nonEmptyStringPattern = /\S/;

const nonEmptyStringSchema = z
    .string()
    .min(1, 'must not be empty.')
    .regex(nonEmptyStringPattern, 'must contain at least one non-whitespace character.');

// These payloads are consumed by humans during playback, so line numbers must stay positive.
const positiveIntegerSchema = z.number().int().gte(1);

/**
 * How much the agent is allowed to say.
 *
 * `terse` — dense, high-signal lines. The default: a walk is HEARD, and a human cannot skim audio.
 * `grounded` — longer, more explanatory narration for onboarding or unfamiliar code.
 *
 * This is a MACHINE-WIDE choice, not a per-project one: it changes the instructions and the tool
 * schema the daemon hands to authoring agents, and the daemon serves every window. The VS Code
 * setting is therefore `scope: "application"` (user settings only, never workspace).
 */
export type PatchwalkNarrationStyle = 'terse' | 'grounded';

export const PATCHWALK_DEFAULT_NARRATION_STYLE: PatchwalkNarrationStyle = 'terse';

export interface PatchwalkNarrationLimits {
    summary: number;
    step: number;
    segment: number;
    title: number;
    /** The target band for a sub-segment, quoted to the agent in the tool schema. */
    segmentAim: string;
}

/**
 * Caps on every SPOKEN string. Guidance alone did not hold (agents write long), so length is a
 * GATE, enforced in two places at once: these become `maxLength` in the play tool's JSON Schema (so
 * the authoring model sees the limit WHILE it writes), and an over-long walk is rejected outright.
 */
export const PATCHWALK_NARRATION_LIMITS: Record<PatchwalkNarrationStyle, PatchwalkNarrationLimits> =
    {
        terse: { summary: 350, step: 220, segment: 150, title: 60, segmentAim: '40-110' },
        grounded: { summary: 700, step: 500, segment: 320, title: 80, segmentAim: '120-260' },
    };

/** The most permissive limits — the WIRE contract, so any style's payload survives the protocol. */
const wireLimits: PatchwalkNarrationLimits = PATCHWALK_NARRATION_LIMITS.grounded;

const spokenLineSchema = (maxChars: number, description: string) =>
    z
        .string()
        .min(1, 'must not be empty.')
        .regex(nonEmptyStringPattern, 'must contain at least one non-whitespace character.')
        .max(
            maxChars,
            `must be at most ${maxChars} characters. This is spoken ALOUD to a human who cannot skim it — cut to the signal: what changed, why, what it risks. Delete filler, hedging, and anything that restates the code.`,
        )
        .describe(description);

// Target type is metadata for tools and navigation hints, not the primary playback mechanism.
export const patchwalkTargetTypeSchema = z.enum(['symbol', 'range', 'line']);

export const patchwalkRangeSchema = z
    .strictObject({
        startLine: positiveIntegerSchema,
        endLine: positiveIntegerSchema,
    })
    .superRefine((value, context) => {
        // Reversed ranges make playback highlights confusing, so reject them up front.
        if (value.endLine < value.startLine) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['endLine'],
                message: 'must be greater than or equal to startLine.',
            });
        }
    });

export const patchwalkProducerSchema = z.strictObject({
    agent: nonEmptyStringSchema,
    agentVersion: nonEmptyStringSchema.optional(),
    model: nonEmptyStringSchema.optional(),
});

/**
 * A sub-segment refines a step into a shorter, narrower spoken beat: while its own tighter `range`
 * is highlighted (a subtitle synced to the code), `narration` is the next line of the passage. A
 * step plays its overview first (the broad `range` + `narration`), then each sub-segment in order,
 * progressively narrowing the highlighted selection. Steps without `segments` behave as before.
 */
export const createPatchwalkWalkthroughSegmentSchema = (limits: PatchwalkNarrationLimits) =>
    z.strictObject({
        id: nonEmptyStringSchema.optional(),
        narration: spokenLineSchema(
            limits.segment,
            `The next line of ONE continuous spoken passage, said while these exact lines are highlighted. Aim for ${limits.segmentAim} characters. It must CONTINUE from the previous line — pick up where it left off, do not re-introduce the file or restate context the listener just heard. No filler, no code read aloud, no line numbers.`,
        ),
        range: patchwalkRangeSchema,
    });

export const createPatchwalkWalkthroughStepSchema = (limits: PatchwalkNarrationLimits) =>
    z
        .strictObject({
            id: nonEmptyStringSchema,
            title: nonEmptyStringSchema
                .max(limits.title, `must be at most ${limits.title} characters.`)
                .describe(
                    'Short sidebar label naming the subsystem or decision (not the file name). Not spoken.',
                ),
            narration: spokenLineSchema(
                limits.step,
                'The spoken opening of this step, said while the whole range is highlighted. It CONTINUES the passage from the previous step — bridge into it, do not start over. Say what this code does and why it matters; the sub-segments then narrow into the detail, so do not front-load it here.',
            ),
            path: nonEmptyStringSchema,
            type: patchwalkTargetTypeSchema.optional(),
            symbol: nonEmptyStringSchema.optional(),
            range: patchwalkRangeSchema,
            segments: z
                .array(createPatchwalkWalkthroughSegmentSchema(limits))
                .min(1, 'must contain at least one sub-segment when present.')
                .optional(),
        })
        .superRefine((step, context) => {
            // A sub-segment is a tighter selection INSIDE the step; the progressive broad→narrow model
            // (and the highlight) only makes sense when each sub-range sits within the step range.
            (step.segments ?? []).forEach((segment, index) => {
                if (
                    segment.range.startLine < step.range.startLine ||
                    segment.range.endLine > step.range.endLine
                ) {
                    context.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: ['segments', index, 'range'],
                        message: 'must be within the parent step range.',
                    });
                }
            });
        });

/**
 * The payload schema for a given narration style. The style's caps become `maxLength` in the play
 * tool's JSON Schema, so the authoring agent is gated at the moment it writes.
 */
export const createPatchwalkHandoffPayloadSchema = (limits: PatchwalkNarrationLimits) =>
    z.strictObject({
        $schema: nonEmptyStringSchema.optional(),
        specVersion: nonEmptyStringSchema,
        handoffId: nonEmptyStringSchema,
        createdAt: z.iso.datetime({ offset: true }),
        // Routing depends on this being absolute before the daemon sees the payload.
        basePath: nonEmptyStringSchema.refine((value) => path.isAbsolute(value), {
            message: 'must be an absolute filesystem path.',
        }),
        producer: patchwalkProducerSchema,
        summary: spokenLineSchema(
            limits.summary,
            'The spoken opening of ONE continuous passage. Set up what this change does and why, and lead straight into the first step — the steps and sub-segments that follow must read as the SAME talk, not separate blurbs.',
        ),
        walkthrough: z
            .array(createPatchwalkWalkthroughStepSchema(limits))
            .min(1, 'must contain at least one step.'),
    });

export const patchwalkNarrationLimits = (
    style: PatchwalkNarrationStyle,
): PatchwalkNarrationLimits =>
    PATCHWALK_NARRATION_LIMITS[style] ??
    PATCHWALK_NARRATION_LIMITS[PATCHWALK_DEFAULT_NARRATION_STYLE];

export const patchwalkWalkthroughSegmentSchema =
    createPatchwalkWalkthroughSegmentSchema(wireLimits);
export const patchwalkWalkthroughStepSchema = createPatchwalkWalkthroughStepSchema(wireLimits);

/**
 * The canonical WIRE schema, built from the most permissive limits so a payload authored in ANY
 * style survives the daemon→worker protocol. The style-specific cap is applied at the authoring
 * boundary (the MCP play tool), which is where the gate actually belongs.
 */
export const patchwalkHandoffPayloadSchema = createPatchwalkHandoffPayloadSchema(wireLimits);

export type PatchwalkTargetType = z.infer<typeof patchwalkTargetTypeSchema>;
export type PatchwalkRange = z.infer<typeof patchwalkRangeSchema>;
export type PatchwalkProducer = z.infer<typeof patchwalkProducerSchema>;
export type PatchwalkWalkthroughSegment = z.infer<typeof patchwalkWalkthroughSegmentSchema>;
export type PatchwalkWalkthroughStep = z.infer<typeof patchwalkWalkthroughStepSchema>;
export type PatchwalkHandoffPayload = z.infer<typeof patchwalkHandoffPayloadSchema>;

interface PatchwalkValidationSuccess {
    ok: true;
    value: PatchwalkHandoffPayload;
}

interface PatchwalkValidationFailure {
    ok: false;
    error: string;
}

export type PatchwalkValidationResult = PatchwalkValidationSuccess | PatchwalkValidationFailure;

const formatIssuePath = (path: PropertyKey[]): string => {
    // Format nested zod paths into field strings that are readable in VS Code error notifications.
    return path.reduce<string>((formattedPath, segment) => {
        if (typeof segment === 'number') {
            return `${formattedPath}[${segment}]`;
        }

        const segmentText = String(segment);
        if (!formattedPath) {
            return segmentText;
        }

        return `${formattedPath}.${segmentText}`;
    }, '');
};

const formatValidationIssue = (issue: z.ZodIssue): string => {
    // Unrecognized keys deserve a clearer message than Zod's default wording.
    if (issue.code === 'unrecognized_keys') {
        const issuePath = formatIssuePath(issue.path);
        const location = issuePath ? ` at "${issuePath}"` : '';
        const label = issue.keys.length === 1 ? 'field' : 'fields';
        return `Unexpected ${label}${location}: ${issue.keys.join(', ')}.`;
    }

    const issuePath = formatIssuePath(issue.path);
    if (issuePath) {
        return `Field "${issuePath}": ${issue.message}`;
    }

    return issue.message;
};

/**
 * Every validation problem, formatted for an authoring agent. The play tool reports ALL of them at
 * once so the agent fixes the whole walk in one pass instead of discovering violations one call at
 * a time (which is what makes a strict tool feel like a fight).
 */
export const formatPatchwalkValidationIssues = (error: z.ZodError): string[] => {
    return error.issues.map((issue) => formatValidationIssue(issue));
};

export const validatePatchwalkPayload = (value: unknown): PatchwalkValidationResult => {
    // Validation always returns one human-readable error because the extension UI shows one message at a time.
    const result = patchwalkHandoffPayloadSchema.safeParse(value);

    if (result.success) {
        return {
            ok: true,
            value: result.data,
        };
    }

    return {
        ok: false,
        error:
            result.error.issues.length > 0
                ? formatValidationIssue(result.error.issues[0])
                : 'Invalid payload.',
    };
};
