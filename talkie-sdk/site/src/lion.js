/**
 * Register all Lion web components used by the site.
 */

import '@lion/ui/define/lion-form.js';
import '@lion/ui/define/lion-fieldset.js';
import '@lion/ui/define/lion-input.js';
import '@lion/ui/define/lion-textarea.js';
import '@lion/ui/define/lion-radio-group.js';
import '@lion/ui/define/lion-radio.js';
import '@lion/ui/define/lion-select.js';
import '@lion/ui/define/lion-tabs.js';
import '@lion/ui/define/lion-accordion.js';
import '@lion/ui/define/lion-dialog.js';
import '@lion/ui/define/lion-button.js';
import '@lion/ui/define/lion-tooltip.js';
import '@lion/ui/define/lion-collapsible.js';

/* ---------------------------------------------------------------- switch */

// Lion's switch button ships bare grey boxes and asks to be restyled by extension. LionSwitch
// creates its button through the global registry (no scoped-elements polyfill here).
// Colours come only from the site tokens in theme.css, so both themes follow. The track is
// --field-line when off (3:1 against the page, as a field border is), and the thumb takes the
// colour that contrasts with its track: --raised when off, --accent-ink when on.
import { css, html } from 'lit';
import { LionSwitch, LionSwitchButton } from '@lion/ui/switch.js';

class SiteSwitchButton extends LionSwitchButton {
  static get styles() {
    return [
      ...super.styles,
      css`
        :host { width: 2.25rem; height: 1.25rem; cursor: pointer; }
        .switch-button__track {
          background: var(--field-line);
          border-radius: 999px;
          transition: background-color 0.18s var(--ease), box-shadow 0.18s var(--ease);
        }
        .switch-button__thumb {
          top: 3px;
          left: 3px;
          width: calc(1.25rem - 6px);
          height: calc(1.25rem - 6px);
          background: var(--raised);
          border-radius: 50%;
          box-shadow: var(--shadow-sm);
          transition: left 0.18s var(--ease), width 0.18s var(--ease), background-color 0.18s var(--ease);
        }
        :host(:hover) .switch-button__track { background: var(--ink-soft); }
        /* The thumb stretches while pressed, like a platform switch. */
        :host(:active) .switch-button__thumb { width: calc(1.25rem - 2px); }
        :host([checked]) .switch-button__track { background: var(--accent); }
        :host([checked]:hover) .switch-button__track {
          background: color-mix(in srgb, var(--accent) 88%, var(--ink));
        }
        :host([checked]) .switch-button__thumb {
          left: calc(100% - 1.25rem + 3px);
          right: auto;
          background: var(--accent-ink);
        }
        :host([checked]:active) .switch-button__thumb { left: calc(100% - 1.25rem - 1px); }
        /* Same specificity as Lion's own ':host(:focus:not([disabled])) .switch-button__thumb',
           and later, so its light-blue thumb outline never shows. */
        :host(:focus:not([disabled])) .switch-button__thumb { outline: none; }
        :host(:focus-visible) .switch-button__track {
          outline: 2px solid var(--focus);
          outline-offset: 2px;
          box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 22%, transparent);
        }
        @media (prefers-reduced-motion: reduce) {
          .switch-button__track, .switch-button__thumb { transition: none; }
        }
      `,
    ];
  }
}

// Map the tag to our class in the switch's scoped registry too, or ScopedElementsMixin sees two
// classes for one tag and logs an error.
class SiteSwitch extends LionSwitch {
  static get scopedElements() {
    return { ...super.scopedElements, 'lion-switch-button': SiteSwitchButton };
  }
}

if (!customElements.get('lion-switch-button')) customElements.define('lion-switch-button', SiteSwitchButton);
if (!customElements.get('lion-switch')) customElements.define('lion-switch', SiteSwitch);

/* ---------------------------------------------------------------- range */

// Lion's range renders its value on a line above the track and its limits as two stacked lines,
// all in shadow DOM, so it is restyled by extension too. The value moves into a pill beside the
// label, the limits sit under the track's two ends, and the filled share of the track is handed
// to the light-DOM input as --_fill, because WebKit has no progress pseudo-element to paint.
// The track and thumb themselves are styled in theme.css.
import { LionInputRange } from '@lion/ui/input-range.js';

class SiteInputRange extends LionInputRange {
  static get styles() {
    return [
      ...super.styles,
      css`
        .range-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 0.75rem;
        }
        .range-head .form-field__label { min-width: 0; }
        .input-range__readout {
          flex: none;
          padding: 0.05rem 0.55rem;
          border-radius: 999px;
          background: var(--accent-soft);
          color: var(--accent);
          font-family: var(--mono);
          font-size: 0.8rem;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
        }
        .input-range__unit { margin-left: 0.1em; }
        /* Lion puts the limits inside the input's flex row; wrap them onto their own line. */
        .input-group__input { flex-wrap: wrap; }
        .input-range__limits {
          flex-basis: 100%;
          display: flex;
          justify-content: space-between;
          margin-top: 0.1rem;
          color: var(--ink-soft);
          font-size: 0.75rem;
          font-variant-numeric: tabular-nums;
        }
      `,
    ];
  }

  _groupOneTemplate() {
    const { text, showUnit } = this._valueDisplay;
    return html`
      <div class="range-head">
        ${this._labelTemplate()}
        <span class="input-range__readout"
          ><span class="input-range__value">${text}</span
          >${showUnit && this.unit ? html`<span class="input-range__unit">${this.unit}</span>` : ''}</span
        >
      </div>
      ${this._helpTextTemplate()}
    `;
  }

  // FormControlMixin's input group, without the value line LionInputRange puts above the track:
  // the readout now lives in the head.
  _inputGroupTemplate() {
    return html`
      <div class="input-group">
        ${this._inputGroupBeforeTemplate()}
        <div class="input-group__container">
          ${this._inputGroupPrefixTemplate()} ${this._inputGroupInputTemplate()}
          ${this._inputGroupSuffixTemplate()}
        </div>
        ${this._inputGroupAfterTemplate()}
      </div>
    `;
  }

  updated(changedProperties) {
    super.updated(changedProperties);
    if (['modelValue', 'min', 'max'].some((name) => changedProperties.has(name))) {
      const span = this.max - this.min;
      const share = Number.isFinite(span) && span > 0 ? (Number(this.modelValue) - this.min) / span : 0;
      const fill = Math.min(1, Math.max(0, share || 0)) * 100;
      this._inputNode.style.setProperty('--_fill', `${fill}%`);
    }
  }
}

if (!customElements.get('lion-input-range')) customElements.define('lion-input-range', SiteInputRange);

// Set up default validation feedback messages.
import { loadDefaultFeedbackMessages } from '@lion/ui/validate-messages.js';
loadDefaultFeedbackMessages();
