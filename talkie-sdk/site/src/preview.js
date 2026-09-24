import '../../src/define/talkie-launcher.js';
import '../../src/define/talkie-widget.js';
import '../../src/define/talkie-transcript.js';
import '../../src/define/talkie-waveform.js';
import { TalkieAssistant } from '../../src/components/talkie-assistant.js';
import { MockBackend } from '../../src/backends/mock-backend.js';
import { createTurnstileVerify } from './verify.js';

/**
 * `<talkie-preview>` — a version of `<talkie-assistant>` that can swap between
 * `MockBackend` (no network) and the live agent, controlled via the `backend` attribute.
 */
export class TalkiePreview extends TalkieAssistant {
  constructor() {
    super();
    // A public voice server may ask for a bot check before it issues a visitor ticket.
    if (!this.verify) this.verify = createTurnstileVerify(this.ownerDocument);
  }

  /** 'live' when attribute `backend="live"`, else `'mock'`. */
  get backendMode() {
    return this.getAttribute('backend') === 'live' ? 'live' : 'mock';
  }

  // MockBackend has no converse(), so mock runs push-to-talk.
  get mode() {
    return this.backendMode === 'mock' ? 'push-to-talk' : super.mode;
  }

  /**
   * A persona to use in place of the server's `/agent/context` reply, in that reply's shape
   * (see `toAgentContext`). Set it before the element is connected. Without it the server's
   * `profile` (or its default one) loads, as it does for `<talkie-assistant>`.
   * @type {object | null}
   */
  context = null;

  _loadContext() {
    return this.context ?? super._loadContext();
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
