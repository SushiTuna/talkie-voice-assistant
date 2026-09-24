#!/usr/bin/env node
/**
 * Build the embeddable bundle: dist/talkie-embed.js.
 *
 * An IIFE rather than an ES module, so it works from a plain `<script src>` on a page with
 * no bundler and no `type="module"`. Lit, Lion and every other dependency are inlined.
 *
 * Usage:  npm run build
 */

import { build } from 'esbuild';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const outfile = join(ROOT, 'dist', 'talkie-embed.js');

await build({
  entryPoints: [join(ROOT, 'src', 'embed.js')],
  bundle: true,
  format: 'iife',
  globalName: 'Talkie',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  outfile,
  logLevel: 'warning',
  legalComments: 'eof',
});

const { size } = await stat(outfile);
console.log(`[built] dist/talkie-embed.js (${(size / 1024).toFixed(1)} KiB)`);
