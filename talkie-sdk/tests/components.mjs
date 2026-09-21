#!/usr/bin/env node
/**
 * Smoke tests for Lit web components — catches registration failures
 * and stylesheet build errors (e.g. a stray backtick in a `css`` template).
 *
 * Runs in Node with zero additional dependencies; uses @lit-labs/ssr-dom-shim
 * (a transitive dependency of Lit already available in node_modules).
 */

// ── Install DOM globals BEFORE any component import ────────────────────
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

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

// ── Tag names and their src/define import paths ─────────────────────────
const TAGS = [
  ['talkie-widget',    '../src/define/talkie-widget.js'],
  ['talkie-launcher',  '../src/define/talkie-launcher.js'],
  ['talkie-transcript','../src/define/talkie-transcript.js'],
  ['talkie-waveform',  '../src/define/talkie-waveform.js'],
];

// ── Per-tag smoke checks ───────────────────────────────────────────────
for (const [tag, importPath] of TAGS) {
  // 1. Dynamic import (must be await, not static import) inside try/catch
  // so one broken component does not abort the entire run.
  try {
    await import(importPath);
  } catch (e) {
    check(`${tag} imports without throwing`, false, String(e.message || e));
    continue; // next tag
  }

  // 2. Custom element must be registered.
  const registered = customElements.get(tag);
  check(`${tag} registers on customElements`, typeof registered === 'function');

  if (typeof registered !== 'function') {
    // Can't proceed without a constructor.
    continue;
  }

  // 3. Constructor has truthy static styles (getter evaluates the css`` template).
  // Accept either a single CSSResult or an array of them.
  let stylesOK = false;
  try {
    const s = registered.styles;
    if (Array.isArray(s)) {
      stylesOK = s.length > 0 && s.every(x => x != null);
    } else {
      stylesOK = s != null;
    }
  } catch (e) {
    check(`${tag} styles getter does not throw`, false, String(e.message || e));
  }
  check(`${tag} has truthy styles`, stylesOK);

  // 4. Construct an instance (catches constructor-time errors).
  let constructOK = false;
  try {
    new registered();
    constructOK = true;
  } catch (e) {
    check(`${tag} construction succeeds`, false, String(e.message || e));
  }
  check(`${tag} can be constructed`, constructOK);
}

// ── Layout-regression guards on talkie-widget ──────────────────────────
// These verify that card padding lives on .view-wrapper (shadow-DOM scoped),
// NOT on :host — an outer-document reset like *{padding:0} would override
// :host rules and flatten the card.
(function checkPaddingLocation() {
  const WidgetCtor = customElements.get('talkie-widget');
  if (typeof WidgetCtor !== 'function') {
    check('layout guard: talkie-widget registered', false, 'component not registered');
    return;
  }

  // Build CSS text from static styles (may be single CSSResult or array).
  let rawCssText = '';
  try {
    const s = WidgetCtor.styles;
    if (Array.isArray(s)) {
      rawCssText = s
        .map(x => (typeof x === 'object' && x != null) ? x.cssText ?? '' : String(x))
        .join('\n');
    } else if (s != null) {
      rawCssText = typeof s.cssText === 'string' ? s.cssText : String(s);
    }
  } catch (e) {
    check('layout guard: read styles ok', false, String(e.message || e));
    return;
  }

  // Strip CSS comments before matching — explanatory comments inside the
  // :host block produce false positives otherwise.
  const css = rawCssText.replace(/\/\*[\s\S]*?\*\//g, '');

  check(
    'layout guard: .view-wrapper has padding',
    /\.view-wrapper\s*\{[^}]*padding\s*:/.test(css),
    '.view-wrapper missing padding declaration',
  );

  check(
    'layout guard: :host does NOT have padding',
    !/:host\s*\{[^}]*padding\s*:/.test(css),
    ':host should not carry padding',
  );
  // LionButton slots its children into its own shadow flex box, so a `gap` on the button
  // never reaches the icon — it rendered flush against the label. The icon carries the space.
  check(
    'layout guard: the Start icon carries its own spacing',
    /\.btn-primary svg\s*\{[^}]*margin-right\s*:/.test(css),
    '.btn-primary svg missing margin-right',
  );
  check(
    'layout guard: the Stop square carries its own spacing',
    /\.btn-stop \.sq\s*\{[^}]*margin-right\s*:/.test(css),
    '.btn-stop .sq missing margin-right',
  );
  // The footer hint is a sentence; tracked monospace spread it out letter by letter.
  const hintRule = css.match(/\.hintline\s*\{([^}]*)\}/)?.[1] ?? '';
  check('layout guard: the footer hint has no letter-spacing',
    hintRule !== '' && !/letter-spacing\s*:/.test(hintRule), hintRule.trim());
  check('layout guard: the footer hint is not monospace',
    hintRule !== '' && !/monospace|font-mono/.test(hintRule), hintRule.trim());
})();

// ── Ask another goes straight into the next recording ───────────────────
await (async function checkAskAnotherRecords() {
  const WidgetCtor = customElements.get('talkie-widget');
  if (typeof WidgetCtor !== 'function') return;

  const w = new WidgetCtor();
  const states = [];
  w.addEventListener('talkie-state-change', (e) => states.push(e.detail.to));
  let captures = 0;
  w.backend = {
    startCapture: async () => { captures++; },
    stopCapture: async () => 'first question',
    async *ask() { yield 'Short answer.'; },
    // Never settles: the button is on screen while the answer is still playing.
    speak: () => new Promise(() => {}),
  };

  w.startListening('test');
  w.releaseListening('test');
  for (let i = 0; i < 60 && !states.includes('speaking'); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  check('ask-another: the first turn reaches speaking', states.includes('speaking'),
    states.join(' > '));

  const before = states.length;
  w._onAskAnotherClick();
  await new Promise((r) => setTimeout(r, 20));
  const after = states.slice(before);
  check('ask-another: goes straight to listening, not back to the Start screen',
    after[after.length - 1] === 'listening', after.join(' > '));
  check('ask-another: reopens the mic for the new question', captures === 2,
    `startCapture called ${captures}x`);
})();

// ── Streaming audio: speak when the voice starts, not when the text arrives ──
await (async function checkSpeaksOnFirstAudio() {
  const WidgetCtor = customElements.get('talkie-widget');
  if (typeof WidgetCtor !== 'function') return;

  const w = new WidgetCtor();
  const states = [];
  w.addEventListener('talkie-state-change', (e) => states.push(e.detail.to));

  // Audio starts at once; the text only comes when the whole reply has been spoken.
  let releaseText;
  const textArrives = new Promise((r) => { releaseText = r; });
  w.backend = {
    startCapture: async () => {},
    stopCapture: async () => 'How much is it?',
    speechStarted: async () => {},
    async *ask() { await textArrives; yield 'The price is available on request.'; },
    speak: () => new Promise(() => {}),
  };

  w.startListening('test');
  w.releaseListening('test');
  for (let i = 0; i < 60 && !states.includes('speaking'); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  check('streaming audio: the widget moves to speaking when the voice starts',
    states.includes('speaking'), states.join(' > '));
  check('streaming audio: ...before any reply text exists', w._rp === '', JSON.stringify(w._rp));

  releaseText();
  await new Promise((r) => setTimeout(r, 20));
  check('streaming audio: speaking is entered once, not again when the text lands',
    states.filter((s) => s === 'speaking').length === 1, states.join(' > '));
  check('streaming audio: the late text is shown whole, not paced out behind the voice',
    w._shown === 6 && w._rp === 'The price is available on request.', `shown ${w._shown}: ${w._rp}`);
})();

// A backend without speechStarted keeps the old behaviour: speak when the text arrives.
await (async function checkTextFirstBackendUnchanged() {
  const WidgetCtor = customElements.get('talkie-widget');
  if (typeof WidgetCtor !== 'function') return;

  const w = new WidgetCtor();
  const states = [];
  w.addEventListener('talkie-state-change', (e) => states.push(e.detail.to));
  let releaseText;
  const textArrives = new Promise((r) => { releaseText = r; });
  w.backend = {
    startCapture: async () => {},
    stopCapture: async () => 'Hi',
    async *ask() { await textArrives; yield 'Hello there, friend.'; },
    speak: () => new Promise(() => {}),
  };
  w.startListening('test');
  w.releaseListening('test');
  for (let i = 0; i < 60 && !states.includes('thinking'); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 50));
  check('text-first backend: stays thinking until the text arrives', !states.includes('speaking'),
    states.join(' > '));
  releaseText();
  await new Promise((r) => setTimeout(r, 20));
  check('text-first backend: speaks on the text', states.includes('speaking'), states.join(' > '));
  check('text-first backend: still reveals word by word', w._shown < 3, `shown ${w._shown}`);
  w.hide?.('test done');
})();

// Word-by-word text alongside the voice.
await (async function checkWordsStreamIn() {
  const WidgetCtor = customElements.get('talkie-widget');
  if (typeof WidgetCtor !== 'function') return;

  const w = new WidgetCtor();
  const states = [];
  w.addEventListener('talkie-state-change', (e) => states.push(e.detail.to));
  const gate = [];
  const next = () => new Promise((r) => gate.push(r));
  w.backend = {
    startCapture: async () => {},
    stopCapture: async () => 'Tell me',
    speechStarted: () => next(),
    async *ask() { for (const word of ['The', 'price', 'is', 'on', 'request.']) { await next(); yield word; } },
    speak: () => new Promise(() => {}),
  };
  const release = async () => { gate.shift()?.(); await new Promise((r) => setTimeout(r, 10)); };

  w.startListening('test');
  w.releaseListening('test');
  for (let i = 0; i < 60 && gate.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  check('word stream: still thinking until the voice starts', states.at(-1) === 'thinking', states.join(' > '));
  await release();                      // the voice starts
  check('word stream: speaking once the voice starts', states.at(-1) === 'speaking', states.join(' > '));
  await release();
  await release();
  check('word stream: the answer grows a word at a time', w._rp === 'The price', JSON.stringify(w._rp));
  check('word stream: Stop stays available while the voice is still going', w._shown === 2);
  await release(); await release(); await release();
  await new Promise((r) => setTimeout(r, 20));
  check('word stream: the full answer is shown by the end', w._rp === 'The price is on request.', JSON.stringify(w._rp));
})();

console.log(`\n${passed}/${passed + failed} tests passed`);
process.exit(failed > 0 ? 1 : 0);
