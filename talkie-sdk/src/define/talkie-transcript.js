import { TalkieTranscript } from '../components/talkie-transcript.js';
if (!customElements.get('talkie-transcript')) {
  customElements.define('talkie-transcript', TalkieTranscript);
}
