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
import { encodeBase64, decodeBase64 } from '../src/audio/pcm-codec.js';
import { mock } from 'node:test';

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
 * With `streaming: true` the audio context can schedule buffer sources, so the backend
 * takes its streaming-playback path; otherwise it falls back to one buffered clip.
 *
 * @param {(ctx: { played: string[], contexts: object[], nodes: object[] }) => Promise<void>} fn
 * @param {{ streaming?: boolean }} [options]
 */
async function withBrowser(fn, { streaming = false } = {}) {
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
  const nodes = [];  // mic worklet nodes: `nodes.at(-1).port.onmessage({ data })` feeds the mic

  const contexts = [];
  class FakeAudioContext {
    state = 'running';
    audioWorklet = { addModule: async () => {} };
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async resume() {}
    async close() {}
  }
  class StreamingAudioContext extends FakeAudioContext {
    currentTime = 0;
    destination = {};
    sources = [];
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => data };
    }
    createBufferSource() {
      const src = {
        buffer: null, onended: null, startAt: null, stopped: false,
        connect() {}, disconnect() {},
        start(t) { src.startAt = t; },
        stop() { src.stopped = true; },
      };
      this.sources.push(src);
      return src;
    }
  }

  globalThis.WebSocket = FakeSocket;
  globalThis.WebSocket.OPEN = FakeSocket.OPEN;
  globalThis.window = { AudioContext: streaming ? StreamingAudioContext : FakeAudioContext };
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    configurable: true,
    writable: true,
  });
  globalThis.AudioWorkletNode = class {
    port = { onmessage: null, postMessage() {} };
    constructor() { nodes.push(this); }
    connect() {}
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
    await fn({ played, contexts, nodes });
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
  check('partial user transcripts become a live caption',
    r({ type: 'transcript.user.delta', text: 'hel' })?.text === 'hel'
    && r({ type: 'transcript.user.delta', text: 'hel' }).kind === 'user-partial');
  check('an empty partial is ignored', r({ type: 'transcript.user.delta', text: '' }) === null);
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
  check('input.speech.started is read, because it holds tool results back',
    r({ type: 'input.speech.started' })?.kind === 'speech-started');
  check('input.speech.stopped is read, because it restarts the idle timer',
    r({ type: 'input.speech.stopped' })?.kind === 'speech-stopped');
  check('acks are ignored', r({ type: 'session.updated' }) === null);
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
// The documented interactive sequence: reply.started → reply.audio (transition phrase) →
// tool.call → reply.done → client sends tool.result → the agent fires a follow-up reply.
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools

/** Ask a question and leave the backend waiting on the reply. */
async function askQuestion(ws, b, text = 'Show me the kitchen') {
  ws.frame({ type: 'transcript.user', text });
  return b.stopCapture();
}

async function testToolCall() {
  await withBrowser(async () => {
    const calls = [];
    const b = makeBackend({
      tools: [{ type: 'function', name: 'get_price' }],
      onToolCall: (call) => { calls.push(call); return { price: 24 }; },
    });
    const ws = await connect(b);
    await askQuestion(ws, b, 'What does Pro cost?');
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'tool.call', call_id: 'c1', name: 'get_price', arguments: { plan: 'pro' } });
    await tick();

    check('the handler receives the call', calls.length === 1 && calls[0].name === 'get_price');
    check('the handler receives the arguments', calls[0]?.arguments.plan === 'pro');
    check('the result is held while the reply that asked for it is still going',
      ws.sentOf('tool.result').length === 0);

    ws.frame({ type: 'reply.done', status: 'completed' });
    const results = ws.sentOf('tool.result');
    check('a tool.result is sent back on reply.done', results.length === 1);
    check('the result is JSON-encoded as a string, as the API requires',
      results[0]?.result === '{"price":24}', JSON.stringify(results[0]));
    check('the result is tied to the call id', results[0]?.call_id === 'c1');
    b.dispose();
  });
}

async function testSlowToolSendsWhenItFinishes() {
  await withBrowser(async () => {
    let finish;
    const b = makeBackend({ onToolCall: () => new Promise((r) => { finish = r; }) });
    const ws = await connect(b);
    await askQuestion(ws, b);
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'tool.call', call_id: 'c1', name: 'go_to_room', arguments: {} });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await tick();
    check('nothing is sent before the handler has an answer', ws.sentOf('tool.result').length === 0);
    finish({ ok: true });
    await tick();
    check('a handler finishing after reply.done sends its result at once',
      ws.sentOf('tool.result').length === 1);
    b.dispose();
  });
}

async function testResultsHeldWhileATurnIsInFlight() {
  await withBrowser(async () => {
    let finish;
    const b = makeBackend({ onToolCall: () => new Promise((r) => { finish = r; }) });
    const ws = await connect(b);
    await askQuestion(ws, b);
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'tool.call', call_id: 'c1', name: 'go_to_room', arguments: {} });
    ws.frame({ type: 'reply.done', status: 'completed' });
    ws.frame({ type: 'input.speech.started' });
    finish({ ok: true });
    await tick();
    check('a result is held while the caller is speaking', ws.sentOf('tool.result').length === 0);
    ws.frame({ type: 'reply.started', reply_id: 'r2' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    check('...and sent at the next reply.done', ws.sentOf('tool.result').length === 1);
    b.dispose();
  });
}

async function testInterruptedReplyDropsResults() {
  await withBrowser(async () => {
    let finish;
    const b = makeBackend({ onToolCall: () => new Promise((r) => { finish = r; }) });
    const ws = await connect(b);
    await askQuestion(ws, b);
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'tool.call', call_id: 'c1', name: 'go_to_room', arguments: {} });
    finish({ ok: true });
    await tick();
    ws.frame({ type: 'reply.done', status: 'interrupted' });
    check('an interrupted reply drops the results it asked for, as the docs require',
      ws.sentOf('tool.result').length === 0);
    b.dispose();
  });
}

async function testToolTurnSpansTheFollowUpReply() {
  await withBrowser(async ({ played }) => {
    const b = makeBackend({ onToolCall: () => ({ ok: true, room: 'Kitchen' }) });
    const ws = await connect(b);
    const transcript = await askQuestion(ws, b);

    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: encodeBase64(new Int16Array([1, 2]).buffer) });
    ws.frame({ type: 'transcript.agent', text: 'Taking you there.', reply_id: 'r1' });
    ws.frame({ type: 'tool.call', call_id: 'c1', name: 'go_to_room', arguments: { room: 'kitchen' } });
    await tick();

    const chunks = [];
    let asked = false;
    const asking = (async () => {
      for await (const c of b.ask(transcript, new AbortController().signal)) chunks.push(c);
      asked = true;
    })();
    ws.frame({ type: 'reply.done', status: 'completed' });
    await tick(60);
    check('the result goes out on the transition reply\'s reply.done', ws.sentOf('tool.result').length === 1);
    check('ask() does not end with the transition phrase', asked === false);

    ws.frame({ type: 'reply.started', reply_id: 'r2' });
    ws.frame({ type: 'reply.audio', data: encodeBase64(new Int16Array([3, 4, 5]).buffer) });
    ws.frame({ type: 'transcript.agent', text: 'This is the kitchen.', reply_id: 'r2' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await asking;
    check('ask() yields the transition phrase and the answer, in order',
      chunks.join(' ') === 'Taking you there. This is the kitchen.', JSON.stringify(chunks));

    await b.speak(chunks.join(' '), new AbortController().signal);
    check('speak plays one clip holding both replies', played.length === 1);
    b.dispose();
  });
}

async function testFollowUpWordsUseTheirOwnClock() {
  await withBrowser(async ({ contexts }) => {
    const b = makeBackend({ onToolCall: () => ({ ok: true }) });
    const ws = await connect(b);
    const transcript = await askQuestion(ws, b);
    ws.frame({ type: 'reply.started', reply_id: 'r1' });

    const words = [];
    const asking = (async () => {
      for await (const w of b.ask(transcript, new AbortController().signal)) words.push(w);
    })();
    await tick();

    // Transition reply: 50 ms lead-in, then 200 ms of voice with one word.
    for (let i = 0; i < 5; i++) ws.frame({ type: 'reply.audio', data: replyFrame() });
    sendWords(ws, [['Sure.', 900]]);
    for (let i = 0; i < 20; i++) ws.frame({ type: 'reply.audio', data: speechFrame() });
    ws.frame({ type: 'tool.call', call_id: 'c1', name: 'go_to_room', arguments: {} });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await tick();

    // Follow-up: its own 100 ms lead-in (stream 250–350 ms), and start_ms restarting near 0.
    ws.frame({ type: 'reply.started', reply_id: 'r2' });
    for (let i = 0; i < 10; i++) ws.frame({ type: 'reply.audio', data: replyFrame() });
    sendWords(ws, [['Here ', 40], ['it is.', 240]]);
    for (let i = 0; i < 50; i++) ws.frame({ type: 'reply.audio', data: speechFrame() });

    const out = outputOf(contexts);
    const t0 = out.sources[0].startAt;
    const playTo = async (ms) => { out.currentTime = t0 + ms / 1000; await tick(60); };

    await playTo(60);
    check('the transition phrase appears with its voice', words.join(' ') === 'Sure.', JSON.stringify(words));
    await playTo(300);
    check('the follow-up waits through its own lead-in', words.length === 1, JSON.stringify(words));
    await playTo(360);
    check('the follow-up\'s first word appears as its voice starts',
      words.join(' ') === 'Sure. Here', JSON.stringify(words));
    await playTo(500);
    check('...and its next word is timed from that reply\'s onset, not the first reply\'s',
      words.length === 2, JSON.stringify(words));
    await playTo(560);
    check('...appearing when playback reaches it', words.join(' ') === 'Sure. Here it is.', JSON.stringify(words));

    ws.frame({ type: 'transcript.agent', text: 'Here it is.', reply_id: 'r2' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await asking;
    check('the turn ends after the follow-up, without repeating words',
      words.join(' ') === 'Sure. Here it is.', JSON.stringify(words));
    b.dispose();
  }, { streaming: true });
}

async function testLateToolCallIsNotRunAndItsReplyIsDropped() {
  await withBrowser(async () => {
    const calls = [];
    const b = makeBackend({ onToolCall: (c) => { calls.push(c); return { ok: true }; } });
    const ws = await connect(b);
    const t1 = await askQuestion(ws, b, 'Hello');
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'transcript.agent', text: 'Hi there.', reply_id: 'r1' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    for await (const _ of b.ask(t1, new AbortController().signal)) { /* drain */ }

    // Undocumented order: a call after its turn has finished.
    ws.frame({ type: 'tool.call', call_id: 'late', name: 'go_to_room', arguments: {} });
    await tick();
    check('a call for a finished turn is not run', calls.length === 0);
    const result = ws.sentOf('tool.result')[0];
    check('...but the agent is still answered, so it is not left waiting',
      result?.call_id === 'late' && result.result.includes('cancelled'), JSON.stringify(result));

    // The reply that result triggers must not become the answer to the next question.
    await b.startCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r2' });
    ws.frame({ type: 'transcript.agent', text: 'Stale follow-up.', reply_id: 'r2' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    const t2 = await askQuestion(ws, b, 'Next question');
    ws.frame({ type: 'reply.started', reply_id: 'r3' });
    ws.frame({ type: 'transcript.agent', text: 'Fresh answer.', reply_id: 'r3' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    const chunks = [];
    for await (const c of b.ask(t2, new AbortController().signal)) chunks.push(c);
    check('the follow-up to a finished turn is dropped, not taken as the next answer',
      chunks.join(' ') === 'Fresh answer.', JSON.stringify(chunks));
    b.dispose();
  });
}

async function testCancelledToolTurnDropsTheFollowUp() {
  await withBrowser(async ({ contexts }) => {
    const calls = [];
    const b = makeBackend({ onToolCall: (c) => { calls.push(c); return { ok: true }; } });
    const ws = await connect(b);
    const t1 = await askQuestion(ws, b);
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: replyFrame() });
    const first = new AbortController();
    const asking = (async () => { for await (const _ of b.ask(t1, first.signal)) { /* drain */ } })();
    await tick();
    first.abort();
    try { await asking; } catch { /* AbortError */ }

    ws.frame({ type: 'tool.call', call_id: 'c1', name: 'go_to_room', arguments: {} });
    await tick();
    ws.frame({ type: 'reply.done', status: 'completed' });
    check('a tool the caller cancelled before it arrived is not run', calls.length === 0);
    check('...and is answered on reply.done', ws.sentOf('tool.result').length === 1);

    const out = outputOf(contexts);
    const before = out.sources.length;
    ws.frame({ type: 'reply.started', reply_id: 'r2' });
    ws.frame({ type: 'reply.audio', data: speechFrame() });
    ws.frame({ type: 'reply.done', status: 'completed' });
    check('the follow-up reply to a cancelled turn is not played', out.sources.length === before);
    b.dispose();
  }, { streaming: true });
}

async function testToolFailureStillReplies() {
  await withBrowser(async () => {
    const b = makeBackend({
      onToolCall: () => { throw new Error('upstream is down'); },
    });
    const ws = await connect(b);
    await askQuestion(ws, b);
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'tool.call', call_id: 'c2', name: 'get_price', arguments: {} });
    await tick();
    ws.frame({ type: 'reply.done', status: 'completed' });
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
    await askQuestion(ws, b);
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'tool.call', call_id: 'c3', name: 'mystery', arguments: {} });
    await tick();
    ws.frame({ type: 'reply.done', status: 'completed' });
    check('a tool with no handler is reported back as an error result',
      ws.sentOf('tool.result')[0]?.result.includes('No handler'),
      JSON.stringify(ws.sentOf('tool.result')[0]));
    b.dispose();
  });
}

// ── conversation mode (converse) ────────────────────────────────────────────
{
  const on = VoiceAgentBackend.buildSessionUpdate({ bargeIn: true, greeting: 'Hi!' }).session;
  check('bargeIn turns the vendor\'s interrupt_response on', on.input.turn_detection.interrupt_response === true);
  check('the greeting rides in the session config', on.greeting === 'Hi!');
  check('barge-in stays off by default, as push-to-talk needs',
    VoiceAgentBackend.buildSessionUpdate({}).session.input.turn_detection.interrupt_response === false);
}

/** Start converse() and complete the handshake; events collect in `events`. */
async function startConversation(b, options = {}) {
  const ctrl = new AbortController();
  const state = { events: [], error: null, done: false, ctrl };
  state.running = (async () => {
    try { for await (const e of b.converse(options, ctrl.signal)) state.events.push(e); }
    catch (err) { state.error = err; }
    finally { state.done = true; }
  })();
  await tick();
  state.ws = FakeSocket.last;
  state.ws.accept();
  await tick();
  state.ws.frame({ type: 'session.ready', session_id: 'sess_c' });
  await tick(); await tick();
  return state;
}
const types = (events) => events.map((e) => e.type);
const micChunk = (value = 500) => new Int16Array(240).fill(value).buffer;

async function testConversationTurn() {
  await withBrowser(async ({ nodes, played }) => {
    const b = makeBackend({ bargeIn: true });
    const c = await startConversation(b);
    const { ws } = c;
    check('a conversation configures barge-in on the session',
      ws.sentOf('session.update')[0].session.input.turn_detection.interrupt_response === true);

    const before = ws.sentOf('input.audio').length;
    nodes.at(-1).port.onmessage({ data: micChunk() });
    check('the mic streams straight to the agent', ws.sentOf('input.audio').length === before + 1);

    ws.frame({ type: 'input.speech.started' });
    ws.frame({ type: 'transcript.user.delta', text: 'What is' });
    ws.frame({ type: 'input.speech.stopped' });
    ws.frame({ type: 'transcript.user', text: 'What is the price?' });
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: encodeBase64(new Int16Array([1, 2, 3]).buffer) });
    ws.frame({ type: 'transcript.agent', text: 'Price on request.', reply_id: 'r1' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await tick(20);

    check('a turn is reported in order, with nobody pressing anything',
      types(c.events).join(',') === 'user-speech,user-partial,user-transcript,reply-start,reply-word,reply-end',
      types(c.events).join(','));
    check('the caption and the transcript carry the caller\'s words',
      c.events[1].text === 'What is' && c.events[2].text === 'What is the price?');
    check('the reply\'s words are reported', c.events[4].text === 'Price on request.');
    check('a reply that played out is not marked interrupted', c.events[5].interrupted === false);
    check('the reply is played', played.length === 1);
    check('no silence padding is sent: the agent decides the turn',
      ws.sentOf('input.audio').length === before + 1);
    check('the conversation keeps going after a reply', c.done === false && b.connected);

    c.ctrl.abort();
    await c.running;
    check('ending the conversation surfaces as an abort', c.error?.name === 'AbortError', String(c.error));
    check('ending the conversation ends the agent session', ws.sentOf('session.end').length === 1 && ws.readyState === 3);
    b.dispose();
  });
}

async function testConversationGreeting() {
  await withBrowser(async () => {
    const b = makeBackend({ bargeIn: true, greeting: 'Hi! Ask me anything.' });
    const c = await startConversation(b);
    c.ws.frame({ type: 'reply.started', reply_id: 'g' });
    c.ws.frame({ type: 'transcript.agent', text: 'Hi! Ask me anything.', reply_id: 'g' });
    c.ws.frame({ type: 'reply.done', status: 'completed' });
    await tick(20);
    check('the greeting plays as the first reply, before the caller says anything',
      types(c.events).join(',') === 'reply-start,reply-word,reply-end', types(c.events).join(','));
    c.ctrl.abort();
    await c.running;
    b.dispose();
  });
}

async function testConversationBargeIn() {
  await withBrowser(async ({ contexts }) => {
    const b = makeBackend({ bargeIn: true });
    const c = await startConversation(b);
    const { ws } = c;
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    for (let i = 0; i < 5; i++) ws.frame({ type: 'reply.audio', data: speechFrame() });
    await tick();
    const out = outputOf(contexts);
    check('a reply streams as it arrives', out.sources.length === 5);

    ws.frame({ type: 'input.speech.started' });
    await tick();
    check('talking over a reply cuts it off at once, without waiting for the vendor',
      out.sources.every((src) => src.stopped));
    check('the cut is reported as an interrupted end, then the caller\'s speech',
      types(c.events).slice(-2).join(',') === 'reply-end,user-speech' && c.events.at(-2).interrupted === true,
      JSON.stringify(c.events));

    const scheduled = out.sources.length;
    ws.frame({ type: 'reply.audio', data: speechFrame() });
    ws.frame({ type: 'transcript.agent', text: 'The old answer, trimmed.', interrupted: true });
    ws.frame({ type: 'reply.done', status: 'interrupted' });
    await tick(20);
    check('the rest of the interrupted reply is not played', out.sources.length === scheduled);
    check('...and its text is not reported', !c.events.some((e) => e.type === 'reply-word'));

    ws.frame({ type: 'reply.started', reply_id: 'r2' });
    ws.frame({ type: 'reply.audio', data: speechFrame() });
    await tick();
    check('the next reply plays normally', out.sources.length === scheduled + 1 && types(c.events).at(-1) === 'reply-start');
    c.ctrl.abort();
    await c.running;
    b.dispose();
  }, { streaming: true });
}

async function testConversationWithoutBargeIn() {
  await withBrowser(async ({ nodes, contexts }) => {
    const b = makeBackend({ bargeIn: false });
    const c = await startConversation(b);
    const { ws } = c;
    check('without barge-in the vendor is told not to interrupt',
      ws.sentOf('session.update')[0].session.input.turn_detection.interrupt_response === false);
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: speechFrame() });
    await tick();
    nodes.at(-1).port.onmessage({ data: micChunk(900) });
    const sent = new Int16Array(decodeBase64(ws.sentOf('input.audio').at(-1).audio ?? ws.sentOf('input.audio').at(-1).data));
    check('while a reply plays, the mic is sent as silence', sent.length === 240 && sent.every((v) => v === 0));
    ws.frame({ type: 'input.speech.started' });
    await tick();
    check('a speech detection during a reply does not cut it off',
      !outputOf(contexts).sources.some((src) => src.stopped) && !c.events.some((e) => e.type === 'user-speech'));
    c.ctrl.abort();
    await c.running;
    b.dispose();
  }, { streaming: true });
}

async function testConversationInterrupt() {
  await withBrowser(async ({ contexts }) => {
    const b = makeBackend({ bargeIn: false });
    check('interrupt() outside a conversation does nothing', b.interrupt() === false);
    const c = await startConversation(b);
    const { ws } = c;
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: speechFrame() });
    await tick();
    check('interrupt() cuts off the playing reply', b.interrupt() === true);
    await tick();
    const out = outputOf(contexts);
    check('...silencing it', out.sources.every((src) => src.stopped));
    check('...reported as an interrupted end, with no caller speech',
      types(c.events).join(',') === 'reply-start,reply-end' && c.events[1].interrupted === true, JSON.stringify(c.events));
    const scheduled = out.sources.length;
    ws.frame({ type: 'reply.audio', data: speechFrame() });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await tick(20);
    check('...and the rest of it is dropped', out.sources.length === scheduled && c.done === false);
    c.ctrl.abort();
    await c.running;
    b.dispose();
  }, { streaming: true });
}

async function testConversationIdleTimeout() {
  await withBrowser(async () => {
    const b = makeBackend({ bargeIn: true });
    const c = await startConversation(b, { idleTimeoutMs: 40 });
    c.ws.frame({ type: 'input.speech.started' });
    await tick(80);
    check('the idle limit does not run while the caller is speaking', c.done === false);
    c.ws.frame({ type: 'input.speech.stopped' });
    await tick(80);
    await c.running;
    check('a conversation nobody speaks in ends itself', types(c.events).at(-1) === 'idle-timeout' && c.error === null,
      `${types(c.events)} ${c.error}`);
    check('...ending the agent session, so it stops billing', c.ws.sentOf('session.end').length === 1);
    b.dispose();
  });
}

async function testConversationSocketDrop() {
  await withBrowser(async () => {
    const b = makeBackend({ bargeIn: true });
    const c = await startConversation(b);
    c.ws.close();
    await c.running;
    check('a dropped connection ends the conversation as offline',
      c.error instanceof TalkieBackendError && c.error.reason === 'offline', String(c.error));
    b.dispose();
  });
}

async function testConversationToolTurnIsOneReply() {
  await withBrowser(async () => {
    const b = makeBackend({ bargeIn: true, onToolCall: () => ({ ok: true }) });
    const c = await startConversation(b);
    const { ws } = c;
    ws.frame({ type: 'transcript.user', text: 'Show me the kitchen' });
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'transcript.agent', text: 'Taking you there.', reply_id: 'r1' });
    ws.frame({ type: 'tool.call', call_id: 'c1', name: 'show_room', arguments: { room: 'kitchen' } });
    await tick();
    ws.frame({ type: 'reply.done', status: 'completed' });
    await tick(60);
    check('the tool result goes out mid-conversation', ws.sentOf('tool.result').length === 1);
    ws.frame({ type: 'reply.started', reply_id: 'r2' });
    ws.frame({ type: 'transcript.agent', text: 'Here is the kitchen.', reply_id: 'r2' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await tick(20);
    const t = types(c.events).join(',');
    check('a tool turn is one reply to the widget, transition and answer together',
      t === 'user-transcript,reply-start,reply-word,reply-end'
      && c.events[2].text === 'Taking you there. Here is the kitchen.', `${t} ${JSON.stringify(c.events[2])}`);
    c.ctrl.abort();
    await c.running;
    b.dispose();
  });
}

async function testConversationQueuesOverlappingReplies() {
  await withBrowser(async ({ contexts }) => {
    const b = makeBackend({ bargeIn: true });
    const c = await startConversation(b);
    const { ws } = c;
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: speechFrame() });
    ws.frame({ type: 'reply.done', status: 'completed' });
    ws.frame({ type: 'reply.started', reply_id: 'r2' });   // arrives while r1 is still sounding
    ws.frame({ type: 'reply.audio', data: speechFrame() });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await tick(20);
    check('a reply that starts while another is sounding waits its turn',
      types(c.events).filter((x) => x === 'reply-start').length === 1, types(c.events).join(','));
    for (const src of outputOf(contexts).sources) src.onended?.();
    await tick(1600);
    check('...and plays once the first has finished',
      types(c.events).filter((x) => x === 'reply-start').length === 2, types(c.events).join(','));
    c.ctrl.abort();
    await c.running;
    b.dispose();
  }, { streaming: true });
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


// ── the timing probe ────────────────────────────────────────────────────────
async function testTimingMarks() {
  await withBrowser(async () => {
    const marks = [];
    const b = makeBackend({ onTiming: (mark, detail) => marks.push({ mark, ...detail }) });
    const ws = await connect(b);

    ws.frame({ type: 'transcript.user', text: 'How much?' });
    const transcript = await b.stopCapture();

    const names = marks.map((m) => m.mark);
    check('the release opens the timeline', names[0] === 'release', names.join(','));
    check('the padding is marked once it has been sent', names.includes('pad-sent'));
    check('a transcript that already arrived costs no grace wait',
      marks.find((m) => m.mark === 'user-transcript')?.waited === 0);

    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    // 24000 samples of 16-bit mono = exactly 1000 ms of audio, in two frames.
    ws.frame({ type: 'reply.audio', data: encodeBase64(new Int16Array(12000).buffer) });
    ws.frame({ type: 'reply.audio', data: encodeBase64(new Int16Array(12000).buffer) });
    ws.frame({ type: 'transcript.agent', text: 'Pro is $24.', reply_id: 'r1' });
    ws.frame({ type: 'reply.done', status: 'completed' });

    for await (const _ of b.ask(transcript, new AbortController().signal)) { /* drain */ }
    await b.speak('Pro is $24.', new AbortController().signal);

    const byName = Object.fromEntries(marks.map((m) => [m.mark, m]));
    check('the first audio frame is marked, not just the last',
      byName['first-audio-frame'] !== undefined);
    check('only the first audio frame is marked',
      marks.filter((m) => m.mark === 'first-audio-frame').length === 1);
    check('playback-start carries the reply length that the wait is compared against',
      byName['playback-start']?.audioMs === 1000, String(byName['playback-start']?.audioMs));
    check('audio-complete counts the frames it buffered',
      byName['audio-complete']?.frames === 2, String(byName['audio-complete']?.frames));
    check('the agent text mark carries its length',
      byName['agent-text']?.chars === 11, String(byName['agent-text']?.chars));
    check('every mark is timed from the release',
      marks.every((m) => Number.isFinite(m.at) && m.at >= 0));
    check('the marks run in order',
      marks.every((m, i) => i === 0 || m.at >= marks[i - 1].at));
    const finalNames = marks.map((m) => m.mark);
    check('playback is the last mark of the turn',
      finalNames[finalNames.length - 1] === 'playback-done', finalNames.join(','));

    b.dispose();
  });
}

async function testTimingIsOptional() {
  await withBrowser(async ({ played }) => {
    // No onTiming: the turn must behave exactly as it does in testFullTurn.
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hello' });
    const transcript = await b.stopCapture();
    ws.frame({ type: 'reply.audio', data: encodeBase64(new Int16Array([1, 2, 3]).buffer) });
    ws.frame({ type: 'transcript.agent', text: 'Hi there.' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    for await (const _ of b.ask(transcript, new AbortController().signal)) { /* drain */ }
    await b.speak('Hi there.', new AbortController().signal);
    check('a turn with no timing listener still completes', played.length === 1);
    b.dispose();
  });
}

async function testTimingListenerCannotBreakATurn() {
  await withBrowser(async ({ played }) => {
    const b = makeBackend({ onTiming: () => { throw new Error('probe exploded'); } });
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hello' });
    const transcript = await b.stopCapture();
    ws.frame({ type: 'reply.audio', data: encodeBase64(new Int16Array([1, 2, 3]).buffer) });
    ws.frame({ type: 'transcript.agent', text: 'Hi there.' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    for await (const _ of b.ask(transcript, new AbortController().signal)) { /* drain */ }
    await b.speak('Hi there.', new AbortController().signal);
    check('a throwing timing listener does not cost the caller their turn',
      played.length === 1, JSON.stringify(played));
    b.dispose();
  });
}

async function testAudioMsFromChunks() {
  const secondOfAudio = [new Int16Array(24000).buffer];
  check('audioMs reads 16-bit mono at the session rate',
    VoiceAgentBackend.audioMs(secondOfAudio) === 1000,
    String(VoiceAgentBackend.audioMs(secondOfAudio)));
  check('audioMs of nothing is zero', VoiceAgentBackend.audioMs([]) === 0);
}

// ── streaming playback ──────────────────────────────────────────────────────
/** 10 ms of the agent's silent lead-in, the frame size the live agent sends. */
const replyFrame = () => encodeBase64(new Int16Array(240).buffer);

/** 10 ms of the synthesised voice: loud enough to count as speech. */
const speechFrame = () => encodeBase64(new Int16Array(240).fill(3000).buffer);

/** The output context: the one the player scheduled sources on. */
const outputOf = (contexts) => contexts.find((c) => c.sources?.length) ?? { sources: [] };

async function testStreamsAsFramesArrive() {
  await withBrowser(async ({ played, contexts }) => {
    const b = makeBackend();
    check('speechStarted is offered when the browser can stream', typeof b.speechStarted === 'function');
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'What does it cost?' });
    const transcript = await b.stopCapture();

    // The first frame lands before the widget has called ask(), as it does live.
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: replyFrame() });

    const signal = new AbortController().signal;
    let heard = false;
    b.speechStarted(signal).then(() => { heard = true; });
    const words = [];
    const asking = (async () => { for await (const w of b.ask(transcript, signal)) words.push(w); })();
    await tick();

    const out = outputOf(contexts);
    check('audio that arrived before ask() starts playing as soon as ask() runs',
      out.sources.length === 1, `scheduled ${out.sources.length}`);

    ws.frame({ type: 'reply.audio', data: replyFrame() });
    check('each later frame is scheduled the moment it lands', out.sources.length === 2);
    check('frames are joined back to back, with no gap',
      Math.abs(out.sources[1].startAt - (out.sources[0].startAt + 0.01)) < 1e-9,
      `${out.sources[0].startAt} → ${out.sources[1].startAt}`);

    // The silent lead-in plays out; the voice has not started.
    out.currentTime = out.sources[1].startAt + 0.01;
    await tick(60);
    check('the silent lead-in does not count as the caller hearing the answer', heard === false);

    ws.frame({ type: 'reply.audio', data: speechFrame() });
    out.currentTime = out.sources[2].startAt + 0.005;
    await tick(60);
    check('speechStarted resolves when the voice itself starts playing', heard === true);

    ws.frame({ type: 'transcript.agent', text: 'Price on request.', reply_id: 'r1' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await asking;
    check('without word deltas, the reply text still arrives whole through ask()',
      words.join(' ') === 'Price on request.', JSON.stringify(words));

    let spoke = false;
    const speaking = b.speak(words.join(' '), signal).then(() => { spoke = true; });
    await tick();
    check('speak() does not replay the answer as a second clip', played.length === 0,
      JSON.stringify(played));
    check('speak() waits while streamed audio is still playing', spoke === false);
    for (const src of out.sources) src.onended?.();
    await speaking;
    check('speak() resolves once the streamed audio has played out', spoke === true);
    b.dispose();
  }, { streaming: true });
}

async function testNoSpeechStartedWithoutStreaming() {
  await withBrowser(async ({ played }) => {
    const b = makeBackend();
    check('without Web Audio scheduling, speechStarted is not offered',
      b.speechStarted === undefined);
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hi' });
    await b.stopCapture();
    ws.frame({ type: 'reply.audio', data: replyFrame() });
    ws.frame({ type: 'transcript.agent', text: 'Hello.' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    for await (const _ of b.ask('Hi', new AbortController().signal)) { /* drain */ }
    await b.speak('Hello.', new AbortController().signal);
    check('...and the reply falls back to one buffered clip', played.length === 1);
    b.dispose();
  });
}

async function testTextOnlyBackendDoesNotStream() {
  await withBrowser(async () => {
    const b = makeBackend({ speakEnabled: false });
    check('a text-only backend offers neither speak nor speechStarted',
      b.speak === undefined && b.speechStarted === undefined);
    b.dispose();
  }, { streaming: true });
}

async function testCancelMidReplyDropsTheTail() {
  await withBrowser(async ({ contexts }) => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Tell me everything' });
    const t1 = await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: replyFrame() });

    const first = new AbortController();
    const asking = (async () => { for await (const _ of b.ask(t1, first.signal)) { /* drain */ } })();
    await tick();
    const out = outputOf(contexts);
    first.abort(); // the caller presses Stop, or Ask another, mid-answer
    let caught = null;
    try { await asking; } catch (err) { caught = err; }
    check('cancelling mid-reply unwinds ask() as an abort', caught?.name === 'AbortError', String(caught));
    check('cancelling mid-reply silences what was already scheduled', out.sources.every((s) => s.stopped));

    // The agent keeps sending the reply it was cut off in.
    const before = out.sources.length;
    ws.frame({ type: 'reply.audio', data: replyFrame() });
    ws.frame({ type: 'transcript.agent', text: 'The old, long answer.' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    check('the rest of a cancelled reply is not played', out.sources.length === before);

    // The next question gets its own answer, and only its own.
    await b.startCapture();
    ws.frame({ type: 'transcript.user', text: 'Short question' });
    const t2 = await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r2' });
    ws.frame({ type: 'reply.audio', data: replyFrame() });
    ws.frame({ type: 'transcript.agent', text: 'New answer.', reply_id: 'r2' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    const chunks = [];
    for await (const c of b.ask(t2, new AbortController().signal)) chunks.push(c);
    check('the next turn gets its own text, not the cancelled one',
      chunks.join(' ') === 'New answer.', JSON.stringify(chunks));
    check('the next turn plays its own audio',
      out.sources.length === before + 1 && !out.sources[before].stopped);
    b.dispose();
  }, { streaming: true });
}

async function testCancelBeforeReplyBeganDropsThatReply() {
  await withBrowser(async ({ contexts }) => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'First' });
    const t1 = await b.stopCapture();

    // Cancelled while still "thinking": the agent has not started this reply yet.
    const first = new AbortController();
    const asking = (async () => { for await (const _ of b.ask(t1, first.signal)) { /* drain */ } })();
    await tick();
    first.abort();
    try { await asking; } catch { /* AbortError, as covered above */ }

    // ...but it arrives anyway, afterwards.
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: replyFrame() });
    ws.frame({ type: 'transcript.agent', text: 'Answer nobody wants now.', reply_id: 'r1' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    const out = outputOf(contexts);
    check('a reply to a turn cancelled before it began is dropped whole', out.sources.length === 0,
      `scheduled ${out.sources.length}`);

    await b.startCapture();
    ws.frame({ type: 'transcript.user', text: 'Second' });
    const t2 = await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r2' });
    ws.frame({ type: 'reply.audio', data: replyFrame() });
    ws.frame({ type: 'transcript.agent', text: 'The answer you asked for.', reply_id: 'r2' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    const chunks = [];
    for await (const c of b.ask(t2, new AbortController().signal)) chunks.push(c);
    check('the following reply is delivered normally',
      chunks.join(' ') === 'The answer you asked for.', JSON.stringify(chunks));
    check('...and heard', outputOf(contexts).sources.length === 1);
    b.dispose();
  }, { streaming: true });
}

async function testSpeechStartedHonoursAbort() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hi' });
    await b.stopCapture();
    const ctrl = new AbortController();
    const waiting = b.speechStarted(ctrl.signal);
    ctrl.abort();
    let caught = null;
    try { await waiting; } catch (err) { caught = err; }
    check('speechStarted rejects with AbortError when the turn is cancelled first',
      caught?.name === 'AbortError', String(caught));
    b.dispose();
  }, { streaming: true });
}

async function testStreamedTimingMarks() {
  await withBrowser(async ({ contexts }) => {
    const marks = [];
    const b = makeBackend({ onTiming: (mark, d) => marks.push({ mark, ...d }) });
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hi' });
    await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: replyFrame() });
    const signal = new AbortController().signal;
    const it = b.ask('Hi', signal)[Symbol.asyncIterator]();
    const text = it.next();
    await tick();
    ws.frame({ type: 'transcript.agent', text: 'Hello.' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await text;
    const playbackStart = marks.find((m) => m.mark === 'playback-start');
    const agentText = marks.find((m) => m.mark === 'agent-text');
    check('streamed playback is marked as streamed', playbackStart?.streamed === true);
    check('streamed playback starts before the reply text arrives',
      marks.indexOf(playbackStart) < marks.indexOf(agentText),
      marks.map((m) => m.mark).join(','));
    const speaking = b.speak('Hello.', signal);
    for (const src of outputOf(contexts).sources) src.onended?.();
    await speaking;
    check('the end of streamed playback is marked', marks.some((m) => m.mark === 'playback-done' && m.streamed));
    b.dispose();
  }, { streaming: true });
}

// ── the reply timeout is about silence, not length ──────────────────────────
/** Let pending promise callbacks run without touching the (mocked) timers. */
const flush = () => new Promise((r) => setImmediate(r));

async function testLongReplyDoesNotTimeOut() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Tell me everything' });
    const transcript = await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });

    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    try {
      let outcome = 'pending';
      const asking = (async () => {
        const out = [];
        for await (const c of b.ask(transcript, new AbortController().signal)) out.push(c);
        return out.join(' ');
      })().then((t) => { outcome = t; }, (err) => { outcome = err; });

      // A 50 s answer: audio keeps arriving the whole time, well past the 30 s limit.
      for (let s = 0; s < 50; s++) {
        ws.frame({ type: 'reply.audio', data: replyFrame() });
        mock.timers.tick(1000);
        await flush();
      }
      check('a reply that is still streaming is not timed out, however long it runs',
        outcome === 'pending', String(outcome?.message ?? outcome));

      ws.frame({ type: 'transcript.agent', text: 'A very long answer.' });
      ws.frame({ type: 'reply.done', status: 'completed' });
      await flush();
      await asking;
      check('...and its text is delivered when it finally arrives',
        outcome === 'A very long answer.', String(outcome?.message ?? outcome));
    } finally {
      mock.timers.reset();
    }
    b.dispose();
  });
}

async function testSilentReplyStillTimesOut() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hello?' });
    const transcript = await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: replyFrame() });

    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    try {
      let caught = null;
      const asking = (async () => {
        for await (const _ of b.ask(transcript, new AbortController().signal)) { /* drain */ }
      })().catch((err) => { caught = err; });
      await flush();
      mock.timers.tick(29_000);
      await flush();
      check('a reply is not given up on before the limit', caught === null, String(caught));
      mock.timers.tick(1_500);
      await flush();
      await asking;
      check('a reply that goes quiet for the whole limit still fails, rather than hanging',
        caught instanceof TalkieBackendError && caught.reason === 'backend-failure', String(caught));
    } finally {
      mock.timers.reset();
    }
    b.dispose();
  });
}

// ── word-by-word text, in step with the voice ──────────────────────────────
/** Send a burst of word deltas the way the live agent does: all at once, before the voice. */
function sendWords(ws, words) {
  for (const [delta, start_ms] of words) {
    ws.frame({ type: 'transcript.agent.delta', reply_id: 'r1', delta, start_ms, end_ms: start_ms + 300 });
  }
}

async function testWordsFollowPlayback() {
  await withBrowser(async ({ contexts }) => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Say three words' });
    const transcript = await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });

    const words = [];
    const signal = new AbortController().signal;
    const asking = (async () => { for await (const w of b.ask(transcript, signal)) words.push(w); })();
    await tick();

    // 50 ms of lead-in, then the word burst, then 1 s of voice.
    for (let i = 0; i < 5; i++) ws.frame({ type: 'reply.audio', data: replyFrame() });
    sendWords(ws, [['Three ', 300], ['little ', 700], ['words.', 1100]]);
    for (let i = 0; i < 100; i++) ws.frame({ type: 'reply.audio', data: speechFrame() });

    const out = outputOf(contexts);
    const t0 = out.sources[0].startAt;          // where stream position 0 plays
    const playTo = async (ms) => { out.currentTime = t0 + ms / 1000; await tick(60); };

    await playTo(40);
    check('no words appear during the silent lead-in, though they have all arrived',
      words.length === 0, JSON.stringify(words));
    await playTo(60);
    check('the first word appears as the voice starts', words.join(' ') === 'Three', JSON.stringify(words));
    await playTo(400);
    check('the next word waits for its moment in the audio', words.length === 1, JSON.stringify(words));
    await playTo(500);
    check('...and appears once playback reaches it', words.join(' ') === 'Three little', JSON.stringify(words));
    await playTo(900);
    check('the last word follows the voice too', words.join(' ') === 'Three little words.', JSON.stringify(words));

    ws.frame({ type: 'transcript.agent', text: 'Three little words.', reply_id: 'r1' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await asking;
    check('the final transcript does not repeat words already shown',
      words.join(' ') === 'Three little words.', JSON.stringify(words));
    b.dispose();
  }, { streaming: true });
}

async function testWordsArriveAtOnceWithoutStreaming() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hi' });
    const transcript = await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    const words = [];
    const asking = (async () => {
      for await (const w of b.ask(transcript, new AbortController().signal)) words.push(w);
    })();
    await tick();
    sendWords(ws, [['Hello ', 100], ['there.', 400]]);
    await tick(60);
    check('without streaming playback, words show as soon as they arrive',
      words.join(' ') === 'Hello there.', JSON.stringify(words));
    ws.frame({ type: 'transcript.agent', text: 'Hello there.' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await asking;
    check('...and are not repeated at the end', words.length === 2, JSON.stringify(words));
    b.dispose();
  });
}

async function testTranscriptCompletesShortDeltas() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Price?' });
    const transcript = await b.stopCapture();
    sendWords(ws, [['Price ', 100], ['is ', 300]]);
    ws.frame({ type: 'transcript.agent', text: 'Price is on request.' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    const words = [];
    for await (const w of b.ask(transcript, new AbortController().signal)) words.push(w);
    check('words the deltas missed are filled in from the final transcript',
      words.join(' ') === 'Price is on request.', JSON.stringify(words));
    b.dispose();
  });
}

async function testStalledClockStillReleasesText() {
  await withBrowser(async ({ contexts }) => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hi' });
    const transcript = await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    const words = [];
    const asking = (async () => {
      for await (const w of b.ask(transcript, new AbortController().signal)) words.push(w);
    })();
    await tick();
    // A suspended output context: frames are scheduled but the clock never moves.
    ws.frame({ type: 'reply.audio', data: speechFrame() });
    sendWords(ws, [['Still ', 0], ['here.', 200]]);
    ws.frame({ type: 'transcript.agent', text: 'Still here.' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await tick(100);
    check('text waits for playback while it might still come', words.length === 0, JSON.stringify(words));
    await asking;  // released after the flush grace
    check('if playback never moves, the text is released anyway rather than hanging',
      words.join(' ') === 'Still here.', JSON.stringify(words));
    check('...that is a real stall being simulated', outputOf(contexts).currentTime === 0);
    b.dispose();
  }, { streaming: true });
}

async function testCancelledReplyWordsDropped() {
  await withBrowser(async () => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'First' });
    const t1 = await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    ws.frame({ type: 'reply.audio', data: speechFrame() });
    const first = new AbortController();
    const asking = (async () => { for await (const _ of b.ask(t1, first.signal)) { /* drain */ } })();
    await tick();
    first.abort();
    try { await asking; } catch { /* AbortError */ }
    sendWords(ws, [['Stale ', 0], ['words.', 200]]);
    ws.frame({ type: 'reply.done', status: 'completed' });

    await b.startCapture();
    ws.frame({ type: 'transcript.user', text: 'Second' });
    const t2 = await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r2' });
    sendWords(ws, [['Fresh ', 0], ['answer.', 200]]);
    ws.frame({ type: 'transcript.agent', text: 'Fresh answer.' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    const words = [];
    for await (const w of b.ask(t2, new AbortController().signal)) words.push(w);
    check('words from a cancelled reply never reach the next answer',
      words.join(' ') === 'Fresh answer.', JSON.stringify(words));
    b.dispose();
  });
}

async function testSpeechOnsetDetection() {
  // Via the public surface: a reply whose audio never gets loud never "starts speaking".
  await withBrowser(async ({ contexts }) => {
    const b = makeBackend();
    const ws = await connect(b);
    ws.frame({ type: 'transcript.user', text: 'Hi' });
    await b.stopCapture();
    ws.frame({ type: 'reply.started', reply_id: 'r1' });
    // Near-silence at the level measured live (peak |2|), not exact zeros.
    ws.frame({ type: 'reply.audio', data: encodeBase64(new Int16Array(240).fill(2).buffer) });
    const signal = new AbortController().signal;
    let heard = false;
    b.speechStarted(signal).then(() => { heard = true; });
    const asking = (async () => { for await (const _ of b.ask('Hi', signal)) { /* drain */ } })();
    await tick();
    const out = outputOf(contexts);
    out.currentTime = out.sources[0].startAt + 0.01;
    await tick(60);
    check('the agent\'s low-level lead-in noise is not mistaken for speech', heard === false);
    ws.frame({ type: 'transcript.agent', text: 'Hi.' });
    ws.frame({ type: 'reply.done', status: 'completed' });
    await asking;
    b.dispose();
  }, { streaming: true });
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
await testSlowToolSendsWhenItFinishes();
await testResultsHeldWhileATurnIsInFlight();
await testInterruptedReplyDropsResults();
await testToolTurnSpansTheFollowUpReply();
await testFollowUpWordsUseTheirOwnClock();
await testLateToolCallIsNotRunAndItsReplyIsDropped();
await testCancelledToolTurnDropsTheFollowUp();
await testToolFailureStillReplies();
await testUnhandledToolIsReported();
await testConversationTurn();
await testConversationGreeting();
await testConversationBargeIn();
await testConversationWithoutBargeIn();
await testConversationInterrupt();
await testConversationIdleTimeout();
await testConversationSocketDrop();
await testConversationToolTurnIsOneReply();
await testConversationQueuesOverlappingReplies();
await testTokenIsCachedThenConsumed();
await testExpiredTokenIsRefetched();
await testDisposedBackendRefuses();
await testDisposeMidReplyUnblocksAsk();
await testTimingMarks();
await testTimingIsOptional();
await testTimingListenerCannotBreakATurn();
await testAudioMsFromChunks();
await testStreamsAsFramesArrive();
await testNoSpeechStartedWithoutStreaming();
await testTextOnlyBackendDoesNotStream();
await testCancelMidReplyDropsTheTail();
await testCancelBeforeReplyBeganDropsThatReply();
await testSpeechStartedHonoursAbort();
await testStreamedTimingMarks();
await testLongReplyDoesNotTimeOut();
await testSilentReplyStillTimesOut();
await testWordsFollowPlayback();
await testWordsArriveAtOnceWithoutStreaming();
await testTranscriptCompletesShortDeltas();
await testStalledClockStillReleasesText();
await testCancelledReplyWordsDropped();
await testSpeechOnsetDetection();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
