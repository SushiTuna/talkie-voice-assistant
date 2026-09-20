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

The SDK ships **only `MockBackend`**, which replays four scripted Q&A pairs with simulated timing
(950 ms transcribe + 1500 ms think). Wiring a real ASR / LLM / TTS pipeline is the host app's job
and the typical integration effort.

### Worked example: a stub adapter

```js
import { SpeechRecognition } from './my-asr.js';    // your browser speech API wrapper
import { queryLLM } from './my-llm.js';             // your REST / SSE client

class RealBackend {
  #recognition = null;

  async startCapture(signal) {
    this.#recognition = new SpeechRecognition();
    return new Promise((resolve, reject) => {
      this.#recognition.onresult = () => resolve();  // actual transcript collected incrementally
      this.#recognition.onerror = (e) => reject(new TalkieBackendError('no-speech-detected', e.error));
      this.#recognition.start();
    });
  }

  async stopCapture() {
    const transcript = this.#recognition?.resultText ?? '';
    this.#recognition?.abort?.();
    return transcript;
  }

  async *ask(transcript, signal) {
    // Stream tokens from an SSE endpoint
    const res = await fetch('/api/ask', {
      method: 'POST', body: JSON.stringify({ text: transcript }),
      headers: { 'Content-Type': 'application/json' },
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;
        const chunk = decoder.decode(value, { stream: true });
        yield* chunk.split(/\s+/).filter(Boolean);  // word-level chunks
      }
    } finally { reader.cancel().catch(() => {}); }
  }

  dispose() {
    this.#recognition?.abort?.();
  }
}
```

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

## Public API

| Property / Method | Type                | Description                              |
|-------------------|---------------------|------------------------------------------|
| `backend`         | `TalkieBackend`     | Set before showing the widget.           |
| `mode`            | `'hold' \| 'toggle' \| 'auto'` | Input mode (default: `'auto'`). |
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
- **Only `MockBackend` ships.** Wiring ASR / LLM / TTS is required for production use. The SDK
  provides the interface and tests but not an adapter.
- **Browser polyfills.** The scoped-elements polyfill is documented but not installed by the
  package. Consumers add it to their project when needed.

## Testing

```bash
npm test          # 79 tests — state machine + mock backend (zero dependencies)
```

Runs entirely in Node. No browser or JSDOM required for the core unit tests.
