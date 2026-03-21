# Patchwalk

Patchwalk replays AI code handoffs inside live editor windows.

The extension now runs in two layers:

- a single local daemon that owns the MCP endpoint
- one worker per VS Code/Cursor window that registers workspace roots and can play a handoff locally

The daemon is bundled inside the extension. Users install one extension. They do not install a separate MCP server.

## Runtime model

On the first Patchwalk activation after install:

1. the extension checks `GET /health` on the local daemon port
2. if the daemon is down, the extension spawns the bundled Node daemon
3. the window opens one persistent WebSocket connection to the daemon
4. the worker registers its current workspace folder roots and playback state
5. the worker sends heartbeat and workspace updates over that same socket

If the daemon dies later, any live Patchwalk window will restart it and re-register.

## Commands

- `Patchwalk: Restart Daemon`
- `Patchwalk: Show Daemon Status`
- `Patchwalk: Stop Daemon`
- `Patchwalk: Play Handoff From Clipboard`

`Stop Daemon` is a debug command. Once stopped, the current worker pauses automatic daemon recovery until you restart the daemon or reload the window.

## Settings

- `patchwalk.daemonPort` (default: `7357`)

## MCP endpoint

- URL: `http://127.0.0.1:<patchwalk.daemonPort>/mcp`
- Health check: `GET /health`
- Transport: stateful Streamable HTTP via `@modelcontextprotocol/sdk`
- MCP methods handled on the endpoint: `POST`, `GET`, `DELETE`

The daemon also exposes one private worker socket used only by extension windows:

- `ws://127.0.0.1:<patchwalk.daemonPort>/workers/connect`

## Routing contract

Every handoff must include a root-level `basePath`.

- `basePath` must be an absolute filesystem path.
- The daemon compares `basePath` against the registered workspace roots of every live worker.
- The daemon routes directly to one worker using:
  - exact match first
  - otherwise longest parent-path match
  - otherwise earliest live registration
- The daemon sends a lightweight `playback.prepare` message to the best candidate first.
- If that worker is stale or unavailable, the daemon falls through to the next ranked worker.
- Only the selected worker receives the actual `playback.execute` command.

## Active handoff contract

- Patchwalk allows exactly one active narration across the whole machine at a time.
- If any worker is already playing or stopping a handoff, new `patchwalk.play` requests are rejected immediately.
- Clipboard playback uses the same daemon path and is subject to the same single-active-handoff rule.
- Use `patchwalk.stop` to stop the currently active narration globally.

## Minimal payload

```json
{
  "specVersion": "1.0.0",
  "handoffId": "8d8f64f2-6f2c-4f91-a7ba-3af2f0ef8d9a",
  "createdAt": "2026-03-05T09:10:00Z",
  "basePath": "/Users/mac/Vault/the-60/my-project",
  "producer": { "agent": "codex", "agentVersion": "1.0", "model": "gpt-5" },
  "summary": "Added refresh flow.",
  "walkthrough": [
    {
      "id": "step-1",
      "title": "Refresh handler",
      "narration": "This file adds refresh token validation, rotation, and response shaping.",
      "path": "src/auth/refresh.ts",
      "type": "symbol",
      "symbol": "handleRefresh",
      "range": { "startLine": 24, "endLine": 92 }
    }
  ]
}
```

Relative step paths resolve from `basePath`, not from the currently focused editor tab.

## Capabilities

Tools:

- `patchwalk.play`
- `patchwalk.stop`

Resources:

- `patchwalk://server/status`
- `patchwalk://server/operator-manual`
- `patchwalk://handoff/example`
- `patchwalk://handoff/authoring-guide`

Prompts:

- `patchwalk.compose-handoff`
- `patchwalk.expand-walkthrough`

## Manual testing

Run the sample client:

```bash
pnpm play:sample
```

If you changed the daemon port:

```bash
PATCHWALK_DAEMON_PORT=7357 pnpm play:sample
```

Expected result:

1. the client connects to the daemon MCP endpoint
2. the daemon status resource shows registered workers
3. the handoff is routed to the best matching live window
4. that window opens files, highlights ranges, and narrates the walkthrough
5. if another handoff is already active, the daemon rejects the request until the active one completes or is stopped

Before generating non-trivial payloads, read `patchwalk://handoff/authoring-guide`. It tells MCP clients to write semantic engineer-facing explanations with intent, risk, blast radius, behavior changes, tests, and architecture, while filtering out formatting-only noise.

## Recovery steps

### Daemon is down

Symptom:

- `GET /health` fails
- MCP clients cannot connect

Recovery:

1. open any VS Code/Cursor window with Patchwalk installed
2. wait for activation or run `Patchwalk: Restart Daemon`
3. retry the MCP call

Expected outcome:

- `GET /health` returns `ok: true`
- `patchwalk://server/status` shows at least one registered worker

### Handoff does not play anywhere

Symptom:

- MCP tool call returns an error saying no live Patchwalk window matched `basePath`

Recovery:

1. verify `basePath` is absolute
2. verify a Patchwalk-enabled window has the exact path open as a workspace root, or a parent of it open as a workspace root
3. run `Patchwalk: Show Daemon Status` and inspect the registered worker roots
4. resend the handoff

### New handoff is rejected as already active

Symptom:

- MCP tool call returns an error saying another Patchwalk handoff is already active

Recovery:

1. run the MCP tool `patchwalk.stop`, or wait for the current narration to complete
2. if you think nothing is active, run `Patchwalk: Show Daemon Status`
3. inspect `activeHandoff` and each worker `playbackState`
4. if the daemon state is stale, reload the worker window that still reports playback

### Wrong window wins routing

Recovery:

1. prefer sending the most specific `basePath`
2. if two windows both open parents of the same path, open the exact project root in the intended window
3. if the tie is still identical, reload the intended window first so it becomes the earliest live registration

## Development

```bash
pnpm install
pnpm esbuild:base
```

Run the extension via `F5` in VS Code.
