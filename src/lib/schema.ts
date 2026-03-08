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

export const patchwalkWalkthroughStepSchema = z.strictObject({
    id: nonEmptyStringSchema,
    title: nonEmptyStringSchema,
    narration: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    type: patchwalkTargetTypeSchema.optional(),
    symbol: nonEmptyStringSchema.optional(),
    range: patchwalkRangeSchema,
});

export const patchwalkHandoffPayloadSchema = z.strictObject({
    $schema: nonEmptyStringSchema.optional(),
    specVersion: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    createdAt: z.iso.datetime({ offset: true }),
    // Routing depends on this being absolute before the daemon sees the payload.
    basePath: nonEmptyStringSchema.refine((value) => path.isAbsolute(value), {
        message: 'must be an absolute filesystem path.',
    }),
    producer: patchwalkProducerSchema,
    summary: nonEmptyStringSchema,
    walkthrough: z.array(patchwalkWalkthroughStepSchema).min(1, 'must contain at least one step.'),
});

export type PatchwalkTargetType = z.infer<typeof patchwalkTargetTypeSchema>;
export type PatchwalkRange = z.infer<typeof patchwalkRangeSchema>;
export type PatchwalkProducer = z.infer<typeof patchwalkProducerSchema>;
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
