/**
 * Gapless playback of PCM audio as it arrives, instead of after the last chunk.
 *
 * The voice agent streams its reply at real-time pace — measured at 923 frames of 10 ms
 * for a 9.23 s answer, arriving over ~9.2 s. Buffering the whole reply before playing it
 * therefore costs the full length of the answer in silence. This schedules each chunk on
 * a Web Audio clock the moment it lands, back to back, so playback starts with the first.
 *
 * Why a scheduled `AudioBufferSourceNode` per chunk rather than an `<audio>` element or
 * MediaSource: raw `audio/pcm` has no container a media element can stream, and sources
 * started at exact clock times are the one Web Audio primitive that joins without gaps.
 * https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start
 */

/**
 * Seconds of audio held back before the first chunk plays, and again after a stall.
 *
 * Frames arrive every ~10 ms with network jitter on top; with no cushion, one late frame
 * leaves a gap. 120 ms rides out ordinary jitter and is short enough not to be heard as a
 * delay against the several seconds the agent takes to start speaking.
 */
const JITTER_BUFFER_S = 0.12;

export class PcmStreamPlayer {
  /** @type {number} */ #sampleRate;
  /** @type {AudioContext | null} */ #ctx = null;
  /** @type {number} Context time at which the next chunk should start. */ #next = 0;
  /** @type {Set<AudioBufferSourceNode>} Scheduled and not yet ended. */ #live = new Set();
  /** @type {boolean} No more chunks are coming for this reply. */ #finished = false;
  /** @type {boolean} */ #started = false;
  /** @type {Array<() => void>} */ #drainWaiters = [];
  /** @type {Array<() => void>} */ #startWaiters = [];
  /**
   * Where each chunk sits in the reply and on the clock, in push order, so a position in
   * the reply can be matched to the moment it is heard.
   * @type {Array<{ streamMs: number, at: number, ms: number }>}
   */
  #schedule = [];
  /** @type {number} Milliseconds of reply audio pushed so far. */ #streamMs = 0;
  /** @type {number} Index into #schedule of the chunk last found playing. */ #cursor = 0;

  /**
   * @param {object} options
   * @param {number} options.sampleRate - Rate of the incoming 16-bit mono PCM.
   */
  constructor({ sampleRate }) {
    this.#sampleRate = sampleRate;
  }

  /**
   * True when the browser can do scheduled playback. Callers fall back to buffered
   * playback without it (and in Node, where the tests run).
   * @returns {boolean}
   */
  static isSupported() {
    const Ctor = globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext;
    return typeof Ctor === 'function'
      && typeof Ctor.prototype?.createBufferSource === 'function'
      && typeof Ctor.prototype?.createBuffer === 'function';
  }

  /** @returns {boolean} True once the first chunk has been scheduled. */
  get started() {
    return this.#started;
  }

  /**
   * Create or resume the output context. Call it from the press that starts a turn: a
   * context created outside a user gesture starts suspended under autoplay policy.
   * https://developer.mozilla.org/en-US/docs/Web/Media/Autoplay_guide#autoplay_using_the_web_audio_api
   * @returns {Promise<void>}
   */
  async prepare() {
    const Ctor = globalThis.window.AudioContext || globalThis.window.webkitAudioContext;
    this.#ctx ??= new Ctor();
    if (this.#ctx.state === 'suspended') {
      try { await this.#ctx.resume(); } catch { /* still suspended; push() retries */ }
    }
  }

  /**
   * Begin a new reply: forget the previous one's schedule and completion state.
   * Anything still sounding is stopped first.
   */
  reset() {
    this.stop();
    this.#finished = false;
    this.#started = false;
    this.#next = 0;
    this.#schedule = [];
    this.#streamMs = 0;
    this.#cursor = 0;
  }

  /**
   * Schedule one chunk to play straight after the previous one.
   * @param {ArrayBuffer} chunk - 16-bit little-endian mono PCM.
   */
  push(chunk) {
    if (this.#finished || !chunk?.byteLength) return;
    const ctx = this.#ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    const samples = new Int16Array(chunk, 0, chunk.byteLength >> 1);
    const buffer = ctx.createBuffer(1, samples.length, this.#sampleRate);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // First chunk of a reply, or the stream stalled and the schedule fell behind the clock:
    // restart it a cushion ahead of now, rather than asking for a start time already past.
    // "First" is tested explicitly: on a fresh context both the schedule and the clock sit at
    // exactly 0, so `next < currentTime` alone would start the reply with no cushion at all.
    if (!this.#started || this.#next < ctx.currentTime) this.#next = ctx.currentTime + JITTER_BUFFER_S;
    source.start(this.#next);
    const ms = buffer.duration * 1000;
    this.#schedule.push({ streamMs: this.#streamMs, at: this.#next, ms });
    this.#streamMs += ms;
    this.#next += buffer.duration;

    this.#live.add(source);
    source.onended = () => {
      this.#live.delete(source);
      this.#maybeDrained();
    };

    if (!this.#started) {
      this.#started = true;
      for (const wake of this.#startWaiters.splice(0)) wake();
    }
  }

  /**
   * How far into the reply playback has got, in milliseconds of reply audio.
   *
   * Read off the schedule rather than the wall clock, so a stall — where the schedule was
   * restarted ahead of the clock — does not throw the position off by the length of the gap.
   * -1 before the first chunk starts sounding.
   *
   * @returns {number}
   */
  positionMs() {
    const ctx = this.#ctx;
    const schedule = this.#schedule;
    if (!ctx || schedule.length === 0) return -1;
    const now = ctx.currentTime;
    if (now < schedule[0].at) return -1;
    // Playback only moves forward, so resume the search where it last stopped.
    let i = Math.min(this.#cursor, schedule.length - 1);
    while (i + 1 < schedule.length && schedule[i + 1].at <= now) i++;
    this.#cursor = i;
    const chunk = schedule[i];
    return chunk.streamMs + Math.min((now - chunk.at) * 1000, chunk.ms);
  }

  /** No more chunks are coming: `drained()` resolves once what is scheduled has played. */
  finish() {
    this.#finished = true;
    this.#maybeDrained();
  }

  /** Silence everything now and release anyone waiting on this reply. */
  stop() {
    for (const source of this.#live) {
      source.onended = null;
      try { source.stop(); } catch { /* never started, or already ended */ }
      try { source.disconnect(); } catch { /* already disconnected */ }
    }
    this.#live.clear();
    this.#finished = true;
    for (const wake of this.#startWaiters.splice(0)) wake();
    this.#maybeDrained();
  }

  /**
   * Resolve when the first chunk of this reply has been scheduled. That is not necessarily
   * speech: the voice agent opens each reply with seconds of near-silence while it thinks.
   * Also resolves if the reply is stopped first.
   * @returns {Promise<void>}
   */
  whenStarted() {
    if (this.#started || this.#finished) return Promise.resolve();
    return new Promise((resolve) => this.#startWaiters.push(resolve));
  }

  /**
   * Resolve once the reply is finished and every scheduled chunk has played out.
   * @returns {Promise<void>}
   */
  drained() {
    if (this.#finished && this.#live.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }

  /** Close the output context. The player is unusable afterwards. */
  async close() {
    this.stop();
    const ctx = this.#ctx;
    this.#ctx = null;
    if (ctx) {
      try { await ctx.close(); } catch { /* already closed */ }
    }
  }

  #maybeDrained() {
    if (!this.#finished || this.#live.size > 0) return;
    for (const wake of this.#drainWaiters.splice(0)) wake();
  }
}
