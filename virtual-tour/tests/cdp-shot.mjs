// Headless CDP driver: load the tour, click Start, screenshot the live scene.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run",
  "--enable-unsafe-swiftshader", "--window-size=1280,720", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error("chrome did not start");
}

let msgId = 0;
const pending = new Map();
let ws;
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
const events = [];
function onMessage(ev) {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method) {
    events.push(m);
  }
}

async function main() {
  ws = new WebSocket(await getWsUrl());
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", onMessage);

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: "http://localhost:8080/" }, sessionId);

  // wait for the Start overlay to appear (model loaded)
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await send("Runtime.evaluate", {
      expression: `(() => {
        const s = document.getElementById('start');
        const nm = document.getElementById('noModel');
        return JSON.stringify({ start: !s.hidden, noModel: !nm.hidden,
          loadMsg: document.getElementById('loadMsg').textContent });
      })()`,
      returnByValue: true,
    }, sessionId);
    const st = JSON.parse(r.result.value);
    if (st.start) { ready = true; break; }
    if (st.noModel) { console.log("NO-MODEL overlay:", st.loadMsg); break; }
  }
  console.log("start overlay visible:", ready);

  // click Start, then screenshot the scene
  await send("Runtime.evaluate", { expression: `document.getElementById('startBtn').click()` }, sessionId);
  await sleep(2500);
  const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync("/tmp/scene.png", Buffer.from(shot.data, "base64"));
  console.log("wrote /tmp/scene.png");

  // dump console errors seen
  const errs = events
    .filter((e) => e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type))
    .map((e) => (e.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" "))
    .slice(0, 10);
  console.log("console errors/warnings:", errs.length ? "\n  " + errs.join("\n  ") : "none");
}

main().finally(() => { chrome.kill(); process.exit(0); });
