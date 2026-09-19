// Baseline capture of the pre-Lit UI/UX: screenshots + DOM/UX inventory, for diffing after the migration.
// Usage: npm start (server on :8080), then `node baseline/capture.mjs [outDir]`.
// Driver mirrors tests/cdp-shot.mjs (headless Chrome over CDP, no extra deps).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const URL = process.env.URL || "http://localhost:8080/";
const OUT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "current");
const SHOTS = join(OUT, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};
const SECTIONS = ["top", "floor-plan", "highlights", "tour-section", "residence", "location", "contact"];

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run",
  "--enable-unsafe-swiftshader", "--hide-scrollbars", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, msgId = 0;
const pending = new Map();
const events = [];
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function connect() {
  for (let i = 0; i < 40; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  throw new Error("chrome did not start");
}

async function newPage(vp, theme) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  const ev = (expression) => send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, s)
    .then((r) => r.result.value);
  await send("Page.enable", {}, s);
  await send("Runtime.enable", {}, s);
  await send("Emulation.setDeviceMetricsOverride", VIEWPORTS[vp], s);
  if (VIEWPORTS[vp].mobile) await send("Emulation.setTouchEmulationEnabled", { enabled: true }, s);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, s);
  await send("Page.navigate", { url: URL }, s);
  await sleep(3500);
  // Force scroll-reveal content visible and stop the theme from being remembered between runs.
  await ev(`(() => { try { localStorage.removeItem('theme'); } catch {}
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    document.querySelectorAll('.reveal, [data-stagger], .tour-frame').forEach(e => e.classList.add('in','settled'));
    return true; })()`);
  // Scroll through so lazy images and map tiles load, then return to the top.
  await ev(`(async () => { document.querySelectorAll('img[loading=lazy]').forEach(i => i.loading = 'eager');
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 2) { scrollTo(0, y); await new Promise(r => setTimeout(r, 150)); }
    await new Promise(r => setTimeout(r, 1500)); scrollTo(0, 0); return true; })()`);
  await sleep(800);
  return { s, ev, close: () => send("Target.closeTarget", { targetId }) };
}

async function shot(s, file, clip) {
  const params = { format: "png", captureBeyondViewport: !!clip };
  if (clip) params.clip = { ...clip, scale: 1 };
  const r = await send("Page.captureScreenshot", params, s);
  writeFileSync(join(SHOTS, file), Buffer.from(r.data, "base64"));
  return file;
}

async function fullPage(p, file) {
  const { w, h } = await p.ev(`({ w: document.documentElement.clientWidth, h: document.documentElement.scrollHeight })`);
  return shot(p.s, file, { x: 0, y: 0, width: w, height: h });
}

async function sectionShots(p, prefix) {
  const out = [];
  for (const id of SECTIONS) {
    const box = await p.ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: 0, y: r.top + scrollY, width: document.documentElement.clientWidth, height: Math.max(1, r.height) }; })()`);
    if (box) out.push(await shot(p.s, `${prefix}-section-${id}.png`, box));
  }
  return out;
}

// Structural + UX inventory: what a user can see and do, and the design tokens in effect.
const INVENTORY = `(() => {
  const name = (e) => (e.getAttribute('aria-label') || e.labels?.[0]?.textContent || e.textContent || e.value || e.title || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const root = getComputedStyle(document.documentElement);
  const tokens = {};
  for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch { continue; }
    for (const r of rules) if (r.style) for (const p of r.style) if (p.startsWith('--')) tokens[p] = root.getPropertyValue(p).trim(); }
  const body = getComputedStyle(document.body);
  return {
    title: document.title, theme: document.documentElement.dataset.theme,
    viewport: { w: innerWidth, h: innerHeight }, docHeight: document.documentElement.scrollHeight,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    body: { fontFamily: body.fontFamily, fontSize: body.fontSize, color: body.color, background: body.backgroundColor },
    landmarks: [...document.querySelectorAll('header,nav,main,footer,section,aside,[role]')].map(e => ({ tag: e.tagName.toLowerCase(), id: e.id || undefined, role: e.getAttribute('role') || undefined, label: e.getAttribute('aria-label') || undefined })),
    headings: [...document.querySelectorAll('h1,h2,h3,h4')].map(e => ({ level: +e.tagName[1], text: e.textContent.trim().replace(/\\s+/g, ' '), visible: vis(e) })),
    interactive: [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[role=button]')].map(e => ({
      tag: e.tagName.toLowerCase(), id: e.id || undefined, type: e.type || undefined, name: name(e), href: e.getAttribute('href') || undefined,
      visible: vis(e), disabled: e.disabled || undefined, size: (() => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() })),
    images: [...document.images].map(i => ({ src: i.getAttribute('src'), alt: i.alt, loaded: i.complete && i.naturalWidth > 0 })),
    ids: [...document.querySelectorAll('[id]')].map(e => e.id),
    customElements: [...new Set([...document.querySelectorAll('*')].map(e => e.tagName.toLowerCase()).filter(t => t.includes('-')))],
    cssTokens: tokens,
  };
})()`;

async function keyboardOrder(p, n = 40) {
  await p.ev(`(document.activeElement?.blur(), window.scrollTo(0,0), true)`);
  const order = [];
  for (let i = 0; i < n; i++) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, p.s);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, p.s);
    order.push(await p.ev(`(() => { const e = document.activeElement; return e ? (e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + ' ' + (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g,' ').slice(0, 50)) : null; })()`));
  }
  return order;
}

async function main() {
  ws = new WebSocket(await connect());
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
    else if (m.method) events.push(m);
  });

  const report = { url: URL, capturedAt: new Date().toISOString(), runs: {} };
  for (const vp of Object.keys(VIEWPORTS)) for (const theme of ["dark", "light"]) {
    const key = `${vp}-${theme}`;
    console.log("capturing", key);
    const p = await newPage(vp, theme);
    const run = { screenshots: [] };
    run.screenshots.push(await shot(p.s, `${key}-above-fold.png`));
    run.screenshots.push(await fullPage(p, `${key}-full.png`));
    run.screenshots.push(...await sectionShots(p, key));
    run.inventory = await p.ev(INVENTORY);

    if (theme === "dark") {
      run.keyboardTabOrder = await keyboardOrder(p);
      // Booking form: empty submit → validation UX.
      await p.ev(`(() => { const f = document.getElementById('tourForm'); f.scrollIntoView(); f.requestSubmit(); return true; })()`);
      await sleep(700);
      run.formErrors = await p.ev(`(() => ({ summaryVisible: !document.getElementById('errorSummary').hidden,
        summary: document.getElementById('errorSummaryList')?.innerText, focused: document.activeElement?.id,
        invalid: [...document.querySelectorAll('[aria-invalid=true]')].map(e => e.id || e.name) }))()`);
      const box = await p.ev(`(() => { const r = document.getElementById('contact').getBoundingClientRect(); return { x: 0, y: r.top + scrollY, width: document.documentElement.clientWidth, height: r.height }; })()`);
      run.screenshots.push(await shot(p.s, `${key}-form-errors.png`, box));

      // 3D tour: start and capture the live scene + HUD.
      await p.ev(`(document.getElementById('tour-section').scrollIntoView(), true)`);
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (await p.ev(`!document.getElementById('startBtn')?.disabled && !!document.getElementById('startBtn')?.offsetParent`)) break;
      }
      await p.ev(`(document.getElementById('startBtn')?.click(), true)`);
      await sleep(4000);
      const tbox = await p.ev(`(() => { const r = document.getElementById('tour').getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
      run.screenshots.push(await shot(p.s, `${key}-tour-started.png`, tbox));
      run.tourState = await p.ev(`({ badge: document.getElementById('badge')?.textContent.trim(), hint: document.getElementById('tourHint')?.textContent.trim(),
        dockNow: document.getElementById('dockNowName')?.textContent.trim(), dockCount: document.getElementById('dockCount')?.textContent.trim(),
        noModel: !document.getElementById('noModel')?.hidden })`);
    }
    await p.close();
    report.runs[key] = run;
  }
  report.console = events
    .filter((e) => (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)) || e.method === "Runtime.exceptionThrown")
    .map((e) => e.method === "Runtime.exceptionThrown" ? `exception: ${e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text}`
      : `${e.params.type}: ${(e.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ")}`);
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log("wrote", OUT);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); setTimeout(() => process.exit(), 200); });
