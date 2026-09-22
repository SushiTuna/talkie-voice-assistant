import '../../src/define/talkie-launcher.js';
import '../../src/define/talkie-widget.js';
import '../../src/define/talkie-transcript.js';
import '../../src/define/talkie-waveform.js';
import { TalkieAssistant } from '../../src/components/talkie-assistant.js';
import { MockBackend } from '../../src/backends/mock-backend.js';

/**
 * `<talkie-preview>` — a version of `<talkie-assistant>` that can swap between
 * `MockBackend` (no network) and the live agent, controlled via the `backend` attribute.
 */
export class TalkiePreview extends TalkieAssistant {
  /** 'live' when attribute `backend="live"`, else `'mock'`. */
  get backendMode() {
    return this.getAttribute('backend') === 'live' ? 'live' : 'mock';
  }

  // MockBackend has no converse(), so mock runs push-to-talk.
  get mode() {
    return this.backendMode === 'mock' ? 'push-to-talk' : super.mode;
  }

  _createBackend(options) {
    if (this.backendMode === 'live') return super._createBackend(options);
    const backend = new MockBackend();
    // _onOpen calls prewarm unconditionally; give it a no-op so nothing breaks.
    backend.prewarm = () => {};
    return backend;
  }
}

if (!customElements.get('talkie-preview')) {
  customElements.define('talkie-preview', TalkiePreview);
}
