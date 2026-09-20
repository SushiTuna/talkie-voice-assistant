#!/usr/bin/env node
/**
 * Tests for the PCM codec helpers — base64 round-tripping, silence sizing and the WAV
 * header the agent transport's headerless audio needs before it can be played.
 *
 * Runs in Node with zero additional dependencies.
 */

import {
  encodeBase64,
  decodeBase64,
  silenceFrame,
  pcmToWavBytes,
  pcmToWavBlob,
} from '../src/audio/pcm-codec.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

/** Read a little-endian uint32 out of a byte array. */
function u32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
}

/** Read a little-endian uint16 out of a byte array. */
function u16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, true);
}

/** Read `length` ASCII characters. */
function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

// ── base64 ──────────────────────────────────────────────────────────────────
{
  const samples = new Int16Array([0, 1, -1, 32767, -32768, 1234, -4321]);
  const round = new Int16Array(decodeBase64(encodeBase64(samples.buffer)));
  check('base64 round-trips PCM16 exactly',
    round.length === samples.length && samples.every((v, i) => round[i] === v),
    `got [${round.join(',')}]`);

  check('encodeBase64 accepts a Uint8Array as well as an ArrayBuffer',
    encodeBase64(new Uint8Array([1, 2, 3])) === encodeBase64(new Uint8Array([1, 2, 3]).buffer));

  check('empty buffer encodes to an empty string', encodeBase64(new ArrayBuffer(0)) === '');

  // A single String.fromCharCode(...bytes) throws or truncates well before this size,
  // which is why the encoder strides; a 1 s frame is a realistic worst case.
  const big = new Int16Array(24000);
  for (let i = 0; i < big.length; i++) big[i] = (i % 2000) - 1000;
  const bigRound = new Int16Array(decodeBase64(encodeBase64(big.buffer)));
  check('base64 survives a one-second 24 kHz frame without a call-stack overflow',
    bigRound.length === big.length && bigRound[23999] === big[23999]);
}

// ── silence ─────────────────────────────────────────────────────────────────
{
  const frame = silenceFrame(24000, 50);
  const samples = new Int16Array(frame);
  check('silenceFrame sizes by rate and duration', samples.length === 1200, `got ${samples.length}`);
  check('silenceFrame is actually silent', samples.every((v) => v === 0));
  check('silenceFrame(rate, 0) is empty', new Int16Array(silenceFrame(24000, 0)).length === 0);
}

// ── WAV container ───────────────────────────────────────────────────────────
{
  const a = new Int16Array([1, 2, 3, 4]).buffer;
  const b = new Int16Array([5, 6]).buffer;
  const wav = pcmToWavBytes([a, b], 24000);

  check('WAV is 44 header bytes plus the PCM', wav.length === 44 + 12, `got ${wav.length}`);
  check('WAV starts with RIFF', ascii(wav, 0, 4) === 'RIFF');
  check('RIFF size counts everything after the size field', u32(wav, 4) === 36 + 12, `got ${u32(wav, 4)}`);
  check('WAVE tag present', ascii(wav, 8, 4) === 'WAVE');
  check('fmt chunk present', ascii(wav, 12, 4) === 'fmt ');
  check('fmt body is 16 bytes', u32(wav, 16) === 16);
  check('format is uncompressed PCM', u16(wav, 20) === 1);
  check('mono', u16(wav, 22) === 1);
  check('sample rate carried through', u32(wav, 24) === 24000);
  check('byte rate is rate * 2 for mono PCM16', u32(wav, 28) === 48000, `got ${u32(wav, 28)}`);
  check('block align is 2', u16(wav, 32) === 2);
  check('16 bits per sample', u16(wav, 34) === 16);
  check('data chunk present', ascii(wav, 36, 4) === 'data');
  check('data size excludes the header', u32(wav, 40) === 12, `got ${u32(wav, 40)}`);

  const payload = new Int16Array(wav.buffer.slice(44));
  check('chunks are concatenated in order',
    [...payload].join(',') === '1,2,3,4,5,6', `got [${payload.join(',')}]`);

  const empty = pcmToWavBytes([], 24000);
  check('an empty reply still produces a valid, zero-length WAV',
    empty.length === 44 && u32(empty, 40) === 0);

  const blob = pcmToWavBlob([a], 24000);
  check('pcmToWavBlob is typed audio/wav', blob.type === 'audio/wav');
  check('pcmToWavBlob carries the whole file', blob.size === 44 + 8, `got ${blob.size}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
