// Tour-themed Lion buttons. The submit variant is the booking form's CTA: the page's
// .btn/.btn-primary/.btn-submit classes style the host from the outer tree, and outer-tree
// declarations always win over shadow :host rules — so the look comes from styles.css and
// this file only neutralises the Lion defaults that would clash.
import { css } from "lit";
import { LionButton, LionButtonSubmit } from "@lion/ui/button.js";

const buttonBase = css`
  :host {
    font-family: var(--sans);
    color: var(--ink);
  }
  /* styles.css draws the aria-busy spinner on the host's ::before; LionButton's invisible
     44px hit-area ::before is absolutely centred there and would fight it. While busy the
     button is disabled anyway, so drop the positioning. */
  :host([aria-busy="true"])::before {
    position: static;
    top: auto;
    left: auto;
    transform: none;
    min-width: 0;
    min-height: 0;
  }
`;

/* Neutral host styling for plain tour-buttons: the page's classes (.btn/.btn-light,
   .zoom-btn, .dock-btn, #fsBtn) fully control the look, so strip every LionButton
   default that could show through where outer-tree rules are silent. */
const neutral = css`
  :host {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: baseline; /* match a native <button> in the poster's text flow */
    background: none;
    padding: 0;
    cursor: pointer;
  }
  /* drop LionButton's invisible 44px hit-area overlay: the page sizes its own targets */
  :host::before {
    content: none;
  }
  /* the slot lives in this shadow wrapper: inherit the host's gap so icon+label
     spacing set by outer styles.css keeps working, and add no padding of its own */
  .button-content {
    padding: 0;
    gap: inherit;
  }
  /* Lion's hover/active/disabled defaults must never paint over the page's states */
  :host(:hover),
  :host(:active),
  :host([active]),
  :host([disabled]) {
    background: none;
  }
`;

export class TourButton extends LionButton {
  static get styles() {
    return [super.styles ?? [], buttonBase, neutral];
  }
}

// Submit variant: the host is laid out as a flex row by styles.css so the busy spinner and
// the slotted label sit side by side, centred.
export class TourButtonSubmit extends LionButtonSubmit {
  static get styles() {
    return [super.styles ?? [], buttonBase];
  }
}

if (!customElements.get("tour-button")) customElements.define("tour-button", TourButton);
if (!customElements.get("tour-button-submit")) customElements.define("tour-button-submit", TourButtonSubmit);
