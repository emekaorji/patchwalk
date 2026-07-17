import { z } from 'zod';

import type { PatchwalkHandoffPayload, PatchwalkNarrationStyle } from './schema';
import {
    createPatchwalkHandoffPayloadSchema,
    PATCHWALK_DEFAULT_NARRATION_STYLE,
    patchwalkNarrationLimits,
} from './schema';

/**
 * This module is the daemon's catalog of public MCP-facing types, sample resources, and helper
 * text. Keeping it separate from the server logic makes the public contract easier to review and
 * test.
 */
const nonEmptyStringSchema = z.string().min(1).regex(/\S/, 'must not be blank.');
const positiveIntegerSchema = z.number().int().gte(1);

// These names and URIs are stable public contract, so keep them centralized and literal.
export const PATCHWALK_MCP_SERVER_INFO = {
    name: 'patchwalk-mcp',
    version: '1.0.0',
    title: 'Patchwalk MCP Server',
} as const;

export const PATCHWALK_PLAY_TOOL_NAME = 'patchwalk.play';
export const PATCHWALK_STOP_TOOL_NAME = 'patchwalk.stop';
export const PATCHWALK_STATUS_TOOL_NAME = 'patchwalk.status';
export const PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME = 'patchwalk.compose-handoff';
export const PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME = 'patchwalk.expand-walkthrough';
export const PATCHWALK_COMPOSE_ONBOARDING_PROMPT_NAME = 'patchwalk.compose-onboarding';

export const PATCHWALK_STATUS_RESOURCE_URI = 'patchwalk://server/status';
export const PATCHWALK_OPERATOR_MANUAL_RESOURCE_URI = 'patchwalk://server/operator-manual';
export const PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI = 'patchwalk://handoff/example';
export const PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI = 'patchwalk://handoff/authoring-guide';

// `patchwalk.play` now LAUNCHES a walk and returns immediately (launch+ack). The developer
// controls the running walk from the sidebar; the agent is never blocked on completion.
export const patchwalkPlayResultSchema = z.strictObject({
    status: z.literal('launched'),
    walkId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    workerId: nonEmptyStringSchema,
    matchedRoot: nonEmptyStringSchema,
    steps: positiveIntegerSchema,
});

export const patchwalkStopResultSchema = z.strictObject({
    status: z.enum(['stopped', 'idle']),
    handoffId: nonEmptyStringSchema.optional(),
    workerId: nonEmptyStringSchema.optional(),
});

export const patchwalkStatusResultSchema = z.strictObject({
    active: z.boolean(),
    walkId: nonEmptyStringSchema.optional(),
    handoffId: nonEmptyStringSchema.optional(),
    workerId: nonEmptyStringSchema.optional(),
    state: z.enum(['preparing', 'executing', 'playing', 'paused', 'stopping']).optional(),
    stepIndex: z.number().int().gte(0).optional(),
    stepCount: positiveIntegerSchema.optional(),
});

// MCP `registerTool` wants a ZodRawShape (`{ field: zodType }`), NOT a full ZodType. Passing a
// union/object schema makes the SDK emit a degenerate `properties: {}` JSON Schema, which makes
// agent tool bridges string-coerce nested fields (producer/walkthrough) and the call unusable.
// Expose the real shapes so the generated JSON Schema has proper typed properties.
//
// `$schema` is OMITTED on purpose: tool input property keys must match `^[a-zA-Z0-9_.-]{1,64}$`, and
// a leading `$` makes the model provider reject the ENTIRE tools list with a 400 — which breaks every
// turn, not just this tool. The payload validator still ACCEPTS `$schema`; we simply never ADVERTISE
// it. Any new top-level payload field must satisfy that pattern (guarded by a test).

/** The play tool's payload schema for the active narration style (this is where the gate lives). */
export const createPatchwalkPlayPayloadSchema = (style: PatchwalkNarrationStyle) =>
    createPatchwalkHandoffPayloadSchema(patchwalkNarrationLimits(style));

/** The advertised input shape for the active style — its caps reach the agent as `maxLength`. */
export const createPatchwalkPlayInputShape = (style: PatchwalkNarrationStyle) =>
    createPatchwalkPlayPayloadSchema(style).omit({ $schema: true }).shape;
export const patchwalkPlayResultShape = patchwalkPlayResultSchema.shape;
export const patchwalkStopResultShape = patchwalkStopResultSchema.shape;
export const patchwalkStatusResultShape = patchwalkStatusResultSchema.shape;

export type PatchwalkPlayResult = z.infer<typeof patchwalkPlayResultSchema>;
export type PatchwalkStopResult = z.infer<typeof patchwalkStopResultSchema>;
export type PatchwalkStatusResult = z.infer<typeof patchwalkStatusResultSchema>;

// Status payloads are intentionally daemon-centric so humans and MCP clients see the same runtime picture.
export interface PatchwalkWorkerStatusResource {
    workerId: string;
    processId: number;
    extensionVersion: string;
    workspaceRoots: string[];
    registeredAt: string;
    lastSeenAt: string;
    connectionState: 'connected';
    playbackState: 'idle' | 'playing' | 'paused' | 'stopping';
    activeHandoffId: string | null;
}

export interface PatchwalkDispatchStatusResource {
    dispatchId: string;
    handoffId: string;
    basePath: string;
    state: 'preparing' | 'executing' | 'playing' | 'stopping';
    createdAt: string;
    selectedWorkerId?: string;
}

export interface PatchwalkActiveHandoffStatusResource {
    dispatchId: string | null;
    handoffId: string | null;
    basePath: string | null;
    workerId: string | null;
    state: 'preparing' | 'executing' | 'playing' | 'paused' | 'stopping';
    source: 'daemon-dispatch' | 'worker-state';
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
    activeHandoff: PatchwalkActiveHandoffStatusResource | null;
    prompts: string[];
    resources: string[];
    tools: string[];
}

/**
 * The example is the shape agents copy, so it must MODEL both rules, not merely satisfy them: every
 * line CONTINUES the one before it (read the narrations top to bottom — they are one passage), and
 * each is as dense as the active style allows.
 */
const exampleNarration = (style: PatchwalkNarrationStyle) =>
    style === 'grounded'
        ? {
              summary:
                  'Patchwalk has two halves that only make sense together: the editor window that actually plays a walk out loud, and the machine-wide daemon that outside agents talk to. Follow the flow from one into the other and the whole design falls out.',
              step1: 'Start where the extension wakes up. On activation it stands up every piece a walk will need, and only then hands this window to the daemon, so the window is never advertised as ready before it can actually play anything.',
              seg1: 'It begins with the local pieces — the output channel, the voice layer, and the playback runner that will do the actual narrating.',
              seg2: 'Then comes the worker controller. That is the part that keeps the machine-wide daemon alive and lets this particular window receive walks routed to it.',
              seg3: 'And last the sidebar, so once a walk is running the developer can watch it and steer it rather than just sit through it.',
              step2: 'Which brings us to the other half. The daemon is what an outside agent actually talks to: it publishes the tools over local HTTP and routes each walk to whichever window owns that project.',
          }
        : {
              summary:
                  'Two halves of Patchwalk: the window that plays a walk, and the daemon agents talk to.',
              step1: 'Start where the extension wakes up — it stands up everything a walk needs, then hands the window to the daemon.',
              seg1: 'First the local pieces: output, voice, and the playback runner.',
              seg2: 'Then the worker controller, which keeps the daemon alive and lets this window receive walks.',
              seg3: 'And finally the sidebar, so you can steer a running walk instead of just sitting through it.',
              step2: 'Which brings us to the other half — the daemon, the piece an outside agent actually talks to.',
          };

export const createPatchwalkExampleHandoff = (
    style: PatchwalkNarrationStyle = PATCHWALK_DEFAULT_NARRATION_STYLE,
): PatchwalkHandoffPayload => {
    // The sample payload demonstrates the routing field as well as the narration shape.
    const say = exampleNarration(style);
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
        summary: say.summary,
        walkthrough: [
            {
                id: 'step-1',
                title: 'Extension worker activation',
                // The step overview selects the whole function and opens the passage.
                narration: say.step1,
                path: 'src/extension/index.ts',
                type: 'symbol',
                symbol: 'activate',
                range: {
                    startLine: 33,
                    endLine: 74,
                },
                // Sub-segments narrow the selection while the passage keeps running.
                segments: [
                    {
                        id: 'wiring',
                        narration: say.seg1,
                        range: { startLine: 35, endLine: 48 },
                    },
                    {
                        id: 'worker',
                        narration: say.seg2,
                        range: { startLine: 50, endLine: 62 },
                    },
                    {
                        id: 'sidebar',
                        narration: say.seg3,
                        range: { startLine: 64, endLine: 74 },
                    },
                ],
            },
            {
                id: 'step-2',
                title: 'Daemon MCP entrypoint',
                narration: say.step2,
                path: 'src/daemon/mcpServer.ts',
                type: 'symbol',
                symbol: 'PatchwalkMcpServer',
                range: {
                    startLine: 229,
                    endLine: 260,
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
        `- Tool: \`${PATCHWALK_STOP_TOOL_NAME}\` stops the one active narrated handoff on the machine.`,
        `- Resource: \`${PATCHWALK_STATUS_RESOURCE_URI}\` reports server status and active sessions.`,
        `- Resource: \`${PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI}\` returns a valid example handoff payload.`,
        `- Resource: \`${PATCHWALK_AUTHORING_GUIDE_RESOURCE_URI}\` explains how to write a strong developer-grade handoff.`,
        `- Prompt: \`${PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME}\` drafts a full handoff payload.`,
        `- Prompt: \`${PATCHWALK_EXPAND_WALKTHROUGH_PROMPT_NAME}\` turns a file list into narrated walkthrough steps.`,
        '',
        'Tool contract:',
        '- Pass the handoff JSON object directly as the tool arguments (its top-level fields ARE the arguments).',
        '- `basePath` is required and must be an absolute project path on the local machine.',
        '- Patchwalk allows exactly one active handoff across the whole machine at a time.',
        '- The daemon routes directly to one live Patchwalk window using exact match, then longest parent-path match, then earliest registration.',
        '- `patchwalk.stop` stops the currently active handoff globally. If nothing is running, it reports an idle result.',
        '- Playback will move the selected editor window, highlight ranges, and trigger local narration.',
        '',
        'Authoring expectations:',
        '- Read the authoring guide resource before generating payloads for non-trivial changes.',
        '- Write for senior engineers. Explain behavior, risk, blast radius, and architecture, not raw line edits.',
        '- Use the top-level summary for the whole patch, then use walkthrough narration for step-by-step semantic explanation.',
        '',
        'Operational notes:',
        '- Use an MCP client library for session handling and lifecycle notifications.',
        '- Patchwalk windows keep one persistent worker connection to the daemon and re-register after reconnect.',
        '- Patchwalk windows self-heal the daemon. If the daemon dies, any live window will restart and re-register it.',
        '- The health check remains available at `GET /health` for local diagnostics.',
    ].join('\n');
};

export const createPatchwalkAuthoringGuide = (
    style: PatchwalkNarrationStyle = PATCHWALK_DEFAULT_NARRATION_STYLE,
): string => {
    // This resource is tuned for AI callers that need concrete authoring standards.
    const limits = patchwalkNarrationLimits(style);
    const terse = style === 'terse';
    return [
        '# Patchwalk Walk Authoring Guide',
        '',
        `Active narration style: **${style.toUpperCase()}**${
            terse
                ? ' — dense, high-signal lines. This is the default.'
                : ' — longer, more grounded explanation (onboarding / unfamiliar code).'
        }`,
        '',
        'A Patchwalk *walk* is SPOKEN ALOUD to a developer inside their editor, step by step, while the',
        'relevant file and lines are highlighted. Write it the way a senior engineer would explain the',
        'change out loud — not the way you would write a text review.',
        '',
        'Audience: an engineer who already reads code fluently. They do NOT need logic narrated; they',
        'need the WHAT and the WHY — intent, reasoning, and consequence.',
        '',
        '## The one rule',
        '',
        'Explain the what and the WHY, never the diff. Do NOT restate code, read lines aloud, or say',
        '"line 42 changed to X". Say what the change DOES, why it was made, and what it affects.',
        '',
        '## Write ONE CONTINUOUS PASSAGE, not a pile of blurbs',
        '',
        'The walk is chopped into steps and sub-segments so the HIGHLIGHT can follow the code. The SPEECH',
        'must not be chopped. Played end to end, the whole walk has to sound like one person talking',
        'straight through — a single explanation that happens to move around the codebase.',
        '',
        'So write it as one passage, then cut it into cues:',
        '- Each line CONTINUES the previous one. Pick up where you left off.',
        '- Use connective tissue: "then", "from there", "which is why", "and that\'s what lets…".',
        '- NEVER re-introduce. Do not restart with "This function…" / "In this file…" / "Here we can',
        '  see…" on every cue. The listener never left; they heard the last line two seconds ago.',
        '- Do not repeat context you already said. Say it once, then build on it.',
        '- The last line should LAND — close the thought, do not just trail off.',
        '',
        'BAD (three self-contained blurbs, each restarting):',
        '  1. "This function creates symlinks. It starts by setting up directories."',
        '  2. "This function then resolves the options for the symlink operation."',
        '  3. "This function finally creates the links and prints the result."',
        'GOOD (one passage, chopped):',
        '  1. "Everything starts by working out where things live — cwd, home, the sessions directory."',
        '  2. "Then it settles the rules: which options won, and what to do on a collision."',
        '  3. "And that\'s the actual work — sweep the stale sessions, link, then prove something was made."',
        '',
        `## ${terse ? 'HIGH SIGNAL' : 'GROUNDED, BUT NEVER PADDED'} — and this one is ENFORCED`,
        '',
        'Your listener is a HUMAN, not a model. They are hearing this out loud while they watch their',
        'editor. They cannot skim it, re-read a line, or scroll back. Every padded word costs them time',
        'and buries the point.',
        '',
        terse
            ? 'Write like the engineer everyone wants in the room: the one who packs a lot of information into a few plain words, is understood immediately, and gives people their time back. DENSE, NOT LONG. Long narration is not "thorough" — it is disrespectful of their time.'
            : 'You have room to teach here: explain the reasoning, the trade-off, and the context a newcomer would lack. But room is not licence to ramble — every sentence must still earn its place. Grounded, never padded.',
        '',
        'These caps are a HARD GATE. A walk that exceeds them is REJECTED, not played:',
        `- \`summary\`             at most ${limits.summary} characters`,
        `- step \`narration\`      at most ${limits.step} characters`,
        `- segment \`narration\`   at most ${limits.segment} characters  <- aim for ${limits.segmentAim}.`,
        `- \`title\`               at most ${limits.title} characters`,
        '',
        'Cut in this order: filler, hedging, throat-clearing, restating the code, context they already',
        'have, anything merely "nice to know". Keep: what changed, why, what it risks.',
        `Before every line ask: "would a senior engineer actually SAY this out loud, or am I padding?"`,
        '',
        'BAD (rambling, restates the code, 246 chars):',
        '  "In this section of the function, we can see that the code first sets up the current working',
        "   directory, and then it proceeds to determine the user's home directory, after which it goes",
        '   on to construct the path for the sessions directory that will be used later on."',
        'GOOD (46 chars):',
        '  "Sets up cwd, home, and the sessions directory."',
        '',
        'BAD:  "This part of the code is responsible for handling the core work of the function, which',
        '       involves a number of important operations that we will now go through in detail."',
        'GOOD: "The core work: sweep stale sessions, classify targets, link, then assert something was made."',
        '',
        '## Written to be spoken (voice-first)',
        '',
        '- Plain sentences that sound natural read aloud — no code snippets, no symbols spelled out,',
        '  no bullet fragments, no markdown inside `narration`.',
        '- Front-load the point; the listener cannot skim.',
        '- No line numbers, no "as you can see", no "the following code" — reference behavior, not text.',
        '- `title` is a short label shown in the sidebar; `narration` is the exact text that gets spoken.',
        '',
        '## Say code out loud (never spell it)',
        '',
        'Everything in `narration` is fed to a text-to-speech voice. Code tokens read aloud sound like',
        'gibberish, so translate them into words:',
        '- Never voice punctuation, file paths, line numbers, or markdown. No backticks, no symbols.',
        '- Say identifiers as words: `fs.symlinkSync` → "the symlink-sync call"; `argv.slice(2)` →',
        '  "everything after the command name"; `res.status(404)` → "a not-found response".',
        '- Say literals as words: `0o755` → "mode seven five five"; `#!` → "a shebang"; `.ts` →',
        '  "a TypeScript file"; `\\n` → "a newline".',
        '- Reference behavior, not text location: say "when the path is missing" — never "on line 42".',
        'The transcript and the highlighted code already carry the exact names; the spoken line stays',
        'plain and human.',
        '',
        '## Granularity: sub-segments (a subtitle synced to the code)',
        '',
        'A step may include an ordered `segments` array. When present, the step plays like this:',
        '1. the step OVERVIEW first — its broad `range` (e.g. a whole function) is selected while the',
        '   step `narration` explains what the whole thing does end to end;',
        '2. then each sub-segment in turn — its OWN tighter `range` is selected while its short',
        '   `narration` (one or two spoken sentences) explains just those lines.',
        'The selection narrows progressively (broad → narrow), like a subtitle following the code as it',
        'is explained. Keep each sub-segment narration short and specific; do not dump reference detail',
        'into audio. A step with no `segments` is still valid and plays as a single beat.',
        '',
        'Worked example — a ~30-line function played as five beats:',
        '- overview: select the whole function; say what it does end to end;',
        '- sub-segment (its first few lines): "it sets up the working directory and the sessions folder";',
        '- sub-segment (the next lines): "here it resolves the options and the collision policy";',
        '- sub-segment (the core block): "this is the real work: it sweeps stale sessions, creates the',
        '  links, and checks that something was actually made";',
        '- sub-segment (the tail): "and finally it prints the outcome and a hint about the PATH".',
        'Each beat is one short spoken line while its lines are highlighted — never a whole file read out.',
        '',
        'Use this mindset:',
        '- Explain what behavior changed.',
        '- Explain why the change matters.',
        '- Explain what could go wrong.',
        '- Explain how far the change can reach.',
        '',
        '## Required tone',
        '',
        '- Conversational, direct, technically dense, but easy to follow by ear.',
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
        '- For anything longer than a few lines, add a `segments` array so the highlight follows the',
        '  explanation instead of sitting on one big block. Each sub-segment needs its own `range`',
        '  (inside the step range) and a short spoken `narration`.',
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
        'A strong Patchwalk walk should make a reviewer feel like a senior engineer already walked them through the patch out loud, including intent, consequences, and risk, before they read the code themselves.',
    ].join('\n');
};

/**
 * The two rules every authoring surface repeats: how MUCH may be said (the enforced caps for the
 * active style), and how it must SOUND (one continuous passage, not a pile of self-contained
 * blurbs).
 */
const narrationDoctrineLines = (style: PatchwalkNarrationStyle): string[] => {
    const limits = patchwalkNarrationLimits(style);
    const terse = style === 'terse';
    return [
        `NARRATION STYLE: ${style.toUpperCase()} — these caps are ENFORCED; the walk is REJECTED if you exceed them:`,
        `- \`summary\` <= ${limits.summary} chars · step \`narration\` <= ${limits.step} · sub-segment \`narration\` <= ${limits.segment} (aim ${limits.segmentAim}) · \`title\` <= ${limits.title}.`,
        '- The listener is a HUMAN hearing this aloud. They cannot skim, re-read, or scroll back.',
        terse
            ? '- DENSE, NOT LONG. Pack the point into a few plain words like the engineer everyone wants in the room. Padding wastes their time.'
            : '- Grounded, never padded: explain the reasoning and the context a newcomer lacks, but every sentence must still earn its place.',
        '- Cut filler, hedging, and anything restating the code. Keep what changed, why, and what it risks.',
        '  BAD: "In this section we can see that the code first sets up the current working directory,',
        '  and then proceeds to determine the home directory..."  GOOD: "Sets up cwd, home, and sessions."',
        '',
        'ONE CONTINUOUS PASSAGE — this is how the whole walk must SOUND:',
        '- It is chopped into cues so the HIGHLIGHT can follow the code. The SPEECH must not be chopped.',
        '- Played end to end it has to sound like one person talking straight through. Every line CONTINUES',
        '  the previous one — bridge with "then", "from there", "which is why".',
        '- NEVER restart each cue with "This function…" / "In this file…" / "Here we can see…". The listener',
        '  never left; they heard the last line two seconds ago. Never repeat context you already gave.',
        '- The final line should LAND and close the thought, not trail off.',
    ];
};

export const createPatchwalkComposePromptText = (
    args: {
        changeSummary: string;
        changedFiles?: string;
        focusAreas?: string;
    },
    style: PatchwalkNarrationStyle = PATCHWALK_DEFAULT_NARRATION_STYLE,
): string => {
    // Compose prompts are intentionally prescriptive so generated payloads are useful on first pass.
    return [
        'Create a valid Patchwalk walk (a JSON payload) for the following code change.',
        'Every step’s `narration` is SPOKEN ALOUD to the developer in their editor, so write it to be',
        'heard: conversational sentences explaining the WHAT and the WHY — intent, reasoning, and',
        'consequence. Never narrate the diff, never read code or line numbers aloud.',
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
        '- For any step covering more than a few lines, add a `segments` array: each sub-segment has an',
        '  optional `id`, a short spoken `narration`, and its own `range` inside the step range. Playback',
        '  selects the whole step first, then each sub-segment in turn, so the highlight follows the words.',
        '- Every `narration` is SPOKEN ALOUD by a text-to-speech voice: write plain sentences, say code',
        '  tokens as words (never spell out symbols, paths, or line numbers), and keep each sub-segment to',
        '  one or two sentences about the WHAT and the WHY.',
        '- Use `type` and `symbol` when a named symbol meaningfully improves navigation.',
        '- Start with the most important files or entrypoints, then move into implementation details.',
        '- Prefer 8 to 15 steps unless the change is unusually broad.',
        '',
        ...narrationDoctrineLines(style),
    ].join('\n');
};

export const createPatchwalkExpandWalkthroughPromptText = (
    args: {
        summary: string;
        files: string;
        detailLevel?: string;
    },
    style: PatchwalkNarrationStyle = PATCHWALK_DEFAULT_NARRATION_STYLE,
): string => {
    // Expand prompts bias the model toward reviewer-grade narration rather than diff paraphrasing.
    return [
        'Expand the following change description into Patchwalk walkthrough steps.',
        'Each step’s `narration` is SPOKEN ALOUD in the editor: write conversational sentences about the',
        'WHAT and the WHY (intent, reasoning, consequence), not a diff narration and not code read aloud.',
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
        '- For any step longer than a few lines, add a `segments` array: the step selects the broad range',
        '  first, then each sub-segment selects its own tighter range with the NEXT line of the passage,',
        '  so the highlight narrows with the explanation (a subtitle synced to the code).',
        '- Every narration is spoken aloud: say code tokens as words, and never voice symbols, paths, or line numbers.',
        '',
        ...narrationDoctrineLines(style),
    ].join('\n');
};

export const createPatchwalkOnboardingPromptText = (
    args: {
        codebasePath: string;
        area?: string;
        depth?: string;
    },
    style: PatchwalkNarrationStyle = PATCHWALK_DEFAULT_NARRATION_STYLE,
): string => {
    // Onboarding walks explain a whole system to a newcomer, not a single diff.
    return [
        'Create a valid Patchwalk walk (a JSON payload) that ONBOARDS a newcomer to this codebase by',
        'explaining it start to finish, out loud, inside their editor.',
        'Each step’s `narration` is SPOKEN ALOUD, so write conversational sentences about the WHAT and',
        'the WHY — how the system is put together and why it is shaped that way — never reading code aloud.',
        '',
        `Codebase root (use as basePath): ${args.codebasePath}`,
        args.area ? `Focus area: ${args.area}` : 'Focus area: the whole system.',
        `Depth: ${args.depth ?? 'a guided tour a new hire could follow in one sitting'}`,
        '',
        'Cover, in a sensible narrative order:',
        '- the big picture: what this project does and its main moving parts',
        '- the entrypoints and how a request / command / activation flows through the system',
        '- the core modules and the responsibility of each, and how they collaborate',
        '- the key data models / types and where state lives',
        '- important conventions, invariants, and “gotchas” a newcomer would trip on',
        '- where to make common kinds of changes',
        '',
        'Output requirements:',
        '- Return a single JSON object with `specVersion`, `handoffId`, `createdAt`, `basePath`,',
        '  `producer`, `summary`, and `walkthrough`.',
        '- Order steps as a tour: high-level overview first, then entrypoints, then deeper modules.',
        '- Each step points at a real file + a narrow, representative `range` to highlight while speaking.',
        '- Prefer 8 to 20 steps depending on the size of the area.',
        '- The narration teaches understanding; it never just lists files or restates code.',
        '- The whole tour is ONE talk: each step continues the last, so the newcomer is led through the',
        '  system rather than handed a stack of disconnected file summaries.',
        '',
        ...narrationDoctrineLines(style),
    ].join('\n');
};

/** The play tool's description, carrying the active style's gate and the passage rule. */
export const createPatchwalkPlayToolDescription = (style: PatchwalkNarrationStyle): string => {
    const limits = patchwalkNarrationLimits(style);
    const terse = style === 'terse';
    return [
        `Launch a spoken Patchwalk walk in the developer's editor: it narrates the change ALOUD, step by step, highlighting each file/range.`,
        `Write every narration to be HEARD by a HUMAN — the WHAT and the WHY (intent, reasoning, consequence), never a diff narration or code read aloud, and say code tokens as words (no symbols, paths, or line numbers spoken).`,
        `SOUND LIKE ONE CONTINUOUS PASSAGE: the walk is chopped into cues so the HIGHLIGHT can follow the code, but the SPEECH must not be chopped. Each line continues the previous one ("then", "from there", "which is why"). Never restart a cue with "This function..." or "Here we can see..." — the listener never left.`,
        terse
            ? `BE HIGH SIGNAL: a human cannot skim audio, so pack the point into a few plain words like the engineer everyone wants in the room — dense, not long; padding wastes their time.`
            : `BE GROUNDED BUT NEVER PADDED: you have room to explain reasoning and context a newcomer lacks, but every sentence must earn its place.`,
        `Narration style is ${style.toUpperCase()}. Length caps are ENFORCED and the walk is REJECTED if any is exceeded: summary <= ${limits.summary} chars, step narration <= ${limits.step}, sub-segment narration <= ${limits.segment} (aim ${limits.segmentAim}), title <= ${limits.title}.`,
        `For any step longer than a few lines, add a \`segments\` array so the highlight follows the words: the step selects its broad range first, then each sub-segment selects its own tighter range with the NEXT line of the passage.`,
        `Pass the handoff object's fields directly as the tool arguments. Read the patchwalk://handoff/authoring-guide resource first.`,
        `Returns immediately once the walk is launched (it does not block until narration finishes); the developer controls it from the Patchwalk sidebar. Rejected if another walk is already active anywhere on the machine.`,
    ].join(' ');
};
