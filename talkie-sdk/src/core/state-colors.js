/**
 * The colour of each conversation state: the widget's accents, its waveform and the
 * launcher's waves all take theirs from here, so the three always agree.
 *
 * These are defaults. A page overrides them through `--talkie-state`, on the element or per
 * state (`talkie-widget[state='listening'] { --talkie-state: … }`, as README shows).
 */
export const STATE_COLORS = Object.freeze({
  idle: '#5fd9c6',
  listening: '#ff8a4c',
  transcribing: '#ffc96b',
  thinking: '#7fb5ff',
  speaking: '#8be28b',
  error: '#ff6b6b',
});

/** For a state that has no entry (the widget before its first render). */
export const NEUTRAL_STATE_COLOR = '#8aa39e';

/** @param {string} state */
export function stateColor(state) {
  return STATE_COLORS[state] ?? NEUTRAL_STATE_COLOR;
}
