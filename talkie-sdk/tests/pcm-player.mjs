#!/usr/bin/env node
/**
 * Tests for PcmStreamPlayer — scheduling PCM chunks gaplessly as they arrive.
 *
 * Web Audio is faked with a clock the test moves by hand, so each check can say exactly
 * when a chunk was asked to start and whether the schedule stayed seamless.
 */

import { PcmStreamPlayer } from '../src/audio/pcm-player.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

const RATE = 24000;
const near = (a, b) => Math.abs(a - b) < 1e-9;

class FakeContext {
  static last = null;
  currentTime = 0;
  state = 'running';
  destination = {};
  sources = [];
  closed = false;
  constructor() { FakeContext.last = this; }
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
      end() { src.onended?.(); },
    };
    this.sources.push(src);
    return src;
  }
  async resume() { this.state = 'running'; }
  async close() { this.closed = true; }
}

/** `ms` of 16-bit mono PCM at the session rate, every sample set to `value`. */
function pcm(ms, value = 0) {
  const samples = new Int16Array(Math.round(RATE * ms / 1000));
  samples.fill(value);
  return samples.buffer;
}

async function withPlayer(fn) {
  const savedWindow = globalThis.window;
  globalThis.window = { AudioContext: FakeContext };
  try {
    const player = new PcmStreamPlayer({ sampleRate: RATE });
    await player.prepare();
    await fn(player, FakeContext.last);
  } finally {
    globalThis.window = savedWindow;
  }
}

// ── support detection ───────────────────────────────────────────────────────
{
  const saved = globalThis.window;
  globalThis.window = undefined;
  check('unsupported without a window (Node, SSR)', PcmStreamPlayer.isSupported() === false);
  globalThis.window = { AudioContext: class { createBuffer() {} } };
  check('unsupported without createBufferSource', PcmStreamPlayer.isSupported() === false);
  globalThis.window = { AudioContext: FakeContext };
  check('supported with scheduled buffer sources', PcmStreamPlayer.isSupported() === true);
  globalThis.window = saved;
}

// ── scheduling ──────────────────────────────────────────────────────────────
await withPlayer(async (player, ctx) => {
  ctx.currentTime = 5;
  player.push(pcm(10));
  player.push(pcm(10));
  player.push(pcm(20));
  const [a, b, c] = ctx.sources;
  check('the first chunk starts a small cushion ahead of now, not in the past',
    a.startAt > 5 && a.startAt < 5.2, String(a.startAt));
  check('the second chunk starts exactly where the first ends', near(b.startAt, a.startAt + 0.01),
    `${b.startAt} vs ${a.startAt + 0.01}`);
  check('the third follows the second without a gap', near(c.startAt, b.startAt + 0.01));
});

await withPlayer(async (player, ctx) => {
  // A brand-new context: the clock and the schedule both start at exactly 0.
  player.push(pcm(10));
  check('the first chunk is cushioned even on a fresh context at time 0',
    Math.abs(ctx.sources[0].startAt - 0.12) < 1e-9, String(ctx.sources[0].startAt));
});

await withPlayer(async (player, ctx) => {
  player.push(pcm(10));
  const first = ctx.sources[0].startAt;
  // The network stalls: the clock runs past everything scheduled.
  ctx.currentTime = first + 2;
  player.push(pcm(10));
  const resumed = ctx.sources[1].startAt;
  check('after a stall the schedule restarts ahead of the clock instead of in the past',
    resumed > ctx.currentTime && resumed < ctx.currentTime + 0.2, `${resumed} at ${ctx.currentTime}`);
});

await withPlayer(async (player, ctx) => {
  player.push(pcm(10, 16384));
  const data = ctx.sources[0].buffer.getChannelData(0);
  check('16-bit samples are scaled into Web Audio range', near(data[0], 0.5), String(data[0]));
  check('a chunk becomes one buffer of the right length', data.length === 240, String(data.length));
});

await withPlayer(async (player, ctx) => {
  player.push(new ArrayBuffer(0));
  check('an empty chunk schedules nothing', ctx.sources.length === 0);
});

// ── start and drain ─────────────────────────────────────────────────────────
await withPlayer(async (player) => {
  let started = false;
  const waiting = player.whenStarted().then(() => { started = true; });
  await Promise.resolve();
  check('whenStarted waits for the first chunk', started === false);
  player.push(pcm(10));
  await waiting;
  check('whenStarted resolves once audio is scheduled', started && player.started);
});

await withPlayer(async (player, ctx) => {
  player.push(pcm(10));
  player.push(pcm(10));
  let drained = false;
  player.drained().then(() => { drained = true; });
  player.finish();
  await Promise.resolve();
  check('drained waits for scheduled audio to play out', drained === false);
  ctx.sources[0].end();
  await Promise.resolve();
  check('drained still waits while a chunk is left', drained === false);
  ctx.sources[1].end();
  await Promise.resolve();
  check('drained resolves after the last chunk ends', drained === true);
});

await withPlayer(async (player, ctx) => {
  player.push(pcm(10));
  player.finish();
  player.push(pcm(10));
  check('nothing is scheduled after finish()', ctx.sources.length === 1);
});

// ── stop and reset ──────────────────────────────────────────────────────────
await withPlayer(async (player, ctx) => {
  player.push(pcm(10));
  player.push(pcm(10));
  let drained = false;
  player.drained().then(() => { drained = true; });
  player.stop();
  await Promise.resolve();
  check('stop silences every scheduled chunk', ctx.sources.every((s) => s.stopped));
  check('stop releases anyone waiting on the reply', drained === true);
  player.push(pcm(10));
  check('a stopped reply accepts no more audio', ctx.sources.length === 2);
});

await withPlayer(async (player) => {
  let settled = false;
  player.whenStarted().then(() => { settled = true; });
  player.stop();
  await Promise.resolve();
  check('stopping before any audio still releases whenStarted', settled);
  check('...without claiming playback started', player.started === false);
});

await withPlayer(async (player, ctx) => {
  player.push(pcm(10));
  player.stop();
  player.reset();
  player.push(pcm(10));
  check('reset makes the player usable for the next reply', ctx.sources.length === 2 && player.started);
  check('the next reply schedules afresh from the clock',
    ctx.sources[1].startAt >= ctx.currentTime);
});

// ── playback position ───────────────────────────────────────────────────────
await withPlayer(async (player, ctx) => {
  ctx.currentTime = 1;
  player.push(pcm(100));
  player.push(pcm(100));
  const t0 = ctx.sources[0].startAt;
  ctx.currentTime = t0 - 0.01;
  check('position is -1 before the first chunk sounds', player.positionMs() === -1);
  ctx.currentTime = t0 + 0.05;
  check('position reads 50 ms into the first chunk', Math.abs(player.positionMs() - 50) < 1e-6,
    String(player.positionMs()));
  ctx.currentTime = t0 + 0.15;
  check('position carries on into the second chunk', Math.abs(player.positionMs() - 150) < 1e-6,
    String(player.positionMs()));
  ctx.currentTime = t0 + 5;
  check('position stops at the end of what has been scheduled', Math.abs(player.positionMs() - 200) < 1e-6,
    String(player.positionMs()));
});

await withPlayer(async (player, ctx) => {
  player.push(pcm(100));
  const t0 = ctx.sources[0].startAt;
  // Stall: the next chunk lands long after the first finished playing.
  ctx.currentTime = t0 + 2;
  player.push(pcm(100));
  const t1 = ctx.sources[1].startAt;
  ctx.currentTime = t1 + 0.03;
  check('a stall does not skew the position by the length of the gap',
    Math.abs(player.positionMs() - 130) < 1e-6, String(player.positionMs()));
});

await withPlayer(async (player, ctx) => {
  await player.close();
  check('close closes the output context', ctx.closed === true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
