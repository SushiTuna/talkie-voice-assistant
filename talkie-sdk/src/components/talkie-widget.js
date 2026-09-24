import { css, html, unsafeCSS } from 'lit';
import { ScopedElementsMixin } from '@open-wc/scoped-elements';
import { svg } from 'lit-html';
import { LionButton } from '@lion/ui/button.js';
import { LitElement } from 'lit';
import { TalkieTranscript } from './talkie-transcript.js';
import { TalkieWaveform } from './talkie-waveform.js';
import { StateMachine } from '../core/state-machine.js';
import { STATE_COLORS, NEUTRAL_STATE_COLOR, stateColor } from '../core/state-colors.js';

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

function iconMic(size = 17) {
  return svg`<svg width=${size} height=${size} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="2" width="6" height="11" rx="3"/>
    <path d="M5 10v2a7 7 0 0 0 14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="22"/>
  </svg>`;
}

function iconMinimize() {
  return svg`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
    <line x1="6" y1="18" x2="18" y2="18"/>
  </svg>`;
}

function iconClose() {
  return svg`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18"/>
  </svg>`;
}

/** Default copy for the `heading` and `subtitle` attributes. */
const DEFAULT_HEADING = 'Product Expert';
const DEFAULT_SUBTITLE = 'Ask about features, pricing, integrations, or compatibility.';

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
  /** @type {AbortController|null} The running conversation (conversation mode) */
  #abortConv = null;
  /** @type {boolean} The last conversation ended itself for silence (idle view copy) */
  #endedForSilence = false;
  /** @type {boolean} The no-converse fallback has been reported once */
  #warnedNoConverse = false;

  static properties = {
    backend: { type: Object },
    open:   { type: Boolean, reflect: true },
    // Open but tucked away: the panel is hidden and the conversation keeps running. The
    // launcher stands in for it (talkie-assistant.js). restore() brings the panel back.
    minimized: { type: Boolean, reflect: true },
    // 'sheet': a full-width bottom sheet, for phones. Set by <talkie-assistant>; unset is the
    // floating panel.
    layout: { type: String, reflect: true },
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
    // 'push-to-talk' (Start / Stop & Send) or 'conversation' (mic stays open, the backend's
    // turn detection runs the exchange). Conversation needs a backend with converse().
    mode: { type: String, reflect: true },
    // Conversation mode: seconds of silence before the conversation ends itself; 0 = never.
    idleTimeout: { type: Number, attribute: 'idle-timeout' },
    // Conversation mode: live caption of what the caller is saying.
    _partial: { type: String, state: true },
    // Panel copy: the eyebrow in the top bar, and the line under "Have a question?" on the
    // Start screen. Not `title`: that is a global attribute, and the browser would show it as
    // a tooltip over the whole panel. useDefault: the defaults are not written out as
    // attributes, and removing an attribute brings its default back.
    heading:  { type: String, reflect: true, useDefault: true },
    subtitle: { type: String, reflect: true, useDefault: true },
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
    // One rule per state sets --_state from the shared table; a page's --talkie-state wins.
    const stateRules = Object.entries(STATE_COLORS)
      .map(([state, color]) => `:host([state='${state}']) { --_state: var(--talkie-state, ${color}); }`)
      .join('\n');
    return css`
      /* Private tokens. Each public --talkie-* token is read once, here; everything below
         uses these, and the tints derive from the ink so a dark theme gets light lines.
         The fallbacks follow the host page's color-scheme (light-dark()), so the panel is dark
         on a page that declares a dark scheme and stays light on one that declares none. */
      :host {
        --_ink: var(--talkie-ink, light-dark(#101d20, #eceeef));
        --_ink-soft: var(--talkie-ink-soft, light-dark(#4a5a58, #a3abad));
        --_paper: var(--talkie-paper, light-dark(#f7f5ec, #16191b));
        /* Text on the ink-filled buttons. Falls back to the paper, so a theme that swaps paper
           and ink (README's dark example) keeps those labels readable. */
        --_surface: var(--talkie-surface, var(--_paper));
        --_display: var(--talkie-font-display, 'Space Grotesk', sans-serif);
        --_body: var(--talkie-font-body, 'Instrument Sans', sans-serif);
        --_mono: var(--talkie-font-mono, monospace);
        --_line: color-mix(in srgb, var(--_ink) 12%, transparent);
        --_tint: color-mix(in srgb, var(--_ink) 6%, transparent);
        --_state: var(--talkie-state, ${unsafeCSS(NEUTRAL_STATE_COLOR)});
        --_stop: ${unsafeCSS(STATE_COLORS.error)};
        --_ease: cubic-bezier(.2, .8, .2, 1);
      }
      ${unsafeCSS(stateRules)}

      /* ── Panel ── */
      :host {
        display: flex;
        flex-direction: column;
        position: relative;
        width: min(430px, 100%);
        min-height: 330px;
        font-family: var(--_body);
        background: var(--_paper);
        color: var(--_ink);
        border-radius: 24px;
        /* padding is on .view-wrapper — an outer-document reset like '* { padding: 0 }' overrides
           :host rules (the host element is matched by '*' in the light DOM), so host padding is
           not reliable in a distributable component. */
        box-shadow: 0 28px 70px -24px rgba(0, 0, 0, .55),
                    0 0 0 1px var(--_line),
                    0 0 64px -22px var(--_state);
        transition: box-shadow .4s, opacity .35s ease, transform .35s var(--_ease);
      }
      :host(:not([open])),
      :host([minimized]) {
        opacity: 0;
        transform: translateY(18px) scale(.92);
        pointer-events: none;
        visibility: hidden;
        transition: box-shadow .4s, opacity .35s ease, transform .35s var(--_ease), visibility 0s .35s;
      }
      /* Minimizing shrinks toward the launcher in the corner. */
      :host([minimized]) {
        transform-origin: 100% 100%;
        transform: translateY(40px) scale(.2);
      }

      /* ── Top bar: who you are talking to, its state, and the window controls ── */
      .bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 14px 0 22px;
      }
      .eyebrow {
        display: flex;
        align-items: center;
        gap: 9px;
        font-family: var(--_mono);
        font-size: 11px;
        letter-spacing: 2px;
        text-transform: uppercase;
        color: var(--_ink-soft);
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--_state);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--_state) 22%, transparent);
        animation: twk-pulse 1.8s infinite;
      }
      .bar-actions {
        display: flex;
        gap: 6px;
      }
      .icon-btn {
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: var(--_tint);
        color: var(--_ink-soft);
        cursor: pointer;
        transition: background .2s, color .2s, transform .2s var(--_ease);
      }
      .icon-btn:hover {
        background: var(--_ink);
        color: var(--_surface);
      }
      .close-btn:hover { transform: rotate(90deg); }

      /* Padding is here, not on :host, so an outer-document reset like '* { padding: 0 }' can't
         strip it away — the host element itself is matched by '*' in the light DOM. */
      .view-wrapper {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 22px 32px 18px;
      }

      /* A full sentence, so body type at normal spacing: the tracked monospace that suits
         the short uppercase eyebrow spread these hints out letter by letter. In the flow, not
         pinned to the bottom, so a tall view can never run into it. */
      .hintline {
        margin: 0;
        padding: 0 24px 16px;
        min-height: 1.5em;
        font-family: var(--_body);
        font-size: 12.5px;
        text-align: center;
        color: var(--_ink-soft);
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

      /* ── Type ── */
      .big {
        margin: 2px 0 4px;
        font-family: var(--_display);
        font-weight: 700;
        font-size: clamp(24px, 3.2vw, 30px);
        letter-spacing: -.02em;
        line-height: 1.15;
        text-wrap: balance;
      }
      .sub {
        margin: 0;
        max-width: 34ch;
        font-size: 14px;
        line-height: 1.6;
        color: var(--_ink-soft);
      }
      .status-text {
        margin: 0;
        font-family: var(--_display);
        font-weight: 700;
        font-size: 25px;
        letter-spacing: -.02em;
      }
      .rec-clock {
        display: inline-block;
        margin-left: 10px;
        padding: 3px 9px;
        border-radius: 999px;
        background: var(--_tint);
        color: var(--_ink-soft);
        font-family: var(--_mono);
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
        vertical-align: 4px;
        font-variant-numeric: tabular-nums;
      }

      /* ── Buttons ──
         lion-button and button share one base; the classes after it only change colour and
         size. Icon spacing is a margin, not a gap on the button: LionButton slots its children
         into its own shadow flex box, which a gap on the host never reaches. */
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: 999px;
        font-family: var(--_display);
        font-weight: 600;
        cursor: pointer;
        touch-action: manipulation;
        user-select: none;
        transition: transform .15s var(--_ease), box-shadow .25s, background .2s, color .2s;
      }
      .btn:active { transform: scale(.97); }
      .btn-primary,
      .btn-stop {
        background: var(--_ink);
        color: var(--_surface);
      }
      .btn-primary {
        padding: 15px 28px;
        font-size: 16px;
        box-shadow: 0 10px 26px -12px var(--_state);
      }
      .btn-primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 30px -10px var(--_state),
                    0 0 0 4px color-mix(in srgb, var(--_state) 28%, transparent);
      }
      .btn-primary svg {
        flex-shrink: 0;
        margin-right: 10px;
      }
      .btn-stop {
        padding: 13px 26px;
        font-size: 14.5px;
      }
      .btn-stop .sq {
        flex-shrink: 0;
        margin-right: 10px;
        width: 9px;
        height: 9px;
        border-radius: 2px;
        background: var(--_stop);
      }
      .btn-secondary {
        padding: 12px 24px;
        font-size: 14px;
        background: transparent;
        color: var(--_ink);
        box-shadow: inset 0 0 0 1.5px var(--_ink);
      }
      .btn-secondary:hover {
        background: var(--_ink);
        color: var(--_surface);
      }
      .link-btn {
        /* No margin: the layout's gap already spaces it. */
        padding: 7px 18px;
        border: 1.5px solid color-mix(in srgb, var(--_ink) 28%, transparent);
        border-radius: 999px;
        background: none;
        font-family: var(--_display);
        font-weight: 600;
        font-size: 14px;
        color: var(--_ink);
        cursor: pointer;
        transition: border-color .15s, background .15s;
      }
      .link-btn:hover {
        border-color: var(--_ink);
        background: var(--_tint);
      }
      /* Leaving a hands-free call: the coral stop mark says "this ends it" before the words do. */
      .end-btn {
        display: inline-flex;
        align-items: center;
        padding: 6px 18px 6px 6px;
        border: 0;
        border-radius: 999px;
        background: var(--_tint);
        font-family: var(--_display);
        font-weight: 600;
        font-size: 14px;
        color: var(--_ink);
        cursor: pointer;
        transition: background .15s;
      }
      .end-btn svg {
        flex-shrink: 0;
        box-sizing: border-box;
        width: 28px;
        height: 28px;
        margin-right: 10px;
        padding: 7px;
        border-radius: 50%;
        background: var(--_stop);
        /* Dark on the coral, as on .err-icon: white on it is under 3:1. */
        color: #2a0b0b;
      }
      .end-btn:hover {
        background: color-mix(in srgb, var(--_ink) 12%, transparent);
      }
      lion-button:focus-visible,
      button:focus-visible {
        outline: 2px solid var(--_ink);
        outline-offset: 3px;
      }

      /* ── Views ── */
      .view {
        animation: twk-rise .34s var(--_ease) both;
      }
      .center-layout {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 14px;
      }
      /* The speaking view reads like a chat: the caller's words on the right, the answer below. */
      .answer-layout {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 14px;
      }
      .answer-layout talkie-transcript { align-self: flex-end; }
      .answer-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }

      /* One mark for the whole turn: the state colour as a lit orb. Idle holds the mic;
         transcribing sweeps a ring around it; thinking breathes. Same size and place in every
         view, so a turn reads as one object changing colour, not a new icon per state. */
      .orb {
        position: relative;
        display: grid;
        place-items: center;
        width: 60px;
        height: 60px;
        border-radius: 50%;
        color: #06231f;
        background: radial-gradient(circle at 32% 28%, color-mix(in srgb, var(--_state) 45%, #fff), var(--_state) 70%);
        box-shadow: 0 0 0 8px color-mix(in srgb, var(--_state) 16%, transparent),
                    0 14px 30px -10px var(--_state);
      }
      .orb-busy::after {
        content: '';
        position: absolute;
        inset: -9px;
        border-radius: 50%;
        background: conic-gradient(from 0deg, transparent 0 62%, var(--_state));
        -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
        mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
        animation: twk-spin 1s linear infinite;
      }
      .orb-think {
        animation: twk-breathe 1.6s ease-in-out infinite;
      }
      .eq {
        display: inline-flex;
        gap: 3px;
        align-items: flex-end;
        height: 12px;
        margin-left: 2px;
      }
      .eq i {
        width: 3px;
        height: 100%;
        border-radius: 2px;
        background: var(--_state);
        transform-origin: bottom;
        animation: twk-eq .9s ease-in-out infinite;
      }
      .eq i:nth-child(2) { animation-delay: .15s; }
      .eq i:nth-child(3) { animation-delay: .3s; }
      .eq i:nth-child(4) { animation-delay: .45s; }
      .eq i:nth-child(5) { animation-delay: .6s; }
      .err-icon {
        display: grid;
        place-items: center;
        width: 46px;
        height: 46px;
        border-radius: 50%;
        background: var(--_stop);
        /* Dark on the coral: white on it is under 3:1. */
        color: #2a0b0b;
        font-family: var(--_display);
        font-weight: 700;
        font-size: 24px;
        box-shadow: 0 0 0 8px color-mix(in srgb, var(--_stop) 20%, transparent);
      }
      /* Capped, and scrolled to the newest words as they stream (updated()), so a long reply
         can't push the panel past the top of the viewport. */
      .resp-area {
        align-self: stretch;
        margin: 0;
        min-height: 96px;
        max-height: min(38vh, 320px);
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        font-size: 19px;
        line-height: 1.55;
        letter-spacing: -.005em;
        color: var(--_ink);
      }
      /* Once older words scroll off the top, fade that edge rather than cutting a line in half. */
      .resp-area.scrolled {
        -webkit-mask-image: linear-gradient(to bottom, transparent, #000 2.4em);
        mask-image: linear-gradient(to bottom, transparent, #000 2.4em);
      }
      talkie-waveform { width: 100%; }
      .cursor-cursor {
        display: inline-block;
        width: 2px;
        height: 1em;
        margin-left: 2px;
        vertical-align: -2px;
        background: var(--_state);
        animation: twk-blinkC 1s steps(1) infinite;
      }

      /* ── Animations ── */
      @keyframes twk-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: .4; }
      }
      @keyframes twk-rise {
        from { opacity: 0; transform: translateY(10px); }
        to   { opacity: 1; transform: none; }
      }
      @keyframes twk-spin { to { transform: rotate(360deg); } }
      @keyframes twk-breathe {
        0%, 100% { transform: scale(1); }
        50% {
          transform: scale(1.08);
          box-shadow: 0 0 0 14px color-mix(in srgb, var(--_state) 10%, transparent),
                      0 14px 34px -8px var(--_state);
        }
      }
      @keyframes twk-eq {
        0%, 100% { transform: scaleY(.25); }
        50%      { transform: scaleY(1); }
      }
      @keyframes twk-blinkC { 50% { opacity: 0; } }

      /* The waveform draws a static field on its own; this stills everything else. The state
         still shows: the colour changes, and the spinner and dots stay as marks. */
      @media (prefers-reduced-motion: reduce) {
        :host, :host(:not([open])), :host([minimized]) { transition-duration: 0s !important; }
        .view, .dot, .orb-busy::after, .orb-think, .eq i, .cursor-cursor { animation: none; }
        .btn, .icon-btn { transition: none; }
        .btn:active, .btn-primary:hover, .close-btn:hover { transform: none; }
      }

      /* ── Bottom sheet (layout="sheet", phones) ──
         Full width along the bottom edge, the page still visible above it; slides down out of
         the way when minimized or closed. */
      :host([layout='sheet']) {
        width: 100%;
        min-height: 0;
        max-height: min(62dvh, 520px);
        overflow-y: auto;
        overscroll-behavior: contain;
        border-radius: 24px 24px 0 0;
        box-shadow: 0 -18px 50px -18px rgba(0, 0, 0, .5),
                    0 0 0 1px var(--_line),
                    0 -8px 50px -22px var(--_state);
      }
      :host([layout='sheet']:not([open])),
      :host([layout='sheet'][minimized]) {
        opacity: 1;
        transform: translateY(calc(100% + 24px));
        transition: transform .32s cubic-bezier(.4, 0, .2, 1), visibility 0s .32s;
      }
      :host([layout='sheet']) .bar { padding: 18px 12px 0 20px; }
      :host([layout='sheet']) .view-wrapper { padding: 16px 20px 14px; }
      :host([layout='sheet']) .hintline { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
      .grabber { display: none; }
      :host([layout='sheet']) .grabber {
        display: block;
        position: absolute;
        top: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 88px;
        height: 22px;
        padding: 0;
        border: 0;
        background: none;
        cursor: pointer;
      }
      :host([layout='sheet']) .grabber::before {
        content: '';
        position: absolute;
        top: 8px;
        left: 26px;
        right: 26px;
        height: 5px;
        border-radius: 3px;
        background: color-mix(in srgb, var(--_ink) 22%, transparent);
      }

      /* Phones: a compact panel. The desktop spacing and type fill most of a small screen. */
      @media (max-width: 600px) {
        :host { min-height: 0; border-radius: 20px; }
        .bar { padding: 10px 10px 0 18px; }
        .view-wrapper { padding: 16px 20px 14px; }
        .big { font-size: 23px; }
        .sub { font-size: 13px; }
        .status-text { font-size: 21px; }
        .center-layout, .answer-layout { gap: 10px; }
        .orb { width: 48px; height: 48px; }
        .resp-area { font-size: 17px; line-height: 1.5; min-height: 0; max-height: 26vh; }
        talkie-transcript { font-size: 13.5px; max-height: 4.6em; overflow-y: auto; }
        .hintline { padding: 0 20px 12px; }
      }
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
    this.mode = 'push-to-talk';
    this.idleTimeout = 60;
    this._partial = '';
    this.heading = DEFAULT_HEADING;
    this.subtitle = DEFAULT_SUBTITLE;

    this.#sm = new StateMachine();

    this._onSmChange   = this._onSmChange.bind(this);
    this._onStartActivate = this._onStartActivate.bind(this);
    this._onBtnClick    = this._onBtnClick.bind(this);
    this._onCloseClick  = this._onCloseClick.bind(this);
    this._onMinimizeClick = this._onMinimizeClick.bind(this);
    this._onRetryClick  = this._onRetryClick.bind(this);
    this._onStopClick   = this._onStopClick.bind(this);
    this._onAskAnotherClick = this._onAskAnotherClick.bind(this);
    this._onStopSendClick = this._onStopSendClick.bind(this);
    this._onCancelRecordingClick = this._onCancelRecordingClick.bind(this);
    this._onEndClick    = this._onEndClick.bind(this);
    this._onInterruptClick = this._onInterruptClick.bind(this);
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
    if (changed.has('_sm') || changed.has('open') || changed.has('mode') || changed.has('backend')) {
      this._syncLabel();
      this._syncHint();
    }
  }

  updated(changed) {
    if (changed.has('open') && this.open) {
      this._tx = this.#sm.transcript;
      this._rp = this.#sm.response;
    }
    if (changed.has('_shown')) {
      const resp = this.renderRoot.querySelector('.resp-area');
      if (resp) {
        resp.scrollTop = resp.scrollHeight;
        resp.classList.toggle('scrolled', resp.scrollTop > 0);
      }
    }
  }

  /** Fade the reply's top edge only while some of it is scrolled out of view. */
  _onRespScroll(e) {
    e.currentTarget.classList.toggle('scrolled', e.currentTarget.scrollTop > 0);
  }

  /* ── Public API ─────────────────────────────── */

  show() {
    if (this.open) {
      this.restore();
      return;
    }
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
    this.minimized = false;
    this.open = false;
    this._emitEvent('talkie-close', { reason });
  }

  /** Hide the panel but keep the conversation (and the mic) going. */
  minimize() {
    if (!this.open || this.minimized) return;
    this.minimized = true;
    this._emitEvent('talkie-minimize');
  }

  /** Bring a minimized panel back. */
  restore() {
    if (!this.minimized) return;
    this.minimized = false;
    this._emitEvent('talkie-restore');
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

    if (ev.to === 'listening' && ev.from !== 'idle') {
      // A conversation's next turn: the same question asked twice should still emit.
      this.#lastTranscript = '';
      this.#lastResponse = '';
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
    if (this._conversational) {
      const hints = {
        idle: 'Press Start or the space bar to talk',
        listening: 'Just talk · Esc ends',
        speaking: 'Space stops the answer · Esc ends',
        transcribing: 'Esc ends',
        thinking: 'Esc ends',
      };
      this._hint = hints[this.#sm.state] ?? '';
      return;
    }
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
    if (this._conversational) {
      if (this.#sm.state === 'idle') this.startConversation('space-start');
      else if (this.#sm.state === 'speaking') this._onInterruptClick();
      return;
    }
    if (this.#sm.state === 'idle') this.startListening('space-start');
    else if (this.#sm.state === 'listening') this.releaseListening('space-stop');
    // Space is the primary action key, so while an answer is playing it does what
    // the on-screen Stop button does: cut the audio short. Pressing it once more
    // then starts the next recording.
    else if (this.#sm.state === 'speaking') this._stopSpeaking();
  }

  /* ── Conversation flow ──────────────────────── */

  /**
   * True when this widget runs conversations: `mode="conversation"` and a backend that can
   * hold one. Anything else falls back to push-to-talk, so the mode never breaks a backend.
   * @returns {boolean}
   */
  get _conversational() {
    if (this.mode !== 'conversation') return false;
    if (typeof this.backend?.converse === 'function') return true;
    if (this.backend && !this.#warnedNoConverse) {
      this.#warnedNoConverse = true;
      console.warn('[talkie] mode="conversation" needs a backend with converse(); using push-to-talk.');
    }
    return false;
  }

  startListening(src) {
    if (this._conversational) {
      this.startConversation(src);
      return;
    }
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

  /* ── Conversation mode ──────────────────────── */

  /**
   * Start a continuous conversation. The backend's events drive the states from here on:
   * listening → transcribing → thinking → speaking → listening, until End, Esc, closing the
   * panel, an error, or the backend's idle limit.
   * @param {string} [src]
   */
  startConversation(src) {
    if (this.#sm.state !== 'idle' || !this._conversational) return;
    const ctrl = new AbortController();
    this.#abortConv = ctrl;
    this.#listenSource = src;
    this.#endedForSilence = false;
    this._tx = '';
    this._rp = '';
    this._shown = 0;
    this._partial = '';
    this.#streamDone = false;
    this.#sm.transition('listening');
    this.#startElapsedTimer();

    (async () => {
      try {
        const idleTimeoutMs = Math.max(0, Number(this.idleTimeout) || 0) * 1000;
        for await (const evt of this.backend.converse({ idleTimeoutMs }, ctrl.signal)) {
          if (ctrl.signal.aborted) return;
          this.#onConversationEvent(evt);
        }
      } catch (err) {
        if (ctrl.signal.aborted || err?.name === 'AbortError') return;
        if (this.#abortConv === ctrl) this.#abortConv = null;
        this.#stopElapsedTimer();
        this._handleError(err);
        return;
      }
      // The backend ended it: nobody spoke for the idle limit.
      if (this.#abortConv !== ctrl) return;
      this.#abortConv = null;
      this.#stopElapsedTimer();
      this.#endedForSilence = true;
      if (this.#sm.state !== 'idle') this.#sm.transition('idle');
      this.requestUpdate();
    })();
  }

  /** End the running conversation, if any, and return to idle. */
  endConversation() {
    if (!this.#abortConv) return;
    this.#cancelConversation('conversation ended');
  }

  /** @param {{ type: string, text?: string, interrupted?: boolean }} evt */
  #onConversationEvent(evt) {
    const sm = this.#sm;
    switch (evt.type) {
      case 'user-speech':
        // The caller is talking again, possibly over the answer (barge-in).
        if (sm.state === 'speaking' || sm.state === 'thinking' || sm.state === 'transcribing') {
          sm.transition('listening');
        }
        break;
      case 'user-partial':
        this._partial = evt.text ?? '';
        break;
      case 'user-transcript':
        this._partial = '';
        this._tx = evt.text ?? '';
        sm.transcript = this._tx;
        if (sm.state === 'listening') sm.transition('transcribing');
        break;
      case 'reply-start':
        // No dwell here, unlike push-to-talk: the agent is already answering, so a pause
        // would only put the panel behind the voice.
        this._rp = '';
        this._shown = 0;
        this.#streamDone = false;
        if (sm.state === 'listening') sm.transition('transcribing');
        if (sm.state === 'transcribing') sm.transition('thinking');
        break;
      case 'speech-audible':
        if (sm.state === 'thinking') sm.transition('speaking');
        break;
      case 'reply-word':
        this._rp = this._rp ? `${this._rp} ${evt.text}` : (evt.text ?? '');
        this._shown = this._rp.split(/\s+/).filter((w) => w.length > 0).length;
        if (sm.state === 'thinking') sm.transition('speaking');
        this.requestUpdate();
        break;
      case 'reply-end':
        // Only a reply still on screen ends here; after a barge-in the caller already moved on.
        if (sm.state === 'speaking' || sm.state === 'thinking') {
          this.#streamDone = true;
          if (this._rp) sm.response = this._rp;
          sm.transition('listening');
        }
        break;
    }
  }

  #cancelConversation(reason) {
    this.#stopSpeakTimer();
    const conversing = this.#abortConv !== null;
    if (conversing) {
      // The backend's converse() ends the mic and the agent session on abort.
      this.#abortConv.abort();
      this.#abortConv = null;
      this._partial = '';
    }
    // Abandoning a recording still has to close the mic and the ASR socket; the
    // abort controllers below only unwind this component's own work. The
    // transcript is deliberately discarded.
    if (!conversing && this.#sm.state === 'listening' && this.backend?.stopCapture) {
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

  _onMinimizeClick() {
    this.minimize();
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

  /** Conversation mode: End conversation. */
  _onEndClick() {
    this.endConversation();
  }

  /** Conversation mode: Stop — cut the answer short and keep listening. */
  _onInterruptClick() {
    if (this.#sm.state !== 'speaking') return;
    if (typeof this.backend?.interrupt === 'function' && this.backend.interrupt()) return;
    // No reply to cut on the backend's side (it already finished arriving): just move on.
    this.#streamDone = true;
    this.#sm.transition('listening');
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
    // A minimized panel is out of the way: the page's own keys are the page's.
    if (!this.open || this.minimized) return;
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
      ${this.layout === 'sheet'
        ? html`<button type="button" class="grabber" @click=${this._onMinimizeClick} aria-label="Minimize, keep talking"></button>`
        : ''}
      <div class="bar">
        <div class="eyebrow">
          <span class="dot" aria-hidden="true"></span>${this.heading}
          ${s === 'speaking' ? html`<span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>` : ''}
        </div>
        <div class="bar-actions">
          <lion-button class="icon-btn min-btn" @click=${this._onMinimizeClick}
              aria-label="Minimize, keep talking" title="Minimize — the conversation keeps going">${iconMinimize()}</lion-button>
          <lion-button class="icon-btn close-btn" @click=${this._onCloseClick}
              aria-label="End and close" title="End and close">${iconClose()}</lion-button>
        </div>
      </div>
      <div class="view-wrapper">
        ${this._renderView(s)}
      </div>
      <p class="hintline">${this._hint}</p>
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
    const conversation = this._conversational;
    const sub = !conversation
      ? this.subtitle
      : this.#endedForSilence
        ? `Ended after ${this.idleTimeout} seconds of silence. Start again any time.`
        : `Just talk. ${this.subtitle}`;
    return html`
      <div class="view center-layout">
        <div class="orb" aria-hidden="true">${iconMic(26)}</div>
        <h2 class="big" aria-hidden="true">Have a&nbsp;question?</h2>
        <p class="sub">${sub}</p>
        <lion-button class="btn btn-primary" id="startBtn" data-action="start" @click=${this._onStartActivate}>
          ${iconMic()} ${conversation ? 'Start\u00a0conversation' : 'Start\u00a0Recording'}
        </lion-button>
      </div>`;
  }

  /** Conversation mode: the End control every in-conversation view offers. */
  _renderEndLink() {
    return html`<button type="button" class="end-btn" id="endBtn" @click=${this._onEndClick}>${iconClose()}End conversation</button>`;
  }

  _renderListening() {
    const title = this._conversational ? 'Listening' : 'Recording';
    return html`
      <div class="view center-layout">
        <h2 class="status-text" aria-hidden="true">
          ${title}<span class="rec-clock">${formatElapsed(this._elapsed)}</span>
        </h2>
        <talkie-waveform .enabled=${true} .color=${this._getStateColor()}></talkie-waveform>
        ${this._conversational
          ? html`
            ${this._partial ? html`<talkie-transcript .text=${this._partial}></talkie-transcript>` : ''}
            ${this._renderEndLink()}`
          : html`
            <lion-button class="btn btn-stop" id="stopSendBtn" data-action="stop-send" @click=${this._onStopSendClick}>
              <span class="sq"></span>Stop &amp; Send
            </lion-button>
            <button type="button" class="link-btn" @click=${this._onCancelRecordingClick}>Discard</button>`}
      </div>`;
  }

  _renderTranscribing() {
    return html`
      <div class="view center-layout">
        <div class="orb orb-busy" aria-hidden="true"></div>
        <h2 class="status-text" aria-hidden="true">Understanding…</h2>
        ${this._tx ? html`<talkie-transcript .text=${this._tx}></talkie-transcript>` : ''}
        ${this._conversational ? this._renderEndLink() : ''}
      </div>`;
  }

  _renderThinking() {
    return html`
      <div class="view center-layout">
        <div class="orb orb-think" aria-hidden="true"></div>
        <h2 class="status-text" aria-hidden="true">Finding the right answer…</h2>
        ${this._tx ? html`<talkie-transcript .text=${this._tx}></talkie-transcript>` : ''}
        ${this._conversational ? this._renderEndLink() : ''}
      </div>`;
  }

  _renderSpeaking() {
    const answer = this._rp ?? '';
    const words = answer.split(/\s+/);
    const displayText = words.slice(0, this._shown).join(' ');
    // Cursor is visible while streaming; it fades once the generator finishes.
    const complete = this.#streamDone;
    const stop = (onClick) => html`
      <lion-button class="btn btn-stop" id="stopBtn" data-action="stop" @click=${onClick}>
        <span class="sq"></span>Stop
      </lion-button>`;

    return html`
      <div class="view answer-layout">
        ${this._tx ? html`<talkie-transcript .text=${this._tx}></talkie-transcript>` : ''}
        <p class="resp-area" @scroll=${this._onRespScroll}>
          ${displayText}${complete ? '' : html`<span class="cursor-cursor"></span>`}
        </p>
        <div class="answer-actions">
          ${this._conversational
            ? html`${stop(this._onInterruptClick)}${this._renderEndLink()}`
            : complete
            ? html`<lion-button class="btn btn-secondary" id="askAnotherBtn" data-action="ask-another" @click=${this._onAskAnotherClick}>Ask another</lion-button>`
            : stop(this._onStopClick)}
        </div>
      </div>`;
  }

  _renderError() {
    const msg = ERROR_MESSAGES[this.#sm.errorReason] ?? ERROR_MESSAGES.unknown;
    return html`
      <div class="view center-layout">
        <div class="err-icon" aria-hidden="true">!</div>
        <h2 class="status-text">${msg.title}</h2>
        <p class="sub">${msg.sub}</p>
        <lion-button class="btn btn-secondary" id="retryBtn" data-action="retry"
            @click=${this._onRetryClick}>Try again</lion-button>
      </div>`;
  }

  /* ── Utility ────────────────────────────────── */

  /** The current state's colour, for the canvas waveform (CSS reads --_state instead). */
  _getStateColor() {
    return stateColor(this.#sm.state);
  }
}
