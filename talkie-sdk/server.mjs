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
 *
 * Only PUBLIC paths are served: the pages, their built bundles and the markdown the Docs page
 * fetches. Everything else, and any dotfile (.tmp/ holds server logs), is a 404. Hono's
 * serveStatic rejects `..` but not dotfiles, so the check is here.
 *
 * Usage:
 *   npm start                     → http://localhost:8081
 *   PORT=3000 npm start           → http://localhost:3000
 *   HOST=0.0.0.0 npm start        → also reachable from other machines (off by default)
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

/* ----------------------------------------------------------------- app */

/**
 * The routes, without a listening socket, so tests can call `app.request(path)`.
 *
 * @param {{ root?: string, demoBundle?: Uint8Array | null }} [options]
 */
export function createApp({ root = ROOT, demoBundle = null } = {}) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    // Dev server: always revalidate, so an edited file shows on the next reload.
    c.header('Cache-Control', 'no-cache');
    // Hono's MIME table has no .md, which the Docs page fetches. Set here, after the response
    // exists: serveStatic's onFound hook runs too late for a header to stick.
    if (c.req.path.endsWith('.md') && c.res.status === 200) c.header('Content-Type', 'text/markdown; charset=utf-8');
  });

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
  serve({ fetch: createApp({ demoBundle }).fetch, port, hostname }, () => {
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
