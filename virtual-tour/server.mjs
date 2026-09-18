import { createServer } from "node:http";
import { readFile, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

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
  ".svg": "image/svg+xml",
};

const MODEL_EXT = [".glb", ".gltf", ".obj", ".fbx", ".stl"];

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
  const date = str(b.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = "Please pick a preferred date.";
  else if (date < tomorrowIso()) errors.date = "Please choose tomorrow or later.";
  if (!TIME_WINDOWS.includes(str(b.timeWindow))) errors.timeWindow = "Please choose a valid time window.";
  const tourType = str(b.tourType);
  if (!["in-person", "video"].includes(tourType)) errors.tourType = "Please choose a tour type.";
  const message = str(b.message);
  if (message.length > 1000) errors.message = "Message is limited to 1000 characters.";
  return { errors, clean: { name, email, phone, date, timeWindow: str(b.timeWindow), tourType, message } };
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

    const filePath = join(ROOT, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch (err) {
    res.writeHead(err?.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain" });
    res.end(err?.code === "ENOENT" ? "Not found" : "Server error");
  }
});

server.listen(PORT, () => {
  console.log(`Talkie 3D Virtual Tour -> http://localhost:${PORT}`);
});
