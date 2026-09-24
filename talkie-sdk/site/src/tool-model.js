/**
 * The console's tool editor model: tools JSON ⇄ an editable list of tools, each with a flat list
 * of parameters. No DOM.
 *
 * The stored format does not change: the editor writes the same JSON array the "Tools (JSON)"
 * field holds, so `validateTools` in profile.js still decides what can be saved and sent. Keys
 * the form has no field for (a parameter's `items`, `additionalProperties`, a tool's own extras,
 * an `enum` the Allowed values field can't show) ride along in `extra` and come back out
 * unchanged.
 */

/** Parameter types offered in the form. A tool may use another; it is kept and offered too. */
export const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'];

/** Types whose values can be limited to a list (JSON Schema `enum`) in the form. */
export const ENUM_TYPES = ['string', 'number', 'integer'];

/** What `validateTools` accepts as a tool name, as a hint for the form. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** A new, empty tool. Invalid until it has a name and a description, as it should be. */
export const blankTool = () => ({ name: '', description: '', params: [], paramsExtra: {}, extra: {} });

/** A new parameter: a required string, the most common case. */
export const blankParam = () => ({ name: '', type: 'string', required: true, description: '', enumText: '', extra: {} });

/**
 * The Allowed values field → enum values for `type`: comma-separated text, numbers for number
 * and integer. Empty text is no limit (`values: []`).
 *
 * @param {string} type
 * @param {string} text
 * @returns {{ ok: true, values: (string|number)[] } | { ok: false, error: string }}
 */
export function parseEnum(type, text) {
  const parts = (text || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (type === 'string') return { ok: true, values: [...new Set(parts)] };
  const values = parts.map(Number);
  const bad = parts.find((_, k) => (type === 'integer' ? !Number.isInteger(values[k]) : !Number.isFinite(values[k])));
  if (bad !== undefined) return { ok: false, error: `"${bad}" is not ${type === 'integer' ? 'a whole number' : 'a number'}.` };
  return { ok: true, values: [...new Set(values)] };
}

/** Whether an `enum` from JSON can be shown in the Allowed values field and written back as is. */
function enumFits(type, values) {
  if (!ENUM_TYPES.includes(type) || !Array.isArray(values) || !values.length) return false;
  const parsed = parseEnum(type, values.join(', '));
  return parsed.ok && JSON.stringify(parsed.values) === JSON.stringify(values);
}

/**
 * Read tools JSON into the form model.
 *
 * Fails (`ok: false`) only when the JSON cannot be shown as a form without losing something:
 * unparsable text, not an array, or a shape the form has no place for. The caller then keeps the
 * raw JSON view. Missing names or descriptions are *not* failures: the form shows them as errors.
 *
 * @param {string} text
 * @returns {{ ok: true, tools: object[] } | { ok: false, error: string }}
 */
export function parseTools(text) {
  if (!text || !text.trim()) return { ok: true, tools: [] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `The JSON does not parse (${err.message}).` };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'The JSON is not an array of tools.' };

  const tools = [];
  for (let i = 0; i < parsed.length; i++) {
    const at = `Tool ${i + 1}`;
    const item = parsed[i];
    if (!isPlainObject(item)) return { ok: false, error: `${at} is not an object.` };
    const { type, name, description, parameters, ...extra } = item;
    if (type !== undefined && type !== 'function') return { ok: false, error: `${at} has type "${type}"; the form only edits "function" tools.` };
    if (name !== undefined && typeof name !== 'string') return { ok: false, error: `${at}: "name" is not text.` };
    if (description !== undefined && typeof description !== 'string') return { ok: false, error: `${at}: "description" is not text.` };
    if (parameters !== undefined && !isPlainObject(parameters)) return { ok: false, error: `${at}: "parameters" is not an object.` };

    const { properties = {}, required = [], ...paramsExtra } = parameters ?? {};
    if (!isPlainObject(properties)) return { ok: false, error: `${at}: "parameters.properties" is not an object.` };
    if (!Array.isArray(required) || required.some((r) => typeof r !== 'string')) {
      return { ok: false, error: `${at}: "parameters.required" is not a list of names.` };
    }

    const params = [];
    for (const [pName, schema] of Object.entries(properties)) {
      if (!isPlainObject(schema)) return { ok: false, error: `${at}: parameter "${pName}" is not an object.` };
      const { type: pType = 'string', description: pDesc = '', ...pExtra } = schema;
      if (typeof pType !== 'string') return { ok: false, error: `${at}: parameter "${pName}" has more than one type; edit it as JSON.` };
      if (typeof pDesc !== 'string') return { ok: false, error: `${at}: parameter "${pName}" has a description that is not text.` };
      let enumText = '';
      if (enumFits(pType, pExtra.enum)) {
        enumText = pExtra.enum.join(', ');
        delete pExtra.enum;
      }
      params.push({ name: pName, type: pType, required: required.includes(pName), description: pDesc, enumText, extra: pExtra });
    }
    // A required name with no property would be dropped on the next save.
    const orphan = required.find((r) => !Object.hasOwn(properties, r));
    if (orphan) return { ok: false, error: `${at}: "${orphan}" is required but not defined; fix it as JSON.` };

    tools.push({ name: name ?? '', description: description ?? '', params, paramsExtra, extra });
  }
  return { ok: true, tools };
}

/**
 * The form model → the tools JSON the field stores (pretty-printed, as imports already are).
 * An empty list is the empty string, which is what an untouched field holds.
 *
 * @param {object[]} tools
 * @returns {string}
 */
export function serializeTools(tools) {
  if (!tools.length) return '';
  const out = tools.map((t) => {
    const properties = {};
    // A parameter still being named has no key yet; the form flags it and holds the save.
    for (const p of t.params.filter((q) => q.name)) {
      const schema = { type: p.type, ...p.extra };
      if (p.description) schema.description = p.description;
      // The field keeps its text when the type changes, but only these types get an enum.
      const allowed = ENUM_TYPES.includes(p.type) ? parseEnum(p.type, p.enumText) : { ok: false };
      if (allowed.ok && allowed.values.length) schema.enum = allowed.values;
      // An array with no `items` says nothing about its elements; give a new one a default to edit.
      if (p.type === 'array' && !('items' in schema)) schema.items = { type: 'string' };
      properties[p.name] = schema;
    }
    const required = t.params.filter((p) => p.name && p.required).map((p) => p.name);
    const parameters = { type: 'object', ...t.paramsExtra, properties };
    if (required.length) parameters.required = required;
    return { type: 'function', name: t.name, description: t.description, parameters, ...t.extra };
  });
  return JSON.stringify(out, null, 2);
}

/**
 * Problems to show beside the form's fields, keyed by field:
 * `tool:<i>:name`, `tool:<i>:description`, `param:<i>:<j>:name`, `param:<i>:<j>:enum`.
 *
 * Covers what `validateTools` would reject, plus what JSON would silently lose (two parameters
 * with one name), so each message can sit next to the field that causes it.
 *
 * @param {object[]} tools
 * @returns {Map<string, string>}
 */
export function toolProblems(tools) {
  const problems = new Map();
  const seen = new Set();
  tools.forEach((t, i) => {
    if (!t.name) problems.set(`tool:${i}:name`, 'Give the tool a name.');
    else if (!TOOL_NAME_PATTERN.test(t.name)) problems.set(`tool:${i}:name`, 'Use only letters, digits, _ and - (up to 64).');
    else if (seen.has(t.name)) problems.set(`tool:${i}:name`, `Another tool is already called "${t.name}".`);
    seen.add(t.name);

    if (!t.description) problems.set(`tool:${i}:description`, 'Say what the tool does; the agent decides when to call it from this.');

    const pSeen = new Set();
    t.params.forEach((p, j) => {
      if (!p.name) problems.set(`param:${i}:${j}:name`, 'Give the parameter a name.');
      else if (pSeen.has(p.name)) problems.set(`param:${i}:${j}:name`, `"${p.name}" is already a parameter of this tool.`);
      pSeen.add(p.name);
      if (ENUM_TYPES.includes(p.type)) {
        const allowed = parseEnum(p.type, p.enumText);
        if (!allowed.ok) problems.set(`param:${i}:${j}:enum`, allowed.error);
      }
    });
  });
  return problems;
}
