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
 * The API key never reaches the browser. A short-lived, single-use token is minted by
 * your server; point `tokenUrl` at that route, or pass `fetchToken` to source it yourself.
 */

import { TalkieBackendError } from '../core/backend.js';
import { MicCapture } from '../audio/mic-capture.js';
import { encodeBase64, decodeBase64, silenceFrame, pcmToWavBlob } from '../audio/pcm-codec.js';

/** The vendor's socket endpoint. */
const DEFAULT_WS_URL = 'wss://agents.assemblyai.com/v1/ws';

/** `audio/pcm` means 16-bit LE mono at this rate, for both directions. */
const PCM_SAMPLE_RATE = 24000;

/** How long to wait for `session.ready` before giving up on the socket. */
const SESSION_READY_TIMEOUT_MS = 10000;

/** How long to wait after the silence padding for the closing `transcript.user`. */
const FINAL_TRANSCRIPT_GRACE_MS = 2500;

/** How long to wait for `transcript.agent` once `ask()` starts reading the turn. */
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

/** Silence is sent in frames this long, so a cancel can interrupt the padding. */
const PAD_FRAME_MS = 50;

/** Error codes the vendor reports that are worth mapping to `offline` rather than a bug. */
const OFFLINE_ERROR_CODES = new Set(['server_error', 'INTERNAL_ERROR']);

export class VoiceAgentBackend {
  /** @type {string} */ #tokenUrl;
  /** @type {(() => Promise<object>) | null} */ #fetchTokenFn;
  /** @type {string} */ #wsUrl;
  /** @type {object} */ #sessionConfig;
  /** @type {number} */ #padMs;
  /** @type {boolean} */ #keepMicWarm;
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
   * @param {boolean} [options.speakEnabled=true] - Set false for a text-only widget.
   * @param {boolean} [options.keepMicWarm=false] - Hold the mic open between turns.
   * @param {number} [options.endOfTurnPadMs] - Override the silence padding length.
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
    speakEnabled = true,
    keepMicWarm = false,
    endOfTurnPadMs = null,
  } = {}) {
    const origin = baseUrl.replace(/\/+$/, '');
    this.#tokenUrl = tokenUrl ?? `${origin}/agent/token`;
    this.#fetchTokenFn = fetchToken;
    this.#wsUrl = wsUrl;
    this.#keepMicWarm = keepMicWarm;
    this.#onToolCall = onToolCall;

    this.#sessionConfig = VoiceAgentBackend.buildSessionUpdate({
      agentId, systemPrompt, greeting, voice, keyterms, volume, turnDetection, tools,
    });

    this.#padMs = endOfTurnPadMs ?? END_OF_TURN_PAD_MS;

    this.#mic = new MicCapture({ sampleRate: PCM_SAMPLE_RATE });
    // The widget checks `typeof backend.speak === 'function'`, so opting out has to
    // remove the method rather than just flag it.
    if (!speakEnabled) this.speak = undefined;
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
          // it on only risks the agent cutting itself off on stray room noise.
          interrupt_response: false,
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
      default:
        // transcript.user.delta, session.updated, input.speech.started/stopped: the
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
    await this.#mic.stop({ keepMic: this.#keepMicWarm });

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

    // The closing words are still being recognised upstream; waiting for the final
    // transcript beats truncating the caller mid-sentence.
    if (this.connected && !this.#userTurns.size) {
      await new Promise((resolve) => {
        const settle = () => {
          this.#awaitingUserTranscript = null;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(settle, FINAL_TRANSCRIPT_GRACE_MS);
        this.#awaitingUserTranscript = { resolve: settle };
      });
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
    const text = await turn.textReady(signal);
    if (text) yield text;
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

    // `ask()` returns on transcript.agent, which the spec places after the last audio
    // frame — but reply.done is the actual end of the stream, so wait for it.
    await turn.audioComplete(signal);
    if (signal?.aborted) return;

    const chunks = turn.audio;
    if (!chunks.length) return;

    this.#stopAudio();
    this.#audioUrl = URL.createObjectURL(pcmToWavBlob(chunks, PCM_SAMPLE_RATE));
    const audio = new Audio(this.#audioUrl);
    this.#audio = audio;

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
  }

  /** Release every resource this backend holds and end the agent session. */
  dispose() {
    this.#disposed = true;
    this.#mic.release().catch(() => {});
    this.#tokenCache = null;
    this.#turn?.fail(new TalkieBackendError('backend-failure', 'Backend disposed'));
    this.#turn = null;
    this.#awaitingUserTranscript?.resolve('');
    this.#awaitingUserTranscript = null;
    this.#endSession();
    this.#stopAudio();
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
        if (this.#ws === ws) this.#ws = null;
        fail(new TalkieBackendError('offline', 'Agent socket closed before it was ready.'));
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
        break;

      case 'reply-started':
        // The reply begins before the widget calls ask(), so the buffer opens here.
        this.#beginTurn();
        break;

      case 'reply-audio':
        (this.#turn ?? this.#beginTurn()).audio.push(decodeBase64(evt.data));
        break;

      case 'agent-transcript':
        (this.#turn ?? this.#beginTurn()).setText(evt.text);
        break;

      case 'reply-done':
        // A reply with no transcript.agent — empty, interrupted, or a turn the agent
        // answered with a tool call alone — still has to release ask(), or the widget
        // sits in `thinking` until the reply timeout for nothing. The turn is created
        // here when nothing else opened one, so ask() finds it already settled.
        (this.#turn ?? this.#beginTurn()).finish();
        break;

      case 'tool-call':
        this.#runTool(evt);
        break;

      case 'error': {
        const err = new TalkieBackendError(
          VoiceAgentBackend.reasonForCode(evt.code),
          `${evt.message} (${evt.code})`,
        );
        this.#turn?.fail(err);
        this.#awaitingUserTranscript?.resolve('');
        this.#awaitingUserTranscript = null;
        break;
      }

      case 'ended':
        (this.#turn ?? this.#beginTurn()).finish();
        this.#sessionId = null;
        break;
    }
  }

  /**
   * Run a tool call and send its result back.
   * @param {{ callId: string, name: string, arguments: object }} call
   */
  async #runTool({ callId, name, arguments: args }) {
    let result;
    try {
      if (!this.#onToolCall) throw new Error(`No handler for tool "${name}"`);
      result = await this.#onToolCall({ name, arguments: args, call_id: callId });
    } catch (err) {
      // The agent is mid-turn waiting on this; telling it the tool failed keeps the
      // conversation moving, where silence would strand it until the vendor times out.
      result = { error: err?.message || String(err) };
    }
    this.#send({
      type: 'tool.result',
      call_id: callId,
      // The API takes the result as a JSON-encoded string, not a nested object.
      result: typeof result === 'string' ? result : JSON.stringify(result ?? null),
    });
  }

  /** @returns {ReplyTurn} A fresh reply buffer, replacing any finished one. */
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
  /** @type {string | null} */ #text = null;
  /** @type {Error | null} */ #error = null;
  /** @type {boolean} */ #done = false;
  /** @type {Array<() => void>} */ #waiters = [];

  /** @returns {boolean} True once the reply has finished or failed. */
  get settled() {
    return this.#done || this.#error !== null;
  }

  /** @param {string} text */
  setText(text) {
    this.#text = text;
    this.#wake();
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
   * Resolve with the reply text once it arrives.
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async textReady(signal) {
    await this.#wait(() => this.#text !== null || this.settled, signal, REPLY_TIMEOUT_MS,
      'The voice agent sent no reply.');
    return this.#text ?? '';
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
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#waiters = this.#waiters.filter((w) => w !== check);
      };
      const onAbort = () => { cleanup(); reject(abortError()); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new TalkieBackendError('backend-failure', timeoutMessage));
      }, timeoutMs);
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

/** @returns {Error} A DOMException-shaped abort error the widget maps to idle. */
function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}
