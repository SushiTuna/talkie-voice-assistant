/**
 * Persona Console — list + editor for voice-agent persona profiles.
 */

import '../lion.js';
import { mountShell, getBackendSettings } from '../shell.js';
import '../preview.js';
import {
  validateTools, slugify, toAgentContext, fromAgentContext,
  toServerProfile, fromServerProfile, serverProfileProblems,
} from '../profile.js';
import { listAgentProfiles, fetchAgentContext, saveAgentProfile } from '../../../src/core/agent-profiles.js';
import { Required, Validator } from '@lion/ui/form-core.js';

mountShell('console');

/* =================================================================== storage */

const STORAGE_KEY = 'talkie-site:profiles';

const SEED_PROFILE = {
  id: crypto.randomUUID ? crypto.randomUUID() : 'seed-1',
  name: 'Product expert',
  description: '',
  systemPrompt: 'You are a friendly product expert. Answer in one or two short sentences.',
  voice: '',
  greeting: 'Hi! What would you like to know?',
  keyterms: '',
  tools: '',
};

function readProfiles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeProfiles(profiles) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch { /* best effort */ }
}

/* =================================================================== ValidTools */

class ValidTools extends Validator {
  static get validatorName() {
    return 'ValidTools';
  }

  execute(value) {
    if (!value || !value.trim()) return false;
    const result = validateTools(value);
    return !result.ok;
  }

  static getMessage({ modelValue }) {
    if (!modelValue || !modelValue.trim()) return '';
    const result = validateTools(modelValue);
    return result.ok ? '' : result.error;
  }
}

/* =================================================================== DOM refs */

const selectEl = document.getElementById('profile-select');
const selectInput = selectEl.querySelector('[slot="input"]');
const btnNew = document.getElementById('btn-new');
const btnDuplicate = document.getElementById('btn-duplicate');
const btnDelete = document.getElementById('btn-delete');
const formEl = document.getElementById('profile-form');
const formStatus = document.getElementById('form-status');
const btnExport = document.getElementById('btn-export');
const btnImport = document.getElementById('btn-import');
const btnTest = document.getElementById('btn-test');
const contextPreview = document.getElementById('context-preview');
const testLogCollapsible = document.getElementById('test-log-collapsible');
const testLogList = document.getElementById('test-log');
const deleteDialog = document.getElementById('delete-dialog');
const importDialog = document.getElementById('import-dialog');
const deleteConfirmMsg = document.getElementById('delete-confirm-message');
const mockNoteInfo = document.getElementById('mock-note-info');
const importTextarea = importDialog?.querySelector('lion-textarea');
const importFileInput = document.getElementById('import-file');
const importError = document.getElementById('import-error');

/* =================================================================== Validators on form fields */

// Set public validators property (not private _validators).
function setupValidators() {
  const fieldEls = formEl.querySelectorAll('lion-input, lion-textarea');
  fieldEls.forEach((el) => {
    const name = el.name;
    const validators = [];
    if (name === 'name' || name === 'systemPrompt') {
      validators.push(new Required());
    }
    if (name === 'tools') {
      validators.push(new ValidTools());
    }
    el.validators = validators;
  });
}

/* =================================================================== Profile management */

let currentId = null;
let saveTimer = null;
/** True while the page itself fills the form, so that doesn't count as an edit. */
let filling = false;

/** Fill the form without autosaving; Lion settles values asynchronously, so wait a frame. */
function fill(values) {
  filling = true;
  formEl.querySelectorAll('lion-input, lion-textarea').forEach((el) => {
    el.modelValue = values[el.name] ?? '';
  });
  requestAnimationFrame(() => { filling = false; });
}

/** Actions that need a saved profile are disabled without one. */
function updateActions() {
  btnDuplicate.disabled = !currentId;
  btnDelete.disabled = !currentId;
}

let statusTimer = 0;
/** One status line next to the editor title. `kind`: 'ok' | 'error' | '' (neutral). */
function setStatus(text, kind = '', { sticky = false } = {}) {
  clearTimeout(statusTimer);
  formStatus.textContent = text;
  formStatus.dataset.kind = kind;
  if (text && !sticky) statusTimer = setTimeout(() => { formStatus.textContent = ''; }, 3000);
}

function populateSelect() {
  const profiles = readProfiles();
  // Clear existing options except the first
  while (selectInput.options.length > 1) {
    selectInput.remove(1);
  }
  profiles.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || '(unnamed)';
    selectInput.appendChild(opt);
  });
  // Rebuilding the options drops the selection; keep showing the profile being edited.
  selectInput.value = currentId ?? '';
  updateActions();
}

function loadProfile(id) {
  const profiles = readProfiles();
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return;

  currentId = profile.id;
  selectInput.value = profile.id;

  fill(profile);
  updateActions();
  checkServerCopy(profile);

  updatePreview();
  clearSaveIndicator();
}

function saveCurrentForm() {
  const profiles = readProfiles();
  const data = getFormData();

  if (currentId) {
    // Update existing
    const idx = profiles.findIndex((p) => p.id === currentId);
    if (idx !== -1) {
      profiles[idx] = { ...profiles[idx], ...data };
    } else {
      profiles.push({ id: currentId, ...data });
    }
  } else {
    // New profile
    currentId = crypto.randomUUID ? crypto.randomUUID() : `prof-${Date.now()}`;
    profiles.push({ id: currentId, ...data });
  }

  writeProfiles(profiles);
  populateSelect();
  showSaved();
}

function getFormData() {
  const fieldMap = {
    name: 'name',
    description: 'description',
    systemPrompt: 'systemPrompt',
    greeting: 'greeting',
    voice: 'voice',
    keyterms: 'keyterms',
    tools: 'tools',
  };

  const data = {};
  Object.values(fieldMap).forEach((name) => {
    const field = formEl.querySelector(`[name="${name}"]`);
    if (field) data[name] = field.modelValue ?? '';
  });

  return data;
}

/* =================================================================== Autosave / Preview */

function scheduleAutosave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const hasErrors = checkFormErrors();
    if (!hasErrors) {
      saveCurrentForm();
    }
  }, 400);
}

function checkFormErrors() {
  const fieldEls = formEl.querySelectorAll('lion-input, lion-textarea');
  for (const el of fieldEls) {
    if (el.hasFeedbackFor && el.hasFeedbackFor.includes('error')) {
      return true;
    }
  }
  return false;
}

function clearSaveIndicator() {
  setStatus('');
}

function showSaved() {
  setStatus('Saved', 'ok');
}

function showUnsaved() {
  const names = [];
  const fieldEls = formEl.querySelectorAll('lion-input, lion-textarea');
  fieldEls.forEach((el) => {
    if (el.hasFeedbackFor && el.hasFeedbackFor.includes('error')) {
      names.push(el.label || el.name);
    }
  });
  setStatus(
    names.length ? `Not saved: fix ${names.join(', ')}` : 'Not saved: fix the highlighted fields',
    'error',
    { sticky: true },
  );
}

function updatePreview() {
  const data = getFormData();
  let ctx;
  try {
    ctx = toAgentContext(data);
  } catch {
    contextPreview.textContent = '—';
    return;
  }
  contextPreview.textContent = JSON.stringify(ctx, null, 2);
}

/* =================================================================== Event listeners */

// Select change
selectInput.addEventListener('change', () => {
  if (selectInput.value) {
    loadProfile(selectInput.value);
  } else {
    currentId = null;
    fill({});
    updateActions();
    updatePreview();
    clearSaveIndicator();
  }
});

// Form field changes → autosave
formEl.addEventListener('model-value-changed', () => {
  updatePreview();
  if (filling) return;
  scheduleAutosave();
  if (checkFormErrors()) {
    showUnsaved();
  } else {
    setStatus('Saving…', '', { sticky: true });
  }
});

// New profile
btnNew.addEventListener('click', () => {
  // Clear form
  currentId = null;
  fill({});
  selectInput.value = '';
  updateActions();
  updatePreview();
  setStatus('New profile: give it a name and a system prompt to save it.', '', { sticky: true });
  // Focus name field
  const nameField = formEl.querySelector('[name="name"]');
  if (nameField) nameField.focus();
});

// Duplicate
btnDuplicate.addEventListener('click', () => {
  const profiles = readProfiles();
  const current = profiles.find((p) => p.id === currentId);
  if (!current) return;

  const dup = { ...current, id: crypto.randomUUID ? crypto.randomUUID() : `prof-${Date.now()}`, name: `${current.name} (copy)` };
  profiles.push(dup);
  writeProfiles(profiles);
  currentId = dup.id;
  populateSelect();
  loadProfile(dup.id);
  setStatus(`Duplicated as "${dup.name}"`, 'ok');
});

// Delete with confirmation dialog
btnDelete.addEventListener('click', () => {
  if (!currentId) return;
  openDeleteDialog();
});

function openDeleteDialog() {
  const profile = readProfiles().find((p) => p.id === currentId);
  deleteConfirmMsg.textContent = `"${profile?.name || 'This profile'}" will be removed from this browser. Export it first if you may need it again.`;
  deleteDialog.open();
  // Default to the safe choice.
  requestAnimationFrame(() => document.querySelector('#delete-dialog .cancel-btn')?.focus());
}

document.querySelector('#delete-dialog .cancel-btn').addEventListener('click', () => {
  deleteDialog.close();
});

document.querySelector('#delete-dialog .danger-btn').addEventListener('click', async () => {
  await deleteProfile();
  deleteDialog.close();
});

function deleteProfile() {
  if (!currentId) return;
  const all = readProfiles();
  const name = all.find((p) => p.id === currentId)?.name;
  const profiles = all.filter((p) => p.id !== currentId);
  writeProfiles(profiles);
  currentId = null;
  // Land on another profile rather than an empty form.
  const next = profiles[profiles.length - 1];
  if (next) {
    populateSelect();
    loadProfile(next.id);
  } else {
    fill({});
    populateSelect();
    updatePreview();
  }
  setStatus(`Deleted "${name || 'profile'}"`, 'ok');
}

// Export
btnExport.addEventListener('click', () => {
  const data = getFormData();
  if (!data.name || !data.systemPrompt) {
    setStatus('Add a name and a system prompt before exporting.', 'error');
    return;
  }

  // The voice server's own file format, so the download can go straight into agents/.
  const filename = `${slugify(data.name) || 'persona'}.json`;
  const blob = new Blob([JSON.stringify(toServerProfile(data), null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus(`Exported ${filename}: put it in the voice server's agents/ folder`, 'ok');
});

// Import
btnImport.addEventListener('click', () => {
  openImportDialog();
});

function openImportDialog() {
  importTextarea.modelValue = '';
  importFileInput.value = '';
  importFileName = '';
  importError.textContent = '';
  importDialog.open();
}

document.querySelector('#import-dialog .cancel-btn').addEventListener('click', () => {
  importDialog.close();
});

/** A profile file carries no name of its own; its file name is the profile name. */
let importFileName = '';

// A chosen file fills the textarea, so the JSON can be checked before importing.
importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files?.[0];
  if (!file) return;
  importError.textContent = '';
  importFileName = file.name.replace(/\.json$/i, '');
  try {
    importTextarea.modelValue = await file.text();
  } catch (err) {
    importError.textContent = `Couldn't read ${file.name}: ${err.message}`;
  }
});

document.querySelector('#import-dialog .import-btn').addEventListener('click', () => {
  const jsonStr = importTextarea.modelValue ?? '';
  if (!jsonStr.trim()) {
    importError.textContent = 'Please paste JSON or upload a file.';
    return;
  }

  try {
    const parsed = JSON.parse(jsonStr);
    importProfile(parsed);
  } catch (err) {
    importError.textContent = `Invalid JSON: ${err.message}`;
  }
});

function importProfile(json) {
  try {
    // Either a voice-server profile file (agents/*.json) or an /agent/context reply.
    const isServerFile = 'system_prompt_override' in json || 'agent' in json;
    let form;
    if (isServerFile) {
      form = fromServerProfile(json, json.name || importFileName || 'imported');
    } else {
      if (!json.profile && !json.name) throw new Error('Missing profile name');
      if (!json.system_prompt && !json.systemPrompt) throw new Error('Missing system prompt');
      form = fromAgentContext(json);
    }

    // Preserve tools: carry across exactly what was in the source JSON
    if (json.tools != null && typeof json.tools === 'string') {
      form.tools = json.tools;
    } else if (typeof json.tools === 'object' && json.tools) {
      // If tools was an array, convert back to JSON string
      form.tools = JSON.stringify(json.tools, null, 2);
    } else {
      form.tools = '';
    }

    const profiles = readProfiles();
    const newProfile = {
      id: crypto.randomUUID ? crypto.randomUUID() : `prof-${Date.now()}`,
      ...form,
    };
    profiles.push(newProfile);
    writeProfiles(profiles);
    populateSelect();
    currentId = newProfile.id;
    populateSelect();
    loadProfile(newProfile.id);
    importDialog.close();
    setStatus(`Imported "${newProfile.name}"`, 'ok');
  } catch (err) {
    importError.textContent = err.message;
  }
}

/* =================================================================== Confirm dialog */

const confirmDialog = document.getElementById('confirm-dialog');

/** Ask before a destructive step; resolves true only for the confirm button. */
function confirmAction({ title, message, confirm }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      confirmDialog.removeEventListener('opened-changed', onToggle);
      if (confirmDialog.opened) confirmDialog.close();
      resolve(value);
    };
    // Escape or a click outside closes it too: that is a no.
    const onToggle = () => { if (!confirmDialog.opened) done(false); };
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    const ok = confirmDialog.querySelector('.confirm-btn');
    ok.textContent = confirm;
    ok.onclick = () => done(true);
    confirmDialog.querySelector('.cancel-btn').onclick = () => done(false);
    confirmDialog.open();
    confirmDialog.addEventListener('opened-changed', onToggle);
    requestAnimationFrame(() => confirmDialog.querySelector('.cancel-btn').focus());
  });
}

/* =================================================================== Personas on the voice server */

const FORM_FIELDS = ['name', 'description', 'systemPrompt', 'greeting', 'voice', 'keyterms', 'tools'];
const serverStatus = document.getElementById('server-status');
const driftBox = document.getElementById('server-drift');
const driftText = document.getElementById('server-drift-text');
/** Names from the last successful list load; empty until then. */
let serverNames = new Set();
const serverList = document.getElementById('server-list');
const btnServerLoad = document.getElementById('btn-server-load');

function setServerStatus(text, kind = '') {
  serverStatus.textContent = text;
  serverStatus.dataset.kind = kind;
}

const serverApi = () => getBackendSettings().api;

/** The local profile that mirrors server profile `name`, matched the way Send names files. */
const localCopyOf = (name, profiles = readProfiles()) => profiles.find((p) => slugify(p.name || '') === name);

const sameForm = (a, b) => FORM_FIELDS.every((k) => (a[k] ?? '') === (b[k] ?? ''));

async function loadServerList() {
  const api = serverApi();
  btnServerLoad.disabled = true;
  setServerStatus(`Loading from ${api}…`);
  try {
    const { default: def, profiles } = await listAgentProfiles({ api });
    serverNames = new Set(profiles.map((p) => p.name));
    renderServerList(profiles, def);
    const current = readProfiles().find((p) => p.id === currentId);
    if (current) checkServerCopy(current);
    setServerStatus(profiles.length
      ? `${profiles.length} persona${profiles.length > 1 ? 's' : ''} on ${api}.`
      : `No personas on ${api} yet. Send one to create it.`);
  } catch (err) {
    serverList.replaceChildren();
    serverNames = new Set();
    driftBox.hidden = true;
    setServerStatus(err.message, 'error');
  } finally {
    btnServerLoad.disabled = false;
    btnServerLoad.textContent = 'Refresh';
  }
}

function renderServerList(profiles, def) {
  const local = readProfiles();
  serverList.replaceChildren(...profiles.map(({ name, description }) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'server-item';
    btn.title = `Open "${name}" in the editor`;
    const title = document.createElement('span');
    title.className = 'server-item-name';
    title.textContent = name;
    if (name === def) title.append(badge('default'));
    if (localCopyOf(name, local)) title.append(badge('in this browser'));
    const desc = document.createElement('span');
    desc.className = 'server-item-desc';
    desc.textContent = description || 'No description';
    btn.append(title, desc);
    btn.addEventListener('click', () => openServerPersona(name, btn));
    li.append(btn);
    return li;
  }));
}

function badge(text) {
  const b = document.createElement('span');
  b.className = 'mini-badge';
  b.textContent = text;
  return b;
}

/** Server context → the console's local profile record. */
const recordFromContext = (ctx, name) => ({
  ...Object.fromEntries(FORM_FIELDS.map((k) => [k, ''])),
  ...fromAgentContext(ctx),
  serverName: name,
  promptSource: ctx.prompt_source === 'override' ? 'override' : 'composed',
});

/**
 * The local copy is not refreshed by itself, so say when it differs from the server's (the
 * server changed, or this copy was edited) and offer the server's version.
 */
async function checkServerCopy(profile) {
  const name = profile.serverName || slugify(profile.name || '');
  driftBox.hidden = true;
  if (!name || !serverNames.has(name)) return;
  const id = profile.id;
  let ctx;
  try {
    ctx = await fetchAgentContext({ api: serverApi(), profile: name });
  } catch {
    return; // the list load already reports an unreachable server
  }
  if (currentId !== id) return; // moved on while it loaded
  const local = readProfiles().find((p) => p.id === id);
  if (!local || sameForm(local, recordFromContext(ctx, name))) return;
  const toolsDiffer = (local.tools ?? '') !== (recordFromContext(ctx, name).tools ?? '');
  driftText.textContent = `This copy of "${name}" differs from the one on the voice server${
    toolsDiffer ? ', including its tools' : ''}: the server's may have changed, or you edited this one.`;
  driftBox.hidden = false;
  driftBox.dataset.name = name;
}

document.getElementById('btn-server-sync').addEventListener('click', (e) => {
  // The notice is the confirmation; don't ask twice.
  openServerPersona(driftBox.dataset.name, e.currentTarget, { confirm: false });
});

/** Fetch one persona and make it the profile being edited, as a local copy. */
async function openServerPersona(name, btn, { confirm = true } = {}) {
  btn.disabled = true;
  try {
    const ctx = await fetchAgentContext({ api: serverApi(), profile: name });
    const record = recordFromContext(ctx, name);
    const profiles = readProfiles();
    const existing = localCopyOf(name, profiles);
    if (confirm && existing && !sameForm(existing, record)) {
      const ok = await confirmAction({
        title: `Replace your copy of "${existing.name}"?`,
        message: 'The copy in this browser differs from the one on the voice server. Loading replaces it with the server version.',
        confirm: 'Replace',
      });
      if (!ok) return;
    }
    let id;
    if (existing) {
      Object.assign(existing, record);
      id = existing.id;
    } else {
      id = crypto.randomUUID ? crypto.randomUUID() : `prof-${Date.now()}`;
      profiles.push({ id, ...record });
    }
    writeProfiles(profiles);
    currentId = id;
    populateSelect();
    loadProfile(id);
    setStatus(`Loaded "${name}" from the voice server`, 'ok');
    loadServerList();
  } catch (err) {
    setServerStatus(`Couldn't open "${name}": ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

btnServerLoad.addEventListener('click', loadServerList);

/* =================================================================== Send to voice server */

const TOKEN_KEY = 'talkie-site:profile-admin-token';
const sendDialog = document.getElementById('send-dialog');
const sendTarget = document.getElementById('send-target');
const sendApi = document.getElementById('send-api');
const sendToken = document.getElementById('send-token');
const sendError = document.getElementById('send-error');
const sendBtn = document.querySelector('#send-dialog .send-btn');
/** Set after the server says the profile exists: the next send replaces it. */
let confirmOverwrite = false;

function readToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function writeToken(token) {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* best effort */ }
}

function renderSendTarget() {
  const api = (sendApi.modelValue || '').trim().replace(/\/+$/, '');
  const name = slugify(getFormData().name || '');
  sendTarget.textContent = `Saves "${name}" as agents/${name}.json on ${api || 'the server'}. It is then served from /agent/context?profile=${name}.`;
}

function resetOverwrite() {
  confirmOverwrite = false;
  sendBtn.textContent = 'Send';
  sendBtn.classList.remove('danger');
}

document.getElementById('btn-send').addEventListener('click', () => {
  const data = getFormData();
  const problems = serverProfileProblems(data);
  if (problems.length) {
    setStatus(`Before sending, add ${problems.join(', ')}.`, 'error');
    return;
  }
  if (checkFormErrors()) {
    showUnsaved();
    return;
  }
  sendApi.modelValue = getBackendSettings().api;
  sendToken.modelValue = readToken();
  sendError.textContent = '';
  resetOverwrite();
  renderSendTarget();
  // A prompt built from sections comes back here only as finished text; sending it writes
  // that text as an override, and the sections stop being used.
  const current = readProfiles().find((p) => p.id === currentId);
  document.getElementById('send-warning').textContent =
    current?.promptSource === 'composed' && current.serverName === slugify(data.name)
      ? `On the server, "${current.serverName}" builds its prompt from sections (agent, knowledge, style…). Sending replaces them with this fixed prompt.`
      : '';
  sendDialog.open();
  requestAnimationFrame(() => (sendToken.modelValue ? sendBtn : sendToken).focus());
});

sendApi.addEventListener('model-value-changed', () => {
  renderSendTarget();
  resetOverwrite();
});
document.querySelector('#send-dialog .cancel-btn').addEventListener('click', () => sendDialog.close());

sendBtn.addEventListener('click', async () => {
  const data = getFormData();
  const api = (sendApi.modelValue || '').trim();
  const adminToken = (sendToken.modelValue || '').trim();
  if (!api) { sendError.textContent = 'Enter the voice server URL.'; return; }
  if (!adminToken) { sendError.textContent = 'Enter the admin token.'; return; }

  const name = slugify(data.name);
  sendError.textContent = '';
  sendBtn.disabled = true;
  sendBtn.textContent = confirmOverwrite ? 'Replacing…' : 'Sending…';
  try {
    const { replaced } = await saveAgentProfile({
      api, name, adminToken, overwrite: confirmOverwrite, profile: toServerProfile(data),
    });
    writeToken(adminToken);
    sendDialog.close();
    const tools = validateTools(data.tools);
    const toolsNote = tools.ok && tools.tools.length
      ? ` ${tools.tools.length === 1 ? 'Its tool is' : `Its ${tools.tools.length} tools are`} served too; the page embedding it needs an onToolCall handler.`
      : '';
    setStatus(`${replaced ? 'Replaced' : 'Created'} "${name}" on the voice server.${toolsNote}`, 'ok', { sticky: !!toolsNote });
    addLogEntry(`📤 Sent "${name}" to ${api} (${replaced ? 'replaced' : 'created'})`);
    driftBox.hidden = true; // this copy is now what the server has
    const sent = readProfiles();
    const record = sent.find((p) => p.id === currentId);
    if (record) {
      Object.assign(record, { serverName: name, promptSource: 'override' });
      writeProfiles(sent);
    }
    if (serverList.children.length || serverStatus.dataset.kind === 'error') loadServerList();
  } catch (err) {
    if (err.code === 'exists') {
      confirmOverwrite = true;
      sendError.textContent = `The server already has a profile named "${name}". Replace it? This cannot be undone.`;
      sendBtn.disabled = false;
      sendBtn.textContent = 'Replace';
      sendBtn.classList.add('danger');
      return;
    }
    const hints = {
      disabled: ' Set TALKIE_PROFILE_ADMIN_TOKEN on the voice server and restart it.',
      unauthorized: ' Check the admin token.',
    };
    sendError.textContent = `${err.message}${hints[err.code] ?? ''}`;
    resetOverwrite();
  } finally {
    sendBtn.disabled = false;
  }
});

// Test
btnTest.addEventListener('click', () => {
  runTest();
});

let activePreview = null;
const testLogEntries = [];

function runTest() {
  // Remove previous preview (and its listeners) before adding another.
  if (activePreview && activePreview.parentNode) {
    activePreview.parentNode.removeChild(activePreview);
  }
  activePreview = null;

  const settings = getBackendSettings();
  const data = getFormData();

  const preview = document.createElement('talkie-preview');
  preview.setAttribute('backend', settings.backend);
  if (settings.api !== 'http://localhost:8000') {
    preview.setAttribute('api', settings.api);
  }

  // Set attributes inherited by TalkieAssistant.
  if (data.systemPrompt) {
    preview.setAttribute('system-prompt', data.systemPrompt);
  }
  if (data.voice) {
    preview.setAttribute('voice', data.voice);
  }

  const toolResult = validateTools(data.tools);
  if (toolResult.ok && toolResult.tools.length > 0) {
    preview.tools = toolResult.tools;
  }

  preview.onToolCall = (call) => {
    addLogEntry(`🔧 Tool called: ${call.name || call.fn?.name || 'unknown'} (${JSON.stringify(call.args || call.arguments || {})})`);
    return { ok: true, note: 'Console test: tool not executed' };
  };

  const stateChangeHandler = ({ detail }) => {
    addLogEntry(`📡 State change: ${JSON.stringify(detail)}`);
  };

  // Listen on the element itself; talkie-close closes via the preview's own listener.
  preview.addEventListener('talkie-state-change', stateChangeHandler);

  preview.addEventListener('talkie-close', () => {
    if (activePreview && activePreview.parentNode) {
      activePreview.parentNode.removeChild(activePreview);
    }
    activePreview = null;
    preview.removeEventListener('talkie-state-change', stateChangeHandler);
  });

  testLogCollapsible.opened = true;
  addLogEntry(`▶️ Testing "${data.name || 'unsaved profile'}" on the ${settings.backend === 'live' ? `live server (${settings.api})` : 'mock backend'}`);

  // Open immediately
  setTimeout(() => {
    preview.open();
    if (settings.backend === 'mock') {
      addLogEntry('ℹ️ Mock backend replies with scripted answers; your prompt is only used with a live voice server');
    }
  }, 100);

  document.body.appendChild(preview);
  activePreview = preview;
}

function addLogEntry(text) {
  testLogEntries.unshift({ text, time: new Date().toLocaleTimeString() });
  if (testLogEntries.length > 50) testLogEntries.pop();
  renderTestLog();
}

function renderTestLog() {
  const items = testLogEntries.map((entry) => {
    const li = document.createElement('li');
    li.textContent = `${entry.time || '--'} — ${entry.text}`;
    return li;
  });
  testLogList.replaceChildren(...items);
}

/* =================================================================== Init */

setupValidators();
populateSelect();

// Load seeded profile if none exist
if (readProfiles().length === 0) {
  writeProfiles([SEED_PROFILE]);
  populateSelect();
  loadProfile(SEED_PROFILE.id);
} else {
  // Select the last profile
  const profiles = readProfiles();
  const lastProfile = profiles[profiles.length - 1];
  if (lastProfile) {
    selectInput.value = lastProfile.id;
    loadProfile(lastProfile.id);
  }
}

updatePreview();
updateActions();

function renderMockNote(settings) {
  mockNoteInfo.textContent = settings.backend === 'mock'
    ? 'Test runs on the mock backend: scripted answers, so your prompt has no effect. Switch on Live voice server to hear it.'
    : '';
}
renderMockNote(getBackendSettings());

// With a live server expected, show its personas straight away; otherwise wait for Load,
// so a visitor without one does not get a connection error on arrival.
setServerStatus('Load the personas your voice server has, and open any of them here.');
if (getBackendSettings().backend === 'live') loadServerList();

// Backend switch → update mock note text, and follow a live server's URL.
window.addEventListener('talkie-site-backend', ({ detail }) => {
  renderMockNote(detail);
  if (detail.backend === 'live') loadServerList();
});
