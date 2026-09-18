// Probe: which Page.captureScreenshot clip coordinate space works for an element below the fold?
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
const PORT = 9501, BASE = "http://localhost:8080";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colorType = 0; const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === "IDAT") idat.push(data); else if (type === "IEND") break;
    pos += 12 + len;
  }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(idat)), stride = width * ch, out = Buffer.alloc(stride * height);
  let rp = 0;
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const v = raw[rp + x], a = x >= ch ? out[y * stride + x - ch] : 0, b = y > 0 ? out[(y - 1) * stride + x] : 0, c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      out[y * stride + x] = f === 0 ? v : f === 1 ? (v + a) & 255 : f === 2 ? (v + b) & 255 : f === 3 ? (v + ((a + b) >> 1)) & 255 : (v + paeth(a, b, c)) & 255;
    }
    rp += stride;
  }
  return { width, height, ch, data: out };
}
function stats(file) {
  const img = decodePng(readFileSyncSafe(file));
  let sum = 0, sum2 = 0, n = 0; const set = new Set();
  for (let i = 0; i < img.data.length; i += img.ch * 37) { const v = img.data[i] + img.data[i + 1] + img.data[i + 2]; sum += v; sum2 += v * v; n++; set.add(v >> 8); }
  const mean = sum / n, sd = Math.sqrt(sum2 / n - mean * mean);
  return `${img.width}x${img.height} meanLum=${(mean / 3).toFixed(1)} sd=${sd.toFixed(1)} distinctBuckets=${set.size}`;
}
const readFileSyncSafe = (f) => readFileSync(f);
let ws, msgId = 0; const pending = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s })); });
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--enable-unsafe-swiftshader", "--window-size=1440,900", `--user-data-dir=/tmp/qa-probe-${PORT}`, "about:blank"], { stdio: "ignore" });
const main = async () => {
  let url; for (let i = 0; i < 60 && !url; i++) { try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(250); } }
  ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  const { targetId } = await send("Target.createTarget", { url: BASE + "/" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, s); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
  for (let i = 0; i < 200; i++) { await sleep(500); const ok = await ev(`(() => { const b = document.getElementById('startBtn'); if (b && !b.closest('[hidden]')) b.click(); return !!(window.tour && window.tour.isReady()); })()`); if (ok) break; }
  await ev(`document.getElementById('tour').scrollIntoView({ behavior: 'instant', block: 'center' })`);
  await sleep(1500);
  const rect = JSON.parse(await ev(`(() => { const r = document.getElementById('tour').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), sx: window.scrollX, sy: window.scrollY }); })()`));
  console.log("tour rect", JSON.stringify(rect));
  const save = async (name, params) => { const r = await send("Page.captureScreenshot", params, s); writeFileSync(`/tmp/${name}`, Buffer.from(r.data, "base64")); console.log(name, stats(`/tmp/${name}`)); };
  await save("probe-full.png", { format: "png" });
  await save("probe-clip-viewport.png", { format: "png", clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 }, captureBeyondViewport: false });
  await save("probe-clip-doc.png", { format: "png", clip: { x: rect.x + rect.sx, y: rect.y + rect.sy, width: rect.w, height: rect.h, scale: 1 }, captureBeyondViewport: true });
  chrome.kill(); process.exit(0);
};
main().catch((e) => { console.error("probe failed:", e.message); chrome.kill(); process.exit(1); });
