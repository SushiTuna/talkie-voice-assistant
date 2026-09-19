// Lion-based dark-mode switch used in the header (#themeToggle, see page.js wireTheme).
// LionSwitch paints its role=switch control (LionSwitchButton) inside the button's own shadow
// DOM, so the track/thumb/icon visuals live in TourSwitchButton below and are injected into
// LionSwitch via scopedElements (LionSwitch creates its input through createScopedElement).
import { css, html } from "lit";
import { LionSwitch, LionSwitchButton } from "@lion/ui/switch.js";

export class TourSwitchButton extends LionSwitchButton {
  static get styles() {
    return [
      super.styles ?? [],
      css`
        :host {
          width: 68px;
          height: 38px;
          cursor: pointer;
        }
        /* replace Lion's placeholder focus style; the ring goes on the whole control */
        :host(:focus:not([disabled])) .switch-button__thumb {
          outline: none;
        }
        :host(:focus-visible) {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
          border-radius: 999px;
        }
        .switch-button__track {
          position: relative;
          height: 100%;
          box-sizing: border-box;
          background: var(--surface-2);
          border: 1px solid var(--line);
          border-radius: 999px;
          transition: border-color 0.15s;
        }
        :host(:hover) .switch-button__track {
          border-color: var(--warm);
        }
        .i {
          position: absolute;
          top: 50%;
          z-index: 2; /* ride above the knob: the active icon shows on the knob itself */
          width: 15px;
          height: 15px;
          transform: translateY(-50%);
          color: var(--muted);
          pointer-events: none;
          transition: color 0.2s;
        }
        .i-sun { left: 9px; }
        .i-moon { right: 9px; }
        /* checked = dark: knob on the right carrying the moon; unchecked = light, sun on the left */
        :host(:not([checked])) .i-sun,
        :host([checked]) .i-moon {
          color: var(--on-accent);
        }
        .switch-button__thumb {
          top: 4px;
          left: 4px;
          z-index: 1;
          width: 30px;
          height: 30px;
          box-sizing: border-box;
          background: var(--accent);
          border-radius: 50%;
          transform: translateX(0);
          transition: transform 0.2s ease;
        }
        :host([checked]) .switch-button__thumb {
          right: auto;
          transform: translateX(30px);
        }
        @media (prefers-reduced-motion: reduce) {
          .switch-button__track, .switch-button__thumb, .i { transition: none; }
        }
      `,
    ];
  }

  render() {
    return html`
      <div class="btn">
        <div class="switch-button__track">
          <svg class="i i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4.2" />
            <path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
          </svg>
          <svg class="i i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        </div>
        <div class="switch-button__thumb"></div>
      </div>
    `;
  }

  updated(changedProperties) {
    super.updated(changedProperties);
    // Lion only refreshes aria-checked on user toggles; a programmatic .checked sync from
    // TourSwitch (on load / system-preference change) would leave it stale.
    if (changedProperties.has("checked")) this.setAttribute("aria-checked", `${this.checked}`);
  }
}

export class TourSwitch extends LionSwitch {
  static get scopedElements() {
    return { ...super.scopedElements, "lion-switch-button": TourSwitchButton };
  }

  static get styles() {
    return [
      super.styles ?? [],
      css`
        :host {
          position: relative; /* contain the sr-only label */
          display: inline-block;
          font-family: var(--sans);
          color: var(--ink);
        }
      `,
    ];
  }

  firstUpdated(changedProperties) {
    super.firstUpdated(changedProperties);
    // Lion wires the (sr-only) label to the switch via aria-labelledby, but the label lives in
    // this shadow tree while the role=switch button is a light-DOM child — cross-tree idrefs are
    // unreliable. Mirror the label into aria-label as a fallback (aria-labelledby still wins
    // where it resolves, so the name is "Dark mode" either way, never doubled).
    const input = this._inputNode;
    if (input && this.label && !input.getAttribute("aria-label")) {
      input.setAttribute("aria-label", this.label);
    }
  }
}

if (!customElements.get("tour-switch")) customElements.define("tour-switch", TourSwitch);
