#!/usr/bin/env node
/**
 * Dev server for the Talkie Voice UI site, demo and example, on Hono.
 *
 * Routing:
 *   /                          → 302 /site/
 *   /playground, /console, /docs → 302 /site/<page>  (short links; redirected, not rewritten,
 *                                 because the pages load `src/…` and `dist/…` relative to /site/)
 *   /site/playground           → site/playground.html  (clean URL)
 *   /site/playground.html      → 301 /site/playground   (one address per page; the #hash survives)
 *   /site                      → 301 /site/             (a folder needs its slash, or the page's
 *                                 relative assets resolve against / and 404)
 *   /demo-bundle.js            → the demo, bundled with esbuild at startup
 *   /voice/agent/…             → the voice server at VOICE_API (default http://127.0.0.1:8000),
 *                                only the routes in voiceRoute(). A public site reaches the voice
 *                                server this way: same origin, no CORS, and the voice server
 *                                itself stays private. Saving a profile is forwarded; the voice
 *                                server refuses it without TALKIE_PROFILE_ADMIN_TOKEN.
 *
 * Only PUBLIC paths are served: the pages, their built bundles and the markdown the Docs page
 * fetches. Everything else, and any dotfile (.tmp/ holds server logs), is a 404. Hono's
 * serveStatic rejects `..` but not dotfiles, so the check is here.
 *
 * Usage:
 *   npm start                     → http://localhost:8081
 *   PORT=3000 npm start           → http://localhost:3000
 *   HOST=0.0.0.0 npm start        → also reachable from other machines (off by default)
 *   VOICE_API=http://voice:8000   → where /voice/* goes
 *   TRUST_PROXY=cloudflare        → the visitor is CF-Connecting-IP (only behind a Cloudflare
 *                                   Tunnel that is the one way in); TRUST_PROXY=1 → the last
 *                                   X-Forwarded-For entry (one load balancer in front)
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ----------------------------------------------------------------- config */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

/** Path prefixes a browser may fetch. Directories end in '/'. */
export const PUBLIC = ['/site/', '/demo/', '/examples/', '/dist/', '/docs/', '/README.md'];

/** Short top-level links to the site's pages. */
const SHORT_LINKS = { '/playground': '/site/playground', '/console': '/site/console', '/docs': '/site/docs' };

/**
 * Voice server routes forwarded under /voice, with the one method each allows. What the site's
 * pages call: the assistant (context, token, visitor tickets), and the playground and console
 * (profiles, voices).
 */
export const VOICE_ROUTES = new Map([
  ['/agent/context', 'GET'],
  ['/agent/token', 'GET'],
  ['/agent/session', 'POST'],
  ['/agent/profiles', 'GET'],
  ['/agent/voices', 'GET'],
]);
const VOICE_BODY_MAX = 10 * 1024;

// The console's "Send to server": PUT /agent/profiles/{name}[?overwrite=true]. The voice server
// accepts it only with `Authorization: Bearer <TALKIE_PROFILE_ADMIN_TOKEN>` (off when unset),
// checks the name, and caps the body at 64 KiB; the name shape here only keeps other paths out.
const PROFILE_WRITE = /^\/agent\/profiles\/[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PROFILE_BODY_MAX = 64 * 1024;

/** The method and body limit of a forwarded route, or null when it is not forwarded. */
function voiceRoute(route) {
  if (VOICE_ROUTES.has(route)) return { method: VOICE_ROUTES.get(route), maxBody: VOICE_BODY_MAX };
  if (PROFILE_WRITE.test(route)) return { method: 'PUT', maxBody: PROFILE_BODY_MAX };
  return null;
}

const isPublic = (path) => PUBLIC.some((p) => (p.endsWith('/') ? path.startsWith(p) || path === p.slice(0, -1) : path === p));
const hasDotSegment = (path) => path.split('/').some((seg) => seg.startsWith('.'));

function kind(file) {
  try {
    const st = statSync(file);
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- bundler */

/** Bundle demo/demo.js once. Returns the bytes, or null when esbuild fails. */
async function buildDemoBundle(root) {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [join(root, 'demo', 'demo.js')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: false, // keep readable for debugging
    sourcemap: 'inline',
    write: false,
    outfile: join(root, '.tmp', 'demo-bundle.js'),
    logLevel: 'warning',
  });
  const data = result.outputFiles[0].contents;
  console.log(`[bundled] demo-bundle.js (${data.length} bytes)`);
  return data;
}

/* ----------------------------------------------------------------- voice proxy */

/**
 * The visitor's address, as this server can vouch for it.
 * https://developers.cloudflare.com/fundamentals/reference/http-headers/
 */
function clientAddress(c, trustProxy) {
  if (trustProxy === 'cloudflare') {
    const ip = (c.req.header('cf-connecting-ip') || '').trim();
    if (ip) return ip;
  } else if (trustProxy === '1') {
    const last = (c.req.header('x-forwarded-for') || '').split(',').pop().trim();
    if (last) return last;
  }
  // @hono/node-server passes the Node request as c.env.incoming; app.request() in tests has none.
  return c.env?.incoming?.socket?.remoteAddress || '';
}

/** Forward one allow-listed /voice/* request to the voice server. */
async function proxyVoice(c, { voiceApi, trustProxy, fetch: doFetch }) {
  const route = c.req.path.slice('/voice'.length);
  const { method, maxBody } = voiceRoute(route) ?? {};
  if (!method) return c.json({ detail: 'Not found' }, 404);
  if (c.req.method !== method) return c.json({ detail: 'Method not allowed' }, 405, { Allow: method });

  // The voice server limits tokens per address, and trusts X-Forwarded-For only from this
  // proxy (uvicorn --forwarded-allow-ips). Replace, never append, so a visitor cannot plant one.
  const headers = { 'X-Forwarded-For': clientAddress(c, trustProxy) };
  const auth = c.req.header('authorization');
  if (auth) headers.Authorization = auth; // visitor ticket, or the admin token on a profile save
  let body;
  if (method !== 'GET') {
    body = await c.req.text();
    if (Buffer.byteLength(body) > maxBody) return c.json({ detail: 'Body too large.' }, 413);
    headers['Content-Type'] = 'application/json';
  }

  let upstream;
  try {
    upstream = await doFetch(voiceApi + route + new URL(c.req.url).search, { method, headers, body });
  } catch {
    return c.json({ detail: `Voice server unreachable at ${voiceApi}` }, 502);
  }
  return c.body(await upstream.arrayBuffer(), upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
  });
}

/* ----------------------------------------------------------------- app */

/**
 * The routes, without a listening socket, so tests can call `app.request(path)`.
 *
 * @param {{ root?: string, demoBundle?: Uint8Array | null, voiceApi?: string,
 *   trustProxy?: string, fetch?: typeof fetch }} [options]
 */
export function createApp({
  root = ROOT,
  demoBundle = null,
  voiceApi = 'http://127.0.0.1:8000',
  trustProxy = '',
  fetch: doFetch = globalThis.fetch,
} = {}) {
  const app = new Hono();
  voiceApi = voiceApi.replace(/\/+$/, '');

  app.use('*', async (c, next) => {
    await next();
    // Tokens and tickets are per visitor: never cache a /voice answer.
    if (c.req.path.startsWith('/voice/')) {
      c.header('Cache-Control', 'no-store');
      return;
    }
    // Dev server: always revalidate, so an edited file shows on the next reload.
    c.header('Cache-Control', 'no-cache');
    // Hono's MIME table has no .md, which the Docs page fetches. Set here, after the response
    // exists: serveStatic's onFound hook runs too late for a header to stick.
    if (c.req.path.endsWith('.md') && c.res.status === 200) c.header('Content-Type', 'text/markdown; charset=utf-8');
  });

  app.all('/voice/*', (c) => proxyVoice(c, { voiceApi, trustProxy, fetch: doFetch }));

  app.get('/', (c) => c.redirect('/site/', 302));
  for (const [from, to] of Object.entries(SHORT_LINKS)) app.get(from, (c) => c.redirect(to, 302));

  app.get('/demo-bundle.js', (c) => {
    if (!demoBundle) return c.text('Demo bundle failed to build; see the server log.', 503);
    return c.body(demoBundle, 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  });

  // Keep the query string on every redirect.
  const redirectKeepingQuery = (c, path) => c.redirect(path + new URL(c.req.url).search, 301);

  app.get('*', async (c, next) => {
    const path = c.req.path;
    if (hasDotSegment(path) || !isPublic(path)) return c.text('Not found', 404);

    // /site/playground.html → /site/playground; /site/index.html → /site/
    if (path.endsWith('.html')) {
      const clean = path.endsWith('/index.html') ? path.slice(0, -'index.html'.length) : path.slice(0, -'.html'.length);
      return redirectKeepingQuery(c, clean);
    }

    const file = join(root, path);
    if (relative(root, file).startsWith('..')) return c.text('Not found', 404);
    if (!path.endsWith('/') && kind(file) === 'dir') return redirectKeepingQuery(c, `${path}/`);
    return next();
  });

  app.use('*', serveStatic({
    root,
    // Clean URLs: an extensionless path that is not a file is its .html page.
    rewriteRequestPath: (path) => (path.endsWith('/') || kind(join(root, path)) ? path : `${path}.html`),
  }));

  app.notFound((c) => c.text('Not found', 404));
  return app;
}

/* ----------------------------------------------------------------- boot */

async function main() {
  const port = Number(process.env.PORT || 8081);
  const hostname = process.env.HOST || '127.0.0.1';
  let demoBundle = null;
  try {
    demoBundle = await buildDemoBundle(ROOT);
  } catch (err) {
    console.error('[bundle] failed — /demo-bundle.js will answer 503:', err.message);
  }
  const app = createApp({
    demoBundle,
    voiceApi: process.env.VOICE_API || undefined,
    trustProxy: process.env.TRUST_PROXY || '',
  });
  serve({ fetch: app.fetch, port, hostname }, () => {
    console.log(`Talkie Voice UI -> http://localhost:${port}/  (site; demo at /demo/)`);
  });
}

// Run only as a script, so tests can import createApp without opening a port.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
