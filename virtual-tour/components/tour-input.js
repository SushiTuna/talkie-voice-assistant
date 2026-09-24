// Tour-themed Lion text fields (booking form "Your details").
// The page keeps ownership of error rendering: each field's .field-error span is slotted
// into slot="feedback" (so Lion wires it into the input's aria-describedby) while Lion's own
// message display is suppressed via feedbackCondition(). Look & feel lives in styles.css,
// which targets the slotted native controls directly (they are light DOM).
import { html, css } from "lit";
import { LionInput } from "@lion/ui/input.js";
import { LionInputEmail } from "@lion/ui/input-email.js";
import { LionTextarea } from "@lion/ui/textarea.js";
import { LionInputDatepicker } from "@lion/ui/input-datepicker.js";
import { LionInputTel } from "@lion/ui/input-tel.js";
import { LionCalendar } from "@lion/ui/calendar.js";

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
  // Lion's ValidateMixin rewrites the native input's aria-invalid every time it recomputes
  // showsFeedbackFor — which happens whenever hasFeedbackFor changes, e.g. from input-tel's
  // late async validation (awesome-phonenumber loads dynamically, so it can land *after* the
  // page set aria-invalid="true"). feedbackCondition() never fires, so that recompute only
  // ever produces an empty array; dropping the trigger keys keeps the page in full control.
  updated(changedProperties) {
    changedProperties.delete("hasFeedbackFor");
    changedProperties.delete("shouldShowFeedbackFor");
    super.updated(changedProperties);
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

// The calendar invoker is slotted into .input-group__suffix, a plain block: the button
// collapses to its own content height beside the 48px input. Lay the container out as a
// flex row so the suffix can stretch to the input's height (styles.css .date-other button
// gives it the field's border and hover/focus treatment — it is light DOM).
const datepickerStyles = css`
  .input-group__container {
    display: flex;
    align-items: stretch;
  }
  .input-group__input {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* the suffix stretches to the input's height; make it a flex row too so the button
     inside it can fill that height rather than sitting at its own content height */
  .input-group__suffix {
    display: flex;
    align-items: stretch;
  }
  /* Lion ships the calendar popover on a hard-coded white frame, which renders white-on-white
     against the page's inherited ink colour (and stays white in dark mode). Re-skin the frame
     and its header with the site tokens. The grid itself lives in lion-calendar's own shadow
     root, out of reach here, so it picks up only the inherited text colour. */
  .calendar__overlay-frame {
    background: var(--surface);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 18px 40px rgb(0 0 0 / 35%);
    overflow: hidden;
  }
  .arrow svg path {
    fill: var(--surface);
    stroke: var(--line);
  }
  .calendar-overlay__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 8px 12px 16px;
    border-bottom: 1px solid var(--line);
  }
  .calendar-overlay__heading {
    font: 600 14px/1.3 var(--sans);
    color: var(--ink);
    margin: 0;
  }
  .calendar-overlay__close-button {
    flex: none;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }
  .calendar-overlay__close-button:hover {
    background: color-mix(in srgb, var(--ink) 10%, transparent);
    color: var(--ink);
  }
  lion-calendar {
    display: block;
    padding: 8px;
    color: var(--ink);
  }
`;

// Lion's calendar hard-codes a white grid on black text (calendarStyle.js), which is unreadable
// on this site's dark surface. The grid lives in the calendar's own shadow root, so the only way
// in is to restyle the element itself and hand it to the datepicker via scopedElements below.
export class TourCalendar extends LionCalendar {
  // Lion renders the month and year navigation as two stacked rows of bare "<" / ">" text.
  // These two hooks are its supported way to swap the glyphs; the chevrons match the stroked
  // icons used elsewhere on the page, and the styles below fold both rows into one header.
  _previousIconTemplate() {
    return html`<svg class="nav-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7" /></svg>`;
  }
  _nextIconTemplate() {
    return html`<svg class="nav-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5 7 7-7 7" /></svg>`;
  }
  static get styles() {
    return [
      super.styles ?? [],
      css`
        /* one centred header row — month first, then year — instead of two left-aligned rows */
        .calendar__navigation {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          padding: 4px 4px 10px;
          margin-bottom: 4px;
          border-bottom: 1px solid var(--line);
        }
        .calendar__navigation__month {
          order: 1;
        }
        .calendar__navigation__year {
          order: 2;
        }
        .calendar__navigation__month,
        .calendar__navigation__year {
          align-items: center;
        }
        .calendar__navigation-heading {
          font: 600 15px/1.3 var(--sans);
          color: var(--ink);
          margin: 0;
          text-align: center;
          white-space: nowrap;
        }
        /* fixed widths stop the chevrons shuffling as the month name changes length */
        #month {
          min-width: 88px;
        }
        #year {
          min-width: 46px;
        }
        .nav-chevron {
          width: 16px;
          height: 16px;
          fill: none;
          stroke: currentColor;
          stroke-width: 1.8;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .calendar__previous-button,
        .calendar__next-button {
          min-width: 32px;
          min-height: 32px;
          display: inline-grid;
          place-items: center;
          color: var(--muted);
        }
        .calendar__previous-button:hover,
        .calendar__next-button:hover {
          color: var(--ink);
        }
        .calendar__previous-button[disabled],
        .calendar__next-button[disabled] {
          color: color-mix(in srgb, var(--ink) 25%, transparent);
          cursor: default;
          background-color: transparent;
        }
        .calendar__previous-button,
        .calendar__next-button,
        .calendar__day-button {
          background-color: transparent;
          color: var(--ink);
          border-radius: 4px;
          font: 400 14px/1 var(--sans);
          cursor: pointer;
        }
        .calendar__weekday-header {
          font: 600 11px/1.2 var(--sans);
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: var(--muted);
          padding-bottom: 4px;
        }
        .calendar__previous-button:hover,
        .calendar__next-button:hover,
        .calendar__day-button:hover {
          border: 0;
          background-color: color-mix(in srgb, var(--accent) 22%, transparent);
        }
        /* Lion's default is a 1px blue border on :focus, which shows on mouse clicks too */
        .calendar__day-button:focus {
          border: 0;
        }
        .calendar__day-button:focus-visible {
          border: 0;
          outline: 2px solid var(--accent);
          outline-offset: -2px;
        }
        .calendar__day-button[selected] {
          background: var(--accent);
          color: var(--on-accent);
          font-weight: 600;
        }
        /* no "today" marker: it competes with the selected day, and today is never bookable
           anyway (MinDate is tomorrow), so it would only ever mark a disabled cell */
        .calendar__day-button[today] {
          text-decoration: none;
        }
        /* days outside the allowed range (MinDate) and the padding days of adjacent months */
        .calendar__day-button[aria-disabled="true"],
        .calendar__day-button[previous-month],
        .calendar__day-button[next-month] {
          background-color: transparent;
          color: color-mix(in srgb, var(--ink) 30%, transparent);
          cursor: default;
        }
        .calendar__day-button[aria-disabled="true"]:hover {
          background-color: transparent;
        }
      `,
    ];
  }
}

export class TourInputDatepicker extends TourField(LionInputDatepicker) {
  // Lion's default invoker icon is the 📅 emoji; use the same stroked calendar glyph as the
  // "Later date" chip above the field. The invoker lives in light DOM (slot="suffix"), so its
  // size and colour come from styles.css .date-other button, not from this component's styles.
  _invokerIconTemplate() {
    return html`<svg class="invoker-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 9.5h17M8 3.5V6M16 3.5V6" />
    </svg>`;
  }
  static get scopedElements() {
    return { ...super.scopedElements, "lion-calendar": TourCalendar };
  }
  static get styles() {
    return [super.styles ?? [], fieldStyles, datepickerStyles];
  }
}

export class TourInputTel extends TourField(LionInputTel) {
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
if (!customElements.get("tour-input-datepicker")) customElements.define("tour-input-datepicker", TourInputDatepicker);
if (!customElements.get("tour-input-tel")) customElements.define("tour-input-tel", TourInputTel);
if (!customElements.get("tour-textarea")) customElements.define("tour-textarea", TourTextarea);
