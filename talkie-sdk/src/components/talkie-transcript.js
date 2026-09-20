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
      :host {
        display: block;
        font-size: 15px;
        line-height: 1.5;
        color: var(--talkie-ink-soft, #4a5a58);
        padding: 8px 12px;
        margin: 8px 0;
        background: rgba(0,0,0,.04);
        border-radius: 8px;
        word-break: break-word;
      }
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
