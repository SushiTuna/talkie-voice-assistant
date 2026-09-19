// Tour-themed Lion text fields (booking form "Your details").
// The page keeps ownership of error rendering: each field's .field-error span is slotted
// into slot="feedback" (so Lion wires it into the input's aria-describedby) while Lion's own
// message display is suppressed via feedbackCondition(). Look & feel lives in styles.css,
// which targets the slotted native controls directly (they are light DOM).
import { html, css } from "lit";
import { LionInput } from "@lion/ui/input.js";
import { LionInputEmail } from "@lion/ui/input-email.js";
import { LionTextarea } from "@lion/ui/textarea.js";

const fieldStyles = css`
  :host {
    font-family: var(--sans);
    color: var(--ink);
  }
`;

// Shared setup for every text field:
// - help text renders *below* the input (Lion's default puts it above, between label and input);
// - the label's `for` points at the real input id (Lion would use its own uuid);
// - Lion's feedback display is off: feedbackCondition() never fires, so showsFeedbackFor stays
//   empty, Lion never touches aria-invalid, and the page remains the single source of messages.
const TourField = (base) => class extends base {
  _groupOneTemplate() {
    return html`${this._labelTemplate()}`;
  }
  _groupTwoTemplate() {
    return html`${this._inputGroupTemplate()} ${this._helpTextTemplate()} ${this._feedbackTemplate()}`;
  }
  _enhanceLightDomA11y() {
    super._enhanceLightDomA11y();
    if (this._labelNode && this._inputNode?.id) {
      this._labelNode.setAttribute("for", this._inputNode.id);
    }
  }
  feedbackCondition() {
    return false;
  }
};

export class TourInput extends TourField(LionInput) {
  static get styles() {
    return [super.styles ?? [], fieldStyles];
  }
}

export class TourInputEmail extends TourField(LionInputEmail) {
  static get styles() {
    return [super.styles ?? [], fieldStyles];
  }
}

export class TourTextarea extends TourField(LionTextarea) {
  static get styles() {
    return [super.styles ?? [], fieldStyles];
  }
  // Keep today's fixed-height textarea (rows=3, resize: vertical) instead of autosize's
  // growing box, and skip the max-height Lion would derive from maxRows.
  __startAutoresize() {}
  setTextareaMaxHeight() {}
}

if (!customElements.get("tour-input")) customElements.define("tour-input", TourInput);
if (!customElements.get("tour-input-email")) customElements.define("tour-input-email", TourInputEmail);
if (!customElements.get("tour-textarea")) customElements.define("tour-textarea", TourTextarea);
