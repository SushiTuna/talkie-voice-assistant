#!/usr/bin/env node
/**
 * Tests for VoiceAgentBackend — the session.update it builds, the server events it
 * normalises, and a full push-to-talk turn driven through a scripted fake socket.
 *
 * Runs in Node with zero additional dependencies: the WebSocket, the audio graph and the
 * `<audio>` element are stubbed per test, so nothing here reaches the network or a device.
 */

import { VoiceAgentBackend } from '../src/backends/voice-agent-backend.js';
import { TalkieBackendError } from '../src/core/backend.js';
import { encodeBase64 } from '../src/audio/pcm-codec.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Swap in a fetch stub for the duration of `fn`. */
async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

/* ── the fake socket ─────────────────────────────────────────────────────────
 * Scripted rather than automatic: each test decides when the socket opens and which
 * frames arrive, which is the only way to cover "the reply landed before ask() was
 * called" — the ordering this backend exists to handle.
 * ───────────────────────────────────────────────────────────────────────────── */
class FakeSocket {
  static OPEN = 1;
  static last = null;

  constructor(url) {
    this.url = url;
    this.readyState = 0;       // CONNECTING
    this.sent = [];
    this.listeners = {};
    FakeSocket.last = this;
  }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }

  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close', {}); }

  emit(type, event) { for (const fn of [...(this.listeners[type] ?? [])]) fn(event); }

  // ── test drivers ──
  /** Complete the handshake. */
  accept() { this.readyState = FakeSocket.OPEN; this.emit('open', {}); }
  /** Deliver one server frame. */
  frame(obj) { this.emit('message', { data: JSON.stringify(obj) }); }
  /** Every frame of a given type that the backend sent. */
  sentOf(type) { return this.sent.filter((f) => f.type === type); }
}

/**
 * Stub the browser surface MicCapture, the codec and playback touch, run `fn`, restore.
 *
 * @param {(ctx: { played: string[] }) => Promise<void>} fn
 */
async function withBrowser(fn) {
  const saved = {
    WebSocket: globalThis.WebSocket,
    window: globalThis.window,
    // Node defines `navigator` as a getter-only global, so it has to be redefined
    // rather than assigned — and put back the same way afterwards.
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    AudioWorkletNode: globalThis.AudioWorkletNode,
    Audio: globalThis.Audio,
    createObjectURL: globalThis.URL.createObjectURL,
    revokeObjectURL: globalThis.URL.revokeObjectURL,
  };
  const played = [];

  class FakeAudioContext {
    state = 'running';
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async resume() {}
    async close() {}
  }

  globalThis.WebSocket = FakeSocket;
  globalThis.WebSocket.OPEN = FakeSocket.OPEN;
  globalThis.window = { AudioContext: FakeAudioContext };
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    configurable: true,
    writable: true,
  });
  globalThis.AudioWorkletNode = class {
    port = { onmessage: null, postMessage() {} };
    disconnect() {}
  };
  globalThis.Audio = class {
    constructor(src) { this.src = src; played.push(src); this.handlers = {}; }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    removeEventListener() {}
    pause() {}
    // Resolve on the next turn of the loop, as a finished clip would.
    play() { return Promise.resolve().then(() => this.handlers.ended?.()); }
  };
  globalThis.URL.createObjectURL = () => 'blob:fake-reply';
  globalThis.URL.revokeObjectURL = () => {};

  try {
    await fn({ played });
  } finally {
    globalThis.WebSocket = saved.WebSocket;
    globalThis.window = saved.window;
    Object.defineProperty(globalThis, 'navigator', saved.navigator);
    globalThis.AudioWorkletNode = saved.AudioWorkletNode;
    globalThis.Audio = saved.Audio;
    globalThis.URL.createObjectURL = saved.createObjectURL;
    globalThis.URL.revokeObjectURL = saved.revokeObjectURL;
    FakeSocket.last = null;
  }
}

/** A backend wired to an inline token supplier, with the padding shortened for tests. */
function makeBackend(options = {}) {
  return new VoiceAgentBackend({
    fetchToken: async () => ({ token: 'tok-1', expires_in_seconds: 300 }),
    endOfTurnPadMs: 50,
    systemPrompt: 'Be brief.',
    ...options,
  });
}

/** Take a backend through startCapture, resolving once the session is ready. */
async function connect(backend) {
  const started = backend.startCapture();
  await tick();
  const ws = FakeSocket.last;
  ws.accept();
  await tick();
  ws.frame({ type: 'session.ready', session_id: 'sess_1' });
  await started;
  return ws;
}

// ── contract ────────────────────────────────────────────────────────────────
{
  const b = makeBackend();
  check('has startCapture', typeof b.startCapture === 'function');
  check('has stopCapture', typeof b.stopCapture === 'function');
  check('has ask', typeof b.ask === 'function');
  check('has speak', typeof b.speak === 'function');
  check('has dispose', typeof b.dispose === 'function');
  check('has prewarm', typeof b.prewarm === 'function');
  check('sessionId is null before a session exists', b.sessionId === null);

  check('speakEnabled:false removes speak so the widget skips TTS',
    makeBackend({ speakEnabled: false }).speak === undefined);
}

// ── session.update ──────────────────────────────────────────────────────────
{
  const { session } = VoiceAgentBackend.buildSessionUpdate({
    systemPrompt: 'Be brief.',
    voice: 'anna',
    keyterms: ['WanderSafe'],
  });
  check('inline config carries the system prompt', session.system_prompt === 'Be brief.');
  check('input encoding is PCM', session.input.format.encoding === 'audio/pcm');
  check('output encoding is PCM', session.output.format.encoding === 'audio/pcm');
  check('voice is passed through', session.output.voice === 'anna');
  check('keyterms sit under input', session.input.keyterms[0] === 'WanderSafe');
  check('barge-in is off by default, because push-to-talk closes the mic',
    session.input.turn_detection.interrupt_response === false);
  check('silence thresholds are left at the service default, since measurement showed '
    + 'they do not move end-of-turn timing',
    session.input.turn_detection.min_silence === undefined
    && session.input.turn_detection.max_silence === undefined,
    JSON.stringify(session.input.turn_detection));
  check('greeting is omitted unless asked for', session.greeting === undefined);
  check('no agent_id when configured inline', session.agent_id === undefined);

  const override = VoiceAgentBackend.buildSessionUpdate({
    turnDetection: { min_silence: 400, vad_threshold: 0.3 },
  });
  check('turnDetection is still passed through for callers who want to tune it',
    override.session.input.turn_detection.min_silence === 400
    && override.session.input.turn_detection.vad_threshold === 0.3
    && override.session.input.turn_detection.interrupt_response === false);

  const stored = VoiceAgentBackend.buildSessionUpdate({ agentId: 'agent-7' });
  check('agentId produces a stored-agent session', stored.session.agent_id === 'agent-7');
  check('a stored-agent session carries nothing else',
    Object.keys(stored.session).length === 1, JSON.stringify(stored.session));

  let mixed = null;
  try {
    VoiceAgentBackend.buildSessionUpdate({ agentId: 'agent-7', systemPrompt: 'Hi' });
  } catch (err) {
    mixed = err;
  }
  check('agentId plus inline config is rejected before it reaches the API',
    mixed instanceof TalkieBackendError && mixed.reason === 'backend-failure'
    && mixed.message.includes('systemPrompt'), mixed?.message);

  const volume = VoiceAgentBackend.buildSessionUpdate({ volume: 60 });
  check('volume rides on output', volume.session.output.volume === 60);
  check('volume is absent when unset',
    VoiceAgentBackend.buildSessionUpdate({}).session.output.volume === undefined);

  const withTools = VoiceAgentBackend.buildSessionUpdate({
    tools: [{ type: 'function', name: 'get_weather' }],
  });
  check('tools ride at session level', withTools.session.tools[0].name === 'get_weather');
}

// ── readEvent ───────────────────────────────────────────────────────────────
{
  const r = VoiceAgentBackend.readEvent;
  check('session.ready yields the session id',
    r({ type: 'session.ready', session_id: 's1' })?.sessionId === 's1');
  check('transcript.user yields the text',
    r({ type: 'transcript.user', text: 'hello' })?.kind === 'user-transcript');
  check('an empty transcript.user is ignored',
    r({ type: 'transcript.user', text: '' }) === null);
  check('partial user transcripts are ignored',
    r({ type: 'transcript.user.delta', text: 'hel' }) === null);
  check('reply.audio yields its base64 payload',
    r({ type: 'reply.audio', data: 'AAA=' })?.data === 'AAA=');
  check('transcript.agent yields the answer',
    r({ type: 'transcript.agent', text: 'Sure.' })?.text === 'Sure.');
  check('transcript.agent reports interruption',
    r({ type: 'transcript.agent', text: 'Su', interrupted: true })?.interrupted === true);
  check('reply.done yields its status',
    r({ type: 'reply.done', status: 'interrupted' })?.status === 'interrupted');
  check('tool.call yields the call id, name and arguments', (() => {
    const e = r({ type: 'tool.call', call_id: 'c1', name: 'f', arguments: { a: 1 } });
    return e.callId === 'c1' && e.name === 'f' && e.arguments.a === 1;
  })());
  check('session.error is an error event',
    r({ type: 'session.error', code: 'invalid_audio', message: 'bad' })?.kind === 'error');
  check('bare error frames map too', r({ type: 'error', code: 'x' })?.kind === 'error');
  check('speech markers are ignored',
    r({ type: 'input.speech.started' }) === null && r({ type: 'session.updated' }) === null);
  check('unknown frames are ignored', r({ type: 'whatever' }) === null && r(null) === null);

  check('transient server failures map to offline',
    VoiceAgentBackend.reasonForCode('server_error') === 'offline');
  check('auth and config failures map to backend-failure',
    VoiceAgentBackend.reasonForCode('UNAUTHORIZED') === 'backend-failure'
    && VoiceAgentBackend.reasonForCode('invalid_config') === 'backend-failure');
}

// ── joinTurns ───────────────────────────────────────────────────────────────
{
  const turns = new Map([[1, 'world'], [0, 'hello']]);
  check('turns join in order', VoiceAgentBackend.joinTurns(turns) === 'hello world');
  check('whitespace is collapsed',
    VoiceAgentBackend.joinTurns(new Map([[0, '  a   b  ']])) === 'a b');
  check('no turns yields an empty string', VoiceAgentBackend.joinTurns(new Map()) === '');
}

// ── a full turn ─────────────────────────────────────────────────────────────
async function testFullTurn() {
  await withBrowser(async ({ played }) => {
    const b = makeBackend();
    const ws = await connect(b);

    check('token rides in the socket query string', ws.url.includes('token=tok-1'), ws.url);
    check('the endpoint is the vendor agent socket',
      ws.url.startsWith('wss://agents.assemblyai.com/v1/ws?'), ws.url);
    const updates = ws.sentOf('session.update');
    check('exactly one session.update is sent', updates.length === 1, `got ${updates.length}`);
    check('sessionId is exposed once ready', b.sessionId === 'sess_1');
    check('no audio is sent before session.ready', (() => {
      const firstAudio = ws.sent.findIndex((f) => f.type === 'input.audio');
      const update = ws.sent.findIndex((f) => f.type === 'session.update');
      return firstAudio === -1 || update < firstAudio;
    })());

    ws.frame({ type: 'transcript.user', text: 'What does Pro cost?' });
    const transcript = await b.stopCapture();
    check('stopCapture returns the recognised transcript',
      transcript === 'What does Pro cost?', transcript);
    check('silence is padded so the vendor closes the turn',
      ws.sentOf('input.audio').length >= 1, `got ${ws.sentOf('input.audio').length}`);
    check('the socket stays open for the reply', b.connected === true);

    // The reply arrives before ask() is called — the ordering this backend exists for.
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: encodeBase64(new Int16Array([1, 2, 3]).buffer) });
    ws.frame({ type: 'reply.audio', data: encodeBase64(new Int16Array([4, 5]).buffer) });
    ws.frame({ type: 'transcript.agent', text: 'Pro is $24 per seat.', reply_id: 'r1' });
    ws.frame({ type: 'reply.done', status: 'completed' });

    const chunks = [];
    for await (const chunk of b.ask(transcript, new AbortController().signal)) chunks.push(chunk);
    check('ask yields the answer buffered before it was called',
      chunks.length === 1 && chunks[0] === 'Pro is $24 per seat.', JSON.stringify(chunks));

    await b.speak(chunks[0], new AbortController().signal);
    check('speak plays the agent audio', played.length === 1 && played[0] === 'blob:fake-reply',
      JSON.stringify(played));

    b.dispose();
    check('dispose ends the agent session', ws.sentOf('session.end').length === 1);
    check('dispose closes the socket', ws.readyState === 3);
  });
}

// ── a second turn reuses the session ────────────────────────────────────────
async function testSecondTurnReusesSocket() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'One' });
    await b.stopCapture();
    ws.frame({ type: 'transcript.agent', text: 'First answer.' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    for await (const _ of b.ask('One', new AbortController().signal)) { /* drain */ }

    await b.startCapture();
    check('the second turn reuses the open socket', FakeSocket.last === ws);
    const full = ws.sentOf('session.update').filter((f) => f.session.system_prompt);
    check('the agent is configured once per socket, not per turn', full.length === 1,
      `got ${full.length}`);
    check('the session is configured exactly once per socket',
      ws.sentOf('session.update').length === 1, `got ${ws.sentOf('session.update').length}`);

    ws.frame({ type: 'transcript.user', text: 'Two' });
    const second = await b.stopCapture();
    check('the second turn transcribes on its own, without the first turn leaking in',
      second === 'Two', second);
    b.dispose();
  });
}

// ── the release padding ─────────────────────────────────────────────────────
async function testReleasePadsSilence() {
  await withBrowser(async () => {
    // 200 ms of padding at 50 ms a frame is four frames of digital silence.
    const b = makeBackend({ endOfTurnPadMs: 200 });
    const ws = await connect(b);
    const before = ws.sentOf('input.audio').length;
    ws.frame({ type: 'transcript.user', text: 'Hi' });
    await b.stopCapture();

    const padding = ws.sentOf('input.audio').slice(before);
    check('releasing pads the stream so a turn cut off mid-sentence still closes',
      padding.length === 4, `got ${padding.length} frames`);
    check('the padding is actually silent', padding.every((f) => {
      const bytes = atob(f.audio);
      for (let i = 0; i < bytes.length; i++) if (bytes.charCodeAt(i) !== 0) return false;
      return true;
    }));
    check('no session.update is sent on release — the thresholds are left alone',
      ws.sentOf('session.update').length === 1);
    b.dispose();
  });
}

// ── multi-part transcripts ──────────────────────────────────────────────────
async function testPausedSpeechJoins() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'What does Pro' });
    ws.frame({ type: 'transcript.user', text: 'cost per seat?' });
    const transcript = await b.stopCapture();
    check('a caller who pauses mid-sentence still yields one transcript',
      transcript === 'What does Pro cost per seat?', transcript);
    b.dispose();
  });
}

// ── nothing said ────────────────────────────────────────────────────────────
async function testNoSpeech() {
  await withBrowser(async () => {
    const b = makeBackend();
    await connect(b);
    let caught = null;
    try { await b.stopCapture(); } catch (err) { caught = err; }
    check('silence surfaces as no-speech-detected',
      caught instanceof TalkieBackendError && caught.reason === 'no-speech-detected',
      caught?.reason);
    b.dispose();
  });
}

// ── an empty reply still releases the widget ────────────────────────────────
async function testEmptyReply() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hi' });
    await b.stopCapture();
    // reply.done with no transcript.agent: without the done handler, ask() would hang
    // until the reply timeout and strand the widget in `thinking`.
    ws.frame({ type: 'reply.done', status: 'completed' });
    const chunks = [];
    for await (const chunk of b.ask('Hi', new AbortController().signal)) chunks.push(chunk);
    check('a reply with no transcript yields nothing rather than hanging',
      chunks.length === 0, JSON.stringify(chunks));
    b.dispose();
  });
}

// ── errors ──────────────────────────────────────────────────────────────────
async function testSessionErrorDuringReply() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hi' });
    await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'session.error', code: 'agent_timeout', message: 'Agent gave up' });

    let caught = null;
    try {
      for await (const _ of b.ask('Hi', new AbortController().signal)) { /* drain */ }
    } catch (err) { caught = err; }
    check('a mid-reply session.error surfaces as backend-failure',
      caught instanceof TalkieBackendError && caught.reason === 'backend-failure', caught?.reason);
    check('the error message names the vendor code',
      caught?.message.includes('agent_timeout'), caught?.message);
    b.dispose();
  });
}

async function testHandshakeErrorIsOffline() {
  await withBrowser(async () => {
    const b = makeBackend();
    const started = b.startCapture();
    await tick();
    FakeSocket.last.emit('error', {});
    let caught = null;
    try { await started; } catch (err) { caught = err; }
    check('an unreachable agent service is offline, not a backend failure',
      caught instanceof TalkieBackendError && caught.reason === 'offline', caught?.reason);
    b.dispose();
  });
}

async function testRejectedTokenIsMapped() {
  await withBrowser(async () => {
    const b = new VoiceAgentBackend({
      tokenUrl: 'http://server/agent/token',
      endOfTurnPadMs: 50,
    });
    await withFetch(async () => ({ ok: false, status: 401 }), async () => {
      let caught = null;
      try { await b.startCapture(); } catch (err) { caught = err; }
      check('a refused token mints a backend-failure, not a silent retry',
        caught instanceof TalkieBackendError && caught.reason === 'backend-failure', caught?.reason);
      check('the message names the route', caught?.message.includes('/agent/token'), caught?.message);
    });

    await withFetch(async () => { throw new Error('Failed to fetch'); }, async () => {
      let caught = null;
      try { await b.startCapture(); } catch (err) { caught = err; }
      check('an unreachable token route is offline', caught?.reason === 'offline', caught?.reason);
    });

    await withFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }), async () => {
      let caught = null;
      try { await b.startCapture(); } catch (err) { caught = err; }
      check('a token response with no token is rejected up front',
        caught?.reason === 'backend-failure' && caught.message.includes('no token'), caught?.message);
    });
    check('no socket is opened when the token never arrives', FakeSocket.last === null);
    b.dispose();
  });
}

async function testDefaultTokenUrl() {
  // Inside withBrowser so prewarm's audio-graph step succeeds and stays quiet.
  await withBrowser(async () => {
    const b = new VoiceAgentBackend({ baseUrl: 'http://localhost:8000/' });
    await withFetch(async (url) => {
      check('tokenUrl defaults to baseUrl + /agent/token, with the trailing slash stripped',
        url === 'http://localhost:8000/agent/token', String(url));
      return { ok: true, status: 200, json: async () => ({ token: 't', expires_in_seconds: 300 }) };
    }, async () => {
      await b.prewarm();
    });
    b.dispose();
  });
}

// ── abort ───────────────────────────────────────────────────────────────────
async function testAskPropagatesAbort() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hi' });
    await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });

    const ac = new AbortController();
    const drain = (async () => {
      for await (const _ of b.ask('Hi', ac.signal)) { /* never arrives */ }
    })();
    await tick();
    ac.abort();

    let caught = null;
    try { await drain; } catch (err) { caught = err; }
    check('aborting while waiting on the reply raises AbortError, which the widget maps to idle',
      caught?.name === 'AbortError', caught?.name);
    b.dispose();
  });
}

// ── tools ───────────────────────────────────────────────────────────────────
async function testToolCall() {
  await withBrowser(async () => {
    const calls = [];
    const b = makeBackend({
      tools: [{ type: 'function', name: 'get_price' }],
      onToolCall: (call) => { calls.push(call); return { price: 24 }; },
    });
    const ws = await connect(b);
    ws.frame({ type: 'tool.call', call_id: 'c1', name: 'get_price', arguments: { plan: 'pro' } });
    await tick();

    check('the handler receives the call', calls.length === 1 && calls[0].name === 'get_price');
    check('the handler receives the arguments', calls[0].arguments.plan === 'pro');
    const results = ws.sentOf('tool.result');
    check('a tool.result is sent back', results.length === 1);
    check('the result is JSON-encoded as a string, as the API requires',
      results[0].result === '{"price":24}', JSON.stringify(results[0]));
    check('the result is tied to the call id', results[0].call_id === 'c1');
    b.dispose();
  });
}

async function testToolFailureStillReplies() {
  await withBrowser(async () => {
    const b = makeBackend({
      onToolCall: () => { throw new Error('upstream is down'); },
    });
    const ws = await connect(b);
    ws.frame({ type: 'tool.call', call_id: 'c2', name: 'get_price', arguments: {} });
    await tick();
    const results = ws.sentOf('tool.result');
    check('a throwing handler still answers the agent, rather than stranding the turn',
      results.length === 1 && results[0].result.includes('upstream is down'),
      JSON.stringify(results[0]));
    b.dispose();
  });
}

async function testUnhandledToolIsReported() {
  await withBrowser(async () => {
    const b = makeBackend();  // no onToolCall
    const ws = await connect(b);
    ws.frame({ type: 'tool.call', call_id: 'c3', name: 'mystery', arguments: {} });
    await tick();
    check('a tool with no handler is reported back as an error result',
      ws.sentOf('tool.result')[0]?.result.includes('No handler'),
      JSON.stringify(ws.sentOf('tool.result')[0]));
    b.dispose();
  });
}

// ── token caching ───────────────────────────────────────────────────────────
async function testTokenIsCachedThenConsumed() {
  await withBrowser(async () => {
    let minted = 0;
    const b = new VoiceAgentBackend({
      fetchToken: async () => { minted++; return { token: `tok-${minted}`, expires_in_seconds: 300 }; },
      endOfTurnPadMs: 50,
    });

    await b.prewarm();
    check('prewarm mints a token', minted === 1, `minted ${minted}`);
    check('prewarm does not open the socket, because the token is single-use',
      FakeSocket.last === null);

    const ws = await connect(b);
    check('the press reuses the warmed token instead of minting another',
      minted === 1 && ws.url.includes('tok-1'), `minted ${minted}, url ${ws.url}`);

    b.dispose();

    // A redeemed token cannot open a second socket, so the next connection must mint one.
    const b2 = new VoiceAgentBackend({
      fetchToken: async () => { minted++; return { token: `tok-${minted}`, expires_in_seconds: 300 }; },
      endOfTurnPadMs: 50,
    });
    const ws2 = await connect(b2);
    check('a fresh socket mints a fresh token', ws2.url.includes('tok-2'), ws2.url);
    b2.dispose();
  });
}

async function testExpiredTokenIsRefetched() {
  await withBrowser(async () => {
    let minted = 0;
    const b = new VoiceAgentBackend({
      // 20 s is inside the 30 s safety margin, so the cache must never be trusted.
      fetchToken: async () => { minted++; return { token: `tok-${minted}`, expires_in_seconds: 20 }; },
      endOfTurnPadMs: 50,
    });
    await b.prewarm();
    await b.prewarm();
    check('a token too close to expiry is refetched rather than risked',
      minted === 2, `minted ${minted}`);
    b.dispose();
  });
}

// ── disposal ────────────────────────────────────────────────────────────────
async function testDisposedBackendRefuses() {
  await withBrowser(async () => {
    const b = makeBackend();
    b.dispose();
    let caught = null;
    try { await b.startCapture(); } catch (err) { caught = err; }
    check('a disposed backend refuses to start a turn',
      caught instanceof TalkieBackendError && caught.reason === 'backend-failure', caught?.reason);
    const warm = await b.prewarm();
    check('prewarm on a disposed backend is a no-op',
      warm.token === false && warm.audio === false);
  });
}

async function testDisposeMidReplyUnblocksAsk() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hi' });
    await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });

    const drain = (async () => {
      for await (const _ of b.ask('Hi', new AbortController().signal)) { /* none */ }
    })();
    await tick();
    b.dispose();
    let caught = null;
    try { await drain; } catch (err) { caught = err; }
    check('disposing mid-reply releases ask instead of leaving it pending',
      caught instanceof TalkieBackendError, caught?.message);
  });
}

// ── run ─────────────────────────────────────────────────────────────────────
await testFullTurn();
await testSecondTurnReusesSocket();
await testReleasePadsSilence();
await testPausedSpeechJoins();
await testNoSpeech();
await testEmptyReply();
await testSessionErrorDuringReply();
await testHandshakeErrorIsOffline();
await testRejectedTokenIsMapped();
await testDefaultTokenUrl();
await testAskPropagatesAbort();
await testToolCall();
await testToolFailureStillReplies();
await testUnhandledToolIsReported();
await testTokenIsCachedThenConsumed();
await testExpiredTokenIsRefetched();
await testDisposedBackendRefuses();
await testDisposeMidReplyUnblocksAsk();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
