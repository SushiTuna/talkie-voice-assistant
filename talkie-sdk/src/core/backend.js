/**
 * Backend interface contract for the Talkie Voice UI SDK.
 *
 * The widget accepts a backend instance and never imports a concrete one.
 * This file defines the types and the error class — it holds no transport logic.
 */

/**
 * Concrete backend implementation that the widget wires into.
 * @typedef {Object} TalkieBackend
 * @property {() => Promise<void>} startCapture
 *   Begin microphone capture; reject on permission denial.
 * @property {() => Promise<string>} stopCapture
 *   End capture, resolve with the recognised transcript string.
 * @property {(transcript: string, signal: AbortSignal) => AsyncIterable<string>} ask
 *   Send the transcript, yield response text incrementally (token / word chunks).
 * @property {(text: string, signal: AbortSignal) => Promise<void>} [speak]
 *   Optional TTS synthesis; when absent the widget renders text only.
 * @property {() => void} [dispose]
 *   Clean up resources; called once when the widget is destroyed.
 */

/**
 * Error class that backends use to carry structured failure information.
 * Widget code maps these to the FSM's error-reason values.
 */
export class TalkieBackendError extends Error {
  /**
   * @param {string} reason - One of the five FSM error reasons.
   * @param {string} [message] - Human-readable description.
   */
  constructor(reason, message) {
    super(message ?? reason);
    this.name = 'TalkieBackendError';
    this.reason = reason;
  }
}

/**
 * Pre-defined reason strings for validation consistency.
 * @readonly
 * @type {ReadonlyArray<'mic-permission-denied'|'no-speech-detected'|'offline'|'backend-failure'|'unknown'>}
 */
export const BACKEND_ERROR_REASONS = Object.freeze([
  'mic-permission-denied',
  'no-speech-detected',
  'offline',
  'backend-failure',
  'unknown',
]);
