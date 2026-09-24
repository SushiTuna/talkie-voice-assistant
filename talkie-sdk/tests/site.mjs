/**
 * Tests for the site build pipeline and pure modules.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

/* ------------------------------------------------------------------- snippet */

{
  const { buildSnippet } = await import('../site/src/snippet.js');

  // Default config: only api emitted.
  const defaultHtml = buildSnippet({});
  check(
    'default config emits talkie-assistant with api only',
    defaultHtml.split('\n')[1].trim() === '<talkie-assistant api="http://localhost:8000"></talkie-assistant>',
  );

  // mode emitted only when non-default.
  let html = buildSnippet({ attrs: { mode: 'push-to-talk' } });
  check(
    'mode="push-to-talk" is emitted',
    html.includes('mode="push-to-talk"'),
  );
  html = buildSnippet({ attrs: {} }); // back to defaults
  check(
    'default mode is not emitted',
    !html.includes('mode='),
  );

  // layout emitted only when non-default.
  html = buildSnippet({ attrs: { layout: 'sheet' } });
  check(
    'layout="sheet" is emitted',
    html.includes('layout="sheet"'),
  );
  check(
    'default layout is not emitted',
    !buildSnippet({}).includes('layout='),
  );

  // barge-in: 'off' emitted, 'on' omitted.
  html = buildSnippet({ attrs: { 'barge-in': 'off' } });
  check(
    'barge-in="off" is emitted',
    html.includes('barge-in="off"'),
  );
  check(
    'barge-in="on" (default) is not emitted',
    !buildSnippet({}).includes('barge-in'),
  );

  // HTML escaping for special characters.
  html = buildSnippet({ attrs: { profile: '&"<>test' } });
  check(
    'special characters in attribute values are escaped',
    html.includes('&amp;&quot;&lt;&gt;test'),
  );

  // Theme styling.
  html = buildSnippet({
    theme: { '--talkie-ink': '#111', '--talkie-paper': '#fff', color: 'red' },
  });
  const line2 = html.split('\n')[1];
  check(
    'theme variables starting with --talkie- become the style attribute',
    line2.includes('style="--talkie-ink: #111; --talkie-paper: #fff"'),
  );
  check(
    'non--talkie- keys are dropped from theme',
    !line2.includes('color:red'),
  );

  // Theme with different values (verifies computed themeAttrs, not hard-coded fallback).
  html = buildSnippet({
    theme: { '--talkie-ink': '#abcdef', '--talkie-wave-color': '#123456' },
  });
  const line2b = html.split('\n')[1];
  check(
    'custom theme colors are rendered',
    line2b.includes('style="--talkie-ink: #abcdef; --talkie-wave-color: #123456"'),
  );
}

/* ------------------------------------------------------------------- profile */

{
  const { validateTools, toAgentContext, fromAgentContext } =
    await import('../site/src/profile.js');

  // Empty / whitespace-only → ok true, tools [].
  check(
    'validateTools accepts empty string',
    JSON.stringify(validateTools('')) === '{"ok":true,"tools":[]}',
  );
  check(
    'validateTools accepts whitespace-only string',
    JSON.stringify(validateTools('  \n\t  ')) === '{"ok":true,"tools":[]}',
  );

  // Bad JSON.
  const badJson = validateTools('{bad');
  check(
    'validateTools rejects invalid JSON',
    badJson.ok === false,
    String(badJson.error),
  );

  // Not an array.
  const notArray = validateTools('{"foo":"bar"}');
  check(
    'validateTools rejects object (not array)',
    notArray.ok === false,
    String(notArray.error),
  );

  // Missing description with item numbering.
  const missingDesc = validateTools('[{"type":"function","name":"foo"}]');
  check(
    'validateTools reports missing description with item index',
    missingDesc.ok === false && missingDesc.error.includes('Tool 1') && missingDesc.error.includes('description'),
    missingDesc.error,
  );

  // Valid tool definition.
  const validResult = validateTools('[{"type":"function","name":"hello","description":"says hello","parameters":{}}]');
  check(
    'validateTools accepts a valid tool',
    validResult.ok === true && Array.isArray(validResult.tools) && validResult.tools.length === 1,
  );

  const dup = validateTools('[{"type":"function","name":"a","description":"d","parameters":{}},{"type":"function","name":"a","description":"d","parameters":{}}]');
  check('validateTools rejects duplicate tool names, as the server does', dup.ok === false && dup.error.includes('duplicate'), dup.error);

  // Null array item.
  const nullItem = validateTools('[null]');
  check(
    'validateTools rejects null array item',
    nullItem.ok === false && nullItem.error === 'Tool 1: must be an object',
    nullItem.error,
  );

  /* toAgentContext */
  const ctx = toAgentContext({
    name: 'AI Assistant',
    description: 'An AI assistant',
    systemPrompt: 'You are helpful.',
    keyterms: 'helpful, clever,\ncreative',
  });
  check(
    'toAgentContext slugifies name and includes required fields',
    ctx.profile === 'ai-assistant' && ctx.system_prompt === 'You are helpful.',
  );
  check(
    'toAgentContext splits keyterms and omits empty optionals',
    Array.isArray(ctx.keyterms) && ctx.keyterms.length === 3 && !ctx.greeting,
  );

  /* fromAgentContext */
  const json = { profile: 'my-agent', system_prompt: 'Be concise.', description: 'A bot' };
  const form = fromAgentContext(json);
  check(
    'fromAgentContext round-trips name from profile',
    form.name === 'my-agent',
  );
  check(
    'fromAgentContext preserves system_prompt',
    form.systemPrompt === 'Be concise.',
  );

  // Throws when missing system_prompt.
  let threw = false;
  try { fromAgentContext({ profile: 'x' }); } catch { threw = true; }
  check(
    'fromAgentContext throws on missing system_prompt',
    threw,
  );
}

/* ------------------------------------------------------------------- server profile files */

{
  const { toServerProfile, fromServerProfile, serverProfileProblems } = await import('../site/src/profile.js');
  const form = { name: 'Tour Guide', description: 'd', systemPrompt: 'Be brief.', voice: 'anna', greeting: 'Hi!', keyterms: 'Talkie,\n  lobby ' };
  const file = toServerProfile(form);
  check('toServerProfile puts the prompt in system_prompt_override',
    file.system_prompt_override === 'Be brief.' && !('system_prompt' in file) && !('profile' in file));
  check('toServerProfile keeps greeting, voice, description and split keyterms',
    file.greeting === 'Hi!' && file.voice === 'anna' && file.description === 'd' && JSON.stringify(file.keyterms) === '["Talkie","lobby"]');
  check('toServerProfile omits empty optionals', !('voice' in toServerProfile({ systemPrompt: 'x', greeting: 'y' })));

  const back = fromServerProfile(file, 'tour-guide');
  check('fromServerProfile round-trips a console profile',
    back.name === 'tour-guide' && back.systemPrompt === 'Be brief.' && back.keyterms === 'Talkie, lobby' && back.greeting === 'Hi!');
  let threw = false;
  try { fromServerProfile({ agent: { role: 'x' }, greeting: 'Hi' }, 'property'); } catch { threw = true; }
  check('fromServerProfile refuses profiles built from agent sections', threw);

  const toolJson = '[{"type":"function","name":"go_to_room","description":"Go.","parameters":{"type":"object"}}]';
  const withTools = toServerProfile({ ...form, tools: toolJson });
  check('toServerProfile sends tools as parsed JSON', Array.isArray(withTools.tools) && withTools.tools[0].name === 'go_to_room');
  check('...and fromServerProfile brings them back as editable JSON',
    JSON.parse(fromServerProfile(withTools, 'x').tools)[0].name === 'go_to_room');
  check('toServerProfile omits an empty tools list', !('tools' in toServerProfile({ ...form, tools: '  ' })));
  const badTools = serverProfileProblems({ ...form, tools: '{"not":"an array"}' });
  check('serverProfileProblems refuses invalid tools rather than dropping them', badTools.some((p) => p.includes('tools')), badTools.join(' | '));

  check('serverProfileProblems is empty for a complete profile', serverProfileProblems(form).length === 0);
  const problems = serverProfileProblems({ name: '!!', systemPrompt: ' ', greeting: '' });
  check('serverProfileProblems names the missing name, prompt and greeting', problems.length === 3, problems.join(' | '));
}

/* ------------------------------------------------------------------- tool editor model */

{
  const { parseTools, serializeTools, toolProblems, blankTool, blankParam, parseEnum } = await import('../site/src/tool-model.js');
  const { validateTools } = await import('../site/src/profile.js');

  const source = [{
    type: 'function',
    name: 'show_room',
    description: 'Open a room view',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        room: { type: 'string', description: 'Room id', enum: ['kitchen', 'lobby'] },
        zoom: { type: 'number' },
      },
      required: ['room'],
    },
    strict: true,
  }];
  const parsed = parseTools(JSON.stringify(source));
  check('parseTools reads a tool into name, description and parameter rows',
    parsed.ok && parsed.tools[0].name === 'show_room' && parsed.tools[0].params.length === 2, JSON.stringify(parsed));
  const [room, zoom] = parsed.tools[0].params;
  check('parseTools marks required parameters from parameters.required', room.required === true && zoom.required === false);
  check('parseTools reads enum into the Allowed values field', room.enumText === 'kitchen, lobby' && !('enum' in room.extra), JSON.stringify(room));
  check('serializeTools(parseTools(x)) keeps everything, extras included',
    JSON.stringify(JSON.parse(serializeTools(parsed.tools))) === JSON.stringify([{
      type: 'function', name: 'show_room', description: 'Open a room view',
      parameters: { type: 'object', additionalProperties: false, properties: {
        room: { type: 'string', description: 'Room id', enum: ['kitchen', 'lobby'] }, zoom: { type: 'number' } }, required: ['room'] },
      strict: true,
    }]), serializeTools(parsed.tools));
  check('the form writes JSON that validateTools accepts', validateTools(serializeTools(parsed.tools)).ok);

  check('parseTools treats empty text as no tools', parseTools('  ').ok && parseTools('').tools.length === 0);
  check('serializeTools writes no tools as an empty field', serializeTools([]) === '');
  check('parseTools reads a tool with no parameters', parseTools('[{"type":"function","name":"a","description":"d"}]').tools[0].params.length === 0);

  for (const [what, text] of [
    ['invalid JSON', '[{'],
    ['a non-array', '{"name":"a"}'],
    ['a non-function tool', '[{"type":"web_search"}]'],
    ['a parameter with several types', '[{"type":"function","name":"a","description":"d","parameters":{"properties":{"x":{"type":["string","null"]}}}}]'],
    ['a required name with no parameter', '[{"type":"function","name":"a","description":"d","parameters":{"properties":{},"required":["x"]}}]'],
  ]) {
    const r = parseTools(text);
    check(`parseTools refuses ${what}, so the editor stays on JSON`, !r.ok && typeof r.error === 'string', JSON.stringify(r));
  }

  check('parseEnum splits comma-separated text and drops blanks and repeats',
    JSON.stringify(parseEnum('string', ' a, b ,, a')) === '{"ok":true,"values":["a","b"]}');
  check('parseEnum reads numbers for number and integer types',
    JSON.stringify(parseEnum('number', '1, 2.5').values) === '[1,2.5]' && JSON.stringify(parseEnum('integer', '3,4').values) === '[3,4]');
  check('parseEnum refuses a non-number for number, and a fraction for integer',
    !parseEnum('number', '1, two').ok && !parseEnum('integer', '1.5').ok);
  const numEnum = parseTools('[{"type":"function","name":"a","description":"d","parameters":{"properties":{"n":{"type":"integer","enum":[1,2]}}}}]');
  check('an integer enum round-trips through the form',
    numEnum.tools[0].params[0].enumText === '1, 2' && JSON.stringify(JSON.parse(serializeTools(numEnum.tools))[0].parameters.properties.n.enum) === '[1,2]');
  const oddEnum = parseTools('[{"type":"function","name":"a","description":"d","parameters":{"properties":{"s":{"type":"string","enum":["a, b","c"]}}}}]');
  check('an enum the field cannot show (a value with a comma) stays aside, unchanged',
    oddEnum.tools[0].params[0].enumText === '' && JSON.stringify(oddEnum.tools[0].params[0].extra.enum) === '["a, b","c"]'
      && JSON.stringify(JSON.parse(serializeTools(oddEnum.tools))[0].parameters.properties.s.enum) === '["a, b","c"]');
  const boolWithEnum = { ...blankTool(), name: 'a', description: 'd', params: [{ ...blankParam(), name: 'b', type: 'boolean', enumText: 'x' }] };
  check('allowed values are dropped for a type that cannot have them (boolean)',
    !('enum' in JSON.parse(serializeTools([boolWithEnum]))[0].parameters.properties.b) && toolProblems([boolWithEnum]).size === 0);
  const badNum = { ...blankTool(), name: 'a', description: 'd', params: [{ ...blankParam(), name: 'n', type: 'number', enumText: '1, x' }] };
  check('a non-number allowed value for a number parameter is flagged on that field', toolProblems([badNum]).get('param:0:0:enum')?.includes('"x"'));

  const t = blankTool();
  check('a new tool reports its missing name and description',
    toolProblems([t]).has('tool:0:name') && toolProblems([t]).has('tool:0:description'));
  const good = { ...blankTool(), name: 'go', description: 'Go' };
  check('a complete tool has no problems', toolProblems([good]).size === 0);
  check('a tool name with a space is flagged, as validateTools rejects it',
    toolProblems([{ ...good, name: 'go now' }]).has('tool:0:name') && !validateTools(serializeTools([{ ...good, name: 'go now' }])).ok);
  check('a second tool with the same name is flagged on the second one',
    toolProblems([good, { ...good }]).has('tool:1:name') && !toolProblems([good, { ...good }]).has('tool:0:name'));
  const dupParams = { ...good, params: [{ ...blankParam(), name: 'x' }, { ...blankParam(), name: 'x' }] };
  check('a repeated parameter name is flagged (JSON would silently keep only one)', toolProblems([dupParams]).has('param:0:1:name'));
  const unnamed = { ...good, params: [blankParam()] };
  check('an unnamed parameter is flagged and left out of the JSON',
    toolProblems([unnamed]).has('param:0:0:name') && !('required' in JSON.parse(serializeTools([unnamed]))[0].parameters)
      && Object.keys(JSON.parse(serializeTools([unnamed]))[0].parameters.properties).length === 0);
  const arr = { ...good, params: [{ ...blankParam(), name: 'ids', type: 'array' }] };
  check('a new array parameter gets a default item type',
    JSON.stringify(JSON.parse(serializeTools([arr]))[0].parameters.properties.ids.items) === '{"type":"string"}');
}

/* ------------------------------------------------------------------- tool editor (fake DOM) */

{
  // Just enough DOM for tool-editor.js: elements, events, focus and simple selectors.
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null; this.hidden = false; this.className = ''; }
    append(...kids) {
      for (const k of kids) {
        const n = typeof k === 'string' ? Object.assign(new Node('#text'), { text: k }) : k;
        n.parent = this;
        this.children.push(n);
      }
    }
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    get textContent() { return this.tagName === '#TEXT' ? this.text : this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(String(v)); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    dispatch(type, extra = {}) {
      const e = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      (this.listeners[type] ?? []).forEach((fn) => fn(e));
      return e;
    }
    focus() { const prev = doc.activeElement; doc.activeElement = this; prev?.dispatch?.('blur'); }
    contains(n) { for (; n; n = n.parent) if (n === this) return true; return false; }
    get all() { return this.children.flatMap((c) => [c, ...c.all]); }
    matches(sel) {
      if (sel.startsWith('.')) return this.className.split(' ').includes(sel.slice(1));
      const m = sel.match(/^\[([\w-]+)="([^"]*)"\]$/);
      if (m) return this.attrs[m[1]] === m[2];
      return this.tagName === sel.toUpperCase();
    }
    querySelector(sel) { return this.all.find((n) => n.matches(sel)) ?? null; }
    querySelectorAll(sel) { return this.all.filter((n) => n.matches(sel)); }
  }
  const doc = { activeElement: null, createElement: (tag) => new Node(tag) };
  const saved = { document: globalThis.document, raf: globalThis.requestAnimationFrame };
  globalThis.document = doc;
  globalThis.requestAnimationFrame = (fn) => fn();

  const h = (tag, cls, attrs = {}) => { const n = new Node(tag); n.className = cls; Object.assign(n.attrs, attrs); return n; };
  function setup(initial = '') {
    const host = h('section', 'tool-editor');
    const formView = h('div', 'tool-form');
    formView.append(h('ul', 'tool-list'), h('button', 'btn tool-add'));
    host.append(h('button', 'tool-mode-btn', { 'data-mode': 'form' }), h('button', 'tool-mode-btn', { 'data-mode': 'json' }),
      h('p', 'tool-editor-note'), formView);
    // The lion-textarea: setting modelValue fires model-value-changed at once, as Lion's FormatMixin does.
    const field = h('lion-textarea', '');
    let value = initial;
    Object.defineProperty(field, 'modelValue', {
      get: () => value,
      set: (v) => { if (v !== value) { value = v; field.dispatch('model-value-changed'); } },
    });
    field.append(h('textarea', ''));
    host.append(field);
    // The lion-dialog: open()/close() flip `opened` and fire opened-changed, as OverlayMixin does.
    const dialog = h('lion-dialog', '');
    dialog.opened = false;
    dialog.open = () => { dialog.opened = true; dialog.dispatch('opened-changed'); };
    dialog.close = () => { if (dialog.opened) { dialog.opened = false; dialog.dispatch('opened-changed'); } };
    dialog.append(h('h3', 'tool-dialog-title'), h('div', 'tool-dialog-body'),
      h('button', 'btn danger delete-btn'), h('button', 'btn cancel-btn'), h('button', 'btn primary save-btn'));
    const editor = mountToolEditor(host, field, dialog);
    const body = dialog.querySelector('.tool-dialog-body');
    const input = (suffix, k = 0) => body.all.filter((n) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName) && n.id.endsWith(suffix))[k];
    const type = (el, v) => { el.value = v; el.dispatch(el.tagName === 'SELECT' ? 'change' : 'input'); };
    const stored = () => (field.modelValue ? JSON.parse(field.modelValue) : []);
    const list = host.querySelector('.tool-list');
    return {
      host, field, dialog, body, editor, list, input, type, stored,
      note: host.querySelector('.tool-editor-note'),
      click: (sel, root = dialog) => root.querySelector(sel).dispatch('click'),
      rows: () => list.children.map((li) => li.querySelector('.tool-row-name').textContent + ' | ' + li.querySelector('.tool-row-desc').textContent),
    };
  }

  const { mountToolEditor } = await import('../site/src/tool-editor.js');
  try {
    let ui = setup();
    check('editor: opens on the list, with the JSON field hidden',
      ui.host.querySelector('[data-mode="form"]').getAttribute('aria-pressed') === 'true' && ui.field.hidden === true && ui.list.children.length === 0);

    ui.click('.tool-add', ui.host);
    check('editor: + Add a tool opens the dialog on a new tool, Name focused, no Delete',
      ui.dialog.opened && ui.dialog.querySelector('.tool-dialog-title').textContent === 'Add a tool'
        && doc.activeElement === ui.input('-name') && ui.dialog.querySelector('.delete-btn').hidden === true);
    check('editor: a new tool shows no errors before the user has typed', ui.body.querySelectorAll('.tool-error').every((e) => e.textContent === ''));

    ui.click('.save-btn');
    check('editor: Save on an incomplete tool keeps the dialog open, shows the errors and focuses the first',
      ui.dialog.opened && ui.field.modelValue === '' && ui.input('-name').getAttribute('aria-invalid') === 'true' && doc.activeElement === ui.input('-name'));
    const nameErr = ui.body.querySelector('.tool-error');
    check('editor: the error is linked to its field after the hint',
      ui.input('-name').getAttribute('aria-describedby') === `${ui.input('-name').id}-hint ${nameErr.id}` && nameErr.textContent.includes('name'));

    ui.type(ui.input('-name'), 'show_room');
    ui.type(ui.input('-desc'), 'Open a room view');
    check('editor: typing in the dialog does not touch the stored JSON before Save', ui.field.modelValue === '');

    ui.click('.tool-param-add');
    const pName = ui.input('-name', 1);
    check('editor: + Add parameter adds a labelled row and focuses its name', doc.activeElement === pName && ui.body.all.some((n) => n.tagName === 'LABEL' && n.htmlFor === pName.id));
    check('editor: the row has an Allowed values field for strings', ui.input('-enum') && ui.body.querySelector('.tool-param-enum').hidden === false);
    ui.type(pName, 'room');
    ui.type(ui.input('-desc', 1), 'Room id');
    ui.type(ui.input('-enum'), 'kitchen, lobby');
    ui.click('.save-btn');
    check('editor: Save writes the tool, with the allowed values as enum, and closes',
      !ui.dialog.opened && JSON.stringify(ui.stored()) === JSON.stringify([{ type: 'function', name: 'show_room', description: 'Open a room view',
        parameters: { type: 'object', properties: { room: { type: 'string', description: 'Room id', enum: ['kitchen', 'lobby'] } }, required: ['room'] } }]),
      ui.field.modelValue);
    check('editor: the list shows only name and description, with an Edit button',
      JSON.stringify(ui.rows()) === '["show_room | Open a room view"]'
        && ui.list.querySelector('.tool-edit').getAttribute('aria-label') === 'Edit tool show_room' && ui.list.querySelectorAll('input').length === 0);
    check('editor: focus returns to the saved tool\'s Edit button', doc.activeElement === ui.list.querySelector('.tool-edit'));

    ui.click('.tool-edit', ui.list);
    check('editor: Edit opens the dialog filled from the tool, with Delete',
      ui.dialog.opened && ui.input('-name').value === 'show_room' && ui.input('-enum').value === 'kitchen, lobby' && ui.dialog.querySelector('.delete-btn').hidden === false);
    const sel = ui.input('-type');
    sel.value = 'boolean'; sel.dispatch('change');
    check('editor: a boolean parameter hides Allowed values', ui.body.querySelector('.tool-param-enum').hidden === true);
    sel.value = 'integer'; sel.dispatch('change');
    ui.click('.save-btn');
    check('editor: integer with non-number allowed values will not save',
      ui.dialog.opened && ui.input('-enum').getAttribute('aria-invalid') === 'true' && ui.stored()[0].parameters.properties.room.type === 'string');
    ui.type(ui.input('-name'), 'renamed');
    ui.click('.cancel-btn');
    check('editor: Cancel drops every change made in the dialog',
      !ui.dialog.opened && ui.stored()[0].name === 'show_room' && ui.stored()[0].parameters.properties.room.type === 'string');
    check('editor: ...and puts focus back on the Edit button', doc.activeElement === ui.list.querySelector('.tool-edit'));

    ui.click('.tool-edit', ui.list);
    const e = ui.input('-desc', 1).dispatch('keydown', { key: 'Enter' });
    check('editor: Enter in a one-line field saves the dialog', e.defaultPrevented && !ui.dialog.opened);

    // A second tool may not reuse a name.
    ui.click('.tool-add', ui.host);
    ui.type(ui.input('-name'), 'show_room');
    ui.type(ui.input('-desc'), 'Dup');
    ui.click('.save-btn');
    check('editor: a name another tool already has is refused in the dialog',
      ui.dialog.opened && ui.body.querySelector('.tool-error').textContent.includes('already'));
    ui.type(ui.input('-name'), 'go_home');
    ui.click('.save-btn');
    check('editor: a new tool is added at the end of the list', JSON.stringify(ui.rows()) === '["show_room | Open a room view","go_home | Dup"]');

    // Remove a parameter inside the dialog.
    ui.click('.tool-edit', ui.list);
    ui.click('.tool-param-remove');
    check('editor: removing a parameter moves focus to Add parameter', doc.activeElement === ui.body.querySelector('.tool-param-add'));
    ui.click('.save-btn');
    check('editor: ...and Save writes the tool without it', Object.keys(ui.stored()[0].parameters.properties).length === 0 && !('required' in ui.stored()[0].parameters));

    const before = ui.field.modelValue;
    ui.click('.tool-edit', ui.list);
    ui.click('.delete-btn');
    const undo = ui.note.querySelector('.tool-undo');
    check('editor: Delete tool removes it, closes the dialog and focuses Undo',
      !ui.dialog.opened && ui.stored().length === 1 && ui.stored()[0].name === 'go_home' && doc.activeElement === undo);
    undo.dispatch('click');
    check('editor: Undo puts the tool back in its place', ui.field.modelValue === before);

    // Outside changes: loading another profile rebuilds the list and closes an open dialog.
    ui.click('.tool-edit', ui.list);
    new Node('select').focus();
    ui.field.modelValue = JSON.stringify([{ type: 'function', name: 'a', description: 'A', parameters: {} }]);
    check('editor: a profile loaded into the field replaces the list and closes the dialog',
      JSON.stringify(ui.rows()) === '["a | A"]' && !ui.dialog.opened);

    // JSON the form cannot show without loss → JSON view with a reason.
    ui.field.modelValue = '[{"type":"web_search"}]';
    check('editor: tools the form cannot show switch to the JSON view and say why',
      ui.field.hidden === false && ui.host.querySelector('.tool-form').hidden === true && ui.note.textContent.includes('web_search'));
    ui.click('[data-mode="form"]', ui.host);
    check('editor: Form stays unavailable until the JSON can be shown', ui.field.hidden === false);
    ui.field.querySelector('textarea').focus();
    ui.field.modelValue = '[{"type":"function","name":"c","description":"C","parameters":{}}]';
    check('editor: JSON typed while the JSON view has focus is left alone', ui.field.hidden === false);
    new Node('select').focus();
    ui.field.modelValue = '[{"type":"function","name":"c","description":"C","parameters":{"type":"object"}}]';
    check('editor: the next loadable tools bring the list back', ui.field.hidden === true && JSON.stringify(ui.rows()) === '["c | C"]');

    ui.click('[data-mode="json"]', ui.host);
    ui.field.modelValue = '[]';
    check('editor: a chosen JSON view stays chosen when another profile loads', ui.field.hidden === false);

    ui = setup('[{"type":"function","name":"x","description":"","parameters":{}}]');
    check('editor: a saved tool with a problem is flagged in the list and holds the save',
      ui.list.querySelector('.tool-row-flag')?.textContent === 'Needs fixing' && ui.editor.hasProblems());
    ui.click('.tool-edit', ui.list);
    check('editor: ...and its dialog shows the problem straight away',
      ui.body.querySelectorAll('.tool-error').some((n) => n.textContent.includes('Say what the tool does')));

    ui = setup('{bad');
    check('editor: unparsable saved JSON opens on the JSON view', ui.field.hidden === false && ui.note.textContent.includes('parse'));
  } finally {
    globalThis.document = saved.document;
    globalThis.requestAnimationFrame = saved.raf;
  }
}

/* ------------------------------------------------------------------- talkie-assistant source */

{
  const src = readFileSync(join(ROOT, 'src', 'components', 'talkie-assistant.js'), 'utf8');
  check(
    'talkie-assistant source still contains _createBackend(options)',
    src.includes('_createBackend(options)'),
  );
}

/* ------------------------------------------------------------------- page markup */

{
  const page = (name) => readFileSync(join(ROOT, 'site', name), 'utf8');

  // The Docs page renders the README alone; links into it keep the #guide/<heading> shape.
  const docs = page('docs.html');
  const docsJs = readFileSync(join(ROOT, 'site', 'src', 'pages', 'docs.js'), 'utf8');
  check('docs.html has the data-doc="guide" panel', docs.includes('data-doc="guide"'));
  check('docs.js knows doc id "guide"', docsJs.includes("id: 'guide'"));
  check('docs.html has no Integration or Production checklist tab',
    !/data-doc="(integration|checklist)"/.test(docs) && !/<lion-tabs/.test(docs));

  // <lion-form> must wrap the native <form>, not the other way round.
  const consoleHtml = page('console.html');
  check('console.html: lion-form wraps the native form', /<lion-form id="profile-form">\s*<form>/.test(consoleHtml));
  check('console.html: no native form around lion-form', !/<form>\s*<lion-form/.test(consoleHtml));

  // Console: New / Duplicate / Delete are icon-only, so each needs an accessible name and a tooltip.
  for (const id of ['btn-new', 'btn-duplicate', 'btn-delete']) {
    const tag = consoleHtml.match(new RegExp(`<lion-button id="${id}"[^>]*>`))?.[0] ?? '';
    check(`console.html: #${id} has an aria-label and a title`, /aria-label="[^"]+"/.test(tag) && /title="[^"]+"/.test(tag), tag);
  }
  check('console.html: the server card sits right after the Profile select',
    /id="profile-select">[\s\S]*?<\/lion-select>\s*<section class="server-current"/.test(consoleHtml));
  check('console.html: Voice is a select filled from the server', /<lion-select label="Voice" name="voice"/.test(consoleHtml));
  check('console.html: the Tools JSON field stays inside the form, named "tools"',
    /<form>[\s\S]*<lion-textarea label="Tools \(JSON\)" name="tools"[\s\S]*<\/form>/.test(consoleHtml));
  check('console.html: the tool editor has a Form / JSON switch with aria-pressed',
    /data-mode="form" aria-pressed="true"/.test(consoleHtml) && /data-mode="json" aria-pressed="false"/.test(consoleHtml));
  check('console.html: the tool dialog has Save, Cancel and Delete tool',
    /<lion-dialog id="tool-dialog">[\s\S]*delete-btn[\s\S]*cancel-btn[\s\S]*save-btn[\s\S]*?<\/lion-dialog>/.test(consoleHtml));
  check('console.html: the tool dialog sits outside the profile form',
    consoleHtml.indexOf('id="tool-dialog"') > consoleHtml.indexOf('</lion-form>'));
  check('console.html: every button in the tool editor is type="button", so none submits the form',
    (consoleHtml.match(/<section id="tool-editor"[\s\S]*?<\/section>/)?.[0] ?? '').match(/<button(?![^>]*type="button")/g) === null);
  check('tool-editor.js builds DOM without innerHTML',
    !/innerHTML|insertAdjacentHTML|outerHTML/.test(readFileSync(join(ROOT, 'site', 'src', 'tool-editor.js'), 'utf8')));
  check('playground.html: Voice is a select filled from the server', /<lion-select name="voice"/.test(page('playground.html')));

  // CSS guards: each of these once broke the look without failing anything.
  const css = (name) => readFileSync(join(ROOT, 'site', 'src', name), 'utf8');
  const radioRule = css('theme.css').match(/\nlion-radio \{[^}]*\}/)?.[0] ?? '';
  check('theme.css: lion-radio stays a flex row, so the label sits beside its input',
    /display:\s*flex/.test(radioRule) && /align-items:\s*center/.test(radioRule), radioRule);
  // lion-accordion re-slots its children to "_accordion" and adds .invoker / .content.
  check('theme.css: accordion invoker styles match the upgraded .invoker class', css('theme.css').includes('lion-accordion > .invoker > button'));
  check('home.css: Good to know styles match the upgraded .invoker / .content classes',
    css('home.css').includes('lion-accordion > .invoker') && css('home.css').includes('lion-accordion > .content'));

  // Home page: the token-route pointer is a link into the docs, not literal markdown.
  const home = page('index.html');
  check('index.html has no literal markdown emphasis', !/\*The token route\*/.test(home));
  check('index.html links the token route into the docs', home.includes('href="/site/docs#guide/'));

  // Playground first run: the steps, the grouped settings and the announced status.
  const playground = page('playground.html');
  check('playground.html: the intro is three numbered start steps',
    (playground.match(/<ol class="start-steps"[\s\S]*?<\/ol>/)?.[0].match(/<li>/g) ?? []).length === 3);
  check('playground.html: Configure is grouped under Connection, Persona, Conversation and Appearance',
    /Connection<\/h3>[\s\S]*Persona<\/h3>[\s\S]*Conversation<\/h3>[\s\S]*Appearance<\/h3>/.test(
      playground.match(/<lion-form id="config">[\s\S]*?<\/lion-form>/)?.[0] ?? ''));
  check('playground.html: the preview status line is a live region', /id="status-line" role="status"/.test(playground));
  // Heading and subtitle: fields in Appearance, read by attrs(), emitted by the snippet when set.
  const appearance = playground.match(/Appearance<\/h3>[\s\S]*?<\/form>/)?.[0] ?? '';
  check('playground.html: Appearance has Heading and Subtitle fields, showing the defaults as placeholders',
    /<lion-input name="heading"[^>]*placeholder="Product Expert"/.test(appearance)
      && /<lion-input name="subtitle"[^>]*placeholder="Ask about features, pricing, integrations, or compatibility\."/.test(appearance));
  const playgroundJs = readFileSync(join(ROOT, 'site', 'src', 'pages', 'playground.js'), 'utf8');
  check('playground.js: the preview and snippet read heading and subtitle from the form',
    /heading: text\(v\.heading\)/.test(playgroundJs) && /subtitle: text\(v\.subtitle\)/.test(playgroundJs));
  const { buildSnippet } = await import('../site/src/snippet.js');
  const copySnippet = buildSnippet({ attrs: { heading: 'Travel Guide', subtitle: 'Ask about visas & "packing".' } });
  check('playground snippet: a heading and subtitle are emitted, escaped',
    copySnippet.includes('heading="Travel Guide"') && copySnippet.includes('subtitle="Ask about visas &amp; &quot;packing&quot;."'), copySnippet);
  check('playground snippet: empty heading and subtitle are left out, so the defaults apply',
    !/heading=|subtitle=/.test(buildSnippet({ attrs: { heading: '', subtitle: '' } })));
  check('playground.css: the icon in a lion-button is spaced with a margin, not gap',
    /\.btn-block > svg \{[^}]*margin-right/.test(css('playground.css')));

  // Theme: motion, contrast and small screens.
  check('theme.css: prefers-reduced-motion switches transitions and animations off',
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration:\s*0\.01ms[\s\S]*?animation-duration:\s*0\.01ms/.test(css('theme.css')));
  const dangerRule = css('theme.css').match(/\n\.btn\.danger\.primary \{[^}]*\}/)?.[0] ?? '';
  check('theme.css: a filled danger button uses --bg for its text (white fails contrast on the dark theme\'s red)',
    /color:\s*var\(--bg\)/.test(dangerRule), dangerRule);
  check('theme.css: form fields draw their border with --field-line (3:1 against the field)',
    /textarea\[slot="input"\],\s*lion-select > select\[slot="input"\] \{[^}]*border: 1px solid var\(--field-line\)/.test(css('theme.css')));
  check('home.css: #main clips the hero glow, so a 360px screen does not scroll sideways',
    /#main \{ overflow-x: clip; \}/.test(css('home.css')));
}

/* ------------------------------------------------------------------- build-site */

{
  // A stale chunk from an earlier build must not survive the next one.
  const stale = join(ROOT, 'site', 'dist', 'chunk-STALE0000.js');
  writeFileSync(stale, '// stale');
  execFileSync(process.execPath, [join(ROOT, 'build-site.mjs')], { stdio: 'pipe' });

  const distDir = join(ROOT, 'site', 'dist');
  const files = readdirSync(distDir);

  for (const name of ['home.js', 'playground.js', 'console.js', 'docs.js']) {
    check(`build produces site/dist/${name}`, files.includes(name), files.join(', '));
  }
  check('build clears stale files from site/dist', !files.includes('chunk-STALE0000.js'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
