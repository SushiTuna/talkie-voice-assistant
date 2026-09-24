/**
 * Mock TalkieBackend — replays the four Q&A pairs from the HTML mockup's SCRIPT array.
 *
 * Timings match the mockup: 950 ms transcribe phase, 1 500 ms think phase before speaking starts.
 */

import { TalkieBackendError } from '../core/backend.js';

// The exact SCRIPT content extracted from the mockup.
export const SCRIPT = Object.freeze([
  {
    q: 'How much does the Pro plan cost?',
    a: 'Pro is $24 per seat per month when billed annually — or $29 month-to-month. Every plan starts with a 14-day trial, and you can downgrade any time without losing data.',
  },
  {
    q: 'Does it integrate with Slack?',
    a: 'Yes — the native Slack app syncs channels, threads, and mentions in real time. Setup takes about two minutes under Integrations → Slack → Connect. Zapier and webhooks cover everything else.',
  },
  {
    q: 'Which browsers are supported?',
    a: 'Chrome, Edge, Firefox, and Safari from the last two major releases. Voice features need a WebRTC-capable browser; on mobile, iOS 16+ and Android 12+ are fully supported.',
  },
  {
    q: 'Can I export my analytics?',
    a: 'Absolutely. Export any dashboard as CSV or PDF, schedule recurring email reports, or pull raw events through the REST API — no row limits on Pro and above.',
  },
]);

const TRANSCRIBE_DELAY = 950; // ms — matches mockup `later(toThinking, 950)`
const THINK_DELAY = 1500;     // ms — matches mockup `later(toSpeaking, 1500)`

/**
 * Split text into chunks roughly word-sized (≥8 chars each) for streaming simulation.
 * Tracks indices explicitly to avoid O(n²) indexOf / includes lookups.
 * Output is lossless: joining yielded chunks with a single space reproduces the input exactly.
 */
export function* chunkText(text) {
  const words = text.split(/\s+/);
  let buffer = '';
  for (let i = 0; i < words.length; i++) {
    buffer += (buffer ? ' ' : '') + words[i];
    if (buffer.length >= 8 || i === words.length - 1) {
      yield buffer;
      buffer = '';
    }
  }
}

export class MockBackend {
  /** @type {number} Current SCRIPT index (advances only in stopCapture). */
  #idx = 0;

  constructor() {
    this.#disposed = false;
  }
  #disposed;

  /** Begin microphone capture (mock — resolves immediately). */
  async startCapture() {
    if (this.#disposed) throw new TalkieBackendError('backend-failure', 'Backend disposed');
  }

  /** Return the mock transcript (the question from SCRIPT), advancing the round-robin index. */
  async stopCapture() {
    if (this.#disposed) throw new TalkieBackendError('backend-failure', 'Backend disposed');
    const entry = SCRIPT[this.#idx % SCRIPT.length];
    this.#idx++;
    return entry.q;
  }

  /**
   * Simulate LLM streaming: look up the answer matching the provided transcript,
   * then yield chunks after transcribe + think phases.
   * Honours the AbortSignal — aborting mid-stream stops yielding promptly.
   *
   * @param {string} transcript - The user's recognized text; matched against SCRIPT entries.
   * @param {AbortSignal} signal
   * @returns {AsyncIterable<string>}
   */
  async *ask(transcript, signal) {
    if (this.#disposed) throw new TalkieBackendError('backend-failure', 'Backend disposed');

    // Look up the SCRIPT entry whose question matches the transcript.
    let entry = SCRIPT.find(s => s.q === transcript);
    if (!entry) {
      // Fallback: use the first entry when the transcript matches no SCRIPT row.
      entry = SCRIPT[0];
    }

    // Phase 1: transcribe delay.
    await this.#sleep(TRANSCRIBE_DELAY, signal);
    if (signal.aborted) throw signal.reason;

    // Phase 2: thinking delay.
    await this.#sleep(THINK_DELAY, signal);
    if (signal.aborted) throw signal.reason;

    // Phase 3: stream answer chunks.
    for (const chunk of chunkText(entry.a)) {
      if (signal.aborted) throw signal.reason;
      yield chunk;
      // Small yield to allow AbortSignal checks between chunks.
      await this.#sleep(80, signal);
    }
  }

  /** Optional TTS — mocks speaking by resolving after ~400 ms per word. */
  async speak(text, signal) {
    if (this.#disposed) throw new TalkieBackendError('backend-failure', 'Backend disposed');
    // Simple paced delay: 400ms per word.
    const totalMs = Math.ceil(text.split(/\s+/).length) * 400;
    await this.#sleep(totalMs, signal);
  }

  dispose() {
    this.#disposed = true;
  }

  /** Internal sleep helper that honours abort. */
  #sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
    });
  }
}
