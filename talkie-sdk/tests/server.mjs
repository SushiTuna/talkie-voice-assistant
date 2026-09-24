/**
 * Tests for the dev server's routes (server.mjs), through Hono's app.request — no port opened.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

const app = createApp({ demoBundle: new TextEncoder().encode('// demo bundle') });
const get = (path) => app.request(path);
const describe = (r) => `${r.status} ${r.headers.get('location') ?? ''} ${r.headers.get('content-type') ?? ''}`.trim();

/* ------------------------------------------------------------------- redirects */

for (const [from, to, status] of [
  ['/', '/site/', 302],
  ['/playground', '/site/playground', 302],
  ['/console', '/site/console', 302],
  ['/docs', '/site/docs', 302],
  ['/site/playground.html', '/site/playground', 301],
  ['/site/index.html', '/site/', 301],
  ['/demo/index.html', '/demo/', 301],
  ['/site', '/site/', 301],
]) {
  const r = await get(from);
  check(`${from} redirects (${status}) to ${to}`, r.status === status && r.headers.get('location') === to, describe(r));
}
{
  const r = await get('/site/playground.html?profile=tour');
  check('a .html redirect keeps the query string',
    r.headers.get('location') === '/site/playground?profile=tour', describe(r));
}

/* ------------------------------------------------------------------- clean URLs and assets */

for (const [path, type] of [
  ['/site/', 'text/html'],
  ['/site/playground', 'text/html'],
  ['/site/console', 'text/html'],
  ['/site/docs', 'text/html'],
  ['/demo/', 'text/html'],
  ['/examples/embed', 'text/html'],
  ['/site/src/theme.css', 'text/css'],
  ['/README.md', 'text/markdown'],
  ['/docs/integration.md', 'text/markdown'],
  ['/demo-bundle.js', 'text/javascript'],
]) {
  const r = await get(path);
  check(`${path} is served as ${type}`, r.status === 200 && r.headers.get('content-type')?.startsWith(type), describe(r));
}
{
  const r = await get('/site/playground');
  const body = await r.text();
  check('the clean URL serves the page itself', body.includes('<title>Talkie — Playground</title>'));
  check('responses always revalidate (no-cache)', r.headers.get('cache-control') === 'no-cache', r.headers.get('cache-control'));
}
{
  const r = await createApp({ demoBundle: null }).request('/demo-bundle.js');
  check('a failed demo bundle answers 503, not a stale file', r.status === 503, describe(r));
}

/* ------------------------------------------------------------------- what is not served */

for (const path of [
  '/.tmp/voice-server.log', '/site/.hidden', '/.git/config',
  '/AGENTS.md', '/SPEC.md', '/package.json', '/server.mjs', '/tests/server.mjs',
  '/src/index.js', '/node_modules/lit/index.js',
  '/site/../AGENTS.md', '/site/%2e%2e/AGENTS.md', '/site/%2e%2e%2fAGENTS.md',
  '/site/nope',
]) {
  const r = await get(path);
  check(`${path} is not served`, r.status === 404, describe(r));
}

/* ------------------------------------------------------------------- the site's own links */

// Every page link the site renders must land on a page, with no redirect in between.
const shell = readFileSync(join(ROOT, 'site', 'src', 'shell.js'), 'utf8');
const home = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
const links = new Set([
  ...[...shell.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]),
  ...[...shell.matchAll(/brand\.href = '([^']+)'/g)].map((m) => m[1]),
  ...[...home.matchAll(/href="(\/site\/[^"#]*)/g)].map((m) => m[1]),
]);
check('found the site nav and home page links', links.size >= 4, [...links].join(' '));
for (const link of links) {
  const r = await get(link);
  check(`site link ${link} is a page, not a redirect`, r.status === 200, describe(r));
}

/* ------------------------------------------------------------------- listening */

const source = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
check('the server listens on 127.0.0.1 unless HOST says otherwise',
  /hostname = process\.env\.HOST \|\| '127\.0\.0\.1'/.test(source));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
