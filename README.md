# Developer Guide

Onboarding for the Talkie voice assistant project.

Read this top to bottom once. It takes about 15 minutes.

---

## 1. What this project is

Two things that work together:

| Part | What it is |
|---|---|
| **`talkie-sdk/`** | A voice widget. Web components. Drop it into any page. |
| **`virtual-tour/`** | A 3D house tour with a listing page. Babylon.js. |

A third part lives **outside this repo**:

| Part | Where | What it is |
|---|---|---|
| **voice server** | `~/Develop/voice` | Python API. Mints tokens. Serves the agent's persona. |

That third one surprises people. It is a separate git repo. Clone it separately.

---

## 2. Architecture

The widget never talks to a vendor directly. It talks to a **backend**.

```
┌─────────────────┐
│  <talkie-widget>│   web component, owns the UI + state machine
└────────┬────────┘
         │  backend contract (4 methods)
         ▼
┌─────────────────┐
│    a backend    │   MockBackend | HttpBackend | VoiceAgentBackend
└────────┬────────┘
         │
         ▼
   speech vendor / your server
```

Swap the backend, and the UI does not change. That is the whole design.

### The backend contract

Four methods. That is all a backend must provide.

```js
const backend = {
  async startCapture()      { /* open mic */ },
  async stopCapture()       { return 'what the user said'; },
  async *ask(text, signal)  { yield 'answer'; yield ' text'; },
  async speak(text, signal) { /* play audio — optional */ },
  dispose()                 { /* clean up — optional */ },
};
```

`ask()` is an async generator. It yields text as it arrives. That is how streaming works without the UI knowing the transport.

Every long call gets an `AbortSignal`. Press Esc, and the work actually stops.

Defined in `talkie-sdk/src/core/backend.js`.

### The three backends

| Backend | Use it for |
|---|---|
| `MockBackend` | Demos and tests. Scripted replies. No network, no mic. |
| `HttpBackend` | Your own server. Separate STT, LLM and TTS calls. |
| `VoiceAgentBackend` | AssemblyAI Voice Agent. One socket does all three. |

### The state machine

Six states. Illegal moves throw.

```
idle → listening → transcribing → thinking → speaking → idle
                                                   ↘ error → idle
```

Pure JavaScript. No DOM. Testable in Node.

Defined in `talkie-sdk/src/core/state-machine.js`.

---

## 3. How a turn flows

Press the button. Speak. Press again.

```
press    → startCapture()   mic opens, audio streams
release  → stopCapture()    returns the transcript
         → ask()            yields the answer text
         → speak()          plays the audio
```

The widget drives this. You do not call these yourself.

### What the audio pipeline does

1. Mic gives you audio at the device's rate. Usually 48 kHz.
2. An `AudioWorklet` resamples it. Converts to 16-bit PCM.
3. Chunks go out every 100 ms.

The worklet runs on the audio thread. Layout work on the main thread would drop frames.

Files: `talkie-sdk/src/audio/mic-capture.js` and `pcm-worklet.js`.

---

## 4. The agent's personality

`VoiceAgentBackend` needs a system prompt. Do not hard-code it.

The voice server serves it instead. One JSON file per agent, in `~/Develop/voice/agents/`.

```js
const ctx = await fetch('http://localhost:8000/agent/context?profile=property')
  .then(r => r.json());

widget.backend = new VoiceAgentBackend({
  tokenUrl:     'http://localhost:8000/agent/token',
  systemPrompt: ctx.system_prompt,
  keyterms:     ctx.keyterms,
  voice:        ctx.voice,
});
```

### Writing a profile

Only `agent.role` and `greeting` are required. A profile with a `system_prompt_override` (one fixed prompt) can leave out `agent`.

```json
{
  "agent":    { "role": "You are a lending assistant for Acme Bank." },
  "greeting": "Hi! What would you like to know?",
  "knowledge": [
    { "heading": "PRODUCTS",
      "items": [{ "label": "Home loan", "value": "up to 20 years" }] }
  ],
  "boundaries": {
    "unknown": [{ "label": "interest rates", "value": "only an officer can quote one" }],
    "never":   ["Never quote a figure you were not given."]
  },
  "style": ["Keep answers to one or two sentences."]
}
```

**`boundaries` is the important part.**

A fact in neither `knowledge` nor `boundaries.unknown` is a fact the model will make up. Put every gap in `unknown`. It is rendered under a never-guess instruction.

Never put the same fact in both. The agent will contradict itself.

Edit the file. Refresh the page. No restart — files reload when they change.

Four profiles ship today: `property`, `finance`, `education`, `it-support`. The last three are templates. They use `[square brackets]` where a real fact belongs.

A profile can also carry `tools`: function-tool definitions the page runs. `/agent/context` serves them, and `<talkie-assistant>` uses them when the page sets none. `property` holds the virtual tour's three tools.

The persona console at `http://localhost:8081/site/console.html` lists the profiles and opens them. **Send to server…** writes one back through `PUT /agent/profiles/{name}`. That route is off until `TALKIE_PROFILE_ADMIN_TOKEN` is set on the voice server.

---

## 5. Tooling

### Running things

Three servers. Three terminals.

```bash
# 1. voice server (separate repo)
cd ~/Develop/voice
TALKIE_ALLOWED_ORIGINS="http://localhost:8081,http://localhost:8080" \
  uv run uvicorn server:app --port 8000   # 8080 lets the tour's assistant in

# 2. the SDK demo
cd talkie-sdk && npm start          # → http://localhost:8081

# 3. the 3D tour
cd virtual-tour && npm start        # → http://localhost:8080
```

Open **http://localhost:8081/demo/index.html**. Pick a scenario from the left rail.

| Rail item | What it does |
|---|---|
| 01–06 | Mock backend. No mic, no network. Start here. |
| 07 | `HttpBackend` against the voice server. |
| 08 | `VoiceAgentBackend` against AssemblyAI. Uses your mic. |

Add `?profile=it-support` to try another persona.

### Tests

```bash
cd talkie-sdk && npm test                  # 272 assertions, 7 suites
cd ~/Develop/voice && python3 tests/agent_profile.py   # 37 assertions
```

Zero dependencies. No Jest, no pytest. Plain scripts that print `ok` or `FAIL`.

The virtual tour has its own:

```bash
cd virtual-tour && npm run smoke
```

### Ports

| Port | Serves |
|---|---|
| 8000 | voice server (Python) |
| 8080 | virtual tour |
| 8081 | SDK demo |

---

## 6. Gotchas

These will cost you an hour each. Read them now.

**CORS is locked to 8081.**
The voice server allows `localhost:8081` only. Serve the demo anywhere else and the fetches fail silently. The agent then runs with no knowledge. Set `TALKIE_ALLOWED_ORIGINS` to change it.

**The demo bundles once, at startup.**
Edit `demo/demo.js`, and you must restart `npm start`. Editing `agents/*.json` needs no restart.

**The agent answers before you release the button.**
That is the vendor, not a bug. It decides end-of-turn itself. There is no way to disable it and no event to commit a turn. `min_silence` does not change the timing — that was measured, not assumed.

**Never commit an API key.**
The voice server reads `ASSEMBLYAI_API_KEY` from its own `.env`. The browser only ever sees a short-lived token. Keep it that way.

---

## 7. Common tasks

### Add a new backend

Implement the four methods. Export it. Done.

```js
// src/backends/my-backend.js
import { TalkieBackendError } from '../core/backend.js';

export class MyBackend {
  async startCapture() { /* ... */ }
  async stopCapture()  { return transcript; }
  async *ask(text, signal) { yield answer; }
}
```

Throw `TalkieBackendError` with one of these reasons, and the widget shows the right error screen:

`mic-permission-denied` · `no-speech-detected` · `offline` · `backend-failure` · `unknown`

### Listen to what the widget is doing

Events bubble. Listen at `document` if you like.

```js
widget.addEventListener('talkie-state-change', e => {
  console.log(e.detail.from, '→', e.detail.to);
});
```

Also available: `talkie-transcript`, `talkie-response`, `talkie-error`, `talkie-open`, `talkie-close`.

### Change what the agent knows

Edit `~/Develop/voice/agents/property.json`. Refresh the page.

To see exactly what it is being told:

```bash
curl -s localhost:8000/agent/context \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['system_prompt'])"
```

---

## 8. Where to read next

| File | Why |
|---|---|
| `talkie-sdk/README.md` | Backend contract in full. Theming. Public API. |
| `talkie-sdk/docs/integration.md` | React, Vue, Angular, plain HTML. |
| `~/Develop/voice/README.md` | Profile schema. Endpoints. Webhooks. |
| `virtual-tour/README.md` | The 3D tour and its camera API. |
| `talkie-sdk/SPEC.md` | Why the SDK is built this way. |

---

## 9. Not built yet

The agent can describe the house. It cannot show you the house.

The tour exposes `window.tour.goTo('kitchen')`. `VoiceAgentBackend` supports tool calls. Nobody has connected the two. The widget is not on the tour page at all.

That is the next piece of work.
