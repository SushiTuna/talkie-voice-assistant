/**
 * PCM <-> base64 <-> WAV helpers for agent-style voice transports.
 *
 * The AudioWorklet emits headerless 16-bit little-endian PCM (see `pcm-worklet.js`) and
 * agent APIs carry audio as base64 inside JSON frames, so every chunk crosses the wire
 * twice-encoded. These functions are deliberately pure — no DOM beyond `Blob`, no
 * vendor knowledge — so they can be tested in Node without a browser.
 */

/** Bytes per `String.fromCharCode` call. A 100 ms 24 kHz frame is 4800 bytes, and
 *  spreading that into one call is already close to the engine's argument limit; 0x8000
 *  is the conventional safe stride. */
const CHUNK_BYTES = 0x8000;

/** Bytes in a canonical PCM WAV header. */
const WAV_HEADER_BYTES = 44;

/**
 * Base64-encode raw bytes.
 *
 * @param {ArrayBuffer | Uint8Array} buffer - Bytes to encode.
 * @returns {string} Standard base64, no line breaks.
 */
export function encodeBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_BYTES));
  }
  return btoa(binary);
}

/**
 * Decode base64 back to raw bytes.
 *
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
export function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Build a buffer of digital silence, sized in milliseconds of mono PCM16.
 *
 * Used to close an agent turn: the vendor detects end-of-turn from silence, and once the
 * microphone stops there is no audio at all — not silence — so the socket has to be fed
 * explicit zeroes for the turn to end.
 *
 * @param {number} sampleRate - Samples per second.
 * @param {number} ms - Duration in milliseconds.
 * @returns {ArrayBuffer} Zeroed PCM16, `sampleRate * ms / 1000` samples long.
 */
export function silenceFrame(sampleRate, ms) {
  const samples = Math.max(0, Math.round((sampleRate * ms) / 1000));
  return new Int16Array(samples).buffer;
}

/**
 * Total byte length of a list of buffers.
 * @param {Array<ArrayBuffer | Uint8Array>} chunks
 * @returns {number}
 */
function totalBytes(chunks) {
  let n = 0;
  for (const chunk of chunks) n += chunk.byteLength;
  return n;
}

/**
 * Wrap raw mono PCM16 chunks in a WAV container.
 *
 * `<audio>` cannot decode headerless PCM, and the agent transport delivers exactly that,
 * so playback needs a container bolted on. WAV is the cheapest one to write by hand: a
 * fixed 44-byte header followed by the samples, no re-encoding of the audio itself.
 *
 * @param {Array<ArrayBuffer | Uint8Array>} chunks - PCM16 LE mono pieces, in order.
 * @param {number} sampleRate - Rate the samples were captured/synthesised at.
 * @returns {Uint8Array} The complete WAV file bytes.
 */
export function pcmToWavBytes(chunks, sampleRate) {
  const dataBytes = totalBytes(chunks);
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;

  ascii(0, 'RIFF');
  // Everything after this field: the 4-byte "WAVE" tag plus both chunk headers and data.
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt chunk body size
  view.setUint16(20, 1, true);             // 1 = PCM, uncompressed
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, (channels * bitsPerSample) / 8, true);  // block align
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    out.set(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Same as `pcmToWavBytes`, wrapped in a Blob ready for `URL.createObjectURL`.
 *
 * @param {Array<ArrayBuffer | Uint8Array>} chunks
 * @param {number} sampleRate
 * @returns {Blob}
 */
export function pcmToWavBlob(chunks, sampleRate) {
  return new Blob([pcmToWavBytes(chunks, sampleRate)], { type: 'audio/wav' });
}
