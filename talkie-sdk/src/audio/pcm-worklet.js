/**
 * AudioWorklet processor source for 16-bit PCM capture.
 *
 * The source lives here as a string because an AudioWorklet module must be fetched
 * by URL, and the SDK ships no build step: `createWorkletUrl()` turns it into a Blob
 * URL at runtime so consumers never have to copy a loose .js file into their static
 * assets. `ScriptProcessorNode` would avoid this dance but is deprecated and runs on
 * the main thread, where layout work causes dropped audio frames.
 *
 * The processor resamples from the AudioContext's native rate (usually 48 kHz) down
 * to the rate the STT provider expects (16 kHz for AssemblyAI) and converts float
 * samples to signed 16-bit little-endian, which is what `pcm_s16le` means.
 */

/** @type {string} Processor source, evaluated inside the AudioWorkletGlobalScope. */
export const PCM_WORKLET_SOURCE = /* js */ `
class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._targetRate = opts.targetSampleRate || 16000;
    // Samples per posted chunk at the TARGET rate. 100 ms keeps us inside the
    // provider's 50-1000 ms per-message window with room to spare.
    this._chunkSamples = opts.chunkSamples || 1600;
    // Fractional read position into the incoming buffer; carries across renders so
    // resampling does not drift or click at block boundaries.
    this._readPos = 0;
    this._out = new Int16Array(this._chunkSamples);
    this._outLen = 0;
    this._stopped = false;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this._flush();
        this._stopped = true;
      }
    };
  }

  _flush() {
    if (this._outLen === 0) return;
    const slice = this._out.slice(0, this._outLen);
    this.port.postMessage(slice.buffer, [slice.buffer]);
    this._outLen = 0;
  }

  _pushSample(float) {
    // Clamp before scaling: values outside [-1, 1] would wrap to the opposite sign.
    const clamped = float < -1 ? -1 : float > 1 ? 1 : float;
    this._out[this._outLen++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this._outLen >= this._chunkSamples) this._flush();
  }

  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    const ratio = sampleRate / this._targetRate;
    if (ratio <= 1.0001 && ratio >= 0.9999) {
      for (let i = 0; i < channel.length; i++) this._pushSample(channel[i]);
      return true;
    }

    // Linear interpolation between neighbouring samples. Cheap, and the artefacts it
    // introduces sit far above the speech band that matters for recognition.
    let pos = this._readPos;
    while (pos < channel.length) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = channel[idx];
      const b = idx + 1 < channel.length ? channel[idx + 1] : a;
      this._pushSample(a + (b - a) * frac);
      pos += ratio;
    }
    // Keep the leftover fraction so the next render block continues mid-stride.
    this._readPos = pos - channel.length;
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
`;

/** @type {string | null} Cached Blob URL so repeated captures reuse one module. */
let cachedUrl = null;

/**
 * Create (or reuse) an object URL serving the worklet source.
 * @returns {string} A URL suitable for `audioWorklet.addModule()`.
 */
export function createWorkletUrl() {
  if (cachedUrl) return cachedUrl;
  const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
  cachedUrl = URL.createObjectURL(blob);
  return cachedUrl;
}

/** Release the cached Blob URL. Mainly for tests and hot-reload. */
export function revokeWorkletUrl() {
  if (cachedUrl) {
    URL.revokeObjectURL(cachedUrl);
    cachedUrl = null;
  }
}
