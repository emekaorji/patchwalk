import { z } from 'zod';

import type { PatchwalkHandoffPayload } from './schema';
import { patchwalkHandoffPayloadSchema } from './schema';

const nonEmptyStringSchema = z.string().min(1).regex(/\S/, 'must not be blank.');
const positiveIntegerSchema = z.number().int().gte(1);

export const PATCHWALK_MCP_SERVER_INFO = {
    name: 'patchwalk-mcp',
    version: '1.0.0',
    title: 'Patchwalk MCP Server',
} as const;

export const PATCHWALK_PLAY_TOOL_NAME = 'patchwalk.play';
export const PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME = 'patchwalk.compose-handoff';
export const PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME = 'patchwalk.expand-walkthrough';

export const PATCHWALK_STATUS_RESOURCE_URI = 'patchwalk://server/status';
export const PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI = 'patchwalk://server/operator-manual';
export const PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI = 'patchwalk://handoff/example';

export const patchwalkPlayArgumentsSchema = z.union([
    patchwalkHandoffPayloadSchema,
    z.strictObject({
        payload: patchwalkHandoffPayloadSchema,
    }),
]);

export const patchwalkPlayResultSchema = z.strictObject({
    handoffId: nonEmptyStringSchema,
    status: z.literal('completed'),
    stepsPlayed: positiveIntegerSchema,
});

export type PatchwalkPlayArguments = z.infer<typeof patchwalkPlayArgumentsSchema>;
export type PatchwalkPlayResult = z.infer<typeof patchwalkPlayResultSchema>;

export interface PatchwalkStatusResource {
    endpointUrl: string;
    healthUrl: string;
    startedAt: string | null;
    activeSessionCount: number;
    prompts: string[];
    resources: string[];
    tools: string[];
}

export const normalizePatchwalkPlayPayload = (
    argumentsValue: PatchwalkPlayArguments,
): PatchwalkHandoffPayload => {
    return 'payload' in argumentsValue ? argumentsValue.payload : argumentsValue;
};

export const createPatchwalkExampleHandoff = (): PatchwalkHandoffPayload => {
    return {
        specVersion: '1.0.0',
        handoffId: 'patchwalk-example-handoff',
        createdAt: '2026-03-07T00:00:00Z',
        producer: {
            agent: 'patchwalk',
            agentVersion: PATCHWALK_MCP_SERVER_INFO.version,
            model: 'example',
        },
        summary: 'Explain the extension activation flow and the MCP entrypoint.',
        walkthrough: [
            {
                id: 'step-1',
                title: 'Extension activation',
                narration:
                    'Patchwalk activates, creates its playback runner, and starts the local MCP server based on user settings.',
                path: 'src/extension.ts',
                type: 'symbol',
                symbol: 'activate',
                range: {
                    startLine: 1,
                    endLine: 40,
                },
            },
            {
                id: 'step-2',
                title: 'MCP server entrypoint',
                narration:
                    'The MCP server exposes tools, prompts, and resources over the Streamable HTTP transport.',
                path: 'src/mcpServer.ts',
                type: 'symbol',
                symbol: 'PatchwalkMcpServer',
                range: {
                    startLine: 1,
                    endLine: 160,
                },
            },
        ],
    };
};

export const createPatchwalkOperatorManual = (endpointUrl: string): string => {
    return [
        '# Patchwalk Operator Manual',
        '',
        `Endpoint: \`${endpointUrl}\``,
        '',
        'Capabilities:',
        `- Tool: \`${PATCHWALK_PLAY_TOOL_NAME}\` plays a narrated handoff inside VS Code.`,
        `- Resource: \`${PATCHWALK_STATUS_RESOURCE_URI}\` reports server status and active sessions.`,
        `- Resource: \`${PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI}\` returns a valid example handoff payload.`,
        `- Prompt: \`${PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME}\` drafts a full handoff payload.`,
        `- Prompt: \`${PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME}\` turns a file list into narrated walkthrough steps.`,
        '',
        'Tool contract:',
        '- Pass the handoff JSON object directly as tool arguments.',
        '- Backward compatibility: a wrapper of the form `{ "payload": <handoff> }` is also accepted.',
        '- Playback will move the active editor, highlight ranges, and trigger local narration.',
        '',
        'Operational notes:',
        '- Use an MCP client library for session handling and lifecycle notifications.',
        '- The health check remains available at `GET /health` for local diagnostics.',
    ].join('\n');
};

export const createPatchwalkComposePromptText = (args: {
    changeSummary: string;
    changedFiles?: string;
    focusAreas?: string;
}): string => {
    return [
        'Create a valid Patchwalk handoff JSON payload for the following code change.',
        '',
        `Change summary: ${args.changeSummary}`,
        args.changedFiles ? `Changed files:\n${args.changedFiles}` : 'Changed files: not provided.',
        args.focusAreas ? `Focus areas:\n${args.focusAreas}` : 'Focus areas: not provided.',
        '',
        'Output requirements:',
        '- Return a single JSON object.',
        '- Use `specVersion`, `handoffId`, `createdAt`, `producer`, `summary`, and `walkthrough`.',
        '- Each walkthrough step must include `id`, `title`, `narration`, `path`, and `range`.',
        '- Use `type` and `symbol` when a named symbol meaningfully improves navigation.',
        '- Prefer 8 to 15 steps unless the change is unusually broad.',
    ].join('\n');
};

export const createPatchwalkExpandWalkthroughPromptText = (args: {
    summary: string;
    files: string;
    detailLevel?: string;
}): string => {
    return [
        'Expand the following change description into Patchwalk walkthrough steps.',
        '',
        `Summary: ${args.summary}`,
        `Files:\n${args.files}`,
        `Detail level: ${args.detailLevel ?? 'detailed'}`,
        '',
        'Output requirements:',
        '- Return only the walkthrough array, not the full payload.',
        '- Order steps so they can be narrated from entrypoints to implementation details.',
        '- Make the narration specific enough to explain intent, control flow, and side effects.',
        '- Keep every range narrow enough for the editor highlight to stay readable.',
    ].join('\n');
};
