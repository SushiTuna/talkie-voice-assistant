/**
 * Six-state finite state machine for the Talkie Voice UI.
 * Pure JavaScript — no DOM, no browser APIs. Fully testable in Node.
 *
 * Legal transitions (reject anything else):
 *   idle        -> listening, error
 *   listening   -> transcribing, idle (cancel), error
 *   transcribing-> thinking, idle (cancel), error
 *   thinking    -> speaking, idle (cancel), error
 *   speaking    -> idle, error
 *   error       -> idle
 */

const VALID_STATES = ['idle', 'listening', 'transcribing', 'thinking', 'speaking', 'error'];

const ERROR_REASONS = Object.freeze([
  'mic-permission-denied',
  'no-speech-detected',
  'offline',
  'backend-failure',
  'unknown',
]);

// Map from current state → set of allowed next states (and actions).
const TRANSITIONS = Object.freeze({
  idle: new Set(['listening', 'error']),
  listening: new Set(['transcribing', 'idle', 'error']),
  transcribing: new Set(['thinking', 'idle', 'error']),
  thinking: new Set(['speaking', 'idle', 'error']),
  speaking: new Set(['idle', 'error']),
  error: new Set(['idle']),
});

const TRANSITION_LABELS = Object.freeze({
  idle_listening: 'startListening',
  idle_error: 'transitionToError',
  listening_transcribing: 'startTranscribing',
  listening_idle: 'cancelListening',
  listening_error: 'transitionToError',
  transcribing_thinking: 'startThinking',
  transcribing_idle: 'cancelTranscribing',
  transcribing_error: 'transitionToError',
  thinking_speaking: 'startSpeaking',
  thinking_idle: 'cancelThinking',
  thinking_error: 'transitionToError',
  speaking_idle: 'stopSpeaking',
  speaking_error: 'transitionToError',
  error_idle: 'retry',
});

/**
 * @param {any} reason - Value to validate as an error reason.
 * @returns {string} The validated reason string.
 * @throws {TypeError} If the value is not a valid error reason.
 */
function validateReason(reason) {
  if (!ERROR_REASONS.includes(reason)) {
    throw new TypeError(
      `Invalid error reason "${reason}". Must be one of: ${ERROR_REASONS.join(', ')}`
    );
  }
  return reason;
}

/**
 * @param {string} from - Current state.
 * @param {string} to - Target state.
 * @throws {Error} If the transition is not legal.
 */
function validateTransition(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed?.has(to)) {
    const label = TRANSITION_LABELS[`${from}_${to}`] ?? `${from}→${to}`;
    const options = [...TRANSITIONS[from]].join(', ');
    throw new Error(`Illegal transition ${label}: cannot go from "${from}" to "${to}". Allowed: [${options}]`);
  }
}

export class StateMachine {
  /**
   * @param {object} [options] - Initial configuration.
   * @param {'idle'|'listening'|'transcribing'|'thinking'|'speaking'|'error'} [options.initialState='idle']
   * @param {('mic-permission-denied'|'no-speech-detected'|'offline'|'backend-failure'|'error')} [options.errorReason]
   */
  constructor(options = {}) {
    this._listeners = [];
    this._state = options.initialState ?? 'idle';
    this._transcript = '';
    this._response = '';
    this._errorReason = null;

    if (this._state === 'error') {
      this._errorReason = options.errorReason ? validateReason(options.errorReason) : 'unknown';
    }
  }

  /**
   * @returns {string} The current state.
   */
  get state() {
    return this._state;
  }

  /**
   * @returns {string} The accumulated transcript from user speech recognition.
   */
  get transcript() {
    return this._transcript;
  }

  /**
   * @param {string} value - The new transcript text.
   */
  set transcript(value) {
    this._transcript = value;
  }

  /**
   * @returns {string} The accumulated assistant response text.
   */
  get response() {
    return this._response;
  }

  /**
   * @param {string} value - The new response text.
   */
  set response(value) {
    this._response = value;
  }

  /**
   * @returns {string | null} The current error reason, or null if not in error state.
   */
  get errorReason() {
    return this._errorReason;
  }

  /**
   * Transition to a new state. Throws if the transition is illegal.
   * Emits a change event before returning.
   *
   * @param {string} nextState - The target state.
   * @param {object} [extra] - Extra payload for the event.
   * @returns {StateMachine} This instance for chaining.
   */
  transition(nextState, extra = {}) {
    validateTransition(this._state, nextState);

    const fromState = this._state;

    // Validate error reason BEFORE mutating any fields.
    if (nextState === 'error') {
      const reason = extra.reason || 'unknown';
      validateReason(reason); // throws on invalid reason — no mutation has happened yet
      this._errorReason = reason;
    } else {
      this._errorReason = null;
    }

    if (nextState === 'idle') {
      // Cancelling out of any in-flight state resets transcript and response.
      this._transcript = '';
      this._response = '';
    }

    this._state = nextState;

    // Notify listeners synchronously.
    const event = { type: 'change', from: fromState, to: nextState, ...extra };
    for (const fn of this._listeners) {
      try { fn(event); } catch (_) { /* don't break other listeners */ }
    }

    return this;
  }

  /**
   * Subscribe to state-change events. Returns an unsubscribe function.
   *
   * @param {(event: {type: string, from: string, to: string, [key]: any}) => void} fn
   * @returns {() => void} Unsubscribe function.
   */
  onChange(fn) {
    this._listeners.push(fn);
    return () => {
      const idx = this._listeners.indexOf(fn);
      if (idx !== -1) this._listeners.splice(idx, 1);
    };
  }

  /**
   * Reset to idle state. Always emits a change event (even if already idle).
   * @returns {StateMachine}
   */
  reset() {
    const fromState = this._state;
    this._transcript = '';
    this._response = '';
    this._errorReason = null;
    this._state = 'idle';

    // Notify listeners — consistent with other transitions.
    const event = { type: 'change', from: fromState, to: 'idle' };
    for (const fn of this._listeners) {
      try { fn(event); } catch (_) { /* don't break other listeners */ }
    }

    return this;
  }
}

export { VALID_STATES, ERROR_REASONS, TRANSITIONS, TRANSITION_LABELS };
