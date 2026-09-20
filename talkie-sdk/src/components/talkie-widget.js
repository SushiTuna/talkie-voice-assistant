import { css, html } from 'lit';
import { ScopedElementsMixin } from '@open-wc/scoped-elements';
import { svg } from 'lit-html';
import { LionButton } from '@lion/ui/button.js';
import { LitElement } from 'lit';
import { TalkieTranscript } from './talkie-transcript.js';
import { StateMachine } from '../core/state-machine.js';

/** Minimum dwell time so the user actually sees the transcribing state. */
const MIN_TRANSCRIBE_DWELL_MS = 700;

/** Race a timer against an abort signal; resolves immediately if the signal fires first. */
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/** Human-readable error messages keyed on state-machine reason values. */
const ERROR_MESSAGES = /** @type {Record<string,{title:string;sub:string}>} */ ({
  'mic-permission-denied': {
    title: 'Microphone access is blocked.',
    sub: 'Allow microphone access in your browser settings, then try again.',
  },
  'no-speech-detected': {
    title: "I didn't catch that.",
    sub: 'Hold the button and speak, then release to send.',
  },
  offline: {
    title: 'You appear to be offline.',
    sub: 'Check your connection and try again.',
  },
  'backend-failure': {
    title: 'The assistant is unavailable.',
    sub: 'Something went wrong on our end. Please try again.',
  },
  unknown: {
    title: 'Something went wrong.',
    sub: 'Please try again.',
  },
});

/** Mixin-applied base class for scoped element composition. */
const ScopedLitElement = ScopedElementsMixin(LitElement);

function iconMic() {
  return svg`<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="2" width="6" height="11" rx="3"/>
    <path d="M5 10v2a7 7 0 0 0 14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="22"/>
  </svg>`;
}

const STATE_LABELS = {
  idle:     'Idle',
  listening:    'Listening',
  transcribing: 'Transcribing',
  thinking:     'Thinking',
  speaking:     'Speaking',
  error:        'Error',
};

/** @typedef {import('../core/backend.js').TalkieBackend} TalkieBackend */

export class TalkieWidget extends ScopedLitElement {
  /** @type {StateMachine} */
  #sm;
  /** @type {string} Current transcript text */
  _tx = '';
  /** @type {string} Current response text */
  _rp = '';
  /** @type {string} Hint text for current state */
  _hint = '';
  /** @type {string} Screen-reader label for current state */
  _label = '';
  /** @type {number} Answer words revealed so far (drives the speaking view) */
  _shown = 0;
  /** @type {string} Last transcript emitted, for event de-duplication */
  #lastTranscript = '';
  /** @type {string} Last response emitted, for event de-duplication */
  #lastResponse = '';
  /** @type {number|null} Animation frame id for waveform */
  #waveAnimId = null;
  /** @type {AbortController|null} Mic capture abort */
  #abortListen = null;
  /** @type {AbortController|null} Transcription abort */
  #abortTrans = null;
  /** @type {AbortController|null} Think abort */
  #abortThink = null;
  /** @type {AbortController|null} Speak abort */
  #abortSpeak = null;
  /** @type {NodeJS.Timeout[]} Timers created by pointer handlers */
  #chunkTimers = [];
  /** @type {boolean} Whether a pointerdown intent is active */
  #hasIntent = false;
  /** @type {number|null} Timestamp of pointer down */
  #listenTime = 0;
  /** @type {boolean} Whether mic capture is active */
  #isListening = false;
  /** @type {string|null} How listening was initiated (for stop button rendering) */
  #listenSource = null;
  /** @type {NodeJS.Timeout|null} Interval for speak reveal */
  #speakTimer = null;
  /** @type {string[]} Words for speak reveal */
  #speakChunks = [];
  /** @type {number} Index of word currently revealed */
  #speakIdx = 0;
  /** @type {boolean} Whether the streaming generator has finished (drives cursor visibility) */
  #streamDone = false;

  static properties = {
    backend: { type: Object },
    mode:   { type: String, attribute: 'mode' },
    open:   { type: Boolean, reflect: true },
    state:  { type: String, reflect: true },
    _tx:    { type: String, state: true },
    _rp:    { type: String, state: true },
    _hint:  { type: String, state: true },
    _label: { type: String, state: true },
    // Number of answer words revealed so far. Must be reactive: the reveal timer
    // advances it and the speaking view re-renders from it.
    _shown: { type: Number, state: true },
  };

  static get scopedElements() {
    return { 'lion-button': LionButton, 'talkie-transcript': TalkieTranscript };
  }

  static get styles() {
    return css`
      :host {
        display: block;
        width: min(430px, 100%);
        min-height: 330px;
        font-family: var(--talkie-font-body, 'Instrument Sans', sans-serif);
        background: var(--talkie-paper, #f7f5ec);
        color: var(--talkie-ink, #101d20);
        border-radius: 22px;
        /* padding is on .view-wrapper — an outer-document reset like '* { padding: 0 }' overrides
           :host rules (the host element is matched by '*' in the light DOM), so host padding is
           not reliable in a distributable component. */
        box-shadow: 0 30px 80px -20px rgba(0,0,0,.6),
                    0 0 0 1px rgba(255,255,255,.07),
                    0 0 70px -18px var(--talkie-state, #8aa39e);
        transition: box-shadow .4s, opacity .35s ease, transform .35s cubic-bezier(.2,.8,.2,1);
        position: relative;
      }
      :host(:not([open])) {
        opacity: 0;
        transform: translateY(18px) scale(.92);
        pointer-events: none;
      }
      /* Padding is here, not on :host, so an outer-document reset like '* { padding: 0 }' can't
         strip it away — the host element itself is matched by '*' in the light DOM. */
      .view-wrapper {
        padding: 44px 34px 36px;
      }
      .eyebrow {
        font-family: var(--talkie-font-mono, monospace);
        font-size: 11px;
        letter-spacing: 2.5px;
        text-transform: uppercase;
        color: var(--talkie-ink-soft, #4a5a58);
        display: flex;
        align-items: center;
        gap: 9px;
      }
      .eyebrow .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--talkie-state, #5fd9c6);
        animation: twk-pulse 1.8s infinite;
      }
      .big {
        font-family: var(--talkie-font-display, 'Space Grotesk', sans-serif);
        font-weight: 700;
        font-size: clamp(26px, 3.4vw, 33px);
        letter-spacing: -.5px;
        margin: 14px 0 22px;
      }
      .sub {
        font-size: 14px;
        line-height: 1.6;
        color: var(--talkie-ink-soft, #4a5a58);
        max-width: 34ch;
      }
      .status-text {
        font-family: var(--talkie-font-display, 'Space Grotesk', sans-serif);
        font-weight: 700;
        font-size: 27px;
        letter-spacing: -.4px;
        margin-bottom: 8px;
      }
      .hintline {
        font-family: var(--talkie-font-mono, monospace);
        font-size: 11.5px;
        letter-spacing: 1.5px;
        color: var(--talkie-ink-soft, #4a5a58);
      }
      .hintline-bottom {
        position: absolute;
        bottom: 14px;
        left: 34px;
        right: 34px;
        text-align: center;
      }
      .tw-sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      /* Buttons */
      .btn-primary {
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 11px;
        background: var(--talkie-ink, #101d20);
        color: var(--talkie-surface, #f6f4ec);
        font-family: var(--talkie-font-display, 'Space Grotesk', sans-serif);
        font-weight: 600;
        font-size: 16px;
        padding: 16px 30px;
        border-radius: 999px;
        margin: 6px 0 20px;
        transition: transform .15s, box-shadow .25s;
        touch-action: none;
        user-select: none;
      }
      .btn-primary:hover { transform: translateY(-2px); }
      .btn-primary:active { transform: scale(.96); }
      .btn-stop {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        background: var(--talkie-ink, #101d20);
        color: var(--talkie-surface, #f6f4ec);
        font-family: var(--talkie-font-display, 'Space Grotesk', sans-serif);
        font-weight: 600;
        font-size: 14.5px;
        padding: 13px 28px;
        border-radius: 999px;
        border: none;
        cursor: pointer;
        transition: transform .15s, box-shadow .25s;
      }
      .btn-stop .sq {
        width: 9px;
        height: 9px;
        background: #ff6b6b;
        border-radius: 2px;
      }
      .ghost {
        background: transparent !important;
        color: var(--talkie-ink, #101d20) !important;
        border: 2px solid var(--talkie-ink, #101d20) !important;
        font-size: 14px !important;
        padding: 12px 26px !important;
        margin: 6px 0 0 !important;
      }
      .ghost:hover {
        background: var(--talkie-ink, #101d20) !important;
        color: var(--talkie-surface, #f6f4ec) !important;
        box-shadow: none !important;
      }
      .close-btn {
        position: absolute;
        top: 13px;
        right: 13px;
        width: 30px;
        height: 30px;
        border-radius: 50%;
        border: none;
        background: rgba(16,29,32,.07);
        color: var(--talkie-ink-soft, #4a5a58);
        font-size: 15px;
        cursor: pointer;
        display: grid;
        place-items: center;
        transition: background .2s, color .2s, transform .2s;
      }
      .close-btn:hover {
        background: var(--talkie-ink, #101d20);
        color: var(--talkie-surface, #f6f4ec);
        transform: rotate(90deg);
      }

      /* Layout */
      .center-layout {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 14px;
      }
      .view {
        animation: twk-rise .34s cubic-bezier(.2,.7,.2,1) both;
      }
      .arc {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 3px solid rgba(16,29,32,.14);
        border-top-color: var(--talkie-state, #ffc96b);
        animation: twk-spin 1s linear infinite;
      }
      .dots3 span {
        display: inline-block;
        width: 7px;
        height: 7px;
        margin: 0 3px;
        border-radius: 50%;
        background: var(--talkie-state, #7fb5ff);
        animation: twk-blink 1.2s infinite;
      }
      .dots3 span:nth-child(2) { animation-delay: .2s; }
      .dots3 span:nth-child(3) { animation-delay: .4s; }
      .eq {
        display: inline-flex;
        gap: 3px;
        align-items: flex-end;
        height: 13px;
        margin-left: 6px;
      }
      .eq i {
        width: 3px;
        height: 100%;
        border-radius: 2px;
        background: var(--talkie-state, #8be28b);
        transform-origin: bottom;
        animation: twk-eq .9s ease-in-out infinite;
      }
      .eq i:nth-child(1) { animation-delay: 0s; }
      .eq i:nth-child(2) { animation-delay: .15s; }
      .eq i:nth-child(3) { animation-delay: .3s; }
      .eq i:nth-child(4) { animation-delay: .45s; }
      .eq i:nth-child(5) { animation-delay: .6s; }
      .err-icon {
        width: 46px;
        height: 46px;
        border-radius: 50%;
        background: #ff6b6b;
        color: #fff;
        display: grid;
        place-items: center;
        font-family: var(--talkie-font-display, 'Space Grotesk', sans-serif);
        font-weight: 700;
        font-size: 24px;
        box-shadow: 0 0 0 8px rgba(255,107,107,.18);
      }
      .resp-area {
        font-size: 17px;
        line-height: 1.65;
        margin: 16px 0 24px;
        min-height: 110px;
        color: #1c2b2e;
      }
      .waveform-host {
        width: 100%;
        height: 72px;
        margin: 4px 0;
      }
      .cursor-cursor {
        display: inline-block;
        width: 2px;
        height: 1em;
        background: var(--talkie-ink, #101d20);
        vertical-align: -2px;
        margin-left: 2px;
        animation: twk-blinkC 1s steps(1) infinite;
      }

      /* Animations */
      @keyframes twk-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: .35; }
      }
      @keyframes twk-rise {
        from { opacity: 0; transform: translateY(12px); }
        to   { opacity: 1; transform: none; }
      }
      @keyframes twk-spin { to { transform: rotate(360deg); } }
      @keyframes twk-blink {
        0%, 100% { opacity: .25; transform: translateY(0); }
        50%      { opacity: 1;       transform: translateY(-4px); }
      }
      @keyframes twk-eq {
        0%, 100% { transform: scaleY(.25); }
        50%      { transform: scaleY(1);   }
      }
      @keyframes twk-blinkC { 50% { opacity: 0; } }
    `;
  }

  constructor() {
    super();
    this.backend = undefined;
    this.mode    = 'auto';
    this.open    = false;
    /** @type {string} Reflective read-only — synced from state machine */
    this.state   = '';

    this.#sm = new StateMachine();

    this._onSmChange   = this._onSmChange.bind(this);
    this._onStartActivate = this._onStartActivate.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp   = this._onPointerUp.bind(this);
    this._onBtnClick    = this._onBtnClick.bind(this);
    this._onCloseClick  = this._onCloseClick.bind(this);
    this._onRetryClick  = this._onRetryClick.bind(this);
    this._onStopClick   = this._onStopClick.bind(this);
    this._onAskAnotherClick = this._onAskAnotherClick.bind(this);
    this._onTapStopClick= this._onTapStopClick.bind(this);
    this._onKeydown     = this._onKeydown.bind(this);

    this.#sm.onChange(this._onSmChange);
    // Init from machine so state is correct before any transition fires
    this.state = this.#sm.state;
    this._syncLabel();
    this._syncHint();
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('pointerdown', this._onPointerDown);
    this.addEventListener('pointerup', this._onPointerUp);
    this.addEventListener('keydown', this._onKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('pointerdown', this._onPointerDown);
    this.removeEventListener('pointerup', this._onPointerUp);
    this.removeEventListener('keydown', this._onKeydown);
    this.#disposeAll();
  }

  willUpdate(changed) {
    if (changed.has('_sm') || changed.has('open')) {
      this._syncLabel();
      this._syncHint();
    }
  }

  updated(changed) {
    if (changed.has('open') && this.open) {
      this._tx = this.#sm.transcript;
      this._rp = this.#sm.response;
    }
  }

  /* ── Public API ─────────────────────────────── */

  show() {
    if (this.open) return;
    if (this.#sm.state !== 'idle') {
      // #cancelConversation already returns the machine to idle; transitioning
      // again would be an illegal idle -> idle and throw.
      this.#cancelConversation('widget reopened');
    }
    if (this.#sm.state !== 'idle') this.#sm.transition('idle');
    this.open = true;
    this._emitEvent('talkie-open');
  }

  hide(reason) {
    if (!this.open) return;
    this.#cancelConversation(reason ?? 'widget closed');
    this.open = false;
    this._emitEvent('talkie-close', { reason });
  }

  reset() {
    this.#cancelConversation('manual reset');
    this.#sm.reset();
    this._syncLabel();
    this._syncHint();
    this.#streamDone = false;
  }

  /* ── Event helpers ──────────────────────────── */

  _emitEvent(name, detail, cancelable = false) {
    this.dispatchEvent(new CustomEvent(name, {
      bubbles: true,
      composed: true,
      detail: detail ?? {},
      cancelable,
    }));
  }

  /* ── State machine listener ─────────────────── */

  _onSmChange(ev) {
    this.state = ev.to;
    this._emitEvent('talkie-state-change', { from: ev.from, to: ev.to });
    this._syncLabel();
    this._syncHint();

    // Emit only on change: this runs for every transition, so an unconditional emit
    // re-fired the same transcript on transcribing, thinking and speaking. Dedup against
    // a dedicated field, not against _tx/_rp — those are render state and are assigned
    // by the conversation pipeline before the transition lands here.
    const t = this.#sm.transcript;
    if (t && t !== this.#lastTranscript) {
      this.#lastTranscript = t;
      this._tx = t;
      this._emitEvent('talkie-transcript', { text: t });
    }

    const r = this.#sm.response;
    if (r && r !== this.#lastResponse) {
      this.#lastResponse = r;
      this._rp = r;
      this._emitEvent('talkie-response', { text: r });
    }

    if (ev.to === 'error') {
      this._emitEvent('talkie-error', { reason: ev.reason, error: ev.error });
    }

    if (ev.to === 'idle') {
      // Clear the de-dup memory so a repeated question still emits next time round
      // (MockBackend round-robins, and real users do ask the same thing twice).
      this.#lastTranscript = '';
      this.#lastResponse = '';
      if (ev.from === 'transcribing' && t) {
        this._tx = '';
      }
      if (ev.from === 'thinking') {
        this.#stopSpeakTimer();
      }
      if (ev.from === 'speaking' && this._rp) {
        this._emitEvent('talkie-response', { text: this._rp });
      }
    }
  }

  _syncLabel() {
    this._label = STATE_LABELS[this.#sm.state] ?? '';
  }

  _syncHint() {
    switch (this.#sm.state) {
      case 'idle':
        this._hint = this.mode === 'toggle'
          ? 'Tap the button to talk'
          : 'Hold Space or the button to talk · release to send';
        break;
      case 'listening':
        this._hint = '';
        break;
      case 'transcribing':
        this._hint = '';
        break;
      case 'thinking':
        this._hint = '';
        break;
      case 'speaking':
        this._hint = '';
        break;
      case 'error':
        this._hint = '';
        break;
      default:
        this._hint = '';
    }
  }

  /* ── Hold / Tap handlers ────────────────────── */

  /**
   * Keyboard activation of the talk button. Listening otherwise starts on
   * pointerdown, which Enter/Space never produce — so a keyboard user could focus
   * the button and get nothing (WCAG 2.1.1). LionButton dispatches a click for
   * Enter and Space; a keyboard-generated click reports detail === 0, which is how
   * we tell it apart from the click that trails our own pointer sequence.
   */
  _onStartActivate(e) {
    if (e.detail !== 0) return;          // pointer-driven: already handled
    if (this.#sm.state !== 'idle') return;
    this.startListening('keyboard');
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.#hasIntent = true;

    if (this.mode === 'toggle' && this.#sm.state === 'idle') {
      this.startListening('tap-toggle');
      return;
    }

    if ((this.mode === 'auto' || this.mode === 'hold') && this.#sm.state === 'idle') {
      this.#listenTime = Date.now();
      const timer = setTimeout(() => {
        if (this.#hasIntent && this.#sm.state === 'idle') {
          this.startListening('hold-to-talk');
        }
      }, 240);
      this.#chunkTimers.push(timer);
    }
  }

  _onPointerUp(e) {
    if (!this.#hasIntent) return;
    // Only act if the pointer was down inside this component
    if (e.target?.assignedSlot?.parentNode?.getRootNode() !== this.shadowRoot
        && e.target.getRootNode?.() !== this.shadowRoot
        && !this.contains(e.target)) return;

    const held = Date.now() - this.#listenTime;
    const isTap = held < 240;

    if (isTap) {
      if (this.mode === 'auto') {
        // Defect 3 fix: auto mode — short tap toggles listening
        this.startListening('tap-toggle');
        this.#chunkTimers.forEach(clearTimeout);
        this.#chunkTimers = [];
      } else {
        // hold mode: sub-threshold tap is a cancelled hold
        this.#cleanupListen();
        this.#sm.transition('idle');
      }
    } else {
      // Held long enough — release in any mode
      this.releaseListening('hold-release');
    }

    this.#hasIntent = false;
  }

  /* ── Conversation flow ──────────────────────── */

  startListening(src) {
    if (this.#sm.state !== 'idle') return;
    this.#abortListen  = new AbortController();
    this.#abortTrans   = new AbortController();
    this.#abortThink   = new AbortController();
    this.#abortSpeak   = new AbortController();
    this.#listenSource = src;
    try { this.#sm.transition('listening'); } catch (_) { return; }

    // Actually open the mic. Without this the backend's startCapture() is never
    // invoked, so a real ASR adapter never records and a denied permission — the
    // most common real failure — could never surface as an error.
    if (this.backend?.startCapture) {
      Promise.resolve()
        .then(() => this.backend.startCapture())
        .catch(err => {
          if (this.#sm.state !== 'listening') return;  // already cancelled
          this.#cleanupListen();
          this._handleError(err);
        });
    }
  }

  releaseListening(src) {
    if (this.#sm.state !== 'listening') return;
    this.#cleanupListen();

    if (!this.backend) {
      this.#sm.transition('idle');
      return;
    }

    (async () => {
      try {
        const transcript = await this.backend.stopCapture();
        this.#sm.transcript = transcript;

        // NB: #abortListen is aborted and nulled by #cleanupListen() above — ending
        // listening is the normal path here, so it is not a reason to stop.
        if (this.#abortTrans?.signal.aborted !== false) return;

        const transSignal = this.#abortTrans?.signal;
        if (!transSignal) return;

        this.#sm.transition('transcribing');
        this._tx = transcript;

        if (transSignal.aborted) return;

        // Dwell so the user actually sees the transcribing state. Capture signal once:
        // a concurrent cancel nulls the controller, and dereferencing it again
        // mid-iteration would throw instead of aborting. The abortableSleep helper
        // races the timer against the signal so a cancel exits promptly.
        try {
          await abortableSleep(MIN_TRANSCRIBE_DWELL_MS, transSignal);
        } catch {
          return;  // aborted — don't fall through to thinking
        }

        if (transSignal.aborted) return;

        this.#sm.transition('thinking');

        // Capture the signal once: a concurrent cancel nulls the controller, and
        // dereferencing it again mid-iteration would throw instead of aborting.
        const speakSignal = this.#abortSpeak?.signal;
        if (!speakSignal) return;

        const answerChunks = [];
        let firstChunkDone = false;
        this.#streamDone = false;
        for await (const chunk of this.backend.ask(transcript, speakSignal)) {
          if (speakSignal.aborted) break;
          answerChunks.push(chunk);
          if (!firstChunkDone) {
            firstChunkDone = true;
            this._rp = chunk;
            this.#sm.transition('speaking');
            this._shown = chunk.split(/\s+/).filter(w => w.length > 0).length;
            this.requestUpdate();
          } else {
            // Append new words and update _shown to reflect arrived count
            this._rp += ' ' + chunk;
            const newWords = chunk.split(/\s+/).filter(w => w.length > 0).length;
            this._shown += newWords;
            this.requestUpdate();
          }
        }

        if (speakSignal.aborted) return;

        // Chunks are whole words with no trailing space (see MockBackend.chunkText):
        // joining with '' would render "Pro is $24per seatper month".
        const answer = answerChunks.join(' ');
        this.#sm.response = answer;
        // Finalise reveal count so complete === true and cursor fades.
        this._shown = Math.max(this._shown, answer.split(/\s+/).filter(w => w.length > 0).length);

        // Signal that streaming has finished so _renderSpeaking can show the cursor faded out.
        // For single-chunk backends the speak timer owns this transition; only mark done
        // here for multi-chunk streams (or empty responses) so the cursor fades after reveal.
        if (answerChunks.length !== 1) {
          this.#streamDone = true;
          this.requestUpdate();
        }

        if (this.backend.speak) {
          this.backend.speak(answer, speakSignal).catch(() => {});
        }

        // Fake timer only for single-chunk backends whose generator yielded once;
        // multi-chunk streams already drive the reveal in-place.
        if (answerChunks.length === 1) {
          this._startSpeakTimer(answer);
        }

      } catch (err) {
        if (err.name === 'AbortError' || err?.name === 'AbortError') {
          if (this.#sm.state === 'speaking' || this.#sm.state === 'thinking'
              || this.#sm.state === 'transcribing') {
            this.#sm.transition('idle');
          }
          return;
        }
        this._handleError(err);
      }
    })();
  }

  #cancelConversation(reason) {
    this.#stopSpeakTimer();
    this.#disposeAll();
    if (this.#sm.state !== 'idle') {
      this.#sm.transition('idle');
    }
  }

  _handleError(err) {
    let reason = 'unknown';
    if (err?.reason) {
      reason = err.reason;
    } else {
      const msg = (err?.message ?? '').toLowerCase();
      if (msg.includes('permission') || msg.includes('denied') || msg.includes('not-allowed')) {
        reason = 'mic-permission-denied';
      } else if (msg.includes('not-found') || msg.includes('no-speech')) {
        reason = 'no-speech-detected';
      } else if (msg.includes('offline') || msg.includes('network')) {
        reason = 'offline';
      } else if (msg.includes('backend')) {
        reason = 'backend-failure';
      }
    }
    this.#sm.transition('error', { reason, error: err });
  }

  /* ── Speak timer (Fix 7: ~400 ms/word) ─────── */

  /**
   * Reveal the answer at roughly speech pace (~400ms/word == ~150wpm). The mockup
   * used 46ms/word (~1300wpm), about 8x faster than anyone actually speaks, which
   * left the Stop button reachable for barely a second.
   */
  _startSpeakTimer(text) {
    this.#stopSpeakTimer();
    this._shown = 0;
    if (!text) return;

    const total = text.split(/\s+/).length;
    this.#speakTimer = setInterval(() => {
      if (this.#sm.state !== 'speaking') {
        this.#stopSpeakTimer();
        return;
      }
      this._shown = Math.min(this._shown + 1, total);
      // The `_shown = 0` class field shadows Lit's reactive accessor, so assigning
      // it does not schedule an update on its own. Ask for one explicitly.
      this.requestUpdate();
      if (this._shown >= total) {
        this.#stopSpeakTimer();
        // Mark streaming done so the cursor fades in _renderSpeaking.
        this.#streamDone = true;
        // Announce the finished answer once, rather than per revealed word.
        this._label = `${STATE_LABELS.speaking}. ${text}`;
      }
    }, 400);
  }

  #stopSpeakTimer() {
    if (this.#speakTimer) {
      clearInterval(this.#speakTimer);
      this.#speakTimer = null;
    }
  }

  /* ── Cleanup ────────────────────────────────── */

  #disposeAll() {
    this.#stopSpeakTimer();
    this.#chunkTimers.forEach(clearTimeout);
    this.#chunkTimers = [];
    this.#hasIntent = false;

    if (this.#abortListen) { this.#abortListen.abort(); this.#abortListen = null; }
    if (this.#abortTrans) { this.#abortTrans.abort();   this.#abortTrans   = null; }
    if (this.#abortThink) { this.#abortThink.abort();   this.#abortThink   = null; }
    if (this.#abortSpeak) { this.#abortSpeak.abort();   this.#abortSpeak   = null; }

    if (this.#waveAnimId) {
      cancelAnimationFrame(this.#waveAnimId);
      this.#waveAnimId = null;
    }

    this.#isListening = false;
  }

  #cleanupListen() {
    if (this.#abortListen) { this.#abortListen.abort(); this.#abortListen = null; }
    this.#chunkTimers.forEach(clearTimeout);
    this.#chunkTimers = [];
    this.#hasIntent = false;
  }

  /* ── Button handlers ────────────────────────── */

  _onBtnClick(ev) {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');

    switch (action) {
      case 'stop':
        this._stopSpeaking();
        break;
      case 'retry':
        this.hide('retry');
        setTimeout(() => this.show(), 300);
        break;
      case 'start':
        if (this.#sm.state === 'idle') this.startListening('button-start');
        break;
    }
  }

  _onCloseClick() {
    this.hide('user closed');
  }

  _onRetryClick() {
    if (this.#sm.state !== 'error') return;
    this.#sm.transition('idle');
    this._tx = '';
    this._rp = '';
    this._shown = 0;
    this.requestUpdate();
  }

  _onStopClick() {
    this._stopSpeaking();
  }

  _onAskAnotherClick() {
    if (this.#sm.state !== 'speaking') return;
    this.#sm.transition('idle');
    this._tx = '';
    this._rp = '';
    this._shown = 0;
    this.#streamDone = false;
    this.requestUpdate();
  }

  _stopSpeaking() {
    this.#stopSpeakTimer();
    if (this.#abortSpeak) {
      this.#abortSpeak.abort();
      this.#abortSpeak = null;
    }
    if (this.#sm.state === 'speaking') {
      this.#sm.transition('idle');
    }
  }

  /** Tap-started listening: stop capture and send */
  /**
   * Tap-started listening ends via this button ("Stop & Send"). The conversation
   * that follows is identical to a hold-release, so delegate rather than duplicate:
   * an earlier copy of this pipeline drifted out of sync and crashed on a nulled
   * AbortController.
   */
  async _onTapStopClick() {
    this.releaseListening('tap-stop');
  }

  /* ── Escape key handler (Defect 6) ──────────── */

  _onKeydown(e) {
    if (e.key === 'Escape' && this.open) {
      e.preventDefault();
      this.#cancelConversation('escaped');
    }
  }

  /* ── Template ───────────────────────────────── */

  render() {
    const s = this.#sm.state;
    return html`
      <lion-button class="close-btn" @click=${this._onCloseClick} aria-label="Collapse to floating icon">✕</lion-button>
      <div class="view-wrapper">
        ${this._renderView(s)}
      </div>
      <div class="hintline hintline-bottom">${this._hint}</div>
      <div role="status" aria-live="polite" class="tw-sr-only">${this._label}</div>
    `;
  }

  _renderView(s) {
    switch (s) {
      case 'idle':
        return this._renderIdle();
      case 'listening':
        return this._renderListening();
      case 'transcribing':
        return this._renderTranscribing();
      case 'thinking':
        return this._renderThinking();
      case 'speaking':
        return this._renderSpeaking();
      case 'error':
        return this._renderError();
      default:
        return html``;
    }
  }

  _renderIdle() {
    return html`
      <div class="view center-layout">
        <div class="eyebrow"><span class="dot"></span>Product Expert</div>
        <h2 class="big" aria-hidden="true">Have a&nbsp;question?</h2>
        <lion-button class="btn-primary" id="startBtn" data-action="start"
            @click=${this._onStartActivate}
            style="--talkie-state:${this._getStateColor()}">
          ${iconMic()} Hold&nbsp;to&nbsp;Talk
        </lion-button>
        <p class="sub">Ask about features, pricing, integrations, or compatibility.</p>
      </div>`;
  }

  _renderListening() {
    // Show stop button only when listening began via tap (toggle or auto-tap)
    const isTap = this.#listenSource === 'tap-toggle';
    return html`
      <div class="center-layout">
        <h2 class="status-text" aria-hidden="true">Listening…</h2>
        <talkie-waveform .enabled=${true} .color="${this._getStateColor()}"></talkie-waveform>
        ${isTap
          ? html`<lion-button class="btn-stop" @click=${this._onTapStopClick}>
              <span class="sq"></span>Stop &amp; Send
            </lion-button>`
          : html`<p class="hintline">Release to send</p>`}
      </div>`;
  }

  _renderTranscribing() {
    return html`
      <div class="center-layout">
        <div class="arc" aria-hidden="true"></div>
        <h2 class="status-text" aria-hidden="true">Understanding…</h2>
        ${this._tx ? html`<talkie-transcript .text=${this._tx}></talkie-transcript>` : ''}
      </div>`;
  }

  _renderThinking() {
    return html`
      <div class="center-layout">
        <h2 class="status-text" aria-hidden="true">Finding the right answer…</h2>
        ${this._tx ? html`<talkie-transcript .text=${this._tx}></talkie-transcript>` : ''}
        <div class="dots3" aria-hidden="true"><span></span><span></span><span></span></div>
      </div>`;
  }

  _renderSpeaking() {
    const answer = this._rp ?? '';
    const words = answer.split(/\s+/);
    const displayText = words.slice(0, this._shown).join(' ');
    // Cursor is visible while streaming; it fades once the generator finishes.
    const complete = this.#streamDone;

    return html`
      <div class="view">
        <div class="eyebrow">
          <span class="dot"></span>Product Expert
          <span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        </div>
        ${this._tx ? html`<talkie-transcript .text=${this._tx}></talkie-transcript>` : ''}
        <p class="resp-area">
          ${displayText}${complete ? '' : html`<span class="cursor-cursor"></span>`}
        </p>
        ${complete
          ? html`<lion-button class="btn-primary ghost" id="askAnotherBtn" data-action="ask-another" @click=${this._onAskAnotherClick}>Ask another</lion-button>`
          : html`<lion-button class="btn-stop" id="stopBtn" data-action="stop" @click=${this._onStopClick}>
              <span class="sq"></span>Stop
            </lion-button>`}
      </div>`;
  }

  _renderError() {
    const msg = ERROR_MESSAGES[this.#sm.errorReason] ?? ERROR_MESSAGES.unknown;
    return html`
      <div class="center-layout">
        <div class="err-icon" aria-hidden="true">!</div>
        <h2 class="status-text">${msg.title}</h2>
        <p class="sub">${msg.sub}</p>
        <lion-button class="btn-primary ghost" id="retryBtn" data-action="retry"
            @click=${this._onRetryClick}>Try again</lion-button>
      </div>`;
  }

  /* ── Utility ────────────────────────────────── */

  _getStateColor() {
    const map = {
      idle:         '#5fd9c6',
      listening:    '#ff8a4c',
      transcribing: '#ffc96b',
      thinking:     '#7fb5ff',
      speaking:     '#8be28b',
      error:        '#ff6b6b',
    };
    return map[this.#sm.state] ?? '#8aa39e';
  }
}
