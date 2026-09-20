#!/usr/bin/env node
/**
 * Tests for HttpBackend — SSE framing, abort propagation, error mapping and the
 * transcript assembled from speech-vendor Turn messages.
 *
 * Runs in Node with zero additional dependencies: `fetch`, `WebSocket` and the DOM
 * bits the backend touches are stubbed per test, so nothing here reaches the network.
 */

import { HttpBackend } from '../src/backends/http-backend.js';
import { TalkieBackendError } from '../src/core/backend.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

/** Build a Response-alike whose body streams the given SSE text in small pieces. */
function sseResponse(text, { chunkSize = 7, ok = true, status = 200 } = {}) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return {
    ok,
    status,
    body: new ReadableStream({
      pull(controller) {
        if (i >= bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.slice(i, i + chunkSize));
        i += chunkSize;
      },
    }),
  };
}

/** Swap in a fetch stub for the duration of `fn`. */
async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const SESSION_OK = { ok: true, status: 200, json: async () => ({ session_id: 's1', opening_greeting: 'Yo', model: 'qwen3.7-flash' }) };

// ── contract ────────────────────────────────────────────────────────────────
{
  const b = new HttpBackend({ baseUrl: 'http://x' });
  check('has startCapture', typeof b.startCapture === 'function');
  check('has stopCapture', typeof b.stopCapture === 'function');
  check('has ask', typeof b.ask === 'function');
  check('has speak', typeof b.speak === 'function');
  check('has dispose', typeof b.dispose === 'function');
  check('trailing slash stripped from baseUrl',
    new HttpBackend({ baseUrl: 'http://x/' }).sessionId === null);

  const noSpeak = new HttpBackend({ baseUrl: 'http://x', speakEnabled: false });
  check('speakEnabled:false removes speak so the widget skips TTS',
    noSpeak.speak === undefined);
}

// ── SSE framing ─────────────────────────────────────────────────────────────
{
  check('parses a data line', HttpBackend.parseSseEvent('data: {"delta":"hi"}')?.delta === 'hi');
  check('recognises the DONE sentinel', HttpBackend.parseSseEvent('data: [DONE]') === '[DONE]');
  check('ignores a comment-only block', HttpBackend.parseSseEvent(': keepalive') === null);
  check('ignores an empty block', HttpBackend.parseSseEvent('') === null);
  check('survives malformed JSON', HttpBackend.parseSseEvent('data: {nope') === null);
  check('skips non-data lines before the payload',
    HttpBackend.parseSseEvent('event: msg\ndata: {"delta":"x"}')?.delta === 'x');
  check('preserves a delta containing a newline',
    HttpBackend.parseSseEvent('data: {"delta":"a\\nb"}')?.delta === 'a\nb');
}

// ── ask(): streaming ────────────────────────────────────────────────────────
async function testAskStreams() {
  const sse = 'data: {"delta": "Gr"}\n\n'
            + 'data: {"delta": "abe, "}\n\n'
            + 'data: {"delta": "kaibigan!"}\n\n'
            + 'data: [DONE]\n\n';

  await withFetch(async (url) => {
    if (String(url).endsWith('/chat/session')) return SESSION_OK;
    return sseResponse(sse);
  }, async () => {
    const b = new HttpBackend({ baseUrl: 'http://x' });
    const out = [];
    for await (const chunk of b.ask('hello', new AbortController().signal)) out.push(chunk);
    check('ask yields every delta', out.length === 3, JSON.stringify(out));
    check('ask preserves delta text', out.join('') === 'Grabe, kaibigan!', out.join(''));
    check('ask created a session first', b.sessionId === 's1');
  });
}

async function testAskHandlesSplitFrames() {
  // One byte at a time: every frame boundary lands mid-event, which is exactly the
  // case a naive split() on the raw buffer gets wrong.
  const sse = 'data: {"delta": "one"}\n\ndata: {"delta": "two"}\n\ndata: [DONE]\n\n';
  await withFetch(async (url) => {
    if (String(url).endsWith('/chat/session')) return SESSION_OK;
    return sseResponse(sse, { chunkSize: 1 });
  }, async () => {
    const b = new HttpBackend({ baseUrl: 'http://x', sessionId: 's9' });
    const out = [];
    for await (const chunk of b.ask('hi', new AbortController().signal)) out.push(chunk);
    check('ask reassembles events split across reads', out.join('|') === 'one|two', out.join('|'));
  });
}

async function testAskStopsAtDone() {
  const sse = 'data: {"delta": "kept"}\n\ndata: [DONE]\n\ndata: {"delta": "after"}\n\n';
  await withFetch(async (url) => {
    if (String(url).endsWith('/chat/session')) return SESSION_OK;
    return sseResponse(sse);
  }, async () => {
    const b = new HttpBackend({ baseUrl: 'http://x', sessionId: 's9' });
    const out = [];
    for await (const chunk of b.ask('hi', new AbortController().signal)) out.push(chunk);
    check('ask stops at [DONE] and ignores trailing frames', out.join('') === 'kept', out.join(''));
  });
}

async function testAskSurfacesServerError() {
  const sse = 'data: {"error": "upstream exploded"}\n\ndata: [DONE]\n\n';
  await withFetch(async (url) => {
    if (String(url).endsWith('/chat/session')) return SESSION_OK;
    return sseResponse(sse);
  }, async () => {
    const b = new HttpBackend({ baseUrl: 'http://x', sessionId: 's9' });
    let err = null;
    try {
      for await (const _ of b.ask('hi', new AbortController().signal)) { /* drain */ }
    } catch (e) { err = e; }
    check('an SSE error frame becomes a TalkieBackendError',
      err instanceof TalkieBackendError && err.reason === 'backend-failure', String(err));
    check('the server message is preserved', err?.message === 'upstream exploded', err?.message);
  });
}

async function testAskMapsHttpFailure() {
  await withFetch(async (url) => {
    if (String(url).endsWith('/chat/session')) return SESSION_OK;
    return { ok: false, status: 500, body: null };
  }, async () => {
    const b = new HttpBackend({ baseUrl: 'http://x', sessionId: 's9' });
    let err = null;
    try {
      for await (const _ of b.ask('hi', new AbortController().signal)) { /* drain */ }
    } catch (e) { err = e; }
    check('a non-OK ask maps to backend-failure',
      err instanceof TalkieBackendError && err.reason === 'backend-failure', String(err));
  });
}

async function testAskPropagatesAbort() {
  // The widget relies on AbortError reaching it unchanged to return to idle; wrapping
  // it in a TalkieBackendError would surface a spurious error state instead.
  await withFetch(async (url) => {
    if (String(url).endsWith('/chat/session')) return SESSION_OK;
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }, async () => {
    const b = new HttpBackend({ baseUrl: 'http://x', sessionId: 's9' });
    let err = null;
    try {
      for await (const _ of b.ask('hi', AbortSignal.abort())) { /* drain */ }
    } catch (e) { err = e; }
    check('AbortError propagates unwrapped', err?.name === 'AbortError', String(err));
  });
}

async function testAskMapsNetworkFailure() {
  await withFetch(async (url) => {
    if (String(url).endsWith('/chat/session')) return SESSION_OK;
    throw new TypeError('Failed to fetch');
  }, async () => {
    const b = new HttpBackend({ baseUrl: 'http://x', sessionId: 's9' });
    let err = null;
    try {
      for await (const _ of b.ask('hi', new AbortController().signal)) { /* drain */ }
    } catch (e) { err = e; }
    check('a network failure maps to offline',
      err instanceof TalkieBackendError && err.reason === 'offline', String(err));
  });
}

// ── session handling ────────────────────────────────────────────────────────
async function testSessionIsCreatedOnce() {
  let calls = 0;
  await withFetch(async (url) => {
    if (String(url).endsWith('/chat/session')) { calls++; return SESSION_OK; }
    return sseResponse('data: [DONE]\n\n');
  }, async () => {
    const b = new HttpBackend({ baseUrl: 'http://x' });
    await b.ensureSession();
    await b.ensureSession();
    for await (const _ of b.ask('hi', new AbortController().signal)) { /* drain */ }
    check('the session is created exactly once', calls === 1, `calls=${calls}`);
    check('opening greeting is captured from the server', b.openingGreeting === 'Yo');
  });
}

async function testSessionErrorIsMapped() {
  await withFetch(async () => ({
    ok: false, status: 400, json: async () => ({ detail: "Missing required key 'products'" }),
  }), async () => {
    const b = new HttpBackend({ baseUrl: 'http://x' });
    let err = null;
    try { await b.ensureSession(); } catch (e) { err = e; }
    check('a 400 from /chat/session becomes backend-failure',
      err instanceof TalkieBackendError && err.reason === 'backend-failure', String(err));
    check('the server detail reaches the message',
      err?.message.includes("Missing required key 'products'"), err?.message);
  });
}

// ── Turn messages -> transcript ─────────────────────────────────────────────
{
  const T = (o) => HttpBackend.readTurn(o);
  check('reads a partial turn from transcript',
    T({ type: 'Turn', turn_order: 0, transcript: 'how much' })?.text === 'how much');
  check('prefers utterance on a closing frame',
    T({ type: 'Turn', turn_order: 0, end_of_turn: true, utterance: 'How much?', transcript: 'how much' })?.text === 'How much?');
  check('falls back to transcript when utterance is absent',
    T({ type: 'Turn', turn_order: 1, end_of_turn: true, transcript: 'and gadgets' })?.text === 'and gadgets');
  check('ignores a non-Turn message', T({ type: 'Begin', id: 'x' }) === null);
  check('ignores an empty turn', T({ type: 'Turn', turn_order: 0, transcript: '' }) === null);
  check('defaults a missing turn_order to 0',
    T({ type: 'Turn', transcript: 'hi' })?.order === 0);

  // A final frame must supersede the partial it replaces, and turns must join in
  // index order regardless of the order they arrived in.
  const turns = new Map();
  for (const msg of [
    { type: 'Turn', turn_order: 1, transcript: 'and gadget' },
    { type: 'Turn', turn_order: 0, transcript: 'how much' },
    { type: 'Turn', turn_order: 0, end_of_turn: true, utterance: 'How much is travel insurance?' },
    { type: 'Turn', turn_order: 1, end_of_turn: true, utterance: 'And gadget cover?' },
  ]) {
    const turn = HttpBackend.readTurn(msg);
    if (turn) turns.set(turn.order, turn.text);
  }
  check('turns join in index order with finals superseding partials',
    HttpBackend.joinTurns(turns) === 'How much is travel insurance? And gadget cover?',
    HttpBackend.joinTurns(turns));
  check('an empty turn map yields an empty transcript',
    HttpBackend.joinTurns(new Map()) === '');
  check('whitespace is collapsed',
    HttpBackend.joinTurns(new Map([[0, '  a   b  ']])) === 'a b');
}

// ── startCapture failure path ───────────────────────────────────────────────
async function testStartCaptureClosesSocketOnMicFailure() {
  // No mediaDevices here, so MicCapture fails the way it would in a headless or
  // permission-denied browser. The socket opened moments earlier must not be left
  // dangling — an idle vendor session is billed for its full lifetime.
  class FakeSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.forEach((f) => f()));
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    send() {}
    close() { this.readyState = 3; this.listeners.close?.forEach((f) => f()); }
  }
  const originalWs = globalThis.WebSocket;
  let sock = null;
  globalThis.WebSocket = class extends FakeSocket { constructor(u) { super(u); sock = this; } };
  globalThis.WebSocket.OPEN = 1;

  try {
    const b = new HttpBackend({ baseUrl: 'http://x', sessionId: 's9' });
    await withFetch(async (url) => {
      if (String(url).endsWith('/stt/token')) {
        return { ok: true, status: 200, json: async () => ({ ws_url: 'wss://fake', sample_rate: 16000, encoding: 'pcm_s16le' }) };
      }
      return SESSION_OK;
    }, async () => {
      let err = null;
      try { await b.startCapture(); } catch (e) { err = e; }
      check('startCapture surfaces a mic failure as a TalkieBackendError',
        err instanceof TalkieBackendError, String(err));
      check('a mic failure closes the speech socket',
        sock !== null && sock.readyState === 3);
    });
    check('stopCapture with no recognised speech raises no-speech-detected',
      await b.stopCapture().then(() => false, (e) => e.reason === 'no-speech-detected'));
  } finally {
    globalThis.WebSocket = originalWs;
  }
}

// ── dispose ─────────────────────────────────────────────────────────────────
async function testDispose() {
  const seen = [];
  await withFetch(async (url, opts) => {
    seen.push(`${opts?.method ?? 'GET'} ${new URL(url).pathname}`);
    return SESSION_OK;
  }, async () => {
    const b = new HttpBackend({ baseUrl: 'http://x' });
    await b.ensureSession();
    b.dispose();
    check('dispose ends the server session',
      seen.some((s) => s === 'POST /chat/session/s1/end'), seen.join(', '));

    let err = null;
    try {
      for await (const _ of b.ask('hi', new AbortController().signal)) { /* drain */ }
    } catch (e) { err = e; }
    check('a disposed backend refuses ask',
      err instanceof TalkieBackendError && err.message === 'Backend disposed', String(err));
  });
}

await testAskStreams();
await testAskHandlesSplitFrames();
await testAskStopsAtDone();
await testAskSurfacesServerError();
await testAskMapsHttpFailure();
await testAskPropagatesAbort();
await testAskMapsNetworkFailure();
await testSessionIsCreatedOnce();
await testSessionErrorIsMapped();
await testStartCaptureClosesSocketOnMicFailure();
await testDispose();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
