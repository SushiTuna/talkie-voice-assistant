/**
 * Playground page — configure, theme and try a Talkie assistant, and copy its embed snippet.
 *
 * The markup lives in playground.html. Two <lion-form>s hold the state: #config, whose field
 * names are the <talkie-assistant> attribute names, and #theme, whose field names are the
 * CSS custom properties they set. This module only wires them to a <talkie-preview>.
 */

import '../lion.js';
import { mountShell, getBackendSettings } from '../shell.js';
import '../preview.js';
import { buildSnippet, DEFAULTS } from '../snippet.js';
import { listAgentProfiles, fetchAgentContext } from '../../../src/core/agent-profiles.js';
import { loadVoices, showVoice } from '../voices.js';

mountShell('playground');

/** The SDK's own fallbacks (src/components/*.js), so an untouched theme field shows reality. */
const THEME_DEFAULTS = {
  '--talkie-ink': '#101d20',
  '--talkie-ink-soft': '#4a5a58',
  '--talkie-paper': '#f7f5ec',
  '--talkie-surface': '#f6f4ec',
  '--talkie-launcher-bg': '#1c7f70',
  '--talkie-wave-color': '#ff8a4c',
  '--talkie-launcher-offset-right': 28,
  '--talkie-launcher-offset-bottom': 28,
  '--talkie-sheet-offset-bottom': 0,
};
const PX_TOKENS = new Set([
  '--talkie-launcher-offset-right', '--talkie-launcher-offset-bottom', '--talkie-sheet-offset-bottom',
]);

const $ = (id) => /** @type {any} */ (document.getElementById(id));
const configForm = $('config');
const themeForm = $('theme');
const statusLine = $('status-line');
const snippetCode = $('snippet-code');
const copyStatus = $('copy-status');
const backendBadge = $('backend-badge');
const eventLog = $('event-log');

let backend = getBackendSettings();
/** Theme tokens the user has changed; only these reach the preview and the snippet. */
const touched = new Set();
let preview = null;
let previewOpen = false;
let rebuildPending = false;
let rebuildTimer = 0;
let ready = false;

/* ---------------------------------------------------------------- initial values */

// Radios take their value from `choiceValue` (a property: ChoiceInputMixin), so set it here.
for (const radio of configForm.querySelectorAll('lion-radio[data-choice]')) {
  radio.choiceValue = radio.dataset.choice;
}

function field(form, name) {
  return form.querySelector(`[name="${CSS.escape(name)}"]`);
}

function setConfigDefaults() {
  field(configForm, 'api').modelValue = backend.backend === 'live' ? backend.api : DEFAULTS.api;
  field(configForm, 'mode').modelValue = DEFAULTS.mode;
  field(configForm, 'idle-timeout').modelValue = Number(DEFAULTS['idle-timeout']);
  field(configForm, 'barge-in').checked = true;
  field(configForm, 'layout').modelValue = DEFAULTS.layout;
  field(configForm, 'fonts').checked = false;
}

function setThemeDefaults() {
  for (const [name, value] of Object.entries(THEME_DEFAULTS)) field(themeForm, name).modelValue = value;
}

/** Show each colour's hex beside its swatch; the native colour input only shows the colour. */
function addHexReadouts() {
  for (const colorField of themeForm.querySelectorAll('lion-input[type="color"]')) {
    const hex = document.createElement('span');
    hex.slot = 'prefix'; // inside Lion's input row, so it sits beside the swatch, not under it
    hex.className = 'color-hex';
    colorField.append(hex);
    colorField.requestUpdate(); // Lion renders the prefix slot only once it has a child
    const sync = () => { hex.textContent = String(colorField.modelValue ?? '').toLowerCase(); };
    colorField.addEventListener('model-value-changed', sync);
    sync();
  }
}

/* ---------------------------------------------------------------- reading state */

/** The config form as <talkie-assistant> attribute strings. */
function attrs() {
  const v = configForm.serializedValue;
  const text = (x) => (typeof x === 'string' ? x.trim() : '');
  return {
    api: text(v.api) || DEFAULTS.api,
    'token-url': text(v['token-url']),
    profile: text(v.profile),
    'system-prompt': text(v['system-prompt']),
    voice: text(v.voice),
    heading: text(v.heading),
    subtitle: text(v.subtitle),
    label: text(v.label),
    mode: v.mode || DEFAULTS.mode,
    'idle-timeout': String(v['idle-timeout'] ?? DEFAULTS['idle-timeout']),
    'barge-in': field(configForm, 'barge-in').checked ? 'on' : 'off',
    layout: v.layout || DEFAULTS.layout,
    fonts: field(configForm, 'fonts').checked ? 'google' : 'off',
  };
}

/** Touched theme tokens as CSS values. */
function theme() {
  const out = {};
  for (const name of touched) {
    const value = field(themeForm, name).modelValue;
    out[name] = PX_TOKENS.has(name) ? `${value}px` : String(value);
  }
  return out;
}

/* ---------------------------------------------------------------- preview */

function log(text) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  eventLog.prepend(li);
  while (eventLog.children.length > 50) eventLog.lastElementChild.remove();
}

function describe(detail) {
  if (!detail) return '';
  return JSON.stringify(detail, (_k, v) => (v instanceof Error ? v.message : v));
}

const LOGGED_EVENTS = [
  'talkie-state-change', 'talkie-transcript', 'talkie-response', 'talkie-error',
  'talkie-open', 'talkie-close', 'talkie-minimize', 'talkie-restore',
];

function applyTheme(el) {
  for (const name of Object.keys(THEME_DEFAULTS)) el.style.removeProperty(name);
  for (const [name, value] of Object.entries(theme())) el.style.setProperty(name, value);
}

function buildPreview() {
  preview?.remove(); // disconnecting ends the old agent session
  const a = attrs();
  const el = document.createElement('talkie-preview');
  el.setAttribute('backend', backend.backend);
  el.setAttribute('api', backend.backend === 'live' ? backend.api : a.api);
  for (const [name, value] of Object.entries(a)) {
    if (name === 'api' || value === '') continue;
    el.setAttribute(name, value);
  }
  applyTheme(el);
  for (const type of LOGGED_EVENTS) {
    el.addEventListener(type, (e) => log(`${type.slice(7)} ${describe(e.detail)}`));
  }
  el.addEventListener('talkie-open', () => { previewOpen = true; });
  el.addEventListener('talkie-close', () => {
    previewOpen = false;
    if (rebuildPending) {
      rebuildPending = false;
      buildPreview();
    }
    renderStatus();
  });
  document.body.append(el);
  preview = el;
}

/** Attributes are read when the assistant opens, so a change needs a fresh element. */
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    if (previewOpen) rebuildPending = true;
    else buildPreview();
    renderStatus();
  }, 300);
}

/* ---------------------------------------------------------------- snippet and status */

function snippet() {
  return buildSnippet({ attrs: attrs(), theme: theme() });
}

function renderSnippet() {
  snippetCode.textContent = snippet();
}

function renderStatus() {
  const live = backend.backend === 'live';
  backendBadge.textContent = live ? 'Live' : 'Mock';
  backendBadge.toggleAttribute('data-live', live);
  const where = live
    ? `Talks to ${backend.api}.`
    : 'Scripted answers, no microphone. Switch on Live voice server to talk to a real one.';
  statusLine.textContent = rebuildPending ? `${where} Your changes apply when the assistant closes.` : where;
}

/* ---------------------------------------------------------------- events */

configForm.addEventListener('model-value-changed', () => {
  if (!ready) return;
  renderSnippet();
  scheduleRebuild();
});

themeForm.addEventListener('model-value-changed', (e) => {
  if (!ready) return;
  // The form re-dispatches its fields' events; the field that changed is formPath[0].
  const name = e.detail?.formPath?.[0]?.name;
  if (name in THEME_DEFAULTS) touched.add(name);
  renderSnippet();
  // Custom properties inherit into the shadow DOM, so no rebuild is needed.
  if (preview) applyTheme(preview);
});

$('theme-reset').addEventListener('click', () => {
  ready = false;
  touched.clear();
  setThemeDefaults();
  requestAnimationFrame(() => { ready = true; });
  renderSnippet();
  if (preview) applyTheme(preview);
});

$('btn-open').addEventListener('click', () => preview?.open());
$('btn-minimize').addEventListener('click', () => preview?.minimize());
$('btn-restore').addEventListener('click', () => preview?.restore());
$('btn-close').addEventListener('click', () => preview?.close());
$('btn-clear').addEventListener('click', () => eventLog.replaceChildren());

$('btn-preview').addEventListener('click', () => preview?.open());

let copyTimer = 0;
const copyBtn = $('btn-copy');
copyBtn.addEventListener('click', async () => {
  clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(snippet());
    copyStatus.textContent = 'Copied to clipboard.';
    copyStatus.dataset.kind = 'ok';
    // The button is where the eye is; the status line below it is for screen readers too.
    copyBtn.textContent = 'Copied ✓';
    copyBtn.dataset.copied = '';
  } catch {
    copyStatus.textContent = 'Copy failed. Select the snippet and copy it by hand.';
    copyStatus.dataset.kind = 'error';
  }
  copyTimer = setTimeout(() => {
    copyStatus.textContent = '';
    copyBtn.textContent = 'Copy';
    delete copyBtn.dataset.copied;
  }, 2500);
});

window.addEventListener('talkie-site-backend', ({ detail }) => {
  backend = detail;
  renderStatus();
  scheduleRebuild();
});

/* ---------------------------------------------------------------- server personas */

// The Profile field suggests the live server's personas. Only when live: without a server
// the request would just fail, and the mock backend ignores the profile anyway.
const profileField = field(configForm, 'profile');
const PROFILE_HELP = profileField.getAttribute('help-text');
/** Persona names from the last successful list load. */
let serverPersonas = new Set();
const personaList = document.createElement('datalist');
personaList.id = 'server-personas';
document.body.append(personaList);

async function suggestPersonas() {
  const input = profileField.querySelector('input');
  if (backend.backend !== 'live') {
    personaList.replaceChildren();
    serverPersonas = new Set();
    profileField.helpText = PROFILE_HELP;
    return;
  }
  input?.setAttribute('list', personaList.id);
  try {
    const { default: def, profiles } = await listAgentProfiles({ api: backend.api });
    serverPersonas = new Set(profiles.map((p) => p.name));
    personaList.replaceChildren(...profiles.map(({ name, description }) => {
      const option = document.createElement('option');
      option.value = name;
      option.label = description ? `${name} — ${description}` : name;
      return option;
    }));
    profileField.helpText = profiles.length
      ? `On the server: ${profiles.map((p) => (p.name === def ? `${p.name} (default)` : p.name)).join(', ')}`
      : 'The server has no personas yet; create one in the Persona console.';
  } catch (err) {
    personaList.replaceChildren();
    serverPersonas = new Set();
    profileField.helpText = `${PROFILE_HELP}. Couldn't list the server's personas: ${err.message}`;
  }
}

window.addEventListener('talkie-site-backend', () => suggestPersonas());

// Picking one of the server's personas fills the fields it defines, so what the snippet and
// the preview show matches that persona (and can be edited from there).
const promptField = field(configForm, 'system-prompt');
const voiceField = field(configForm, 'voice');
let personaTimer = 0;
let personaRequest = 0;

async function fillFromPersona(name) {
  const request = ++personaRequest;
  try {
    const ctx = await fetchAgentContext({ api: backend.api, profile: name });
    if (request !== personaRequest) return; // another persona was picked meanwhile
    promptField.modelValue = ctx.system_prompt ?? '';
    showVoice(voiceField, ctx.voice ?? '');
    voiceField.modelValue = ctx.voice ?? '';
    profileField.helpText = `Filled from "${name}" on the server.`;
  } catch (err) {
    if (request === personaRequest) profileField.helpText = `Couldn't load "${name}": ${err.message}`;
  }
}

profileField.addEventListener('model-value-changed', () => {
  if (!ready) return;
  clearTimeout(personaTimer);
  const name = (profileField.modelValue ?? '').trim();
  if (!serverPersonas.has(name)) return;
  personaTimer = setTimeout(() => fillFromPersona(name), 300);
});

const VOICE_EMPTY = "Profile's voice";
window.addEventListener('talkie-site-backend', ({ detail }) => loadVoices(voiceField, detail.api, VOICE_EMPTY));

/* ---------------------------------------------------------------- start */

// Lion fields settle their initial values asynchronously; ignore the change events that causes.
await Promise.all([configForm.updateComplete, themeForm.updateComplete]);
setConfigDefaults();
addHexReadouts();
setThemeDefaults();
requestAnimationFrame(() => { ready = true; });
renderSnippet();
renderStatus();
buildPreview();
suggestPersonas();
loadVoices(voiceField, backend.api, VOICE_EMPTY);
