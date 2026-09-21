// API tests for POST /api/tour-requests. Boots the real server on a random port,
// exercises 201 / 400 / 413 / 405 / honeypot / bad-JSON, and restores data/tour-requests.json.
// Also checks the Talkie embed route (/talkie/*), its mount in index.html, and the /voice/* proxy.
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

async function main() {
  const before = existsSync(DATA_FILE) ? await readFile(DATA_FILE, "utf8") : null;
  // Stub voice server for the /voice/* proxy: echoes the path and query it was asked for.
  const voiceStub = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ stub: true, url: req.url }));
  });
  await new Promise((r) => voiceStub.listen(0, "127.0.0.1", r));
  const server = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    env: { ...process.env, PORT: String(PORT), VOICE_API: `http://127.0.0.1:${voiceStub.address().port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(150);
      try { up = (await fetch(`${BASE}/api/models`)).ok; } catch { /* not yet */ }
    }
    if (!up) throw new Error("server did not start");

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
    check("voice proxy rejects non-GET", res.status === 405, `got ${res.status}`);
    res = await fetch(`${BASE}/voice/health`);
    check("voice proxy forwards only allow-listed routes", res.status === 404, `got ${res.status}`);

    // server survived all of the above
    res = await fetch(`${BASE}/api/models`);
    check("server still alive", res.ok);
  } finally {
    server.kill();
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
