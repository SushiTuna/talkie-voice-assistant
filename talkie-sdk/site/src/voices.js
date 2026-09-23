/**
 * The Voice field: a <lion-select> filled from the voice server's GET /agent/voices.
 *
 * The list is never hard-coded here; until it loads (or when it can't) the field still holds,
 * and offers, whatever voice the profile already has, so nothing is lost.
 */

import { listVoices } from '../../src/core/agent-profiles.js';

/** @param {any} field  the lion-select */
const nativeSelect = (field) => field.querySelector('select');

function option(value, text) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = text;
  return opt;
}

/** "anna (English, British)" */
const voiceLabel = ({ id, language, accent }) =>
  `${id} (${[language, accent].filter(Boolean).join(', ') || 'unknown'})`;

/**
 * Make sure `value` is one of the options (a voice the loaded list doesn't have, or any voice
 * before the list loads), then select it without Lion counting it as an edit.
 */
export function showVoice(field, value) {
  const select = nativeSelect(field);
  if (value && ![...select.options].some((o) => o.value === value)) {
    select.append(option(value, `${value} (not in the server's list)`));
  }
  select.value = value ?? '';
}

/**
 * Load the voice list into the field.
 *
 * @param {any} field         the lion-select
 * @param {string} api        voice server origin
 * @param {string} emptyText  text of the "no voice set" option
 * @returns {Promise<boolean>} whether the list loaded
 */
export async function loadVoices(field, api, emptyText) {
  const select = nativeSelect(field);
  const help = field.dataset.help ??= field.getAttribute('help-text') ?? '';
  const current = field.modelValue ?? '';
  select.disabled = true;
  field.helpText = `Loading voices from ${api}…`;
  try {
    const { default: def, voices } = await listVoices({ api });
    select.replaceChildren(
      option('', def ? `${emptyText} (${def})` : emptyText),
      ...voices.map((v) => option(v.id, voiceLabel(v))),
    );
    field.helpText = help;
    return true;
  } catch (err) {
    select.replaceChildren(option('', emptyText));
    field.helpText = `Couldn't load the voice list: ${err.message}`;
    return false;
  } finally {
    // Replacing the options resets the native value; put the field's value back.
    showVoice(field, field.modelValue || current);
    select.disabled = false;
  }
}
