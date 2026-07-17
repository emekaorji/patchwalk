# Changelog

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
