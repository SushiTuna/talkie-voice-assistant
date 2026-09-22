/**
 * Pure utilities for validating and transforming agent-tool definitions and persona profiles.
 *
 * No DOM. Intended for use on the site's console page to generate and parse agent context.
 */

/**
 * Validate a JSON array of tool definitions.
 *
 * @param {string} text — raw JSON string
 * @returns {{ ok: true, tools: unknown[] } | { ok: false, error: string }}
 */
export function validateTools(text) {
  if (!text || !text.trim()) return { ok: true, tools: [] };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }

  if (!Array.isArray(parsed)) return { ok: false, error: 'Not an array' };

  const names = new Set();
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];

    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `Tool ${i + 1}: must be an object` };
    }

    if (item.type !== 'function') {
      return { ok: false, error: `Tool ${i + 1}: "type" must be "function"` };
    }

    if (typeof item.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.name)) {
      return { ok: false, error: `Tool ${i + 1}: "name" is required` };
    }

    if (names.has(item.name)) {
      return { ok: false, error: `Tool ${i + 1}: duplicate name "${item.name}"` };
    }
    names.add(item.name);

    if (!item.description || typeof item.description !== 'string') {
      return { ok: false, error: `Tool ${i + 1}: "description" is required` };
    }

    if (item.parameters == null || Array.isArray(item.parameters) || typeof item.parameters !== 'object') {
      return { ok: false, error: `Tool ${i + 1}: "parameters" is required` };
    }
  }

  return { ok: true, tools: parsed };
}

/**
 * Convert a display name to a URL-friendly slug.
 *
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Comma- or newline-separated keyterms → a trimmed list. */
function splitKeyterms(keyterms) {
  return (keyterms || '').split(/[,\n]+/).map((k) => k.trim()).filter(Boolean);
}

/**
 * Build an agent-context payload suitable for posting to `${api}/agent/context?profile=`.
 *
 * @param {object} opts
 * @param {string} opts.name        — display name
 * @param {string} [opts.description]
 * @param {string} opts.systemPrompt
 * @param {string} [opts.voice]
 * @param {string} [opts.greeting]
 * @param {string} [opts.keyterms]  — comma- or newline-separated keywords
 * @returns {object}
 */
export function toAgentContext({ name, description, systemPrompt, voice, greeting, keyterms, tools }) {
  const result = { profile: slugify(name), system_prompt: systemPrompt };

  if (description) result.description = description;
  const kts = splitKeyterms(keyterms);
  if (kts.length) result.keyterms = kts;
  if (voice) result.voice = voice;
  if (greeting) result.greeting = greeting;
  const parsedTools = validateTools(tools);
  if (parsedTools.ok && parsedTools.tools.length) result.tools = parsedTools.tools;

  return result;
}

/**
 * Inverse of toAgentContext — rebuild a form object from a context response.
 *
 * @param {object} json
 * @returns {{ name: string, systemPrompt: string, description?: string, voice?: string, greeting?: string, keyterms?: string }}
 */
export function fromAgentContext(json) {
  if (!json.profile || !json.system_prompt) {
    throw new Error('Not an agent context: missing profile or system_prompt');
  }

  const result = { name: json.profile, systemPrompt: json.system_prompt };
  if (json.description != null) result.description = json.description;
  if (json.voice != null) result.voice = json.voice;
  if (json.greeting != null) result.greeting = json.greeting;
  if (Array.isArray(json.keyterms)) result.keyterms = json.keyterms.join(', ');
  if (Array.isArray(json.tools) && json.tools.length) result.tools = JSON.stringify(json.tools, null, 2);

  return result;
}

/**
 * The profile *file* the voice server stores in `agents/<name>.json` (what
 * `PUT /agent/profiles/{name}` takes). Unlike the `/agent/context` reply, the prompt goes in
 * `system_prompt_override`: it replaces the prompt the server would build from `agent` and
 * `knowledge` sections, which this console does not edit.
 *
 * @param {object} opts — the console form
 * @returns {object}
 */
export function toServerProfile({ description, systemPrompt, voice, greeting, keyterms, tools }) {
  const result = { system_prompt_override: systemPrompt, greeting };
  if (description) result.description = description;
  if (voice) result.voice = voice;
  const kts = splitKeyterms(keyterms);
  if (kts.length) result.keyterms = kts;
  // Invalid tools are caught before sending (serverProfileProblems), never silently dropped.
  const parsedTools = validateTools(tools);
  if (parsedTools.ok && parsedTools.tools.length) result.tools = parsedTools.tools;
  return result;
}

/** What the voice server requires of a profile file, as messages; empty when it will accept it. */
export function serverProfileProblems({ name, systemPrompt, greeting, tools }) {
  const problems = [];
  const parsedTools = validateTools(tools);
  if (!slugify(name || '')) problems.push('a name');
  if (!(systemPrompt || '').trim()) problems.push('a system prompt');
  if (!(greeting || '').trim()) problems.push('a greeting (the server requires one)');
  if (!parsedTools.ok) problems.push(`valid tools (${parsedTools.error})`);
  return problems;
}

/**
 * Inverse of toServerProfile, for importing a profile file. Only files with a
 * `system_prompt_override` can be edited here; ones built from `agent`/`knowledge` sections
 * would lose that structure.
 *
 * @param {object} json
 * @param {string} name — the file's name, since the file does not carry one
 */
export function fromServerProfile(json, name) {
  if (typeof json.system_prompt_override !== 'string' || !json.system_prompt_override.trim()) {
    throw new Error('This profile is built from agent/knowledge sections; edit it on the server instead.');
  }
  const result = { name, systemPrompt: json.system_prompt_override };
  if (json.description != null) result.description = json.description;
  if (json.voice != null) result.voice = json.voice;
  if (json.greeting != null) result.greeting = json.greeting;
  if (Array.isArray(json.keyterms)) result.keyterms = json.keyterms.join(', ');
  if (Array.isArray(json.tools) && json.tools.length) result.tools = JSON.stringify(json.tools, null, 2);
  return result;
}
