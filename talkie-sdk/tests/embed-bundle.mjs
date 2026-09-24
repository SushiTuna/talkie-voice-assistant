#!/usr/bin/env node
/**
 * Build dist/talkie-embed.js and prove it boots on its own.
 *
 * The unit tests import from src/, which says nothing about the file a host page actually
 * loads. This runs the real build, then evaluates the bundle as a classic script — the way
 * `<script src>` would — with no module loader and nothing from node_modules in reach.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as shim from '@lit-labs/ssr-dom-shim';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

execFileSync(process.execPath, [join(ROOT, 'build.mjs')], { stdio: 'inherit' });
const source = readFileSync(join(ROOT, 'dist', 'talkie-embed.js'), 'utf8');

check('the bundle has no bare imports left for a browser to choke on',
  !/\bimport\s*[\s{*'"]|\brequire\(/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')));
check('the bundle does not depend on import.meta, which a classic script lacks',
  !source.includes('import.meta'));

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

let bootError = null;
try {
  (0, eval)(source); // indirect eval: global scope, like a classic <script>
} catch (err) {
  bootError = err;
}
check('the bundle evaluates as a classic script', bootError === null, String(bootError));

for (const tag of ['talkie-assistant', 'talkie-widget', 'talkie-launcher', 'talkie-transcript', 'talkie-waveform']) {
  check(`the bundle registers <${tag}>`, typeof customElements.get(tag) === 'function');
}
check('window.Talkie exposes the backend for hand-wired widgets',
  typeof globalThis.Talkie?.VoiceAgentBackend === 'function');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
