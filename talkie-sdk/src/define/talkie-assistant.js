import { TalkieAssistant } from '../components/talkie-assistant.js';
// The assistant mounts a launcher and a widget, so both have to be registered first.
import './talkie-launcher.js';
import './talkie-widget.js';

if (!customElements.get('talkie-assistant')) {
  customElements.define('talkie-assistant', TalkieAssistant);
}
