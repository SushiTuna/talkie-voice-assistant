import { LitElement, css, html } from 'lit';

/**
 * Renders the recognised user text — shown from transcribing onward.
 *
 * This component is new to the SDK (not in the mockup). It accumulates chunks
 * as they arrive and displays the full transcript so the user can see when ASR
 * misheard.
 *
 * Fix 3 (show the transcript): this component is rendered inside talkie-widget
 * in the transcribing and thinking states.
 */
export class TalkieTranscript extends LitElement {
  static properties = {
    text:   { type: String },
  };

  static get styles() {
    return css`
      /* A chat bubble for the caller's words. The tint comes from the ink, so it shows on a
         dark theme too (a fixed black tint vanished there). */
      :host {
        display: block;
        box-sizing: border-box;
        width: fit-content;
        max-width: min(100%, 34ch);
        font-size: 15px;
        line-height: 1.5;
        text-align: start;
        color: var(--talkie-ink, light-dark(#101d20, #eceeef));
        padding: 9px 14px;
        background: color-mix(in srgb, var(--talkie-ink, light-dark(#101d20, #eceeef)) 7%, transparent);
        border-radius: 16px 16px 4px 16px;
        overflow-wrap: anywhere;
      }
      p { margin: 0; }
    `;
  }

  constructor() {
    super();
    this.text = '';
  }

  /* ── Template ──────────────────────────────── */

  render() {
    if (!this.text) return html``;
    return html`<p>${this.text}</p>`;
  }
}
