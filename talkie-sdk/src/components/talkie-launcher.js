import { LitElement, css, html } from 'lit';
import { ScopedElementsMixin } from '@open-wc/scoped-elements';
import { svg } from 'lit-html';
import { LionIcon } from '@lion/ui/icon.js';
import { LionButton } from '@lion/ui/button.js';

/** Mixin-applied base class for scoped element composition. */
const ScopedLitElement = ScopedElementsMixin(LitElement);

function iconMic() {
  return svg`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="2" width="6" height="11" rx="3"/>
    <path d="M5 10v2a7 7 0 0 0 14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="22"/>
  </svg>`;
}

/**
 * Floating mic launcher button with pulse ring, floaty animation, hover label,
 * and nudge toast.
 */
export class TalkieLauncher extends ScopedLitElement {
  static properties = {
    label:  { type: String, attribute: 'label' },
    open:   { type: Boolean, reflect: true },
    nudged: { type: Boolean, reflect: true },
    _timer: { type: Object, state: true },
  };

  static get scopedElements() {
    return { 'lion-icon': LionIcon, 'lion-button': LionButton };
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
        --talkie-launcher-bg: linear-gradient(145deg, #6ee7d4, #1c7f70);
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
        font-family: monospace;
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
        font-family: 'Space Grotesk', sans-serif;
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
      @keyframes tl-nudge {
        0%   { opacity: 0; transform: translateY(8px); }
        7%   { opacity: 1; transform: none;            }
        80%  { opacity: 1;                             }
        100% { opacity: 0; visibility: hidden;          }
      }
    `;
  }

  constructor() {
    super();
    this.label = 'Product Expert · Voice';
    this.open  = false;
    this.nudged = false;
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
        ${this.nudged ? html`<div class="nudge-toast">Have a question? Tap to ask.</div>` : ''}
        <span class="hover-label">${this.label}</span>
        <lion-button class="launcher-btn" aria-label="Open Product Expert">
          ${iconMic()}
        </lion-button>
      </div>
    `;
  }
}
