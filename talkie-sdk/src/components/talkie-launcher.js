import { LitElement, css, html } from 'lit';
import { ScopedElementsMixin } from '@open-wc/scoped-elements';
import { svg } from 'lit-html';
import { TalkieButton } from './talkie-button.js';
import { STATE_COLORS } from '../core/state-colors.js';

/** Mixin-applied base class for scoped element composition. */
const ScopedLitElement = ScopedElementsMixin(LitElement);

function iconMic() {
  return svg`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="2" width="6" height="11" rx="3"/>
    <path d="M5 10v2a7 7 0 0 0 14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="22"/>
  </svg>`;
}

/** Voice bars bouncing in the button while the agent talks behind a minimized panel. */
function iconTalking() {
  return html`<span class="talking" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`;
}


/**
 * Floating mic launcher button with pulse ring, floaty animation, hover label,
 * and nudge toast.
 */
export class TalkieLauncher extends ScopedLitElement {
  static properties = {
    // The assistant's name: the button's accessible name says "Open <heading>", and the hover
    // label defaults to "<heading> · Voice". <talkie-assistant> passes its own `heading` on.
    heading: { type: String, reflect: true, useDefault: true },
    // Hover label. Unset (or removed), it follows `heading`; the getter below supplies that.
    label:  { type: String, attribute: 'label' },
    open:   { type: Boolean, reflect: true },
    nudged: { type: Boolean, reflect: true },
    // A conversation is running behind a minimized panel: the button shows rippling
    // waves, coloured and scaled by `state`, and tapping it brings the panel back.
    active: { type: Boolean, reflect: true },
    state:  { type: String, reflect: true },
    _timer: { type: Object, state: true },
  };

  static get scopedElements() {
    return { 'talkie-button': TalkieButton };
  }

  static get styles() {
    return css`
      :host {
        display: block;
        position: fixed;
        right: var(--talkie-launcher-offset-right, 28px);
        bottom: var(--talkie-launcher-offset-bottom, 28px);
        z-index: 60;
        width: 60px;
        height: 60px;
      }
      :host([open]) {
        opacity: 0;
        transform: scale(.55) translateY(24px);
        pointer-events: none;
      }
      .launcher-wrap {
        position: relative;
        width: 100%;
        height: 100%;
      }
      .launcher-btn {
        cursor: pointer;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: var(--talkie-launcher-bg, linear-gradient(145deg, #6ee7d4, #1c7f70));
        color: #06231f;
        position: relative;
        box-shadow: 0 12px 34px -8px rgba(95,217,198,.55),
                    0 0 0 1px rgba(255,255,255,.18);
        animation: tl-floaty 3.6s ease-in-out infinite;
        transition: transform .2s, box-shadow .25s;
        z-index: 1;
      }
      .launcher-btn:hover {
        transform: scale(1.1);
        box-shadow: 0 16px 44px -8px rgba(95,217,198,.8),
                    0 0 0 1px rgba(255,255,255,.3);
      }
      .launcher-btn:active {
        transform: scale(.94);
      }
      .launcher-btn:focus-visible {
        outline: 2px solid var(--talkie-state, #5fd9c6);
        outline-offset: 3px;
      }
      .launcher-btn::after {
        content: '';
        position: absolute;
        inset: -5px;
        border-radius: 50%;
        border: 2px solid rgba(95,217,198,.55);
        animation: tl-pulseRing 2.4s ease-out infinite;
        pointer-events: none;
      }
      @keyframes tl-floaty {
        0%, 100% { margin-top: 0; }
        50%      { margin-top: -7px; }
      }
      @keyframes tl-pulseRing {
        0%   { transform: scale(1);   opacity: .7; }
        100% { transform: scale(1.45); opacity: 0;  }
      }

      .hover-label {
        position: absolute;
        right: 74px;
        top: 50%;
        transform: translateY(-50%) translateX(8px);
        white-space: nowrap;
        background: #101d20;
        color: #eaf4f1;
        font-family: var(--talkie-font-mono, monospace);
        font-size: 11px;
        letter-spacing: 1px;
        padding: 9px 14px;
        border-radius: 9px;
        border: 1px solid rgba(255,255,255,.14);
        opacity: 0;
        pointer-events: none;
        transition: opacity .25s, transform .25s;
        box-shadow: 0 10px 24px -8px rgba(0,0,0,.6);
      }
      .hover-label::after {
        content: '';
        position: absolute;
        right: -5px;
        top: 50%;
        transform: translateY(-50%) rotate(45deg);
        width: 9px;
        height: 9px;
        background: #101d20;
        border-right: 1px solid rgba(255,255,255,.14);
        border-top: 1px solid rgba(255,255,255,.14);
      }
      :host(:hover) .hover-label {
        opacity: 1;
        transform: translateY(-50%) translateX(0);
      }

      .nudge-toast {
        position: absolute;
        right: 4px;
        bottom: 74px;
        white-space: nowrap;
        background: #ff8a4c;
        color: #20100a;
        font-family: var(--talkie-font-display, 'Space Grotesk', sans-serif);
        font-weight: 600;
        font-size: 12.5px;
        padding: 9px 14px;
        border-radius: 10px;
        box-shadow: 0 10px 26px -8px rgba(255,138,76,.6);
        opacity: 0;
        pointer-events: none;
        animation: tl-nudge 7.5s .9s ease forwards;
      }
      .nudge-toast::after {
        content: '';
        position: absolute;
        right: 18px;
        bottom: -5px;
        width: 10px;
        height: 10px;
        background: #ff8a4c;
        transform: rotate(45deg);
      }
      /* ── Live conversation behind a minimized panel ── */
      .waves {
        position: absolute;
        inset: -46px;
        width: calc(100% + 92px);
        height: calc(100% + 92px);
        pointer-events: none;
        overflow: visible;
        display: none;
      }
      :host([active]) .waves { display: block; }
      :host([active]) .launcher-btn { animation: none; }
      :host([active]) .launcher-btn::after { display: none; }
      :host([active]) .nudge-toast { display: none; }
      /* --_wave is the state's colour, set per render; a page's --talkie-wave-color wins. */
      .waves .ring { stroke: var(--talkie-wave-color, var(--_wave)); }
      .waves stop { stop-color: var(--talkie-wave-color, var(--_wave)); }
      .waves .ring {
        fill: none;
        stroke-width: 2.5;
        transform-box: fill-box;
        transform-origin: center;
        animation: tl-wave 2.4s cubic-bezier(.2,.6,.3,1) infinite;
      }
      .waves .ring:nth-of-type(2) { animation-delay: .8s; }
      .waves .ring:nth-of-type(3) { animation-delay: 1.6s; }
      .waves .glow {
        transform-box: fill-box;
        transform-origin: center;
        animation: tl-breathe 1.6s ease-in-out infinite;
      }
      @keyframes tl-wave {
        0%   { transform: scale(.62); opacity: .95; }
        100% { transform: scale(1.18); opacity: 0; }
      }
      @keyframes tl-breathe {
        0%, 100% { transform: scale(.66); opacity: .45; }
        50%      { transform: scale(.78); opacity: .7; }
      }
      /* The agent is talking: faster ripples, and bars in place of the mic. */
      :host([state='speaking']) .waves .ring { animation-duration: 1.5s; }
      :host([state='speaking']) .waves .ring:nth-of-type(2) { animation-delay: .5s; }
      :host([state='speaking']) .waves .ring:nth-of-type(3) { animation-delay: 1s; }
      .talking {
        display: flex;
        align-items: center;
        gap: 3px;
        height: 24px;
      }
      .talking i {
        display: block;
        width: 3.5px;
        height: 100%;
        border-radius: 2px;
        background: currentColor;
        transform-origin: center;
        animation: tl-talk .9s ease-in-out infinite;
      }
      .talking i:nth-child(1) { animation-delay: -.45s; }
      .talking i:nth-child(2) { animation-delay: -.15s; }
      .talking i:nth-child(3) { animation-delay: -.6s; }
      .talking i:nth-child(4) { animation-delay: -.3s; }
      .talking i:nth-child(5) { animation-delay: -.75s; }
      @keyframes tl-talk {
        0%, 100% { transform: scaleY(.25); }
        50%      { transform: scaleY(1); }
      }
      @media (prefers-reduced-motion: reduce) {
        .talking i { animation: none; transform: scaleY(.6); }
        .talking i:nth-child(odd) { transform: scaleY(.9); }
        .waves .ring, .waves .glow { animation: none; }
        .waves .ring:nth-of-type(n+2) { display: none; }
        .waves .ring { transform: scale(.85); opacity: .8; }
      }

      @keyframes tl-nudge {
        0%   { opacity: 0; transform: translateY(8px); }
        7%   { opacity: 1; transform: none;            }
        80%  { opacity: 1;                             }
        100% { opacity: 0; visibility: hidden;          }
      }
    `;
  }

  /** @type {string | null | undefined} An explicitly set hover label */
  #label = null;

  // Lit wraps these accessors, so setting `label` still requests an update.
  get label() {
    return this.#label ?? `${this.heading} · Voice`;
  }

  set label(value) {
    this.#label = value;
  }

  constructor() {
    super();
    this.heading = 'Product Expert';
    this.open  = false;
    this.nudged = false;
    this.active = false;
    this.state = 'idle';
    this._timer = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', this._onClick);
    // Schedule nudge after a delay (once)
    if (!this.nudged) {
      this._scheduleNudge();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('click', this._onClick);
    if (this._timer) clearTimeout(this._timer);
  }

  _onClick() {
    this.dispatchEvent(new CustomEvent('talkie-launch', { bubbles: true, composed: true }));
  }

  _scheduleNudge() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this.nudged = true;
    }, 3000);
  }

  /* ── Template ──────────────────────────────── */

  render() {
    return html`
      <div class="launcher-wrap">
        ${this.active ? this._renderWaves() : ''}
        ${this.nudged ? html`<div class="nudge-toast">Have a question? Tap to ask.</div>` : ''}
        <span class="hover-label">${this.active ? 'Conversation on · tap to open' : this.label}</span>
        <talkie-button class="launcher-btn" aria-haspopup="dialog" aria-expanded=${this.open ? 'true' : 'false'}
            aria-label=${this.active ? 'Open the voice assistant, the conversation is still on' : `Open ${this.heading}`}>
          ${this.active && this.state === 'speaking' ? iconTalking() : iconMic()}
        </talkie-button>
      </div>
    `;
  }

  /** Plain circles rippling out from the button, coloured by the conversation state. */
  _renderWaves() {
    // The same colours as the widget's (core/state-colors.js).
    const color = STATE_COLORS[this.state] ?? STATE_COLORS.idle;
    return html`<svg class="waves" viewBox="0 0 152 152" aria-hidden="true" style=${`--_wave: ${color}`}>
      <defs>
        <radialGradient id="tl-glow">
          <stop offset="55%" stop-opacity=".55"/>
          <stop offset="100%" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <circle class="glow" cx="76" cy="76" r="56" fill="url(#tl-glow)"/>
      <circle class="ring" cx="76" cy="76" r="62"/>
      <circle class="ring" cx="76" cy="76" r="62"/>
      <circle class="ring" cx="76" cy="76" r="62"/>
    </svg>`;
  }
}
