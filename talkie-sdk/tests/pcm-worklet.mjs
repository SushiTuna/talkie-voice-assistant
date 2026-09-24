#!/usr/bin/env node
/**
 * Tests for the PCM capture worklet.
 *
 * AudioWorklet only exists in a browser, so this evaluates the *shipped* processor
 * source against a minimal shim of the AudioWorkletGlobalScope and drives `process()`
 * directly. That covers the resampling and Float32 -> Int16 conversion — the parts
 * most likely to be wrong — without a browser. The audio-graph plumbing around it
 * still needs a real page with microphone permission.
 */

import { PCM_WORKLET_SOURCE } from '../src/audio/pcm-worklet.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

/**
 * Evaluate the worklet source in a shimmed global scope and return an instance.
 * @param {number} contextRate - The AudioContext rate the processor should see.
 * @param {object} processorOptions
 */
function makeProcessor(contextRate, processorOptions) {
  let Registered = null;
  const scope = {
    sampleRate: contextRate,
    registerProcessor: (_name, cls) => { Registered = cls; },
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } },
  };
  // eslint-disable-next-line no-new-func
  const load = new Function('sampleRate', 'registerProcessor', 'AudioWorkletProcessor', PCM_WORKLET_SOURCE);
  load(scope.sampleRate, scope.registerProcessor, scope.AudioWorkletProcessor);
  if (!Registered) throw new Error('worklet source did not call registerProcessor');

  const posted = [];
  const proc = new Registered({ processorOptions });
  proc.port = {
    postMessage: (buf) => posted.push(new Int16Array(buf)),
    onmessage: null,
  };
  // The constructor installed its own handler on the old port object; re-run the
  // stop wiring against the replacement.
  proc.port.onmessage = (e) => {
    if (e.data === 'stop') { proc._flush(); proc._stopped = true; }
  };
  return { proc, posted };
}

/** @returns {Float32Array} `seconds` of a sine wave at `rate`. */
function tone(rate, seconds, freq = 440, amplitude = 0.5) {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amplitude;
  return out;
}

/** Feed a signal through the processor in 128-sample render quanta. */
function pump(proc, signal) {
  for (let i = 0; i < signal.length; i += 128) {
    proc.process([[signal.subarray(i, Math.min(i + 128, signal.length))]]);
  }
}

// ── registration ────────────────────────────────────────────────────────────
{
  const { proc } = makeProcessor(48000, { targetSampleRate: 16000, chunkSamples: 1600 });
  check('source registers a processor', typeof proc.process === 'function');
}

// ── downsampling 48k -> 16k ─────────────────────────────────────────────────
{
  const { proc, posted } = makeProcessor(48000, { targetSampleRate: 16000, chunkSamples: 1600 });
  pump(proc, tone(48000, 1.0));
  proc.port.onmessage({ data: 'stop' });

  const samples = posted.reduce((n, c) => n + c.length, 0);
  // One second in should give ~16000 samples out, allowing for the final partial chunk.
  check('48k -> 16k yields roughly one second of samples',
    Math.abs(samples - 16000) < 200, `got ${samples}`);
  check('chunks are 1600 samples (100 ms)',
    posted.slice(0, -1).every((c) => c.length === 1600),
    posted.map((c) => c.length).join(','));
  check('output is Int16', posted[0] instanceof Int16Array);
}

// ── pass-through at the target rate ─────────────────────────────────────────
{
  const { proc, posted } = makeProcessor(16000, { targetSampleRate: 16000, chunkSamples: 1600 });
  pump(proc, tone(16000, 1.0));
  proc.port.onmessage({ data: 'stop' });
  const samples = posted.reduce((n, c) => n + c.length, 0);
  check('16k in, 16k out passes through 1:1',
    Math.abs(samples - 16000) < 50, `got ${samples}`);
}

// ── 44.1k -> 16k, a non-integer ratio ───────────────────────────────────────
{
  const { proc, posted } = makeProcessor(44100, { targetSampleRate: 16000, chunkSamples: 1600 });
  pump(proc, tone(44100, 1.0));
  proc.port.onmessage({ data: 'stop' });
  const samples = posted.reduce((n, c) => n + c.length, 0);
  // A fractional ratio is where a resampler that resets its read position each render
  // block drifts; 44100/16000 = 2.75625 exercises that directly.
  check('44.1k -> 16k stays within 2% of one second',
    Math.abs(samples - 16000) < 320, `got ${samples}`);
}

// ── amplitude and clipping ──────────────────────────────────────────────────
{
  const { proc, posted } = makeProcessor(16000, { targetSampleRate: 16000, chunkSamples: 160 });
  pump(proc, tone(16000, 0.05, 440, 1.0));
  proc.port.onmessage({ data: 'stop' });
  const all = posted.flatMap((c) => Array.from(c));
  const peak = Math.max(...all.map(Math.abs));
  check('full-scale input reaches near Int16 max',
    peak > 32000 && peak <= 32768, `peak ${peak}`);
  check('signal is not silent', all.some((v) => v !== 0));
}

{
  // Values outside [-1, 1] must clamp, not wrap: an unclamped +1.5 would overflow the
  // Int16 range and come back as a large negative, which sounds like a loud click.
  const { proc, posted } = makeProcessor(16000, { targetSampleRate: 16000, chunkSamples: 8 });
  const hot = new Float32Array(16).fill(1.5);
  hot.set(new Float32Array(8).fill(-1.5), 8);
  pump(proc, hot);
  proc.port.onmessage({ data: 'stop' });
  const all = posted.flatMap((c) => Array.from(c));
  check('over-range positives clamp to +32767',
    all.slice(0, 8).every((v) => v === 32767), all.slice(0, 8).join(','));
  check('over-range negatives clamp to -32768',
    all.slice(8, 16).every((v) => v === -32768), all.slice(8, 16).join(','));
}

// ── lifecycle ───────────────────────────────────────────────────────────────
{
  const { proc, posted } = makeProcessor(16000, { targetSampleRate: 16000, chunkSamples: 1600 });
  pump(proc, tone(16000, 0.02));  // 320 samples — well under one chunk
  check('a partial buffer is not posted early', posted.length === 0);
  proc.port.onmessage({ data: 'stop' });
  check('stop flushes the partial buffer so the last word survives',
    posted.length === 1 && posted[0].length === 320, posted.map((c) => c.length).join(','));
  check('process() returns false once stopped', proc.process([[new Float32Array(128)]]) === false);
}

{
  const { proc } = makeProcessor(48000, { targetSampleRate: 16000, chunkSamples: 1600 });
  check('an empty input block is survivable', proc.process([[]]) === true);
  check('a missing input is survivable', proc.process([]) === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
