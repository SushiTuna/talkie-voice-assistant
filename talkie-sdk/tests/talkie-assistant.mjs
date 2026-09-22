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
 * `beforeConnect(el)` runs on the bare element first.
 * @returns {{ el: any, appended: any[], head: any[], win: EventTarget }}
 */
function mount(attrs = {}, beforeConnect = null, { phone = false } = {}) {
  const Ctor = customElements.get('talkie-assistant');
  const el = new Ctor();
  beforeConnect?.(el);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);

  const appended = [];
  const head = [];
  const win = new EventTarget();
  // Only the sheet query is asked; `phone` answers it.
  win.matchMedia = () => Object.assign(new EventTarget(), { matches: phone });
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


// ── tools ───────────────────────────────────────────────────────────────────
/** Open `el` and capture the options its backend was built with. */
async function openCapturing(el) {
  let options = null;
  const build = el._createBackend.bind(el);
  el._createBackend = (opts) => { options = opts; return build(opts); };
  await el.open();
  return options;
}

async function testToolsReachTheBackend() {
  stubFetch({});
  const { el } = mount();
  const tools = [{ type: 'function', name: 'go_to_room', parameters: { type: 'object', properties: {} } }];
  el.tools = tools;
  const seen = [];
  el.onToolCall = (call) => { seen.push(call); return { ok: true }; };
  const options = await openCapturing(el);

  check('tools set on the element are passed to the agent session', options?.tools === tools);
  const result = await options.onToolCall({ name: 'go_to_room', arguments: { room: 'kitchen' }, call_id: 'c1' });
  check('a tool call reaches the page\'s handler', seen[0]?.arguments.room === 'kitchen');
  check('the handler\'s value is the tool result', result?.ok === true);

  el.close();
  const { el: bare } = mount();
  const bareOptions = await openCapturing(bare);
  check('no tools are sent when the page sets none', bareOptions.tools === undefined);
  let caught = null;
  try { await bareOptions.onToolCall({ name: 'x', arguments: {} }); } catch (err) { caught = err; }
  check('a call with no handler fails with a message the agent can read',
    caught?.message.includes('No handler'), String(caught));
  bare.close();
}

async function testToolHandlerIsReadPerCall() {
  stubFetch({});
  const { el } = mount();
  el.onToolCall = () => 'first';
  const options = await openCapturing(el);
  el.onToolCall = () => 'second';
  check('a handler replaced while the panel is open is the one used',
    (await options.onToolCall({ name: 'x', arguments: {} })) === 'second');
  el.close();
}

async function testToolsSetBeforeUpgradeSurvive() {
  stubFetch({});
  const tools = [{ type: 'function', name: 'go_to_room' }];
  const handler = () => 'early';
  // Before the embed bundle defines the element, a page's assignment lands as a plain own
  // property on the unupgraded node. Recreate that state, then connect.
  const { el } = mount({}, (node) => {
    Object.defineProperty(node, 'tools', { value: tools, writable: true, configurable: true, enumerable: true });
    Object.defineProperty(node, 'onToolCall', { value: handler, writable: true, configurable: true, enumerable: true });
  });
  check('properties set before the element was defined are taken over on connect',
    !Object.prototype.hasOwnProperty.call(el, 'tools') && el.tools === tools && el.onToolCall === handler);
  const options = await openCapturing(el);
  check('...and reach the session', options.tools === tools
    && (await options.onToolCall({ name: 'go_to_room', arguments: {} })) === 'early');
  el.close();
}

async function testServerToolsFromContext() {
  const served = [{ type: 'function', name: 'open_door', description: 'Open it.', parameters: { type: 'object', properties: {} } }];
  stubFetch({ 'http://localhost:8000/agent/context': { system_prompt: 'x', greeting: 'Hi', tools: served } });

  const { el } = mount();
  el.onToolCall = () => ({ ok: true });
  await tick();
  const options = await openCapturing(el);
  check('with no page tools, the server profile\'s tools reach the session', options.tools === served);
  el.close();

  const pageTools = [{ type: 'function', name: 'go_to_room', description: 'Go.', parameters: {} }];
  const { el: own } = mount();
  own.tools = pageTools;
  own.onToolCall = () => ({ ok: true });
  await tick();
  const ownOptions = await openCapturing(own);
  check('tools the page sets take precedence over the server\'s', ownOptions.tools === pageTools);
  own.close();

  const warnings = [];
  const quietWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  const { el: unhandled } = mount();
  await tick();
  await openCapturing(unhandled);
  console.warn = quietWarn;
  check('server tools without an onToolCall log a warning naming them',
    warnings.some((w) => w.includes('open_door') && w.includes('onToolCall')), warnings.join(' | '));
  unhandled.close();

  stubFetch({ 'http://localhost:8000/agent/context': { system_prompt: 'x', greeting: 'Hi', tools: [] } });
  const { el: none } = mount();
  await tick();
  const noneOptions = await openCapturing(none);
  check('an empty server tools list sends no tools', noneOptions.tools === undefined);
  none.close();
}

async function testConversationIsTheDefault() {
  stubFetch({
    'http://localhost:8000/agent/context': { system_prompt: 'You are the property assistant.', greeting: 'Hi there!' },
  });
  const { el } = mount();
  await tick();
  const options = await openCapturing(el);
  check('the assistant holds a conversation by default', el.widget.mode === 'conversation');
  check('the idle limit defaults to 60 seconds', el.widget.idleTimeout === 60);
  check('a conversation speaks the server persona\'s greeting', options.greeting === 'Hi there!');
  check('a conversation lets the caller talk over a reply', options.bargeIn === true);
  el.close();
}

async function testPushToTalkAndOptOuts() {
  stubFetch({
    'http://localhost:8000/agent/context': { system_prompt: 'x', greeting: 'Hi there!' },
  });
  const { el } = mount({ mode: 'push-to-talk' });
  await tick();
  const ptt = await openCapturing(el);
  check('mode="push-to-talk" keeps Start / Stop & Send', el.widget.mode === 'push-to-talk');
  check('...without the greeting, which would land mid-recording', ptt.greeting === undefined);
  check('...and without barge-in', ptt.bargeIn === false);
  el.close();

  const { el: quiet } = mount({ 'barge-in': 'off', 'idle-timeout': '0' });
  await tick();
  const q = await openCapturing(quiet);
  check('barge-in="off" turns barge-in off in a conversation', q.bargeIn === false && quiet.widget.mode === 'conversation');
  check('idle-timeout="0" disables the idle limit', quiet.widget.idleTimeout === 0);
  quiet.close();

  const { el: odd } = mount({ 'idle-timeout': 'soon' });
  await openCapturing(odd);
  check('an unreadable idle-timeout falls back to the default', odd.widget.idleTimeout === 60);
  odd.close();
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

// ── minimize ────────────────────────────────────────────────────────────────
async function testMinimizeKeepsTheConversation() {
  stubFetch({ 'http://localhost:8000/agent/token': { token: 'tok', expires_in_seconds: 300 } });
  const { el, appended } = mount();
  const launcher = appended[0];
  await el.open();
  const backend = el.backend;

  el.minimize();
  check('minimizing hides the panel but leaves it open', el.widget.minimized === true && el.widget.open === true);
  check('...and keeps the agent session', el.backend === backend && el.backend !== null);
  check('...and brings the launcher back, showing the live conversation',
    launcher.open === false && launcher.active === true);

  el.widget._onSmChange({ from: 'idle', to: 'speaking' });
  check('the launcher follows the conversation state while minimized', launcher.state === 'speaking');

  el._onLaunch(new CustomEvent('talkie-launch'));
  check('tapping the launcher restores the same conversation',
    el.widget.minimized === false && el.widget.open === true && el.backend === backend);
  check('...and the launcher steps aside again', launcher.open === true && launcher.active === false);

  el.minimize();
  el.close();
  check('closing from minimized ends the session and stops the waves',
    el.backend === null && el.widget.minimized === false && launcher.active === false);
}

// ── layout ──────────────────────────────────────────────────────────────────
async function testSheetLayoutOnPhones() {
  stubFetch({});
  const { el } = mount({}, null, { phone: true });
  check('a phone gets the bottom sheet', el.widget.layout === 'sheet');
  check('...spanning the bottom edge',
    el.widget.style.left === '0' && el.widget.style.right === '0' && el.widget.style.bottom.includes('--talkie-sheet-offset-bottom'),
    JSON.stringify(el.widget.style));

  const { el: forced } = mount({ layout: 'floating' }, null, { phone: true });
  check('layout="floating" keeps the floating panel on a phone',
    forced.widget.layout === undefined && forced.widget.style.bottom === '104px');

  const { el: desk } = mount({ layout: 'sheet' });
  check('layout="sheet" forces the sheet on a wide screen', desk.widget.layout === 'sheet');
}

await testMountsLauncherAndWidget();
await testToolsReachTheBackend();
await testToolHandlerIsReadPerCall();
await testToolsSetBeforeUpgradeSurvive();
await testServerToolsFromContext();
await testConversationIsTheDefault();
await testPushToTalkAndOptOuts();
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
await testMinimizeKeepsTheConversation();
await testSheetLayoutOnPhones();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
