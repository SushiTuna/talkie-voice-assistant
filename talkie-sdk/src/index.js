/**
 * @talkie/voice-ui — public core API re-export.
 *
 * Hard rule: no side effects on import. This file only re-exports symbols;
 * it does NOT call customElements.define or import any lit/lion packages.
 */

export { StateMachine, VALID_STATES, ERROR_REASONS, TRANSITIONS, TRANSITION_LABELS } from './core/state-machine.js';
export { TalkieBackendError } from './core/backend.js';
export { MockBackend } from './backends/mock-backend.js';
export { TalkieWidget }           from './components/talkie-widget.js';
export { TalkieLauncher }         from './components/talkie-launcher.js';
export { TalkieWaveform }         from './components/talkie-waveform.js';
export { TalkieTranscript }       from './components/talkie-transcript.js';
