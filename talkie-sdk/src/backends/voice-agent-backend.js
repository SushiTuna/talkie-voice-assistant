/**
 * VoiceAgentBackend — a TalkieBackend on top of the AssemblyAI Voice Agent API.
 *
 * Where `HttpBackend` stitches three vendors together behind your own server (a speech
 * socket, an SSE model stream and a TTS request), this talks to one duplex WebSocket that
 * does transcription, the model turn and synthesis server-side:
 *
 *   wss://agents.assemblyai.com/v1/ws?token=<short-lived token>
 *
 * Spec: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/voice-agent-websocket
 * Token: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/generate-voice-agent-token
 *
 * ── The mismatch this class bridges ────────────────────────────────────────────
 * The widget is push-to-talk and turn-shaped: `startCapture()`, then `stopCapture()`
 * returns a transcript, then `ask()` streams an answer, then `speak()` plays it. The
 * agent API is continuous and decides end-of-turn from *silence*, and its client event
 * list has no "commit turn" event. Two consequences drive the whole design:
 *
 *   1. Releasing the button stops audio altogether, which is not the same as silence, so
 *      the turn would never close. On release we keep the socket open and feed it
 *      explicit PCM zeroes until the vendor's `min_silence` elapses.
 *   2. The reply starts arriving the moment the vendor closes the turn — before the
 *      widget has called `ask()`. Every reply event is therefore buffered into a turn
 *      record, which `ask()` and `speak()` then read.
 *
 * Unlike `HttpBackend`, the socket stays open across turns: the reply arrives on it, and
 * the conversation's context lives in the session. It closes on `dispose()`, which sends
 * `session.end` so the vendor does not hold the session for its 30 s resume window.
 *
 * ── Conversation mode ────────────────────────────────────────────────────────────
 * `converse()` is the other way to use the same socket: the mic stays open, the vendor's own
 * turn detection decides when the caller has finished, replies stream as they come, and (with
 * `bargeIn`) the caller can talk over a reply to cut it off. It yields small events the widget
 * turns into states. No silence padding, no stop button: the model the API was built for.
 *
 * ── Tool calls ───────────────────────────────────────────────────────────────
 * A turn that calls a tool gets two replies, not one: the agent speaks a transition phrase
 * ("let me take you there"), emits `tool.call`, ends that reply, and only answers after the
 * `tool.result` in a second reply it fires itself. Per the docs the result must go out while
 * `reply.done` is the latest event received — sent mid-reply, the tool fires again. So results
 * are held and flushed on `reply.done`, and the widget's turn stays open across both replies:
 * `ask()` and playback run on until the follow-up reply is done too.
 * https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools
 *
 * The API key never reaches the browser. A short-lived, single-use token is minted by
 * your server; point `tokenUrl` at that route, or pass `fetchToken` to source it yourself.
 */

import { TalkieBackendError } from '../core/backend.js';
import { MicCapture } from '../audio/mic-capture.js';
import { encodeBase64, decodeBase64, silenceFrame, pcmToWavBlob } from '../audio/pcm-codec.js';
import { PcmStreamPlayer } from '../audio/pcm-player.js';

/** The vendor's socket endpoint. */
const DEFAULT_WS_URL = 'wss://agents.assemblyai.com/v1/ws';

/** `audio/pcm` means 16-bit LE mono at this rate, for both directions. */
const PCM_SAMPLE_RATE = 24000;

/** How long to wait for `session.ready` before giving up on the socket. */
const SESSION_READY_TIMEOUT_MS = 10000;

/** How long to wait after the silence padding for the closing `transcript.user`. */
const FINAL_TRANSCRIPT_GRACE_MS = 2500;

/**
 * How long a reply may go without any sign of life before it is given up on.
 *
 * An inactivity limit, not a total one: every audio frame restarts it. The reply text only
 * arrives after the last audio frame, so a fixed limit timed out any answer longer than
 * itself — a measured 37 s answer to an open question tripped the old 30 s cap and threw
 * the widget into its error state mid-sentence.
 */
const REPLY_TIMEOUT_MS = 30000;

/**
 * Milliseconds of silence padded onto the stream when the button is released.
 *
 * Measured against the live service rather than derived from `min_silence`: with one
 * utterance replayed at `min_silence: 2000` and at `min_silence: 200`, the turn closed
 * 2301 ms after speech began in both runs — about 210 ms after the speech itself ended,
 * identically. The documented threshold did not move end-of-turn timing, so the padding
 * is sized from what the service actually does, with margin.
 *
 * The padding still earns its place: it is what closes the turn when the caller releases
 * the button *while still speaking*, since the audio then stops rather than going quiet.
 */
const END_OF_TURN_PAD_MS = 400;

/**
 * RMS level, on the 16-bit scale, above which a reply frame counts as speech.
 *
 * Each reply opens with seconds of near-silence while the agent works out its answer —
 * measured at ~3.5 s, peaking at |2| — before the synthesised voice starts at an RMS in
 * the hundreds. Anything between the two separates them; 100 leaves margin both ways.
 */
const SPEECH_RMS_THRESHOLD = 100;

/** How often ask() checks the playback position for words that are now being spoken. */
const WORD_POLL_MS = 40;

/**
 * Once the reply has fully arrived, how long past its expected end ask() waits before
 * releasing any words playback has not reached — so a suspended audio context, which never
 * advances, cannot hold the text back forever.
 */
const WORD_FLUSH_GRACE_MS = 1500;

/** Silence is sent in frames this long, so a cancel can interrupt the padding. */
const PAD_FRAME_MS = 50;

/** Error codes the vendor reports that are worth mapping to `offline` rather than a bug. */
/**
 * How long a conversation may sit with nobody speaking before it ends itself. A product choice,
 * not a measurement: an open conversation streams the microphone to the vendor the whole time.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 60000;

const OFFLINE_ERROR_CODES = new Set(['server_error', 'INTERNAL_ERROR']);

export class VoiceAgentBackend {
  /** @type {string} */ #tokenUrl;
  /** @type {(() => Promise<object>) | null} */ #fetchTokenFn;
  /** @type {string} */ #wsUrl;
  /** @type {object} */ #sessionConfig;
  /** @type {number} */ #padMs;
  /** @type {boolean} */ #keepMicWarm;
  /** @type {((mark: string, detail: object) => void) | null} */ #onTiming = null;
  /** @type {number} Performance clock at the release that opened the current turn. */ #turnT0 = 0;
  /** @type {boolean} Whether this turn has seen its first `reply.audio` frame yet. */ #sawFirstAudio = false;
  /** @type {((call: { name: string, arguments: object, call_id: string }) => any) | null} */ #onToolCall;

  /** @type {WebSocket | null} */ #ws = null;
  /** @type {MicCapture} */ #mic;
  /** @type {{ cred: object, at: number } | null} */ #tokenCache = null;
  /** @type {string | null} */ #sessionId = null;
  /** @type {boolean} */ #disposed = false;

  /** @type {Map<number, string>} Final user transcripts for the turn, in arrival order. */
  #userTurns = new Map();
  /** @type {number} */ #userTurnSeq = 0;
  /** @type {{ resolve: (v: string) => void } | null} */ #awaitingUserTranscript = null;

  /** @type {ReplyTurn | null} The reply being assembled, or the one awaiting playback. */
  #turn = null;

  /** @type {HTMLAudioElement | null} */ #audio = null;
  /** @type {string | null} */ #audioUrl = null;

  /** @type {PcmStreamPlayer | null} Streams the reply as it arrives; null without Web Audio. */
  #player = null;
  /** @type {ReplyTurn | null} The reply currently routed to the player. */ #streamingTurn = null;
  /**
   * True between cancelling a reply mid-stream and its `reply.done`. The agent keeps
   * sending the rest of a reply the caller stopped; without this those frames would play
   * under the next answer. The published spec gives `reply.audio` only `data`. Live frames
   * do also carry `reply_id`, but that field is undocumented, so correctness here rests on
   * event order instead.
   * @type {boolean}
   */
  #discarding = false;
  /**
   * Set when a turn is cancelled before its reply has even started: that reply is still
   * coming, so the next `reply.started` opens a discard rather than a new turn.
   * @type {boolean}
   */
  #discardNext = false;
  /** @type {{ promise: Promise<void>, resolve: () => void } | null} Settles when this turn's audio is first heard. */
  #speechStart = null;
  /**
   * The last turn-shaped vendor event: `reply.started`, `reply.done` or
   * `input.speech.started`. Tool results may only be sent while it is `reply.done`.
   * @type {string | null}
   */
  #lastEvent = null;
  /**
   * Tool results waiting for `reply.done`. `discardFollowUp` marks a call whose turn is
   * already over or cancelled: the reply the agent fires on its result has nobody to hear it.
   * @type {Array<{ callId: string, result: string, discardFollowUp: boolean }>}
   */
  #pendingResults = [];
  /** @type {boolean} Let caller speech interrupt a reply (conversation mode). */ #bargeIn = false;
  /**
   * The running conversation, or null outside `converse()`.
   *   queue      events for the converse() iterator
   *   idleMs     inactivity limit; 0 disables it
   *   idleTimer  pending idle timeout
   *   replyTurn  the reply being played, until it ends or is cut off
   *   turnAbort  aborts that reply's playback and word reveal
   *   waiting    replies that began while another was still playing, in order
   * @type {{ queue: EventQueue, idleMs: number, idleTimer: any, replyTurn: ReplyTurn | null,
   *   turnAbort: AbortController | null, waiting: ReplyTurn[] } | null}
   */
  #conv = null;

  /**
   * @param {object} options
   * @param {string} [options.baseUrl='http://localhost:8000'] - Origin the default
   *   `tokenUrl` is derived from. Ignored when `tokenUrl` or `fetchToken` is given.
   * @param {string} [options.tokenUrl] - Route returning `{ token, expires_in_seconds }`.
   *   Defaults to `${baseUrl}/agent/token`.
   * @param {() => Promise<{ token: string, expires_in_seconds?: number }>} [options.fetchToken]
   *   Supply the credential yourself; overrides `tokenUrl` entirely.
   * @param {string} [options.wsUrl] - Override the vendor socket endpoint.
   * @param {string} [options.agentId] - Use a stored agent. Mutually exclusive with the
   *   inline fields below, as the API rejects a `session.update` carrying both.
   * @param {string} [options.systemPrompt] - Inline agent instructions.
   * @param {string} [options.greeting] - Spoken on connect, before the caller says
   *   anything. See the known-gap note in the README before setting it.
   * @param {string} [options.voice='anna'] - Output voice.
   * @param {string[]} [options.keyterms] - Rare words to bias recognition towards.
   * @param {number} [options.volume] - Output level, 0-100.
   * @param {object} [options.turnDetection] - Merged over this class's defaults;
   *   `{ vad_threshold, min_silence, max_silence, interrupt_response }`.
   * @param {Array<object>} [options.tools] - Function-tool definitions.
   * @param {(call: object) => any} [options.onToolCall] - Invoked for each `tool.call`;
   *   its resolved value is sent back as the `tool.result`.
   * @param {boolean} [options.bargeIn=false] - Let the caller interrupt a reply by speaking.
   *   Only meaningful with `converse()`; push-to-talk closes the mic during replies anyway.
   * @param {boolean} [options.speakEnabled=true] - Set false for a text-only widget.
   * @param {boolean} [options.keepMicWarm=false] - Hold the mic open between turns.
   * @param {number} [options.endOfTurnPadMs] - Override the silence padding length.
   * @param {(mark: string, detail: object) => void} [options.onTiming] - Called at each
   *   turn-phase boundary with `{ at, since, ... }` milliseconds, where `at` is measured
   *   from the release that ended the caller's turn. Diagnostic only: nothing in the turn
   *   path depends on it, and leaving it unset costs nothing.
   */
  constructor({
    baseUrl = 'http://localhost:8000',
    tokenUrl = null,
    fetchToken = null,
    wsUrl = DEFAULT_WS_URL,
    agentId = null,
    systemPrompt = null,
    greeting = null,
    voice = 'anna',
    keyterms = null,
    volume = null,
    turnDetection = null,
    tools = null,
    onToolCall = null,
    bargeIn = false,
    speakEnabled = true,
    keepMicWarm = false,
    endOfTurnPadMs = null,
    onTiming = null,
  } = {}) {
    const origin = baseUrl.replace(/\/+$/, '');
    this.#tokenUrl = tokenUrl ?? `${origin}/agent/token`;
    this.#fetchTokenFn = fetchToken;
    this.#wsUrl = wsUrl;
    this.#keepMicWarm = keepMicWarm;
    this.#onToolCall = onToolCall;
    this.#onTiming = onTiming;
    this.#bargeIn = bargeIn === true;

    this.#sessionConfig = VoiceAgentBackend.buildSessionUpdate({
      agentId, systemPrompt, greeting, voice, keyterms, volume, turnDetection, tools,
      bargeIn: this.#bargeIn,
    });

    this.#padMs = endOfTurnPadMs ?? END_OF_TURN_PAD_MS;

    this.#mic = new MicCapture({ sampleRate: PCM_SAMPLE_RATE });
    // The widget checks `typeof backend.speak === 'function'`, so opting out has to
    // remove the method rather than just flag it.
    if (!speakEnabled) this.speak = undefined;
    if (speakEnabled && PcmStreamPlayer.isSupported()) {
      this.#player = new PcmStreamPlayer({ sampleRate: PCM_SAMPLE_RATE });
    } else {
      // Without streaming playback the widget must not wait on it: it keys "speaking" off
      // the reply text, as it does for every other backend.
      this.speechStarted = undefined;
    }
  }

  /** @returns {string | null} The vendor session id, once `session.ready` has arrived. */
  get sessionId() {
    return this.#sessionId;
  }

  /** @returns {boolean} True while the agent socket is open. */
  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  // ── wire format (static, so it is testable without a socket) ───────────────

  /**
   * Build the first `session.update` frame from constructor options.
   *
   * Stored-agent and inline configuration are mutually exclusive: the API fails the
   * session when both arrive, so catch it here where the message names the option.
   *
   * @param {object} config
   * @returns {{ type: 'session.update', session: object }}
   * @throws {TalkieBackendError} When `agentId` is combined with inline fields.
   */
  static buildSessionUpdate({
    agentId = null,
    systemPrompt = null,
    greeting = null,
    voice = null,
    keyterms = null,
    volume = null,
    turnDetection = null,
    tools = null,
    bargeIn = false,
  } = {}) {
    const inline = { systemPrompt, greeting, keyterms, volume, turnDetection, tools };
    const inlineKeys = Object.entries(inline)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k]) => k);

    if (agentId) {
      if (inlineKeys.length) {
        throw new TalkieBackendError(
          'backend-failure',
          `agentId cannot be combined with inline agent config (${inlineKeys.join(', ')}).`,
        );
      }
      return { type: 'session.update', session: { agent_id: agentId } };
    }

    const session = {
      input: {
        format: { encoding: 'audio/pcm' },
        turn_detection: {
          // Push-to-talk shuts the mic during the reply, so nothing can barge in; leaving
          // it on only risks the agent cutting itself off on stray room noise. Conversation
          // mode turns it on when asked (`bargeIn`), which is the vendor's own default.
          interrupt_response: bargeIn === true,
          // min_silence and max_silence are deliberately left at the service's defaults:
          // measured end-of-turn timing did not change with them (see END_OF_TURN_PAD_MS).
          ...(turnDetection ?? {}),
        },
      },
      output: {
        format: { encoding: 'audio/pcm' },
        ...(voice ? { voice } : {}),
        ...(volume !== null && volume !== undefined ? { volume } : {}),
      },
    };
    if (systemPrompt) session.system_prompt = systemPrompt;
    if (greeting) session.greeting = greeting;
    if (keyterms?.length) session.input.keyterms = keyterms;
    if (tools?.length) session.tools = tools;

    return { type: 'session.update', session };
  }

  /**
   * Normalise one server frame into the shape this backend acts on.
   *
   * Keeps the vendor's event names in exactly one place, and lets the tests assert the
   * mapping without standing up a socket.
   *
   * @param {object} msg - A parsed server message.
   * @returns {{ kind: string, [key: string]: any } | null} Null for frames with nothing
   *   to act on (partial transcripts, speech markers, acks).
   */
  static readEvent(msg) {
    switch (msg?.type) {
      case 'session.ready':
        return { kind: 'ready', sessionId: msg.session_id ?? null };
      case 'transcript.user':
        return msg.text ? { kind: 'user-transcript', text: msg.text } : null;
      case 'reply.started':
        return { kind: 'reply-started', replyId: msg.reply_id ?? null };
      case 'reply.audio':
        return msg.data ? { kind: 'reply-audio', data: msg.data } : null;
      case 'transcript.agent.delta':
        // Not in the published spec, but sent on every live turn: one word at a time, with
        // `start_ms` placing it within the synthesised speech. The whole reply's words come
        // in one burst just before the voice starts, so they are revealed against playback
        // rather than on arrival. Absent, the reply text still comes from transcript.agent.
        return {
          kind: 'agent-delta',
          text: msg.delta ?? '',
          startMs: Number.isFinite(msg.start_ms) ? msg.start_ms : null,
        };
      case 'transcript.agent':
        return {
          kind: 'agent-transcript',
          text: msg.text ?? '',
          interrupted: msg.interrupted === true,
        };
      case 'reply.done':
        return { kind: 'reply-done', status: msg.status ?? 'completed' };
      case 'tool.call':
        return {
          kind: 'tool-call',
          callId: msg.call_id,
          name: msg.name,
          arguments: msg.arguments ?? {},
        };
      case 'session.error':
      case 'error':
        return {
          kind: 'error',
          code: msg.code ?? 'unknown',
          message: msg.message ?? 'The voice agent reported an error.',
        };
      case 'session.ended':
        return { kind: 'ended' };
      case 'input.speech.started':
        // Holds tool results back (a turn is in flight), and is barge-in in conversation mode.
        return { kind: 'speech-started' };
      case 'input.speech.stopped':
        return { kind: 'speech-stopped' };
      case 'transcript.user.delta':
        // Live caption for conversation mode.
        return msg.text ? { kind: 'user-partial', text: msg.text } : null;
      default:
        // session.updated and other acks: the
        // widget has no state that reacts to them, so they are deliberately ignored.
        return null;
    }
  }

  /**
   * Map a vendor error code onto one of the FSM's error reasons.
   * @param {string} code
   * @returns {'offline' | 'backend-failure'}
   */
  static reasonForCode(code) {
    return OFFLINE_ERROR_CODES.has(code) ? 'offline' : 'backend-failure';
  }

  // ── warm-up ───────────────────────────────────────────────────────────────

  /**
   * Do the slow parts of `startCapture()` ahead of the press: the token fetch and the
   * AudioContext plus worklet module, which together cost about a second.
   *
   * The socket is deliberately not opened here. The token is single-use and expires in at
   * most 600 s, and an idle session still occupies the vendor's session slot.
   *
   * @param {object} [options]
   * @param {boolean} [options.mic=false] - Also open the microphone now. The browser shows
   *   its recording indicator until capture ends, so this is opt-in.
   * @returns {Promise<{ audio: boolean, token: boolean, mic: boolean }>} What warmed up;
   *   a failure here is never fatal, since `startCapture()` redoes any step that missed.
   */
  async prewarm({ mic = false } = {}) {
    if (this.#disposed) return { audio: false, token: false, mic: false };
    const done = { audio: false, token: false, mic: false };

    const settled = await Promise.allSettled([
      this.#mic.prepare().then(() => { done.audio = true; }),
      this.#fetchToken().then(() => { done.token = true; }),
      this.#player ? this.#player.prepare() : Promise.resolve(),
      mic ? this.#mic.openMic().then(() => { done.mic = true; }) : Promise.resolve(),
    ]);
    for (const r of settled) {
      if (r.status === 'rejected') {
        // Warming is best-effort; the press path will surface any real problem.
        console.debug?.('[talkie] prewarm step failed:', r.reason?.message ?? r.reason);
      }
    }
    return done;
  }

  // ── TalkieBackend contract ────────────────────────────────────────────────

  /**
   * Open the agent session if needed and start streaming microphone audio to it.
   * @returns {Promise<void>}
   */
  async startCapture() {
    this.#assertLive();
    this.#userTurns.clear();
    this.#userTurnSeq = 0;
    this.#turn = null;

    // Inside the press, so autoplay policy lets the output context run. Not awaited on the
    // critical path: a failure here only means the reply falls back to buffered playback.
    this.#player?.prepare().catch(() => {});

    const socketWasOpen = this.connected;
    if (!socketWasOpen) {
      const [, cred] = await Promise.all([this.#mic.prepare(), this.#fetchToken()]);
      // A token buys exactly one socket, so drop it the moment it is redeemed.
      this.#tokenCache = null;
      await this.#openSocket(cred.token);
    } else {
      await this.#mic.prepare();
    }

    try {
      await this.#mic.start((chunk) => this.#sendAudio(chunk));
    } catch (err) {
      // A mic failure on the first turn leaves a session open that nobody will speak
      // into; close it rather than let the vendor hold it. On a later turn the socket
      // already carries conversation history worth keeping.
      if (!socketWasOpen) this.#endSession();
      throw err;  // already a TalkieBackendError from MicCapture
    }
  }

  /**
   * Stop capture, close the agent's turn, and resolve with what the caller said.
   *
   * @returns {Promise<string>}
   * @throws {TalkieBackendError} `no-speech-detected` when nothing was recognised.
   */
  async stopCapture() {
    // Every mark in the turn is measured from here: the moment the caller stopped talking.
    this.#turnT0 = performance.now();
    this.#sawFirstAudio = false;
    this.#speechStart = deferred();
    this.#mark('release');

    await this.#mic.stop({ keepMic: this.#keepMicWarm });
    this.#mark('mic-stopped');

    if (!this.connected) {
      // Cancelled before the socket came up, or the session already failed.
      const early = VoiceAgentBackend.joinTurns(this.#userTurns);
      if (early) return early;
      throw new TalkieBackendError('no-speech-detected', 'No speech was recognised.');
    }

    // The vendor ends the turn on silence and has no event to force it, so the silence
    // has to be sent. Frame by frame, so `dispose()` mid-pad stops promptly.
    const frames = Math.ceil(this.#padMs / PAD_FRAME_MS);
    const pad = silenceFrame(PCM_SAMPLE_RATE, PAD_FRAME_MS);
    for (let i = 0; i < frames; i++) {
      if (!this.connected) break;
      this.#sendAudio(pad);
      await new Promise((r) => setTimeout(r, PAD_FRAME_MS));
    }
    this.#mark('pad-sent', { padMs: this.#padMs, frames });

    // The closing words are still being recognised upstream; waiting for the final
    // transcript beats truncating the caller mid-sentence.
    if (this.connected && !this.#userTurns.size) {
      const waitedFrom = performance.now();
      let timedOut = false;
      await new Promise((resolve) => {
        const settle = () => {
          this.#awaitingUserTranscript = null;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => { timedOut = true; settle(); }, FINAL_TRANSCRIPT_GRACE_MS);
        this.#awaitingUserTranscript = { resolve: settle };
      });
      // A `timedOut: true` here is the expensive case: the full grace window spent waiting
      // on a final transcript that never came, before the agent was even asked.
      this.#mark('user-transcript', {
        waited: Math.round(performance.now() - waitedFrom),
        graceMs: FINAL_TRANSCRIPT_GRACE_MS,
        timedOut,
      });
    } else {
      this.#mark('user-transcript', { waited: 0, timedOut: false, alreadyHad: true });
    }

    const transcript = VoiceAgentBackend.joinTurns(this.#userTurns);
    if (!transcript) {
      throw new TalkieBackendError('no-speech-detected', 'No speech was recognised.');
    }
    return transcript;
  }

  /**
   * Yield the agent's answer.
   *
   * Nothing is sent here: the agent began replying the moment it closed the turn, and the
   * message handler has been buffering that reply since. The text arrives in one frame
   * (`transcript.agent`, emitted after all audio has been sent), so this yields once and
   * the widget's word-paced reveal does the rest.
   *
   * @param {string} _transcript - Unused; the agent already has the audio.
   * @param {AbortSignal} signal
   * @returns {AsyncGenerator<string>}
   */
  async *ask(_transcript, signal) {
    this.#assertLive();
    const turn = this.#turn ?? this.#beginTurn();
    this.#mark('ask-entered');
    // ask() is the first call that carries the turn's abort signal, so it is where playback
    // can safely begin: anything that cancels the turn can also silence it.
    if (this.#player) this.#streamTurn(turn, signal);

    const speechStart = this.#speechStart;
    yield* this.#replyWords(turn, signal, () => {
      if (!speechStart || speechStart.settled) return;
      speechStart.settled = true;
      this.#mark('speech-audible');
      speechStart.resolve();
    });
  }

  /**
   * Yield a reply's words as the caller hears them, then whatever the final transcript adds.
   * Shared by `ask()` and conversation mode, so both reveal text the same way.
   *
   * @param {ReplyTurn} turn
   * @param {AbortSignal} [signal]
   * @param {() => void} [onAudible] - Called once, when the reply's voice starts sounding.
   * @returns {AsyncGenerator<string>}
   */
  async *#replyWords(turn, signal, onAudible) {
    const spoken = [];
    let emitted = 0;
    let flushAt = null;
    let audible = false;

    for (;;) {
      if (signal?.aborted) throw abortError();
      const pos = this.#playedMs(turn);

      if (!audible && turn.onsetMs !== null && pos >= turn.onsetMs) {
        audible = true;
        onAudible?.();
      }

      // reply.done, not transcript.agent: a reply that called a tool has its text too, but
      // the answer is still to come in the follow-up reply.
      const final = turn.done;
      if (final && flushAt === null) {
        // Everything has arrived; the rest is playback. Allow for it, plus a margin.
        flushAt = Date.now() + Math.max(0, turn.receivedMs - Math.max(pos, 0)) + WORD_FLUSH_GRACE_MS;
      }
      const flush = flushAt !== null && Date.now() >= flushAt;

      const due = flush ? turn.words.length : this.#dueWords(turn, pos);
      while (emitted < due) {
        const word = turn.words[emitted++].text.trim();
        if (!word) continue;
        if (spoken.length === 0) this.#mark('first-word');
        spoken.push(word);
        yield word;
        if (signal?.aborted) throw abortError();
      }

      if (final && emitted >= turn.words.length) break;
      await turn.changed(signal, WORD_POLL_MS);
    }

    const text = turn.text ?? '';
    this.#mark('agent-text', { chars: text.length, words: spoken.length });
    if (spoken.length === 0) {
      // No word deltas — the undocumented event is gone, or this reply had none. The final
      // transcript is the whole answer.
      if (text) yield text;
      return;
    }
    // Deltas have matched the final transcript exactly on every turn measured. If they ever
    // fall short, finish with what the transcript has beyond them.
    const finalWords = text.trim().split(/\s+/).filter(Boolean);
    const matches = spoken.every((w, i) => finalWords[i] === w);
    if (matches) {
      for (const word of finalWords.slice(spoken.length)) yield word;
    }
  }

  /**
   * How far playback of `turn` has got, in milliseconds of reply audio. Infinity when the
   * turn is not being streamed, so its words are shown as soon as they arrive.
   * @param {ReplyTurn} turn
   * @returns {number}
   */
  #playedMs(turn) {
    if (!this.#player || !turn.streamed || this.#streamingTurn !== turn) return Infinity;
    return this.#player.positionMs();
  }

  /**
   * How many of `turn`'s words the caller has now heard begin.
   *
   * `start_ms` counts from the start of the synthesised speech, not from the start of the
   * reply stream, which opens with the agent's silent lead-in. The speech onset found in the
   * audio anchors the two: measured, onset minus the first word's `start_ms` placed the
   * last word's end within 60 ms of where the voice actually stopped.
   *
   * @param {ReplyTurn} turn
   * @param {number} pos - Playback position, from #playedMs.
   * @returns {number}
   */
  #dueWords(turn, pos) {
    const words = turn.words;
    if (pos === Infinity) return words.length;
    let n = 0;
    while (n < words.length) {
      // Each reply of a tool-calling turn has its own lead-in and its own start_ms clock.
      const seg = turn.segments[words[n].segment];
      if (seg.onsetMs === null) break;
      const at = words[n].startMs;
      const first = seg.firstStartMs;
      // A word without timing is shown with the first moment of speech.
      const dueAt = at === null || first === null ? seg.onsetMs : seg.onsetMs + (at - first);
      if (dueAt > pos) break;
      n++;
    }
    return n;
  }

  /**
   * Hold a continuous conversation: the mic stays open and the agent decides the turns.
   *
   * Optional backend capability; the widget uses it in `mode="conversation"`. Yields events
   * until the signal aborts (throws `AbortError`), the session fails (throws a
   * `TalkieBackendError`), or nobody has spoken for `idleTimeoutMs` (yields `idle-timeout`,
   * then returns). Either way the mic is released and the agent session ended.
   *
   *   { type: 'user-speech' }                      the caller started speaking
   *   { type: 'user-partial', text }               live caption of what they are saying
   *   { type: 'user-transcript', text }            what they said, final
   *   { type: 'reply-start' }                      a reply began (the greeting too)
   *   { type: 'speech-audible' }                   its voice is now sounding
   *   { type: 'reply-word', text }                 one word, as it is heard
   *   { type: 'reply-end', interrupted }           the reply finished playing, or was cut off
   *   { type: 'idle-timeout' }                     ended for silence
   *
   * @param {{ idleTimeoutMs?: number }} [options] - 0 disables the idle limit.
   * @param {AbortSignal} [signal]
   * @returns {AsyncGenerator<object>}
   */
  async *converse({ idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}, signal) {
    this.#assertLive();
    if (this.#conv) throw new TalkieBackendError('backend-failure', 'A conversation is already running.');
    if (signal?.aborted) throw abortError();

    const queue = new EventQueue();
    const conv = { queue, idleMs: idleTimeoutMs, idleTimer: null, replyTurn: null, turnAbort: null, waiting: [] };
    this.#conv = conv;
    this.#userTurns.clear();
    this.#userTurnSeq = 0;
    this.#turn = null;
    const onAbort = () => queue.fail(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // Inside the press, so autoplay policy lets the output context run.
      this.#player?.prepare().catch(() => {});
      if (!this.connected) {
        const [, cred] = await Promise.all([this.#mic.prepare(), this.#fetchToken()]);
        this.#tokenCache = null;
        // The greeting starts arriving right after session.ready; #conv is already set, so
        // it is played as the conversation's first reply.
        await this.#openSocket(cred.token);
      } else {
        await this.#mic.prepare();
      }
      if (signal?.aborted) throw abortError();
      await this.#mic.start((chunk) => this.#sendConversationAudio(chunk));
      this.#armIdle();

      for await (const evt of queue.drain()) {
        yield evt;
        if (evt.type === 'idle-timeout') return;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(conv.idleTimer);
      this.#conv = null;
      conv.turnAbort?.abort();
      await this.#mic.stop().catch(() => {});
      // A new conversation mints a fresh session; one left open bills for nothing.
      this.#endSession();
      this.#turn = null;
      this.#discarding = false;
      this.#discardNext = false;
      this.#pendingResults = [];
      this.#lastEvent = null;
    }
  }

  /**
   * Send one mic chunk in conversation mode. Without barge-in the caller is not heard while
   * a reply plays: the chunk goes as silence, so the stream stays continuous but says nothing.
   * @param {ArrayBuffer} chunk
   */
  #sendConversationAudio(chunk) {
    if (!this.#bargeIn && this.#conv?.replyTurn) chunk = new ArrayBuffer(chunk.byteLength);
    this.#sendAudio(chunk);
  }

  /** (Re)start the conversation's idle countdown, unless a reply is playing. */
  #armIdle() {
    const conv = this.#conv;
    if (!conv) return;
    clearTimeout(conv.idleTimer);
    conv.idleTimer = null;
    if (!(conv.idleMs > 0) || conv.replyTurn) return;
    conv.idleTimer = setTimeout(() => {
      if (this.#conv === conv && !conv.replyTurn) conv.queue.push({ type: 'idle-timeout' });
    }, conv.idleMs);
  }

  /** @param {object} conv */
  #holdIdle(conv) {
    clearTimeout(conv.idleTimer);
    conv.idleTimer = null;
  }

  /**
   * Play a reply that arrived during a conversation, and report its words and its end.
   * @param {ReplyTurn} turn
   */
  #playConversationReply(turn) {
    const conv = this.#conv;
    const ctrl = new AbortController();
    conv.replyTurn = turn;
    conv.turnAbort = ctrl;
    this.#holdIdle(conv);
    conv.queue.push({ type: 'reply-start' });
    if (this.#player) this.#streamTurn(turn, ctrl.signal);

    (async () => {
      try {
        const words = this.#replyWords(turn, ctrl.signal, () => conv.queue.push({ type: 'speech-audible' }));
        for await (const text of words) conv.queue.push({ type: 'reply-word', text });
        if (turn.streamed) await this.#player.drained();
        else if (this.speak) await this.speak('', ctrl.signal);
      } catch (err) {
        if (err?.name !== 'AbortError') {
          if (this.#conv === conv) conv.queue.fail(err);
          return;
        }
      }
      // Cut off by barge-in, or superseded: that path has already reported the end.
      if (this.#conv !== conv || conv.replyTurn !== turn) return;
      conv.replyTurn = null;
      conv.turnAbort = null;
      conv.queue.push({ type: 'reply-end', interrupted: ctrl.signal.aborted });
      const next = conv.waiting.shift();
      if (next) this.#playConversationReply(next);
      else this.#armIdle();
    })();
  }

  /**
   * Cut off the reply that is playing in a conversation — the widget's Stop button. The
   * conversation carries on listening. No-op outside a conversation or between replies.
   * @returns {boolean} Whether a reply was cut off.
   */
  interrupt() {
    const conv = this.#conv;
    if (!conv?.replyTurn) return false;
    this.#cutReply(conv);
    this.#armIdle();
    return true;
  }

  /**
   * Stop the conversation's current reply now and report it as interrupted. The abort also
   * drops the rest of that reply as it keeps arriving (#streamTurn marks it for discarding).
   * @param {object} conv
   */
  #cutReply(conv) {
    const ctrl = conv.turnAbort;
    conv.replyTurn = null;
    conv.turnAbort = null;
    // Replies queued behind it answered what came before the cut; drop them too.
    conv.waiting = [];
    conv.queue.push({ type: 'reply-end', interrupted: true });
    ctrl?.abort();
  }

  /** The caller started speaking during a conversation. */
  #onConversationSpeech() {
    const conv = this.#conv;
    if (conv.replyTurn) {
      // Without barge-in the mic is silenced during replies; a detection here is noise.
      if (!this.#bargeIn) return;
      // Stop at once rather than wait for the vendor's interrupted reply.done: a voice that
      // keeps going for a beat after you talk over it feels like it did not hear you.
      this.#cutReply(conv);
      this.#mark('barge-in');
    }
    this.#holdIdle(conv);
    conv.queue.push({ type: 'user-speech' });
  }

  /**
   * Resolve when the caller starts hearing this turn's reply — the voice itself, not the
   * silent lead-in the agent streams while it works out the answer.
   *
   * Optional backend capability. The widget calls this alongside `ask()` and moves to
   * `speaking` on whichever comes first. Absent when streaming playback is unavailable.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async speechStarted(signal) {
    this.#speechStart ??= deferred();
    const { promise } = this.#speechStart;
    if (signal?.aborted) throw abortError();
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      promise.then(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  /**
   * Play the audio the agent already synthesised for this turn.
   *
   * @param {string} _text - Unused; the audio came down with the reply.
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async speak(_text, signal) {
    this.#assertLive();
    const turn = this.#turn;
    if (!turn) return;

    if (turn.streamed) {
      // Already playing since the first frame; nothing to start, just wait it out. An abort
      // stops the player (see #streamTurn), which releases drained() at once.
      await this.#player.drained();
      this.#mark('playback-done', { streamed: true });
      return;
    }

    // `ask()` returns on transcript.agent, which the spec places after the last audio
    // frame — but reply.done is the actual end of the stream, so wait for it.
    await turn.audioComplete(signal);
    this.#mark('audio-complete', {
      frames: turn.audio.length,
      audioMs: VoiceAgentBackend.audioMs(turn.audio),
    });
    if (signal?.aborted) return;

    const chunks = turn.audio;
    if (!chunks.length) return;

    this.#stopAudio();
    this.#audioUrl = URL.createObjectURL(pcmToWavBlob(chunks, PCM_SAMPLE_RATE));
    const audio = new Audio(this.#audioUrl);
    this.#audio = audio;
    // The headline number: silence between the caller releasing and hearing anything back.
    this.#mark('playback-start', { audioMs: VoiceAgentBackend.audioMs(chunks) });

    await new Promise((resolve) => {
      const finish = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => { this.#stopAudio(); finish(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      audio.addEventListener('ended', finish, { once: true });
      // A failed play (autoplay policy, decode error) must not wedge the widget in the
      // speaking state, so an error resolves rather than rejects.
      audio.addEventListener('error', finish, { once: true });
      audio.play().catch(finish);
    });
    this.#mark('playback-done');
  }

  /** Release every resource this backend holds and end the agent session. */
  dispose() {
    this.#disposed = true;
    this.#mic.release().catch(() => {});
    this.#tokenCache = null;
    this.#turn?.fail(new TalkieBackendError('backend-failure', 'Backend disposed'));
    this.#conv?.queue.fail(abortError());
    this.#turn = null;
    this.#awaitingUserTranscript?.resolve('');
    this.#awaitingUserTranscript = null;
    this.#endSession();
    this.#stopAudio();
    this.#speechStart?.resolve();
    this.#streamingTurn = null;
    this.#discarding = false;
    this.#discardNext = false;
    this.#pendingResults = [];
    this.#lastEvent = null;
    this.#player?.close();
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Join recognised user turns into one transcript, in arrival order.
   * @param {Map<number, string>} turns
   * @returns {string}
   */
  static joinTurns(turns) {
    return [...turns.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Report one turn-phase boundary to `onTiming`, if anyone is listening.
   *
   * `at` is milliseconds since the release that ended the caller's turn, so the marks read
   * as one timeline and the gap between any two is the cost of that phase. A throwing
   * listener is swallowed: instrumentation must never break a live turn.
   *
   * @param {string} mark
   * @param {object} [detail] - Extra fields worth seeing beside the timing.
   */
  #mark(mark, detail = {}) {
    if (!this.#onTiming) return;
    const at = this.#turnT0 ? Math.round(performance.now() - this.#turnT0) : 0;
    try {
      this.#onTiming(mark, { at, ...detail });
    } catch { /* a broken probe must not cost the caller their turn */ }
  }

  /**
   * Total duration of the buffered reply audio, in milliseconds.
   *
   * 16-bit mono, so two bytes per sample. Used to tell a long answer apart from a slow
   * one: if playback lag tracks this number, the wait is the buffering, not the network.
   *
   * @param {ArrayBuffer[]} chunks
   * @returns {number}
   */
  static audioMs(chunks) {
    const bytes = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    return Math.round((bytes / 2 / PCM_SAMPLE_RATE) * 1000);
  }

  /**
   * Fetch a session token, reusing a cached one while it is still redeemable.
   *
   * The token must open the socket within `expires_in_seconds` of issue, so the cache is
   * dropped well before that: a stale token fails the handshake and costs a whole turn.
   *
   * @returns {Promise<{ token: string, expires_in_seconds?: number }>}
   */
  async #fetchToken() {
    const cached = this.#tokenCache;
    if (cached) {
      const ageMs = Date.now() - cached.at;
      const budgetMs = Math.max(0, (cached.cred.expires_in_seconds ?? 300) * 1000 - 30000);
      if (ageMs < budgetMs) return cached.cred;
    }

    let cred;
    if (this.#fetchTokenFn) {
      try {
        cred = await this.#fetchTokenFn();
      } catch (err) {
        throw new TalkieBackendError('backend-failure', err?.message || String(err));
      }
    } else {
      let res;
      try {
        res = await fetch(this.#tokenUrl);
      } catch (err) {
        throw new TalkieBackendError('offline', err?.message || String(err));
      }
      if (!res.ok) {
        throw new TalkieBackendError(
          'backend-failure',
          `GET ${this.#tokenUrl} failed: HTTP ${res.status}`,
        );
      }
      cred = await res.json();
    }

    if (!cred?.token) {
      throw new TalkieBackendError('backend-failure', 'Token response carried no token.');
    }
    this.#tokenCache = { cred, at: Date.now() };
    return cred;
  }

  /**
   * Open the agent socket, send the session config, and resolve on `session.ready`.
   * @param {string} token
   * @returns {Promise<void>}
   */
  #openSocket(token) {
    const url = `${this.#wsUrl}${this.#wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(new TalkieBackendError('offline', err?.message || String(err)));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.#ws = ws;

      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new TalkieBackendError('backend-failure', 'Agent session never became ready.')),
        SESSION_READY_TIMEOUT_MS,
      );

      ws.addEventListener('close', () => {
        const ours = this.#ws === ws;
        if (ours) this.#ws = null;
        fail(new TalkieBackendError('offline', 'Agent socket closed before it was ready.'));
        // A conversation outlives the handshake; a drop mid-way must end it, not leave it
        // listening to nothing. converse() nulls #conv before closing the socket itself.
        if (ours && settled) this.#conv?.queue.fail(new TalkieBackendError('offline', 'The voice agent connection closed.'));
      });

      ws.addEventListener('open', () => {
        // The session has to be configured before any audio is accepted, so this goes out
        // immediately rather than waiting for the first chunk.
        this.#send(this.#sessionConfig);
      });

      ws.addEventListener('error', () => {
        fail(new TalkieBackendError('offline', 'Could not reach the voice agent service.'));
      });

      ws.addEventListener('message', (event) => {
        const evt = this.#readFrame(event.data);
        if (!evt) return;

        if (evt.kind === 'ready') {
          this.#sessionId = evt.sessionId;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        if (evt.kind === 'error' && !settled) {
          fail(new TalkieBackendError(VoiceAgentBackend.reasonForCode(evt.code), evt.message));
          return;
        }
        this.#handleEvent(evt);
      });
    });
  }

  /**
   * Parse a raw frame into a normalised event.
   * @param {any} data
   * @returns {object | null}
   */
  #readFrame(data) {
    if (typeof data !== 'string') return null;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return null;
    }
    return VoiceAgentBackend.readEvent(msg);
  }

  /**
   * Act on one normalised server event.
   * @param {object} evt
   */
  #handleEvent(evt) {
    switch (evt.kind) {
      case 'user-transcript':
        // Keyed by arrival order so a caller who pauses mid-sentence still yields one
        // ordered transcript.
        this.#userTurns.set(this.#userTurnSeq++, evt.text);
        this.#awaitingUserTranscript?.resolve(evt.text);
        this.#awaitingUserTranscript = null;
        this.#conv?.queue.push({ type: 'user-transcript', text: evt.text });
        break;

      case 'user-partial':
        this.#conv?.queue.push({ type: 'user-partial', text: evt.text });
        break;

      case 'speech-stopped':
        // Noise that never became a turn must not hold the conversation open forever.
        this.#armIdle();
        break;

      case 'reply-started':
        this.#lastEvent = 'reply.started';
        if (this.#discardNext) {
          // The reply to a turn the caller cancelled before it began. Drop all of it.
          this.#discardNext = false;
          this.#discarding = true;
          break;
        }
        if (this.#turn && !this.#turn.settled && this.#turn.awaitingFollowUp) {
          // The agent answering a tool result: same question, so the same turn carries on.
          this.#turn.startSegment();
          this.#mark('follow-up-started');
          break;
        }
        // The reply begins before the widget calls ask(), so the buffer opens here.
        this.#beginTurn().began = true;
        // In a conversation nobody calls ask(): the reply plays as soon as it starts, or as
        // soon as the one still sounding has finished.
        if (this.#conv) {
          if (this.#conv.replyTurn) this.#conv.waiting.push(this.#turn);
          else this.#playConversationReply(this.#turn);
        }
        // How long the service took to close the turn and start answering at all.
        this.#mark('reply-started');
        break;

      case 'reply-audio': {
        if (this.#discarding) break;
        const turn = this.#turn ?? this.#beginTurn();
        turn.began = true;
        turn.touch();
        const chunk = decodeBase64(evt.data);
        if (turn.segment.onsetMs === null && isSpeech(chunk)) turn.segment.onsetMs = turn.receivedMs;
        turn.receivedMs += (chunk.byteLength / 2 / PCM_SAMPLE_RATE) * 1000;
        turn.audio.push(chunk);
        if (this.#streamingTurn === turn) this.#player.push(chunk);
        if (!this.#sawFirstAudio) {
          this.#sawFirstAudio = true;
          // The frame we could have started playing on. The gap between this and
          // `playback-start` is what full-reply buffering costs.
          this.#mark('first-audio-frame');
        }
        break;
      }

      case 'agent-delta':
        if (this.#discarding) break;
        {
          const turn = this.#turn ?? this.#beginTurn();
          turn.began = true;
          turn.addWord(evt.text, evt.startMs);
        }
        break;

      case 'agent-transcript':
        if (this.#discarding) break;
        {
          const turn = this.#turn ?? this.#beginTurn();
          turn.began = true;
          turn.setText(evt.text);
        }
        break;

      case 'reply-done':
        // A reply with no transcript.agent — empty, interrupted, or a turn the agent
        // answered with a tool call alone — still has to release ask(), or the widget
        // sits in `thinking` until the reply timeout for nothing. The turn is created
        // here when nothing else opened one, so ask() finds it already settled.
        this.#lastEvent = 'reply.done';
        if (evt.status === 'interrupted') {
          // Per the docs: the agent has moved on, so results it asked for are stale.
          this.#pendingResults = [];
          if (this.#turn) this.#turn.awaitingFollowUp = false;
        }
        if (this.#discarding) {
          // The tail of a reply the caller cancelled. It is over; start listening again.
          this.#discarding = false;
        } else {
          const turn = this.#turn ?? this.#beginTurn();
          if (turn.awaitingFollowUp) {
            // This reply called a tool; the answer comes in the reply its result triggers.
            turn.touch();
          } else {
            turn.finish();
            if (this.#streamingTurn === turn) this.#player.finish();
          }
        }
        this.#flushResults();
        break;

      case 'speech-started':
        this.#lastEvent = 'input.speech.started';
        if (this.#conv) this.#onConversationSpeech();
        break;

      case 'tool-call': {
        // Documented order: tool.call arrives inside the reply that asks for it. A call for a
        // turn that is over or cancelled still gets a result — the agent waits on one — but
        // it is not run, and the reply it triggers is dropped rather than leaking into the
        // caller's next question.
        // The vendor can also send a call with no reply.started before it. In a conversation a
        // finished turn is only the previous answer, not a cancelled question, so the call
        // opens the new question's turn.
        if (this.#conv && this.#turn?.settled && !this.#discarding) this.#turn = null;
        const live = !this.#discarding && !this.#turn?.settled;
        // No turn yet means no reply event since the press: the call is this question's.
        if (live) {
          const turn = this.#beginTurn();
          turn.awaitingFollowUp = true;
          // Nothing has told the widget a reply began, and the follow-up only continues this
          // turn, so without this it would wait on "Understanding…" forever.
          const conv = this.#conv;
          if (conv && conv.replyTurn !== turn && !conv.waiting.includes(turn)) {
            if (conv.replyTurn) conv.waiting.push(turn);
            else this.#playConversationReply(turn);
          }
        }
        this.#runTool(evt, { live });
        break;
      }

      case 'error': {
        const err = new TalkieBackendError(
          VoiceAgentBackend.reasonForCode(evt.code),
          `${evt.message} (${evt.code})`,
        );
        this.#turn?.fail(err);
        this.#conv?.queue.fail(err);
        this.#pendingResults = [];
        this.#awaitingUserTranscript?.resolve('');
        this.#awaitingUserTranscript = null;
        break;
      }

      case 'ended':
        (this.#turn ?? this.#beginTurn()).finish();
        this.#sessionId = null;
        // Ended from the vendor's side (converse() clears #conv before ending it itself).
        this.#conv?.queue.fail(new TalkieBackendError('offline', 'The voice agent ended the session.'));
        break;
    }
  }

  /**
   * Run a tool call and queue its result for the next moment it may be sent.
   * @param {{ callId: string, name: string, arguments: object }} call
   * @param {{ live: boolean }} options - False when the call's turn is over or cancelled.
   */
  async #runTool({ callId, name, arguments: args }, { live }) {
    let result;
    try {
      if (!live) throw new Error('The caller cancelled this request before it ran. Do not retry it.');
      if (!this.#onToolCall) throw new Error(`No handler for tool "${name}"`);
      result = await this.#onToolCall({ name, arguments: args, call_id: callId });
    } catch (err) {
      // The agent is mid-turn waiting on this; telling it the tool failed keeps the
      // conversation moving, where silence would strand it until the vendor times out.
      result = { error: err?.message || String(err) };
    }
    if (this.#disposed) return;
    this.#pendingResults.push({
      callId,
      // The API takes the result as a JSON-encoded string, not a nested object.
      result: typeof result === 'string' ? result : JSON.stringify(result ?? null),
      discardFollowUp: !live,
    });
    // The handler may finish after reply.done has already arrived.
    this.#flushResults();
  }

  /** Send every held tool result, if `reply.done` is the latest event received. */
  #flushResults() {
    if (this.#lastEvent !== 'reply.done' || !this.#pendingResults.length) return;
    const results = this.#pendingResults;
    this.#pendingResults = [];
    for (const { callId, result } of results) {
      this.#send({ type: 'tool.result', call_id: callId, result });
    }
    this.#mark('tool-results-sent', { count: results.length });
    // Each flush triggers one reply. If it answers a turn nobody is listening to any more,
    // drop it — unless the live turn is also waiting on it, in which case it is that turn's.
    const liveWaiting = this.#turn && !this.#turn.settled && this.#turn.awaitingFollowUp;
    if (!liveWaiting && results.some((r) => r.discardFollowUp)) this.#discardNext = true;
  }

  /** @returns {ReplyTurn} A fresh reply buffer, replacing any finished one. */
  /**
   * Route `turn` to the player: whatever has already arrived plays now, and each frame
   * after it plays as it lands. Cancelling the turn silences it and, if the agent is still
   * sending, drops the rest of that reply rather than letting it leak into the next.
   *
   * @param {ReplyTurn} turn
   * @param {AbortSignal} [signal]
   */
  #streamTurn(turn, signal) {
    const player = this.#player;
    player.reset();
    turn.streamed = true;
    this.#streamingTurn = turn;

    player.whenStarted().then(() => {
      // whenStarted() also settles when the player is stopped; only a real start counts.
      // This is the first frame, usually the silent lead-in; speech-audible marks the voice.
      if (!player.started || this.#streamingTurn !== turn) return;
      this.#mark('playback-start', { streamed: true });
    });

    for (const chunk of turn.audio) player.push(chunk);
    if (turn.settled) player.finish();

    const onAbort = () => {
      if (this.#streamingTurn === turn) {
        this.#streamingTurn = null;
        player.stop();
      }
      if (!turn.settled) {
        // Mid-reply: drop the rest of it. Not yet begun: the whole reply is still coming.
        if (turn.began) this.#discarding = true;
        else this.#discardNext = true;
        turn.fail(abortError());
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  }

  #beginTurn() {
    if (this.#turn && !this.#turn.settled) return this.#turn;
    this.#turn = new ReplyTurn();
    return this.#turn;
  }

  /**
   * Send one PCM chunk as an `input.audio` frame.
   * @param {ArrayBuffer} chunk
   */
  #sendAudio(chunk) {
    if (!this.connected) return;
    this.#send({ type: 'input.audio', audio: encodeBase64(chunk) });
  }

  /**
   * Send a JSON frame if the socket is open.
   * @param {object} frame
   */
  #send(frame) {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch { /* socket already going down */ }
  }

  /**
   * End the agent session and close the socket.
   *
   * `session.end` matters: without it the vendor holds the session for its 30 s resume
   * window, and a page that opens the widget repeatedly stacks up abandoned sessions.
   */
  #endSession() {
    const ws = this.#ws;
    this.#ws = null;
    this.#sessionId = null;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'session.end' })); } catch { /* going down */ }
    }
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    } catch { /* already closing */ }
  }

  /** Stop any playing audio and release its object URL. */
  #stopAudio() {
    if (this.#audio) {
      try { this.#audio.pause(); } catch { /* not playing */ }
      this.#audio = null;
    }
    if (this.#audioUrl) {
      try { URL.revokeObjectURL(this.#audioUrl); } catch { /* already revoked */ }
      this.#audioUrl = null;
    }
  }

  /** @throws {TalkieBackendError} When the backend has been disposed. */
  #assertLive() {
    if (this.#disposed) {
      throw new TalkieBackendError('backend-failure', 'Backend disposed');
    }
  }
}

/**
 * One agent reply, buffered as its frames arrive.
 *
 * The widget asks for the reply in two stages — text through `ask()`, then audio through
 * `speak()` — but both arrive together on the socket, and often before `ask()` is called.
 * This holds the pieces and the promises that let those calls await them.
 */
class ReplyTurn {
  /** @type {ArrayBuffer[]} Decoded PCM chunks, in order. */ audio = [];
  /** @type {boolean} Played through the streaming player rather than as one clip. */ streamed = false;
  /** @type {boolean} The agent has started sending this reply. */ began = false;
  /** @type {Array<{ text: string, startMs: number | null, segment: number }>} Word deltas, in order. */ words = [];
  /** @type {number} Milliseconds of reply audio received. */ receivedMs = 0;
  /**
   * One entry per vendor reply in this turn: one normally, more when the agent calls a tool
   * and answers in a follow-up. Each has its own silent lead-in and its own `start_ms` clock.
   *   onsetMs       where in the turn's audio this reply's voice starts; null until heard
   *   firstStartMs  `start_ms` of this reply's first timed word
   *   text          this reply's transcript.agent
   * @type {Array<{ onsetMs: number | null, firstStartMs: number | null, text: string | null }>}
   */
  segments = [{ onsetMs: null, firstStartMs: null, text: null }];
  /** @type {boolean} A tool was called; reply.done does not end the turn until its follow-up does. */ awaitingFollowUp = false;
  /** @type {number} Date.now() of the last sign the agent is still sending. */ #lastActivity = Date.now();
  /** @type {Error | null} */ #error = null;
  /** @type {boolean} */ #done = false;
  /** @type {Array<() => void>} */ #waiters = [];
  /** @type {Set<() => void>} Restart each pending waiter's inactivity timer. */ #rearms = new Set();

  /** @returns {boolean} True once the reply has finished or failed. */
  get settled() {
    return this.#done || this.#error !== null;
  }

  /** @returns {object} The reply currently arriving. */
  get segment() {
    return this.segments[this.segments.length - 1];
  }

  /** @returns {number | null} Where the turn's first voice starts; null until heard. */
  get onsetMs() {
    return this.segments[0].onsetMs;
  }

  /** The agent's follow-up reply to a tool result has begun. */
  startSegment() {
    this.segments.push({ onsetMs: null, firstStartMs: null, text: null });
    this.awaitingFollowUp = false;
    this.touch();
    this.#wake();
  }

  /** @param {string} text - This reply's transcript.agent. */
  setText(text) {
    this.segment.text = text;
    this.#lastActivity = Date.now();
    this.#wake();
  }

  /** The agent is still sending this reply: push every pending timeout back. */
  touch() {
    this.#lastActivity = Date.now();
    for (const rearm of this.#rearms) rearm();
  }

  /** @returns {boolean} True once reply.done has arrived. */
  get done() {
    return this.#done;
  }

  /** @returns {string | null} Every reply's transcript.agent text joined, once any has arrived. */
  get text() {
    const parts = this.segments.map((seg) => seg.text).filter((t) => t !== null);
    return parts.length ? parts.filter(Boolean).join(' ') : null;
  }

  /**
   * @param {string} text
   * @param {number | null} startMs
   */
  addWord(text, startMs) {
    const seg = this.segment;
    if (seg.firstStartMs === null && startMs !== null) seg.firstStartMs = startMs;
    this.words.push({ text, startMs, segment: this.segments.length - 1 });
    this.touch();
    this.#wake();
  }

  /**
   * Resolve on the next change to this reply, or after `pollMs` — whichever is first.
   * Rejects on the reply failing, on abort, or when the agent has sent nothing at all for
   * REPLY_TIMEOUT_MS while the reply is unfinished.
   *
   * @param {AbortSignal} [signal]
   * @param {number} pollMs
   * @returns {Promise<void>}
   */
  changed(signal, pollMs) {
    if (this.#error) return Promise.reject(this.#error);
    if (signal?.aborted) return Promise.reject(abortError());
    if (!this.settled && Date.now() - this.#lastActivity >= REPLY_TIMEOUT_MS) {
      if (this.text !== null && !this.awaitingFollowUp) {
        // The whole answer's text arrived and only reply.done went missing: finish with it.
        this.finish();
        return Promise.resolve();
      }
      return Promise.reject(new TalkieBackendError('backend-failure', 'The voice agent sent no reply.'));
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#waiters = this.#waiters.filter((w) => w !== onChange);
      };
      const onAbort = () => { cleanup(); reject(abortError()); };
      const onChange = () => {
        cleanup();
        if (this.#error) reject(this.#error);
        else resolve();
      };
      const timer = setTimeout(() => { cleanup(); resolve(); }, pollMs);
      this.#waiters.push(onChange);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Mark the reply complete, releasing anything waiting on it. */
  finish() {
    this.#done = true;
    this.#wake();
  }

  /** @param {Error} error */
  fail(error) {
    this.#error = error;
    this.#wake();
  }

  /**
   * Resolve once every audio frame has arrived.
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async audioComplete(signal) {
    try {
      await this.#wait(() => this.settled, signal, REPLY_TIMEOUT_MS, 'Reply never completed.');
    } catch (err) {
      // Playback is the last step of a turn that already produced text; a timeout here
      // should play what arrived rather than throw the widget into an error state.
      if (err?.name === 'AbortError') throw err;
    }
  }

  /**
   * Wait until `ready()` holds, or the signal aborts, or the timeout expires.
   * @param {() => boolean} ready
   * @param {AbortSignal | undefined} signal
   * @param {number} timeoutMs
   * @param {string} timeoutMessage
   * @returns {Promise<void>}
   */
  #wait(ready, signal, timeoutMs, timeoutMessage) {
    if (this.#error) return Promise.reject(this.#error);
    if (ready()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        this.#rearms.delete(rearm);
        signal?.removeEventListener('abort', onAbort);
        this.#waiters = this.#waiters.filter((w) => w !== check);
      };
      const onAbort = () => { cleanup(); reject(abortError()); };
      const rearm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          cleanup();
          reject(new TalkieBackendError('backend-failure', timeoutMessage));
        }, timeoutMs);
      };
      rearm();
      this.#rearms.add(rearm);
      const check = () => {
        if (this.#error) { cleanup(); reject(this.#error); return; }
        if (ready()) { cleanup(); resolve(); }
      };
      this.#waiters.push(check);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Re-run every pending waiter's condition. */
  #wake() {
    for (const waiter of [...this.#waiters]) waiter();
  }
}

/**
 * An unbounded queue read by one async iterator: the conversation's events, pushed from socket
 * handlers and reply tasks, pulled by `converse()`. A failure is thrown to the reader at once.
 */
class EventQueue {
  /** @type {object[]} */ #items = [];
  /** @type {Error | null} */ #error = null;
  /** @type {(() => void) | null} */ #wake = null;

  /** @param {object} item */
  push(item) {
    if (this.#error) return;
    this.#items.push(item);
    this.#wake?.();
  }

  /** @param {Error} error */
  fail(error) {
    this.#error ??= error;
    this.#wake?.();
  }

  /** @returns {AsyncGenerator<object>} */
  async *drain() {
    for (;;) {
      if (this.#error) throw this.#error;
      if (this.#items.length) {
        yield this.#items.shift();
        continue;
      }
      await new Promise((resolve) => { this.#wake = resolve; });
      this.#wake = null;
    }
  }
}

/**
 * True when a PCM frame is loud enough to be the synthesised voice rather than the
 * near-silence the agent streams before it.
 * @param {ArrayBuffer} chunk - 16-bit little-endian mono PCM.
 * @returns {boolean}
 */
function isSpeech(chunk) {
  const samples = new Int16Array(chunk, 0, chunk.byteLength >> 1);
  if (samples.length === 0) return false;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length) > SPEECH_RMS_THRESHOLD;
}

/** @returns {{ promise: Promise<void>, resolve: () => void, settled?: boolean }} */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** @returns {Error} A DOMException-shaped abort error the widget maps to idle. */
function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}
