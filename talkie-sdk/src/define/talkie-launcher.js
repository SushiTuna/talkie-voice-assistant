import { TalkieLauncher } from '../components/talkie-launcher.js';
if (!customElements.get('talkie-launcher')) {
  customElements.define('talkie-launcher', TalkieLauncher);
}
