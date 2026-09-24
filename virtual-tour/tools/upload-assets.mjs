// Uploads the site's static assets (models/, assets/) to the R2 bucket behind ASSET_BASE
// (assets.js), each with its Content-Type and a one-year immutable Cache-Control. Keys carry a
// version prefix (v1/models/…), so changed files go up under a new VERSION and the page switches
// by updating ASSET_BASE — cached copies of the old version never need purging.
// The files aren't kept in the repo: restore them (from the backup, or rebuild with
// npm run optimize / bake-sky) into models/ and assets/ before running this.
//
// Usage: npx wrangler login (once), then npm run upload-assets [-- --dry-run]
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const BUCKET = "talkie-tour-assets";
const VERSION = "v1"; // keep in step with ASSET_BASE in assets.js
const DIRS = ["models", "assets"];
const MIME = {
  ".glb": "model/gltf-binary",
  ".env": "application/octet-stream", // Babylon prefiltered environment (sky cube)
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const CACHE = "public, max-age=31536000, immutable";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler");
const dryRun = process.argv.includes("--dry-run");

/** Files under dir, skipping source/ folders (originals are never served). */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "source" ? [] : walk(p);
    return e.name.startsWith(".") ? [] : [p];
  });
}

const files = DIRS.flatMap((d) => (statSync(join(ROOT, d), { throwIfNoEntry: false }) ? walk(join(ROOT, d)) : []));
if (!files.length) throw new Error(`nothing to upload: ${DIRS.join("/, ")}/ are empty or missing`);
let bytes = 0;
for (const file of files) {
  const rel = relative(ROOT, file);
  const type = MIME[extname(file).toLowerCase()];
  if (!type) throw new Error(`${rel}: no Content-Type for ${extname(file)}; add it to MIME`);
  const key = `${BUCKET}/${VERSION}/${rel}`;
  bytes += statSync(file).size;
  if (dryRun) { console.log(`would put ${key} (${type})`); continue; }
  execFileSync(WRANGLER, ["r2", "object", "put", key, "--file", file, "--content-type", type, "--cache-control", CACHE, "--remote"],
    { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  console.log(`put ${key}`);
}
console.log(`${dryRun ? "would upload" : "uploaded"} ${files.length} files, ${(bytes / 1048576).toFixed(1)} MB → ${BUCKET}/${VERSION}/`);
