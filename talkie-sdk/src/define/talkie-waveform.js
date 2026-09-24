import { TalkieWaveform } from '../components/talkie-waveform.js';
if (!customElements.get('talkie-waveform')) {
  customElements.define('talkie-waveform', TalkieWaveform);
}
