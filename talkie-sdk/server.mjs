#!/usr/bin/env node
/**
 * Zero-dependency HTTP server for the Talkie Voice UI demo.
 *
 * Serves static files from talkie-sdk/ (demo + source). Bundles the demo
 * entry point with esbuild (already a devDependency) before the first
 * request, so the browser gets a single self-contained bundle with all
 * component imports resolved.
 *
 * Usage:
 *   npm start           → http://localhost:8081
 *   PORT=3000 npm start → http://localhost:3000
 */

import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ----------------------------------------------------------------- config */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 8081);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.wasm': 'application/wasm',
};

/* ----------------------------------------------------------------- bundler */

let bundleData = null; // { path, data, etag } or null

async function buildBundle() {
  const esbuild = await import('esbuild');
  const { createHash } = await import('node:crypto');

  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'demo', 'demo.js')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: false, // keep readable for debugging
    sourcemap: 'inline',
    outfile: join(ROOT, '.tmp', 'demo-bundle.js'),
    logLevel: 'warning',
  });

  if (result.outputFiles?.length > 0) {
    const buf = result.outputFiles[0].contents;
    const etag = `"${createHash('sha1').update(buf).digest('base64url').slice(0, 20)}"`;
    bundleData = { path: '/demo-bundle.js', data: buf, etag };
  } else {
    // Fallback: read from outfile
    const data = await readFile(join(ROOT, '.tmp', 'demo-bundle.js'));
    const etag = `"${createHash('sha1').update(data).digest('base64url').slice(0, 20)}"`;
    bundleData = { path: '/demo-bundle.js', data, etag };
  }

  console.log(`[bundled] demo-bundle.js (${bundleData.data.length} bytes)`);
}

/* ----------------------------------------------------------------- helper */

async function serveFile(req, res, filePath) {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });

    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      return res.end();
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      ETag: etag,
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  }
}

/* ----------------------------------------------------------------- server */

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    // Redirect root to demo page
    if (pathname === '/') {
      res.writeHead(302, { Location: '/demo/index.html' });
      return res.end();
    }

    // Serve bundled demo JS
    if (pathname === '/demo-bundle.js' && bundleData) {
      if (req.headers['if-none-match'] === bundleData.etag) {
        res.writeHead(304);
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        ETag: bundleData.etag,
      });
      return res.end(bundleData.data);
    }

    // Serve static files from ROOT (talkie-sdk/)
    const relPath = pathname === '/' ? 'demo/index.html' : pathname.slice(1);
    const filePath = join(ROOT, relPath);

    // Prevent directory traversal
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }

    return await serveFile(req, res, filePath);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  }
});

/* ----------------------------------------------------------------- boot */

async function main() {
  // Build the bundle once on startup
  try {
    await buildBundle();
  } catch (err) {
    console.error('[bundle] failed — components may load unbundled:', err.message);
  }

  server.listen(PORT, () => {
    console.log(`Talkie Voice UI Demo -> http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
