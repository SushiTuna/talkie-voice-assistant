# Framework Integration — Talkie Voice UI SDK

Import the components into any framework using one of the two registration strategies below.
All frameworks share the same runtime API: properties in, events out.

## Quick setup (all frameworks)

Load the scoped-elements polyfill as your **first** import so that multiple versions of a
component can coexist on the same page:

```html
<script type="module">
  import '@webcomponents/scoped-custom-element-registry'; // ← first!
  import '@talkie/voice-ui/define/talkie-widget.js';       // registers <talkie-widget>
</script>
```

### Why the polyfill?

The widget component uses `ScopedElementsMixin` from `@open-wc/scoped-elements`. When you render
a `<lion-button>` inside the widget's shadow DOM, the mixin needs the Scoped Custom Element
Registry to scope those children correctly. The polyfill is not yet installed by this package;
consumers add it to their project when they hit a missing-registry error (the widget will
render but Lion elements won't be styled or functional without it).

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

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --talkie-paper: #f7f5ec; --talkie-ink: #101d20; --talkie-font-display: 'Space Grotesk', sans-serif;
      --talkie-font-body: 'Instrument Sans', sans-serif; --talkie-font-mono: monospace;
    }
  </style>
</head>
<body>
  <div id="container" style="position:fixed;bottom:80px;right:28px;">
    <talkie-widget id="widget"></talkie-widget>
  </div>

  <!-- Import the scoped-elements polyfill first, then register the component -->
  <script type="module">
    import '@webcomponents/scoped-custom-element-registry';
    import '@talkie/voice-ui/define/talkie-widget.js';
    import { MockBackend } from '@talkie/voice-ui/backends/mock-backend.js';

    const widget = document.getElementById('widget');
    widget.backend = new MockBackend();
  </script>
</body>
</html>
```

See [`../README.md`](../README.md) for theming, backend details, and known gaps.
