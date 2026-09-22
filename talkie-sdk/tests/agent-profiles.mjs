/**
 * Tests for the voice server profile client: list, fetch and save.
 */

import { listAgentProfiles, fetchAgentContext, saveAgentProfile, AgentProfileError } from '../src/core/agent-profiles.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

/** A fetch that records its call and answers with `status` and a JSON body. */
function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

async function rejection(promise) {
  try { await promise; return null; } catch (err) { return err; }
}

const base = { api: 'http://localhost:8000/', name: 'my agent', adminToken: 's3cret', profile: { greeting: 'Hi', system_prompt_override: 'Be kind.' } };

{
  const f = fakeFetch(200, { profile: 'my agent', replaced: false });
  const result = await saveAgentProfile({ ...base, fetch: f });
  const { url, init } = f.calls[0];
  check('PUTs to /agent/profiles/{name}, trailing slash trimmed, name encoded', url === 'http://localhost:8000/agent/profiles/my%20agent', url);
  check('uses PUT', init.method === 'PUT');
  check('sends the admin token as a Bearer credential', init.headers.Authorization === 'Bearer s3cret');
  check('sends the profile as JSON', init.headers['Content-Type'] === 'application/json' && JSON.parse(init.body).greeting === 'Hi');
  check('does not ask to overwrite by default', !url.includes('overwrite'));
  check('resolves with the server reply', result.profile === 'my agent' && result.replaced === false);
}

{
  const f = fakeFetch(200, { profile: 'x', replaced: true });
  const result = await saveAgentProfile({ ...base, overwrite: true, fetch: f });
  check('overwrite adds ?overwrite=true', f.calls[0].url.endsWith('?overwrite=true'));
  check('reports a replacement', result.replaced === true);
}

for (const [status, code] of [[401, 'unauthorized'], [403, 'disabled'], [409, 'exists'], [422, 'invalid'], [500, 'failed']]) {
  const err = await rejection(saveAgentProfile({ ...base, fetch: fakeFetch(status, { detail: `reason ${status}` }) }));
  check(`${status} → AgentProfileError code "${code}" with the server's detail`,
    err instanceof AgentProfileError && err.code === code && err.status === status && err.message === `reason ${status}`,
    err && `${err.code} ${err.message}`);
}

{
  const err = await rejection(saveAgentProfile({ ...base, fetch: fakeFetch(422, { detail: [{ msg: 'field required' }, { msg: 'bad type' }] }) }));
  check('a FastAPI validation list becomes one message', err?.message === 'field required; bad type', err?.message);
}

{
  const f = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('not json'); } });
  const err = await rejection(saveAgentProfile({ ...base, fetch: f }));
  check('a non-JSON error page still gives a message', err?.code === 'failed' && err.message.includes('502'), err?.message);
}

{
  const f = async () => { throw new TypeError('Failed to fetch'); };
  const err = await rejection(saveAgentProfile({ ...base, fetch: f }));
  check('a network failure is "unreachable" with status 0', err?.code === 'unreachable' && err.status === 0 && err.message.includes('localhost:8000'), err?.message);
}

/* ---------------------------------------------------------------- list and fetch */

{
  const f = fakeFetch(200, {
    default: 'property',
    profiles: [{ name: 'property', description: 'The tour' }, { name: 'finance' }, { bogus: true }],
  });
  const list = await listAgentProfiles({ api: 'http://localhost:8000/', fetch: f });
  check('listAgentProfiles GETs /agent/profiles', f.calls[0].url === 'http://localhost:8000/agent/profiles' && !f.calls[0].init?.method);
  check('...returns the default profile name', list.default === 'property');
  check('...and each profile, with an empty description when missing and junk dropped',
    list.profiles.length === 2 && list.profiles[1].name === 'finance' && list.profiles[1].description === '', JSON.stringify(list.profiles));
}

{
  const list = await listAgentProfiles({ api: 'x', fetch: fakeFetch(200, {}) });
  check('an unexpected list body gives an empty list, not a crash', list.profiles.length === 0 && list.default === '');
}

{
  const ctx = { profile: 'it support', system_prompt: 'You fix things.', greeting: 'Hi', tools: [] };
  const f = fakeFetch(200, ctx);
  const got = await fetchAgentContext({ api: 'http://localhost:8000', profile: 'it support', fetch: f });
  check('fetchAgentContext GETs /agent/context with the profile encoded',
    f.calls[0].url === 'http://localhost:8000/agent/context?profile=it%20support', f.calls[0].url);
  check('...and returns the context', got.system_prompt === 'You fix things.');

  const g = fakeFetch(200, ctx);
  await fetchAgentContext({ api: 'http://localhost:8000', fetch: g });
  check('no profile asks for the server default', g.calls[0].url === 'http://localhost:8000/agent/context');

  const err = await rejection(fetchAgentContext({ api: 'x', profile: 'nope', fetch: fakeFetch(404, { detail: "No profile 'nope'" }) }));
  check('a missing profile is code "not-found" with the server\'s message', err?.code === 'not-found' && err.message.includes('nope'), err?.message);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
