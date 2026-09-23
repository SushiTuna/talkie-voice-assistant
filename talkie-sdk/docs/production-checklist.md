# Production checklist — Talkie Voice UI SDK

What to settle before `<talkie-assistant>` / `dist/talkie-embed.js` goes in front of real visitors.
Every item points at the code or doc it comes from, so it can be checked. `[x]` means the SDK
already does it; `[ ]` means a decision or piece of work is still open.

Status as of 2026-09-21, package version `0.1.0` (`package.json`).

---

## 1. Blockers — do not launch without these

- [ ] **Gate the token route.** `/agent/token` mints AssemblyAI session tokens with your API key.
      It has a per-IP rate limit but no authentication, and CORS stops other *browsers*, not
      scripts (README → *Known gaps*; AGENTS.md §16). Anyone who finds the URL can spend your
      AssemblyAI quota. Add a real gate: a signed page session, a short-lived nonce, bot
      protection, or a per-origin/per-user quota.
- [ ] **Keep profile writes off, or behind a real gate.** `PUT /agent/profiles/{name}` rewrites
      what the agent says and which tools it is offered. It is disabled unless
      `TALKIE_PROFILE_ADMIN_TOKEN` is set on the voice server (`server.py` `put_agent_profile`). Leave
      it unset in production, or expose the route only to your admin network: anyone holding the
      token can change every visitor's agent, and the persona console keeps it in the tab's
      `sessionStorage`. Never put the token in a page visitors load.
- [ ] **Set a spend alert or cap on the AssemblyAI account.** Conversation mode keeps the mic
      streaming until the visitor ends it, goes silent for `idle-timeout` (default 60 s), or leaves
      the page (`docs/integration.md` attribute table; `talkie-assistant.js` `_onPageHide`).
      `idle-timeout="0"` streams until closed, so never ship `0` on a public page.
- [ ] **Serve over HTTPS.** Browsers expose `getUserMedia` only in a secure context
      ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#security)).
- [ ] **List every embedding origin in `TALKIE_ALLOWED_ORIGINS`** on the voice server. Unset, it
      allows only the local demo origins (`docs/integration.md` → *What the host page's server
      needs*).
- [ ] **Privacy notice and consent.** The visitor's voice is streamed to AssemblyAI
      (`wss://agents.assemblyai.com`, README → *VoiceAgentBackend*). Say so in your privacy
      policy, and check AssemblyAI's data-retention terms against your own obligations (GDPR/CCPA
      or local equivalents). The SDK does not open the mic until the visitor presses Start
      (`talkie-assistant.js` `_onOpen`: `prewarm({ mic: false })`). Keep it that way.

## 2. Security

- [x] The AssemblyAI API key stays on the server. The browser only gets single-use tokens that
      last at most 600 s (README → *The token route*).
- [x] Each open gets a fresh session. Closing the panel, removing the element or `pagehide` sends
      `session.end` (README method table, `dispose()`; `talkie-assistant.js` `#endSession`).
- [x] The persona (`system_prompt`) is fetched from the server's `/agent/context`, not baked
      into the page (README → *Keeping the persona off the page*). Treat it as public anyway: it
      reaches the browser.
- [ ] **Content-Security-Policy.** If the host page sets a CSP, it must allow:
  - `blob:` in `script-src` or `worker-src`, for the mic's audio worklet
    (`src/audio/pcm-worklet.js`, `createWorkletUrl`);
  - `blob:` in `media-src`, for the WAV playback fallback
    (`src/backends/voice-agent-backend.js`, `new Audio(URL.createObjectURL(…))`). This one is not
    in `docs/integration.md` yet;
  - the voice server and `wss://agents.assemblyai.com` in `connect-src`.
- [ ] **Tool handlers are an input boundary.** The model chooses `onToolCall` arguments. Validate
      them against your own allow-list, as `virtual-tour/talkie-tools.js` does with its `ROOMS`,
      `SECTIONS` and `PLACE_TYPES` lists and `Unknown …` errors — even when the schema's `enum`
      says the same, since with server-profile tools that schema lives elsewhere and can drift.
      Never pass them to `innerHTML`, `eval` or a URL without checking. The API does not validate
      `parameters` schemas (`docs/integration.md` → *Tools*).
- [ ] **Decide whether to publish the source map.** `npm run build` writes
      `dist/talkie-embed.js.map` (about 548 KiB) next to the bundle (`build.mjs`: `sourcemap: true`).

## 3. Hosting and delivery

- [ ] **Build and pin the bundle.** Run `npm run build` → `dist/talkie-embed.js` (118.7 KiB
      minified, about 36 KiB gzip, measured 2026-09-23). `dist/` is not committed; whether it
      should be is an open decision (AGENTS.md §16). Serve it with a versioned file name or a
      content hash, long-cache headers, and compression.
- [ ] **Subresource Integrity** (`integrity="sha384-…"`) if the bundle is served from a CDN or
      another origin.
- [x] **Update the size in `docs/integration.md`.** It says ~119 KiB, measured 2026-09-23.
- [ ] **npm publishing**, if wanted. There is no `files` field yet, so the package would ship
      demo files, tests and the mockup `docs/design/voice-ui-mockup.html`. The name and version
      are an open decision (AGENTS.md §16; README → *Not on npm yet*).
- [ ] **Deploy the voice server** (a separate project; README → *Trying it live*) behind TLS,
      with health checks, and with `ASSEMBLYAI_API_KEY` held in a secret store, not in the repo
      or the image.

## 4. Host page integration

- [ ] Set `api` to the production voice server. The default is `http://localhost:8000`
      (`talkie-assistant.js` `DEFAULT_API`).
- [ ] Choose `profile`, `mode`, `idle-timeout`, `barge-in` and `layout` deliberately
      (`docs/integration.md` attribute table).
- [ ] Check the fixed positioning against the page's own chrome. The launcher and panel use
      `z-index: 2147483000` (`talkie-assistant.js` `Z_INDEX`). Move them with
      `--talkie-launcher-offset-*` and `--talkie-sheet-offset-bottom`, as
      `virtual-tour/styles.css` does for its sticky CTA bar.
- [ ] `fonts="google"` sends each visitor's IP to Google, so it is off by default. Use the page's
      own fonts through `--talkie-font-*` instead (`docs/integration.md`).
- [ ] React ≤18: set `backend`, `tools` and `onToolCall` imperatively. Props become strings
      (`docs/integration.md` → *React ≤18*).

## 5. Product copy and branding

- [x] **"Product Expert" copy is configurable.** `heading` sets the panel's eyebrow, the
      launcher's `aria-label` (`Open <heading>`) and its default hover label
      (`<heading> · Voice`); `subtitle` sets the Start screen line. Both default to the old text
      (`docs/integration.md` attribute table). Set them, or accept the defaults. "Have a
      question?", the hints and the nudge toast are still fixed (see *No localisation*).
- [ ] **No localisation.** All UI strings, including error messages (`ERROR_MESSAGES` in
      `talkie-widget.js`), are English.
- [ ] **No text-input fallback** for visitors who cannot or will not speak (README →
      *Known gaps*). Decide whether launch needs one.
- [ ] **No conversation history.** Only the current exchange is shown (README → *Known gaps*).

## 6. Reliability and behaviour to know

- [x] Errors map to four reasons, each with its own copy: `mic-permission-denied`, `offline`,
      `backend-failure` and `unknown` (SPEC.md; `ERROR_MESSAGES`).
- [x] A missing or failing `/agent/context` falls back to `system-prompt` instead of breaking
      (`talkie-assistant.js` `#fetchContext`).
- [ ] **Set expectations on latency.** Speech starts about 5.5 s after the caller stops talking,
      and about 3.5 s of that is the service's own lead-in (README → *Behaviour worth knowing*;
      AGENTS.md §13, measured).
- [ ] **Undocumented vendor events.** Word-by-word text relies on `transcript.agent.delta`, which
      has been observed but not documented. The whole `transcript.agent` text is the fallback
      (AGENTS.md §13). Re-test after any AssemblyAI API change.
- [ ] **Barge-in on loudspeakers is unverified.** The agent may hear itself and interrupt
      (AGENTS.md §13 and §16). Test on laptop speakers and phones; `barge-in="off"` is the escape
      hatch.
- [ ] **No reconnect.** A dropped socket ends the conversation, and `session.resume` is not used
      (README). Decide whether that is acceptable.

## 7. Observability

- [ ] **Forward `talkie-*` events to analytics and error tracking.** The SDK itself logs only
      two `console.debug` lines, for failed prewarm steps (`http-backend.js`,
      `voice-agent-backend.js`). Useful events: `talkie-error` (`{ reason, error }`),
      `talkie-state-change`, `talkie-open`, `talkie-close`, `talkie-minimize` (README → *Events*).
- [ ] **Voice server metrics:** token mint rate, 4xx/5xx from AssemblyAI, context-route
      failures, and AssemblyAI usage against budget.
- [ ] **Track tool calls:** unknown-tool and invalid-argument errors from `onToolCall` are the
      signal that tool descriptions need work.

## 8. Accessibility and UX

- [x] State changes are announced through an `aria-live="polite"` region (`talkie-widget.js`
      `render()`).
- [x] Reduced motion is respected by the waveform, the launcher waves and the talking bars
      (`prefers-reduced-motion` in `talkie-waveform.js` and `talkie-launcher.js`).
- [x] Phones get a bottom sheet, and a minimized panel keeps the conversation going
      (`layout="auto"`; `minimize()` / `restore()`).
- [ ] Run a screen-reader pass (VoiceOver on iOS and macOS, TalkBack, NVDA): opening, Start,
      minimize, restore, End, errors.
- [ ] Check keyboard focus. Escape ends the conversation and Space toggles it (`_onKeydown`).
      Minimizing does not move focus to the launcher yet.
- [ ] Check colour contrast of the state colours and the hint text against your theme tokens.

## 9. Browser and device matrix (human QA)

- [ ] Chrome, Edge, Firefox, Safari (macOS); Safari and Chrome (iOS); Chrome (Android).
- [ ] Mic permission: first prompt, denied, revoked mid-session, no mic device.
- [ ] Bluetooth headset, wired headset, laptop speakers (echo), phone speaker.
- [ ] iOS: audio after the phone is locked or the app is backgrounded, and the silent switch.
- [ ] Slow network (throttled 3G) and offline mid-conversation → `offline` error view.
- [ ] Long session near the token's lifetime (≤600 s, set by your token route) and near
      `idle-timeout`.

## 10. Release gate

- [ ] `npm test` passes (all suites in `package.json` `test`).
- [ ] `npm run build` succeeds, and the `tests/embed-bundle.mjs` checks pass on the built file.
- [ ] Human sign-off on section 9. Browser, mic and audio QA is manual (AGENTS.md §15).
- [ ] The open decisions in AGENTS.md §16 are settled or explicitly deferred.
- [ ] Changelog and version bump. The package is still `0.1.0`.
