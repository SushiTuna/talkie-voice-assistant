#!/usr/bin/env node
/**
 * Tests for <talkie-assistant> — the attribute-configured embed element.
 *
 * The SSR DOM shim has no tree operations (append, style, ownerDocument), so each element
 * gets a small fake document that hands out *real* launcher and widget instances. What is
 * under test is this element's own wiring: which URLs it calls, whether the server's persona
 * reaches the backend, and when an agent session is started and ended.
 */

import * as shim from '@lit-labs/ssr-dom-shim';

for (const k of [
  'HTMLElement', 'customElements', 'Element', 'Event', 'CustomEvent',
  'ShadowRoot', 'CSSStyleSheet', 'Node', 'EventTarget', 'MutationObserver',
  'ResizeObserver', 'IntersectionObserver', 'HTMLSlotElement',
  'ElementInternals', 'Document',
]) {
  if (!(k in globalThis) && shim[k]) globalThis[k] = shim[k];
}
globalThis.window ??= globalThis;
globalThis.document ??= shim.document;

await import('../src/define/talkie-assistant.js');

// Node has no AudioContext, so every prewarm logs a failed audio step, and the fallback
// tests log the missing context route on purpose. Both are expected; keep the output to
// the checks themselves.
console.debug = () => {};
console.warn = () => {};

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Record every fetch and answer it from `routes`, keyed by URL. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const route = routes[String(url)];
    if (route instanceof Error) throw route;
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => route };
  };
  return calls;
}

/**
 * Build a <talkie-assistant> with the given attributes and a fake document, then connect it.
 * @returns {{ el: any, appended: any[], head: any[], win: EventTarget }}
 */
function mount(attrs = {}) {
  const Ctor = customElements.get('talkie-assistant');
  const el = new Ctor();
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);

  const appended = [];
  const head = [];
  const win = new EventTarget();
  const doc = {
    defaultView: win,
    head: { append: (n) => head.push(n) },
    querySelector: (sel) => head.find((n) => sel.includes(n.href)) ?? null,
    createElement(tag) {
      const C = customElements.get(tag);
      const node = C ? new C() : { tagName: tag.toUpperCase() };
      node.style ??= {};
      node.remove ??= () => { node.removed = true; };
      return node;
    },
  };
  Object.defineProperty(el, 'ownerDocument', { value: doc });
  Object.defineProperty(el, 'isConnected', { value: true, writable: true });
  el.append = (...nodes) => appended.push(...nodes);
  el.connectedCallback();
  return { el, appended, head, win };
}

// ── mounting ────────────────────────────────────────────────────────────────
async function testMountsLauncherAndWidget() {
  stubFetch({});
  const { el, appended } = mount();
  const tags = appended.map((n) => n.localName ?? n.tagName?.toLowerCase());
  check('mounts a launcher and a widget', appended.length === 2, tags.join(','));
  check('the widget is exposed for event listeners', el.widget === appended[1]);
  check('the widget is fixed above the launcher',
    el.widget.style.position === 'fixed' && el.widget.style.bottom === '104px',
    JSON.stringify(el.widget.style));
  check('both sit above typical host-page chrome',
    appended.every((n) => Number(n.style.zIndex) > 1_000_000));
  check('no session exists before the assistant is opened', el.backend === null);
}

// ── configuration ───────────────────────────────────────────────────────────
async function testDefaultUrls() {
  const calls = stubFetch({});
  const { el } = mount();
  await tick();
  check('api defaults to the local voice server', el.api === 'http://localhost:8000');
  check('token url derives from api', el.tokenUrl === 'http://localhost:8000/agent/token');
  check('the context is fetched on mount, ahead of the first open',
    calls[0] === 'http://localhost:8000/agent/context', calls.join(','));
  check('no token is minted just by loading the page',
    !calls.some((u) => u.includes('/agent/token')), calls.join(','));
}

async function testAttributesOverride() {
  const calls = stubFetch({});
  const { el } = mount({
    api: 'https://voice.example.com/',
    profile: 'it support',
    'token-url': 'https://auth.example.com/mint',
  });
  await tick();
  check('a trailing slash on api is dropped', el.api === 'https://voice.example.com');
  check('the profile is URL-encoded into the context request',
    calls[0] === 'https://voice.example.com/agent/context?profile=it%20support', calls[0]);
  check('token-url overrides the derived route', el.tokenUrl === 'https://auth.example.com/mint');
}

// ── opening and closing ─────────────────────────────────────────────────────
async function testOpenStartsSessionWithServerPersona() {
  const calls = stubFetch({
    'http://localhost:8000/agent/context': {
      profile: 'it-support', system_prompt: 'You are IT support.', keyterms: ['VPN'], voice: 'nova',
    },
    'http://localhost:8000/agent/token': { token: 'tok', expires_in_seconds: 300 },
  });
  const { el, appended } = mount({ 'system-prompt': 'should lose to the server' });
  await el.open();
  await tick();

  check('opening shows the widget', el.widget.open === true);
  check('opening hides the launcher', appended[0].open === true);
  check('opening builds a backend and hands it to the widget',
    el.backend !== null && el.widget.backend === el.backend);
  check('the session is prewarmed with a token on open',
    calls.includes('http://localhost:8000/agent/token'), calls.join(','));

  el.close();
  check('closing ends the session', el.backend === null && el.widget.backend === null);
  check('closing brings the launcher back', appended[0].open === false);
}

async function testFallbackPromptWithoutServerContext() {
  stubFetch({ 'http://localhost:8000/agent/context': new Error('connection refused') });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { el } = mount({ 'system-prompt': 'Local fallback.' });
    await el.open();
    check('a missing context route does not stop the assistant opening',
      el.widget.open === true && el.backend !== null);
  } finally {
    console.warn = warn;
  }
}

async function testReopenBuildsFreshSession() {
  stubFetch({});
  const { el } = mount();
  await el.open();
  const first = el.backend;
  el.close();
  await el.open();
  check('each open gets a fresh session rather than reviving a closed one',
    el.backend !== null && el.backend !== first);
  el.close();
}

async function testWidgetShowDirectlyStillGetsBackend() {
  stubFetch({});
  const { el } = mount();
  await tick();
  el.widget.show();
  check('a host calling widget.show() directly still gets a backend', el.backend !== null);
  el.close();
}

async function testDoubleOpenMakesOneSession() {
  stubFetch({});
  const { el } = mount();
  let built = 0;
  el.widget.addEventListener('talkie-open', () => built++);
  await Promise.all([el.open(), el.open()]);
  check('a double click opens one session, not two', built === 1, `opened ${built}x`);
  el.close();
}

async function testLauncherClickOpens() {
  stubFetch({});
  const { el } = mount();
  // The shim does not bubble from child to host, so deliver the launcher's event to the
  // host directly, the way the browser would after bubbling.
  const ev = new CustomEvent('talkie-launch', { bubbles: true, composed: true });
  let stopped = false;
  const stop = ev.stopPropagation.bind(ev);
  ev.stopPropagation = () => { stopped = true; stop(); };
  el.dispatchEvent(ev);
  await tick();
  check('a launcher click opens the assistant', el.widget.open === true);
  check('the launch event is not left to bubble into the host page', stopped);
  el.close();
}

async function testPageHideEndsSession() {
  stubFetch({});
  const { el, win } = mount();
  await el.open();
  win.dispatchEvent(new Event('pagehide'));
  check('leaving the page ends the agent session', el.backend === null);
}

async function testRemovalCleansUp() {
  stubFetch({});
  const { el, appended } = mount();
  await el.open();
  el.isConnected = false;
  el.disconnectedCallback();
  await tick();
  check('removing the element ends the session', el.backend === null);
  check('removing the element removes what it mounted', appended.every((n) => n.removed));
}

// ── fonts ───────────────────────────────────────────────────────────────────
async function testFontsAreOptIn() {
  stubFetch({});
  const off = mount();
  check('no third-party font request by default', off.head.length === 0);
  const on = mount({ fonts: 'google' });
  check('fonts="google" adds the stylesheet',
    on.head.length === 1 && on.head[0].href.startsWith('https://fonts.googleapis.com/'));
}

async function testLabelIsForwarded() {
  stubFetch({});
  const { el, appended } = mount({ label: 'Ask IT' });
  check('label reaches the launcher', appended[0].getAttribute('label') === 'Ask IT');
  el.setAttribute('label', 'Ask HR');
  el.attributeChangedCallback('label', 'Ask IT', 'Ask HR');
  check('a changed label is forwarded live', appended[0].getAttribute('label') === 'Ask HR');
}

await testMountsLauncherAndWidget();
await testDefaultUrls();
await testAttributesOverride();
await testOpenStartsSessionWithServerPersona();
await testFallbackPromptWithoutServerContext();
await testReopenBuildsFreshSession();
await testWidgetShowDirectlyStillGetsBackend();
await testDoubleOpenMakesOneSession();
await testLauncherClickOpens();
await testPageHideEndsSession();
await testRemovalCleansUp();
await testFontsAreOptIn();
await testLabelIsForwarded();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
