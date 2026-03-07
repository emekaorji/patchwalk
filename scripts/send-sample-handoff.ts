import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
    PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
    PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
    PATCHWALK_PLAY_TOOL_NAME,
    PATCHWALK_STATUS_RESOURCE_URI,
} from '../src/mcpCatalog';
import type { PatchwalkHandoffPayload } from '../src/schema';

type WalkthroughTargetType = 'line' | 'range' | 'symbol';

const port = Number(process.env.PATCHWALK_MCP_PORT ?? '7357');
const baseUrl = `http://127.0.0.1:${port}`;
const endpointUrl = `${baseUrl}/mcp`;

interface SampleWalkthroughStep {
    id: string;
    title: string;
    narration: string;
    path: string;
    type?: WalkthroughTargetType;
    symbol?: string;
    range: {
        startLine: number;
        endLine: number;
    };
}

const createStep = (
    stepNumber: number,
    title: string,
    narration: string,
    path: string,
    startLine: number,
    endLine: number,
    options: {
        type?: WalkthroughTargetType;
        symbol?: string;
    } = {},
): SampleWalkthroughStep => {
    return {
        id: `step-${String(stepNumber).padStart(2, '0')}`,
        title,
        narration,
        path,
        type: options.type ?? 'range',
        symbol: options.symbol,
        range: {
            startLine,
            endLine,
        },
    };
};

const walkthrough: SampleWalkthroughStep[] = [
    createStep(
        1,
        'Workspace Manifest',
        'Start at the workspace package manifest. This establishes that the demo project is private, module-based, and intentionally scoped for Patchwalk manual testing.',
        'package.json',
        1,
        6,
    ),
    createStep(
        2,
        'Workspace Scripts',
        'These scripts show how the demo app is expected to run: watch mode for local iteration, a regular start path, and a compile-only check command.',
        'package.json',
        7,
        11,
    ),
    createStep(
        3,
        'TypeScript Build Shape',
        'The workspace tsconfig locks the demo app into a strict NodeNext TypeScript setup with a single src root and an emitted dist folder.',
        'tsconfig.json',
        1,
        13,
    ),
    createStep(
        4,
        'Entry Imports',
        'The runtime entry point stays thin. It imports the token builder and the server bootstrap so startup logic is easy to scan.',
        'src/index.ts',
        1,
        2,
    ),
    createStep(
        5,
        'Build Demo Token',
        'Before the server starts, the entry point prepares a realistic bearer token for a maintainer with read and write project scopes.',
        'src/index.ts',
        4,
        8,
    ),
    createStep(
        6,
        'Boot Sequence',
        'Startup logs the demo token for manual testing and then kicks off the HTTP server. There is no framework here, just a deliberate bare Node bootstrap.',
        'src/index.ts',
        10,
        13,
    ),
    createStep(
        7,
        'Config Contract',
        'The config module starts with an explicit environment union and a typed AppConfig interface so the rest of the codebase consumes one stable configuration shape.',
        'src/config/env.ts',
        1,
        8,
    ),
    createStep(
        8,
        'Defaults And Environment Guard',
        'These constants define safe defaults, and the environment type guard constrains NODE_ENV to the three modes this demo app actually understands.',
        'src/config/env.ts',
        10,
        15,
    ),
    createStep(
        9,
        'Numeric Env Fallback',
        'readNumber first handles the common case where an environment variable is missing and simply falls back to a known safe default.',
        'src/config/env.ts',
        17,
        24,
        { type: 'symbol', symbol: 'readNumber' },
    ),
    createStep(
        10,
        'Numeric Env Validation',
        'The second half of readNumber enforces that environment overrides are positive finite numbers instead of silently accepting bad configuration.',
        'src/config/env.ts',
        26,
        31,
        { type: 'symbol', symbol: 'readNumber' },
    ),
    createStep(
        11,
        'Load Config Input',
        'loadAppConfig begins by reading process.env, defaulting the environment, and rejecting unsupported NODE_ENV values early.',
        'src/config/env.ts',
        34,
        40,
        { type: 'symbol', symbol: 'loadAppConfig' },
    ),
    createStep(
        12,
        'Load Config Output',
        'Once validation is done, loadAppConfig assembles the final typed config object that the rest of the server will import.',
        'src/config/env.ts',
        42,
        51,
        { type: 'symbol', symbol: 'loadAppConfig' },
    ),
    createStep(
        13,
        'Config Singleton',
        'The module exports one eagerly loaded config instance so downstream code can depend on configuration without repeating parsing logic.',
        'src/config/env.ts',
        54,
        54,
    ),
    createStep(
        14,
        'Core Domain Records',
        'The mock database file opens with three record interfaces that define the user, project, and activity shapes the rest of the demo app will manipulate.',
        'src/data/mockDatabase.ts',
        1,
        26,
    ),
    createStep(
        15,
        'Seed Users',
        'The first seed block creates a small but realistic team with distinct roles: owner, maintainer, and viewer.',
        'src/data/mockDatabase.ts',
        28,
        32,
    ),
    createStep(
        16,
        'Seed Projects',
        'The projects seed models two products with owners, contributors, lifecycle state, and monthly spend so service code has something business-like to shape.',
        'src/data/mockDatabase.ts',
        34,
        53,
    ),
    createStep(
        17,
        'Seed Activity Feed',
        'This activity seed gives each project recent human-readable events, which later become the dashboard-style feed returned by the service layer.',
        'src/data/mockDatabase.ts',
        55,
        77,
    ),
    createStep(
        18,
        'Find User By Id',
        'The first lookup helper stays intentionally tiny: a direct find against the in-memory user list.',
        'src/data/mockDatabase.ts',
        79,
        81,
        { type: 'symbol', symbol: 'findUserById' },
    ),
    createStep(
        19,
        'Find User By Email',
        'The email lookup lowercases both sides, which keeps session resolution tolerant of case differences in tokens or manual input.',
        'src/data/mockDatabase.ts',
        83,
        85,
        { type: 'symbol', symbol: 'findUserByEmail' },
    ),
    createStep(
        20,
        'List Projects For User',
        'Project visibility in the mock database is derived from ownership or contributor membership, which mirrors the authorization rules used higher up.',
        'src/data/mockDatabase.ts',
        87,
        91,
        { type: 'symbol', symbol: 'listProjectsForUser' },
    ),
    createStep(
        21,
        'Find Project By Slug',
        'Slug-based lookup is what the route layer will use when paths like slash projects slash apollo come in.',
        'src/data/mockDatabase.ts',
        93,
        95,
        { type: 'symbol', symbol: 'findProjectBySlug' },
    ),
    createStep(
        22,
        'List Recent Activity',
        'Recent activity is filtered, sorted descending by timestamp, and sliced to a configurable limit before it reaches the service layer.',
        'src/data/mockDatabase.ts',
        97,
        105,
        { type: 'symbol', symbol: 'listRecentActivityForProject' },
    ),
    createStep(
        23,
        'Rename Project In Store',
        'The in-memory mutation helper looks up the project, throws if the id is unknown, trims the name, and returns the updated record.',
        'src/data/mockDatabase.ts',
        107,
        115,
        { type: 'symbol', symbol: 'renameProject' },
    ),
    createStep(
        24,
        'Session Contracts',
        'The session module starts with narrow claims and context interfaces. The rest of the app only needs a resolved user and the validated token claims.',
        'src/auth/session.ts',
        5,
        14,
    ),
    createStep(
        25,
        'Bearer Header Guard',
        'parseSessionToken rejects missing or malformed Authorization headers up front instead of trying to decode garbage.',
        'src/auth/session.ts',
        16,
        19,
        { type: 'symbol', symbol: 'parseSessionToken' },
    ),
    createStep(
        26,
        'Decode Session Payload',
        'The next block strips the Bearer prefix, base64url-decodes the token, and parses the embedded JSON claims.',
        'src/auth/session.ts',
        21,
        23,
        { type: 'symbol', symbol: 'parseSessionToken' },
    ),
    createStep(
        27,
        'Normalize Session Claims',
        'After decoding, parseSessionToken enforces the required identifiers and normalizes missing scopes to an empty array.',
        'src/auth/session.ts',
        25,
        33,
        { type: 'symbol', symbol: 'parseSessionToken' },
    ),
    createStep(
        28,
        'Resolve Session User',
        'requireSession turns raw claims into a full session context by resolving the user through id or email and failing closed when nothing matches.',
        'src/auth/session.ts',
        36,
        45,
        { type: 'symbol', symbol: 'requireSession' },
    ),
    createStep(
        29,
        'Encode Demo Token',
        'The inverse helper builds a demo bearer token by serializing the claims and base64url-encoding them back into header form.',
        'src/auth/session.ts',
        47,
        50,
        { type: 'symbol', symbol: 'buildDemoToken' },
    ),
    createStep(
        30,
        'Scope Helper',
        'Authorization starts with the smallest possible primitive: a helper that checks whether a required scope is present.',
        'src/auth/permissions.ts',
        3,
        5,
    ),
    createStep(
        31,
        'View Project Permission',
        'canViewProject gives owners a fast-path bypass, then falls back to a scoped membership check for everyone else.',
        'src/auth/permissions.ts',
        7,
        18,
        { type: 'symbol', symbol: 'canViewProject' },
    ),
    createStep(
        32,
        'Rename Project Permission',
        'Rename permissions are stricter: viewers are blocked, the write scope is required, and the user still has to belong to the project.',
        'src/auth/permissions.ts',
        20,
        28,
        { type: 'symbol', symbol: 'canRenameProject' },
    ),
    createStep(
        33,
        'Billing Permission',
        'Billing management is the tightest rule in the file: only owners with the billing write scope can pass it.',
        'src/auth/permissions.ts',
        30,
        32,
        { type: 'symbol', symbol: 'canManageBilling' },
    ),
    createStep(
        34,
        'Activity Feed Contract',
        'The activity feed service exposes a presentation-friendly interface that already flattens actor names and summaries into UI-ready items.',
        'src/services/activityFeedService.ts',
        6,
        11,
    ),
    createStep(
        35,
        'Map Feed Items',
        'listActivityFeed pulls recent activity, resolves actor display names, and substitutes a fallback label when an actor record is missing.',
        'src/services/activityFeedService.ts',
        13,
        24,
        { type: 'symbol', symbol: 'listActivityFeed' },
    ),
    createStep(
        36,
        'Project Service View Models',
        'The main service layer defines two outward-facing models: a lightweight summary and a richer overview with feed data and capability flags.',
        'src/services/projectService.ts',
        10,
        21,
    ),
    createStep(
        37,
        'List Visible Projects',
        'listVisibleProjects asks the mock database for the user-owned or contributed projects and immediately trims them down to summary fields.',
        'src/services/projectService.ts',
        23,
        31,
        { type: 'symbol', symbol: 'listVisibleProjects' },
    ),
    createStep(
        38,
        'Overview Lookup And Access',
        'getProjectOverview starts by looking up the project by slug and then applies the view permission guard before any derived data is built.',
        'src/services/projectService.ts',
        33,
        44,
        { type: 'symbol', symbol: 'getProjectOverview' },
    ),
    createStep(
        39,
        'Overview Assembly',
        'Once the guards pass, getProjectOverview assembles the response model with spend, activity feed, and the canRename capability flag.',
        'src/services/projectService.ts',
        46,
        55,
        { type: 'symbol', symbol: 'getProjectOverview' },
    ),
    createStep(
        40,
        'Rename Service Flow',
        'The rename service repeats project lookup and permission checks, persists the new name, then reuses getProjectOverview so clients always get the same shape back.',
        'src/services/projectService.ts',
        57,
        72,
        { type: 'symbol', symbol: 'renameProject' },
    ),
    createStep(
        41,
        'JSON Response Primitive',
        'The HTTP utility layer begins with a tiny JsonResponse contract and a json helper that standardizes the status and body pair used everywhere else.',
        'src/utils/http.ts',
        3,
        13,
    ),
    createStep(
        42,
        'Error Response Wrappers',
        'notFound and badRequest are thin wrappers, but they keep route handlers from hand-rolling repetitive error payloads.',
        'src/utils/http.ts',
        15,
        21,
    ),
    createStep(
        43,
        'Read Body Chunks',
        'readJsonBody accumulates the request stream as Uint8Array chunks so the transport layer stays safe for both string and binary chunk variants.',
        'src/utils/http.ts',
        23,
        30,
        { type: 'symbol', symbol: 'readJsonBody' },
    ),
    createStep(
        44,
        'Parse JSON Body',
        'The second half of readJsonBody turns the bytes into text, treats empty bodies as empty objects, and rejects non-object JSON payloads.',
        'src/utils/http.ts',
        32,
        42,
        { type: 'symbol', symbol: 'readJsonBody' },
    ),
    createStep(
        45,
        'Projects Index Route',
        'The index route is the simplest happy path: require a session, ask the service layer for visible projects, and wrap them in a JSON response.',
        'src/routes/projectRoutes.ts',
        7,
        13,
        { type: 'symbol', symbol: 'handleProjectIndexRequest' },
    ),
    createStep(
        46,
        'Project Details Route',
        'The details route resolves the current session and passes the project slug down to the overview service.',
        'src/routes/projectRoutes.ts',
        15,
        24,
        { type: 'symbol', symbol: 'handleProjectDetailsRequest' },
    ),
    createStep(
        47,
        'Rename Route Input',
        'The rename route is async because it reads the request body first, then extracts the proposed name field before validation.',
        'src/routes/projectRoutes.ts',
        26,
        33,
        { type: 'symbol', symbol: 'handleProjectRenameRequest' },
    ),
    createStep(
        48,
        'Rename Route Validation',
        'If the incoming name is missing or too short, the route returns a structured bad request response instead of throwing.',
        'src/routes/projectRoutes.ts',
        34,
        36,
        { type: 'symbol', symbol: 'handleProjectRenameRequest' },
    ),
    createStep(
        49,
        'Rename Route Success',
        'On the success path, the route delegates the mutation to the service layer and returns the refreshed project overview payload.',
        'src/routes/projectRoutes.ts',
        38,
        40,
        { type: 'symbol', symbol: 'handleProjectRenameRequest' },
    ),
    createStep(
        50,
        'Response Writer',
        'At the HTTP app layer, sendJson centralizes response headers and pretty-printed JSON serialization for every branch.',
        'src/http/createApp.ts',
        7,
        10,
    ),
    createStep(
        51,
        'App Factory Setup',
        'createApp returns one async request handler and begins by parsing the request URL into a pathname that later routing checks can match against.',
        'src/http/createApp.ts',
        12,
        17,
        { type: 'symbol', symbol: 'createApp' },
    ),
    createStep(
        52,
        'Health Route',
        'The first route branch is a health endpoint that reports both liveness and the resolved runtime environment.',
        'src/http/createApp.ts',
        18,
        24,
        { type: 'symbol', symbol: 'createApp' },
    ),
    createStep(
        53,
        'Projects Collection Route',
        'The next branch wires GET slash projects straight into the project index route handler and writes the returned JSON envelope.',
        'src/http/createApp.ts',
        26,
        30,
        { type: 'symbol', symbol: 'createApp' },
    ),
    createStep(
        54,
        'Project Details Match',
        'This regex branch extracts a slug from slash projects slash slug and forwards the request into the details route handler.',
        'src/http/createApp.ts',
        32,
        37,
        { type: 'symbol', symbol: 'createApp' },
    ),
    createStep(
        55,
        'Rename Route Match',
        'The rename branch matches POST slash projects slash slug slash rename and awaits the async rename handler before sending the response.',
        'src/http/createApp.ts',
        39,
        47,
        { type: 'symbol', symbol: 'createApp' },
    ),
    createStep(
        56,
        'Fallback And Error Wrapper',
        'The tail of createApp covers both unmatched routes and unexpected failures, converting each one into a consistent JSON error payload.',
        'src/http/createApp.ts',
        49,
        55,
        { type: 'symbol', symbol: 'createApp' },
    ),
    createStep(
        57,
        'Server Bootstrap',
        'The server bootstrap creates the app handler, wraps it in a Node HTTP server, and deliberately ignores the returned promise from each request with void.',
        'src/server.ts',
        6,
        10,
        { type: 'symbol', symbol: 'startServer' },
    ),
    createStep(
        58,
        'Server Listen And Log',
        'Finally, startServer waits for the listener to bind and logs the fully resolved local URL so a human can manually hit the demo API.',
        'src/server.ts',
        12,
        20,
        { type: 'symbol', symbol: 'startServer' },
    ),
];

const samplePayload: PatchwalkHandoffPayload = {
    specVersion: '1.0.0',
    handoffId: `sample-demo-${new Date().toISOString()}`,
    createdAt: new Date().toISOString(),
    producer: {
        agent: 'codex',
        agentVersion: '1.0.0',
        model: 'gpt-5',
    },
    summary: `Patchwalk is about to run a ${walkthrough.length}-step walkthrough of the demo workspace, from package metadata through auth, data access, services, routing, and server startup.`,
    walkthrough,
};

const fetchJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(input, init);
    const bodyText = await response.text();

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${bodyText}`);
    }

    return bodyText ? (JSON.parse(bodyText) as T) : (undefined as T);
};

const main = async (): Promise<void> => {
    const health = await fetchJson<{ ok: boolean }>(`${baseUrl}/health`);
    console.log('health:', health);

    const client = new Client({
        name: 'patchwalk-sample-client',
        version: '1.0.0',
    });
    const transport = new StreamableHTTPClientTransport(new URL(endpointUrl));

    try {
        await client.connect(transport);

        console.log('serverInfo:', client.getServerVersion());
        console.log('capabilities:', client.getServerCapabilities());
        console.log('sessionId:', transport.sessionId ?? null);

        const resources = await client.listResources();
        console.log(
            'resources:',
            resources.resources.map((resource) => resource.uri),
        );

        const statusResource = await client.readResource({ uri: PATCHWALK_STATUS_RESOURCE_URI });
        console.log('status:', statusResource.contents[0]);

        const exampleHandoff = await client.readResource({
            uri: PATCHWALK_EXAMPLE_HANDOFF_RESOURCE_URI,
        });
        console.log('example-handoff:', exampleHandoff.contents[0]);

        const prompts = await client.listPrompts();
        console.log(
            'prompts:',
            prompts.prompts.map((prompt) => prompt.name),
        );

        const composePrompt = await client.getPrompt({
            name: PATCHWALK_COMPOSE_HANDOFF_PROMPT_NAME,
            arguments: {
                changeSummary: 'Walk through the sample workspace in detail.',
                changedFiles: 'test-workspace/src/**/*',
                focusAreas: 'Explain the architecture from entrypoint through routes and services.',
            },
        });
        console.log('compose-prompt:', composePrompt.messages[0]);

        const tools = await client.listTools();
        console.log(
            'tools:',
            tools.tools.map((tool) => tool.name),
        );

        const playResult = await client.callTool({
            name: PATCHWALK_PLAY_TOOL_NAME,
            arguments: samplePayload,
        });
        console.log('play-result:', playResult);
    } finally {
        await Promise.allSettled([transport.terminateSession(), transport.close()]);
    }
};

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Sample MCP call failed: ${message}`);
    process.exitCode = 1;
});
