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

/* ------------------------------------------------------------------- /voice proxy */

{
  // A fake voice server: records each call and echoes it back.
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, ...init });
    return new Response(JSON.stringify({ url, method: init.method }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'x=1' },
    });
  };
  const voiceApp = (trustProxy = '') => createApp({ voiceApi: 'http://voice:8000/', trustProxy, fetch: fakeFetch });
  const proxy = voiceApp();

  for (const [path, method] of [
    ['/voice/agent/context?profile=property', 'GET'],
    ['/voice/agent/token', 'GET'],
    ['/voice/agent/profiles', 'GET'],
    ['/voice/agent/voices', 'GET'],
  ]) {
    calls.length = 0;
    const r = await proxy.request(path, { method });
    const target = `http://voice:8000${path.slice('/voice'.length)}`;
    check(`${method} ${path} is forwarded to the voice server`,
      r.status === 200 && calls[0]?.url === target && calls[0]?.method === method, `${r.status} ${calls[0]?.url}`);
    check(`...not cached, and no upstream cookie`,
      r.headers.get('cache-control') === 'no-store' && !r.headers.get('set-cookie'), describe(r));
  }

  calls.length = 0;
  let r = await proxy.request('/voice/agent/session', {
    method: 'POST', body: '{"verification":"tok"}', headers: { Authorization: 'Bearer v1.t.s', 'Content-Type': 'application/json' },
  });
  check('POST /voice/agent/session forwards its body and the visitor ticket',
    r.status === 200 && calls[0]?.body === '{"verification":"tok"}' && calls[0]?.headers.Authorization === 'Bearer v1.t.s'
      && calls[0]?.headers['Content-Type'] === 'application/json', JSON.stringify(calls[0]));
  r = await proxy.request('/voice/agent/session', { method: 'POST', body: 'x'.repeat(20 * 1024) });
  check('an oversized session body is refused (413)', r.status === 413, describe(r));

  // The console's "Send to server": forwarded with the admin token; the voice server checks it.
  calls.length = 0;
  const profile = JSON.stringify({ agent: { role: 'x' }, greeting: 'hi' });
  r = await proxy.request('/voice/agent/profiles/property?overwrite=true', {
    method: 'PUT', body: profile, headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
  });
  check('PUT /voice/agent/profiles/{name} is forwarded with its query, body and admin token',
    r.status === 200 && calls[0]?.url === 'http://voice:8000/agent/profiles/property?overwrite=true'
      && calls[0]?.method === 'PUT' && calls[0]?.body === profile && calls[0]?.headers.Authorization === 'Bearer admin',
    JSON.stringify(calls[0]));
  calls.length = 0;
  r = await proxy.request('/voice/agent/profiles/property', { method: 'PUT', body: 'x'.repeat(40 * 1024) });
  check('a profile up to 64 KiB is forwarded', r.status === 200 && calls.length === 1, describe(r));
  r = await proxy.request('/voice/agent/profiles/property', { method: 'PUT', body: 'x'.repeat(65 * 1024) });
  check('a profile over 64 KiB is refused (413)', r.status === 413 && calls.length === 1, describe(r));
  calls.length = 0;
  for (const path of ['/voice/agent/profiles/a/b', '/voice/agent/profiles/.hidden', '/voice/agent/profiles/%2e%2e']) {
    r = await proxy.request(path, { method: 'PUT', body: '{}' });
    check(`PUT ${path} is not forwarded`, r.status === 404 && calls.length === 0, describe(r));
  }
  r = await proxy.request('/voice/agent/profiles/property', { method: 'DELETE' });
  check('a profile route answers 405 to anything but PUT', r.status === 405 && r.headers.get('allow') === 'PUT' && calls.length === 0, describe(r));
  r = await proxy.request('/voice/agent/token', { method: 'POST' });
  check('a route answers 405 to the wrong method', r.status === 405 && r.headers.get('allow') === 'GET' && calls.length === 0, describe(r));
  r = await proxy.request('/voice/health');
  check('a route not on the list is 404', r.status === 404 && calls.length === 0, describe(r));

  calls.length = 0;
  await proxy.request('/voice/agent/token', { headers: { 'X-Forwarded-For': '6.6.6.6', 'CF-Connecting-IP': '7.7.7.7' } });
  check('without TRUST_PROXY a visitor cannot choose their address', !['6.6.6.6', '7.7.7.7'].includes(calls[0]?.headers['X-Forwarded-For']),
    calls[0]?.headers['X-Forwarded-For']);
  calls.length = 0;
  await voiceApp('cloudflare').request('/voice/agent/token', { headers: { 'X-Forwarded-For': '6.6.6.6', 'CF-Connecting-IP': '7.7.7.7' } });
  check('with TRUST_PROXY=cloudflare the visitor is CF-Connecting-IP', calls[0]?.headers['X-Forwarded-For'] === '7.7.7.7',
    calls[0]?.headers['X-Forwarded-For']);
  calls.length = 0;
  await voiceApp('1').request('/voice/agent/token', { headers: { 'X-Forwarded-For': '6.6.6.6, 8.8.8.8' } });
  check('with TRUST_PROXY=1 the visitor is the last X-Forwarded-For entry', calls[0]?.headers['X-Forwarded-For'] === '8.8.8.8',
    calls[0]?.headers['X-Forwarded-For']);

  const down = createApp({ fetch: async () => { throw new Error('ECONNREFUSED'); } });
  r = await down.request('/voice/agent/token');
  check('an unreachable voice server is a 502', r.status === 502, describe(r));
}

/* ------------------------------------------------------------------- listening */

const source = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
check('the server listens on 127.0.0.1 unless HOST says otherwise',
  /hostname = process\.env\.HOST \|\| '127\.0\.0\.1'/.test(source));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
