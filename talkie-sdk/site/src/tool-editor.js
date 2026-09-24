/**
 * The console's tool editor: a list of tools (name, description, Edit), a dialog that edits one
 * tool at a time, and a switch to the raw JSON.
 *
 * The "Tools (JSON)" lion-textarea stays the single source of truth. Saving the dialog writes
 * JSON into it (so autosave, validation and the context preview work as before), and the list
 * re-reads it whenever something else changes it: loading a profile, an import, or edits in the
 * JSON view. When the JSON cannot be shown as a form without losing something, the editor stays
 * on JSON and says why.
 *
 * The dialog edits a copy: Save applies it (only once it is valid), Cancel or Escape drop it.
 * Plain DOM controls, not Lion fields: Lion fields register with the nearest form by name, and the
 * console reads and fills its form by those names.
 */

import {
  PARAM_TYPES, ENUM_TYPES, blankTool, blankParam, parseTools, serializeTools, toolProblems,
} from './tool-model.js';

let uid = 0;

/** createElement with properties, attributes (`attrs`) and children. */
function el(tag, { attrs = {}, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children.filter((c) => c != null));
  return node;
}

/** Focus once the dialog (or the page behind it) has rendered, as the console's dialogs do. */
const later = (fn) => requestAnimationFrame(fn);

/**
 * @param {HTMLElement} host   the editor's container (console.html, #tool-editor)
 * @param {any} field          the lion-textarea named "tools"
 * @param {any} dialog         the lion-dialog that edits one tool (console.html, #tool-dialog)
 * @returns {{ hasProblems: () => boolean }}
 */
export function mountToolEditor(host, field, dialog) {
  const btnForm = host.querySelector('[data-mode="form"]');
  const btnJson = host.querySelector('[data-mode="json"]');
  const note = host.querySelector('.tool-editor-note');
  const list = host.querySelector('.tool-list');
  const formView = host.querySelector('.tool-form');
  const btnAdd = host.querySelector('.tool-add');

  const dialogTitle = dialog.querySelector('.tool-dialog-title');
  const dialogBody = dialog.querySelector('.tool-dialog-body');
  const btnSave = dialog.querySelector('.save-btn');
  const btnCancel = dialog.querySelector('.cancel-btn');
  const btnDelete = dialog.querySelector('.delete-btn');

  let mode = 'form';
  /** The view the user chose; a profile the form can't show only overrides it while it's open. */
  let preferred = 'form';
  let tools = [];
  /** The JSON this editor last wrote, to tell its own writes from outside changes. */
  let written = null;
  /** One step of undo for a deleted tool. */
  let undo = null;

  /** The tool being edited: its index (null for a new one) and a working copy. */
  let draft = null;
  /** Where focus goes when the dialog closes. */
  let focusAfterClose = null;
  /** Field key → { input, error, obj, prop } for the dialog's fields. */
  let fields = new Map();
  /** Errors show for fields the user has left, and for all of them after a Save attempt. */
  let touched = new WeakMap();
  let showAll = false;

  /* ------------------------------------------------------------- mode */

  function setMode(next, { focus = false } = {}) {
    if (next === 'form') {
      const parsed = parseTools(field.modelValue ?? '');
      if (!parsed.ok) {
        showNote(`The form can't show these tools: ${parsed.error} Edit them as JSON, or fix them and switch back.`);
        next = 'json';
      } else {
        tools = parsed.tools;
        renderList();
      }
    }
    mode = next;
    btnForm.setAttribute('aria-pressed', String(mode === 'form'));
    btnJson.setAttribute('aria-pressed', String(mode === 'json'));
    formView.hidden = mode !== 'form';
    field.hidden = mode !== 'json';
    if (mode === 'form') clearNote();
    if (focus) (mode === 'form' ? btnForm : field).focus();
  }

  btnForm.addEventListener('click', () => {
    preferred = 'form';
    setMode('form', { focus: true });
  });
  btnJson.addEventListener('click', () => {
    preferred = 'json';
    clearNote();
    setMode('json');
  });

  function showNote(text, action = null) {
    note.replaceChildren(text, ...(action ? [' ', action] : []));
  }
  function clearNote() {
    undo = null;
    note.replaceChildren();
  }

  // Outside changes: a profile loaded, an import, or typing in the JSON view.
  field.addEventListener('model-value-changed', () => {
    if ((field.modelValue ?? '') === written) return;
    written = null;
    if (dialog.opened) dialog.close(); // its draft belongs to the tools that were replaced
    // Typing in the JSON view is read when switching back, not on every key.
    if (preferred === 'json' || (mode === 'json' && field.contains(document.activeElement))) return;
    clearNote();
    setMode('form');
  });

  function write() {
    written = serializeTools(tools);
    field.modelValue = written;
  }

  /* ------------------------------------------------------------- the list */

  function renderList() {
    const problems = toolProblems(tools);
    list.replaceChildren(...tools.map((tool, i) => {
      const flawed = [...problems.keys()].some((k) => k.startsWith(`tool:${i}:`) || k.startsWith(`param:${i}:`));
      const edit = el('button', {
        type: 'button', className: 'btn tool-edit', textContent: 'Edit',
        attrs: { 'aria-label': `Edit tool ${tool.name || i + 1}` },
      });
      edit.addEventListener('click', () => openDialog(i, edit));
      return el('li', { className: 'tool-row' },
        el('div', { className: 'tool-row-text' },
          el('span', { className: 'tool-row-name', textContent: tool.name || '(no name)' }),
          flawed ? el('span', { className: 'tool-row-flag', textContent: 'Needs fixing' }) : null,
          el('p', { className: 'tool-row-desc', textContent: tool.description || 'No description' })),
        edit);
    }));
    btnAdd.textContent = tools.length ? '+ Add another tool' : '+ Add a tool';
  }

  const editButton = (i) => list.querySelectorAll('.tool-edit')[i];

  btnAdd.addEventListener('click', () => openDialog(null, btnAdd));

  /* ------------------------------------------------------------- the dialog */

  function openDialog(index, opener) {
    const tool = index === null ? blankTool() : structuredClone(tools[index]);
    draft = { index, tool };
    touched = new WeakMap();
    // A saved tool with a problem shows it at once; a new one waits until the user has typed.
    showAll = index !== null;
    focusAfterClose = opener;
    dialogTitle.textContent = index === null ? 'Add a tool' : `Edit tool ${tools[index].name || index + 1}`;
    btnDelete.hidden = index === null;
    renderDialog();
    dialog.open();
    later(() => { if (draft) fields.get(key('tool', 'name'))?.input.focus(); });
  }

  /** The draft's position in the list, for toolProblems' keys. */
  const draftIndex = () => (draft.index === null ? tools.length : draft.index);
  const key = (kind, prop, j) => (kind === 'tool' ? `tool:${draftIndex()}:${prop}` : `param:${draftIndex()}:${j}:${prop}`);

  /** The draft's problems, checked against the other tools too (for duplicate names). */
  function draftProblems() {
    const all = [...tools];
    const i = draftIndex();
    all[i] = draft.tool;
    return new Map([...toolProblems(all)].filter(([k]) => k.startsWith(`tool:${i}:`) || k.startsWith(`param:${i}:`)));
  }

  function refreshErrors() {
    // A field's blur can land after the dialog closed (focus moving back to the list).
    if (!draft) return new Map();
    const problems = draftProblems();
    for (const [k, { input, error, obj, prop }] of fields) {
      const message = showAll || touched.get(obj)?.has(prop) ? problems.get(k) ?? '' : '';
      error.textContent = message;
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    return problems;
  }

  /** Wire a control to its error line; the hint, if any, is read before the error. */
  function register(k, input, obj, prop) {
    const error = el('p', { className: 'tool-error', id: `${input.id}-error` });
    const hint = input.getAttribute('aria-describedby');
    input.setAttribute('aria-describedby', hint ? `${hint} ${error.id}` : error.id);
    input.addEventListener('blur', () => {
      if (!touched.has(obj)) touched.set(obj, new Set());
      touched.get(obj).add(prop);
      refreshErrors();
    });
    fields.set(k, { input, error, obj, prop });
    return error;
  }

  function textInput(id, value, onInput, attrs = {}) {
    const input = el('input', { type: 'text', id, value, attrs: { autocomplete: 'off', spellcheck: 'false', ...attrs } });
    input.addEventListener('input', () => { onInput(input.value); refreshErrors(); });
    // Enter in a one-line field saves, as in any dialog form.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
    });
    return input;
  }

  function hintFor(input, text) {
    const hint = el('span', { className: 'tool-hint', id: `${input.id}-hint`, textContent: text });
    input.setAttribute('aria-describedby', hint.id);
    return hint;
  }

  /** A labelled field: label, optional hint, control, optional error line. */
  function labelled(className, label, input, hint, error) {
    return el('div', { className: `tool-field ${className}`.trim() },
      el('label', { htmlFor: input.id, textContent: label }),
      hint, input, error);
  }

  function renderDialog() {
    fields = new Map();
    const tool = draft.tool;
    const id = `tool-${++uid}`;

    const name = textInput(`${id}-name`, tool.name, (v) => { tool.name = v; }, { placeholder: 'show_room', 'aria-required': 'true' });
    const nameHint = hintFor(name, 'What the agent calls; letters, digits, _ and -.');
    const nameError = register(key('tool', 'name'), name, tool, 'name');

    const description = el('textarea', { id: `${id}-desc`, rows: 3, value: tool.description, attrs: { 'aria-required': 'true' } });
    description.addEventListener('input', () => { tool.description = description.value; refreshErrors(); });
    const descHint = hintFor(description, 'When to use it. The agent picks tools by this.');
    const descError = register(key('tool', 'description'), description, tool, 'description');

    const addParam = el('button', { type: 'button', className: 'btn tool-param-add', textContent: '+ Add parameter' });
    addParam.addEventListener('click', () => {
      tool.params.push(blankParam());
      renderDialog();
      fields.get(key('param', 'name', tool.params.length - 1))?.input.focus();
    });

    dialogBody.replaceChildren(
      labelled('', 'Name', name, nameHint, nameError),
      labelled('', 'Description', description, descHint, descError),
      el('div', { className: 'tool-params', attrs: { role: 'group', 'aria-labelledby': `${id}-params` } },
        el('h4', { className: 'tool-params-label', id: `${id}-params`, textContent: 'Parameters' }),
        tool.params.length
          ? null
          : el('p', { className: 'tool-hint', textContent: 'None: the agent calls this tool without arguments.' }),
        ...tool.params.map((p, j) => renderParam(tool, p, j)),
        addParam));
    refreshErrors();
  }

  function renderParam(tool, p, j) {
    const id = `param-${++uid}`;
    const n = j + 1;

    const name = textInput(`${id}-name`, p.name, (v) => { p.name = v; }, { placeholder: 'room', 'aria-required': 'true' });
    const nameError = register(key('param', 'name', j), name, p, 'name');

    const types = PARAM_TYPES.includes(p.type) ? PARAM_TYPES : [...PARAM_TYPES, p.type];
    const type = el('select', { id: `${id}-type` }, ...types.map((t) => el('option', { value: t, textContent: t })));
    type.value = p.type;

    const required = el('input', { type: 'checkbox', id: `${id}-req`, checked: p.required });
    required.addEventListener('change', () => { p.required = required.checked; });

    const description = textInput(`${id}-desc`, p.description, (v) => { p.description = v; }, { placeholder: 'Which room to show' });

    // JSON Schema `enum`: offered for the types whose values can be listed.
    const allowed = textInput(`${id}-enum`, p.enumText, (v) => { p.enumText = v; }, { placeholder: 'kitchen, lobby, garden' });
    const allowedHint = hintFor(allowed, 'Comma-separated. Leave empty to accept any value.');
    const allowedError = register(key('param', 'enum', j), allowed, p, 'enumText');
    const allowedField = labelled('tool-param-enum', 'Allowed values', allowed, allowedHint, allowedError);
    allowedField.hidden = !ENUM_TYPES.includes(p.type);

    type.addEventListener('change', () => {
      p.type = type.value;
      allowedField.hidden = !ENUM_TYPES.includes(p.type);
      refreshErrors();
    });

    const remove = el('button', {
      type: 'button', className: 'btn tool-param-remove', textContent: 'Remove',
      attrs: { 'aria-label': `Remove parameter ${n}${p.name ? ` (${p.name})` : ''}` },
    });
    remove.addEventListener('click', () => {
      tool.params.splice(j, 1);
      renderDialog();
      // Land on the parameter that took its place, or on Add parameter.
      (fields.get(key('param', 'name', j))?.input ?? dialogBody.querySelector('.tool-param-add')).focus();
    });

    // Schema the form has no field for is kept; say so, so it is not a surprise in the JSON.
    const kept = Object.keys(p.extra);
    return el('div', { className: 'tool-param', attrs: { role: 'group', 'aria-label': `Parameter ${n}` } },
      el('div', { className: 'tool-param-top' },
        labelled('tool-param-name', 'Name', name, null, nameError),
        labelled('tool-param-type', 'Type', type, null, null),
        el('div', { className: 'tool-param-req' }, required, el('label', { htmlFor: required.id, textContent: 'Required' })),
        remove),
      labelled('tool-param-desc', 'Description', description, null, null),
      allowedField,
      kept.length ? el('p', { className: 'tool-hint', textContent: `Also has ${kept.join(', ')}; edit that in JSON.` }) : null);
  }

  /* ------------------------------------------------------------- save / cancel / delete */

  function save() {
    if (!draft) return;
    showAll = true;
    const problems = refreshErrors();
    if (problems.size) {
      const first = [...fields].find(([k]) => problems.has(k));
      first?.[1].input.focus();
      return;
    }
    const { index, tool } = draft;
    const at = index === null ? tools.length : index;
    tools[at] = tool;
    write();
    renderList();
    focusAfterClose = editButton(at);
    dialog.close();
  }

  btnSave.addEventListener('click', save);
  btnCancel.addEventListener('click', () => dialog.close());

  btnDelete.addEventListener('click', () => {
    if (!draft || draft.index === null) return;
    const i = draft.index;
    const [tool] = tools.splice(i, 1);
    write();
    renderList();
    const button = el('button', { type: 'button', className: 'btn tool-undo', textContent: 'Undo' });
    const token = {};
    button.addEventListener('click', () => {
      if (undo !== token) return;
      clearNote();
      tools.splice(i, 0, tool);
      write();
      renderList();
      editButton(i)?.focus();
    });
    showNote(`Deleted ${tool.name ? `"${tool.name}"` : `tool ${i + 1}`}.`, button);
    undo = token;
    focusAfterClose = button;
    dialog.close();
  });

  // However it closes (Save, Cancel, Delete, Escape), the draft goes and focus returns.
  dialog.addEventListener('opened-changed', () => {
    if (dialog.opened) return;
    draft = null;
    const target = focusAfterClose;
    focusAfterClose = null;
    if (target) later(() => target.focus());
  });

  setMode('form');

  return {
    /** True while the list holds a tool that must not be saved (loaded that way from JSON). */
    hasProblems: () => mode === 'form' && toolProblems(tools).size > 0,
  };
}
