// QA driver (independent verifier). CDP over WebSocket, one Chrome instance, one tab per scenario.
// Usage: node tests/qa/qa.mjs [stage ...]     stages: A A4 B C D E   (default: all)
// Writes tests/qa/results.json + screenshots into tests/qa/. Read-only against the project.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { ROOM_ANCHORS, DOLLHOUSE } from "../../anchors.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:8080";
const OUT = new URL("./", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const STAGES = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const want = (s) => !STAGES.length || STAGES.includes(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QA_EMAIL = `qa+${Date.now()}@example.com`;
const PORT = 9400 + Math.floor(Math.random() * 300);

/* ------------------------------------------------------------------ results */
const results = [];
function record(id, status, evidence) {
  results.push({ id, status, evidence });
  console.log(`[${status}] ${id} — ${evidence}`);
}
const log = (...a) => console.log("   ", ...a);

/* ------------------------------------------------------------------ CDP plumbing */
let ws, msgId = 0;
const pending = new Map();
const consoleMsgs = [];
const exceptions = [];
const netEvents = [];
const allRequests = [];
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
function onMessage(ev) {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (!m.method) return;
  const p = m.params || {};
  if (m.method === "Runtime.consoleAPICalled") {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
    if (["error", "warning", "assert"].includes(p.type)) consoleMsgs.push({ type: p.type, text });
  } else if (m.method === "Runtime.exceptionThrown") {
    exceptions.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "unknown");
  } else if (m.method === "Log.entryAdded") {
    const e = p.entry;
    if (e.level === "error" || e.level === "warning") consoleMsgs.push({ type: e.level, text: `[${e.source}] ${e.text}` });
  } else if (m.method === "Network.requestWillBeSent") {
    allRequests.push({ url: p.request.url, method: p.request.method, session: m.sessionId });
  } else if (m.method === "Network.responseReceived") {
    netEvents.push({ url: p.response.url, status: p.response.status, type: p.response.mimeType, session: m.sessionId });
  } else if (m.method === "Network.loadingFailed") {
    netEvents.push({ url: "(see loadingFailed)", status: `FAILED:${p.errorText}`, type: p.type, canceled: p.canceled, session: m.sessionId });
  }
}

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error("chrome did not start");
}

/* ------------------------------------------------------------------ tab helpers */
async function newTab({ width = 1440, height = 900, url = "about:blank" } = {}) {
  const { targetId } = await send("Target.createTarget", { url });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  for (const d of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable", "DOM.enable"]) {
    await send(d, {}, sessionId);
  }
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  const t = { targetId, sessionId, width, height };
  t.ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  t.nav = async (u) => {
    await send("Page.navigate", { url: u }, sessionId);
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      if (await t.ev(`document.readyState`).catch(() => "x")) break;
    }
    for (let i = 0; i < 120; i++) {
      const st = await t.ev(`document.readyState`).catch(() => "x");
      if (st === "complete") return;
      await sleep(250);
    }
  };
  t.box = (sel) => t.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null; const r = e.getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }); })()`).then(JSON.parse);
  t.scrollIntoView = (sel) => t.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return false; e.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); return true; })()`);
  t.clickAt = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
  };
  // Real click on an element's box centre; elementFromPoint guards against clipped/covered targets.
  t.clickEl = async (sel, { scroll = true } = {}) => {
    if (scroll) { await t.scrollIntoView(sel); await sleep(150); }
    const b = await t.box(sel);
    if (!b) throw new Error(`no element ${sel}`);
    const h = JSON.parse(await t.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      const r = e.getBoundingClientRect(); const x = r.x + r.width/2, y = r.y + r.height/2;
      const top = document.elementFromPoint(x, y);
      return JSON.stringify({ ok: !!top && (e === top || e.contains(top) || top.contains(e)),
        top: top ? (top.id || (typeof top.className === 'string' ? top.className : top.tagName) || top.tagName) : null, x, y,
        inView: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight }); })()`));
    if (!h.inView) throw new Error(`${sel} centre off-screen (${Math.round(h.x)},${Math.round(h.y)})`);
    await t.clickAt(Math.round(h.x), Math.round(h.y));
    return { box: b, covered: !h.ok, coveredBy: h.top };
  };
  t.key = async (key, code, vk, extra = {}) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...extra }, sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sessionId);
  };
  t.focus = (sel) => t.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); return document.activeElement === e; })()`);
  t.shot = async (file, clip) => {
    const params = { format: "png" };
    if (clip) {
      // Chrome interprets `clip` in DOCUMENT coordinates when captureBeyondViewport is on,
      // and drops WebGL canvas content when it is off — so convert and capture beyond.
      const s = JSON.parse(await t.ev(`JSON.stringify([window.scrollX, window.scrollY])`));
      params.clip = { x: clip.x + s[0], y: clip.y + s[1], width: clip.width, height: clip.height, scale: 1 };
      params.captureBeyondViewport = true;
    } else if (clip === null) params.captureBeyondViewport = true;
    const r = await send("Page.captureScreenshot", params, sessionId);
    writeFileSync(OUT + file, Buffer.from(r.data, "base64"));
    return file;
  };
  t.settle = async (expr, timeout = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await t.ev(expr).catch(() => false)) return true;
      await sleep(300);
    }
    return false;
  };
  t.close = () => send("Target.closeTarget", { targetId }).catch(() => {});
  if (url !== "about:blank") await t.nav(url);
  return t;
}

async function tourReady(t, timeout = 180000) {
  await t.ev(`(() => { const b = document.getElementById('startBtn'); if (b && !b.closest('[hidden]')) b.click(); return true; })()`);
  return t.settle(`!!(window.tour && window.tour.isReady() && document.querySelectorAll('#anchorBar .pill').length)`, timeout);
}

async function clickPill(t, id) {
  const sel = `#anchorBar .pill[data-anchor="${id}"]`;
  // Make sure the tour (and thus the bar) is on screen, then make sure the pill is inside the bar.
  await t.ev(`(() => { const tour = document.getElementById('tour'); const r = tour.getBoundingClientRect();
    if (r.top > innerHeight * 0.6 || r.bottom < innerHeight * 0.4) tour.scrollIntoView({ behavior: 'instant', block: 'center' });
    return true; })()`);
  await sleep(200);
  await t.ev(`(() => { const bar = document.getElementById('anchorBar'), b = document.querySelector(${JSON.stringify(sel)});
    const br = bar.getBoundingClientRect(), r = b.getBoundingClientRect();
    if (r.left < br.left + 4) bar.scrollLeft -= (br.left + 14 - r.left);
    else if (r.right > br.right - 4) bar.scrollLeft += (r.right - br.right + 14);
    return true; })()`);
  await sleep(150);
  return t.clickEl(sel, { scroll: false });
}

const camOf = (t) => t.ev(`JSON.stringify(window.tour ? window.tour.getCamera() : null)`).then((s) => (s ? JSON.parse(s) : null));
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const glbReqs = (session) => allRequests.filter((r) => /\.glb(\?|$)/.test(r.url) && (session === undefined || r.session === session));

/* ------------------------------------------------------------------ tiny PNG reader (contrast sampling) */
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (interlace) throw new Error("interlaced png unsupported");
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(stride * height);
  let rp = 0;
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const v = raw[rp + x];
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      out[y * stride + x] = f === 0 ? v : f === 1 ? (v + a) & 255 : f === 2 ? (v + b) & 255 : f === 3 ? (v + ((a + b) >> 1)) & 255 : (v + paeth(a, b, c)) & 255;
    }
    rp += stride;
  }
  return { width, height, ch, data: out };
}
// Modal colour in a patch = the background (glyphs are a minority of pixels).
function modal(img, x0, y0, w, h) {
  const counts = new Map();
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) {
      const i = (y * img.width + x) * img.ch;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const k = `${r >> 4},${g >> 4},${b >> 4}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(",").map((n) => (parseInt(n) << 4) + 8);
  return best;
}
const lum = ([r, g, b]) => [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
  .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
const over = (fg, alpha, bg) => fg.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)));
const parseRgb = (s) => (s.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
const parseRgba = (s) => { const m = (s.match(/[\d.]+/g) || []).map(Number); return { rgb: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 }; };


/* ------------------------------------------------------------------ image statistics (no display available) */
function imgStats(file) {
  const img = decodePng(readFileSync(file));
  let sum = 0, sum2 = 0, black = 0, white = 0, n = 0; const hist = new Array(8).fill(0);
  for (let i = 0; i < img.data.length; i += img.ch * 7) {
    const l = img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
    sum += l; sum2 += l * l; n++; if (l < 8) black++; if (l > 245) white++; hist[Math.min(7, l >> 5)]++;
  }
  return { w: img.width, h: img.height, mean: +(sum / n).toFixed(1), sd: +Math.sqrt(sum2 / n - (sum / n) ** 2).toFixed(1),
    pctBlack: +(100 * black / n).toFixed(1), pctWhite: +(100 * white / n).toFixed(1), hist: hist.map((h) => +(100 * h / n).toFixed(1)) };
}
// Mean absolute luminance difference on a shared 32x18 normalised grid (0 = identical framing).
function frameDiff(fa, fb) {
  const A = decodePng(readFileSync(fa)), B = decodePng(readFileSync(fb));
  let sum = 0, n = 0;
  for (let gy = 0; gy < 18; gy++) for (let gx = 0; gx < 32; gx++) {
    const lum = (img) => { const x = Math.min(img.width - 1, Math.floor(((gx + 0.5) / 32) * img.width));
      const y = Math.min(img.height - 1, Math.floor(((gy + 0.5) / 18) * img.height)); const i = (y * img.width + x) * img.ch;
      return img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114; };
    sum += Math.abs(lum(A) - lum(B)); n++;
  }
  return +(sum / n).toFixed(1);
}

/* ------------------------------------------------------------------ A: room anchors */
async function stageA() {
  const t = await newTab({ url: BASE + "/" });
  const ready = await tourReady(t);
  if (!ready) { record("A1", "BLOCKED", "tour never became ready (model did not load)"); return t; }
  await sleep(1500);
  await t.ev(`document.getElementById('tour').scrollIntoView({ behavior: 'instant', block: 'center' })`);
  await sleep(500);

  // A1 — anchor bar contents / grouping / no "Patio"
  const items = JSON.parse(await t.ev(`(() => {
    const out = []; let cur = null;
    for (const n of document.getElementById('anchorBar').children) {
      if (n.className === 'pill-group') { cur = n.textContent; continue; }
      out.push({ group: cur, label: n.textContent, id: n.dataset.anchor });
    }
    return JSON.stringify(out); })()`));
  const expected = [
    ["Overview", "Dollhouse", "dollhouse"],
    ["Outside", "Exterior", "exterior"], ["Outside", "Garage", "garage"], ["Outside", "Balcony", "balcony"],
    ["Living", "Lounge", "lounge"], ["Living", "Dining", "dining"], ["Living", "Kitchen", "kitchen"],
    ["Living", "Rumpus", "rumpus"], ["Living", "Study Nook", "study-nook"],
    ["Bedrooms", "Master Bedroom", "master-bedroom"], ["Bedrooms", "Room 1", "room-1"],
    ["Bedrooms", "Room 2", "room-2"], ["Bedrooms", "Room 3", "room-3"],
    ["Wet areas", "Ensuite", "ensuite"], ["Wet areas", "Bathroom", "bathroom"], ["Wet areas", "Laundry", "laundry"],
  ].map(([group, label, id]) => `${group}|${label}|${id}`);
  const got = items.map((i) => `${i.group}|${i.label}|${i.id}`);
  const missing = expected.filter((e) => !got.includes(e));
  const extra = got.filter((g) => !expected.includes(g));
  const patio = items.filter((i) => /patio/i.test(i.label));
  record("A1", missing.length === 0 && extra.length === 0 && patio.length === 0 ? "PASS" : "FAIL",
    `${items.length} buttons in order ${items.map((i) => i.label).join(", ")}; groups: ${[...new Set(items.map((i) => i.group))].join(" · ")}; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} patioLabels=${patio.length}`);

  // A2 (+ screenshots for A3) — click every anchor
  const rows = [];
  for (const id of [...ROOM_ANCHORS.map((a) => a.id), DOLLHOUSE.id]) {
    const before = await camOf(t);
    const { covered, coveredBy } = await clickPill(t, id);
    await sleep(1500);
    const after = await camOf(t);
    const s = JSON.parse(await t.ev(`(() => {
      const pills = [...document.querySelectorAll('#anchorBar .pill')];
      const on = pills.filter(p => p.getAttribute('aria-pressed') === 'true').map(p => p.dataset.anchor);
      const r = document.getElementById('tour').getBoundingClientRect();
      return JSON.stringify({ hash: location.hash, on, x: r.x, y: r.y, w: r.width, h: r.height }); })()`));
    const moved = before && after ? dist3(before.pos, after.pos) : null;
    const file = `anchor-${id}.png`;
    await t.shot(file, { x: Math.round(s.x), y: Math.round(s.y), width: Math.round(s.w), height: Math.round(s.h) });
    rows.push({ id, moved, hash: s.hash, on: s.on, covered, coveredBy, file });
    log(`${id}: moved=${moved?.toFixed(3)}m hash=${s.hash} pressed=${JSON.stringify(s.on)} covered=${covered}`);
  }
  const noMove = rows.filter((r) => r.id !== "dollhouse" && (r.moved === null || r.moved < 0.02));
  const badHash = rows.filter((r) => r.hash !== `#room=${r.id}`);
  const badPressed = rows.filter((r) => r.on.length !== 1 || r.on[0] !== r.id);
  const badCover = rows.filter((r) => r.covered);
  record("A2", noMove.length || badHash.length || badPressed.length ? "FAIL" : "PASS",
    `${rows.length} anchors clicked; min camera move=${Math.min(...rows.map((r) => r.moved)).toFixed(2)}m (noMove=${JSON.stringify(noMove.map((r) => r.id))}); hashWrong=${JSON.stringify(badHash.map((r) => r.id))}; pressedWrong=${JSON.stringify(badPressed.map((r) => r.id))}; pillObscured=${JSON.stringify(badCover.map((r) => r.id + ":" + r.coveredBy))}; screenshots tests/qa/anchor-*.png`);
  writeFileSync(OUT + "anchor-state.json", JSON.stringify(rows, null, 2));

  // A5 — Tab order, Enter/Space activation, focus ring
  await t.focus(".wordmark");
  const allIds = [...ROOM_ANCHORS.map((a) => a.id), DOLLHOUSE.id];
  const seen = [];
  const pillsSeen = [];
  for (let i = 0; i < 120 && pillsSeen.length < allIds.length; i++) {
    await t.key("Tab", "Tab", 9);
    const o = JSON.parse(await t.ev(`(() => { const e = document.activeElement; if (!e || e === document.body) return JSON.stringify({ tag: 'BODY' });
      return JSON.stringify({ tag: e.tagName, id: e.id, cls: typeof e.className === 'string' ? e.className : '', anchor: e.dataset?.anchor || null }); })()`));
    if (o.tag === "BODY") break;
    if (o.cls === "pill" && o.anchor && !pillsSeen.includes(o.anchor)) pillsSeen.push(o.anchor);
    seen.push(o);
  }
  const unreached = allIds.filter((id) => !pillsSeen.includes(id));
  const ring = JSON.parse(await t.ev(`(() => { const e = document.activeElement; const s = getComputedStyle(e);
    return JSON.stringify({ outline: s.outlineWidth + ' ' + s.outlineStyle + ' ' + s.outlineColor, shadow: s.boxShadow,
      anchor: e.dataset?.anchor || null, focusVisible: e.matches(':focus-visible') }); })()`));
  if (ring.anchor) {
    await t.ev(`(() => { const bar = document.getElementById('anchorBar'); const r = document.activeElement.getBoundingClientRect();
      const br = bar.getBoundingClientRect(); if (r.right > br.right) bar.scrollLeft += r.right - br.right + 12;
      else if (r.left < br.left) bar.scrollLeft -= (br.left - r.left + 12); return 1; })()`);
    await sleep(250);
    const bb = await t.box(`#anchorBar .pill[data-anchor="${ring.anchor}"]`);
    await t.shot("focus-ring.png", { x: Math.round(bb.x - 12), y: Math.round(bb.y - 12), width: Math.round(bb.w + 24), height: Math.round(bb.h + 24) });
  }
  // Tab until a room pill (not dollhouse) has focus, then press Enter.
  for (let i = 0; i < 20; i++) {
    const a = await t.ev(`document.activeElement?.dataset?.anchor || null`);
    if (a && a !== DOLLHOUSE.id) break;
    await t.key("Tab", "Tab", 9);
    await sleep(80);
  }
  const enterAnchor = await t.ev(`document.activeElement?.dataset?.anchor || null`);
  const hashBefore = await t.ev(`location.hash`);
  const beforeEnter = await camOf(t);
  await t.key("Enter", "Enter", 13, { text: "\r" });
  await sleep(1600);
  const camEnter = await camOf(t);
  const enterMoved = dist3(beforeEnter.pos, camEnter.pos);
  const enterHash = await t.ev(`location.hash`);
  const enterPressed = await t.ev(`document.querySelector('#anchorBar .pill[data-anchor="${enterAnchor}"]')?.getAttribute('aria-pressed')`);
  // Space activates (focus the kitchen pill by keyboard-adjacent programmatic focus).
  await t.focus(`#anchorBar .pill[data-anchor="kitchen"]`);
  const beforeSpace = await camOf(t);
  await t.key(" ", "Space", 32);
  await sleep(1600);
  const spaceMoved = dist3(beforeSpace.pos, (await camOf(t)).pos);
  const spaceHash = await t.ev(`location.hash`);
  const ringVisible = ring.focusVisible && !/\bnone\b/.test(ring.outline) && !/^0px /.test(ring.outline);
  record("A5", unreached.length === 0 && enterMoved > 0.02 && spaceMoved > 0.02 && enterHash === `#room=${enterAnchor}` ? (ringVisible ? "PASS" : "PARTIAL") : "FAIL",
    `Tab reached ${pillsSeen.length}/${allIds.length} pills (unreached=${JSON.stringify(unreached)}); last focused=${ring.anchor} :focus-visible=${ring.focusVisible} outline="${ring.outline}" (focus-ring.png); Enter on ${enterAnchor}: moved ${enterMoved.toFixed(2)}m hash ${hashBefore}→${enterHash} aria-pressed=${enterPressed}; Space on kitchen: moved ${spaceMoved.toFixed(2)}m → ${spaceHash}`);
  return t;
}

/* ------------------------------------------------------------------ A3: what each anchor view shows */
const REF_DIR = "/Users/cjlubosana/.copilot/session-state/054e8b60-b6bb-427f-948f-42dbf90751fb/files/shots-orig/";
async function stageA3() {
  const t = await newTab({ url: BASE + "/" });
  if (!(await tourReady(t))) { record("A3", "BLOCKED", "tour never became ready"); await t.close(); return; }
  await sleep(1500);
  const rows = [];
  for (const a of ROOM_ANCHORS) {
    const expr = `(async () => {
      const { Ray } = await import('/node_modules/@babylonjs/core/Culling/ray.js');
      const { Vector3 } = await import('/node_modules/@babylonjs/core/Maths/math.vector.js');
      const sc = window.__scene; if (!sc) return JSON.stringify({ error: 'no scene' });
      const solid = (m) => m.isEnabled() && m.checkCollisions;
      const visible = (m) => m.isEnabled() && m.isPickable !== false && m.name !== 'sky' && m.isVisible !== false && m.visibility > 0 && (m.material && m.material.alpha || 1) > 0;
      const P = ${JSON.stringify(a.pos)};
      const mk = (x, y, z) => new Vector3(x, y, z);
      const dir = (yaw, pitch) => mk(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      const hits = [];
      for (const dy of [-0.34, -0.17, 0, 0.17, 0.34]) for (const dp of [-0.18, 0, 0.18]) {
        const h = sc.pickWithRay(new Ray(mk(P[0], P[1], P[2]), dir(${a.yaw} + dy, ${a.pitch} + dp), 30), visible);
        if (h && h.hit) hits.push({ mesh: h.pickedMesh.name, mat: (h.pickedMesh.material && h.pickedMesh.material.name) || '-', d: +h.distance.toFixed(2) });
      }
      const embedded = [];
      for (const d of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const h = sc.pickWithRay(new Ray(mk(P[0], P[1], P[2]), mk(d[0], d[1], d[2]), 0.12), solid);
        if (h && h.hit) embedded.push(h.pickedMesh.name);
      }
      const down = sc.pickWithRay(new Ray(mk(P[0], P[1], P[2]), mk(0, -1, 0), 60), solid);
      const c = sc.pickWithRay(new Ray(mk(P[0], P[1], P[2]), dir(${a.yaw}, ${a.pitch}), 40), visible);
      const ds = hits.map((h) => h.d);
      const mats = {}; for (const h of hits) mats[h.mat] = (mats[h.mat] || 0) + 1;
      return JSON.stringify({ seen: hits.length, minD: ds.length ? Math.min.apply(null, ds) : null,
        centreD: c && c.hit ? +c.distance.toFixed(2) : null,
        centreMesh: c && c.hit ? c.pickedMesh.name + ' (' + ((c.pickedMesh.material && c.pickedMesh.material.name) || '-') + ')' : 'open sky',
        floorDrop: down && down.hit ? +down.distance.toFixed(2) : null, embedded,
        top: Object.entries(mats).sort((x, y) => y[1] - x[1]).slice(0, 6) }); })()`;
    const r = JSON.parse(await t.ev(expr));
    const mine = OUT + `anchor-${a.id}.png`, ref = REF_DIR + `anchor-${a.id}.png`;
    const st = existsSync(mine) ? imgStats(mine) : null;
    const rs = existsSync(ref) ? imgStats(ref) : null;
    const diff = st && rs ? frameDiff(mine, ref) : null;
    rows.push({ id: a.id, ...r, mine: st, ref: rs, diff });
    log(`${a.id}: centre ${r.centreD}m on ${r.centreMesh}; ${r.seen}/15 rays min=${r.minD}m floor=${r.floorDrop}m embedded=${(r.embedded || []).length} mats=${JSON.stringify(r.top.map(([m, n]) => m + "x" + n))} | mine mean=${st?.mean} sd=${st?.sd} black=${st?.pctBlack}% ref mean=${rs?.mean} diff=${diff}`);
  }
  const blackFrames = rows.filter((r) => r.mine && (r.mine.mean < 20 || r.mine.pctBlack > 70));
  const insideWall = rows.filter((r) => (r.embedded || []).length >= 4);
  const floating = rows.filter((r) => r.floorDrop !== null && (r.floorDrop > 4 || r.floorDrop < 0.3));
  const centreBlocked = rows.filter((r) => r.centreD !== null && r.centreD < 0.5);
  const tooClose = rows.filter((r) => r.minD !== null && r.minD < 0.5);
  const blind = rows.filter((r) => !r.seen);
  const okProg = !blackFrames.length && !insideWall.length && !tooClose.length && !blind.length && !floating.length && !centreBlocked.length;
  record("A3", okProg ? "PARTIAL" : "FAIL",
    `HUMAN visual check BLOCKED (no image display in this verifier environment; all 15 PNGs were still captured to tests/qa/ and analysed). Programmatic: black=${JSON.stringify(blackFrames.map((r) => r.id))} embeddedInSolid=${JSON.stringify(insideWall.map((r) => r.id))} offFloor=${JSON.stringify(floating.map((r) => r.id + ":" + r.floorDrop))} centreWallUnder0.5m=${JSON.stringify(centreBlocked.map((r) => r.id))} anyRayUnder0.5m=${JSON.stringify(tooClose.map((r) => r.id))} noHits=${JSON.stringify(blind.map((r) => r.id))}; frameDiff vs pre-refactor reference (informational, different aspect 16:9 vs 16:10)=${JSON.stringify(rows.map((r) => r.id + ":" + r.diff))}; per-anchor visible materials in tests/qa/a3-report.json`);
  writeFileSync(OUT + "a3-report.json", JSON.stringify(rows, null, 2));
  await t.close();
}

/* ------------------------------------------------------------------ A4 deep links */
async function stageA4() {
  for (const id of ["dining", "master-bedroom"]) {
    const t = await newTab({ url: BASE + `/#room=${id}` });
    const ok = await t.settle(`!!(window.tour && window.tour.isReady())`, 180000);
    if (!ok) { record(`A4-${id}`, "BLOCKED", "tour never became ready without user input"); await t.close(); continue; }
    await sleep(2500);
    const cam = await camOf(t);
    const posterHidden = await t.ev(`document.getElementById('tourPoster').hidden`);
    const a = ROOM_ANCHORS.find((x) => x.id === id);
    const d = dist3(cam.pos, a.pos);
    const hash = await t.ev(`location.hash`);
    record(`A4-${id}`, d <= 0.5 ? "PASS" : "FAIL",
      `no click needed (poster hidden on load=${posterHidden}); camera=${cam.pos.map((n) => n.toFixed(2))} anchor=${a.pos} dist=${d.toFixed(3)}m hash=${hash}`);
    await t.close();
  }
}

/* ------------------------------------------------------------------ B: fullscreen */
async function stageB(t) {
  if (!t) { t = await newTab({ url: BASE + "/" }); await tourReady(t); await sleep(1500); }
  await t.ev(`document.getElementById('tour-section').scrollIntoView({ behavior: 'instant', block: 'center' })`);
  await sleep(500);
  const beforeY = await t.ev(`window.scrollY`);
  const pre = await t.box("#renderCanvas");
  await t.clickEl("#fsBtn");
  await sleep(1000);
  const fs = JSON.parse(await t.ev(`JSON.stringify({
    native: !!document.fullscreenElement,
    fsEl: document.fullscreenElement ? (document.fullscreenElement.id || document.fullscreenElement.tagName) : null,
    pseudo: document.getElementById('tour').classList.contains('pseudo-fullscreen'),
    label: document.getElementById('fsLabel').textContent,
    cw: document.getElementById('renderCanvas').clientWidth,
    ch: document.getElementById('renderCanvas').clientHeight,
    iw: innerWidth, ih: innerHeight,
    rect: (() => { const r = document.getElementById('tour').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
  })`));
  const sizeOk = Math.abs(fs.cw - fs.iw) <= 2 && Math.abs(fs.ch - fs.ih) <= 2;
  const which = fs.native ? fs.fsEl === "tour" : fs.pseudo;
  record("B1", sizeOk && which ? "PASS" : "PARTIAL",
    `nativeFullscreen=${fs.native} fullscreenElement=${fs.fsEl} pseudoFallback=${fs.pseudo} tourRect=${JSON.stringify(fs.rect)} canvas=${fs.cw}x${fs.ch} viewport=${fs.iw}x${fs.ih} label="${fs.label}"`);

  // B2 — bar + exit button visible; anchor click still works
  const vis = JSON.parse(await t.ev(`(() => {
    const vb = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= -1 && r.bottom <= innerHeight + 1 && getComputedStyle(e).display !== 'none'; };
    const bar = document.getElementById('anchorBar'), btn = document.getElementById('fsBtn');
    return JSON.stringify({ bar: vb(bar), exit: vb(btn), exitLabel: btn.textContent.trim() }); })()`));
  const camBefore = await camOf(t);
  // Choose the anchor the camera is furthest from, so "did it move" is a real test.
  const far = ROOM_ANCHORS.map((a) => ({ id: a.id, d: dist3(camBefore.pos, a.pos) })).sort((x, y) => y.d - x.d)[0];
  const pill = await clickPill(t, far.id);
  await sleep(1600);
  const moved = dist3(camBefore.pos, (await camOf(t)).pos);
  await t.shot("fullscreen.png");
  record("B2", vis.bar && vis.exit && moved > 0.02 ? "PASS" : "FAIL",
    `anchorBarVisible=${vis.bar} exitBtnVisible=${vis.exit} label="${vis.exitLabel}" · click ${far.id} (${far.d.toFixed(1)}m away) moved ${moved.toFixed(2)}m (pillCovered=${pill.covered}) · fullscreen.png`);

  // B3 — exit by button, re-enter, exit by Esc; canvas size + scroll restored
  await t.clickEl("#fsBtn");
  await sleep(1000);
  const afterBtn = JSON.parse(await t.ev(`JSON.stringify({ fs: !!document.fullscreenElement, pseudo: document.getElementById('tour').classList.contains('pseudo-fullscreen'), y: Math.round(window.scrollY), dh: document.documentElement.scrollHeight })`));
  await t.clickEl("#fsBtn");
  await sleep(1000);
  const re = JSON.parse(await t.ev(`JSON.stringify({ fs: !!document.fullscreenElement, pseudo: document.getElementById('tour').classList.contains('pseudo-fullscreen'), y: Math.round(window.scrollY) })`));
  await t.key("Escape", "Escape", 27);
  await sleep(1200);
  const esc = JSON.parse(await t.ev(`JSON.stringify({ fs: !!document.fullscreenElement, pseudo: document.getElementById('tour').classList.contains('pseudo-fullscreen'), cw: document.getElementById('renderCanvas').clientWidth, ch: document.getElementById('renderCanvas').clientHeight, y: Math.round(window.scrollY), dh: document.documentElement.scrollHeight })`));
  const sizeBack = Math.abs(esc.cw - pre.w) <= 2 && Math.abs(esc.ch - pre.h) <= 2;
  const scrollBack = Math.abs(esc.y - beforeY) <= 50;
  record("B3", !afterBtn.fs && !afterBtn.pseudo && (re.fs || re.pseudo) && !esc.fs && !esc.pseudo && sizeBack && scrollBack ? "PASS" : "PARTIAL",
    `exitByButton={fs:${afterBtn.fs},pseudo:${afterBtn.pseudo}} reentered={fs:${re.fs},pseudo:${re.pseudo}} exitByEsc={fs:${esc.fs},pseudo:${esc.pseudo}} canvas=${esc.cw}x${esc.ch} expected=${Math.round(pre.w)}x${Math.round(pre.h)} (±2) scroll: before=${beforeY} inFs=${re.y} afterBtnExit=${afterBtn.y} afterEscExit=${esc.y} (Δ${esc.y - beforeY} vs ±50; docHeight ${afterBtn.dh}→${esc.dh})`);
  return t;
}

/* ------------------------------------------------------------------ C: funnel + form */
async function stageC() {
  const t = await newTab({ width: 1440, height: 900, url: BASE + "/" });
  await sleep(800);
  const apiCount = () => allRequests.filter((r) => r.url.includes("/api/tour-requests") && r.session === t.sessionId).length;

  // C1 above the fold (desktop)
  const cta = await t.box('a.btn-primary[href="#contact"]');
  const inFold = cta && cta.y >= 0 && cta.y + cta.h <= 900 && cta.x >= 0 && cta.x + cta.w <= 1440;
  await t.clickEl('a.btn-primary[href="#contact"]');
  await sleep(1500);
  const formInView = JSON.parse(await t.ev(`(() => { const r = document.getElementById('tourForm').getBoundingClientRect();
    return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.top < innerHeight && r.bottom > 0 }); })()`));
  record("C1-desktop", inFold && formInView.visible ? "PASS" : "FAIL",
    `CTA rect=${JSON.stringify(cta && { x: Math.round(cta.x), y: Math.round(cta.y), w: Math.round(cta.w), h: Math.round(cta.h) })} insideFold=${!!inFold}; after click form top=${formInView.top} bottom=${formInView.bottom} inView=${formInView.visible}`);

  // C2 sticky header (desktop)
  await t.ev(`window.scrollTo({ top: 2000, behavior: 'instant' })`);
  await sleep(600);
  const head = await t.box(".btn-header");
  const sticky = head && head.y >= 0 && head.y < 90 && head.w > 0;
  record("C2-desktop", sticky ? "PASS" : "FAIL",
    `position=${await t.ev(`getComputedStyle(document.querySelector('.site-header')).position`)}; after scrollY=2000 header CTA rect=${JSON.stringify(head && { x: Math.round(head.x), y: Math.round(head.y), w: Math.round(head.w), h: Math.round(head.h) })}`);

  // C3 empty submit
  await t.ev(`document.getElementById('contact').scrollIntoView({ behavior: 'instant', block: 'center' })`);
  await sleep(500);
  const reqBefore = apiCount();
  await t.clickEl("#submitBtn");
  await sleep(800);
  const c3 = JSON.parse(await t.ev(`(() => { const f = (id, eid) => { const e = document.getElementById(id);
      return { invalid: e.getAttribute('aria-invalid'), err: (document.getElementById(eid)?.textContent || '').trim() }; };
    return JSON.stringify({ name: f('f-name','err-name'), email: f('f-email','err-email'), phone: f('f-phone','err-phone'),
      date: f('f-date','err-date'), time: f('f-time','err-time'), focus: document.activeElement?.id,
      status: document.getElementById('formStatus').textContent }); })()`));
  const keys = ["name", "email", "phone", "date", "time"];
  const allBad = keys.every((k) => c3[k].invalid === "true" && c3[k].err.length > 0);
  const c3box = await t.box("#tourForm");
  await t.shot("form-errors.png", { x: Math.round(c3box.x), y: Math.round(c3box.y), width: Math.round(c3box.w), height: Math.round(c3box.h) });
  record("C3", apiCount() === reqBefore && allBad && c3.focus === "f-name" ? "PASS" : "FAIL",
    `POSTs during submit=${apiCount() - reqBefore}; ${keys.map((k) => `${k}: invalid=${c3[k].invalid} msg="${c3[k].err}"`).join(" | ")}; focus=${c3.focus}; status="${c3.status}"`);

  // C4 invalid email + past date
  await t.clickEl("#f-name"); await send("Input.insertText", { text: "QA Verifier" }, t.sessionId);
  await t.clickEl("#f-email"); await send("Input.insertText", { text: "foo@" }, t.sessionId);
  await t.clickEl("#f-phone"); await send("Input.insertText", { text: "+61 400 111 222" }, t.sessionId);
  const pastDate = await t.ev(`(() => { const d = new Date(); d.setDate(d.getDate() - 5); const p = (n) => String(n).padStart(2, '0');
    const el = document.getElementById('f-date'); el.value = \`\${d.getFullYear()}-\${p(d.getMonth()+1)}-\${p(d.getDate())}\`;
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
  await t.ev(`(() => { const s = document.getElementById('f-time'); s.value = 'afternoon';
    s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  const reqB2 = apiCount();
  await t.clickEl("#submitBtn");
  await sleep(800);
  const c4 = JSON.parse(await t.ev(`JSON.stringify({ email: document.getElementById('err-email').textContent,
    date: document.getElementById('err-date').textContent,
    invalid: [document.getElementById('f-email').getAttribute('aria-invalid'), document.getElementById('f-date').getAttribute('aria-invalid')],
    focus: document.activeElement?.id })`));
  record("C4", apiCount() === reqB2 && /valid email/i.test(c4.email) && c4.invalid[0] === "true" && c4.date.length > 0 && c4.invalid[1] === "true" ? "PASS" : "FAIL",
    `POSTs=${apiCount() - reqB2}; email error="${c4.email}" aria-invalid=${c4.invalid[0]}; date(${pastDate}) error="${c4.date}" aria-invalid=${c4.invalid[1]}; focus=${c4.focus}`);

  // C5 valid submit
  await t.clickEl("#f-email");
  await t.ev(`(() => { const e = document.getElementById('f-email'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await send("Input.insertText", { text: QA_EMAIL }, t.sessionId);
  const future = await t.ev(`(() => { const d = new Date(); d.setDate(d.getDate() + 6); const p = (n) => String(n).padStart(2, '0');
    const el = document.getElementById('f-date'); el.value = \`\${d.getFullYear()}-\${p(d.getMonth()+1)}-\${p(d.getDate())}\`;
    el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`);
  const reqB3 = apiCount();
  await t.clickEl("#submitBtn");
  await sleep(2000);
  const c5 = JSON.parse(await t.ev(`(() => { const card = document.querySelector('.confirm-card');
    return JSON.stringify({ card: card ? card.textContent.replace(/\\s+/g, ' ').trim() : null,
      when: document.getElementById('cf-when')?.textContent || null,
      formHidden: document.getElementById('tourForm').hidden,
      status: document.getElementById('formStatus').textContent }); })()`));
  const postCount = apiCount() - reqB3;
  const apiResp = netEvents.filter((n) => n.url.includes("/api/tour-requests") && n.session === t.sessionId);
  const lastStatus = apiResp.length ? apiResp[apiResp.length - 1].status : null;
  record("C5", postCount === 1 && lastStatus === 201 && c5.card?.includes(future) && /Afternoon/.test(c5.card || "") ? "PASS" : "FAIL",
    `POSTs=${postCount} status=${lastStatus}; email=${QA_EMAIL}; date=${future}; confirmation="${(c5.card || "").slice(0, 200)}"; formHidden=${c5.formHidden}; statusLine="${c5.status}"`);
  const contact = await t.box("#contact");
  await t.shot("form-confirm.png", { x: Math.round(contact.x), y: Math.round(contact.y), width: Math.round(contact.w), height: Math.round(contact.h) });
  await t.close();

  // mobile 390x844
  const m = await newTab({ width: 390, height: 844, url: BASE + "/" });
  await sleep(1000);
  const mcta = JSON.parse(await m.ev(`(() => {
    const links = [...document.querySelectorAll('a.btn-primary')].filter(a => /schedule/i.test(a.textContent));
    const fold = links.map(a => a.getBoundingClientRect()).filter(r => r.top >= 0 && r.bottom <= innerHeight && r.width > 0);
    const bar = document.getElementById('mobileCta'); const br = bar.getBoundingClientRect(); const bs = getComputedStyle(bar);
    return JSON.stringify({ ctas: links.length, foldCtas: fold.length, bar: { display: bs.display, top: Math.round(br.top), h: Math.round(br.height), hidden: bar.classList.contains('hidden') } }); })()`));
  await m.clickEl('a.btn-primary[href="#contact"]');
  await sleep(1600);
  const mform = JSON.parse(await m.ev(`(() => { const r = document.getElementById('tourForm').getBoundingClientRect();
    return JSON.stringify({ inView: r.top < innerHeight && r.bottom > 0, top: Math.round(r.top), barHidden: document.getElementById('mobileCta').classList.contains('hidden') }); })()`));
  record("C1-mobile", mcta.foldCtas > 0 && mform.inView ? "PASS" : "FAIL",
    `${mcta.ctas} "Schedule a tour" CTAs, ${mcta.foldCtas} fully above the 390x844 fold; after click form top=${mform.top} inView=${mform.inView}`);
  record("C2-mobile", mcta.bar.display === "flex" && !mcta.bar.hidden && mform.barHidden ? "PASS" : "FAIL",
    `bottom bar display=${mcta.bar.display} top=${mcta.bar.top} height=${mcta.bar.h} hiddenAtTop=${mcta.bar.hidden}; hiddenWhenFormInView=${mform.barHidden}`);
  await m.ev(`window.scrollTo({ top: 2000, behavior: 'instant' })`);
  await sleep(500);
  log("mobile header CTA @scrollY=2000:", JSON.stringify(await m.box(".btn-header")));
  await m.close();
}

/* ------------------------------------------------------------------ D: design/layout */
async function stageD() {
  for (const [w, h] of [[1440, 900], [768, 1024], [390, 844]]) {
    const t = await newTab({ width: w, height: h, url: BASE + "/" });
    await sleep(1000);
    await t.ev(`(async () => { const H = document.body.scrollHeight;
      for (let y = 0; y <= H; y += Math.round(innerHeight * 0.6)) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 100)); }
      window.scrollTo(0, 0); return true; })()`);
    await sleep(1200);
    await t.shot(`page-${w}.png`, null);
    const st1 = imgStats(OUT + `page-${w}.png`);
    const secs = JSON.parse(await t.ev(`JSON.stringify([...document.querySelectorAll('header.site-header, main > section, footer.site-footer')].map(e => { const r = e.getBoundingClientRect();
      return (e.id || (typeof e.className === 'string' ? e.className.split(' ')[0] : e.tagName)) + ":" + Math.round(r.top + window.scrollY) + "+" + Math.round(r.height); }))`));
    record(`D1-${w}`, st1.mean > 30 && st1.pctBlack < 60 && st1.sd > 20 ? "PARTIAL" : "FAIL",
      `tests/qa/page-${w}.png ${st1.w}x${st1.h} mean=${st1.mean} sd=${st1.sd} black=${st1.pctBlack}% (painted, not a blank frame); document order ${JSON.stringify(secs)}; HUMAN visual review BLOCKED — this verifier environment cannot display images`);
    const ov = JSON.parse(await t.ev(`(() => {
      const bad = [];
      for (const e of document.querySelectorAll('body *')) {
        const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        if (s.position === 'fixed' || s.display === 'none') continue;
        if (r.width > innerWidth + 1 || r.right > innerWidth + 1.5) {
          bad.push({ sel: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).join('.') : ''),
            w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), pos: s.position, pOverflowX: getComputedStyle(e.parentElement).overflowX });
        }
      }
      // off-screen-left positioned boxes (honeypot / sr-only) are intentional, list separately
      const offLeft = [...document.querySelectorAll('body *')].filter((e) => {
        const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return s.position === 'absolute' && r.right < 0 && r.width > 0;
      }).map((e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]));
      return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, bad: bad.slice(0, 15), offLeft: offLeft.slice(0, 6) }); })()`));
    const real = ov.bad.filter((b) => b.pOverflowX !== "auto" && b.pOverflowX !== "scroll");
    record(`D2-${w}`, ov.scrollWidth <= ov.clientWidth && real.length === 0 ? "PASS" : "FAIL",
      `documentElement scrollWidth=${ov.scrollWidth} clientWidth=${ov.clientWidth}; wider-than-viewport offenders=${JSON.stringify(real.slice(0, 6))}; off-screen-left positioned (intentional, no overflow)=${JSON.stringify(ov.offLeft)}`);
    if (w === 1440) {
      const styles = JSON.parse(await t.ev(`(() => {
        const cs = (sel, props) => { const e = document.querySelector(sel); if (!e) return { sel, missing: true }; const s = getComputedStyle(e);
          const o = { sel }; for (const p of props) o[p] = s[p]; return o; };
        return JSON.stringify([
          cs('body', ['backgroundColor','color','fontFamily','fontSize','lineHeight']),
          cs('.hero h1', ['fontSize','fontWeight','letterSpacing','lineHeight','color','fontFamily','textTransform']),
          cs('.field label', ['fontSize','letterSpacing','textTransform','color','fontWeight']),
          cs('.btn-primary', ['backgroundColor','color','borderRadius','boxShadow','textTransform','letterSpacing','fontSize','border','backgroundImage']),
          cs('.site-header', ['position','boxShadow','borderBottomWidth']),
          cs('.wm-a', ['fontFamily']),
          cs('.lede', ['fontFamily','fontSize','lineHeight','color']),
          cs('.card', ['boxShadow','border','borderRadius']),
          cs('section', ['marginTop','marginBottom']),
          cs('#residence', ['marginTop','marginBottom']),
          cs('.plan-wrap', ['border','boxShadow','backgroundColor']),
        ]); })()`));
      const cssVar = await t.ev(`getComputedStyle(document.documentElement).getPropertyValue('--sec') + '|' + getComputedStyle(document.documentElement).getPropertyValue('--font-body')`);
      log("--sec =", cssVar);
      writeFileSync(OUT + "computed-styles.json", JSON.stringify(styles, null, 2));
      log("computed:", JSON.stringify(styles));
      const shadows = JSON.parse(await t.ev(`JSON.stringify([...document.querySelectorAll('body *')].filter(e => {
        const s = getComputedStyle(e); return s.boxShadow !== 'none' && s.display !== 'none' && e.offsetParent !== null; })
        .map(e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0])).slice(0, 15))`));
      log("elements with box-shadow:", JSON.stringify(shadows));
      const S = Object.fromEntries(styles.map((s) => [s.sel, s]));
      const offWhite = S.body.backgroundColor === "rgb(251, 250, 248)";
      const blackInk = S.body.color === "rgb(17, 17, 17)";
      const blackBtn = S[".btn-primary"].backgroundColor === "rgb(17, 17, 17)" && S[".btn-primary"].boxShadow === "none";
      const capsLabel = S[".field label"].textTransform === "uppercase" && parseFloat(S[".field label"].letterSpacing) >= 1;
      const tightBig = parseFloat(S[".hero h1"].fontSize) >= 40 && parseFloat(S[".hero h1"].letterSpacing) < 0 && Number(S[".hero h1"].fontWeight) >= 600;
      const spacing = parseFloat(S["#residence"].marginTop) >= 64;
      const noShadows = shadows.length === 0;
      const displayFont = /Inter Tight/.test(S[".hero h1"].fontFamily || "");
      record("D3", offWhite && blackInk && blackBtn && capsLabel && tightBig && spacing && noShadows ? (displayFont ? "PASS" : "PARTIAL") : "FAIL",
        `body bg=${S.body.backgroundColor} ink=${S.body.color}; h1 ${S[".hero h1"].fontSize}/${S[".hero h1"].fontWeight}/letter-spacing ${S[".hero h1"].letterSpacing} family="${S[".hero h1"].fontFamily}" (wordmark uses "${S[".wm-a"].fontFamily}"); label ${S[".field label"].fontSize} uppercase=${S[".field label"].textTransform} tracking=${S[".field label"].letterSpacing}; primary btn bg=${S[".btn-primary"].backgroundColor} radius=${S[".btn-primary"].borderRadius} shadow=${S[".btn-primary"].boxShadow} uppercase=${S[".btn-primary"].textTransform}; section margin=${S["#residence"].marginTop}; elements with box-shadow=${shadows.length}; header border-bottom=${S[".site-header"].borderBottomWidth}`);
      const imgs = JSON.parse(await t.ev(`JSON.stringify([...document.images].map(i => ({ src: (i.currentSrc || i.src), nw: i.naturalWidth, alt: i.alt })))`));
      const broken = imgs.filter((i) => !i.nw);
      const noAlt = imgs.filter((i) => !i.alt.trim());
      const external = imgs.filter((i) => /^https?:/.test(i.src) && !i.src.startsWith(BASE));
      record("D4", broken.length === 0 && noAlt.length === 0 && external.length === 0 ? "PASS" : "FAIL",
        `${imgs.length} <img>: broken=${JSON.stringify(broken.map((b) => b.src))} emptyAlt=${JSON.stringify(noAlt.map((b) => b.src))} externalHotlinks=${JSON.stringify(external.map((b) => b.src))}; srcs=${imgs.map((i) => i.src.replace(BASE, "")).join(" ")}`);
      const c = JSON.parse(await t.ev(`(() => { const g = (sel, p) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[p] : null; };
        const rect = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect().toJSON() : null; };
        return JSON.stringify({ bg: g('body','backgroundColor'), ink: g('body','color'),
          muted: g('#residence .eyebrow','color'), mutedRect: rect('#residence .eyebrow'),
          heroColor: g('.hero h1','color'), heroRect: rect('.hero h1'),
          heroEyebrow: g('.hero-eyebrow','color'), heroEyebrowRect: rect('.hero-eyebrow'),
          heroFacts: g('.hero-facts','color'), heroFactsRect: rect('.hero-facts') }); })()`));
      const img = decodePng(readFileSync(OUT + "page-1440.png"));
      const bodyR = ratio(parseRgb(c.ink), parseRgb(c.bg));
      const mutedR = ratio(parseRgb(c.muted), parseRgb(c.bg));
      // Sample the backdrop in the strip immediately to the RIGHT of the text box (no glyphs of
      // that element live there), falling back to a strip to its left.
      const scrimAt = (r) => { const h = Math.max(8, Math.round(r.height * 0.5)); const x = Math.round(r.x + r.width + 12);
        if (x + 90 < img.width) return modal(img, x, Math.round(r.y + r.height * 0.25), 90, h);
        return modal(img, Math.round(Math.max(0, r.x - 102)), Math.round(r.y + r.height * 0.25), 90, h); };
      const hp = scrimAt(c.heroRect);
      const heroR = ratio(parseRgb(c.heroColor), hp);
      const ep = c.heroEyebrowRect ? scrimAt(c.heroEyebrowRect) : hp;
      const eA = parseRgba(c.heroEyebrow);
      const eyebrowR = ratio(over(eA.rgb, eA.a, ep), ep);
      const fp = c.heroFactsRect ? scrimAt(c.heroFactsRect) : hp;
      const fA = parseRgba(c.heroFacts);
      const factsR = ratio(over(fA.rgb, fA.a, fp), fp);
      // overlay text drawn on the live 3D scene (pill labels)
      let pillR = null, pillBg = null;
      await t.ev(`document.getElementById('tour').scrollIntoView({ behavior: 'instant', block: 'center' })`);
      const tourReady2 = await t.settle(`!!(window.tour && window.tour.isReady())`, 180000);
      if (tourReady2) {
        await sleep(2500);
        const tb = await t.box("#tour");
        await t.shot("tour-1440.png", { x: Math.round(tb.x), y: Math.round(tb.y), width: Math.round(tb.w), height: Math.round(tb.h) });
        const o = JSON.parse(await t.ev(`(() => { const p = document.querySelector('#anchorBar .pill');
          return JSON.stringify({ pr: p.getBoundingClientRect().toJSON(), pc: getComputedStyle(p).color }); })()`));
        const timg = decodePng(readFileSync(OUT + "tour-1440.png"));
        const at = (r) => [Math.round(r.x - tb.x), Math.round(r.y - tb.y)];
        const pp = at(o.pr);
        pillBg = modal(timg, pp[0] + 5, pp[1] + 5, Math.round(o.pr.width) - 10, Math.round(o.pr.height) - 10);
        const pA = parseRgba(o.pc);
        pillR = ratio(over(pA.rgb, pA.a, pillBg), pillBg);
      }
      const extras = [[pillR, "pill"], [eyebrowR, "hero eyebrow"], [factsR, "hero facts"]]
        .filter(([v]) => v !== null && v < 4.5).map(([v, n]) => `${n} ${v.toFixed(2)}:1`);
      record("D5", bodyR >= 4.5 && mutedR >= 4.5 && heroR >= 3 ? (extras.length === 0 ? "PASS" : "PARTIAL") : "FAIL",
        `body ${c.ink} on ${c.bg} = ${bodyR.toFixed(2)}:1; muted label ${c.muted} on ${c.bg} = ${mutedR.toFixed(2)}:1; hero title ${c.heroColor} over sampled scrim rgb(${hp}) = ${heroR.toFixed(2)}:1 (96px/700 → ≥3:1); hero eyebrow ${c.heroEyebrow} over rgb(${ep}) = ${eyebrowR.toFixed(2)}:1; hero facts ${c.heroFacts} over rgb(${fp}) = ${factsR.toFixed(2)}:1; pill label over sampled rgb(${pillBg}) = ${pillR === null ? "n/a" : pillR.toFixed(2) + ":1"}; below 4.5:1 → ${JSON.stringify(extras)}`);
      await t.ev(`document.getElementById('floor-plan').scrollIntoView({ behavior: 'instant', block: 'center' })`);
      await sleep(500);
      const pb = await t.box(".plan-wrap");
      await t.shot("plan-1440.png", { x: Math.round(pb.x), y: Math.round(pb.y), width: Math.round(pb.w), height: Math.round(pb.h) });
      const planText = JSON.parse(await t.ev(`JSON.stringify({ h2: document.querySelector('#floor-plan h2').textContent.trim(),
        sub: document.querySelector('#floor-plan .section-sub').textContent.trim(),
        cells: [...document.querySelectorAll('.plan-room')].map(g => { const r = g.querySelector('rect');
          return { id: g.dataset.anchor, x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }; }),
        statics: [...document.querySelectorAll('#floor-plan .plan-static')].map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') })),
        staticLabels: [...document.querySelectorAll('#floor-plan text.plan-sub')].map(e => e.textContent.trim()),
        shell: (() => { const r = document.querySelector('.plan-wall'); return { x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }; })() })`));
      writeFileSync(OUT + "plan.json", JSON.stringify(planText, null, 2));
      // D6 — compare the schematic with the real one-storey, two-row layout (west = left, +z = north).
      const rowOf = {};
      for (const a of ROOM_ANCHORS) if (!["exterior", "garage", "balcony"].includes(a.id)) rowOf[a.id] = a.pos[2] < 0 ? "A(south)" : "B(north)";
      const bandOf = (c) => { const mid = c.y + c.h / 2; return mid < 160 ? "top" : mid < 270 ? "middle" : "bottom"; };
      const cells = planText.cells.filter((c) => rowOf[c.id]);
      const byBand = {};
      for (const c of cells) (byBand[bandOf(c)] ||= []).push(`${c.id}=${rowOf[c.id]}`);
      const bandCountFor = (row) => Object.entries(byBand).filter(([, v]) => v.some((s) => s.endsWith(row))).map(([b]) => b);
      const rowsSplit = { A: bandCountFor("A(south)"), B: bandCountFor("B(north)") };
      const drawnRows = Object.keys(byBand);
      const corridorBand = drawnRows.find((b) => (byBand[b] || []).length === 0) || null;
      const missing = Object.keys(rowOf).filter((id) => !planText.cells.some((c) => c.id === id));
      const wings = /wing/i.test(planText.h2 + " " + planText.sub);
      record("D6", !wings && rowsSplit.A.length === 1 && rowsSplit.B.length === 1 && corridorBand && missing.length === 0 ? "PASS" : "FAIL",
        `heading="${planText.h2}" (mentions wings: ${wings}); drawn bands ${JSON.stringify(byBand)}; real Row A drawn across ${JSON.stringify(rowsSplit.A)} bands, Row B across ${JSON.stringify(rowsSplit.B)}; empty corridor band=${corridorBand}; anchor rooms missing from the schematic=${JSON.stringify(missing)} (exterior/garage/balcony drawn as outside cells: ${JSON.stringify(planText.cells.filter((c) => ["balcony", "garage"].includes(c.id)).map((c) => c.id))}); static labels=${JSON.stringify(planText.staticLabels)}`);
    }
    await t.close();
  }
}

/* ------------------------------------------------------------------ E: behaviour */
async function stageE() {
  const t = await newTab({ width: 1440, height: 900, url: BASE + "/" });
  await sleep(5000);
  const glbEarly = glbReqs(t.sessionId).length;
  const rectTop = await t.ev(`Math.round(document.getElementById('tour').getBoundingClientRect().top + window.scrollY)`);
  const poster = await t.ev(`(() => { const p = document.getElementById('tourPoster'); return JSON.stringify({ hidden: p.hidden, cls: p.className, msg: document.getElementById('loadMsg').textContent }); })()`);
  log(`#tour document y=${rectTop}px (viewport 900, IO rootMargin bottom=+100% → triggers when within 900px); glb reqs after 5s idle=${glbEarly}; poster=${poster}`);
  await t.ev(`window.scrollTo({ top: Math.max(0, ${rectTop} - 800), behavior: 'instant' })`);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && glbReqs(t.sessionId).length === 0) await sleep(300);
  const glbAfter = glbReqs(t.sessionId).length;
  record("E1", glbEarly === 0 && glbAfter >= 1 ? "PASS" : "FAIL",
    `.glb requests on initial load without scrolling=${glbEarly} (#tour at y=${rectTop}px, lazy IO rootMargin '0px 0px 100% 0px' → fires once the section is within one viewport); after scrolling to y=${Math.max(0, rectTop - 800)}: ${glbAfter} request(s) ${JSON.stringify(glbReqs(t.sessionId).map((r) => r.url.split("/").pop()))}`);

  // E2 wheel / capture / Esc
  const ready = await tourReady(t);
  if (!ready) record("E2", "BLOCKED", "tour never became ready");
  else {
    await sleep(1500);
    await t.ev(`document.getElementById('tour-section').scrollIntoView({ behavior: 'instant', block: 'center' })`);
    await sleep(600);
    let cb = await t.box("#renderCanvas");
    const y0 = await t.ev(`window.scrollY`);
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(cb.cx), y: Math.round(cb.cy), deltaX: 0, deltaY: 300 }, t.sessionId);
    await sleep(1200);
    const y1 = await t.ev(`window.scrollY`);
    cb = await t.box("#renderCanvas"); // re-measure: the page just scrolled
    await t.clickAt(Math.round(cb.cx), Math.round(cb.cy));
    await sleep(800);
    const cap = JSON.parse(await t.ev(`JSON.stringify({ hit: (document.elementFromPoint(${Math.round(cb.cx)}, ${Math.round(cb.cy)}) || {}).id, captured: document.getElementById('tour').classList.contains('captured'), badge: document.getElementById('badge').textContent.trim().slice(0,70), lock: document.pointerLockElement?.id || null })`));
    const y2 = await t.ev(`window.scrollY`);
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(cb.cx), y: Math.round(cb.cy), deltaX: 0, deltaY: 300 }, t.sessionId);
    await sleep(1200);
    const y3 = await t.ev(`window.scrollY`);
    await t.key("Escape", "Escape", 27);
    await sleep(900);
    const rel = JSON.parse(await t.ev(`JSON.stringify({ captured: document.getElementById('tour').classList.contains('captured'), badge: document.getElementById('badge').textContent.trim().slice(0,70), lock: document.pointerLockElement?.id || null })`));
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(cb.cx), y: Math.round(cb.cy), deltaX: 0, deltaY: 300 }, t.sessionId);
    await sleep(1200);
    const y4 = await t.ev(`window.scrollY`);
    record("E2", y1 > y0 && cap.captured && !rel.captured && y4 > y3 ? "PASS" : "PARTIAL",
      `click hit #${cap.hit}; wheel over canvas (not captured) scrollY ${y0}→${y1}; click → captured=${cap.captured} pointerLock=${cap.lock} badge="${cap.badge}"; wheel while captured ${y2}→${y3}; Esc → captured=${rel.captured} lock=${rel.lock} badge="${rel.badge}"; wheel after release ${y3}→${y4}`);
  }

  // E5 — listing copy integrity (placeholders only, claims backed by the model)
  const copy = JSON.parse(await t.ev(`JSON.stringify({ text: document.body.innerText.replace(/\\s+/g, ' '),
    beds: [...document.querySelectorAll('#anchorBar .pill')].filter(p => p.closest('#anchorBar') && ['master-bedroom','room-1','room-2','room-3'].includes(p.dataset.anchor)).length })`));
  const txt = copy.text;
  const NEED = ["[Property address]", "Price on request", "[Agent name]", "[Agent phone]", "[agent@email]", "[Listing status]", "[Response-time promise"];
  const low = txt.toLowerCase();
  const placeholders = NEED.filter((p) => low.includes(p.toLowerCase()));
  const missingPh = NEED.filter((p) => !low.includes(p.toLowerCase()));
  const bad = [];
  const flag = (re, why) => { const m = txt.match(re); if (m) bad.push(`${why}: "${m[0]}"`); };
  flag(/four wings/i, "layout claims wings the model doesn't have");
  flag(/their own wing/i, "bedrooms described as a separate wing");
  flag(/\bpatio\b/i, "patio (model has none)");
  flag(/\b(sqm|m²|square met|square feet|ft²)\b/i, "floor area claim");
  flag(/\bpool\b/i, "pool");
  flag(/garage door|double garage|lock-up garage/i, "enclosed garage");
  flag(/\$\s?\d/, "dollar price");
  flag(/\b\d{1,2},\d{3}\b/, "price-like number");
  flag(/two[- ]?(storey|story|level)/i, "multi-level claim");
  const facts = { beds: /4 bedrooms/.test(low) && copy.beds === 4, baths: /2 bathrooms \+ wc/.test(low), deck: /balcony deck/.test(low), carport: /carport/.test(low), raised: /raised on posts|single-level/.test(low) };
  record("E5", placeholders.length === 7 && bad.length === 0 && Object.values(facts).every(Boolean) ? "PASS" : "FAIL",
    `placeholders present ${placeholders.length}/7 (missing=${JSON.stringify(missingPh)}); facts ${JSON.stringify(facts)} (bedroom pills=${copy.beds}); unsupported claims → ${JSON.stringify(bad)}`);

  // E4 — no attribution overlay on the tour canvas (page or fullscreen); the footer owns the credit
  const noOverlay = await t.ev(`(() => { const tour = document.getElementById('tour');
    return !tour.querySelector('#credit') && !/CC BY/.test(tour.textContent); })()`);
  const foot = JSON.parse(await t.ev(`(() => { const f = document.querySelector('footer');
    return JSON.stringify({ text: f.textContent.replace(/\\s+/g, ' ').trim(), links: [...f.querySelectorAll('a')].map(a => a.hostname) }); })()`));
  const footOk = /CC BY 4\.0/.test(foot.text) && /Modular House Cube 3 by Swanbuild Australia/.test(foot.text)
    && /EDSAHERGOM STUDIO/.test(foot.text) && /CC BY-NC 4\.0/.test(foot.text);
  await t.clickEl("#fsBtn");
  await sleep(1000);
  const fsState = JSON.parse(await t.ev(`(() => { const tour = document.getElementById('tour');
    return JSON.stringify({ entered: !!document.fullscreenElement || tour.classList.contains('pseudo-fullscreen'),
      overlay: !!tour.querySelector('#credit') || /CC BY/.test(tour.textContent) }); })()`));
  await t.shot("fullscreen-credit.png");
  await t.clickEl("#fsBtn");
  await sleep(800);
  record("E4", noOverlay && footOk && !fsState.overlay ? "PASS" : "FAIL",
    `canvas overlay in page=${noOverlay}; fullscreen entered=${fsState.entered} overlay=${fsState.overlay}; footer attribution=${footOk}; footer links=${JSON.stringify(foot.links)}`);
  await t.close();

  // E6 reduced motion
  const r = await newTab({ width: 1440, height: 900, url: BASE + "/#room=lounge" });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, r.sessionId);
  const rdy = await tourReady(r);
  if (!rdy) record("E6", "BLOCKED", "tour never became ready under reduced motion");
  else {
    await sleep(1500);
    await clickPill(r, "master-bedroom");
    await sleep(200);
    const a = ROOM_ANCHORS.find((x) => x.id === "master-bedroom");
    const dEarly = dist3((await camOf(r)).pos, a.pos);
    await sleep(1500);
    const dLate = dist3((await camOf(r)).pos, a.pos);
    const css = JSON.parse(await r.ev(`JSON.stringify({ scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
      reveal: (() => { const s = getComputedStyle(document.querySelector('.reveal')); return { opacity: s.opacity, transition: s.transitionDuration, transform: s.transform }; })() })`));
    record("E6", css.matches && dEarly <= 0.05 && css.scrollBehavior === "auto" && css.reveal.transition.split(",").every((d) => d.trim() === "0s") ? "PASS" : "FAIL",
      `matches=${css.matches}; 200ms after pill click camera already ${dEarly.toFixed(3)}m from anchor (settled ${dLate.toFixed(3)}m) → ${dEarly <= 0.05 ? "instant" : "still animating"}; html scroll-behavior=${css.scrollBehavior}; .reveal transition-duration=${css.reveal.transition} opacity=${css.reveal.opacity}`);
  }
  await r.close();
}

/* ------------------------------------------------------------------ main */
async function main() {
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--enable-unsafe-swiftshader",
    "--window-size=1440,900", `--user-data-dir=/tmp/qa-profile-${PORT}`, "about:blank",
  ], { stdio: "ignore" });
  let tabA = null;
  try {
    ws = new WebSocket(await getWsUrl());
    await new Promise((res) => ws.addEventListener("open", res, { once: true }));
    ws.addEventListener("message", onMessage);
    if (want("A")) tabA = await stageA();
    if (want("A3")) await guard("A3", stageA3);
    if (want("A4")) await guard("A4", stageA4);
    if (want("B")) await guard("B", () => stageB(tabA));
    if (want("C")) await guard("C", stageC);
    if (want("D")) await guard("D", stageD);
    if (want("E")) await guard("E", stageE);
  } catch (e) {
    console.error("DRIVER ERROR:", e.message);
    record("driver", "BLOCKED", String(e.message).slice(0, 300));
  } finally {
    if (tabA) await tabA.close();
    const bad = netEvents.filter((n) => (typeof n.status === "number" ? n.status >= 400 : true));
    let prev = { consoleErrors: [], consoleWarnings: [], exceptions: [], failedRequests: [], results: [] };
    if (existsSync(OUT + "results.json")) {
      try { prev = JSON.parse(readFileSync(OUT + "results.json", "utf8")); } catch { /* fresh */ }
    }
    const byId = new Map(prev.results.map((r) => [r.id, r]));
    for (const r of results) byId.set(r.id, r);
    const uniq = (arr) => [...new Set(arr.map((x) => (typeof x === "string" ? x : JSON.stringify(x))))].map((s) => (s.startsWith("{") ? JSON.parse(s) : s));
    const summary = {
      qaEmail: [prev.qaEmail, QA_EMAIL].filter(Boolean).join(" "),
      consoleErrors: uniq([...(prev.consoleErrors || []), ...consoleMsgs.filter((c) => c.type === "error")]),
      consoleWarnings: uniq([...(prev.consoleWarnings || []), ...consoleMsgs.filter((c) => c.type === "warning")]),
      exceptions: uniq([...(prev.exceptions || []), ...exceptions]),
      failedRequests: uniq([...(prev.failedRequests || []), ...bad]),
      results: [...byId.values()],
    };
    writeFileSync(OUT + "results.json", JSON.stringify(summary, null, 2));
    console.log("\n=== console errors:", summary.consoleErrors.length, "===");
    for (const e of summary.consoleErrors.slice(0, 25)) console.log("  ERR", (e.text || e).slice(0, 300));
    console.log("=== uncaught exceptions:", summary.exceptions.length, "===");
    for (const e of summary.exceptions.slice(0, 25)) console.log("  EXC", String(e).slice(0, 300));
    console.log("=== failed / 4xx / 5xx requests:", summary.failedRequests.length, "===");
    for (const e of summary.failedRequests.slice(0, 25)) console.log("  NET", e.status, String(e.url).slice(0, 160));
    console.log("=== console warnings:", summary.consoleWarnings.length, "===");
    for (const e of summary.consoleWarnings.slice(0, 25)) console.log("  WRN", (e.text || e).slice(0, 240));
    console.log("\n--- results ---");
    for (const rr of summary.results) console.log(`${rr.status.padEnd(8)} ${rr.id}`);
    chrome.kill();
  }
}
async function guard(name, fn) {
  try { await fn(); } catch (e) { console.error(`STAGE ${name} failed:`, e); record(`${name}-stage`, "BLOCKED", `driver threw: ${String(e.message).slice(0, 250)}`); }
}
main().catch((e) => { console.error("DRIVER ERROR:", e); process.exitCode = 2; setTimeout(() => process.exit(1), 500); });
