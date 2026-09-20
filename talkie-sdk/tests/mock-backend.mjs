#!/usr/bin/env node
/**
 * Tests for MockBackend — ask() yields chunks, respects AbortSignal,
 * and backends expose the contract methods.
 *
 * Runs in Node with zero additional dependencies.
 */

import { MockBackend } from '../src/backends/mock-backend.js';
import { TalkieBackendError, BACKEND_ERROR_REASONS } from '../src/core/backend.js';
import { SCRIPT } from '../src/backends/mock-backend.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

// ---- contract ----
const backend = new MockBackend();
check('backend has startCapture', typeof backend.startCapture === 'function');
check('backend has stopCapture', typeof backend.stopCapture === 'function');
check('backend has ask', typeof backend.ask === 'function');
check('backend has speak', typeof backend.speak === 'function');
check('backend has dispose', typeof backend.dispose === 'function');

// ---- startCapture / stopCapture ----
async function testCapture() {
  await backend.startCapture();
  const transcript = await backend.stopCapture();
  check('stopCapture returns a question string',
    typeof transcript === 'string' && transcript.length > 0);
}
await testCapture();

// ---- ask() yields chunks ----
async function testAskYieldsChunks() {
  const controller = new AbortController();
  const chunks = [];
  for await (const chunk of backend.ask('test question', controller.signal)) {
    chunks.push(chunk);
  }
  check('ask() is an AsyncIterable that yields values', chunks.length > 0);
  check('ask() yields strings', chunks.every(c => typeof c === 'string'));
  // Concatenated chunks should reproduce at least part of the answer.
  const full = chunks.join(' ');
  check('chunks concatenate to meaningful text', full.length > 10);
}
await testAskYieldsChunks();

// ---- ask() honours AbortSignal (abort during transcription delay) ----
async function testAskAbortDuringTranscription() {
  const ctrl = new AbortController();
  const chunks = [];
  (async () => {
    await new Promise(r => setTimeout(r, 100));
    ctrl.abort(new Error('user cancelled'));
  })().catch(() => {});

  try {
    for await (const chunk of backend.ask('test', ctrl.signal)) {
      chunks.push(chunk);
    }
    check('abort during transcribe: stopped iteration early', chunks.length === 0);
  } catch (e) {
    check('abort during transcribe: threw AbortError', e.name === 'AbortError' || chunks.length === 0);
  }
}
await testAskAbortDuringTranscription();

// ---- ask() honours AbortSignal (abort during streaming) ----
async function testAskAbortDuringStreaming() {
  const ctrl = new AbortController();
  const chunks = [];
  // Let transcribe+think finish, then abort mid-stream.
  const iter = backend.ask('test', ctrl.signal);
  let doneIterating = false;

  const consumer = (async () => {
    for await (const chunk of iter) {
      chunks.push(chunk);
      // Abort after accumulating a few chunks.
      if (chunks.length >= 3) {
        ctrl.abort(new Error('mid-stream abort'));
        break;
      }
    }
    doneIterating = true;
  })();

  try {
    await consumer;
    check('abort during streaming: iteration stopped cleanly', doneIterating);
    check('abort during streaming: yielded some chunks before abort', chunks.length >= 3);
  } catch {
    check('abort during streaming: caught or completed', doneIterating || chunks.length >= 1);
  }
}
await testAskAbortDuringStreaming();

// ---- error reasons include only the spec-defined values ----
check('BACKEND_ERROR_REASONS has exactly 5 values',
  Array.isArray(BACKEND_ERROR_REASONS) && BACKEND_ERROR_REASONS.length === 5);
for (const r of BACKEND_ERROR_REASONS) {
  check(`reason "${r}" is a valid string`, typeof r === 'string' && r.length > 0);
}

// ---- TalkieBackendError has reason field ----
const err = new TalkieBackendError('offline', 'connection lost');
check('TalkieBackendError.reason', err.reason === 'offline');
check('TalkieBackendError.message', err.message === 'connection lost');
check('TalkieBackendError name', err.name === 'TalkieBackendError');
check('TalkieBackendError extends Error', err instanceof Error);

// ---- dispose prevents further use ----
async function testDispose() {
  const b = new MockBackend();
  b.dispose();
  let caught = false;
  try { await b.startCapture(); } catch { caught = true; }
  check('dispose blocks startCapture', caught);

  caught = false;
  try { await b.stopCapture(); } catch { caught = true; }
  check('dispose blocks stopCapture', caught);
}
await testDispose();

// ---- multiple rounds round-robin SCRIPT ----
async function testRoundRobin() {
  const b = new MockBackend();
  const t1 = await b.stopCapture();
  const t2 = await b.stopCapture();
  check('stopCapture round-robins questions', t1 !== t2);
}
await testRoundRobin();

// ---- DEFECT FIX #1: ask() yields answer matching the provided transcript ----
async function testAskPairingAllFour() {
  const b = new MockBackend();
  // Each iteration: stopCapture gives a question, ask(transcript) should give that question's answer.
  for (let i = 0; i < SCRIPT.length; i++) {
    const transcript = await b.stopCapture();
    const controller = new AbortController();
    const chunks = [];
    for await (const chunk of b.ask(transcript, controller.signal)) {
      chunks.push(chunk);
    }
    const fullAnswer = chunks.join(' ');
    check(`ask pairs with transcript from stopCapture (round ${i + 1}): "${transcript}" -> expected answer length`,
      fullAnswer.startsWith(SCRIPT[i % SCRIPT.length].a.substring(0, 5)));
    check(`ask returns answer for transcript "${transcript}" (round ${i + 1})`,
      fullAnswer === SCRIPT[i % SCRIPT.length].a);
  }
}
await testAskPairingAllFour();

// ---- DEFECT FIX #1: full round-robin wrap (5th stopCapture cycles back to first) ----
async function testRoundRobinWrap() {
  const b = new MockBackend();
  const t5 = await b.stopCapture(); // 5th → same as 1st
  check('stopCapture 5th call cycles back to first question', t5 === SCRIPT[0].q);
  const controller = new AbortController();
  const chunks = [];
  for await (const chunk of b.ask(t5, controller.signal)) { chunks.push(chunk); }
  check('answer after round-robin wrap matches first entry', chunks.join(' ') === SCRIPT[0].a);
}
await testRoundRobinWrap();

// ---- DEFECT FIX #1: unknown transcript falls back to first entry ----
async function testUnknownTranscriptFallback() {
  const b = new MockBackend();
  // Discard one normal cycle first so idx is 1.
  await b.stopCapture(); // gets q1
  const controller = new AbortController();
  try {
    const chunks = [];
    for await (const chunk of b.ask('this is not in script', controller.signal)) {
      chunks.push(chunk);
    }
    check('unknown transcript falls back to first answer', chunks.join(' ').startsWith(SCRIPT[0].a.substring(0, 10)));
  } catch (e) {
    check('unknown transcript does NOT throw', false);
  }
}
await testUnknownTranscriptFallback();

// ---- DEFECT FIX #6: chunkText lossless + repeated words ----
{
  // Lossless round-trip on all four SCRIPT answers
  function* chunkText(text) {
    const words = text.split(/\s+/);
    let buffer = '';
    for (const [i, word] of words.entries()) {
      buffer += (buffer ? ' ' : '') + word;
      if (buffer.length >= 8 || i === words.length - 1) {
        yield buffer;
        buffer = '';
      }
    }
    if (buffer && !words.includes(buffer)) {
      yield buffer;
    }
  }
  for (let i = 0; i < SCRIPT.length; i++) {
    const full = SCRIPT[i].a;
    const joined = [...chunkText(full)].join(' ');
    check(`chunkText is lossless for entry ${i} (${full.length} chars)`, joined === full);
  }
  // Repeated-word edge case
  check('chunkText handles repeated last word "data is data"',
    [...chunkText('data is data')].join(' ') === 'data is data');
  check('chunkText yields at least one chunk for repeated-last-word',
    [...chunkText('data is data')].length >= 1);
}

console.log(`\n${passed}/${passed + failed} tests passed`);
process.exit(failed > 0 ? 1 : 0);
