// Screenshot every room anchor from anchors.js in headless Chrome and check the camera stays where it was put.
// Needs the server running (npm start). Usage: node tests/anchor-shots.mjs [baseUrl]
// Output: tests/shots/anchor-<id>.png plus one line of numbers per anchor; exits 1 if any anchor drifts or is blocked.
// Also shoots close-ups of the props the anchors don't frame (view-<id>.png: cars, a broadleaf tree, the
// mountains). SHOTS_DIR=tests/shots/before writes elsewhere, e.g. to compare model builds.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { ROOM_ANCHORS } from "../anchors.js";

const BASE = process.argv[2] || "http://localhost:8080/";
const OUT = process.env.SHOTS_DIR ? `${process.env.SHOTS_DIR.replace(/\/$/, "")}/` : new URL("./shots/", import.meta.url).pathname;
const W = 1280, H = 800, PORT = 9336;
mkdirSync(OUT, { recursive: true });

const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--enable-unsafe-swiftshader",
  `--window-size=${W},${H}`, "--user-data-dir=/tmp/anchor-shots-profile", "about:blank",
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
    else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description);
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
  // Wait until the walk camera exists (works before and after the funnel refactor).
  let ready = false;
  for (let i = 0; i < 180 && !ready; i++) {
    await sleep(500);
    ready = await ev(`(() => { const b = document.getElementById('startBtn'); if (b && !b.closest('[hidden]')) b.click();
      return !!window.__scene?.cameras.find(c => c.name === 'fp'); })()`);
  }
  if (!ready) throw new Error("tour never became ready");
  await sleep(1500);

  let failed = 0;
  for (const a of ROOM_ANCHORS) {
    // Use the public API when it exists (Phase 2+), otherwise place the camera directly.
    await ev(`(async () => {
      const a = ${JSON.stringify(a)};
      if (window.tour?.goTo) { await window.tour.goTo(a.id, { instant: true }); return; }
      const scene = window.__scene, fp = scene.cameras.find(c => c.name === 'fp');
      fp.position.set(...a.pos); fp.rotation.set(a.pitch, a.yaw, 0); scene.activeCamera = fp;
    })()`);
    await sleep(1800);
    const st = await ev(`(async () => {
      const B = await import("@babylonjs/core");
      const scene = window.__scene, fp = scene.activeCamera;
      const p = fp.position, a = ${JSON.stringify(a)};
      const pick = (m) => m.checkCollisions && m.isEnabled();
      const ahead = scene.pickWithRay(new B.Ray(p.clone(), fp.getDirection(B.Vector3.Forward()), 30), pick);
      return { drift: Math.hypot(p.x - a.pos[0], p.y - a.pos[1], p.z - a.pos[2]), sight: ahead?.hit ? ahead.distance : null, sees: ahead?.pickedMesh?.name };
    })()`);
    const shot = await send("Page.captureScreenshot", { format: "png" }, s);
    writeFileSync(`${OUT}anchor-${a.id}.png`, Buffer.from(shot.data, "base64"));
    const bad = st.drift > 0.15 || (st.sight !== null && st.sight < 1.0);
    if (bad) failed++;
    console.log(`${bad ? "FAIL" : "ok  "} ${a.id.padEnd(15)} drift=${st.drift.toFixed(3)}m sight=${st.sight?.toFixed(2) ?? "open"}m sees=${st.sees ?? "-"}`);
  }
  // Prop close-ups: camera placed relative to whatever the scene loaded, looking at its centre.
  const VIEWS = {
    ferrari: `const c = centre(scene.getTransformNodeByName("car-ferrari").getChildMeshes()); return [c.add(new B.Vector3(2.6, 0.5, 2.6)), c];`,
    porsche: `const c = centre(scene.getTransformNodeByName("car-porsche").getChildMeshes()); return [c.add(new B.Vector3(-2.6, 0.5, 2.6)), c];`,
    tree: `const t = scene.meshes.filter((m) => /^broadleaf\\d+$/.test(m.name)).sort((a, b) => a.position.length() - b.position.length())[0];
      const c = centre([t]), d = c.subtract(new B.Vector3(0, c.y, 0)).normalize().scale(-9); return [c.add(new B.Vector3(d.x, 0, d.z)), c];`,
    mountains: `const p = scene.meshes.filter((m) => /^peakTpl/.test(m.sourceMesh?.name || "")).sort((a, b) => a.position.length() - b.position.length())[0];
      const eye = new B.Vector3(-17, -1.7, 11.4); return [eye, new B.Vector3(p.position.x, eye.y + 40, p.position.z)];`,
  };
  for (const [id, pose] of Object.entries(VIEWS)) {
    await ev(`(async () => {
      const B = await import("@babylonjs/core");
      await window.tour?.goTo("exterior", { instant: true }); // walk mode, and wakes the idle render loop
      const scene = window.__scene, fp = scene.cameras.find(c => c.name === 'fp');
      const centre = (ms) => { const { min, max } = B.Mesh.MinMax(ms); return min.add(max).scale(0.5); };
      const [eye, at] = (() => { ${pose} })();
      scene.activeCamera = fp; fp.position.copyFrom(eye); fp.setTarget(at);
    })()`);
    await sleep(1800);
    const shot = await send("Page.captureScreenshot", { format: "png" }, s);
    writeFileSync(`${OUT}view-${id}.png`, Buffer.from(shot.data, "base64"));
    console.log(`view ${id}`);
  }
  console.log(errors.length ? `console errors:\n  ${errors.join("\n  ")}` : "console errors: none");
  console.log(`${ROOM_ANCHORS.length - failed}/${ROOM_ANCHORS.length} anchors ok — screenshots in ${OUT} (open them to confirm each room)`);
  process.exitCode = failed || errors.length ? 1 : 0;
}
main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; }).finally(() => chrome.kill());
