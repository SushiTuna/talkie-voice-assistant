/**
 * Microphone capture that emits 16-bit PCM chunks at a fixed sample rate.
 *
 * The widget's backend contract has no streaming hook — `startCapture()` opens the
 * mic and `stopCapture()` returns a transcript — so this class owns the audio graph
 * for the span between them and hands each chunk to a callback.
 */

import { createWorkletUrl } from './pcm-worklet.js';
import { TalkieBackendError } from '../core/backend.js';

/** @typedef {(chunk: ArrayBuffer) => void} ChunkHandler */

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHUNK_MS = 100;

export class MicCapture {
  /** @type {MediaStream | null} */ #stream = null;
  /** @type {AudioContext | null} */ #ctx = null;
  /** @type {AudioWorkletNode | null} */ #node = null;
  /** @type {MediaStreamAudioSourceNode | null} */ #source = null;
  /** @type {ChunkHandler | null} */ #onChunk = null;

  /**
   * @param {object} [options]
   * @param {number} [options.sampleRate=16000] - Target rate for emitted PCM.
   * @param {number} [options.chunkMs=100] - Chunk length in milliseconds.
   */
  constructor({ sampleRate = DEFAULT_SAMPLE_RATE, chunkMs = DEFAULT_CHUNK_MS } = {}) {
    this.sampleRate = sampleRate;
    this.chunkMs = chunkMs;
  }

  /** @returns {boolean} True while the audio graph is live. */
  get active() {
    return this.#node !== null;
  }

  /**
   * Open the microphone and begin emitting PCM chunks.
   *
   * @param {ChunkHandler} onChunk - Called with each ArrayBuffer of PCM data.
   * @returns {Promise<void>}
   * @throws {TalkieBackendError} `mic-permission-denied` when the user blocks the mic
   *   or no input device exists; `backend-failure` for anything else.
   */
  async start(onChunk) {
    if (this.active) return;
    this.#onChunk = onChunk;

    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      this.#onChunk = null;
      // NotAllowedError is a block; NotFoundError is no device at all. Both are
      // things the person can fix, so they map to the same actionable reason.
      const name = err?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotFoundError') {
        throw new TalkieBackendError('mic-permission-denied', err?.message || name);
      }
      throw new TalkieBackendError('backend-failure', err?.message || String(err));
    }

    try {
      // Take the hardware's native rate and let the worklet resample. Asking for
      // `{ sampleRate: 16000 }` makes Chrome reconfigure the audio device off its
      // native 48 kHz, which measured at 2-10 s on a MacBook — long enough that the
      // caller finishes speaking before capture starts. The worklet downsamples in
      // ~0 time, so there is nothing to gain from forcing the rate here.
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.#ctx = new Ctor();
      if (this.#ctx.state === 'suspended') await this.#ctx.resume();

      await this.#ctx.audioWorklet.addModule(createWorkletUrl());

      this.#node = new AudioWorkletNode(this.#ctx, 'pcm-downsampler', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: {
          targetSampleRate: this.sampleRate,
          chunkSamples: Math.round((this.sampleRate * this.chunkMs) / 1000),
        },
      });
      this.#node.port.onmessage = (event) => {
        this.#onChunk?.(event.data);
      };

      this.#source = this.#ctx.createMediaStreamSource(this.#stream);
      this.#source.connect(this.#node);
      // Deliberately not connected to ctx.destination — routing the mic to the
      // speakers would echo the caller back to themselves.
    } catch (err) {
      await this.stop();
      throw new TalkieBackendError('backend-failure', err?.message || String(err));
    }
  }

  /**
   * Stop capture and tear the audio graph down. Safe to call more than once.
   * @returns {Promise<void>}
   */
  async stop() {
    const node = this.#node;
    this.#node = null;

    if (node) {
      try {
        // Ask the processor to flush its partial buffer before we disconnect, so the
        // tail of the final word is not dropped.
        node.port.postMessage('stop');
        node.port.onmessage = null;
      } catch { /* node already torn down */ }
      try { node.disconnect(); } catch { /* not connected */ }
    }

    if (this.#source) {
      try { this.#source.disconnect(); } catch { /* not connected */ }
      this.#source = null;
    }

    if (this.#stream) {
      for (const track of this.#stream.getTracks()) {
        try { track.stop(); } catch { /* already ended */ }
      }
      this.#stream = null;
    }

    if (this.#ctx) {
      try { await this.#ctx.close(); } catch { /* already closed */ }
      this.#ctx = null;
    }

    this.#onChunk = null;
  }
}
