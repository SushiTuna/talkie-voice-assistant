/**
 * Embed entry point — bundled by `npm run build` into dist/talkie-embed.js.
 *
 * One file with every dependency inlined, so a page that has no build step can use the
 * assistant with a plain script tag:
 *
 *   <script src="talkie-embed.js" defer></script>
 *   <talkie-assistant api="http://localhost:8000"></talkie-assistant>
 *
 * The classes are exposed on `window.Talkie` for a page that wants to wire a widget to a
 * backend of its own instead of using <talkie-assistant>.
 */

import './define/talkie-assistant.js';
import './define/talkie-transcript.js';
import './define/talkie-waveform.js';

export { TalkieAssistant } from './components/talkie-assistant.js';
export { TalkieWidget } from './components/talkie-widget.js';
export { TalkieLauncher } from './components/talkie-launcher.js';
export { VoiceAgentBackend } from './backends/voice-agent-backend.js';
export { HttpBackend } from './backends/http-backend.js';
export { MockBackend } from './backends/mock-backend.js';
export { TalkieBackendError } from './core/backend.js';
