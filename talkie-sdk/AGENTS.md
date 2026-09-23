# Agent Implementation Guide — talkie-sdk

This file is for AI coding agents working in `talkie-sdk/`. It is meant to let you implement a
change end to end — design, code, tests, verification, commit — without asking a human, and to
tell you precisely where you **must** stop and ask instead.

Every fact here was checked against the code when it was written. Symbols are cited by file and
name, not line number, because line numbers drift. If this file and the code ever disagree, **the
code wins**: fix this file in the same change.

---

## 0. Read order and precedence

1. **This file** — how to work here, the invariants, the traps.
2. **The source** — the JSDoc in `src/` is detailed and explains *why*; read the file you touch in
   full before editing it.
3. **`README.md`** — consumer-facing behaviour and API. Keep it true when behaviour changes.
4. **`docs/integration.md`** — framework snippets, embed attributes, CORS/CSP/HTTPS notes.
5. **`SPEC.md`** — the original build spec. Its hard rules still bind, **except** where §14 below
   records that a later, deliberate change superseded them.
6. `docs/design/voice-ui-mockup.html` — the visual mockup the widget was extracted from. Useful
   for look and copy only; its behaviour is simulated and has known bugs (SPEC.md lists them).

---

## 1. What this is

`@talkie/voice-ui` (version `0.1.0`, not published to npm) is a framework-agnostic voice-assistant
UI built from Lit + Lion web components. A host page gets a floating launcher and a six-state
widget (`idle → listening → transcribing → thinking → speaking`, plus `error`) in one of two
modes: push-to-talk, or a hands-free conversation (§5.3a). The widget never
talks to a speech or language vendor; it talks to one **backend** object (§5.2). Three backends
ship: `MockBackend` (scripted, no network), `HttpBackend` (a Talkie voice server that coordinates
separate ASR/LLM/TTS vendors), and `VoiceAgentBackend` (the AssemblyAI Voice Agent API, one
WebSocket for the whole turn). `<talkie-assistant>` plus `dist/talkie-embed.js` lets any page embed
the whole thing with one script tag.

---

## 2. Invariants — MUST and MUST NOT

Breaking any of these is a defect even if every test passes.

**Packaging**
- MUST NOT call `customElements.define` anywhere except `src/define/*.js`. Check:
  `grep -rn "customElements.define" src/` — the only code matches must be under `src/define/`
  (a comment in `src/index.js` mentions it; that is fine).
- MUST keep `src/index.js` side-effect free: re-exports only. New public classes are exported
  from it **and** get an entry in `package.json` `exports` if consumers import the file directly.
- Any component that renders another component **in its template** MUST use `ScopedElementsMixin`
  and list it in `static get scopedElements()` (see `TalkieWidget`, `TalkieLauncher`).
- MUST NOT hard-code a Google Fonts `<link>` into a component. Fonts are optional with system
  fallbacks; `<talkie-assistant fonts="google">` is the only opt-in path.
- MUST NOT add runtime dependencies without the human's approval. Current: `lit`, `@lion/ui`,
  `@open-wc/scoped-elements`. Dev: `esbuild`, `marked` (site docs), `hono` + `@hono/node-server` (`server.mjs`). No test framework — plain `node tests/*.mjs`.

**Safety**
- MUST NOT use `innerHTML` (or `insertAdjacentHTML`, `outerHTML`) with interpolated values —
  anywhere, including `demo/` and `examples/`. Build DOM with `createElement`/`textContent`, or
  Lit templates.
- MUST NOT put a vendor API key in browser code. The browser only ever holds short-lived tokens
  minted by the voice server.

**Behaviour contracts**
- The state machine's legal transitions (§5.1) are fixed. Do not add edges to make a bug go away.
- Every long-running backend call takes an `AbortSignal` and MUST honour it: an abort ends the
  work and, for `speak`, silences audio. Aborts surface as an error whose `name === 'AbortError'`,
  which the widget maps to `idle`, never to `error`.
- Backends throw `TalkieBackendError(reason, message)` with a `reason` from
  `BACKEND_ERROR_REASONS`; the widget maps unknown errors itself (`TalkieWidget._handleError`).
- `ask()` MUST remain an `AsyncIterable<string>` (never a callback). The widget joins chunks with
  a single space (`this._rp += ' ' + chunk`), so a new backend MUST yield **whole words or phrases
  with no leading or trailing space** — as `MockBackend` (`chunkText`) and `VoiceAgentBackend` do.
  `HttpBackend` currently does not (§16).
- Optional backend capabilities (`speak`, `speechStarted`, `prewarm`, `dispose`) are detected with
  `typeof backend.x === 'function'`. To opt out on an instance, assign `undefined` (see
  `VoiceAgentBackend` constructor: `this.speak = undefined`) — do not just return early.

**Styling**
- Card padding lives on `.view-wrapper`, never on `:host` (an outer `* { padding: 0 }` overrides
  `:host`). A test guards this.
- Visibility keys off `:host(:not([open]))`, never `[open=""]` / `[open="false"]`.
- Theme through `--talkie-*` custom properties (§7.3); never require consumers to pierce shadow DOM.

---

## 3. Environment and commands

Verified on **Node v26.9.0**, macOS, zsh. Run everything from `talkie-sdk/`.

| Command | What it does | Notes |
|---|---|---|
| `npm install` | Install deps | Once. `node_modules/` is gitignored. |
| `npm test` | All thirteen suites, sequentially, fail-fast | ~40 s. `mock-backend.mjs` alone takes ~28 s (real timers) — that is not a hang. Exit code is the verdict. |
| `node tests/<name>.mjs` | One suite | Use while iterating. |
| `npm run build` | `dist/talkie-embed.js` + `.map` via `build.mjs` | IIFE, minified, `globalName: 'Talkie'`, ~119 KiB. |
| `npm start` | Dev server on `:8081` (Hono, `server.mjs`) | `/` → the site (`/site/`); the demo is `/demo/`. Clean URLs: `/site/playground`, and `*.html` 301s to them. Serves only `PUBLIC` paths, no dotfiles; binds `127.0.0.1` (`HOST=0.0.0.0` to open it up). |
| `npm run example` | Build, then serve on `:5173` | Open `/examples/embed`. Second origin on purpose (CORS). |

**`server.mjs` bundles `demo/demo.js` once, at startup.** After editing anything under `src/` or
`demo/`, restart the demo server or you will be testing stale code. `npm run example` rebuilds the
embed bundle on each start for the same reason. Custom port: `PORT=3000 npm start`.

**The voice server is a separate project, not in this repository.** `HttpBackend`,
`VoiceAgentBackend` and `<talkie-assistant>` need it on `:8000`. It is a FastAPI app started with
`.venv/bin/uvicorn server:app --port 8000` from its own checkout. If you do not know where that
checkout is, **ask** — do not guess or scaffold one. What this SDK relies on from it:

| Route | Used by |
|---|---|
| `GET /health` | liveness |
| `GET /agent/token` | `VoiceAgentBackend` — returns `{ token, expires_in_seconds }` (default 300) |
| `GET /agent/context[?profile=]` | demo scenarios 8–9, `<talkie-assistant>`, `fetchAgentContext` — `{ profile, description, system_prompt, keyterms, voice, greeting, tools, prompt_source }`; `greeting` is passed only in conversation mode (README explains); `tools` are used only when the page sets none |
| `GET /agent/profiles` | `listAgentProfiles` (site console and playground) — `{ default, profiles: [{ name, description }] }` |
| `GET /agent/voices` | `listVoices` (site console and playground Voice fields) — `{ default, voices: [{ id, language, accent }] }`; the vendor has no voices endpoint, so the server keeps the documented list |
| `PUT /agent/profiles/{name}[?overwrite=true]` | `saveAgentProfile` (site console) — Bearer `TALKIE_PROFILE_ADMIN_TOKEN`; 403 when unset, 401 wrong token, 409 exists without `overwrite` |
| `POST /chat/session`, `GET /stt/token`, `POST /chat/ask`, `POST /tts`, `POST /chat/session/{id}/end` | `HttpBackend` (README documents shapes) |

Its environment: `ASSEMBLYAI_API_KEY` (required for the agent), `TALKIE_ALLOWED_ORIGINS`
(comma-separated CORS allow-list; unset means only `http://localhost:8081` and
`http://127.0.0.1:8081`) and `TALKIE_PROFILE_ADMIN_TOKEN` (optional; unset keeps
`PUT /agent/profiles` disabled). It calls `load_dotenv(override=True)`: a key present in its `.env` beats
the same variable in the shell. So when `TALKIE_ALLOWED_ORIGINS` is not set in that `.env`, pass it
at launch to allow the example page (if it *is* set there, the `.env` value wins — ask before
editing that file):
`TALKIE_ALLOWED_ORIGINS="http://localhost:8081,http://localhost:5173" .venv/bin/uvicorn server:app --port 8000`.
Never print, log, commit or copy the contents of its `.env`.

---

## 4. Repository map

```
talkie-sdk/
  AGENTS.md                 this guide
  SPEC.md                   original build spec (see §14 for superseded parts)
  README.md                 consumer docs
  docs/integration.md       framework snippets, embed attributes, CORS/CSP/HTTPS
  docs/production-checklist.md  launch checklist
  build-site.mjs            esbuild → site/dist/ (one bundle per page; clears the folder first)
  site/                     web UI: index, playground, console, docs pages; sources in site/src/
  package.json              scripts, exports map
  build.mjs                 esbuild → dist/talkie-embed.js (IIFE)
  server.mjs                dev server (Hono): clean URLs, PUBLIC allow-list, no dotfiles; bundles the demo at startup
  demo/index.html, demo.js  review harness: state rail, event log, 9 scenarios (9 = conversation)
  examples/embed.html       a "foreign" host page using only the embed bundle
  src/
    index.js                side-effect-free re-exports (the "." export)
    embed.js                embed entry: registers all elements, exposes window.Talkie
    core/state-machine.js   StateMachine, VALID_STATES, ERROR_REASONS, TRANSITIONS
    core/backend.js         TalkieBackendError, BACKEND_ERROR_REASONS, contract JSDoc
    core/agent-profiles.js  listAgentProfiles, listVoices, fetchAgentContext, saveAgentProfile, AgentProfileError
    core/state-colors.js    STATE_COLORS: one colour per state, shared by the widget and launcher
    backends/mock-backend.js        MockBackend, SCRIPT, chunkText
    backends/http-backend.js        HttpBackend
    backends/voice-agent-backend.js VoiceAgentBackend (+ private ReplyTurn class)
    audio/mic-capture.js    MicCapture: AudioContext + worklet + getUserMedia
    audio/pcm-worklet.js    worklet source, loaded from a blob: URL
    audio/pcm-codec.js      base64, silence frames, WAV container
    audio/pcm-player.js     PcmStreamPlayer: gapless streaming playback
    components/talkie-widget.js     the card; owns the state machine
    components/talkie-launcher.js   floating button; emits talkie-launch
    components/talkie-waveform.js   canvas visualiser (static when reduced motion)
    components/talkie-transcript.js shows what the user said
    components/talkie-assistant.js  <talkie-assistant>: attribute-configured embed
    define/*.js             the ONLY place customElements.define is called
  tests/*.mjs               plain-node suites (§8)
  dist/                     build output — untracked, not committed
  .tmp/                     gitignored scratch: server logs, probes
```

---

## 5. Architecture

### 5.1 State machine (`src/core/state-machine.js`)

Plain class, no DOM. Legal transitions — anything else throws:

| From | To |
|---|---|
| `idle` | `listening`, `error` |
| `listening` | `transcribing`, `idle`, `error` |
| `transcribing` | `thinking`, `listening`, `idle`, `error` |
| `thinking` | `speaking`, `listening`, `idle`, `error` |
| `speaking` | `idle`, `listening`, `error` |
| `error` | `idle` |

The three `→ listening` edges were added deliberately for conversation mode (a reply ends, or
the caller talks over it, and the mic is still open). Push-to-talk never takes them.

There is **no `error → error` edge**. A failing turn usually rejects several promises at once;
`TalkieWidget._handleError` returns early when already in `error` so the first cause is kept.
Error reasons: `mic-permission-denied`, `no-speech-detected`, `offline`, `backend-failure`,
`unknown`. Each has title/sub copy in `ERROR_MESSAGES` in `src/components/talkie-widget.js`; adding a reason means
adding it in `src/core/state-machine.js` (`ERROR_REASONS`), `src/core/backend.js` (`BACKEND_ERROR_REASONS`) and `ERROR_MESSAGES`, with a test.

### 5.2 Backend contract (`src/core/backend.js`)

```
startCapture(): Promise<void>                         begin recording; reject on permission denial
stopCapture(): Promise<string>                        end recording; resolve with the transcript
ask(transcript, signal): AsyncIterable<string>        the answer, as words/phrases
speak?(text, signal): Promise<void>                   play the answer; absent = text only
speechStarted?(signal): Promise<void>                 resolves when the caller starts hearing the answer
prewarm?({ mic }): Promise<{...}>                     do slow setup before the press (demo/embed call it)
converse?(options, signal): AsyncIterable<object>    hold a continuous conversation (§5.3a)
interrupt?(): boolean                                 cut off the reply playing in a conversation
dispose?(): void                                      release everything
```

`speechStarted`, `prewarm`, `converse` and `interrupt` are optional capabilities added after the
spec; `MockBackend` has none, `HttpBackend` has `prewarm`, `VoiceAgentBackend` has all four.

### 5.3 A turn through the widget (`TalkieWidget.startListening` / `releaseListening`)

1. Start (button, Space, or `startListening(src)`): `idle → listening`, `backend.startCapture()`.
2. Stop & Send (button, Space, or `releaseListening(src)`): `backend.stopCapture()` → transcript.
3. `→ transcribing`, shows the transcript, dwells `MIN_TRANSCRIBE_DWELL_MS` (**700 ms**) so the
   state is visible.
4. `→ thinking`. Calls `backend.speechStarted(signal)` if present, then iterates `backend.ask()`.
5. `→ speaking` on **whichever comes first**: `speechStarted` resolving, or the first `ask()` chunk.
   Chunks append to the answer as they arrive.
6. After `ask()` ends: `speak(answer, signal)` is called if present (fire-and-forget). If exactly
   one chunk arrived and speech did not start first, `_startSpeakTimer` reveals it at ~400 ms/word;
   if speech started first, the full text is shown at once.
7. The panel shows **Ask another** when the reveal is complete; it stops speaking and immediately
   starts a new recording.

Cancellation: Esc / Discard / close / Stop / Ask another all go through `#cancelConversation` or
`_stopSpeaking`, which abort the per-turn `AbortController`s. Keyboard handling is a document-level
`keydown` listener installed while connected; Space is ignored when it originates in a button,
input or editable element.

### 5.3a Conversation mode (`mode="conversation"`)

`TalkieWidget._conversational` is true when `mode === 'conversation'` **and** the backend has
`converse`; otherwise the widget warns once and runs push-to-talk. `startListening` routes to
`startConversation`, which iterates `backend.converse({ idleTimeoutMs }, signal)` and maps events
in `#onConversationEvent`: `user-speech` → listening (barge-in from speaking/thinking/
transcribing); `user-partial` → `_partial` caption; `user-transcript` → transcribing;
`reply-start` → thinking (via transcribing); `speech-audible` or first `reply-word` → speaking;
`reply-end` → listening, **only** from speaking/thinking (a late `reply-end` after a barge-in must
not pull a new turn back). The iterator returning means the idle limit hit → idle with "Ended
after N seconds of silence". No `MIN_TRANSCRIBE_DWELL_MS` in this mode. Stop calls
`backend.interrupt()`; End / Esc / closing abort the conversation controller in
`#cancelConversation`. Space: idle → start, speaking → Stop.

### 5.4 `VoiceAgentBackend` — the one with real complexity

Read the file's header comment first. Key model:

- **One socket for the session.** `startCapture` mints a token (or reuses the prewarmed one),
  opens `wss://agents.assemblyai.com/v1/ws?token=…`, sends one `session.update`, waits for
  `session.ready`. Later turns reuse the socket. `dispose()` sends `session.end`.
- **Tokens are single-use.** `#fetchToken` caches one for `expires_in_seconds − 30 s`;
  `startCapture` clears the cache the moment it redeems it. `prewarm` never opens the socket.
- **End of turn is the vendor's call.** There is no commit-turn event; `stopCapture` pads
  `END_OF_TURN_PAD_MS` (400) of silence and waits up to `FINAL_TRANSCRIPT_GRACE_MS` (2500) for the
  final `transcript.user` only if none has arrived.
- **Replies arrive before `ask()` is called.** Every reply event is buffered into a `ReplyTurn`.
- **Streaming playback.** `ask()` is the first call carrying the turn's abort signal, so that is
  where `#streamTurn` routes the turn to `PcmStreamPlayer`: buffered frames play at once, later
  frames as they land. Without Web Audio scheduling (`PcmStreamPlayer.isSupported()` false — this
  includes Node) it falls back to one WAV clip in `speak()`, and `speechStarted` is set to
  `undefined`.
- **Word-by-word text.** `transcript.agent.delta` events (undocumented — §13) give one word each
  with `start_ms` measured from the start of the synthesised speech. The reply stream opens with
  ~3.5 s of near-silence, so the adapter finds the speech onset by level (`isSpeech`,
  `SPEECH_RMS_THRESHOLD` = 100) and yields each word when `player.positionMs()` reaches
  `onset + (start_ms − first start_ms)`. `speechStarted` resolves at the onset, not the first frame.
  Fallbacks, all tested: no deltas → final `transcript.agent` text whole; not streaming → words as
  they arrive; clock never advances → words released `WORD_FLUSH_GRACE_MS` (1500) after the
  reply's expected end; deltas short of the final text → the rest filled from it.
- **Cancelled replies are discarded.** The agent keeps sending a reply after the caller stops it.
  `#discarding` drops its remaining events until its `reply.done`; `#discardNext` drops the whole
  next reply when the cancel happened before that reply began. Correctness relies on event order,
  not on `reply_id` (undocumented on `reply.audio`).
- **Timeout is inactivity, not length.** `REPLY_TIMEOUT_MS` (30000) is reset by every audio frame
  (`ReplyTurn.touch`). A long answer that is still streaming never times out.
- **Barge-in is off** (`interrupt_response: false`) for push-to-talk, which closes the mic during
  the reply. The `bargeIn` option turns it on (`buildSessionUpdate`), for conversations.
- **Conversation (`converse`).** `#conv` holds the running conversation: an `EventQueue` the
  iterator drains, the idle timer, `replyTurn` (the reply being played) + `turnAbort`, and
  `waiting` (replies that began while another was still sounding — played in order).
  `#handleEvent` feeds it: `reply-started` → `#playConversationReply` (streams the turn with its
  own abort signal and reuses `#replyWords`, the loop shared with `ask()`); `speech-started` →
  `#onConversationSpeech` (with `bargeIn`: `#cutReply` silences at once, marks the rest for
  discarding, emits `reply-end{interrupted}` then `user-speech`; without: ignored, and
  `#sendConversationAudio` has been sending the mic as zeros during the reply). Idle timer:
  armed at start, after each `reply-end` and on `speech-stopped`; held during replies and
  speech. `converse()`'s `finally` always stops the mic and calls `#endSession`. A socket
  `close` after the handshake, a vendor `session.ended` or an `error` fail the queue.
  `DEFAULT_IDLE_TIMEOUT_MS` (60000) is a product choice, not a measurement.
- **Tool calls span two replies.** Documented interactive sequence: `reply.started` → transition
  audio → `tool.call` → `reply.done` → client sends `tool.result` → the agent fires a follow-up
  reply with the answer. `#runTool` queues results in `#pendingResults`; `#flushResults` sends them
  only while `#lastEvent === 'reply.done'` (sending mid-reply makes the tool fire again, per the
  docs); an `interrupted` `reply.done` drops them. A `tool.call` sets `ReplyTurn.awaitingFollowUp`,
  so that reply's `reply.done` does not finish the turn; the follow-up's `reply.started` calls
  `startSegment()` and the same turn carries on. `ask()` therefore ends on `turn.done`, never on
  `transcript.agent` alone. Each reply is a **segment** with its own `onsetMs` and `firstStartMs`,
  because each has its own lead-in and `start_ms` clock (`#dueWords`). A call for a turn that is
  over or cancelled is not run: it is answered with an error and its follow-up is dropped via
  `#discardNext`.

Constants (top of the file): `DEFAULT_WS_URL`, `PCM_SAMPLE_RATE` 24000, `SESSION_READY_TIMEOUT_MS`
10000, `FINAL_TRANSCRIPT_GRACE_MS` 2500, `REPLY_TIMEOUT_MS` 30000, `END_OF_TURN_PAD_MS` 400,
`SPEECH_RMS_THRESHOLD` 100, `WORD_POLL_MS` 40, `WORD_FLUSH_GRACE_MS` 1500, `PAD_FRAME_MS` 50.
Each has a comment explaining where its value came from — several were **measured against the live
service**. Do not change one without re-measuring (§12) and updating its comment.

Static helpers (pure, test them directly): `buildSessionUpdate`, `readEvent` (vendor frame →
internal event), `reasonForCode`, `joinTurns`, `audioMs`.

Diagnostics: pass `onTiming(mark, { at, ...detail })`; `at` is ms since release. Marks: `release`,
`mic-stopped`, `pad-sent`, `user-transcript`, `reply-started`, `first-audio-frame`, `ask-entered`,
`playback-start` (first frame scheduled — usually silence), `speech-audible`, `first-word`,
`barge-in`,
`agent-text`, `audio-complete`, `playback-done`, and for tool turns `tool-results-sent` and
`follow-up-started`. The demo prints them as `TIME` rows.

### 5.5 Embed layer

- `src/components/talkie-assistant.js` — `<talkie-assistant>`, a plain `HTMLElement` in light DOM.
  It creates `<talkie-launcher>` and `<talkie-widget>` with `document.createElement`, so it depends
  on them being **globally** registered; `src/define/talkie-assistant.js` imports their define files
  first. Attributes: `api` (default `http://localhost:8000`), `token-url`, `profile`,
  `system-prompt`, `voice`, `label`, `heading`, `subtitle`, `fonts="google"`. It fetches `/agent/context` on connect,
  `mode` (default `conversation`), `idle-timeout` (default 60), `barge-in="off"`. It
  builds a fresh `VoiceAgentBackend` on each open (conversation: `greeting` from the context and
  `bargeIn`; push-to-talk: neither) (in the widget's `talkie-open` handler, so any
  route that opens the widget gets one), prewarms with `mic: false`, and disposes on close, removal
  and `pagehide`. Properties `tools` and `onToolCall` (functions cannot be attributes) are read
  on each open; values a page sets before the element is defined are re-applied in
  `connectedCallback`. With `tools` unset, the context's `tools` are sent instead
  (`#sessionTools`), with a `console.warn` when there is no `onToolCall` to run them. `_createBackend(options)` is a test seam, not public API.
- `src/embed.js` → `build.mjs` → `dist/talkie-embed.js`. Exposes `window.Talkie` with
  `TalkieAssistant`, `TalkieWidget`, `TalkieLauncher`, `VoiceAgentBackend`, `HttpBackend`,
  `MockBackend`, `TalkieBackendError`.
- The mic worklet is inlined as a `blob:` URL, so host pages with a CSP must allow `blob:`.

---

## 6. Workflow for any change

1. **Locate.** Read the files you will touch in full, plus their tests. Read the JSDoc — it records
   decisions and measurements you must not undo by accident.
2. **Decide scope.** Implement what was asked. If you find an adjacent bug, fix it only when it
   blocks the task or would make your change wrong; otherwise note it in your report.
3. **Write the test first when feasible**, in the existing suite for that module (§8.2). A bug fix
   gets a test that fails without the fix — **prove it**: disable the fix, run the suite, see the
   FAIL, restore.
4. **Implement** in the style of the surrounding code: private `#fields`, JSDoc on every public
   member, comments that say *why*, not *what*. Match comment density.
5. **Run the suite you touched**, then `npm test`. Both must exit 0.
6. **Run the invariant checks** (§2): the `customElements.define` grep and an `innerHTML` grep.
7. **Update docs** whose statements your change made false: `README.md`, `docs/integration.md`,
   this file, and JSDoc. Update the test count in `README.md` → *Testing* if it changed.
8. **If `src/` changed and the demo or example is running, restart it** (§3) before handing over.
9. **Report** (§15). Do not claim anything you did not run.

**Definition of done:** tests pass; invariants hold; docs match behaviour; no stray files; the
report lists what was verified and what is left for the human to check in a browser.

---

## 7. Recipes

### 7.1 Add a backend
1. `src/backends/<name>-backend.js` exporting a class that implements §5.2. Throw
   `TalkieBackendError` with a `reason`; honour every `AbortSignal`.
2. Export it from `src/index.js`; add `"./backends/<name>-backend.js"` to `package.json` `exports`;
   add it to `src/embed.js` if embed users need it.
3. `tests/<name>-backend.mjs` using the conventions in §8.2; append `&& node tests/<name>-backend.mjs`
   to the `test` script.
4. Document it in `README.md` (backend table + a section like the existing ones).

### 7.2 Handle a new vendor event in `VoiceAgentBackend`
1. Add a `case` to `static readEvent(msg)` returning a small `{ kind, ... }` object — never pass raw
   vendor frames further in. Undocumented fields: guard with `Number.isFinite` / `?? ''`.
2. Handle the `kind` in `#handleEvent(evt)`. Respect `#discarding` for anything that belongs to a
   reply.
3. Test `readEvent` directly, and the behaviour through a scripted `FakeSocket` turn.

### 7.3 Change the widget's look
Styles are in `static get styles()` of the component. Use the existing tokens:
`--talkie-paper`, `--talkie-surface`, `--talkie-ink`, `--talkie-ink-soft`, `--talkie-state`,
`--talkie-font-display`, `--talkie-font-body`, `--talkie-font-mono`, `--talkie-launcher-bg`,
`--talkie-launcher-offset-right`, `--talkie-launcher-offset-bottom`, `--talkie-sheet-offset-bottom`,
`--talkie-wave-height`,
`--talkie-wave-color`, `--talkie-wave-bar-count`, `--talkie-wave-bar-width`,
`--talkie-wave-container-width`, `--talkie-wave-static-height`. `TalkieWidget` reads each public
token once, into a private `--_*` token on `:host` (`--_ink`, `--_paper`, `--_state`, …); style
with those, and derive tints from the ink (`color-mix`) rather than hard-coding a colour, or a
dark theme breaks. State colours live in `src/core/state-colors.js`. Spacing inside a `lion-button`
must be a margin on the child, not a `gap` on the button (§11). Add a CSS guard to
`tests/components.mjs` if the fix is easy to regress (see the existing `layout guard:` checks).
Visual correctness itself can only be judged in a browser — say so in your report.

### 7.4 Add an attribute to `<talkie-assistant>`
Read it through a getter so edits take effect on the next open; add it to the attribute list in
the file header, the table in `docs/integration.md`, and `tests/talkie-assistant.mjs`. Add it to
`observedAttributes` only if it must react live (today only `label` does).

### 7.5 Add a test suite
Create `tests/<name>.mjs`, end it with the summary line and `process.exit(failed === 0 ? 0 : 1)`,
and append it to the `test` script in `package.json`. The script is an `&&` chain — a suite that
exits non-zero stops the run.

---

## 8. Testing

### 8.1 Suites (verified counts at the time of writing)

| Suite | Assertions | Covers |
|---|---|---|
| `state-machine.mjs` | 41 | legal/illegal transitions, reasons, change events, cancel, reset |
| `mock-backend.mjs` | 42 | scripted answers, abort (~28 s, real timers) |
| `components.mjs` | 78 | registration, styles, layout and theme guards, widget flows, conversation mode |
| `pcm-worklet.mjs` | 15 | downsampling worklet |
| `http-backend.mjs` | 50 | HttpBackend against stubs |
| `pcm-codec.mjs` | 25 | base64, silence, WAV |
| `pcm-player.mjs` | 30 | scheduling, stalls, position, stop/drain |
| `voice-agent-backend.mjs` | 212 | wire format, turns, streaming, words, discard, timeouts, tool turns, conversations |
| `talkie-assistant.mjs` | 73 | embed element wiring, tools properties and server-profile tools, modes |
| `agent-profiles.mjs` | 29 | list profiles and voices / fetch / save profile client against a fake `fetch`: URLs, auth header, error codes |
| `embed-bundle.mjs` | 9 | runs `build.mjs`, boots the bundle as a classic script |
| `server.mjs` | 42 | dev server routes: redirects, clean URLs, MIME types, the allow-list and dotfiles, every site link lands on a page |
| `site.mjs` | 138 | site pure modules (snippet, profile converters, tool editor model incl. enum), the console's tool list and dialog against a fake DOM, page markup and CSS guards, `build-site.mjs` output |

Total **784**. Suites print either `N/N tests passed` or `N passed, M failed`; rely on the exit code.

### 8.2 Conventions
- No framework. Each file defines `check(name, condition, detail)` and counts passes/failures.
  Assertion names are sentences stating the behaviour (`'a stopped reply accepts no more audio'`).
- **DOM**: `@lit-labs/ssr-dom-shim` globals are installed *before* importing any component (copy
  the preamble from `tests/components.mjs`). The shim has **no** `append`, `style` or
  `ownerDocument`; `tests/talkie-assistant.mjs` shows how to fake a document around real elements.
- **Network**: never real. `voice-agent-backend.mjs` has a scripted `FakeSocket` (`accept()`,
  `frame(obj)`, `sentOf(type)`) and helpers `makeBackend(options)`, `connect(backend)`,
  `withBrowser(fn, { streaming })`. `withBrowser` stubs `WebSocket`, `window.AudioContext`,
  `navigator.mediaDevices`, `AudioWorkletNode`, `Audio` and object URLs, and restores them.
- **Audio**: by default the fake `AudioContext` cannot schedule, so backends take the WAV fallback.
  Pass `{ streaming: true }` for a context with `createBuffer`/`createBufferSource`; the test moves
  its `currentTime` by hand and calls `source.onended()` to finish playback.
- **Time**: use `mock` from `node:test` in plain scripts:
  `mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })` and `mock.timers.reset()`
  in `finally`. Mock `Date` too when code reads `Date.now()`, and pass `now:` — the mocked clock
  otherwise starts at 0 and any timestamp recorded earlier makes elapsed time negative. Inside a
  mocked section, flush with `setImmediate`, not `setTimeout`.
- **Noise**: Node has no `AudioContext`, so prewarm logs `[talkie] prewarm step failed` via
  `console.debug`. That is expected. Silence expected logs at the top of a suite, as
  `tests/talkie-assistant.mjs` does, rather than letting them bury failures.
- A suite that stops without printing its summary and exits **13** has an unsettled top-level
  `await` — something is waiting on a timer that never fires (usually a mocked clock).

### 8.3 What tests cannot prove
Real microphone capture, real audio output, autoplay policy, layout and look, and the vendor's
live behaviour. Say which of these your change touches, so the human can check them.

---

## 9. Ports and processes

| Port | Process | Start |
|---|---|---|
| 8000 | voice server (separate project) | §3 |
| 8081 | site + demo (`server.mjs`) | `npm start` |
| 5173 | example host page (`server.mjs`, `PORT=5173`) | `npm run example` |

Find and stop: `lsof -ti :8081 -sTCP:LISTEN` then `kill <pid>`. Before killing a process on 8000,
check with `ps -p <pid> -o args=` that it is the voice server — it may be the human's session.
Write server logs to `.tmp/` (gitignored), never into the repo tree.

---

## 10. When to stop and ask

Ask the human instead of proceeding when the change would:
- add a dependency, or change `package.json` `name`/`version`, or publish anything;
- commit `dist/` (whether to track it is an open decision), push, or open a PR;
- change the voice server, its `.env`, or its CORS/auth policy;
- change a measured constant without re-measuring (§12), or decide product trade-offs such as
  `MIN_TRANSCRIBE_DWELL_MS` (a deliberate UI pause) or default voice/persona;
- spend vendor credits beyond a handful of verification turns;
- require a secret you do not have, or the voice server's location is unknown.

Do **not** ask about things you can determine from the code or by running the tests.

---

## 11. Traps (each one has cost real time here)

1. **`lion-button` ignores `gap`.** It slots children into its own shadow `.button-content` flex box
   (`@lion/ui/components/button/src/LionButton.js`, `render()` and `.button-content`), which has no
   gap; a `gap` on the host spaces only that wrapper. Put `margin-right` on the icon.
2. **`:host` padding is fragile** under an outer `* { padding: 0 }` reset — use `.view-wrapper`.
3. **Class fields shadow Lit reactive accessors.** `_shown = 0` as a field means assigning
   `this._shown` does not schedule a render; code calls `this.requestUpdate()` after changing it.
   Keep doing that, or declare new state only in `static properties`.
4. **Stale demo bundle.** Restart `npm start` after editing `src/` (§3).
5. **zsh `path` is `PATH`.** `for path in …` in a shell script wipes the command search path and
   every command after it fails with `command not found`. Use another variable name.
6. **The fresh-context-at-zero trap.** A new `AudioContext` starts at `currentTime === 0`; logic of
   the form `next < currentTime` is false at exactly 0. `PcmStreamPlayer.push` tests `!#started`
   explicitly for this. Tests of time-based logic should include a clock at 0.
7. **The reply's first frames are silence.** Anything keyed to "audio started" must use the speech
   onset (`speech-audible`), not the first frame (`playback-start`).
8. **Scoped registry polyfill is optional** (§14). Do not add it as a dependency.
9. **Vendor docs vs wire.** The AssemblyAI spec omits events and fields the live service sends
   (§13). Design against what is documented; use undocumented data only with a fallback.
10. **`VoiceAgentBackend.speechStarted` exists on the prototype** but is set to `undefined` on
    instances that cannot stream. Always test with `typeof backend.speechStarted === 'function'`.
11. **The widget's retry path `_onBtnClick` is bound but never attached** — dead code. Do not build
    on it; the Try again button uses `_onRetryClick`.

---

## 12. Verifying against the live agent (no browser)

Use sparingly: each turn mints a real token and uses AssemblyAI credits. Needs the voice server on
`:8000` and Node's global `WebSocket` (present in the verified Node version).

1. Make test speech on macOS: `say -v Samantha -o q.aiff "What is the asking price?"` then
   `afconvert -f WAVE -d LEI16@24000 -c 1 q.aiff q.wav`, and strip the WAV header to raw PCM (take
   the bytes after the `data` chunk's 8-byte header).
2. Either talk to the socket directly — `GET /agent/context` and `/agent/token`, send
   `VoiceAgentBackend.buildSessionUpdate({...})`, stream `input.audio` frames in real time (50 ms),
   then 400 ms of `silenceFrame(24000, 50)` — and log every event; **or** drive the real
   `VoiceAgentBackend` with stubbed browser globals (a fake `AudioContext` whose `currentTime` is
   the wall clock and which records each `createBufferSource().start(at)`), feeding PCM through the
   `AudioWorkletNode` stub's `port.onmessage({ data })`, and pass `onTiming`.
3. Keep probe scripts in `.tmp/`; do not commit them.

Measure what the user hears: time from release to the first *audible* frame, not the first frame.

---

## 13. Vendor facts: documented vs observed

Spec: <https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/voice-agent-websocket>

| Fact | Status |
|---|---|
| `transcript.agent` is sent whole, after all reply audio; has `interrupted` | documented |
| `reply.audio` carries `data` (base64 PCM16, 24 kHz mono) | documented |
| `reply.audio` also carries `reply_id` | observed, undocumented |
| `transcript.agent.delta` — one word per event, `delta`, `start_ms`, `end_ms` (relative to the synthesised speech) | observed, undocumented |
| All of a reply's deltas arrive in one burst, ~3.5–5 s after the first audio frame, just before the voice | observed |
| Each reply opens with ~3.5 s of near-silence (peak sample \|2\|); speech RMS is in the hundreds | observed |
| The first audible frame arrives ~4.5–4.9 s after the caller stops talking; through the widget it is heard at ~5.5 s, because playback starts when `ask()` is called and so trails arrival by ~0.6–0.8 s | observed |
| Audio streams at real-time pace (10 ms frames) | observed |
| End-of-turn timing did not change between `min_silence` 200 and 2000 | observed (see `END_OF_TURN_PAD_MS`) |
| No client event to commit a turn; turn detection cannot be disabled | documented by omission |
| Conversation mode: greeting spoken on `session.ready`, vendor turn detection drives turns | documented; greeting heard live 2026-09-21 (human-reported). Barge-in and echo on loudspeakers not yet confirmed |
| Tool turn: transition reply, `tool.call` before its `reply.done`, `tool.result` (`call_id`, JSON-string `result`) only while `reply.done` is the latest event, then an auto-fired follow-up reply; `reply.done` has `status` `completed`/`interrupted` | documented ([client-side tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools)); works end to end live — page navigation from a conversation, 2026-09-21, reported by the human (event order itself not logged) |

"Observed" rows can change without notice. Code relying on them must degrade gracefully, and tests
must cover the degraded path.

---

## 14. SPEC.md rules that were deliberately superseded

| SPEC.md says | Now | Why |
|---|---|---|
| Expose a `mode` property (`hold`/`toggle`/`auto`); support hold-to-talk | `mode` is `push-to-talk` (start/stop, no hold) or `conversation` (hands-free, backend `converse()`) | Hold-to-talk caps utterance length and has no accessible keyboard equivalent; conversation added on request (README → *Interaction model*) |
| State machine transitions are fixed | Three `→ listening` edges added (§5.1) | Conversation mode keeps the mic open between turns |
| Ship one backend; do not write a vendor adapter | `HttpBackend` and `VoiceAgentBackend` ship | Added on purpose in later commits |
| README must say consumers need the scoped-registry polyfill | Polyfill is optional | `@open-wc/scoped-elements` v2 falls back to the global registry (`ScopedElementsMixin.js`); only a conflicting pre-registered `lion-button` needs it |
| No build/publish pipeline beyond the demo | `build.mjs` produces the embed bundle | Needed for plain-HTML embedding; npm publishing is still out of scope |
| Components extend `LionButton` for controls | Controls are `lion-button` elements via `ScopedElementsMixin` | Same Lion base, composition instead of subclassing |
| Every composing component uses `ScopedElementsMixin` | `<talkie-assistant>` does not | It has no template; it creates elements in light DOM and relies on global registration |

Everything else in SPEC.md still applies, including its acceptance checks.

---

## 15. Git and handing over

- Branch: work on the current feature branch (at the time of writing `add-talki-sdk`; `main` is the
  default). Never commit directly to `main`. Never push or open a PR unless asked.
- **Stage explicitly**, file by file. The repo root has unrelated untracked and deleted files that
  are not yours; never `git add -A` or `git add .`.
- Never commit `dist/`, `.tmp/`, `node_modules/`, probe scripts, logs, or anything from the voice
  server.
- Commit message style (see `git log`): a short imperative subject, usually prefixed
  `Talkie SDK:`; a body explaining the problem, the cause and the fix, with measurements where you
  have them; end with `npm test: <N> assertions across <M> suites.` Follow any attribution rules
  your harness gives you.
- **The human does browser, microphone and audio QA.** Implement, run `npm test`, restart any
  running demo/example server, and hand over. Do not start browser automation unless asked.

Report format — keep it short and factual:
1. What changed and why (files).
2. What you verified, with results (`npm test` exit code and total; any live measurement).
3. What only a human can verify (look, real mic/audio, a specific browser).
4. Anything you found but did not fix, and any decision you need from the human.

---

## 16. Open decisions (do not settle these unilaterally)

- Whether to commit `dist/talkie-embed.js`.
- Access control on the voice server's `/agent/token` (CORS does not stop scripts).
- Whether to shorten or remove `MIN_TRANSCRIBE_DWELL_MS` (~0.7 s of the wait before speech).
- npm publishing (name, version, `files`).
- **`HttpBackend` chunk spacing.** It yields the voice server's raw LLM token deltas
  (`payload.delta`, which the server takes from the model stream unchanged), while the widget joins
  chunks with a space. A token that is part of a word is then likely to render split ("Wander
  Safe"). Found by reading the code, not yet reproduced live. The fix belongs in `HttpBackend`
  (re-chunk into whole words before yielding); confirm with the human before changing it.
- Known product gaps in README → *Known gaps*: conversation history, text-input fallback.
- Conversation mode's echo behaviour on loudspeakers (barge-in on) is unverified live; if the
  agent interrupts itself, the choice between `barge-in="off"` as default or other mitigation is
  the human's.
