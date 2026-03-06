export type PatchwalkTargetType = 'symbol' | 'range' | 'line';

export interface PatchwalkRange {
    startLine: number;
    endLine: number;
}

export interface PatchwalkProducer {
    agent: string;
    agentVersion?: string;
    model?: string;
}

export interface PatchwalkWalkthroughStep {
    id: string;
    title: string;
    narration: string;
    path: string;
    type?: PatchwalkTargetType;
    symbol?: string;
    range: PatchwalkRange;
}

export interface PatchwalkHandoffPayload {
    $schema?: string;
    specVersion: string;
    handoffId: string;
    createdAt: string;
    producer: PatchwalkProducer;
    summary: string;
    walkthrough: PatchwalkWalkthroughStep[];
}

interface PatchwalkValidationSuccess {
    ok: true;
    value: PatchwalkHandoffPayload;
}

interface PatchwalkValidationFailure {
    ok: false;
    error: string;
}

export type PatchwalkValidationResult = PatchwalkValidationSuccess | PatchwalkValidationFailure;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const asNonEmptyString = (value: unknown, fieldName: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`Field "${fieldName}" must be a non-empty string.`);
    }

    return value;
};

const asPositiveInteger = (value: unknown, fieldName: string): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new TypeError(`Field "${fieldName}" must be a positive integer.`);
    }

    return value;
};

const normalizeRange = (value: unknown, fieldName: string): PatchwalkRange => {
    if (!isRecord(value)) {
        throw new TypeError(`Field "${fieldName}" must be an object.`);
    }

    const startLine = asPositiveInteger(value.startLine, `${fieldName}.startLine`);
    const endLine = asPositiveInteger(value.endLine, `${fieldName}.endLine`);

    if (endLine < startLine) {
        throw new TypeError(`Field "${fieldName}.endLine" must be >= "${fieldName}.startLine".`);
    }

    return { startLine, endLine };
};

const normalizeStep = (value: unknown, index: number): PatchwalkWalkthroughStep => {
    if (!isRecord(value)) {
        throw new TypeError(`walkthrough[${index}] must be an object.`);
    }

    const step: PatchwalkWalkthroughStep = {
        id: asNonEmptyString(value.id, `walkthrough[${index}].id`),
        title: asNonEmptyString(value.title, `walkthrough[${index}].title`),
        narration: asNonEmptyString(value.narration, `walkthrough[${index}].narration`),
        path: asNonEmptyString(value.path, `walkthrough[${index}].path`),
        range: normalizeRange(value.range, `walkthrough[${index}].range`),
    };

    if (value.type !== undefined) {
        const type = asNonEmptyString(value.type, `walkthrough[${index}].type`);
        if (type !== 'symbol' && type !== 'range' && type !== 'line') {
            throw new TypeError(
                `Field "walkthrough[${index}].type" must be one of: symbol, range, line.`,
            );
        }

        step.type = type;
    }

    if (value.symbol !== undefined) {
        step.symbol = asNonEmptyString(value.symbol, `walkthrough[${index}].symbol`);
    }

    return step;
};

export const validatePatchwalkPayload = (value: unknown): PatchwalkValidationResult => {
    try {
        if (!isRecord(value)) {
            throw new TypeError('Payload must be a JSON object.');
        }

        const createdAt = asNonEmptyString(value.createdAt, 'createdAt');
        if (Number.isNaN(new Date(createdAt).getTime())) {
            throw new TypeError('Field "createdAt" must be a valid ISO date string.');
        }

        if (!isRecord(value.producer)) {
            throw new TypeError('Field "producer" must be an object.');
        }

        const walkthroughRaw = value.walkthrough;
        if (!Array.isArray(walkthroughRaw)) {
            throw new TypeError('Field "walkthrough" must be an array.');
        }

        const walkthrough = walkthroughRaw.map((step, index) => normalizeStep(step, index));

        const normalized: PatchwalkHandoffPayload = {
            specVersion: asNonEmptyString(value.specVersion, 'specVersion'),
            handoffId: asNonEmptyString(value.handoffId, 'handoffId'),
            createdAt,
            producer: {
                agent: asNonEmptyString(value.producer.agent, 'producer.agent'),
                agentVersion:
                    value.producer.agentVersion === undefined
                        ? undefined
                        : asNonEmptyString(value.producer.agentVersion, 'producer.agentVersion'),
                model:
                    value.producer.model === undefined
                        ? undefined
                        : asNonEmptyString(value.producer.model, 'producer.model'),
            },
            summary: asNonEmptyString(value.summary, 'summary'),
            walkthrough,
        };

        if (typeof value.$schema === 'string' && value.$schema.trim().length > 0) {
            normalized.$schema = value.$schema;
        }

        return {
            ok: true,
            value: normalized,
        };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Invalid payload.',
        };
    }
};
