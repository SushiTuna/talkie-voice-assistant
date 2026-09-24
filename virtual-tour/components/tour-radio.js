// Tour-themed Lion radio components: the booking form's tour-type and time-window card groups.
// Theme tokens are CSS custom properties on :root in styles.css; they inherit into shadow DOM.
import { css } from "lit";
import { LionRadioGroup, LionRadio } from "@lion/ui/radio-group.js";

export class TourRadioGroup extends LionRadioGroup {
  static get styles() {
    return [
      super.styles ?? [],
      css`
        :host {
          display: block;
          font-family: var(--sans);
          color: var(--ink);
        }
        /* The card grid lives here, not on the host: Lion adds its own light-DOM
           slot-holders ([slot="label"], [slot="help-text"], [slot="feedback"]) as host
           children, and a grid on the host would hand them real cells. Grid on the
           shadow .input-group wraps only the slotted <tour-radio> cards; the slot-holders
           stay in normal flow (empty ones are zero-height, feedback shows when invalid).
           Columns and gap come from the page via --choice-grid-columns /
           --choice-grid-gap (custom props inherit). */
        .input-group {
          display: grid;
          grid-template-columns: var(--choice-grid-columns, minmax(0, 1fr));
          gap: var(--choice-grid-gap, 12px);
        }
        /* The page owns the group's error display: the styled #err-* <p> in the fieldset
           carries the message (icon + danger style, like the text fields). Without this,
           an invalid group showed the message twice — Lion's own lion-validation-feedback
           (a light-DOM child in slot="feedback") rendered a plain copy above the page's.
           Hide only that rendering; the Required validators stay (aria wiring, page.js). */
        ::slotted([slot="feedback"]) {
          display: none;
        }
      `,
    ];
  }
}

export class TourRadio extends LionRadio {
  static get styles() {
    return [
      super.styles ?? [],
      css`
        :host {
          font-family: var(--sans);
          color: var(--ink);
        }
        /* The native input is slotted from light DOM (slot="input"); styles.css
           (.choice input) restyles it as the card's corner check circle. */
        ::slotted(input) {
          accent-color: var(--accent);
        }
        :host(:focus-visible) {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
      `,
    ];
  }
}

if (!customElements.get("tour-radio-group")) customElements.define("tour-radio-group", TourRadioGroup);
if (!customElements.get("tour-radio")) customElements.define("tour-radio", TourRadio);
