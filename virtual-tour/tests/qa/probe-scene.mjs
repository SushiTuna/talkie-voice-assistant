// Probe: dump the loaded scene's mesh/material names so the QA checks can assert what is in view.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const PORT = 9503, BASE = "http://localhost:8080";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, msgId = 0; const pending = new Map();
const send = (m, p = {}, s) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s })); });
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--enable-unsafe-swiftshader", "--window-size=1440,900", `--user-data-dir=/tmp/qa-probe-${PORT}`, "about:blank"], { stdio: "ignore" });
let url; for (let i = 0; i < 60 && !url; i++) { try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(250); } }
ws = new WebSocket(url);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const { targetId } = await send("Target.createTarget", { url: BASE + "/" });
const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, s); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
for (let i = 0; i < 300; i++) { await sleep(500); if (await ev(`(() => { const b = document.getElementById('startBtn'); if (b && !b.closest('[hidden]')) b.click(); return !!(window.tour && window.tour.isReady()); })()`)) break; }
const dump = await ev(`(() => {
  const sc = window.__scene;
  const rows = sc.meshes.map(m => ({ name: m.name, mat: m.material?.name || null, verts: m.getTotalVertices(),
    y: +m.getBoundingInfo().boundingBox.maximumWorld.y.toFixed(2), minY: +m.getBoundingInfo().boundingBox.minimumWorld.y.toFixed(2), sx: +(m.getBoundingInfo().boundingBox.maximumWorld.x - m.getBoundingInfo().boundingBox.minimumWorld.x).toFixed(2), sz: +(m.getBoundingInfo().boundingBox.maximumWorld.z - m.getBoundingInfo().boundingBox.minimumWorld.z).toFixed(2),
    x: +((m.getBoundingInfo().boundingBox.maximumWorld.x + m.getBoundingInfo().boundingBox.minimumWorld.x) / 2).toFixed(1),
    z: +((m.getBoundingInfo().boundingBox.maximumWorld.z + m.getBoundingInfo().boundingBox.minimumWorld.z) / 2).toFixed(1) }));
  return JSON.stringify({ total: rows.length, mats: [...new Set(sc.materials.map(m => m.name))], rows }); })()`);
const d = JSON.parse(dump);
writeFileSync(new URL("./scene-dump.json", import.meta.url), JSON.stringify(d, null, 1));
console.log("meshes:", d.total, "materials:", d.mats.length);
const kw = /bed|crib|sofa|couch|chair|table|island|stool|bath|shower|vanity|sink|wc|toilet|wash|dry|laundry|car|desk|shelv|wardrobe|robe|kit|stove|cook|fridge|deck|pergola|tv|rug|lamp|stair|plant|tree|counter|mirror|bench|shelf|unit|appliance|door|window|pillar|post/i;
for (const r of d.rows.filter((r) => kw.test(r.name)).slice(0, 220)) console.log(`${r.name} | mat=${r.mat} | v=${r.verts} | centre=(${r.x},${r.z}) y=${r.minY}..${r.y}`);
console.log("--- other meshes ---");
for (const r of d.rows.filter((r) => !kw.test(r.name)).slice(0, 60)) console.log(`${r.name} | mat=${r.mat} | v=${r.verts} | centre=(${r.x},${r.z})`);
chrome.kill(); process.exit(0);
