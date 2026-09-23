# Talkie Voice UI SDK

A framework-agnostic voice assistant interface built on Lit and Lion web components. Provides a
floating launcher button and a full-state widget (idle → listening → transcribing → thinking →
speaking → error) with CSS custom-property theming, a pluggable backend contract, and zero side
effects on import — safe to use alongside other versions of the same library.

## Run

```bash
cd talkie-sdk
npm install        # once
npm start          # -> http://localhost:8081
```

Opens the demo harness: state rail, live event log, clock, and all six states driven by the real
components wired to `MockBackend`.

## Embed on any page

```bash
npm run build      # -> dist/talkie-embed.js, one file, no dependencies to install
```

```html
<script src="/path/to/talkie-embed.js" defer></script>
<talkie-assistant api="http://localhost:8000"></talkie-assistant>
```

That is the whole integration: a launcher and widget, wired to the voice server named by `api`.
It holds a hands-free **conversation** by default (see [Interaction model](#interaction-model));
`mode="push-to-talk"` gives Start / Stop & Send instead.
The voice server must list the page's origin in `TALKIE_ALLOWED_ORIGINS`. `npm run example`
serves a sample host page on `:5173`. Attributes, CORS, CSP and HTTPS notes are in
[docs/integration.md](docs/integration.md#drop-in-embed-any-web-page-no-build-step).

### Tools: let the agent act on the page

The agent can call functions the page runs: show a room, scroll to a section, fill a form.
The page needs one thing, an `onToolCall` handler. The tool *definitions* (names,
descriptions, parameter schemas) can come from the voice server's profile, so leave `tools`
unset:

```html
<script src="/path/to/talkie-embed.js" defer></script>
<talkie-assistant api="http://localhost:8000" profile="property"></talkie-assistant>

<script>
  const el = document.querySelector('talkie-assistant');

  // el.tools is unset: the profile's `tools` (from /agent/context) are used.
  el.onToolCall = async ({ name, arguments: args }) => {
    switch (name) {
      case 'show_room':
        await window.tour.goTo(args.room);            // do the thing on the page
        return { ok: true, now_showing: args.room };  // becomes the tool result
      case 'go_to_section':
        document.getElementById(args.section)?.scrollIntoView({ behavior: 'smooth' });
        return { ok: true };
      default:
        return { error: `Unknown tool '${name}'.` };   // the model reads this text
    }
  };
</script>
```

- A call arrives as `{ name, arguments, call_id }`, with `arguments` already parsed. The awaited
  return value goes back to the agent as the tool result, so describe what is now on screen.
- Throw, or return `{ error: '…' }`, to report a failure. The model reads it verbatim: say
  what went wrong and what to ask next.
- The handler may be set before the embed script loads, and is looked up on every call.
- Every tool the profile lists needs a case here. With server tools and no handler, each call
  fails back to the agent and the element logs a `[talkie]` warning naming the tools.
- To keep the definitions in the page instead, set `el.tools = [{ type: 'function', … }]`
  before the conversation opens. Tools the page sets always win over the server's. See
  [docs/integration.md](docs/integration.md#drop-in-embed-any-web-page-no-build-step) for the
  full schema, and `virtual-tour/talkie-tools.js` for a worked handler.

## Web UI

```bash
npm run site       # -> http://localhost:8081/site/
```

Four pages, built with Lion components, for showing and setting up the assistant:

| Page | For |
|---|---|
| Overview | What Talkie does, with a live assistant to try |
| Playground | Every attribute and theme token in a form, the preview updating as you go, and the embed snippet to copy |
| Persona console | Browse and open the voice server's personas, write and test profiles, and send them back (or export the file for its `agents/` folder) |
| Docs | This README, the integration guide and the production checklist, rendered from these files |

Each page runs on `MockBackend` (scripted answers, no mic) until **Live voice server** is
switched on in the header, and then talks to the server at the URL given there. Console
profiles are kept in the browser's `localStorage`; they reach the voice server only through
**Send to server…** (which needs its `TALKIE_PROFILE_ADMIN_TOKEN`), and a copy opened from the
server is not refreshed by itself — the console flags one that differs. A profile's tools are listed by
name and description; Edit opens a dialog for one tool and its parameters (type, required,
allowed values), and a JSON view edits the raw array. Both write the same JSON. Sources are in
`site/src/`; `npm run build:site` bundles them into `site/dist/`.

## Install & use

### Side-effect-free import (advanced / controlled registration)

```js
import { TalkieWidget } from '@talkie/voice-ui';
// Register yourself:
import { ScopedElementsMixin } from '@open-wc/scoped-elements';
import { LitElement } from 'lit';

const MyWidget = ScopedElementsMixin(LitElement);
customElements.define('my-widget', class extends MyWidget { /* ... */ });
```

This approach exports **classes only** — no call to `customElements.define` happens on import. It
is what lets a host app run our components alongside another version of the same package without
namespace collisions.

### Opt-in registration (the common path)

```html
<script type="module">
  import '@talkie/voice-ui/define/talkie-widget.js';            // registers <talkie-widget>
</script>
```

That single line makes `<talkie-widget>` available in your markup. You still set the `backend`
property imperatively or via framework bindings to wire up your ASR / LLM / TTS stack.

### The scoped-elements polyfill is optional

The components render `<lion-button>` and `<lion-icon>` through `ScopedElementsMixin` from
`@open-wc/scoped-elements` v2. When the browser has no scoped custom-element registries, the mixin
falls back to the global registry, which works on its own; the demo never loads the polyfill. The
one case it cannot handle is a page that has **already registered a different `lion-button`**
class — it then logs an error. Only then, load `@webcomponents/scoped-custom-element-registry`
before anything else on the page. It is not a dependency of this package.

## Backend interface

The widget never talks directly to a speech or language vendor. It speaks one contract:

```ts
/** @typedef {Object} TalkieBackend */
/** @property {() => Promise<void>}   startCapture  – begin mic capture; reject on permission denial */
/** @property {() => Promise<string>}  stopCapture   – end capture, resolve with transcript */
/** @property {(text: string, signal: AbortSignal) => AsyncIterable<string>} ask
 *   - send transcript; yield response tokens incrementally (word or sub-word chunks)
 *   - returning an AsyncIterable is what makes streaming work without the UI knowing whether the
 *     transport is SSE, WebSocket, or a single blocking call
 *   - every long-running call receives an AbortSignal so Esc / Stop actually cancel in-flight work
 */
/** @property {(text: string, signal: AbortSignal) => Promise<void>} [speak]
 *   - optional TTS synthesis; absent → text-only display
 *   - when present, the widget calls it during the speaking phase
 */
/** @property {(options: { idleTimeoutMs?: number }, signal: AbortSignal) => AsyncIterable<object>} [converse]
 *   - optional: hold a continuous conversation (widget `mode="conversation"`); yields
 *     user-speech / user-partial / user-transcript / reply-start / speech-audible /
 *     reply-word / reply-end / idle-timeout events. Only VoiceAgentBackend has it.
 */
/** @property {() => boolean} [interrupt] – optional: cut off the reply playing in a conversation */
/** @property {() => void} [dispose] */
```

The SDK ships three backends:

| Backend | Use |
|---|---|
| `MockBackend` | Replays four scripted Q&A pairs with simulated timing (950 ms transcribe + 1500 ms think). Zero network, zero permissions — the default for the demo harness and tests. |
| `HttpBackend` | Talks to a running Talkie voice server: real microphone capture, streaming speech recognition, a streaming LLM answer and synthesised speech. |
| `VoiceAgentBackend` | Talks to the [AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api): one WebSocket that does recognition, the model turn and speech synthesis. Your server only mints a token. |

### `HttpBackend` — the real thing

```js
import { HttpBackend } from '@talkie/voice-ui/backends/http-backend.js';

const widget = document.querySelector('talkie-widget');
widget.backend = new HttpBackend({
  baseUrl: 'http://localhost:8000',      // your voice server origin
  caller: { name: 'Juan', email: 'juan@example.com' },  // optional, passed to the agent
  productFocus: 'WanderSafe',            // optional
  prompts: null,                         // optional per-session persona override
  speakEnabled: true,                    // false renders text only
});
```

**How each contract method is carried:**

| Method | Transport |
|---|---|
| `startCapture()` | Creates a server session, fetches a short-lived token from `GET /stt/token`, opens the vendor WebSocket, and streams 16 kHz mono PCM from an `AudioWorklet`. |
| `stopCapture()` | Stops the mic, sends `Terminate`, waits briefly for the closing turn, and returns the joined transcript. |
| `ask(text, signal)` | `POST /chat/ask` as SSE; yields each `{"delta": "..."}` as it arrives. The `AbortSignal` is passed to `fetch`, so pressing Esc cancels the model call server-side, not just in the UI. |
| `speak(text, signal)` | `POST /tts`, plays the returned audio. The widget only calls this once the full answer has streamed. |
| `dispose()` | Stops the mic, closes the socket, and ends the server session so the post-call webhook fires. |

Audio goes **straight from the browser to the speech vendor**, not through your server — the
transcript is ready the instant the user presses Stop. Your server only mints the token,
so the vendor API key never reaches the browser.

**Errors** arrive as `TalkieBackendError` with a `reason` the widget maps directly onto its error
state: `mic-permission-denied` (blocked or no input device), `no-speech-detected` (nothing
recognised), `offline` (network or socket failure), `backend-failure` (anything else).

### Server endpoints it expects

Implement these to point `HttpBackend` at your own stack:

| Method | Path | Returns |
|---|---|---|
| `POST` | `/chat/session` | `{ session_id, opening_greeting, model }` |
| `GET` | `/stt/token` | `{ ws_url, expires_in_seconds, sample_rate, encoding }` |
| `POST` | `/chat/ask` | `text/event-stream` of `data: {"delta": "..."}`, ending `data: [DONE]` |
| `POST` | `/tts` | audio bytes (`audio/mpeg`) |
| `POST` | `/chat/session/{id}/end` | post-call summary |

### `VoiceAgentBackend` — one socket for the whole turn

Where `HttpBackend` coordinates three vendors behind your own server, this speaks to
[AssemblyAI's Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api):
a single duplex WebSocket that transcribes, runs the model turn and synthesises the reply.

```js
import { VoiceAgentBackend } from '@talkie/voice-ui/backends/voice-agent-backend.js';

widget.backend = new VoiceAgentBackend({
  tokenUrl: 'https://your-server/agent/token',   // mints the short-lived token
  systemPrompt: 'You are Talkie, a concise product assistant.',
  voice: 'anna',
  keyterms: ['WanderSafe'],                      // bias recognition toward rare words
  tools: [{ type: 'function', name: 'get_price', description: '…', parameters: {…} }],
  onToolCall: async ({ name, arguments: args }) => runTool(name, args),
});
```

**Tools.** `onToolCall` runs each `tool.call`; its awaited value is JSON-encoded and sent back
as the `tool.result` (throw to report an error the agent can read). A turn that calls a tool
gets two vendor replies: a short transition phrase, then the answer, which the agent fires once
it has the result. The backend follows the
[documented sequence](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools):
results are held until `reply.done` is the latest event (sent mid-reply, the tool fires again)
and dropped on an interrupted `reply.done`. The widget sees one turn: `ask()` yields the
transition phrase and the answer, and playback runs across both. A call that arrives for a turn
already finished or cancelled is not run; it is answered with an error so the agent is not left
waiting, and the reply that answer triggers is dropped rather than shown as the reply to the
next question. On `<talkie-assistant>`, set the `tools` and `onToolCall` properties, or
leave `tools` unset to use the server profile's
([integration guide](docs/integration.md#drop-in-embed-any-web-page-no-build-step)).

Pass `agentId: '<id>'` instead of the inline fields to use an agent you created with the
Agents REST API. The two are mutually exclusive and combining them throws immediately,
rather than failing the session on the wire.

**Keeping the persona off the page.** `systemPrompt` is just a string, so where it comes
from is your choice — but hard-coding it in the bundle means a rebuild per edit, and
anything in the page can be tampered with. The demo instead fetches it from the voice
server:

```js
const ctx = await fetch(`${origin}/agent/context?profile=it-support`).then(r => r.json());
widget.backend = new VoiceAgentBackend({
  tokenUrl: `${origin}/agent/token`,
  systemPrompt: ctx.system_prompt,
  keyterms: ctx.keyterms,
  voice: ctx.voice,
});
```

Each profile is a JSON file on the server — persona, knowledge, boundaries, style — and is
re-read when it changes, so editing one takes effect on the next page load. The schema is
domain-neutral; see *Configuring the voice agent* in the voice server's README.

**How each contract method is carried:**

| Method | Transport |
|---|---|
| `startCapture()` | Fetches a token, opens `wss://agents.assemblyai.com/v1/ws?token=…`, sends one `session.update`, waits for `session.ready`, then streams 24 kHz mono PCM as base64 `input.audio` frames. Later turns reuse the open socket. |
| `stopCapture()` | Stops the mic, pads the stream with PCM silence until the agent closes the turn, and returns the joined `transcript.user` text. |
| `ask(text, signal)` | Sends nothing — the agent started replying when it closed the turn. Starts playing the reply audio as it streams in, and yields the answer one word at a time as the voice reaches each word. Falls back to the whole `transcript.agent` text if no word events arrive. |
| `speechStarted(signal)` | Optional capability the widget uses: resolves when the voice itself starts playing, so the widget moves to *speaking* then rather than on the silent lead-in. |
| `speak(text, signal)` | Waits for the streamed audio to finish playing. Without Web Audio scheduling, wraps the buffered `reply.audio` PCM in a WAV and plays it instead. No second synthesis request either way. |
| `converse(options, signal)` | Conversation mode. Opens the socket (with `greeting` and, if `bargeIn`, `interrupt_response: true`), keeps the mic streaming, and reports the vendor's turns as events: `input.speech.started` → `user-speech`, `transcript.user.delta` → `user-partial`, `transcript.user` → `user-transcript`, each reply as `reply-start`, `speech-audible`, `reply-word`… and `reply-end` once it has played. Ends on abort, on a dropped session, or after `idleTimeoutMs` (default 60 s) without speech, and always ends the vendor session. |
| `interrupt()` | Conversation mode's Stop: silences the current reply and drops the rest of it. |
| `dispose()` | Sends `session.end` and closes the socket, so the vendor does not hold the session for its 30 s resume window. |

The socket stays open across turns — the reply arrives on it, and the conversation's context
lives in the session. That is the opposite of `HttpBackend`, which closes its speech socket per
turn precisely to avoid idle time.

**The token route.** The vendor API key must never reach the browser, so `tokenUrl` points at a
route of yours that proxies
[`GET https://agents.assemblyai.com/v1/token`](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/generate-voice-agent-token)
and returns its `{ token, expires_in_seconds }` verbatim. Tokens are **single-use** and last at
most 600 seconds, so mint a fresh one per connection:

```js
// Express, for illustration. Keep ASSEMBLYAI_API_KEY server-side.
app.get('/agent/token', async (_req, res) => {
  const upstream = await fetch('https://agents.assemblyai.com/v1/token?expires_in_seconds=300', {
    headers: { Authorization: `Bearer ${process.env.ASSEMBLYAI_API_KEY}` },
  });
  res.status(upstream.status).json(await upstream.json());
});
```

Pass `fetchToken: async () => ({ token, expires_in_seconds })` instead if the credential comes
from somewhere other than a GET, and `tokenUrl` is ignored. With neither option the default is
`${baseUrl}/agent/token`.

**Why the silence padding.** The agent decides end-of-turn itself, and its client event list has
no "commit turn" event. Releasing the button stops audio altogether, which is not the same as
silence, so `stopCapture()` keeps the socket open and feeds it 400 ms of explicit zeroes. That is
what closes the turn when someone releases the button *mid-sentence*; override it with
`endOfTurnPadMs`.

**The agent will usually answer before you release.** Measured against the live service: the same
utterance was replayed at `min_silence: 2000` and at `min_silence: 200`, and the turn closed
2301 ms after speech began in both runs — roughly 210 ms after the speech itself ended, identically.
The documented silence thresholds did not move end-of-turn timing at all, so this adapter leaves
them at the service's defaults rather than pretending to control them. `turnDetection` is still
passed straight through if you want to experiment.

The practical consequence is that **the button is a backstop, not the trigger**: stop speaking and
the agent begins its reply on its own, typically before the press lands. One press can also produce
more than one turn if the caller pauses long enough to look finished. The widget handles this
correctly — the reply is buffered whenever it arrives — but if you need the press to be the sole
turn boundary, this API cannot currently give you that: there is no way to disable turn detection
and no client event to commit a turn.

**Behaviour worth knowing before you ship it:**

- Every reply opens with ~3.5 s of near-silence while the agent works out its answer; speech
  starts about 5.5 s after the caller stops talking, measured. That wait is the service's.
- Word text comes from `transcript.agent.delta` events, which the live service sends but the
  published spec does not document. All of a reply's words arrive in one burst just before the
  voice; the adapter reveals each as playback reaches it. If the event ever disappears, the
  complete `transcript.agent` (sent after all reply audio) is shown instead.
- Barge-in is off by default (`interrupt_response: false`): push-to-talk closes the mic during
  the reply, so nothing can interrupt it. `bargeIn: true` turns it on for `converse()`; the reply
  is silenced locally the moment `input.speech.started` arrives, without waiting for the vendor's
  interrupted `reply.done`. It relies on the browser's echo cancellation (`MicCapture` asks for
  it); on loudspeakers the agent may hear itself. With `bargeIn` off, `converse()` sends the mic
  as silence while a reply plays.
- Turn detection cannot be disabled and there is no commit-turn event, so the agent's own
  end-of-turn decision always wins over the button. See the measurement above.
- `greeting` is spoken on `session.ready`, which in a push-to-talk widget lands while the caller is
  already being listened to. It is omitted by default for that reason; in a conversation it is
  the natural opening, and `<talkie-assistant>` passes the server persona's greeting.
- `session.resume` is not used. A reconnect needs a fresh single-use token anyway, and the vendor's
  window is only 30 seconds.
- Errors arrive as `TalkieBackendError`, same as `HttpBackend`: an unreachable socket or a transient
  `server_error` maps to `offline`, auth and config failures to `backend-failure`.

### Trying it live

```bash
# terminal 1 — the voice server (a separate project, not in this repository)
cd <voice-server-checkout> && .venv/bin/uvicorn server:app --port 8000

# terminal 2 — the SDK demo
npm start
```

Then open `http://localhost:8081/demo/` and pick **Live backend** on the rail, or
`?api=https://your-server` to point somewhere else. That scenario is the only one that touches the
microphone, so the browser will ask for permission.

See [`docs/integration.md`](docs/integration.md) for Angular, Vue, React, and plain HTML snippets.

## Theming

All visual appearance flows through CSS custom properties set on the host. Restyle without piercing
shadow DOM:

```css
:root {
  /* Background and text palette */
  --talkie-paper: #f7f5ec;      /* card background      */
  --talkie-ink:   #101d20;      /* primary text color   */
  --talkie-ink-soft: #4a5a58;   /* secondary / hint text */

  /* Fonts */
  --talkie-font-display: 'Space Grotesk', sans-serif;
  --talkie-font-body: 'Instrument Sans', sans-serif;
  --talkie-font-mono: 'IBM Plex Mono', monospace;

  /* State accent (glow, status dot, spinner, Start button shadow). Leave it unset to keep a
     colour per state (src/core/state-colors.js); set here, one colour serves every state.
     Per state: talkie-widget[state="listening"] { --talkie-state: #ff8a4c; } */
  --talkie-state: #5fd9c6;

  /* Launcher floating button gradient */
  --talkie-launcher-bg: linear-gradient(145deg, #6ee7d4, #1c7f70);
  --talkie-launcher-offset-right: 28px;
  --talkie-launcher-offset-bottom: 28px;

  /* <talkie-assistant> bottom sheet (phones): distance from the bottom edge */
  --talkie-sheet-offset-bottom: 0px;

  /* Waveform height */
  --talkie-wave-height: 72px;
}

/* Example rebrand to a dark purple theme */
[data-theme="purple"] {
  --talkie-paper:    #1a1025;
  --talkie-ink:      #f3e8ff;
  --talkie-ink-soft: #b59ad4;
  --talkie-state:    #c084fc;
  --talkie-launcher-bg: linear-gradient(145deg, #9333ea, #4c1d95);
  --talkie-font-display: 'Inter', sans-serif;
}
```

Each component also accepts per-instance overrides via attributes (e.g. `color` on
`<talkie-waveform>`).

**Dark mode.** With paper and ink left unset, the panel follows the page's `color-scheme`: a page
that declares `color-scheme: dark` (or `light dark` on a dark system) gets a dark panel
(`#16191b` paper, `#eceeef` ink); a page that declares nothing keeps the light one. Setting any of
the tokens above wins over this in both schemes.

## Events

Every component dispatches `CustomEvent`s that bubble and compose, making them listenable at any
ancestor level (including `document`). Prefix is always `talkie-`:

| Event               | Detail                         | When emitted                       |
|---------------------|--------------------------------|------------------------------------|
| `talkie-state-change` | `{ from, to }`               | Every legal FSM transition         |
| `talkie-transcript`   | `{ text }`                   | User utterance captured            |
| `talkie-response`     | `{ text }`                   | Assistant answer complete          |
| `talkie-error`        | `{ reason, error }`          | Backend rejects / unhandled error  |
| `talkie-open`         | —                            | Widget opens (`show()` called)     |
| `talkie-close`        | `{ reason }`                 | Widget closes (`hide()` called)    |
| `talkie-minimize`     | —                            | Panel hidden, conversation kept (`minimize()`) |
| `talkie-restore`      | —                            | Minimized panel back (`restore()`, or `show()`) |

Example listener:

```js
widget.addEventListener('talkie-state-change', ev => {
  console.log(`State: ${ev.detail.from} → ${ev.detail.to}`);
});
```

## Interaction model

Two modes, set by the widget's `mode` property (`<talkie-assistant mode="…">`):

**Conversation** (`mode="conversation"`, the default for `<talkie-assistant>`; needs a backend
with `converse()`, otherwise the widget falls back to push-to-talk). Press **Start
conversation** once. The agent greets you, then you just talk: it decides when you have
finished, answers, and listens again. Talk over an answer to interrupt it. **Stop** (or
<kbd>Space</kbd>) cuts the answer short and keeps listening; **End conversation** (or
<kbd>Esc</kbd>) ends it. After `idleTimeout` seconds (default 60) with nobody speaking it ends
itself, since an open conversation streams the microphone the whole time.

**Push-to-talk** (`mode="push-to-talk"`, the widget's default).
Recording is **start / stop**, not press-and-hold: press **Start Recording**, speak for as long as
you need, then press **Stop & Send**. A press-and-hold gesture caps an utterance at how long
someone is willing to keep a finger down, is awkward on touch, and has no accessible equivalent —
holding a key is not something every input device can do.

| Input | Start | Stop and send | Discard |
|---|---|---|---|
| Pointer / touch | Start Recording | Stop & Send | Discard |
| Keyboard | <kbd>Space</kbd>, or <kbd>Enter</kbd>/<kbd>Space</kbd> on the focused button | <kbd>Space</kbd>, or the button | <kbd>Esc</kbd> |

While an answer is playing, <kbd>Space</kbd>, <kbd>Esc</kbd>, **Stop** and **Ask another** all cut
the audio short — every exit from the speaking state aborts the `speak()` signal, so the backend
stops playback rather than talking over the next question.

While recording, the widget shows a live `mm:ss` clock so a long answer never looks stalled.
Discarding (or <kbd>Esc</kbd>) closes the microphone and the speech socket without sending the
transcript.

## Public API

| Property / Method | Type                | Description                              |
|-------------------|---------------------|------------------------------------------|
| `backend`         | `TalkieBackend`     | Set before showing the widget.           |
| `open`            | `boolean` (reflect) | Current open/closed state.               |
| `state`           | `string` (reflect)  | Current FSM state — read-only.           |
| `show()`          | `void`              | Open widget; resets any in-flight state. |
| `hide(reason?)`   | `void`              | Close widget; optionally provide a reason.|
| `reset()`         | `void`              | Cancel conversation, clear data, idle.   |
| `startListening(src)` | `void`          | Start recording, as the Start button does. No-op unless `idle`. `src` is a free-form label for logs. |
| `releaseListening(src)` | `void`        | Stop recording and send, as Stop & Send does. No-op unless `listening`. |
| `mode`            | `string` (reflect)  | `'push-to-talk'` (default) or `'conversation'`. |
| `idleTimeout`     | `number`            | Conversation mode: seconds of silence before it ends; `0` = never. Attribute `idle-timeout`. |
| `heading`         | `string` (reflect)  | Eyebrow at the top of the panel. Default `'Product Expert'`. |
| `subtitle`        | `string` (reflect)  | Start screen line; conversation mode prefixes `Just talk.` Default `'Ask about features, pricing, integrations, or compatibility.'` |
| `startConversation(src)` | `void`       | Start a conversation (what Start does in conversation mode). No-op unless `idle`. |
| `endConversation()` | `void`            | End the running conversation and return to idle. |

### Profiles on the voice server

List the server's personas and read one — both open routes, the same data
`<talkie-assistant profile="…">` loads:

```js
import { listAgentProfiles, fetchAgentContext } from '@talkie/voice-ui/core/agent-profiles.js';

const { default: def, profiles } = await listAgentProfiles({ api: 'http://localhost:8000' });
// profiles: [{ name: 'property', description: '…' }, …]; def: the profile served when none is named

const ctx = await fetchAgentContext({ api: 'http://localhost:8000', profile: 'it-support' });
// { profile, system_prompt, greeting, keyterms, voice, description, tools, prompt_source }
```

`prompt_source` is `composed` when the server builds the prompt from the profile's sections,
`override` when the profile sets a fixed `system_prompt_override`.

`listVoices({ api })` reads `GET /agent/voices`: the output voices a profile can use, as
`{ default, voices: [{ id, language, accent }] }`. AssemblyAI has no endpoint that lists voices,
so the voice server keeps the list from its [voices page](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices).

Saving is for admin tools such as the persona console, not for pages visitors load:

```js
import { saveAgentProfile, AgentProfileError } from '@talkie/voice-ui/core/agent-profiles.js';

try {
  const { replaced } = await saveAgentProfile({
    api: 'http://localhost:8000',
    name: 'tour-guide',                      // becomes agents/tour-guide.json
    profile: { greeting: 'Hi!', system_prompt_override: 'You are a friendly tour guide.', tools: [] },
    adminToken,                              // the server's TALKIE_PROFILE_ADMIN_TOKEN
    overwrite: false,                        // true to replace an existing profile
  });
} catch (err) {
  if (err instanceof AgentProfileError && err.code === 'exists') { /* ask, then retry with overwrite */ }
}
```

It calls `PUT ${api}/agent/profiles/{name}`, which the voice server only enables when
`TALKIE_PROFILE_ADMIN_TOKEN` is set. `err.code` is one of `unreachable`, `disabled` (no token
configured), `unauthorized`, `exists`, `not-found`, `invalid` or `failed` (the same for all three
functions); `err.message` carries the
server's reason. Anyone with the token can rewrite what the agent says, so never ship it in a page.


These are intentionally out of scope for the current release. See linked issues for tracking.

- **No multi-turn conversation history.** The widget shows the current exchange only. A scrollable
  transcript panel for previous turns is planned.
- **No text-input fallback.** The error view copy says "or type your question" but there is no text
  input element yet. This would need a `<talkie-text-input>` component or a prop injection.
- **Not on npm yet.** Use `dist/talkie-embed.js`, or install from a local checkout with
  `npm install ../talkie-sdk`.
- **Token route is not access-controlled.** CORS stops other *browsers* from using the token
  server, but not scripts; `/agent/token` has a per-IP rate limit and no authentication. Add a
  real gate before exposing it publicly.

## Testing

```bash
npm test          # 758 assertions across thirteen suites — state machine, backends, audio, widget, embed, the built bundle, the site and its dev server
```

Runs entirely in Node. No browser or JSDOM required for the core unit tests.
