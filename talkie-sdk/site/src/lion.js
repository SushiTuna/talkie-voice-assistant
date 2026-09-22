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
import '@lion/ui/define/lion-input-range.js';
import '@lion/ui/define/lion-tabs.js';
import '@lion/ui/define/lion-accordion.js';
import '@lion/ui/define/lion-dialog.js';
import '@lion/ui/define/lion-button.js';
import '@lion/ui/define/lion-tooltip.js';
import '@lion/ui/define/lion-collapsible.js';

/* ---------------------------------------------------------------- switch */

// Lion's switch button ships bare grey boxes and asks to be restyled by extension. LionSwitch
// creates its button through the global registry (no scoped-elements polyfill here).
import { css } from 'lit';
import { LionSwitch, LionSwitchButton } from '@lion/ui/switch.js';

class SiteSwitchButton extends LionSwitchButton {
  static get styles() {
    return [
      ...super.styles,
      css`
        :host { width: 2.25rem; height: 1.25rem; }
        .switch-button__track {
          background: var(--line, #ccc);
          border-radius: 999px;
          transition: background 0.15s;
        }
        .switch-button__thumb {
          top: 2px;
          left: 2px;
          width: calc(1.25rem - 4px);
          height: calc(1.25rem - 4px);
          background: #fff;
          border-radius: 50%;
          box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
          transition: left 0.15s;
        }
        :host([checked]) .switch-button__track { background: var(--accent, #2563eb); }
        :host([checked]) .switch-button__thumb { left: calc(100% - 1.25rem + 2px); right: auto; }
        :host(:focus-visible) .switch-button__thumb { outline: none; }
        :host(:focus-visible) .switch-button__track {
          outline: 2px solid var(--focus, #60a5fa);
          outline-offset: 2px;
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

// Set up default validation feedback messages.
import { loadDefaultFeedbackMessages } from '@lion/ui/validate-messages.js';
loadDefaultFeedbackMessages();
