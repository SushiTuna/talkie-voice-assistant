#!/usr/bin/env node
/**
 * Tests for StateMachine — six-state FSM, legal/illegal transitions, error reasons.
 * Runs in Node with zero dependencies.
 */

import { StateMachine } from '../src/core/state-machine.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

function assertThrows(fn, expectedMsgContains) {
  try { fn(); return false; }
  catch (e) {
    if (expectedMsgContains && !e.message.includes(expectedMsgContains)) {
      return false;
    }
    return true;
  }
}

// ---- initial state ----
check('initial state defaults to idle', () => new StateMachine().state === 'idle');

const sm = new StateMachine();
check('initial transcript is empty string', () => sm.transcript === '');
check('initial response is empty string', () => sm.response === '');
check('initial errorReason is null', () => sm.errorReason === null);

// ---- legal transitions ----
sm.transition('listening');
check('idle -> listening', sm.state === 'listening');

sm.transition('transcribing');
check('listening -> transcribing', sm.state === 'transcribing');

sm.transition('thinking');
check('transcribing -> thinking', sm.state === 'thinking');

sm.transition('speaking');
check('thinking -> speaking', sm.state === 'speaking');

sm.transition('idle');
check('speaking -> idle', sm.state === 'idle');

sm.transition('error', { reason: 'backend-failure' });
check('idle -> error (reason=backend-failure)', sm.state === 'error' && sm.errorReason === 'backend-failure');

sm.transition('idle');
check('error -> idle', sm.state === 'idle');

// ---- illegal transitions ----
check('illegal idle->speaking throws',
  assertThrows(() => {
    const s = new StateMachine();
    s.transition('speaking');
  }, 'Illegal transition')
);

check('illegal listening->speaking throws',
  assertThrows(() => {
    const s = new StateMachine();
    s.transition('listening');
    s.transition('speaking');
  }, 'Illegal transition')
);

// Note: transcribing->idle and thinking->idle are now LEGAL (cancel paths per spec).

check('illegal speaking->thinking throws',
  assertThrows(() => {
    const s = new StateMachine();
    s.transition('listening').transition('transcribing').transition('thinking').transition('speaking');
    s.transition('thinking');
  }, 'Illegal transition')
);

check('illegal error->thinking throws',
  assertThrows(() => {
    const s = new StateMachine({ initialState: 'error', errorReason: 'offline' });
    s.transition('thinking');
  }, 'Illegal transition')
);

// ---- invalid error reason throws ----
check('invalid error reason throws TypeError',
  assertThrows(() => {
    const s = new StateMachine();
    s.transition('error', { reason: 'nonexistent' });
  }, 'Invalid error reason')
);

// ---- all valid error reasons round-trip ----
for (const reason of ['mic-permission-denied', 'no-speech-detected', 'offline', 'backend-failure', 'unknown']) {
  const s = new StateMachine();
  s.transition('error', { reason });
  check(`reason "${reason}" round-trips`, s.state === 'error' && s.errorReason === reason);
  s.transition('idle');
}

// ---- cancel: listening -> idle resets transcript ----
const sm2 = new StateMachine();
sm2.transcript = 'hello world';
sm2.transition('listening');
sm2.transition('idle');
check('cancel listening resets transcript', sm2.transcript === '');

// ---- event emission ----
const events = [];
const sm3 = new StateMachine();
sm3.onChange((e) => events.push(e));
sm3.transition('listening');
sm3.transition('transcribing');
check('change event carries {from, to}',
  events.length === 2 && events[0].from === 'idle' && events[0].to === 'listening'
  && events[1].from === 'listening' && events[1].to === 'transcribing');

// ---- unsubscribe ----
const sm4 = new StateMachine();
const unsub = sm4.onChange(() => {});
unsub();
check('onChange returns a function', typeof unsub === 'function');

// ---- reset ----
const sm5 = new StateMachine();
sm5.transition('listening').transition('error', { reason: 'offline' });
sm5.reset();
check('reset brings to idle, clears data',
  sm5.state === 'idle' && sm5.errorReason === null && sm5.transcript === '' && sm5.response === '');

// ---- error state carries reason even from initial config ----
const smErr = new StateMachine({ initialState: 'error', errorReason: 'no-speech-detected' });
check('error initial reason persists', smErr.state === 'error' && smErr.errorReason === 'no-speech-detected');

// ---- DEFECT FIX #2: reset() emits change event even when already idle ----
{
  const sm6 = new StateMachine();
  sm6.transition('listening').transition('transcribing');
  let fired = 0;
  sm6.onChange(() => fired++);
  sm6.reset();
  check('reset fires a change event with {from, to}', fired === 1);
}
{
  const sm7 = new StateMachine(); // already idle
  let fired = 0;
  sm7.onChange(() => fired++);
  sm7.reset(); // reset while already idle
  check('reset emits event even when already idle', fired >= 1);
}

// ---- DEFECT FIX #3: invalid error reason must not mutate state ----
{
  const sm8 = new StateMachine();
  try { sm8.transition('error', { reason: 'bogus' }); } catch (_) {}
  check('invalid reason does NOT corrupt state', sm8.state === 'idle' && sm8.errorReason === null);
}
{
  const sm9 = new StateMachine();
  let evtCount = 0;
  sm9.onChange(() => evtCount++);
  try { sm9.transition('error', { reason: 'bogus' }); } catch (_) {}
  check('invalid reason emits NO events', evtCount === 0);
  check('invalid reason leaves machine in original state', sm9.state === 'idle');
}

// ---- DEFECT FIX #5: transcribing -> idle is now legal (cancel) ----
check('legal transition transcribing->idle', () => {
  const s = new StateMachine();
  s.transition('listening').transition('transcribing');
  try { s.transition('idle'); return s.state === 'idle'; } catch { return false; }
});

// ---- DEFECT FIX #5: thinking -> idle is now legal (cancel) ----
check('legal transition thinking->idle', () => {
  const s = new StateMachine();
  s.transition('listening').transition('transcribing').transition('thinking');
  try { s.transition('idle'); return s.state === 'idle'; } catch { return false; }
});

// ---- DEFECT FIX #5: cancel clears transcript AND response ----
{
  const sm10 = new StateMachine();
  sm10.transcript = 'user spoke something';
  sm10.response = 'assistant was replying';
  sm10.transition('listening').transition('transcribing');
  try {
    sm10.transition('idle');
  } catch (_) {}
  check('cancel from transcribing clears transcript', sm10.transcript === '');
  check('cancel from transcribing clears response', sm10.response === '');
}
{
  const sm11 = new StateMachine();
  sm11.transcript = 'user text';
  sm11.response = 'partial answer';
  sm11.transition('listening').transition('transcribing').transition('thinking');
  try {
    sm11.transition('idle');
  } catch (_) {}
  check('cancel from thinking clears transcript', sm11.transcript === '');
  check('cancel from thinking clears response', sm11.response === '');
}

console.log(`\n${passed}/${passed + failed} tests passed`);
process.exit(failed > 0 ? 1 : 0);
