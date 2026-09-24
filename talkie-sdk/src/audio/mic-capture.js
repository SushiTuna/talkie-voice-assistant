/**
 * Microphone capture that emits 16-bit PCM chunks at a fixed sample rate.
 *
 * The widget's backend contract has no streaming hook — `startCapture()` opens the
 * mic and `stopCapture()` returns a transcript — so this class owns the audio graph
 * for the span between them and hands each chunk to a callback.
 *
 * Setup is split from capture because it is the slow part: creating the AudioContext
 * and loading the worklet module costs a few hundred milliseconds, and doing it after
 * the caller has already pressed the button clips their first word. `prepare()` does
 * that work ahead of time, `start()` only wires up the graph, and the context is kept
 * alive between turns so the second turn costs nothing.
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
  /** @type {Promise<void> | null} */ #preparing = null;
  /** @type {boolean} */ #moduleLoaded = false;

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

  /** @returns {boolean} True once the context and worklet module are ready. */
  get prepared() {
    return this.#ctx !== null && this.#moduleLoaded;
  }

  /** @returns {boolean} True while a microphone stream is held open. */
  get micOpen() {
    return this.#stream !== null;
  }

  /**
   * Create the AudioContext and load the worklet module ahead of capture.
   * Idempotent, and safe to call before any user gesture — it does not touch the
   * microphone, so no recording indicator appears.
   *
   * @returns {Promise<void>}
   */
  prepare() {
    if (this.prepared) return Promise.resolve();
    if (this.#preparing) return this.#preparing;

    this.#preparing = (async () => {
      try {
        // Native rate, deliberately: forcing `{ sampleRate: 16000 }` makes Chrome
        // reconfigure the audio device, which measured at 2-10 s. The worklet
        // downsamples for free.
        const Ctor = window.AudioContext || window.webkitAudioContext;
        this.#ctx ??= new Ctor();
        await this.#ctx.audioWorklet.addModule(createWorkletUrl());
        this.#moduleLoaded = true;
      } catch (err) {
        this.#moduleLoaded = false;
        throw new TalkieBackendError('backend-failure', err?.message || String(err));
      } finally {
        this.#preparing = null;
      }
    })();
    return this.#preparing;
  }

  /**
   * Open the microphone stream ahead of capture and hold it.
   *
   * This makes the browser show its recording indicator for as long as the stream is
   * held, so it belongs behind an explicit opt-in rather than in `prepare()`.
   *
   * @returns {Promise<void>}
   * @throws {TalkieBackendError} `mic-permission-denied` when blocked or absent.
   */
  async openMic() {
    if (this.#stream) return;
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
      // NotAllowedError is a block; NotFoundError is no device at all. Both are
      // things the person can fix, so they map to the same actionable reason.
      const name = err?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotFoundError') {
        throw new TalkieBackendError('mic-permission-denied', err?.message || name);
      }
      throw new TalkieBackendError('backend-failure', err?.message || String(err));
    }
  }

  /**
   * Begin emitting PCM chunks, preparing and opening the mic first if needed.
   *
   * @param {ChunkHandler} onChunk - Called with each ArrayBuffer of PCM data.
   * @returns {Promise<void>}
   */
  async start(onChunk) {
    if (this.active) return;
    this.#onChunk = onChunk;

    try {
      await this.prepare();
      await this.openMic();
    } catch (err) {
      this.#onChunk = null;
      throw err;  // already a TalkieBackendError
    }

    try {
      // A context created before any user gesture starts suspended; resuming needs
      // the gesture, which the press that triggered capture provides.
      if (this.#ctx.state === 'suspended') await this.#ctx.resume();

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
   * Stop capture, leaving the context (and optionally the mic) warm for the next turn.
   *
   * @param {object} [options]
   * @param {boolean} [options.keepMic=false] - Hold the stream open for the next turn.
   * @returns {Promise<void>}
   */
  async stop({ keepMic = false } = {}) {
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

    if (this.#stream && !keepMic) {
      for (const track of this.#stream.getTracks()) {
        try { track.stop(); } catch { /* already ended */ }
      }
      this.#stream = null;
    }

    this.#onChunk = null;
    // The AudioContext deliberately stays open: reopening it costs the same few
    // hundred milliseconds that `prepare()` exists to avoid.
  }

  /** Tear everything down, including the AudioContext. Safe to call repeatedly. */
  async release() {
    await this.stop();
    this.#moduleLoaded = false;
    if (this.#ctx) {
      try { await this.#ctx.close(); } catch { /* already closed */ }
      this.#ctx = null;
    }
  }
}
