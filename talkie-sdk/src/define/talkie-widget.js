import { TalkieWidget } from '../components/talkie-widget.js';
if (!customElements.get('talkie-widget')) {
  customElements.define('talkie-widget', TalkieWidget);
}
