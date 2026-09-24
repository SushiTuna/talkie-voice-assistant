// Bakes the sky HDRI (models/sky/source/*.hdr, 5.4 MB Radiance) into Babylon .env files the page
// loads instead: the same cube HDRCubeTexture used to build at runtime (512 px faces, 128 in LITE
// mode), prefiltered for image-based light, with its spherical harmonics, as WebP faces in RGBD.
// The page then downloads a fraction of the bytes and skips the equirect → cube → prefilter work.
// RGBD tops out at 255: the sun disc (up to ~73 000) is clipped in the specular mips, but the
// harmonics (the diffuse sky light) are computed from the full-range data before encoding.
//
// Needs a browser for WebGL: runs headless Chrome against the dev server.
// Usage: npm start, then npm run bake-sky [baseUrl]
import { spawn } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] || "http://localhost:8080/";
const SRC = "/models/sky/source/kloofendal_48d_partly_cloudy_puresky_2k.hdr";
const OUT = (size) => `models/sky/kloofendal_48d_partly_cloudy_puresky_${size}.env`; // mood.js ENV_URL
const SIZES = [512, 128];
const QUALITY = 0.9; // WebP quality of the RGBD faces
const PORT = 9337;

const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--enable-unsafe-swiftshader",
  "--user-data-dir=/tmp/bake-sky-profile", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, msgId = 0; const pending = new Map();
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
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, s);
  await send("Page.navigate", { url: BASE }, s); // any page with the import map for @babylonjs/core
  await sleep(2000);

  for (const size of SIZES) {
    const r = await send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const B = await import("@babylonjs/core");
      const engine = new B.Engine(document.createElement("canvas"), false);
      const scene = new B.Scene(engine);
      // Same arguments as mood.js used: size, mipmaps, harmonics, linear, prefilterOnLoad.
      const hdr = await new Promise((ok, fail) => {
        const t = new B.HDRCubeTexture(${JSON.stringify(SRC)}, scene, ${size}, false, true, false, true, () => ok(t), fail);
      });
      const buf = await B.EnvironmentTextureTools.CreateEnvTextureAsync(hdr,
        { imageType: "image/webp", imageQuality: ${QUALITY}, disableIrradianceTexture: true });
      engine.dispose();
      const bytes = new Uint8Array(buf); let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    })()` }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    const out = join(ROOT, OUT(size));
    writeFileSync(out, Buffer.from(r.result.value, "base64"));
    console.log(`${OUT(size)}: ${(statSync(out).size / 1024).toFixed(0)} KB`);
  }
}
main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; }).finally(() => chrome.kill());
