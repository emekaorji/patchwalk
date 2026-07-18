# Changelog

## 0.1.3 — one-click agent setup

### One-click agent setup

- On first activation, Patchwalk now **auto-connects** its MCP server into every AI agent it finds on
  your machine — **Claude Code, Cursor, VS Code (Copilot), Windsurf, Claude Desktop, Cline, Roo Code,
  Codex, Gemini CLI, and Continue** — and tells you which to restart. No more hand-editing config
  files; usually you just restart the agent.
- The merge is surgical and safe: only the `patchwalk` entry is written, other servers/keys/comments
  are preserved, each file is written atomically with a one-time backup, and the result is verified
  before it lands. It skips agents that aren't installed, and is idempotent.
- Each agent gets the right shape automatically (the fields differ in ways that silently break a
  connection): `url` vs `serverUrl` vs `httpUrl`, VS Code's `servers` key, Cline's `streamableHttp`
  vs Roo's `streamable-http`, Codex's TOML, Continue's YAML list, and an `mcp-remote` bridge for
  Claude Desktop (which has no native HTTP transport).
- Re-run any time with the **Patchwalk: Connect My Agents** command. Anything that can't be wired up
  gets a copy-paste manual-setup fallback in the notification.

## 0.1.0 — first preview

The first public preview of Patchwalk: your AI agent finishes a change, and Patchwalk **explains it
out loud** inside your editor, highlighting each file and range as it speaks.

### Walks

- An agent launches a walk through the MCP tool `patchwalk.play`. The call **returns as soon as the
  walk starts** — the agent is never blocked for the length of the narration.
- A step can carry **sub-segments**: the step selects its whole range and introduces it, then each
  sub-segment narrows the selection to a few lines and says one short line about them. The highlight
  follows the voice, like a subtitle, instead of parking on a whole file.
- The narrated range is a **real editor selection** — you can copy it.
- A **gutter marker** tracks the line being spoken.

### Narration quality

- Length is enforced, not suggested: the caps reach the authoring agent as `maxLength` in the tool
  schema, and an over-long walk is rejected rather than played at you.
- `patchwalk.narrationStyle` — `terse` (dense, high-signal) or `grounded` (more explanatory, for
  onboarding). This rewrites the instructions the daemon gives agents, so it is a **global** setting.
- Pacing is tunable: `patchwalk.pacing.stepGapMs` and `patchwalk.pacing.subSegmentGapMs`.

### The window that is playing

- A status-bar badge marks the window currently narrating; every other window offers to reveal it.
- The **overview editor** opens beside your code with the agenda and stats of what is about to be
  explained, so the opening segment is never dead air.
- The activity-bar **sidebar** shows a live transcript. Click any row to play from that point — it
  jumps a running walk, or replays a finished one.
- Optional `patchwalk.tintWindowDuringPlayback` tints the window chrome while a walk plays.

### Voice

- Uses your **OS voice** (macOS `say`, Windows SAPI, Linux `espeak-ng`) — offline, private, no setup.
- Choose the voice with `patchwalk.systemVoice`; it strongly affects pacing.
- Audio for the next line is rendered while the current one is still being heard, which removes the
  multi-second pause that per-line speech synthesis would otherwise put between every segment.
- Neural voices (Kokoro) are visible in the Voices panel but marked **experimental — not yet
  available**; they are not downloadable in this release.

### Notes

- Patchwalk runs one small local daemon (default port `7357`) that owns the MCP endpoint and routes
  each walk to the editor window that owns the project. It shuts itself down once no editor windows
  are left.
- Everything is local. No account, no API key, nothing leaves your machine.
