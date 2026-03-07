import { z } from 'zod';

import type { PatchwalkHandoffPayload } from './schema';
import { patchwalkHandoffPayloadSchema } from './schema';

/**
 * This module is the daemon's catalog of public MCP-facing types, sample resources, and helper
 * text. Keeping it separate from the server logic makes the public contract easier to review and
 * test.
 */
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
export const PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI = 'patchwalk://handoff/authoring-guide';

// Keep the tool backward compatible with the older payload wrapper while clients migrate.
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
    workerId: nonEmptyStringSchema,
    matchedRoot: nonEmptyStringSchema,
});

export type PatchwalkPlayArguments = z.infer<typeof patchwalkPlayArgumentsSchema>;
export type PatchwalkPlayResult = z.infer<typeof patchwalkPlayResultSchema>;

// Status payloads are intentionally daemon-centric so humans and MCP clients see the same runtime picture.
export interface PatchwalkWorkerStatusResource {
    workerId: string;
    processId: number;
    extensionVersion: string;
    workspaceRoots: string[];
    registeredAt: string;
    lastSeenAt: string;
}

export interface PatchwalkDispatchStatusResource {
    dispatchId: string;
    handoffId: string;
    basePath: string;
    state: 'claiming' | 'executing';
    createdAt: string;
    selectedWorkerId?: string;
}

export interface PatchwalkStatusResource {
    endpointUrl: string;
    healthUrl: string;
    startedAt: string | null;
    daemonPid: number | null;
    configuredPort: number;
    activeSessionCount: number;
    workerCount: number;
    workers: PatchwalkWorkerStatusResource[];
    activeDispatchCount: number;
    activeDispatches: PatchwalkDispatchStatusResource[];
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
    // The sample payload demonstrates the routing field as well as the narration shape.
    return {
        specVersion: '1.0.0',
        handoffId: 'patchwalk-example-handoff',
        createdAt: '2026-03-07T00:00:00Z',
        basePath: '/Users/example/project',
        producer: {
            agent: 'patchwalk',
            agentVersion: PATCHWALK_MCP_SERVER_INFO.version,
            model: 'example',
        },
        summary: 'Explain the extension worker activation flow and the daemon MCP entrypoint.',
        walkthrough: [
            {
                id: 'step-1',
                title: 'Extension worker activation',
                narration:
                    'Patchwalk activates, creates its playback runner, ensures the daemon is up, and registers the current window as a worker.',
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
                title: 'Daemon MCP entrypoint',
                narration:
                    'The daemon exposes MCP tools, prompts, resources, and worker-control endpoints over local HTTP.',
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
    // This resource is written as an operator handbook for people running and debugging Patchwalk.
    return [
        '# Patchwalk Operator Manual',
        '',
        `Endpoint: \`${endpointUrl}\``,
        '',
        'Capabilities:',
        `- Tool: \`${PATCHWALK_PLAY_TOOL_NAME}\` plays a narrated handoff inside VS Code.`,
        `- Resource: \`${PATCHWALK_STATUS_RESOURCE_URI}\` reports server status and active sessions.`,
        `- Resource: \`${PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI}\` returns a valid example handoff payload.`,
        `- Resource: \`${PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI}\` explains how to write a strong developer-grade handoff.`,
        `- Prompt: \`${PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME}\` drafts a full handoff payload.`,
        `- Prompt: \`${PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME}\` turns a file list into narrated walkthrough steps.`,
        '',
        'Tool contract:',
        '- Pass the handoff JSON object directly as tool arguments.',
        '- Backward compatibility: a wrapper of the form `{ "payload": <handoff> }` is also accepted.',
        '- `basePath` is required and must be an absolute project path on the local machine.',
        '- The daemon broadcasts a claim request to all live Patchwalk windows and selects one winner using exact match, then longest parent-path match, then earliest registration.',
        '- Playback will move the selected editor window, highlight ranges, and trigger local narration.',
        '',
        'Authoring expectations:',
        '- Read the authoring guide resource before generating payloads for non-trivial changes.',
        '- Write for senior engineers. Explain behavior, risk, blast radius, and architecture, not raw line edits.',
        '- Use the top-level summary for the whole patch, then use walkthrough narration for step-by-step semantic explanation.',
        '',
        'Operational notes:',
        '- Use an MCP client library for session handling and lifecycle notifications.',
        '- Patchwalk windows self-heal the daemon. If the daemon dies, any live window will restart and re-register it.',
        '- The health check remains available at `GET /health` for local diagnostics.',
    ].join('\n');
};

export const createPatchwalkAuthoringGuide = (): string => {
    // This resource is tuned for AI callers that need concrete authoring standards.
    return [
        '# Patchwalk Handoff Authoring Guide',
        '',
        'Audience: senior engineers reviewing a real code change.',
        '',
        'Core rule: write a semantic patch explanation, not a diff narration.',
        '',
        'Use this mindset:',
        '- Explain what behavior changed.',
        '- Explain why the change matters.',
        '- Explain what could go wrong.',
        '- Explain how far the change can reach.',
        '',
        '## Required tone',
        '',
        '- Conversational, direct, technically dense.',
        '- Written for developers, not PMs or marketing copy.',
        '- Specific enough that a reviewer can reason about behavior, risk, and follow-up questions.',
        '',
        '## Summary expectations',
        '',
        'The top-level `summary` should be a high-level overview of the full patch.',
        '',
        'A strong summary usually covers:',
        '- developer intent: bug fix, refactor, feature, performance improvement, security fix',
        '- areas touched: auth, cache, API, persistence, routing, background jobs, UI state, shared utilities',
        '- dominant behavior change: what is meaningfully different after the patch',
        '- major risk signals when present',
        '',
        '## Walkthrough expectations',
        '',
        'Each walkthrough step should help the listener understand the patch as an engineer would explain it in person.',
        '',
        'For each step, prefer this order:',
        '1. name the subsystem or decision being changed',
        '2. explain the semantic behavior change',
        '3. explain why it matters',
        '4. call out risk, blast radius, or follow-up concerns if relevant',
        '',
        'Good narration traits:',
        '- intent extraction instead of line restatement',
        '- before-vs-after behavior when it is clear',
        '- concrete risk language when the patch touches concurrency, auth, permissions, SQL, retries, transactions, caching, or I/O',
        '- mention tests, missing tests, or uncovered branches when relevant',
        '- mention architecture shifts when the pattern changes',
        '',
        '## Signals to include when present',
        '',
        '- Risk analysis: concurrency, schema, auth, permission checks, removed validation, removed error handling, retry changes, transaction scope, caching changes',
        '- Blast radius: exported functions, middleware, shared utilities, public APIs, DB models, widely used modules',
        '- Behavior simulation: before vs after behavior, access rules, retry timings, control-flow differences',
        '- Security: auth bypass, input validation removal, dynamic SQL, unsafe deserialization, open redirects, permission regressions',
        '- Performance: new loops, nested loops, N+1 queries, synchronous I/O, removed caching, added network calls',
        '- Test coverage: what was tested, what remains exposed',
        '- Architecture: sync to async, direct DB access to repository, new abstraction layers, ownership boundaries',
        '- Dependency awareness: version upgrades and notable breaking behavior changes',
        '- Git history context: earlier bugs, partial reversions, follow-up work, related commits if known',
        '',
        '## Noise to filter out',
        '',
        '- formatting only',
        '- whitespace only',
        '- comment-only edits',
        '- import order changes',
        '- trivial renames unless they change semantics',
        '',
        '## Payload construction guidance',
        '',
        '- `basePath` should point at the project root that should receive playback.',
        '- `walkthrough` should be ordered from entrypoints and high-level control flow toward deeper implementation details.',
        '- Prefer ranges that are narrow enough for the editor highlight to stay readable.',
        '- Use `type` and `symbol` when they improve navigation, not as filler.',
        '',
        '## What to avoid',
        '',
        '- “Line X changed to line Y.”',
        '- vague claims like “minor improvements” or “cleanup” when the behavior actually changed',
        '- empty praise, filler, or generic summaries that could apply to any patch',
        '- narrating every file equally when some are just support noise',
        '',
        '## Quality bar',
        '',
        'A strong Patchwalk handoff should make a reviewer feel like a senior engineer already walked them through the patch, including intent, consequences, and risk, before they read the code themselves.',
    ].join('\n');
};

export const createPatchwalkComposePromptText = (args: {
    changeSummary: string;
    changedFiles?: string;
    focusAreas?: string;
}): string => {
    // Compose prompts are intentionally prescriptive so generated payloads are useful on first pass.
    return [
        'Create a valid Patchwalk handoff JSON payload for the following code change.',
        'Write for senior engineers. The payload must feel like a valuable code-review walkthrough, not a diff narration.',
        '',
        `Change summary: ${args.changeSummary}`,
        args.changedFiles ? `Changed files:\n${args.changedFiles}` : 'Changed files: not provided.',
        args.focusAreas ? `Focus areas:\n${args.focusAreas}` : 'Focus areas: not provided.',
        '',
        'Authoring paradigm:',
        '- Explain semantic behavior changes, not line-by-line edits.',
        '- Infer likely developer intent when possible: bug fix, refactor, feature, performance improvement, security fix.',
        '- Call out risk signals when present: concurrency, auth, permissions, schema, validation removal, error handling changes, retries, transactions, caching, or I/O.',
        '- Mention blast radius when the patch touches shared utilities, public APIs, middleware, exported functions, or central models.',
        '- Prefer before-vs-after behavior when it makes the change clearer.',
        '- Mention security, performance, architectural impact, dependency changes, and test coverage when they are materially relevant.',
        '- Ignore formatting-only noise, whitespace-only edits, comment-only edits, and import reordering.',
        '',
        'Output requirements:',
        '- Return a single JSON object.',
        '- Use `specVersion`, `handoffId`, `createdAt`, `basePath`, `producer`, `summary`, and `walkthrough`.',
        '- `basePath` must be an absolute filesystem path for the project root that should receive playback.',
        '- The top-level `summary` must be a high-level patch overview, not a generic one-liner.',
        '- Each walkthrough step must include `id`, `title`, `narration`, `path`, and `range`.',
        '- Each `narration` should read like a senior engineer explaining what changed, why it matters, and what to watch out for.',
        '- Use `type` and `symbol` when a named symbol meaningfully improves navigation.',
        '- Start with the most important files or entrypoints, then move into implementation details.',
        '- Prefer 8 to 15 steps unless the change is unusually broad.',
    ].join('\n');
};

export const createPatchwalkExpandWalkthroughPromptText = (args: {
    summary: string;
    files: string;
    detailLevel?: string;
}): string => {
    // Expand prompts bias the model toward reviewer-grade narration rather than diff paraphrasing.
    return [
        'Expand the following change description into Patchwalk walkthrough steps.',
        'Write for developers doing code review. Be specific, semantic, and useful.',
        '',
        `Summary: ${args.summary}`,
        `Files:\n${args.files}`,
        `Detail level: ${args.detailLevel ?? 'detailed'}`,
        '',
        'Authoring paradigm:',
        '- Explain intent, behavior change, and consequences instead of narrating raw diffs.',
        '- Highlight meaningful risks, blast radius, security/performance implications, and missing tests when relevant.',
        '- Prefer before-vs-after behavior when it clarifies the change.',
        '- Filter out formatting noise, comment churn, and import-order-only edits.',
        '',
        'Output requirements:',
        '- Return only the walkthrough array, not the full payload.',
        '- Order steps so they can be narrated from entrypoints to implementation details.',
        '- Make the narration specific enough to explain intent, control flow, side effects, and reviewer concerns.',
        '- Use titles that describe the subsystem or decision, not the file name alone.',
        '- Keep every range narrow enough for the editor highlight to stay readable.',
    ].join('\n');
};
