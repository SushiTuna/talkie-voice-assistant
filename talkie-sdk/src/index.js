/**
 * @talkie/voice-ui — public core API re-export.
 *
 * Hard rule: no side effects on import. This file only re-exports symbols and never calls
 * customElements.define — registration is opt-in via src/define/. It does load lit and
 * @lion/ui transitively, through the component classes it re-exports.
 */

export { StateMachine, VALID_STATES, ERROR_REASONS, TRANSITIONS, TRANSITION_LABELS } from './core/state-machine.js';
export { TalkieBackendError } from './core/backend.js';
export { listAgentProfiles, fetchAgentContext, saveAgentProfile, AgentProfileError } from './core/agent-profiles.js';
export { MockBackend } from './backends/mock-backend.js';
export { HttpBackend } from './backends/http-backend.js';
export { VoiceAgentBackend } from './backends/voice-agent-backend.js';
export { MicCapture } from './audio/mic-capture.js';
export { encodeBase64, decodeBase64, silenceFrame, pcmToWavBytes, pcmToWavBlob } from './audio/pcm-codec.js';
export { TalkieWidget }           from './components/talkie-widget.js';
export { TalkieLauncher }         from './components/talkie-launcher.js';
export { TalkieWaveform }         from './components/talkie-waveform.js';
export { TalkieTranscript }       from './components/talkie-transcript.js';
export { TalkieAssistant }        from './components/talkie-assistant.js';
