// Screenshot two indoor anchors in both render-quality tiers to keep the SSAO tuning honest:
// rain on (the default) settles in the FAST tier — 8-sample SSAO, the tier where flat walls
// false-self-occlude — and rain off settles in FULL quality (16 samples, expensive blur).
// Needs the server running (npm start). Usage: node tests/indoor-shadow-shots.mjs [baseUrl]
// Output: tests/shots/indoor-<anchor>-<tier>.png; exits 1 on console errors or a tour that never loads.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { ROOM_ANCHORS } from "../anchors.js";

const BASE = process.argv[2] || "http://localhost:8080/";
const OUT = new URL("./shots/", import.meta.url).pathname;
const IDS = ["master-bedroom", "lounge"];
const W = 1280, H = 800, PORT = 9337;
mkdirSync(OUT, { recursive: true });

const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--enable-unsafe-swiftshader",
  `--window-size=${W},${H}`, "--user-data-dir=/tmp/indoor-shots-profile", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, msgId = 0; const pending = new Map(); const errors = [];
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++msgId; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

async function main() {
  let url;
  for (let i = 0; i < 40 && !url; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(250); }
  }
  ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description);
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, s);
  await send("Page.navigate", { url: BASE }, s);
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (file) => {
    const r = await send("Page.captureScreenshot", { format: "png" }, s);
    writeFileSync(OUT + file, Buffer.from(r.data, "base64"));
    return file;
  };

  let ready = false;
  for (let i = 0; i < 180 && !ready; i++) {
    await sleep(500);
    ready = await ev(`(() => { const b = document.getElementById('startBtn'); if (b && !b.closest('[hidden]')) b.click();
      return !!window.tour && window.tour.isReady(); })()`).catch(() => false);
  }
  if (!ready) throw new Error("tour never became ready");
  await sleep(1500);

  for (const id of IDS) {
    const anchor = ROOM_ANCHORS.find((a) => a.id === id);
    if (!anchor) throw new Error(`no anchor ${id} in anchors.js`);
    await ev(`window.tour.goTo(${JSON.stringify(id)}, { instant: true })`);
    await sleep(2000); // settle: one rested frame in the FAST tier (rain on by default)
    console.log(`shot ${await shot(`indoor-${id}-fast.png`)} (fast tier, rain on)`);
    await ev(`document.getElementById('rainBtn').click()`); // rain off → settled FULL-quality frame
    await sleep(2000);
    console.log(`shot ${await shot(`indoor-${id}-full.png`)} (full tier, rain off)`);
    await ev(`document.getElementById('rainBtn').click()`); // back to the default for the next anchor
    await sleep(300);
  }
  console.log(errors.length ? `console errors:\n  ${errors.join("\n  ")}` : "console errors: none");
  process.exitCode = errors.length ? 1 : 0;
}
main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; }).finally(() => chrome.kill());
