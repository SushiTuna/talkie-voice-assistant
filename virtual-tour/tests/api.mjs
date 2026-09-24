// API tests for POST /api/tour-requests. Boots the real server on a random port,
// exercises 201 / 400 / 413 / 405 / honeypot / bad-JSON, and restores data/tour-requests.json.
// Also checks the Talkie embed route (/talkie/*), its mount in index.html, the /voice/* proxy, and
// that only the files the page loads are served (never data/ or the server's own files).
// Usage: node tests/api.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DATA_FILE = join(ROOT, "data", "tour-requests.json");
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${detail}`); }
}

const validBody = () => {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  const p = (n) => String(n).padStart(2, "0");
  return {
    name: "API Tester", email: "tester@example.com", phone: "+61 400 000 000",
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    timeWindow: "afternoon", tourType: "in-person", message: "automated test", company: "",
  };
};

const post = (body, headers = { "Content-Type": "application/json" }) =>
  fetch(`${BASE}/api/tour-requests`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

async function waitUp(base) {
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    try { if ((await fetch(`${base}/api/models`)).ok) return true; } catch { /* not yet */ }
  }
  return false;
}

async function main() {
  const before = existsSync(DATA_FILE) ? await readFile(DATA_FILE, "utf8") : null;
  // Stub voice server for the /voice/* proxy: echoes what it was sent.
  const voiceStub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        stub: true, url: req.url, method: req.method, body,
        xff: req.headers["x-forwarded-for"] ?? null, auth: req.headers.authorization ?? null,
      }));
    });
  });
  await new Promise((r) => voiceStub.listen(0, "127.0.0.1", r));
  const server = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    env: { ...process.env, PORT: String(PORT), VOICE_API: `http://127.0.0.1:${voiceStub.address().port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let cfServer = null;
  try {
    if (!(await waitUp(BASE))) throw new Error("server did not start");

    // 201 valid request + persisted entry
    let res = await post(validBody());
    let json = await res.json();
    check("201 valid request", res.status === 201 && json.ok === true && !!json.id, `got ${res.status} ${JSON.stringify(json)}`);
    const stored = JSON.parse(await readFile(DATA_FILE, "utf8"));
    check("entry persisted with id/createdAt", stored.some((e) => e.id === json.id && e.createdAt && e.name === "API Tester"));

    // 400 invalid fields
    res = await post({ name: "", email: "nope", phone: "abc", date: "2000-01-01", timeWindow: "dawn", tourType: "carrier-pigeon" });
    json = await res.json();
    check("400 invalid fields", res.status === 400 && json.ok === false && json.errors.name && json.errors.email && json.errors.phone && json.errors.date && json.errors.timeWindow && json.errors.tourType, JSON.stringify(json));

    // 400 bad JSON
    res = await post("{not json");
    check("400 bad JSON", res.status === 400 && (await res.json()).errors.form, `got ${res.status}`);

    // 400 wrong content type
    res = await post("hello", { "Content-Type": "text/plain" });
    check("400 non-JSON content type", res.status === 400, `got ${res.status}`);

    // 413 oversized body (> 10 KB)
    res = await post(JSON.stringify({ ...validBody(), message: "x".repeat(20000) }));
    check("413 oversized body", res.status === 413, `got ${res.status}`);

    // 405 other methods
    res = await fetch(`${BASE}/api/tour-requests`);
    check("405 GET", res.status === 405, `got ${res.status}`);
    res = await fetch(`${BASE}/api/tour-requests`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
    check("405 PUT", res.status === 405, `got ${res.status}`);

    // honeypot: silently accepted, nothing stored
    const countBefore = JSON.parse(await readFile(DATA_FILE, "utf8")).length;
    res = await post({ ...validBody(), company: "SPAM CO" });
    json = await res.json();
    const countAfter = JSON.parse(await readFile(DATA_FILE, "utf8")).length;
    check("honeypot 200 + not stored", res.status === 200 && json.ok === true && countAfter === countBefore, `got ${res.status}, count ${countBefore}→${countAfter}`);

    // Talkie voice assistant: embed bundle built in memory from ../talkie-sdk, mounted by index.html
    res = await fetch(`${BASE}/talkie/talkie-embed.js`);
    const embed = res.ok ? await res.text() : "";
    check("talkie embed served as JS", res.status === 200 && /javascript/.test(res.headers.get("content-type") || ""), `got ${res.status}`);
    check("talkie embed is the IIFE that registers <talkie-assistant>", /var Talkie\s*=/.test(embed) && embed.includes("talkie-assistant"));
    check("talkie embed links its source map", /sourceMappingURL=talkie-embed\.js\.map/.test(embed));
    res = await fetch(`${BASE}/talkie/talkie-embed.js.map`);
    check("talkie source map served", res.status === 200, `got ${res.status}`);
    res = await fetch(`${BASE}/talkie/nope.js`);
    check("unknown /talkie/ path 404s", res.status === 404, `got ${res.status}`);
    const html = await (await fetch(`${BASE}/`)).text();
    check("index.html loads the embed and mounts the property assistant",
      html.includes('src="/talkie/talkie-embed.js"') && /<talkie-assistant[^>]*profile="property"/.test(html));

    // /voice/*: same-origin proxy to the voice server, allow-listed routes only
    res = await fetch(`${BASE}/voice/agent/context?profile=property`);
    json = await res.json();
    check("voice proxy forwards context with its query", res.status === 200 && json.url === "/agent/context?profile=property", JSON.stringify(json));
    res = await fetch(`${BASE}/voice/agent/token`);
    check("voice proxy forwards token, uncached", res.status === 200 && (await res.json()).url === "/agent/token" && res.headers.get("cache-control") === "no-store");
    res = await fetch(`${BASE}/voice/agent/token`, { method: "POST" });
    check("voice proxy rejects non-GET on the token route", res.status === 405, `got ${res.status}`);
    res = await fetch(`${BASE}/voice/agent/token`, { headers: { Authorization: "Bearer v1.t.s", "X-Forwarded-For": "6.6.6.6" } });
    json = await res.json();
    check("voice proxy passes the visitor ticket through", json.auth === "Bearer v1.t.s", JSON.stringify(json));
    check("voice proxy sends the visitor's own address, not one they forged",
      /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(json.xff ?? ""), JSON.stringify(json));
    res = await fetch(`${BASE}/voice/agent/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"verification":"tok"}' });
    json = await res.json();
    check("voice proxy forwards the session POST with its body",
      res.status === 200 && json.method === "POST" && json.url === "/agent/session" && JSON.parse(json.body).verification === "tok", JSON.stringify(json));
    check("...uncached", res.headers.get("cache-control") === "no-store");
    res = await fetch(`${BASE}/voice/agent/session`);
    check("voice proxy rejects GET on the session route", res.status === 405, `got ${res.status}`);
    res = await fetch(`${BASE}/voice/health`);
    check("voice proxy forwards only allow-listed routes", res.status === 404, `got ${res.status}`);

    // Static files: only what the page loads. The booking file exists at this point (201 above).
    for (const path of ["/", "/styles.css", "/assets.js", "/components/index.js", "/vendor/meshopt_decoder.js",
      "/node_modules/leaflet/dist/leaflet.css"]) {
      res = await fetch(`${BASE}${path}`);
      check(`${path} is served`, res.status === 200, `got ${res.status}`);
    }
    for (const path of ["/data/tour-requests.json", "/dist/data/tour-requests.json", "/server.mjs", "/package.json",
      "/package-lock.json", "/README.md", "/tests/api.mjs", "/tools/upload-assets.mjs", "/.gitignore",
      "/node_modules/leaflet/package.json", "/components/../data/tour-requests.json", "/%2e%2e/talkie-sdk/package.json"]) {
      res = await fetch(`${BASE}${path}`);
      check(`${path} is not served`, res.status === 404, `got ${res.status}`);
    }

    // server survived all of the above
    res = await fetch(`${BASE}/api/models`);
    check("server still alive", res.ok);

    // TRUST_PROXY=cloudflare: the visitor is CF-Connecting-IP, which Cloudflare sets itself
    const cfPort = PORT + 1;
    cfServer = spawn(process.execPath, [join(ROOT, "server.mjs")], {
      env: { ...process.env, PORT: String(cfPort), TRUST_PROXY: "cloudflare", VOICE_API: `http://127.0.0.1:${voiceStub.address().port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!(await waitUp(`http://127.0.0.1:${cfPort}`))) throw new Error("cloudflare-mode server did not start");
    res = await fetch(`http://127.0.0.1:${cfPort}/voice/agent/token`, { headers: { "CF-Connecting-IP": "7.7.7.7", "X-Forwarded-For": "6.6.6.6" } });
    json = await res.json();
    check("with TRUST_PROXY=cloudflare the proxy sends CF-Connecting-IP", json.xff === "7.7.7.7", JSON.stringify(json));
    res = await fetch(`http://127.0.0.1:${cfPort}/voice/agent/token`, { headers: { "X-Forwarded-For": "6.6.6.6" } });
    json = await res.json();
    check("...and without it falls back to the peer, not X-Forwarded-For",
      /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(json.xff ?? ""), JSON.stringify(json));
  } finally {
    server.kill();
    cfServer?.kill();
    voiceStub.close();
    // restore the data file exactly as it was (drop test entries)
    if (before === null) {
      await rm(DATA_FILE, { force: true });
    } else {
      await writeFile(DATA_FILE, before);
    }
  }
  console.log(`${passed}/${passed + failed} api tests passed${failed ? " — FAILURES above" : ""}`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
