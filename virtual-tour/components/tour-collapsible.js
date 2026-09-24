// Tour-themed Lion collapsible. Used by the room dock (index.html #dockCollapse):
// the "Hide rooms" tour-button is the invoker and #dockBody is the content.
// Adds a default slot so unslotted siblings (the dock head row) can live inside the
// collapsible and take part in its layout, and keeps the content's own id (Lion would
// otherwise replace it with a generated one, breaking #dockBody anchors and aria-controls).
import { css, html } from "lit";
import { LionCollapsible } from "@lion/ui/collapsible.js";

export class TourCollapsible extends LionCollapsible {
  static get styles() {
    return [
      super.styles ?? [],
      css`
        :host {
          font-family: var(--sans);
          color: var(--ink);
          border: 1px solid var(--line);
          border-radius: 8px;
          background: var(--surface);
        }
        :host(:focus-visible) {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
      `,
    ];
  }

  render() {
    return html`
      <slot></slot>
      <slot name="invoker"></slot>
      <slot name="content"></slot>
    `;
  }

  connectedCallback() {
    const content = this.querySelector('[slot="content"]');
    const keepId = content?.id;
    super.connectedCallback();
    if (keepId && content) {
      content.id = keepId;
      this._invokerNode?.setAttribute("aria-controls", keepId);
    }
  }
}

if (!customElements.get("tour-collapsible")) customElements.define("tour-collapsible", TourCollapsible);
