import { createServer } from "node:http";
import { readFile, readdir, mkdir, writeFile, rename, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { promisify } from "node:util";
import zlib from "node:zlib";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".obj": "text/plain; charset=utf-8",
  ".mtl": "text/plain; charset=utf-8",
  ".fbx": "application/octet-stream",
  ".stl": "model/stl",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".hdr": "image/vnd.radiance",
};

const MODEL_EXT = [".glb", ".gltf", ".obj", ".fbx", ".stl"];

/* ------------------------------------------------------------------ bundle (/dist/*) */

// page.js and main.js (+ Babylon, ~900 modules) bundled in memory by esbuild, rebuilt whenever a
// source file changes, so editing and reloading still just works. main.js keeps loading Babylon
// lazily: it becomes a separate chunk. If esbuild is unavailable, /dist/<file> serves the raw
// source file instead and the import map in index.html resolves the bare Babylon specifiers.
const bundle = { files: new Map(), ready: null, error: null };

async function startBundler() {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    console.warn("esbuild not installed: serving unbundled modules (slower page load). Run npm install.");
    return;
  }
  let settle;
  bundle.ready = new Promise((r) => (settle = r));
  try {
    const ctx = await esbuild.context({
      absWorkingDir: ROOT,
      entryPoints: ["page.js", "main.js"],
      bundle: true,
      splitting: true,
      format: "esm",
      target: "es2022",
      minify: true,
      sourcemap: "linked",
      outdir: "dist",
      write: false,
      logLevel: "warning",
      plugins: [{
        name: "in-memory",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length) {
              bundle.error = result.errors.map((e) => e.text).join("\n");
            } else {
              bundle.error = null;
              bundle.files = new Map(result.outputFiles.map((f) => {
                const data = Buffer.from(f.contents);
                const etag = `"${createHash("sha1").update(data).digest("base64url").slice(0, 20)}"`;
                return ["/" + f.path.slice(ROOT.length + 1).replaceAll("\\", "/"), { data, etag }];
              }));
              // Compress ahead of the first request, so a reload right after an edit doesn't wait.
              for (const [path, f] of bundle.files) compressed(path, f.etag, f.data, "br").catch(() => {});
            }
            settle();
          });
        },
      }],
    });
    await ctx.watch();
  } catch (err) {
    bundle.ready = null; // fall back to unbundled sources
    settle();
    throw err;
  }
}

/* ------------------------------------------------------------------ compression + caching */

// Formats that are already compressed (jpg/png/webp/woff2) are sent as-is.
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".map", ".svg", ".wasm",
  ".glb", ".gltf", ".bin", ".obj", ".mtl", ".fbx", ".stl", ".hdr"]);
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const packed = new Map(); // `${enc} ${etag} ${key}` → Promise<Buffer | null> (null: not worth it)

function pickEncoding(req) {
  const ae = String(req.headers["accept-encoding"] || "");
  return /\bbr\b/.test(ae) ? "br" : /\bgzip\b/.test(ae) ? "gzip" : null;
}

function compressed(key, etag, data, enc) {
  const id = `${enc} ${etag} ${key}`;
  let p = packed.get(id);
  if (!p) {
    // Max brotli for small files; a faster level for big bundles, models and HDRs.
    const quality = data.length > 256e3 ? 6 : 11;
    p = (enc === "br"
      ? brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } })
      : gzip(data, { level: 6 })
    ).then((out) => (out.length < data.length * 0.97 ? out : null));
    for (const k of packed.keys()) if (k.endsWith(` ${key}`) && !k.includes(` ${etag} `)) packed.delete(k); // stale versions
    packed.set(id, p);
  }
  return p;
}

/** Send a static body with ETag revalidation and (when it helps) br/gzip compression. */
async function sendStatic(req, res, key, data, etag, ext) {
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-cache", // always revalidate: cheap 304s, and edits show up on reload
    ETag: etag,
  };
  if (COMPRESSIBLE.has(ext)) headers.Vary = "Accept-Encoding";
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const enc = COMPRESSIBLE.has(ext) && data.length > 1024 ? pickEncoding(req) : null;
  const body = enc && (await compressed(key, etag, data, enc));
  if (body) {
    headers["Content-Encoding"] = enc;
    headers["X-Decoded-Length"] = String(data.length); // lets the tour show download progress
  }
  const out = body || data;
  headers["Content-Length"] = String(out.length);
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : out);
}

/* ------------------------------------------------------------------ tour booking endpoint */

const REQUESTS_FILE = join(ROOT, "data", "tour-requests.json");
const MAX_BODY = 10 * 1024; // 10 KB
const TIME_WINDOWS = ["morning", "afternoon", "evening"];

function tomorrowIso() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Re-validate every field server-side; returns { errors } keyed by field name. */
function validateRequest(b) {
  const errors = {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const name = str(b.name);
  if (!name || name.length > 120) errors.name = "Please enter your full name.";
  const email = str(b.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = "Please enter a valid email address.";
  const phone = str(b.phone);
  if (!/^[\d+()\- ]{7,20}$/.test(phone)) errors.phone = "Phone must be 7–20 characters (digits, spaces, + ( ) -).";
  const tourType = str(b.tourType);
  if (!["in-person", "video", "inquiry"].includes(tourType)) errors.tourType = "Please choose a tour type.";
  const date = str(b.date);
  if (tourType !== "inquiry") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = "Please pick a preferred date.";
    else if (date < tomorrowIso()) errors.date = "Please choose tomorrow or later.";
    if (!TIME_WINDOWS.includes(str(b.timeWindow))) errors.timeWindow = "Please choose a valid time window.";
  }
  const message = str(b.message);
  if (message.length > 1000) errors.message = "Message is limited to 1000 characters.";
  return { errors, clean: { name, email, phone, date: tourType === "inquiry" ? "" : date, timeWindow: tourType === "inquiry" ? "" : str(b.timeWindow), tourType, message } };
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        if (size > 5 * 1024 * 1024) { rejectBody(new Error("body absurdly large")); req.destroy(); return; }
        return; // stop buffering, keep draining so the 413 response can still flush
      }
      if (!tooLarge) chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) rejectBody(Object.assign(new Error("too large"), { statusCode: 413 }));
      else resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", rejectBody);
  });
}

async function appendRequest(entry) {
  await mkdir(join(ROOT, "data"), { recursive: true });
  let list = [];
  try {
    const parsed = JSON.parse(await readFile(REQUESTS_FILE, "utf8"));
    if (Array.isArray(parsed)) list = parsed;
  } catch { /* first write / unreadable file: start fresh */ }
  list.push(entry);
  // Atomic: write a temp file in the same directory, then rename over the target.
  const tmp = `${REQUESTS_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(list, null, 2) + "\n");
  await rename(tmp, REQUESTS_FILE);
}

async function handleTourRequest(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    return res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
  }
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, errors: { form: "Expected JSON body." } }));
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const code = err.statusCode || 400;
    res.writeHead(code, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, errors: { form: code === 413 ? "Request body too large." : "Could not read body." } }));
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, errors: { form: "Invalid JSON." } }));
  }
  // Honeypot filled → bot: accept silently, store nothing.
  if (typeof parsed.company === "string" && parsed.company.trim() !== "") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  const { errors, clean } = validateRequest(parsed);
  if (Object.keys(errors).length) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, errors }));
  }
  const entry = { id: randomUUID(), createdAt: new Date().toISOString(), ...clean };
  try {
    await appendRequest(entry);
  } catch (err) {
    console.error("tour-requests write failed:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, errors: { form: "Could not save your request. Please try again." } }));
  }
  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, id: entry.id }));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/api/tour-requests") {
      return await handleTourRequest(req, res);
    }

    if (pathname === "/api/models") {
      let files = [];
      try {
        const entries = await readdir(join(ROOT, "models"));
        files = entries
          .filter((f) => MODEL_EXT.includes(extname(f).toLowerCase()))
          .sort();
      } catch {
        /* models/ missing */
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(files));
    }

    if (pathname.startsWith("/dist/") && bundle.ready && (await bundle.ready, bundle.ready)) {
      if (bundle.error) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(`Bundle failed:\n${bundle.error}`);
      }
      const f = bundle.files.get(pathname);
      if (!f) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return await sendStatic(req, res, pathname, f.data, f.etag, extname(pathname).toLowerCase());
    }
    // No bundler: /dist/<file> is the source file itself.
    const rel = pathname === "/" ? "index.html" : pathname.slice(pathname.startsWith("/dist/") ? 6 : 1);
    const filePath = join(ROOT, rel);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const st = await stat(filePath);
    if (!st.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const key = filePath;
    if (req.headers["if-none-match"] === etag) return await sendStatic(req, res, key, null, etag, extname(filePath).toLowerCase());
    const data = await readFile(filePath);
    return await sendStatic(req, res, key, data, etag, extname(filePath).toLowerCase());
  } catch (err) {
    res.writeHead(err?.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain" });
    res.end(err?.code === "ENOENT" ? "Not found" : "Server error");
  }
});

startBundler().catch((err) => console.error("bundler failed to start, serving unbundled modules:", err));

server.listen(PORT, () => {
  console.log(`Talkie 3D Virtual Tour -> http://localhost:${PORT}`);
});
