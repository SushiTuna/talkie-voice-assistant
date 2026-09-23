/**
 * The voice server's agent profiles (personas): list them, read one, save one; and the output
 * voices a profile can use.
 *
 *   GET ${api}/agent/profiles                → listAgentProfiles
 *   GET ${api}/agent/voices                  → listVoices
 *   GET ${api}/agent/context?profile=<name>  → fetchAgentContext
 *   PUT ${api}/agent/profiles/{name}         → saveAgentProfile
 *
 * Reading is open, like the context fetch `<talkie-assistant>` already makes. Saving is off
 * unless the server has TALKIE_PROFILE_ADMIN_TOKEN set, and then needs that token as a Bearer
 * credential — so it belongs in an admin tool such as the persona console, never in a page
 * you ship to visitors.
 *
 * No DOM; `fetch` can be injected for tests.
 */

/** Why a request failed, with the HTTP status (0 when the server could not be reached). */
export class AgentProfileError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {'unreachable'|'not-found'|'disabled'|'unauthorized'|'exists'|'invalid'|'failed'} code
   */
  constructor(message, status, code) {
    super(message);
    this.name = 'AgentProfileError';
    this.status = status;
    this.code = code;
  }
}

const CODE_BY_STATUS = {
  400: 'invalid', 401: 'unauthorized', 403: 'disabled', 404: 'not-found', 409: 'exists', 413: 'invalid', 422: 'invalid',
};

const origin = (api) => api.replace(/\/+$/, '');

/** One request; resolves with the JSON body, or throws an AgentProfileError. */
async function request(doFetch, api, path, init) {
  let res;
  try {
    res = await doFetch(`${origin(api)}${path}`, init);
  } catch (err) {
    throw new AgentProfileError(`Couldn't reach ${api} (${err.message}). Is the voice server running, and does it allow this origin?`, 0, 'unreachable');
  }

  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (res.ok) return body;

  // FastAPI puts the reason in `detail`: a string, or a list of validation errors.
  const detail = typeof body?.detail === 'string'
    ? body.detail
    : Array.isArray(body?.detail) ? body.detail.map((d) => d.msg ?? String(d)).join('; ') : '';
  throw new AgentProfileError(detail || `The server answered ${res.status}.`, res.status, CODE_BY_STATUS[res.status] ?? 'failed');
}

/**
 * Every profile on the server.
 *
 * @param {object} opts
 * @param {string} opts.api
 * @param {typeof fetch} [opts.fetch]
 * @returns {Promise<{ default: string, profiles: Array<{ name: string, description: string }> }>}
 */
export async function listAgentProfiles({ api, fetch: doFetch = globalThis.fetch }) {
  const body = await request(doFetch, api, '/agent/profiles');
  const profiles = Array.isArray(body?.profiles) ? body.profiles : [];
  return {
    default: typeof body?.default === 'string' ? body.default : '',
    profiles: profiles
      .filter((p) => p && typeof p.name === 'string')
      .map((p) => ({ name: p.name, description: typeof p.description === 'string' ? p.description : '' })),
  };
}

/**
 * The output voices the server's agent can speak with. The vendor has no endpoint for this,
 * so the voice server serves its list; a client never hard-codes one.
 *
 * @param {object} opts
 * @param {string} opts.api
 * @param {typeof fetch} [opts.fetch]
 * @returns {Promise<{ default: string, voices: Array<{ id: string, language: string, accent: string }> }>}
 */
export async function listVoices({ api, fetch: doFetch = globalThis.fetch }) {
  const body = await request(doFetch, api, '/agent/voices');
  const voices = Array.isArray(body?.voices) ? body.voices : [];
  const text = (x) => (typeof x === 'string' ? x : '');
  return {
    default: text(body?.default),
    voices: voices
      .filter((v) => v && typeof v.id === 'string' && v.id)
      .map((v) => ({ id: v.id, language: text(v.language), accent: text(v.accent) })),
  };
}

/**
 * One profile as the agent gets it: the composed `system_prompt`, `greeting`, `keyterms`,
 * `voice`, `description` and `tools` (what `<talkie-assistant profile="…">` loads).
 *
 * @param {object} opts
 * @param {string} opts.api
 * @param {string} [opts.profile]  Omit for the server's default profile.
 * @param {typeof fetch} [opts.fetch]
 * @returns {Promise<object>}
 */
export async function fetchAgentContext({ api, profile, fetch: doFetch = globalThis.fetch }) {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  return request(doFetch, api, `/agent/context${query}`);
}

/**
 * Create or replace a profile file on the server (`agents/<name>.json`).
 *
 * @param {object} opts
 * @param {string} opts.api            Voice server origin, e.g. `http://localhost:8000`.
 * @param {string} opts.name           Profile name: letters, digits, `-` or `_`.
 * @param {object} opts.profile        The profile file's JSON (see the voice server's schema).
 * @param {string} opts.adminToken     The server's TALKIE_PROFILE_ADMIN_TOKEN.
 * @param {boolean} [opts.overwrite]   Replace an existing profile; otherwise one throws `exists`.
 * @param {typeof fetch} [opts.fetch]
 * @returns {Promise<{ profile: string, replaced: boolean }>}
 */
export async function saveAgentProfile({ api, name, profile, adminToken, overwrite = false, fetch: doFetch = globalThis.fetch }) {
  const body = await request(doFetch, api, `/agent/profiles/${encodeURIComponent(name)}${overwrite ? '?overwrite=true' : ''}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(profile),
  });
  return { profile: body?.profile ?? name, replaced: !!body?.replaced };
}
