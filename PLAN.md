# Patchwalk — Rebuild Plan

> Status: **active rewrite plan** (aggressive). Supersedes the previous PLAN.md (a product wishlist).
> Owner: Emeka Orji. Last updated: 2026-07-11.

---

## 0. What Patchwalk is (and is not)

Patchwalk fights **developer dulling**. AI coding agents now write most of the code, and
engineers increasingly ship it without reading it — including the PRs. Patchwalk makes an
agent's work _understandable the moment a run finishes_ by **speaking the change to the
developer inside their editor**, patch by patch, focused on the **what and the WHY** — the
reasoning behind each change — the way a senior engineer would explain it in person.

Three jobs:

1. **Post-run handoff.** A dev tells Claude Code / Codex to fix a bug; the agent does it while
   the dev is elsewhere. Right after the pass, the agent launches a Patchwalk walk; the dev
   listens to _why_ those files/lines were touched instead of reading a wall of text.
2. **Change review.** A senior/junior engineer at a company walks any change to confirm it
   matches the ask.
3. **Codebase onboarding.** A newcomer gets the whole system explained start-to-finish,
   step-by-step.

**Patchwalk is NOT a code-review tool** (not CodeRabbit). It does not gate PRs, score risk,
or replace review. It _explains_. **Voice is compulsory and central** — the product exists
because engineers are tired of reading AI slop; the walk must feel like a person who
understands the system talking to you, not a description of logic (the dev already knows
logic — they need intent and reasoning).

Design consequences of "voice-first":

- The walk narration is **the what + the WHY**, not line-by-line description. The MCP tool's
  authoring instructions must force the generating agent to write reasoning, intent, and
  consequence — not diff paraphrase.
- Voice is the experience; a **sidebar transcript is its companion**, not a replacement — so
  the reasoning is still there to re-scan after the audio moves on.

---

## 1. Architecture (confirmed)

```
  ┌─────────────┐   Streamable HTTP (MCP)    ┌──────────────────────────┐
  │ External    │ ─────────────────────────▶ │  Patchwalk Daemon        │
  │ AI agent    │   patchwalk.play(walk)     │  (one per machine,       │
  │ (Claude/    │ ◀───────────────────────── │   fixed localhost port)  │
  │  Codex CLI) │   { launched, walkId }     │  - MCP endpoint /mcp      │
  └─────────────┘                            │  - worker router          │
                                             │  - single-active lock     │
                                             └───────────┬──────────────┘
                                    WebSocket /workers/connect (control plane)
                        ┌──────────────────────┼───────────────────────┐
                        ▼                      ▼                       ▼
                 ┌────────────┐         ┌────────────┐          ┌────────────┐
                 │ VS Code #1 │         │ VS Code #2 │   ...    │ VS Code #N │
                 │  worker    │         │  worker    │          │  worker    │
                 │  + sidebar │         │  + sidebar │          │  + sidebar │
                 │  + playback│         │  + playback│          │  + playback│
                 └────────────┘         └────────────┘          └────────────┘
```

### Why a daemon (not extension-hosted MCP)

An extension-registered MCP server is sandboxed to that window's own agent; it **cannot
receive calls from external tools** (Codex, Claude Code CLI), which is exactly who launches
walks. And N windows cannot each bind the same fixed port. So a **single machine-wide daemon**
on a known localhost port owns the MCP endpoint and **routes** each walk to the right window.
This premise is correct and is kept.

### Routing (kept, from `src/lib/routing.ts`)

A walk carries an absolute `basePath`. The daemon picks the window whose workspace root
**equals** `basePath`, else the **deepest parent** of it, else the **earliest registered**.
Exactly **one walk may be active machine-wide** at a time (single audio device; talking over
yourself is nonsense) — a second launch is rejected with a clear reason while one is active.

### Transport decision: keep WebSocket for the control plane

The daemon↔window channel is **bidirectional + request/response** (prepare→ready,
execute→started→completed, stop→stopped). WS gives one duplex socket per window with free
per-connection identity and a `close` event — precisely what a router/registry needs.

- **SSE was evaluated and rejected here:** it is one-way, so matching today's behavior needs
  SSE-down + POST-up (two half-channels to re-correlate by workerId) — more surface, not less.
  Its wins (proxy/NAT traversal, browser `EventSource` auto-reconnect) do not apply: this is
  **127.0.0.1 loopback** and the extension host is **Node, not a browser**.
- **MCP endpoint stays on Streamable HTTP** (current). Do **not** move it to MCP's legacy
  HTTP+SSE transport — that transport is deprecated in favor of Streamable HTTP.

---

## 2. Core problems in the current build (verified) and how the rewrite fixes them

These were confirmed by reading the code and adversarially verifying. Packaging/publish
issues are explicitly **out of scope** (nothing is published).

| #   | Problem (verified)                                                                                                                                                                                                                                                                                                                               | Where                                                      | Fix                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | **`patchwalk.stop` cannot interrupt a walk.** The worker processes inbound WS messages on one serial queue, and `handleExecuteMessage` `await`s `playbackRunner.play()` until the whole walk ends — so a `stop` message is stuck behind it; `abort()` never fires; daemon times out at 10s "did not acknowledge stop" while audio keeps playing. | `workerController.ts:189-196,342`; `playback.ts:86-101`    | Decouple playback from the message queue (§4). Control messages (stop/pause/next) run out-of-band and hit a live run handle immediately.                           |
| P2  | **`patchwalk.play` blocks the calling agent for the entire walk** (up to a 5-min cap). Pins the agent turn; risks JSON-RPC idle timeout.                                                                                                                                                                                                         | `mcpServer.ts:791,1367-1371`                               | **Launch + ack, async** (§3): return `{ status:'launched', walkId, workerId, steps }` on launch; completion/stop observed via status + sidebar, never by blocking. |
| P3  | **Prepare = "silence means success."** No positive ack; a wedged-but-TCP-open window swallows the walk and hangs the agent ~5 min with no failover. Also a fixed 300ms tax per walk.                                                                                                                                                             | `workerController.ts:322-338`; `mcpServer.ts:1464-1481`    | **Positive `playback.ready` ack** (§4). Daemon proceeds only on ready; on failed/timeout it fails over to the next candidate immediately.                          |
| P4  | **The reasoning evaporates.** Narration is TTS-only; never rendered, persisted, or returned. No view exists at all. After a walk, zero artifact.                                                                                                                                                                                                 | `playback.ts:130,192`; no view in `package.json`           | **Sidebar walk monitor with a live transcript** (§5). Voice stays primary; transcript is the durable companion.                                                    |
| P5  | **Focus theft + tab litter + no lasting highlight.** Every step `showTextDocument(preview:false, preserveFocus:false)`, clobbers the user's cursor, and clears the highlight in a per-step `finally`.                                                                                                                                            | `playback.ts:173-195`                                      | Reworked playback: reveal without stealing focus by default, reuse a single walk editor group, keep the current step highlighted, click-to-jump from the sidebar.  |
| P6  | **Silent no-op where TTS is missing** (headless Linux/containers/WSL without espeak): N warning toasts, no audio, but the tool still reports success.                                                                                                                                                                                            | `tts.ts:96-102`; `playback.ts:210-227`                     | Pluggable voice engine (§6) with a guaranteed system fallback and honest status surfaced to the sidebar + tool result.                                             |
| P7  | **Daemon start failures vanish** (`stdio:'ignore'` + `console.error` not the file logger). **Port reclaim SIGTERMs any process on the port** without checking it is a Patchwalk daemon. Spawn relies on inherited `ELECTRON_RUN_AS_NODE`.                                                                                                        | `daemonClient.ts:214-228,262-289`; `daemon/index.ts:79-82` | Reliability hardening (§7): log the daemon boot path to file; verify `/health serverKind` before killing anything; set `ELECTRON_RUN_AS_NODE:'1'` explicitly.      |

Note: the multi-window routing, schema, and daemon MCP skeleton are **sound** and are kept —
the daemon boots and serves correctly standalone; the failures above live in the untested gap
(current tests mock the worker and never drive a real editor).

---

## 3. MCP surface (external agent ↔ daemon)

**Tools**

- `patchwalk.play(walk)` → **launch + ack**. Validates, routes, gets a `playback.ready` +
  `playback.started` from the chosen window, and returns immediately:
  `{ status: 'launched', walkId, workerId, matchedRoot, steps }`. Never blocks on completion.
  Optional `{ await: true }` to block until completion for scripted use.
- `patchwalk.stop()` → stop the one active walk machine-wide. Must actually interrupt (see P1).
- `patchwalk.status()` (new) → current walk: window, step index/total, state, so an agent can
  poll if it wants.

**Prompts / resources** (authoring)

- Keep the compose/expand prompts and the authoring guide, but **sharpen the instruction**:
  the walk must explain **what changed and WHY / the reasoning and intent**, not describe
  logic the developer already understands. Filter formatting/noise. Order steps entrypoint →
  detail. This guidance is the product's quality bar and belongs in the MCP tool description +
  the authoring-guide resource so every generating agent complies.

**Walk payload** — keep `src/lib/schema.ts` (`specVersion`, `handoffId`, `createdAt`,
`basePath`, `producer`, `summary`, ordered `walkthrough[]` of `{id,title,narration,path,range,
type?,symbol?}`). It is a good, durable data model. Rename user-facing "handoff" → "walk"
consistently; keep `basePath` absolute (routing depends on it).

---

## 4. Control plane rewrite (WS) — the heart of the fix

Root cause of P1/P3: playback lifecycle is entangled with WS message processing.

**Principle: the WS message queue only does fast state transitions; playback runs off it.**

New/changed message types (`src/lib/controlProtocol.ts`):

- Daemon→window: `playback.prepare`, `playback.execute`, `playback.stop`, `playback.pause`,
  `playback.resume`, `playback.next`, `playback.previous`, `worker.reconcile`.
- Window→daemon: `worker.register/update/heartbeat`, **`playback.ready`** (new positive
  prepare-ack), **`playback.started`** (new launch ack), `playback.progress` (new: step index
  changes → drives sidebars + status), `playback.completed`, `playback.failed`,
  `playback.stopped`, `playback.paused`/`playback.resumed`.

Worker changes (`src/extension/workerController.ts`):

- `handleExecuteMessage` **does not await** the walk. It: validates → starts
  `playbackRunner.play()` (returns a run handle) → sends `playback.started` → attaches
  `.then(completed).catch(failed)` to emit terminal messages later.
- `handlePrepare` sends `playback.ready` when it can serve (idle + path match), else
  `playback.failed(prepare)`.
- Control messages (`stop/pause/resume/next/previous`) act on the live run handle
  **immediately** — they are never blocked behind a running walk.

Daemon changes (`src/daemon/mcpServer.ts`):

- `prepare` waits for `playback.ready` (short timeout) instead of assuming success on silence;
  on `failed`/timeout → next ranked candidate.
- `dispatchPlayback` resolves the tool call on `playback.started` (launch+ack), not on
  completion. Remove the 5-min execution-timeout-as-primary-path; keep it only as a watchdog
  that transitions daemon state, not as the thing the agent waits on.
- Keep the single-active lock, but source of truth = daemon `activeWalk`; window heartbeats
  reconcile, they don't silently flip the lock.

---

## 5. Sidebar walk monitor (NEW — activity bar)

Net-new; nothing like it exists today. This is the control surface **and** the persistent
artifact that answers P4/P5.

`package.json` contributes `viewsContainers.activitybar` (Patchwalk icon) + views. Webview
view (rich) is preferred over TreeView for transcript + controls.

Panels:

1. **Now Playing** — walk summary, current step (title + why), step i/N, transport controls:
   ⏮ prev · ⏯ play/pause · ⏹ stop · ⏭ next · ↻ replay step. Buttons map to the control
   messages in §4 (and finally exercise the now-working stop/pause).
2. **Walk transcript** — the ordered steps with their narration text; current step highlighted;
   **click a step → jump to its file/range** (reuse the highlight decoration, no focus theft).
   This is where the reasoning **persists** after the voice moves on.
3. **Voices** — download/manage local neural voices (§6): list (name, size, quality, license),
   Download/Remove, and the active-voice selector. No download → system voice.
4. **Daemon status** — health, this window's routing roots, active walk elsewhere (replaces the
   opaque "Show Daemon Status" output dump).

State feed: the worker already knows local playback state; it pushes `playback.progress` to the
daemon and to its own sidebar. A newly opened sidebar reads current state from the worker.

---

## 6. Voice subsystem (pluggable; local neural + system fallback)

Decision: **opt-in, locally-downloadable neural voices**, managed from the activity bar;
**system voice** (`say`/SAPI/espeak-ng) is the zero-config fallback when nothing is downloaded.
Fully offline, no API keys, private.

**Finalized (research-backed — sources at end of section).**

- **Runtime to bundle: `sherpa-onnx` via `sherpa-onnx-node`** (N-API addon). Apache-2.0
  (commercial-safe), ships **prebuilt per-platform binaries** (macOS/Windows/Linux, arm64+x64)
  as `optionalDependencies` — no local compilation — **loads in-process** in the extension
  host, fully offline, no API key. One runtime hosts many voice families (Kokoro, Piper/VITS,
  Matcha, MeloTTS, KittenTTS), so **new voices are just model downloads, never an engine swap**.
  Needs per-platform lib-path env at spawn (`DYLD_LIBRARY_PATH` / `LD_LIBRARY_PATH`; automatic
  on Windows). Pin a known version (research anchored to v1.13.4 — re-verify at build time).
- **Default downloadable voice: Kokoro-82M.** **Apache-2.0 on both runtime and weights**
  (cleanly redistributable — the load-bearing license fact), ~82–92 MB ONNX, ~28 English voices
  (20 US + 8 GB), the **most natural of the small local models** — the best fit for "a senior
  engineer calmly explaining." CPU cost is near real-time (~0.8–1× RTF single-thread; faster
  with threads / int8 / WebGPU); acceptable because we **pre-synthesize the next utterance while
  the current one plays**.
- **Speed / low-resource alternative: Piper** — RTF ~0.114 (~9× realtime, the CPU leader),
  largest English library (~29 voices + a 904-speaker `libritts_r` model), ~20–75 MB/voice.
  **License caveat:** the classic runtime is MIT but was archived Oct 2025 (the active fork is
  GPL-3.0 — pin the MIT-era runtime), and **per-voice weight licenses are unsettled** (the
  "repo is MIT" claim failed verification; training corpora vary). Offer Piper voices opt-in
  only after vetting each voice's corpus license.
- **Fallback (no download): OS voices** — macOS `say`, Windows SAPI, Linux `espeak-ng`. Always
  available, zero-config, private. This is what runs until the user downloads a neural voice.
- **Excluded: Coqui XTTS-v2** — non-commercial CPML weights, and no entity to license it after
  Coqui's 2024 shutdown. Do not ship it.

**Interruption / streaming:** sherpa-onnx TTS is **synthesize-per-utterance (non-streaming)**.
Chunk narration into sentences and drive **pause / stop / next at utterance boundaries** (don't
synthesize or play the next chunk). Mid-utterance abort is possible via `OfflineTts.generate`'s
progress callback (its return value aborts generation) — confirm at build time; regardless the
**audio player is a killable process**, so stop is immediate.

**Audio output** (the one detail research left open): `sherpa-onnx-node` returns PCM samples +
sample rate, not audible sound. Play each utterance through a **killable** path — write a WAV and
play via a child process (`afplay` / PowerShell / `ffplay` / `aplay`) or a Node audio binding —
and prefetch the next utterance's synthesis while the current plays. Killing the player = instant
stop; that is what wires the P1 fix through to the neural engine.

> License verdicts here are engineering research, not legal advice — have counsel confirm any
> redistributed weights (especially Piper). Re-verify versions/licenses at build time.

**Sources:** k2-fsa sherpa-onnx JS API & `nodejs-addon-examples` README; sherpa-onnx pretrained
TTS models catalog; npm `sherpa-onnx-node` (Apache-2.0, per-platform binaries); HuggingFace
`hexgrad/Kokoro-82M` (Apache-2.0) & `rhasspy/piper-voices`; Coqui `XTTS-v2` CPML license;
csukuangfj RTF benchmarks. (Full cited report saved with the research run.)

Interfaces:

- `TtsEngine { speak(text, {signal}): Promise<void>; stop(): void; readonly ready: boolean }`.
- `SystemVoiceEngine` — current `say`/PowerShell/espeak-ng path; always available; the fallback.
- `LocalNeuralEngine` — runs a downloaded model via the bundled runtime; synthesizes
  **per-utterance**; **interruptible** (abort synth + kill audio on stop/pause/next — required
  for the transport controls).
- **Audio output** is a real cross-platform concern (neural models emit PCM/WAV, unlike `say`
  which plays directly). Integration path (afplay/ffplay/aplay/PowerShell vs. a Node audio
  binding vs. runtime-plays-directly) is decided with the research and must support
  mid-utterance stop.

Download manager: fetch model to `context.globalStorageUri`, verify checksum, register;
persist selected voice in settings; surface progress/failure in the Voices panel.

---

## 7. Reliability hardening

- **Daemon boot diagnostics:** route `daemon/index.ts` `main().catch` through the file logger;
  optionally tee spawned daemon stdio to a log file instead of `stdio:'ignore'` so a dead
  daemon leaves a trail.
- **Safe port reclaim:** before killing anything on the port, probe `/health` and confirm
  `serverKind === 'patchwalk-daemon'`; never SIGTERM an unidentified process. If the port is
  held by a non-Patchwalk process, surface a clear error, don't kill.
- **Explicit `ELECTRON_RUN_AS_NODE:'1'`** in the spawn env (defensive; today it works only by
  inheritance).
- **Liveness:** keep the 5s heartbeat + 20s stale-prune, but base dispatch readiness on the
  positive `playback.ready` ack so a zombie window can never swallow a walk.

---

## 8. Aggressive rewrite scope — keep / rewrite / delete

**Keep (good assets):** `src/lib/schema.ts`, `src/lib/routing.ts`, `src/lib/pathUtils.ts`,
`src/lib/logger.ts`, the daemon HTTP + Streamable-HTTP MCP skeleton, the WS worker transport,
the routing/schema unit tests.

**Rewrite:**

- `src/lib/controlProtocol.ts` — add `ready/started/progress/pause/resume/next/previous`; make
  acks positive.
- `src/extension/workerController.ts` — decouple playback from the message queue; out-of-band
  control handling; run handles.
- `src/extension/playback.ts` — non-blocking run handle; pause/resume/step nav; no focus theft;
  emit progress/transcript events; sane decoration lifecycle.
- `src/daemon/mcpServer.ts` — launch+ack dispatch; positive prepare-ack; failover on
  ready-timeout; watchdog (not blocking) execution timeout.
- `src/extension/daemonClient.ts` — defensive spawn; safe port reclaim.
- `src/extension/tts.ts` → `src/extension/voice/*` — pluggable engine + neural + audio routing.

**Add (net-new):** activity-bar sidebar (walk monitor + transport + transcript + voices),
voice download manager, audio playback layer, `patchwalk.status` tool.

**Delete:** "silence = success" prepare logic; blocking-execution-as-primary path; the forced
daemon round-trip for same-window clipboard play; the current `send-sample-handoff*` scripts
(replace with new fixtures that exercise launch+ack + control messages).

---

## 9. Phased delivery

- **Phase 0 — Control plane works.** Decouple playback from the WS queue; positive
  `ready`/`started` acks; launch+ack `patchwalk.play`; **stop and pause actually interrupt**.
  A walk runs end-to-end with the system voice and is fully controllable. (Unblocks everything.)
- **Phase 1 — Sidebar.** Activity-bar view: Now Playing + transport controls + live transcript
  (click-to-jump) + daemon status. Playback stops stealing focus; highlight persists per step.
- **Phase 2 — Voice.** Bundle sherpa-onnx (§6); pluggable engine; Kokoro-82M as the default
  downloadable voice + download manager; interruptible per-utterance synth + killable audio
  routing; system-voice fallback.
- **Phase 3 — Product depth.** Sharpen MCP authoring instructions (what+why); onboarding-walk
  use case (explain a whole codebase, not just a diff); multi-window routing + reliability
  hardening (§7).
- **Phase 4 — Ship.** Real-editor test harness, docs, packaging.

---

## 10. Testing (fix the biggest gap)

Current tests mock the worker and never drive a real editor, so every real failure hid there.
Add:

- **Real playback integration tests** in the `@vscode/test-electron` host: open files, assert
  decorations/step navigation, and assert **stop/pause actually interrupt** a running walk
  (the P1 regression guard).
- **Control-plane tests:** positive prepare-ack, failover on ready-timeout, launch+ack timing,
  zombie-window does-not-hang.
- **Daemon spawn test** in a real host (execPath + `ELECTRON_RUN_AS_NODE`).
- **Voice engine tests:** system fallback selected when no model; interruption kills synth+audio.
- Keep the routing + schema unit tests.

---

## 11. Open questions

- Voice stack is decided (§6: sherpa-onnx + Kokoro-82M, system fallback). Remaining
  implementation detail: the exact **killable audio-output path** (child-process player vs. Node
  audio binding) and whether to use `OfflineTts.generate`'s progress-callback abort for
  mid-utterance stop — settle during Phase 2.
- Onboarding walks: does the generating agent produce the whole-codebase walk, or does the
  extension help map it? (Phase 3.)
- Should walks be persistable/replayable (save a walk, re-listen later)? Natural extension of
  the transcript artifact.
