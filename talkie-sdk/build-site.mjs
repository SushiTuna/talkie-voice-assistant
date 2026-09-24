#!/usr/bin/env node
/**
 * Build site pages: one ESM bundle per page into site/dist/.
 *
 * Usage:  node build-site.mjs
 */

import { build } from 'esbuild';
import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUTDIR = join(ROOT, 'site', 'dist');

// Discover entry points under site/src/pages/
const pageDir = join(ROOT, 'site', 'src', 'pages');
const entries = await readdir(pageDir);
const entryPoints = entries
  .filter(f => f.endsWith('.js'))
  .map(f => join(pageDir, f));

if (entries.length === 0) throw new Error('No page entries found in site/src/pages/');

// Chunk names are content hashes: clear old ones, or every build leaves its predecessors behind.
await rm(OUTDIR, { recursive: true, force: true });

await build({
  entryPoints,
  bundle: true,
  format: 'esm',
  splitting: true, // dynamic imports → shared chunks
  target: 'es2022',
  minify: false,
  sourcemap: true,
  outdir: OUTDIR,
  logLevel: 'warning',
});

console.log(`[built] site/dist (${entries.length} pages)`);
