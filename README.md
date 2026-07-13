# Patchwalk

**Patchwalk speaks an AI's code changes back to you, inside your editor.**

AI agents now write most of the code, and it's easy to ship it without ever reading it. Patchwalk
fixes that: right after an agent finishes a run, it launches a **walk** — a short, spoken
walkthrough that plays inside your editor, highlighting each file and range while narrating **what
changed and, more importantly, _why_**. It's the difference between a wall of diff text and a senior
engineer explaining the change out loud.

Patchwalk is **not** a code-review tool (it doesn't gate PRs or score risk). It _explains_ — for
three jobs:

1. **Post-run handoff** — an agent finishes a change while you're elsewhere; Patchwalk walks you
   through the reasoning when you come back.
2. **Change review** — walk any change to confirm it matches the ask.
3. **Codebase onboarding** — get a whole system explained start to finish, step by step.

Voice is the point. A **sidebar transcript** is its companion, so the reasoning is still there to
re-scan after the audio moves on.

---

## How it works

An external AI agent (Claude Code, Codex, …) can't call an MCP server that lives inside one editor
window, and N windows can't share one port. So Patchwalk runs a **single local daemon** that owns
the MCP endpoint and **routes** each walk to the right editor window over a private WebSocket.

```
  External AI agent ──HTTP (MCP)──▶  Patchwalk daemon (127.0.0.1:7357)
   (Claude / Codex)  ◀──{launched}──   ├─ /mcp   Streamable-HTTP endpoint
                                        └─ /workers/connect  WebSocket router
                                                     │
                          ┌──────────────────────────┼──────────────────────┐
                       VS Code #1                 VS Code #2      …        VS Code #N
                    (worker + sidebar + playback)
```

A walk carries an absolute `basePath`. The daemon routes it to the window whose workspace root
**equals** that path, else the **deepest parent**, else the **earliest-registered** window. Exactly
**one walk plays machine-wide at a time** (it's a single voice).

`patchwalk.play` returns as soon as the walk is **launched** — it never blocks while narration plays.
You drive the running walk from the Patchwalk sidebar (pause, next, stop, replay, jump).

---

## Install & set up

1. Install the Patchwalk extension in VS Code or Cursor. On first activation it starts the bundled
   daemon automatically — you do **not** install a separate MCP server.
2. Point your agent at the MCP endpoint: `http://127.0.0.1:7357/mcp` (Streamable HTTP).
   For example, add it to your Claude Code / Codex MCP config, then tell the agent to call
   `patchwalk.play` after each change.
3. Open the project you're working in as a workspace folder so the daemon can route walks to it.

---

## MCP surface

**Tools**

- `patchwalk.play(walk)` — launch a spoken walk in the matching window. Returns immediately:
  `{ status: 'launched', walkId, handoffId, workerId, matchedRoot, steps }`. Rejected if a walk is
  already active anywhere on the machine.
- `patchwalk.stop()` — stop the active walk (interrupts narration immediately).
- `patchwalk.status()` — the active walk's window, step index/total, and state.

**Prompts** (draft a walk with your agent)

- `patchwalk.compose-handoff` — a full walk for a change.
- `patchwalk.expand-walkthrough` — turn a summary + file list into walk steps.
- `patchwalk.compose-onboarding` — a whole-codebase onboarding walk.

**Resources**

- `patchwalk://server/status` · `patchwalk://server/operator-manual`
- `patchwalk://handoff/example` · `patchwalk://handoff/authoring-guide`

> Read `patchwalk://handoff/authoring-guide` before generating walks. Because the narration is
> **spoken**, it must be written to be heard: conversational sentences about the **what and the
> WHY** — never a diff narration, never code or line numbers read aloud.

### Walk payload

```json
{
  "specVersion": "1.0.0",
  "handoffId": "8d8f64f2-6f2c-4f91-a7ba-3af2f0ef8d9a",
  "createdAt": "2026-03-05T09:10:00Z",
  "basePath": "/Users/you/project",
  "producer": { "agent": "codex", "model": "gpt-5" },
  "summary": "Fixes a race in cache eviction and doubles the retry backoff.",
  "walkthrough": [
    {
      "id": "step-1",
      "title": "Eviction lock ordering",
      "narration": "The lock now wraps the lookup, so two requests can't evict the same entry at once — that was the source of the intermittent nil-pointer panic.",
      "path": "src/cache/evict.ts",
      "range": { "startLine": 24, "endLine": 92 }
    }
  ]
}
```

Relative step `path`s resolve from `basePath`, not the focused tab.

---

## The sidebar (activity bar)

Open the Patchwalk view in the activity bar to monitor and control a walk:

- **Now Playing** — summary, current step, `i / N`, and transport controls: ⏮ ⏯ ⏹ ⏭ ↻.
- **Walk transcript** — every step's narration; the current one is highlighted; **click a step to
  jump** to its file and range. The reasoning persists here after the voice moves on.
- **Voices** — pick the narration voice, or download a local neural voice (below).

---

## Voice

By default Patchwalk uses your OS voice — macOS `say`, Windows SAPI, Linux `espeak-ng` — with no
setup, offline, and private.

For a more natural, human-sounding walk, download a **local neural voice** (e.g. Kokoro) from the
**Voices** panel. It runs fully offline via a bundled runtime, with no API keys. If a neural voice
can't run on your machine, Patchwalk falls back to the system voice and tells you honestly rather
than playing silence.

---

## Commands & settings

**Commands**

- `Patchwalk: Restart Daemon` · `Patchwalk: Show Daemon Status` · `Patchwalk: Stop Daemon`
- `Patchwalk: Play Walk From Clipboard`

**Settings**

- `patchwalk.daemonPort` (default `7357`) — the local daemon port.
- `patchwalk.voice` (default `"system"`) — active voice; set to a downloaded neural voice id from
  the Voices panel.

---

## Development

```bash
pnpm install
pnpm esbuild:base       # build the extension + daemon bundles
pnpm test               # build, then run the full suite in a real VS Code host
```

Run the extension with `F5` in VS Code. Smoke-test the MCP surface against a running daemon (and an
open Patchwalk window on the given path):

```bash
pnpm play:sample /abs/path/to/your/workspace
```

---

## Troubleshooting

- **`patchwalk.play` says no window matched `basePath`.** Open the exact project root (or a parent)
  as a workspace folder in a Patchwalk-enabled window, then retry. `patchwalk.status` and
  `Patchwalk: Show Daemon Status` show the registered windows.
- **A walk is rejected as already active.** Only one walk plays at a time — call `patchwalk.stop`
  (or use the sidebar) and retry.
- **The daemon seems down.** Any live Patchwalk window restarts it; run `Patchwalk: Restart Daemon`
  and retry. `GET http://127.0.0.1:7357/health` should return `{ "ok": true }`.
