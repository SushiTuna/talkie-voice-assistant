# Talkie Voice UI SDK — build spec

Extract the six voice states from `Qwen_html_20260920_2zzvkipj6.html` (in this folder) into a
reusable, framework-agnostic web-component package built on Lion + Lit.

Reference implementation for look/feel/copy/timing: that HTML file. Read it first. It is a
mockup — all behaviour is simulated. We are keeping its visual design and state model, and
replacing the simulation with a pluggable backend interface.

## Goals

1. **Pluggable into any webapp** — Angular, React, Vue, or plain HTML. Custom elements are the
   interop layer.
2. **Abstracted backend** — the UI never talks to a vendor SDK. It talks to one interface that a
   host app implements to wire in its own ASR / LLM / TTS.

## Package

Create `talkie-sdk/` as an npm package `@talkie/voice-ui`, `"type": "module"`.

Dependencies: `lit`, `@lion/ui`, `@open-wc/scoped-elements`.
Dev: `esbuild` (bundling the demo), nothing heavier. No test framework beyond plain node scripts —
match `virtual-tour/`'s style (`node tests/*.mjs`).

### Hard rule: no side effects on import

Per org guidance (`lion-components/docs/fundamentals/node-tools/rocket-preset-extend-lion-docs/overview.md`,
"Do not distribute side effects"): the main entry exports **classes only** and must never call
`customElements.define`. That lets a host app run our components alongside a different version of
Lion or of this package.

```
src/index.js          -> export { TalkieWidget, TalkieLauncher, ... }  (no define)
src/define/talkie-widget.js -> customElements.define('talkie-widget', TalkieWidget)  (opt-in)
```
Host apps that just want it working import `@talkie/voice-ui/define/talkie-widget.js`.
Host apps that need version isolation import the class and register it themselves.

### Hard rule: ScopedElementsMixin for composition

Per `lion-components/docs/guides/principles/scoped-elements.md`: any component that renders another
component in its template uses `ScopedElementsMixin` + `static get scopedElements()`. Do not put
`lion-*` tags in a template without scoping them. Document in the README that consumers need the
`@webcomponents/scoped-custom-element-registry` polyfill loaded first.

### Styling

Lion ships white-label functional styling only; theming is our layer. Expose the mockup's palette as
CSS custom properties on the host (`--talkie-bg`, `--talkie-paper`, `--talkie-ink`, `--talkie-state`,
`--talkie-font-display`, `--talkie-font-body`, `--talkie-font-mono`, …) with the mockup's values as
defaults, so a host app rebrands without touching shadow DOM. Do not hardcode the Google Fonts
`<link>` into the component — document the fonts as optional and fall back to system stacks.

## State model

Six states, from the mockup: `idle`, `listening`, `transcribing`, `thinking`, `speaking`, `error`.

Put the machine in `src/core/state-machine.js` as a plain class with **no DOM dependency** — it must
be unit-testable in node. It owns: current state, legal transitions, the transcript, the response
text, and the error reason. It emits change events. Components render from it; they do not each keep
their own copy.

Legal transitions (reject anything else, and say so in a thrown error):
```
idle        -> listening, error
listening   -> transcribing, idle (cancel), error
transcribing-> thinking, idle (cancel), error
thinking    -> speaking, idle (cancel), error
speaking    -> idle, error
error       -> idle
```
Every in-flight state can be cancelled back to `idle`: the user pressing Esc while the assistant is
transcribing or thinking is an ordinary path, not an error. Cancelling aborts the backend's
`AbortSignal` and clears the transcript and response.

`error` carries a `reason` field, one of: `mic-permission-denied`, `no-speech-detected`, `offline`,
`backend-failure`, `unknown`. The mockup has a single generic error; these are the real failure modes
of browser voice and each needs its own copy string. Keep it one state with a reason, not six states.

## Backend interface

`src/core/backend.js` defines the contract. The widget accepts a backend instance as a property;
it never imports a concrete one.

```js
/**
 * @typedef {Object} TalkieBackend
 * @property {() => Promise<void>} startCapture  - begin mic capture; reject on permission denial
 * @property {() => Promise<string>} stopCapture - end capture, resolve with the transcript
 * @property {(transcript: string, signal: AbortSignal) => AsyncIterable<string>} ask
 *           - send transcript, yield response text incrementally (token/word chunks)
 * @property {(text: string, signal: AbortSignal) => Promise<void>} [speak]
 *           - optional TTS; when absent the widget renders text only
 * @property {() => void} [dispose]
 */
```

Notes for the implementer:
- `ask` returning an `AsyncIterable` is what makes streaming work without the UI knowing whether the
  backend is SSE, WebSocket, or a single blocking call that yields once. Do not replace it with a
  callback.
- Every long-running call takes an `AbortSignal` so the Stop button and Esc actually cancel in-flight
  work rather than just hiding the UI.
- Errors thrown by a backend must be mapped to an error `reason` by the widget, not by the backend.
  Provide a `TalkieBackendError` class with a `reason` field for backends that want to be specific.

Ship **one** concrete implementation: `src/backends/mock-backend.js`, replaying the four Q&A pairs
from the mockup's `SCRIPT` array with its timings (950ms transcribe, 1500ms think). This drives the
demo and the tests. Do not write an AssemblyAI/OpenAI adapter — that is the host app's job, and the
README shows the shape.

## Components

All in `src/components/`, one file each, extending Lion where Lion has a base worth having
(`LionButton` for the talk/stop/retry controls — match how `virtual-tour/components/tour-button.js`
subclasses it) and `LitElement` where it doesn't.

- `talkie-widget` — the card. Owns the state machine, renders the current state's view, takes the
  `backend` property. This is the only element a host app strictly needs.
- `talkie-launcher` — the floating mic button with pulse ring + nudge toast.
- `talkie-waveform` — the canvas visualiser from the mockup's `startWave()`.
- `talkie-transcript` — shows what the user said (see fix #3 below).

### Fixes to apply while extracting — do not port these bugs

The mockup has defects found in review. Fix them in the components:

1. **Short-tap stranding.** `releaseListening()` ignores holds under 240ms, but the `pointerup` is
   already consumed, so a quick tap leaves the UI stuck in Listening forever. A sub-threshold tap
   must resolve to something — either cancel back to `idle` with a "hold to talk" hint, or latch into
   tap-to-toggle mode. Pick one and make it deliberate.
2. **Hold-to-talk must not be the only input mode.** Sustained press is a motor-load barrier
   (WCAG 2.5.1). Support tap-to-start / tap-to-stop as well as hold. Expose a `mode` property
   (`"hold" | "toggle" | "auto"`, default `"auto"` = tap toggles, hold also works).
3. **Show the user their transcript.** The mockup only logs it to a dev panel. Render the recognised
   text in the widget from `transcribing` onward, so a user can see when ASR misheard.
4. **`aria-live` scope.** The mockup puts `aria-live="polite"` on the whole card, whose subtree is
   replaced every transition — screen readers re-announce everything each time, then churn word by
   word while streaming. Use a small dedicated `role="status"` node carrying only the state label,
   and announce the response once on completion, not per token.
5. **Reduced motion is half-applied.** The CSS `prefers-reduced-motion` block kills CSS animation but
   the waveform is a `requestAnimationFrame` canvas loop and keeps running. `talkie-waveform` must
   check `matchMedia('(prefers-reduced-motion: reduce)')` and render a static bar field instead.
6. **Stale hint text.** The mockup rewrites the hint to "Hold Space to talk" on *every* transition,
   so it says that while the assistant is speaking. Hint copy must be per-state.
7. **Speaking pace.** 46ms/word is ~1300wpm, ~8x real speech. When a backend supplies no TTS timing,
   default the text reveal to ~400ms/word (roughly 150wpm), and let real chunk arrival drive it when
   the backend streams.
8. **`e`-key hotkey** is bound globally with no input-focus guard. Keep debug hotkeys out of the
   shipped component entirely — put them in the demo page only.

### Public API of `talkie-widget`

Properties: `backend`, `mode`, `open` (boolean, reflects), `state` (read-only, reflects as attribute
for host CSS).
Methods: `show()`, `hide()`, `reset()`.

> A property named `open` and a method named `open()` cannot coexist on one object — the accessor and
> the method occupy the same key. We keep the **property** `open` (matching `<dialog>`/`<details>`)
> and name the methods `show()` / `hide()`, matching `<dialog>`'s own method names.

Because `open` is a boolean attribute, an open widget carries `open=""` — so host CSS must key
visibility off `:host(:not([open]))`, never `:host([open=""])` or `:host([open="false"])`, both of
which invert the intended behaviour.
Events (all `CustomEvent`, composed, bubbling, `talkie-` prefixed): `talkie-state-change`
(`{from, to}`), `talkie-transcript` (`{text}`), `talkie-response` (`{text}`), `talkie-error`
(`{reason, error}`), `talkie-open`, `talkie-close`, `talkie-minimize`, `talkie-restore`.

Properties-in / events-out is what makes this work in every framework: Angular binds `[backend]` and
`(talkie-error)`, Vue binds `:backend` and `@talkie-error`, React 19 binds both natively.

## Framework integration

Do **not** build wrapper packages for each framework. Instead `docs/integration.md` with a working
snippet per framework:
- **Angular** — `CUSTOM_ELEMENTS_SCHEMA`, property binding, event binding.
- **Vue** — `compilerOptions.isCustomElement` config.
- **React** — note that React 19 passes objects/events to custom elements natively; for React ≤18
  show the `useRef` + `addEventListener` + imperative property-set escape hatch, because React ≤18
  stringifies props and will break the `backend` object binding.
- **Plain HTML** — script tag + `define/` import.

## Demo

`demo/index.html` — reproduces the mockup's review harness (state rail, event log, clock) driving the
real components via `MockBackend`, so we can still walk stakeholders through all six states. Debug
hotkeys live here, not in the library. Serve it with a tiny `server.mjs` like `virtual-tour/`'s, and
add `npm start`.

## Tests

`tests/state-machine.mjs` — plain node, no browser: legal transitions pass, illegal ones throw,
error reasons round-trip, abort mid-`thinking` lands in `idle`.
`tests/mock-backend.mjs` — `ask()` yields chunks and respects its `AbortSignal`.
Wire both to `npm test`.

## Out of scope

No real ASR/LLM/TTS adapter. No build/publish pipeline beyond what runs the demo. No conversation
history or multi-turn scrollback. No text-input fallback yet (note it in the README as the next
step — the mockup's error copy promises one).

## Acceptance

- `npm test` passes.
- `npm start` serves the demo; all six states reachable from the rail and from real interaction.
- `grep -rn "customElements.define" src/` shows matches **only** under `src/define/`.
- No `innerHTML` with interpolated dynamic values anywhere (the mockup's `log()` had that bug).
- README documents: install, the polyfill requirement, the backend interface, and a rebrand example
  using the CSS custom properties.
