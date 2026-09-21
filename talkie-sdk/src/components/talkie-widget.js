import { css, html } from 'lit';
import { ScopedElementsMixin } from '@open-wc/scoped-elements';
import { svg } from 'lit-html';
import { LionButton } from '@lion/ui/button.js';
import { LitElement } from 'lit';
import { TalkieTranscript } from './talkie-transcript.js';
import { TalkieWaveform } from './talkie-waveform.js';
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

/** mm:ss for the recording clock. */
function formatElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Human-readable error messages keyed on state-machine reason values. */
const ERROR_MESSAGES = /** @type {Record<string,{title:string;sub:string}>} */ ({
  'mic-permission-denied': {
    title: 'Microphone access is blocked.',
    sub: 'Allow microphone access in your browser settings, then try again.',
  },
  'no-speech-detected': {
    title: "I didn't catch that.",
    sub: 'Press Start, say your question, then press Stop to send.',
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
  /** @type {NodeJS.Timeout[]} Timers scheduled for the current listening turn */
  #chunkTimers = [];
  /** @type {NodeJS.Timeout|null} Interval that ticks the recording clock */
  #elapsedTimer = null;
  /** @type {number} Timestamp recording started, for the elapsed clock */
  #startedAt = 0;
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
    open:   { type: Boolean, reflect: true },
    state:  { type: String, reflect: true },
    _tx:    { type: String, state: true },
    _rp:    { type: String, state: true },
    _hint:  { type: String, state: true },
    _label: { type: String, state: true },
    // Number of answer words revealed so far. Must be reactive: the reveal timer
    // advances it and the speaking view re-renders from it.
    _shown: { type: Number, state: true },
    // Seconds recorded so far. Reactive so the clock in the listening view ticks.
    _elapsed: { type: Number, state: true },
  };

  static get scopedElements() {
    // talkie-waveform belongs here too: without a scoped registration the tag in
    // the recording view stays an un-upgraded HTMLElement, collapses to zero
    // height, and the recording view shows no motion at all.
    return {
      'lion-button': LionButton,
      'talkie-transcript': TalkieTranscript,
      'talkie-waveform': TalkieWaveform,
    };
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
      /* A full sentence, so body type at normal spacing: the tracked monospace that suits
         the short uppercase eyebrow spread these hints out letter by letter. */
      .hintline {
        font-family: var(--talkie-font-body, 'Instrument Sans', sans-serif);
        font-size: 12.5px;
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
      /* Icon spacing is a margin, not a gap on the button: LionButton slots its children
         into its own shadow flex box, which a gap on the host never reaches. */
      .btn-primary svg {
        flex-shrink: 0;
        margin-right: 10px;
      }
      .btn-primary:hover { transform: translateY(-2px); }
      .btn-primary:active { transform: scale(.96); }
      .btn-stop {
        display: inline-flex;
        align-items: center;
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
      .rec-clock {
        display: inline-block;
        margin-left: 10px;
        font-variant-numeric: tabular-nums;
        font-size: 20px;
        font-weight: 600;
        opacity: .55;
      }
      .link-btn {
        /* No margin: .center-layout's gap already spaces it, and any extra pushes
           the column into the absolutely positioned hint line at the bottom. */
        background: none;
        border: 1.5px solid rgba(16, 29, 32, .28);
        border-radius: 999px;
        padding: 7px 18px;
        font-family: var(--talkie-font-display, 'Space Grotesk', sans-serif);
        font-weight: 600;
        font-size: 14px;
        color: var(--talkie-ink, #101d20);
        cursor: pointer;
        transition: border-color .15s, background .15s;
      }
      .link-btn:hover {
        border-color: var(--talkie-ink, #101d20);
        background: rgba(16, 29, 32, .05);
      }
      .link-btn:focus-visible {
        outline: 2px solid var(--talkie-ink, #101d20);
        outline-offset: 2px;
      }
      .btn-stop .sq {
        flex-shrink: 0;
        margin-right: 10px;
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
    this.open    = false;
    /** @type {number} Seconds recorded so far */
    this._elapsed = 0;
    /** @type {string} Reflective read-only — synced from state machine */
    this.state   = '';

    this.#sm = new StateMachine();

    this._onSmChange   = this._onSmChange.bind(this);
    this._onStartActivate = this._onStartActivate.bind(this);
    this._onBtnClick    = this._onBtnClick.bind(this);
    this._onCloseClick  = this._onCloseClick.bind(this);
    this._onRetryClick  = this._onRetryClick.bind(this);
    this._onStopClick   = this._onStopClick.bind(this);
    this._onAskAnotherClick = this._onAskAnotherClick.bind(this);
    this._onStopSendClick = this._onStopSendClick.bind(this);
    this._onCancelRecordingClick = this._onCancelRecordingClick.bind(this);
    this._onKeydown     = this._onKeydown.bind(this);

    this.#sm.onChange(this._onSmChange);
    // Init from machine so state is correct before any transition fires
    this.state = this.#sm.state;
    this._syncLabel();
    this._syncHint();
  }

  connectedCallback() {
    super.connectedCallback();
    // Document-level, not host-level: once recording starts the button that had
    // focus is replaced, focus falls back to <body>, and a host listener would
    // never see the key that is supposed to stop the recording. Every handler
    // below is gated on `this.open`, so a closed widget swallows nothing.
    document.addEventListener('keydown', this._onKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this._onKeydown);
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
        this._hint = 'Press Start or the space bar to record';
        break;
      case 'listening':
        this._hint = 'Space sends · Esc discards';
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

  /* ── Start / Stop handlers ──────────────────── */

  /**
   * Start recording. Bound to the idle button's click, which covers pointer,
   * touch and the keyboard (LionButton turns Enter and Space into a click), so
   * every input path lands here (WCAG 2.1.1).
   */
  _onStartActivate() {
    if (this.#sm.state !== 'idle') return;
    this.startListening('button-start');
  }

  /** Stop recording and send what was captured. */
  _onStopSendClick() {
    this.releaseListening('button-stop');
  }

  /** Discard the recording without sending it. */
  _onCancelRecordingClick() {
    if (this.#sm.state !== 'listening') return;
    this.#cancelConversation('recording discarded');
  }

  /**
   * Space bar is a shortcut for the on-screen button: press to start, press
   * again to stop and send. Skipped when the press originates on a button,
   * which already turns Space into a click of its own.
   */
  _onSpaceToggle(e) {
    const origin = e.composedPath?.()[0];
    if (origin && origin !== this) {
      // A button already turns Space into a click of its own, and a text field
      // needs the space character far more than we need the shortcut.
      if (origin.closest?.('lion-button, button, [role="button"], input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    }
    e.preventDefault();
    if (this.#sm.state === 'idle') this.startListening('space-start');
    else if (this.#sm.state === 'listening') this.releaseListening('space-stop');
    // Space is the primary action key, so while an answer is playing it does what
    // the on-screen Stop button does: cut the audio short. Pressing it once more
    // then starts the next recording.
    else if (this.#sm.state === 'speaking') this._stopSpeaking();
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
    this.#startElapsedTimer();

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

        // A backend that streams its audio can be heard long before its text exists — the
        // voice agent only sends the text once the whole reply has been spoken. Waiting for
        // text would leave the panel on "Finding the right answer…" while the answer plays.
        // So move to speaking on whichever comes first: the audio, or the first text chunk.
        let heardFirst = false;
        if (typeof this.backend.speechStarted === 'function') {
          this.backend.speechStarted(speakSignal).then(() => {
            if (speakSignal.aborted || this.#sm.state !== 'thinking') return;
            heardFirst = true;
            this._rp = '';
            this._shown = 0;
            this.#sm.transition('speaking');
            this.requestUpdate();
          }).catch(() => { /* aborted with the turn; the ask() path unwinds it */ });
        }

        for await (const chunk of this.backend.ask(transcript, speakSignal)) {
          if (speakSignal.aborted) break;
          answerChunks.push(chunk);
          if (!firstChunkDone) {
            firstChunkDone = true;
            this._rp = chunk;
            if (this.#sm.state === 'thinking') this.#sm.transition('speaking');
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

        if (heardFirst) {
          // The audio started first, so by now it has been playing for about as long as the
          // answer takes to say. Pacing the words out at 400 ms each from here would trail
          // the voice by the whole answer; show them all at once instead.
          this._shown = answer.split(/\s+/).filter(w => w.length > 0).length;
          this.#streamDone = true;
          this._label = `${STATE_LABELS.speaking}. ${answer}`;
          this.requestUpdate();
        } else if (answerChunks.length === 1) {
          // Fake timer only for single-chunk backends whose generator yielded once;
          // multi-chunk streams already drive the reveal in-place.
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
    // Abandoning a recording still has to close the mic and the ASR socket; the
    // abort controllers below only unwind this component's own work. The
    // transcript is deliberately discarded.
    if (this.#sm.state === 'listening' && this.backend?.stopCapture) {
      Promise.resolve().then(() => this.backend.stopCapture()).catch(() => {});
    }
    this.#disposeAll();
    if (this.#sm.state !== 'idle') {
      this.#sm.transition('idle');
    }
  }

  _handleError(err) {
    // A failed turn usually produces several rejections — the mic, the socket and
    // the in-flight fetch all unwind — and the state machine has no error→error
    // edge, so a second call used to throw "Illegal transition error→error". That
    // exception replaced the real reason in the console with a useless one. The
    // first error is the cause; the rest are its wake, so keep the first.
    if (this.#sm.state === 'error') return;

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
    this.#stopElapsedTimer();

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
    this.#stopElapsedTimer();
  }

  /** Tick the recording clock once a second while capture is live. */
  #startElapsedTimer() {
    this.#stopElapsedTimer();
    this.#startedAt = Date.now();
    this._elapsed = 0;
    this.#elapsedTimer = setInterval(() => {
      this._elapsed = (Date.now() - this.#startedAt) / 1000;
    }, 250);
  }

  #stopElapsedTimer() {
    if (this.#elapsedTimer) {
      clearInterval(this.#elapsedTimer);
      this.#elapsedTimer = null;
    }
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
    // The answer text finishes revealing before the audio finishes playing, so
    // this button is on screen while speak() is still running. Go through
    // _stopSpeaking() rather than transitioning straight to idle: it aborts the
    // speak signal, which is what actually pauses the audio element in the
    // backend. Without it the previous answer kept talking over the next question.
    this._stopSpeaking();
    this._tx = '';
    this._rp = '';
    this._shown = 0;
    this.#streamDone = false;
    this.requestUpdate();
    // The caller already said they have another question; making them press Start
    // again is a wasted step. _stopSpeaking() leaves the machine in idle, which is
    // the only state startListening() accepts.
    this.startListening('button-ask-another');
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

  /* ── Escape key handler (Defect 6) ──────────── */

  _onKeydown(e) {
    if (!this.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.#cancelConversation('escaped');
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      this._onSpaceToggle(e);
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
          ${iconMic()} Start&nbsp;Recording
        </lion-button>
        <p class="sub">Ask about features, pricing, integrations, or compatibility.</p>
      </div>`;
  }

  _renderListening() {
    return html`
      <div class="center-layout">
        <h2 class="status-text" aria-hidden="true">
          Recording<span class="rec-clock">${formatElapsed(this._elapsed)}</span>
        </h2>
        <talkie-waveform .enabled=${true} .color="${this._getStateColor()}"></talkie-waveform>
        <lion-button class="btn-stop" id="stopSendBtn" data-action="stop-send" @click=${this._onStopSendClick}>
          <span class="sq"></span>Stop &amp; Send
        </lion-button>
        <button type="button" class="link-btn" @click=${this._onCancelRecordingClick}>Discard</button>
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
