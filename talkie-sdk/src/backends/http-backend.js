/**
 * HttpBackend — a real TalkieBackend backed by the Talkie voice server.
 *
 * Transport split, and why:
 *   - STT  : the browser streams PCM straight to the speech vendor's WebSocket using a
 *            short-lived token minted by our server, so the transcript is ready the
 *            moment the user releases the button. Routing audio through our own server
 *            first would add an upload plus a batch turnaround to every turn.
 *   - LLM  : SSE over `fetch`, so the AbortSignal the widget already threads through
 *            `ask()` cancels the upstream model call, not just the UI.
 *   - TTS  : one request returning audio bytes. The widget only calls `speak()` after
 *            the whole answer has streamed, so there is nothing to gain from streaming
 *            the synthesis.
 *
 * Server endpoints consumed (see the voice server's README):
 *   POST /chat/session              -> { session_id, opening_greeting, model }
 *   GET  /stt/token                 -> { ws_url, expires_in_seconds, sample_rate, encoding }
 *   POST /chat/ask                  -> text/event-stream of { delta } | { error }
 *   POST /tts                       -> audio bytes
 *   POST /chat/session/{id}/end     -> summary
 */

import { TalkieBackendError } from '../core/backend.js';
import { AccessTicket } from '../core/access-ticket.js';
import { MicCapture } from '../audio/mic-capture.js';

/** How long to wait after Terminate for the vendor's last Turn message. */
const FINAL_TURN_GRACE_MS = 1500;

export class HttpBackend {
  /** @type {string} */ #baseUrl;
  /** @type {string | null} */ #sessionId = null;
  /** @type {WebSocket | null} */ #ws = null;
  /** @type {MicCapture | null} */ #mic = null;
  /** @type {Map<number, string>} */ #turns = new Map();
  /** @type {HTMLAudioElement | null} */ #audio = null;
  /** @type {string | null} */ #audioUrl = null;
  /** @type {boolean} */ #disposed = false;
  /** @type {Promise<void> | null} */ #wsClosed = null;
  /** @type {{ cred: object, at: number } | null} */ #tokenCache = null;
  /** @type {boolean} */ #keepMicWarm = false;
  /** @type {AccessTicket} */ #access;

  /**
   * @param {object} options
   * @param {string} [options.baseUrl='http://localhost:8000'] - Voice server origin.
   * @param {string} [options.sessionId] - Reuse an existing server session.
   * @param {object} [options.caller] - `{ name, email, phone }` passed to the agent.
   * @param {string} [options.productFocus] - Product to prioritise.
   * @param {object} [options.prompts] - Per-session prompt config override.
   * @param {boolean} [options.speakEnabled=true] - Set false for a text-only widget.
   * @param {boolean} [options.keepMicWarm=false] - Hold the mic open between turns.
   *   Removes the per-turn permission round-trip, at the cost of the browser showing
   *   its recording indicator for the whole conversation.
   * @param {(challenge: { provider: string, siteKey: string | null }) => Promise<string> | string}
   *   [options.verify] - Runs the bot check the server's `/agent/session` asks for, when its
   *   `/stt/token` needs a visitor ticket (see `core/access-ticket.js`).
   * @param {AccessTicket} [options.access] - A ticket holder to share; overrides `verify`.
   */
  constructor({
    baseUrl = 'http://localhost:8000',
    sessionId = null,
    caller = null,
    productFocus = null,
    prompts = null,
    speakEnabled = true,
    keepMicWarm = false,
    verify = null,
    access = null,
  } = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#access = access ?? new AccessTicket({ sessionUrl: `${this.#baseUrl}/agent/session`, verify });
    this.#sessionId = sessionId;
    this.caller = caller;
    this.productFocus = productFocus;
    this.prompts = prompts;
    this.#keepMicWarm = keepMicWarm;
    this.#mic = new MicCapture();
    // The widget checks `typeof backend.speak === 'function'`, so opting out has to
    // remove the method rather than just flag it.
    if (!speakEnabled) this.speak = undefined;
  }

  /** @returns {string | null} The server session id, once one has been created. */
  get sessionId() {
    return this.#sessionId;
  }

  /**
   * Create the server session if needed and return its id.
   * @returns {Promise<string>}
   */
  async ensureSession() {
    if (this.#sessionId) return this.#sessionId;
    const body = {};
    if (this.caller) body.caller_info = this.caller;
    if (this.productFocus) body.product_focus = this.productFocus;
    if (this.prompts) body.prompts = this.prompts;

    const data = await this.#json('POST', '/chat/session', body);
    this.#sessionId = data.session_id;
    this.openingGreeting = data.opening_greeting;
    this.model = data.model;
    return this.#sessionId;
  }

  /**
   * Do the slow parts of `startCapture()` ahead of the press.
   *
   * Without this, a press pays for the session POST, the token fetch, the
   * AudioContext and the worklet module before any audio is captured — about 1.4 s,
   * which swallows the caller's first word. Call it when the widget opens, or on
   * hover over the launcher.
   *
   * The speech socket is deliberately **not** opened here: the vendor bills for the
   * whole time a socket stays open, so it is opened on the press and closed on release.
   *
   * @param {object} [options]
   * @param {boolean} [options.mic=false] - Also open the microphone now. The browser
   *   shows its recording indicator until capture ends, so this is opt-in.
   * @returns {Promise<{ session: boolean, audio: boolean, token: boolean, mic: boolean }>}
   *   What actually warmed up; a failure here is never fatal, since `startCapture()`
   *   redoes any step that did not land.
   */
  async prewarm({ mic = false } = {}) {
    if (this.#disposed) return { session: false, audio: false, token: false, mic: false };
    const done = { session: false, audio: false, token: false, mic: false };

    const settled = await Promise.allSettled([
      this.ensureSession().then(() => { done.session = true; }),
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

  /**
   * Fetch a streaming credential, reusing a cached one while it is still redeemable.
   *
   * The token must be used to open the socket within `expires_in_seconds` of issue,
   * so the cache is dropped well before that — a stale token fails the handshake and
   * costs a whole turn.
   *
   * @returns {Promise<object>}
   */
  async #fetchToken() {
    const cached = this.#tokenCache;
    if (cached) {
      const ageMs = Date.now() - cached.at;
      const budgetMs = Math.max(0, (cached.cred.expires_in_seconds ?? 60) * 1000 - 15000);
      if (ageMs < budgetMs) return cached.cred;
    }
    // The one route that spends the vendor account, so the one that may need a ticket.
    const cred = await this.#json('GET', '/stt/token', undefined, { ticketed: true });
    this.#tokenCache = { cred, at: Date.now() };
    return cred;
  }

  // ── TalkieBackend contract ────────────────────────────────────────────────

  /**
   * Open the microphone and begin streaming audio to the speech vendor.
   * @returns {Promise<void>}
   */
  async startCapture() {
    this.#assertLive();
    this.#turns.clear();

    // Warm the audio graph and the session in parallel with the token fetch; each is
    // a no-op when prewarm() already did it.
    const [, cred] = await Promise.all([
      this.ensureSession(),
      this.#fetchToken(),
      this.#mic.prepare(),
    ]);
    // A token is single-use for one socket, so drop it once redeemed.
    this.#tokenCache = null;

    await this.#openSocket(cred.ws_url);

    this.#mic.sampleRate = cred.sample_rate ?? 16000;
    try {
      await this.#mic.start((chunk) => {
        if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(chunk);
      });
    } catch (err) {
      // A mic failure leaves an open socket behind; close it so the vendor is not
      // billed for an idle session.
      this.#closeSocket();
      throw err;  // already a TalkieBackendError from MicCapture
    }
  }

  /**
   * Stop capture and resolve with the recognised transcript.
   * @returns {Promise<string>}
   * @throws {TalkieBackendError} `no-speech-detected` when nothing was recognised.
   */
  async stopCapture() {
    await this.#mic.stop({ keepMic: this.#keepMicWarm });

    if (this.#ws?.readyState === WebSocket.OPEN) {
      try {
        this.#ws.send(JSON.stringify({ type: 'Terminate' }));
      } catch { /* socket already going down */ }
      // The last words are still in flight; give the vendor a moment to send the
      // closing Turn rather than truncating the caller mid-sentence.
      await Promise.race([
        this.#wsClosed ?? Promise.resolve(),
        new Promise((r) => setTimeout(r, FINAL_TURN_GRACE_MS)),
      ]);
    }
    this.#closeSocket();

    const transcript = this.#collectTranscript();
    if (!transcript) {
      throw new TalkieBackendError('no-speech-detected', 'No speech was recognised.');
    }
    return transcript;
  }

  /**
   * Send the transcript and yield response text as it streams back.
   * @param {string} transcript
   * @param {AbortSignal} signal
   * @returns {AsyncGenerator<string>}
   */
  async *ask(transcript, signal) {
    this.#assertLive();
    const sessionId = await this.ensureSession();

    let res;
    try {
      res = await fetch(`${this.#baseUrl}/chat/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, text: transcript }),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;  // widget maps this to idle
      throw new TalkieBackendError('offline', err?.message || String(err));
    }

    if (!res.ok) {
      throw new TalkieBackendError('backend-failure', `ask failed: HTTP ${res.status}`);
    }
    if (!res.body) {
      throw new TalkieBackendError('backend-failure', 'ask returned no response body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line; anything after the last one is a
        // partial event that must stay buffered until the next read.
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
          const payload = HttpBackend.parseSseEvent(event);
          if (payload === null) continue;
          if (payload === '[DONE]') return;
          if (payload.error) {
            throw new TalkieBackendError('backend-failure', payload.error);
          }
          if (payload.delta) yield payload.delta;
        }
      }
    } finally {
      // Releasing the lock lets fetch tear the connection down; without it an aborted
      // turn leaves the server streaming into a socket nobody reads.
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  /**
   * Synthesise and play `text`.
   * @param {string} text
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async speak(text, signal) {
    this.#assertLive();
    if (!text?.trim()) return;

    let res;
    try {
      res = await fetch(`${this.#baseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, session_id: this.#sessionId }),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      throw new TalkieBackendError('backend-failure', err?.message || String(err));
    }
    if (!res.ok) throw new TalkieBackendError('backend-failure', `tts failed: HTTP ${res.status}`);

    const blob = await res.blob();
    if (signal?.aborted) return;

    this.#stopAudio();
    this.#audioUrl = URL.createObjectURL(blob);
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
      // A failed play (autoplay policy, decode error) must not wedge the widget in
      // the speaking state, so an error resolves rather than rejects.
      audio.addEventListener('error', finish, { once: true });
      audio.play().catch(finish);
    });
  }

  /** Release every resource this backend holds. */
  dispose() {
    this.#disposed = true;
    this.#mic.release().catch(() => {});
    this.#tokenCache = null;
    this.#closeSocket();
    this.#stopAudio();

    if (this.#sessionId) {
      const url = `${this.#baseUrl}/chat/session/${this.#sessionId}/end`;
      // keepalive lets the request outlive the page during an unload teardown, so the
      // server still fires its post-call webhook.
      fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
      this.#sessionId = null;
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Parse one SSE event block into its payload.
   * Exposed as a static so the framing logic is testable without a live stream.
   *
   * @param {string} event - One event block, without the trailing blank line.
   * @returns {object | '[DONE]' | null} Parsed payload, the DONE sentinel, or null
   *   when the block carries no usable `data:` line.
   */
  static parseSseEvent(event) {
    for (const line of event.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw) continue;
      if (raw === '[DONE]') return '[DONE]';
      try {
        return JSON.parse(raw);
      } catch {
        // A malformed frame is not worth killing the turn over; skip it.
        return null;
      }
    }
    return null;
  }

  /**
   * Extract the usable text from a speech-vendor `Turn` message.
   * Static so the message shapes can be tested without a live socket.
   *
   * `utterance` is only populated on the closing frame of a turn and is the cleaner
   * text; `transcript` carries the running partial. Returns null for anything that
   * is not a Turn or carries no text yet.
   *
   * @param {object} msg - A parsed vendor message.
   * @returns {{ order: number, text: string } | null}
   */
  static readTurn(msg) {
    if (!msg || msg.type !== 'Turn') return null;
    const text = (msg.end_of_turn && msg.utterance) || msg.transcript || '';
    if (!text) return null;
    return { order: msg.turn_order ?? 0, text };
  }

  /**
   * Join recognised turns into one transcript, ordered by turn index.
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

  /** @returns {string} The recognised turns, joined in order. */
  #collectTranscript() {
    return HttpBackend.joinTurns(this.#turns);
  }

  /**
   * Open the vendor WebSocket and wire up message handling.
   * @param {string} wsUrl
   * @returns {Promise<void>} Resolves once the socket is open.
   */
  #openSocket(wsUrl) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(new TalkieBackendError('offline', err?.message || String(err)));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.#ws = ws;

      let settled = false;
      this.#wsClosed = new Promise((closed) => {
        ws.addEventListener('close', () => {
          closed();
          if (!settled) {
            settled = true;
            reject(new TalkieBackendError('offline', 'Speech socket closed before opening.'));
          }
        });
      });

      ws.addEventListener('open', () => {
        settled = true;
        resolve();
      });

      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new TalkieBackendError('offline', 'Could not reach the speech service.'));
        }
      });

      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        // Keyed by turn_order so a caller who pauses mid-sentence still yields one
        // ordered transcript, and a final frame supersedes its own partial.
        const turn = HttpBackend.readTurn(msg);
        if (turn) this.#turns.set(turn.order, turn.text);
      });
    });
  }

  /** Close the vendor socket if one is open. */
  #closeSocket() {
    const ws = this.#ws;
    this.#ws = null;
    this.#wsClosed = null;
    if (!ws) return;
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

  /**
   * Issue a JSON request against the voice server.
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @returns {Promise<any>}
   */
  async #json(method, path, body, { ticketed = false } = {}) {
    let res;
    try {
      const doFetch = ticketed ? (url, init) => this.#access.fetch(url, init) : fetch;
      res = await doFetch(`${this.#baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (err instanceof TalkieBackendError) throw err;
      throw new TalkieBackendError('offline', err?.message || String(err));
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data?.detail) detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
      } catch { /* non-JSON error body */ }
      throw new TalkieBackendError('backend-failure', `${method} ${path} failed: ${detail}`);
    }
    return res.json();
  }
}
