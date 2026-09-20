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
})();

console.log(`\n${passed}/${passed + failed} tests passed`);
process.exit(failed > 0 ? 1 : 0);
