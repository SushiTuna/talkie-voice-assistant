# Framework Integration — Talkie Voice UI SDK

Import the components into any framework using one of the two registration strategies below.
All frameworks share the same runtime API: properties in, events out.

## Drop-in embed (any web page, no build step)

The fastest route, and the only one that needs no bundler. Build the one-file bundle:

```bash
npm run build        # → dist/talkie-embed.js (~88 KiB, every dependency inlined)
```

Host that file anywhere your page can load it, then add two lines:

```html
<script src="/path/to/talkie-embed.js" defer></script>
<talkie-assistant api="http://localhost:8000"></talkie-assistant>
```

`<talkie-assistant>` mounts the floating launcher and the widget, positions them bottom-right,
and builds a `VoiceAgentBackend` from its attributes. It fetches the persona from
`${api}/agent/context` when the page loads and only mints a token when the visitor opens it.
Closing the panel, removing the element or leaving the page ends the agent session.

| Attribute | Default | Purpose |
|---|---|---|
| `api` | `http://localhost:8000` | Origin of the voice server |
| `token-url` | `${api}/agent/token` | Token route, if it lives elsewhere |
| `profile` | server default | Agent profile, sent as `?profile=` to `/agent/context` |
| `system-prompt` | a short generic prompt | Used only when `/agent/context` is missing or fails |
| `voice` | server's, else `anna` | Output voice |
| `label` | `Product Expert · Voice` | Launcher hover label |
| `fonts` | off | `google` loads Space Grotesk + Instrument Sans from Google Fonts |

`fonts` is opt-in because the request sends each visitor's IP address to Google; without it the
widget falls back to the page's sans-serif. Script access: `el.open()`, `el.close()`, and
`el.widget` for the `talkie-*` events.

A worked example lives at [`../examples/embed.html`](../examples/embed.html) — see
[Running the example](#running-the-example).

### What the host page's server needs

- **CORS.** The voice server only answers origins listed in `TALKIE_ALLOWED_ORIGINS`
  (comma-separated). Unset, it allows only the demo, `http://localhost:8081` and
  `http://127.0.0.1:8081`. Add every origin that embeds the assistant.
- **A secure context for the microphone.** Browsers expose `getUserMedia` only on HTTPS or
  `localhost` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#security)).
- **CSP, if the host page sets one.** The audio worklet is loaded from a `blob:` URL, so a page
  with a Content-Security-Policy must allow `blob:` in `script-src` (or `worker-src`), and must
  allow the voice server in `connect-src` along with `wss://agents.assemblyai.com`.

### Running the example

```bash
# 1. Voice server, allowing the example's origin (from the voice server's directory)
TALKIE_ALLOWED_ORIGINS="http://localhost:8081,http://localhost:5173" \
  .venv/bin/uvicorn server:app --port 8000

# 2. Example host page on a different origin (from talkie-sdk/)
npm run example      # builds, then serves on :5173
```

Open `http://localhost:5173/examples/embed.html`.

## Module import (apps with a bundler)

Register the elements you need and wire the backend yourself:

```html
<script type="module">
  import '@talkie/voice-ui/define/talkie-widget.js';   // registers <talkie-widget>
  // or, for the self-wiring launcher + widget:
  import '@talkie/voice-ui/define/talkie-assistant.js';
</script>
```

Until the package is published, install it from a local checkout: `npm install ../talkie-sdk`.

### The scoped-registry polyfill is optional

The components use `ScopedElementsMixin` from `@open-wc/scoped-elements` (v2) to render their
internal `<lion-button>` and `<lion-icon>`. When the browser has no scoped custom-element
registries, the mixin falls back to the global registry, which works on its own. The one case it
cannot handle is a host page that has **already registered a different `lion-button`** class; it
then logs an error. Only in that case, load `@webcomponents/scoped-custom-element-registry` before
anything else on the page. The `dist/talkie-embed.js` bundle does not include it.

## Backend configuration

Every integration must set the `backend` property on `<talkie-widget>`. This is the single point
where you wire your ASR / LLM / TTS stack. For a real stack pointed at a Talkie voice server, use
the shipped adapter:

```js
import { HttpBackend } from '@talkie/voice-ui/backends/http-backend.js';

const backend = new HttpBackend({ baseUrl: 'http://localhost:8000' });
```

For the AssemblyAI Voice Agent API — one socket covering recognition, the model turn and speech —
use the agent adapter instead. It needs only a route of yours that mints a short-lived token:

```js
import { VoiceAgentBackend } from '@talkie/voice-ui/backends/voice-agent-backend.js';

const backend = new VoiceAgentBackend({
  tokenUrl: 'https://your-server/agent/token',
  systemPrompt: 'You are Talkie, a concise product assistant.',
});
```

See the [README](../README.md#voiceagentbackend--one-socket-for-the-whole-turn) for the token route
and the behavioural trade-offs of mapping a continuous agent onto push-to-talk.

To wire a different stack, implement the four methods yourself:

```js
const backend = {
  async startCapture()   { /* begin mic recording */ },
  async stopCapture()    { return transcript; },
  async *ask(text, sig)  { /* stream answer tokens */ },
  dispose()              { /* cleanup resources */ },
};
// Set via property binding or imperatively (see React ≤18 below).
```

Because `backend` is a property and not an attribute, every framework below differs only in how it
passes an object rather than a string.

## Angular

```ts
// app.component.ts
import { Component } from '@angular/core';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `
    <talkie-widget
      [backend]="backend"
      (talkie-error)="onError($event)"
    ></talkie-widget>
  `,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],  // tell the compiler to ignore unknown tags
})
export class AppComponent {
  readonly backend = { /* see backend config above */ };

  onError(event: Event & { detail: { reason: string } }) {
    console.error('Talkie error:', event.detail?.reason);
  }
}
```

Angular's `[backend]` property binding passes the object reference directly to the custom element,
so the backend contract works without any escape hatch.

## Vue

```vue
<!-- App.vue -->
<template>
  <talkie-widget :backend="backend" @talkie-error="onError" />
</template>

<script setup>
// In vue.config.js or vite.config.js:
// export default { compilerOptions: { isCustomElement: tag => tag.startsWith('talkie-') } }

const backend = ref({ /* see backend config above */ });

function onError(event) {
  console.error('Talkie error:', event.detail?.reason);
}
</script>
```

Vue requires telling the compiler to treat `talkie-*` tags as custom elements rather than looking
for Vue components:

```js
// vite.config.js  (or vue.config.js)
export default defineConfig({
  vue: {
    template: {
      compilerOptions: {
        isCustomElement: tag => tag.startsWith('talkie-'),
      },
    },
  },
});
```

## React

### React 19+

React 19 natively supports passing objects and function handlers to custom elements:

```jsx
function App() {
  const backend = useRef({ /* see backend config above */ }).current;

  return (
    <talkie-widget backend={backend} onTalkieError={(e) => console.error(e.detail?.reason)} />
  );
}
```

### React ≤18 — imperative escape hatch

**⚠️ This is the most likely integration failure.** React ≤18 stringifies all props when rendering
custom elements. So `backend={{ obj }}` becomes the string `"[object Object]"`, which the widget
cannot use.

Use `useRef` + `useEffect` to set the property imperatively and listen for events via
`addEventListener`:

```jsx
import { useRef, useEffect } from 'react';

function App() {
  const widgetRef = useRef(null);

  useEffect(() => {
    const el = widgetRef.current;
    if (!el) return;

    // Imperatively set the backend property (avoids stringification).
    el.backend = {
      async startCapture()   { /* ... */ },
      async stopCapture()    { return text; },
      async *ask(text, sig)  { yield token; },
      dispose()              {},
    };

    // Listen for events imperatively.
    const onError = (e) => console.error('Talkie error:', e.detail?.reason);
    el.addEventListener('talkie-error', onError);
    el.addEventListener('talkie-state-change', (e) => {
      console.log('State →', e.detail.to);
    });

    // Clean up listeners on unmount.
    return () => el.removeEventListener('talkie-error', onError);
  }, []); // run once on mount

  return <talkie-widget ref={widgetRef} />;
}
```

This pattern also works as an escape hatch for any framework where native prop/event delegation
is unavailable.

## Plain HTML

With no bundler, use the drop-in embed above — it is the plain-HTML route. To wire a widget to
a backend of your own instead of using `<talkie-assistant>`, the same bundle exposes the classes
on `window.Talkie`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <script src="/path/to/talkie-embed.js"></script>
</head>
<body>
  <div style="position:fixed;bottom:80px;right:28px;">
    <talkie-widget id="widget"></talkie-widget>
  </div>
  <script>
    const widget = document.getElementById('widget');
    widget.backend = new Talkie.MockBackend();
    widget.show();
  </script>
</body>
</html>
```

See [`../README.md`](../README.md) for theming, backend details, and known gaps.
