import '../src/define/talkie-widget.js';
import '../src/define/talkie-launcher.js';
import { MockBackend, SCRIPT, chunkText } from '../src/backends/mock-backend.js';
import { HttpBackend } from '../src/backends/http-backend.js';
import { TalkieBackendError } from '../src/core/backend.js';

/* ── State metadata (matches mockup palette) ─────────────────────── */
const STATES = [
  { id: 'idle',         num: '01', name: 'Idle',         color: '#5fd9c6' },
  { id: 'listening',    num: '02', name: 'Listening',    color: '#ff8a4c' },
  { id: 'transcribing', num: '03', name: 'Transcribing', color: '#ffc96b' },
  { id: 'thinking',     num: '04', name: 'Thinking',     color: '#7fb5ff' },
  { id: 'speaking',     num: '05', name: 'Speaking',     color: '#8be28b' },
  { id: 'error',        num: '06', name: 'Error',        color: '#ff6b6b' },
];
const META = Object.fromEntries(STATES.map(s => [s.id, s]));

/* ── Demo backends ──────────────────────────────────────────────── */

/** Backend whose startCapture rejects — drives widget into error state. */
class ErrorBackend {
  async startCapture() {
    throw new TalkieBackendError('mic-permission-denied',
      'Microphone access was denied. Please allow microphone permissions.');
  }
  async stopCapture()   { return ''; }
  async *ask(t, s)      { yield ''; }
  dispose()             {}
}

/** Offline backend — startCapture rejects with offline error. */
class OfflineBackend {
  async startCapture() {
    throw new TalkieBackendError('offline', 'You appear to be offline.');
  }
  async stopCapture()   { return ''; }
  async *ask(t, s)      { yield ''; }
  dispose()             {}
}

/** Slow-thinking backend — ~5s thinking phase before answering. */
class SlowThinkingBackend extends MockBackend {
  /** @override with long delay before answer */
  async *ask(transcript, signal) {
    if (this._disposed) throw new TalkieBackendError('backend-failure', 'Disposed');

    let entry = SCRIPT.find(s => s.q === transcript);
    if (!entry) entry = SCRIPT[0];

    // Transcribe delay (fast)
    await this.#sleep(400, signal);
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');

    // Long thinking delay (~5s)
    await this.#sleep(5000, signal);
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');

    // Stream answer
    for (const chunk of chunkText(entry.a)) {
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      yield chunk;
      await this.#sleep(80, signal);
    }
  }
  #sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(), ms);
      if (signal) {
        const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

/* ── Helpers ────────────────────────────────────────────────────── */

let logCount = 0;
const MAX_LOG_ROWS = 50;
let currentState = 'idle';
let conversationTimer = null;
let listenActive = false;
let widgetInstance = null;

/**
 * Append one row to the event log using DOM APIs only.
 * NEVER innerHTML with interpolated values — that was the mockup's XSS sink.
 */
function appendLog(timestamp, tagLabel, message, tagColor) {
  requestAnimationFrame(() => {
    const entry = document.createElement('div');
    entry.className = 'entry';

    const tsSpan = document.createElement('span');
    tsSpan.className = 't';
    tsSpan.textContent = timestamp;

    const tagSpan = document.createElement('span');
    tagSpan.className = 'tag';
    tagSpan.style.color = tagColor;
    tagSpan.textContent = tagLabel;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'm';
    const truncated = message.length > 80 ? message.slice(0, 80) + '\u2026' : message;
    msgSpan.title = message;
    msgSpan.textContent = truncated;

    entry.appendChild(tsSpan);
    entry.appendChild(tagSpan);
    entry.appendChild(msgSpan);

    const logEl = document.getElementById('log');
    logEl.prepend(entry);
    logCount++;

    while (logEl.children.length > MAX_LOG_ROWS) {
      logEl.removeChild(logEl.lastChild);
    }
  });
}

function now() {
  return new Date().toTimeString().slice(0, 8);
}

function clearConversationTimer() {
  if (conversationTimer) {
    clearTimeout(conversationTimer);
    conversationTimer = null;
  }
}

/* ── Widget / Launcher setup ────────────────────────────────────── */

function initWidget() {
  const slot = document.getElementById('widgetSlot');
  widgetInstance = document.createElement('talkie-widget');
  widgetInstance.setAttribute('id', 'widget');
  widgetInstance.style.display = 'block';
  widgetInstance.style.justifySelf = 'center';
  slot.appendChild(widgetInstance);

  /* Launcher → open; Widget → close fires talkie-close */
  const launcher = document.getElementById('launcher');
  launcher.addEventListener('talkie-launch', () => widgetInstance.show());

  /* Subscribe to all talkie-* events */
  const stateColors = Object.fromEntries(STATES.map(s => [s.id, s.color]));

  widgetInstance.addEventListener('talkie-state-change', (ev) => {
    const d = ev.detail || {};
    if (d.to) {
      setState(d.to);
      updateStateChip(d.to);
      appendLog(now(), 'STATE', d.from ? `${d.from} → ${d.to}` : 'initialised', stateColors[d.to] || '#8aa39e');
    }
  });

  widgetInstance.addEventListener('talkie-transcript', (ev) => {
    const text = (ev.detail || {}).text ?? '';
    appendLog(now(), 'TRANSCRIPT', text, '#ffc96b');
  });

  widgetInstance.addEventListener('talkie-response', (ev) => {
    const text = (ev.detail || {}).text ?? '';
    appendLog(now(), 'RESPONSE', text, '#8be28b');
  });

  widgetInstance.addEventListener('talkie-error', (ev) => {
    const d = ev.detail || {};
    const errMsg = typeof d.error?.message === 'string' ? d.error.message : String(d.error ?? '');
    appendLog(now(), 'ERROR', `reason=${d.reason}: ${errMsg}`, '#ff6b6b');
  });

  widgetInstance.addEventListener('talkie-open', () => {
    document.body.dataset.open = 'true';
    // Opening into idle is not a state *change*, so the chrome would keep showing
    // "STANDBY · WIDGET CLOSED" until the next transition. Re-sync it here.
    const s = widgetInstance.state || 'idle';
    setState(s);
    updateStateChip(s);
    appendLog(now(), 'OPEN', 'Widget opened', '#5fd9c6');
  });

  widgetInstance.addEventListener('talkie-close', (ev) => {
    document.body.dataset.open = 'false';
    appendLog(now(), 'CLOSE', ev.detail?.reason ?? 'user closed', '#8aa39e');
    setClosedUI();
  });

  /* Debug hotkey: E key → error state. NOT in the library per SPEC fix #8. */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'e' && e.key !== 'E') return;
    e.preventDefault();
    if (widgetInstance.state !== 'error') {
      if (!widgetInstance.open) widgetInstance.show();
      widgetInstance.backend = new ErrorBackend();
      widgetInstance.startListening('hotkey-e');
      appendLog(now(), 'HOTKEY', 'Pressed E → error backend activated', '#ff6b6b');
    }
  });

  /* Space/Esc conveniences */
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    if (!widgetInstance.open) {
      widgetInstance.show();
    } else if (widgetInstance.state === 'idle') {
      widgetInstance.startListening('keyboard-space');
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && widgetInstance.state === 'listening') {
      widgetInstance.releaseListening('space-release');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!widgetInstance.open) return;
    e.preventDefault();
    if (widgetInstance.state !== 'idle') {
      // Cancel in-flight conversation
      widgetInstance.reset();
    } else {
      widgetInstance.hide('esc close');
    }
  });
}

/** @type {HttpBackend | null} Disposed before each new live run. */
let liveBackend = null;

/* ── Scenario-driven navigation ────────────────────────────────
 * The rail triggers end-to-end scenarios through the real public API surface:
 *   - widget.backend  (swap backend instances)
 *   - widget.show()   / widget.hide()  (open/close)
 *   - widget.startListening(src)       (enter listening)
 *   - widget.releaseListening(src)     (exit listening → full flow)
 * No "jump-to-state" method is added to the library.
 * For states unreachable by the happy path, we use demo-only backends.
 * ─────────────────────────────────────────────────────────────── */

/**
 * Scenario 7 — live backend against the real voice server.
 *
 * Opt in with ?live (defaults to http://localhost:8000) or ?api=<origin>. This is the
 * only scenario that touches the microphone and real vendors, so it stays behind a
 * query flag rather than firing on page load.
 */
function goLive() {
  clearConversationTimer();
  listenActive = true;
  const api = new URLSearchParams(location.search).get('api') || 'http://localhost:8000';

  liveBackend?.dispose();
  liveBackend = new HttpBackend({ baseUrl: api, caller: { name: 'Demo User' } });
  widgetInstance.backend = liveBackend;
  widgetInstance.reset();
  widgetInstance.show();
  widgetInstance.startListening('rail');
  appendLog(now(), 'LIVE', `Streaming to ${api} — speak, then click again or press Space to send`, '#8be28b');
}

/** Scenario 6 — close widget and clear state. */
function goReset() {
  clearConversationTimer();
  listenActive = false;
  widgetInstance.reset();
  widgetInstance.hide('manual reset');
  setClosedUI();
  appendLog(now(), 'RESET', 'Widget closed and reset', '#5fd9c6');
}

/** Scenario 1 — full end-to-end conversation. */
function goFullConversation() {
  clearConversationTimer();
  widgetInstance.backend = new MockBackend();
  widgetInstance.reset();
  widgetInstance.show();
  widgetInstance.startListening('rail');
  autoReleaseIn(1500);
}

/** Scenario 2 — stays listening until released (no auto-release timer). */
function goHoldListening() {
  clearConversationTimer();
  listenActive = true;
  widgetInstance.backend = new MockBackend();
  widgetInstance.reset();
  widgetInstance.show();
  widgetInstance.startListening('rail');
  appendLog(now(), 'RAIL', 'Hold-listening active — click again or press Space to release', '#ff8a4c');
}

/** Scenario 3 — parks on thinking via slow-thinking backend. */
function goSlowAnswer() {
  clearConversationTimer();
  listenActive = false;
  widgetInstance.backend = new SlowThinkingBackend();
  widgetInstance.reset();
  widgetInstance.show();
  widgetInstance.startListening('rail');
  autoReleaseIn(300);
}

/** Scenario 4 — mic permission denied error. */
function goMicBlocked() {
  clearConversationTimer();
  listenActive = false;
  widgetInstance.backend = new ErrorBackend();
  widgetInstance.reset();
  widgetInstance.show();
  widgetInstance.startListening('rail');
  appendLog(now(), 'RAIL', 'Mic-blocked backend active — startCapture will reject', '#ff6b6b');
}

/** Scenario 5 — offline / network failure error. */
function goOffline() {
  clearConversationTimer();
  listenActive = false;
  widgetInstance.backend = new OfflineBackend();
  widgetInstance.reset();
  widgetInstance.show();
  widgetInstance.startListening('rail');
  appendLog(now(), 'RAIL', 'Offline backend active — startCapture will reject', '#ff6b6b');
}

/** Auto-release after timeout — enters transcribing → thinking → speaking → idle. */
function autoReleaseIn(delay) {
  clearConversationTimer();
  conversationTimer = setTimeout(() => {
    widgetInstance.releaseListening('auto-timer');
  }, delay);
}

/** Build the hint line at bottom of stage — no innerHTML, all DOM methods. */
function setHint(open) {
  const el = document.getElementById('hint');
  while (el.firstChild) el.removeChild(el.firstChild);
  if (open) {
    el.appendChild(document.createTextNode('Hold '));
    const kbd1 = document.createElement('kbd'); kbd1.textContent = 'Space';
    el.appendChild(kbd1);
    el.appendChild(document.createTextNode(' or tap the button to talk · '));
    const kbd2 = document.createElement('kbd'); kbd2.textContent = 'E';
    el.appendChild(kbd2);
    el.appendChild(document.createTextNode(' error · '));
    const kbd3 = document.createElement('kbd'); kbd3.textContent = 'Esc';
    el.appendChild(kbd3);
    el.appendChild(document.createTextNode(' cancel · again to close'));
  } else {
    el.textContent = 'Pick a scenario on the left, or tap the floating icon to open.';
  }
}

/* ── UI helpers
 ─────────────────────────────────────────────────── */

function updateStateChip(state) {
  const chip = document.getElementById('chip');
  chip.textContent = state === 'idle' ? 'STANDBY' : state.toUpperCase();
}

function setActiveRail(state) {
  document.querySelectorAll('.rail button').forEach(b =>
    b.classList.toggle('active', b.dataset.go === state));
}

function setState(state) {
  currentState = state;
  document.body.dataset.state = state;
  const m = META[state];
  document.documentElement.style.setProperty('--state', m.color);
  document.getElementById('stateNum').textContent = m.num;
  document.querySelectorAll('.timeline li').forEach(li =>
    li.classList.toggle('on', li.dataset.state === state));
  const isOpen = document.body.dataset.open === 'true';
  document.getElementById('specTag').textContent = !isOpen
    ? 'STANDBY · WIDGET CLOSED'
    : `STATE ${m.num} · ${m.name.toUpperCase()}`;
  setHint(isOpen);
}

function setClosedUI() {
  document.body.dataset.open = 'false';
  document.getElementById('chip').textContent = 'STANDBY';
  document.getElementById('specTag').textContent = 'STANDBY · WIDGET CLOSED';
  document.getElementById('stateNum').textContent = '\u2014';
  document.querySelectorAll('.timeline li').forEach(li => li.classList.remove('on'));
  setActiveRail('idle');
  setHint(false);
}

/* ── Build state rail ──────────────────────────────────────────── */

function buildRail() {
  const rail = document.getElementById('rail');

  const items = [
    { go: 'full-conversation',  num: '01', label: 'Full conversation',  desc: 'Ask, think, answer — end to end',  action: goFullConversation },
    { go: 'hold-listening',     num: '02', label: 'Hold listening',     desc: 'Stays listening until you release', action: goHoldListening },
    { go: 'slow-answer',        num: '03', label: 'Slow answer',        desc: "Parks on 'Finding the right answer…'", action: goSlowAnswer },
    { go: 'mic-blocked',        num: '04', label: 'Mic blocked',        desc: "Permission denied error",            action: goMicBlocked },
    { go: 'offline',            num: '05', label: 'Offline',            desc: 'Network failure error',              action: goOffline },
    { go: 'reset',              num: '06', label: 'Reset',              desc: 'Close the widget and clear state', action: goReset },
    { go: 'live',               num: '07', label: 'Live backend',      desc: 'Real mic + server (?live or ?api=)', action: goLive },
  ];

  items.forEach(item => {
    const btn = document.createElement('button');
    btn.dataset.go = item.go;

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = item.num;

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = item.label;

    const ds = document.createElement('span');
    ds.className = 'ds';
    ds.textContent = item.desc;

    btn.appendChild(num);
    btn.appendChild(nm);
    btn.appendChild(ds);

    btn.addEventListener('click', () => {
      /* Scenario #2 is a toggle — click again while running to release */
      if (item.go === 'hold-listening' && listenActive) {
        widgetInstance.releaseListening('rail-release');
        listenActive = false;
        return;
      }
      if (item.go === 'hold-listening') listenActive = true;
      item.action();
      setActiveRail(item.go);
    });

    rail.appendChild(btn);
  });
}

/* ── Build state timeline ──────────────────────────────────────── */

/** Populate the <ol id="timeline"> with one <li> per state. */
function buildTimeline() {
  const ol = document.getElementById('timeline');
  STATES.forEach(s => {
    const li = document.createElement('li');
    li.dataset.state = s.id;
    const numSpan = document.createElement('span');
    numSpan.textContent = s.num;
    const nameSpan = document.createElement('span');
    nameSpan.textContent = s.name;
    li.appendChild(numSpan);
    li.appendChild(nameSpan);
    ol.appendChild(li);
  });
}

/* ── Clock ─────────────────────────────────────────────────────── */

function initClock() {
  const clockEl = document.getElementById('clock');
  clockEl.textContent = now();
  setInterval(() => { clockEl.textContent = now(); }, 1000);
}

/* ── Init ──────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  initWidget();
  buildRail();
  buildTimeline();
  initClock();
  setState('idle');
  widgetInstance.show();
  appendLog(now(), 'BOOT', 'Demo harness ready \u2014 all six states', '#5fd9c6');
});
