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
The voice server must list the page's origin in `TALKIE_ALLOWED_ORIGINS`. `npm run example`
serves a sample host page on `:5173`. Attributes, CORS, CSP and HTTPS notes are in
[docs/integration.md](docs/integration.md#drop-in-embed-any-web-page-no-build-step).

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
  import '@webcomponents/scoped-custom-element-registry';       // polyfill first
  import '@talkie/voice-ui/define/talkie-widget.js';            // registers <talkie-widget>
</script>
```

That single line makes `<talkie-widget>` available in your markup. You still set the `backend`
property imperatively or via framework bindings to wire up your ASR / LLM / TTS stack.

### The scoped-elements polyfill

If your host page renders multiple component versions or needs IE-level support for the Scoped
Custom Element Registry spec, load it as your first import:

```html
<script type="module" src="@webcomponents/scoped-custom-element-registry"></script>
```

The polyfill itself does not register any elements — it provides the registry infrastructure that
Lit's `ScopedElementsMixin` depends on. Without it, `lion-button` slots inside the widget will
render but lack Lion styling.

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
/** @property {() => void} [dispose] */
```

The SDK ships two backends:

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
| `ask(text, signal)` | Sends nothing — the agent started replying when it closed the turn. Yields the `transcript.agent` text that the message handler has been buffering. |
| `speak(text, signal)` | Wraps the buffered `reply.audio` PCM in a WAV container and plays it. No second synthesis request. |
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

- The answer arrives as one `transcript.agent` frame, sent *after* all reply audio, so `ask()`
  yields once and the widget's word-paced reveal supplies the streaming feel.
- Barge-in is off (`interrupt_response: false`): push-to-talk closes the mic during the reply, so
  nothing can interrupt it, and leaving it on only risks the agent cutting itself off on room noise.
- Turn detection cannot be disabled and there is no commit-turn event, so the agent's own
  end-of-turn decision always wins over the button. See the measurement above.
- `greeting` is spoken on `session.ready`, which in a push-to-talk widget lands while the caller is
  already being listened to. It is omitted by default for that reason.
- `session.resume` is not used. A reconnect needs a fresh single-use token anyway, and the vendor's
  window is only 30 seconds.
- Errors arrive as `TalkieBackendError`, same as `HttpBackend`: an unreachable socket or a transient
  `server_error` maps to `offline`, auth and config failures to `backend-failure`.

### Trying it live

```bash
# terminal 1 — the voice server
cd ../../voice && uv run uvicorn server:app --port 8000

# terminal 2 — the SDK demo
npm start
```

Then open `http://localhost:8081/demo/index.html` and pick **Live backend** on the rail, or
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

  /* State accent colors (used in box-shadow glow + dot indicators) */
  --talkie-state: #5fd9c6;      /* default (idle); per-state overrides work too */

  /* Launcher floating button gradient */
  --talkie-launcher-bg: linear-gradient(145deg, #6ee7d4, #1c7f70);
  --talkie-launcher-offset-right: 28px;
  --talkie-launcher-offset-bottom: 28px;

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

Example listener:

```js
widget.addEventListener('talkie-state-change', ev => {
  console.log(`State: ${ev.detail.from} → ${ev.detail.to}`);
});
```

## Interaction model

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

## Known gaps

These are intentionally out of scope for the current release. See linked issues for tracking.

- **No multi-turn conversation history.** The widget shows the current exchange only. A scrollable
  transcript panel for previous turns is planned.
- **No text-input fallback.** The error view copy says "or type your question" but there is no text
  input element yet. This would need a `<talkie-text-input>` component or a prop injection.
- **No continuous, hands-free conversation.** `VoiceAgentBackend` maps the agent API onto the
  widget's push-to-talk model, which costs the agent's own turn detection, barge-in and spoken
  greeting. A continuous mode would need the widget to cycle states from backend events.
- **Not on npm yet.** Use `dist/talkie-embed.js`, or install from a local checkout with
  `npm install ../talkie-sdk`.
- **Token route is not access-controlled.** CORS stops other *browsers* from using the token
  server, but not scripts; `/agent/token` has a per-IP rate limit and no authentication. Add a
  real gate before exposing it publicly.

## Testing

```bash
npm test          # 334 tests — state machine, backends, audio codecs, embed element and the built bundle
```

Runs entirely in Node. No browser or JSDOM required for the core unit tests.
