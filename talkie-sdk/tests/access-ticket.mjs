/**
 * Tests for visitor tickets (src/core/access-ticket.js) and their use by both backends and
 * <talkie-assistant>, against a fake voice server that behaves like token_guard.py.
 */

import { AccessTicket } from '../src/core/access-ticket.js';
import { TalkieBackendError } from '../src/core/backend.js';
import { VoiceAgentBackend } from '../src/backends/voice-agent-backend.js';
import { HttpBackend } from '../src/backends/http-backend.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

async function rejection(promise) {
  try { await promise; return null; } catch (err) { return err; }
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

/**
 * A fake voice server. `tickets`: token routes need a Bearer ticket. `turnstile`: the session
 * route needs `verification: 'human'` first. Records every request.
 */
function fakeServer({ tickets = true, turnstile = false, ttl = 1800 } = {}) {
  const calls = [];
  let issued = 0;
  const valid = new Set();
  const fn = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const path = new URL(url, 'http://x').pathname;
    const call = { path, method: init.method ?? 'GET', auth: headers.get('Authorization'), body: init.body };
    calls.push(call);
    if (path.endsWith('/agent/session')) {
      if (!tickets) return json(404, { detail: { code: 'tickets_disabled', message: 'off' } });
      const body = JSON.parse(init.body || '{}');
      if (turnstile && !body.verification) {
        return json(401, { detail: { code: 'verification_required', provider: 'turnstile', site_key: 'site-1' } });
      }
      if (turnstile && body.verification !== 'human') {
        return json(403, { detail: { code: 'verification_failed', message: 'The bot check did not pass.' } });
      }
      const ticket = `ticket-${++issued}`;
      valid.add(ticket);
      return json(200, { ticket, expires_in_seconds: ttl });
    }
    if (path.endsWith('/agent/token') || path.endsWith('/stt/token')) {
      if (tickets) {
        const ticket = call.auth?.replace(/^Bearer /, '');
        if (!ticket) return json(401, { detail: { code: 'ticket_required', message: 'x' } });
        if (!valid.has(ticket)) return json(401, { detail: { code: 'ticket_invalid', message: 'x' } });
      }
      return path.endsWith('/agent/token')
        ? json(200, { token: 'agent-token', expires_in_seconds: 300 })
        : json(200, { ws_url: 'wss://x', expires_in_seconds: 60, sample_rate: 16000, encoding: 'pcm_s16le' });
    }
    if (path.endsWith('/chat/session')) return json(200, { session_id: 's1', opening_greeting: 'Hi', model: 'm' });
    return json(404, { detail: 'not found' });
  };
  fn.calls = calls;
  fn.revoke = () => valid.clear();
  return fn;
}

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

// ── AccessTicket against a server without tickets ──────────────────────────
{
  const server = fakeServer({ tickets: false });
  const access = new AccessTicket({ sessionUrl: 'http://v/agent/session', fetch: server });
  const res = await access.fetch('http://v/agent/token');
  check('no tickets on the server: the token request goes straight through', res.ok);
  check('...with no session request and no Authorization header',
    server.calls.length === 1 && server.calls[0].auth === null);
}

// ── AccessTicket with tickets ───────────────────────────────────────────────
{
  const server = fakeServer();
  const access = new AccessTicket({ sessionUrl: 'http://v/agent/session', fetch: server });
  const res = await access.fetch('http://v/agent/token');
  check('a ticket_required refusal gets a ticket and retries', res.ok && (await res.json()).token === 'agent-token');
  check('...as token, POST session, token',
    server.calls.map((c) => `${c.method} ${c.path}`).join(', ') === 'GET /agent/token, POST /agent/session, GET /agent/token');
  check('...the retry carries the ticket as a Bearer credential', server.calls[2].auth === 'Bearer ticket-1');

  await access.fetch('http://v/agent/token');
  check('the next request sends the held ticket first time, with no new session',
    server.calls.length === 4 && server.calls[3].auth === 'Bearer ticket-1');

  server.revoke();
  const again = await access.fetch('http://v/agent/token');
  check('a ticket_invalid refusal replaces the ticket and retries', again.ok && server.calls.at(-1).auth === 'Bearer ticket-2');
}

{
  const server = fakeServer();
  const access = new AccessTicket({ sessionUrl: 'http://v/agent/session', fetch: server });
  await Promise.all([access.fetch('http://v/agent/token'), access.fetch('http://v/agent/token')]);
  check('two token requests at once share one session request',
    server.calls.filter((c) => c.path === '/agent/session').length === 1);
}

{
  const server = fakeServer({ ttl: 20 }); // shorter than the 30 s safety margin
  const access = new AccessTicket({ sessionUrl: 'http://v/agent/session', fetch: server });
  await access.fetch('http://v/agent/token');
  await access.fetch('http://v/agent/token');
  check('a ticket inside the 30 s expiry margin is not sent; a new one is fetched',
    server.calls[3].auth === null && server.calls.filter((c) => c.path === '/agent/session').length === 2,
    server.calls.map((c) => `${c.path}:${c.auth}`).join(' '));
}

{
  const server = fakeServer();
  const access = new AccessTicket({ sessionUrl: 'http://v/agent/session', fetch: server });
  const res = await access.fetch('http://v/other', { headers: { 'X-Keep': '1' } });
  check('other 4xx answers pass through untouched', res.status === 404 && server.calls.length === 1);
}

// ── bot check ───────────────────────────────────────────────────────────────
{
  const server = fakeServer({ turnstile: true });
  const challenges = [];
  const access = new AccessTicket({
    sessionUrl: 'http://v/agent/session',
    fetch: server,
    verify: async (challenge) => { challenges.push(challenge); return 'human'; },
  });
  const res = await access.fetch('http://v/agent/token');
  check('a verification_required answer runs verify, then the token request succeeds', res.ok);
  check('verify gets the provider and site key the server named',
    challenges.length === 1 && challenges[0].provider === 'turnstile' && challenges[0].siteKey === 'site-1');
  const posts = server.calls.filter((c) => c.method === 'POST');
  check('the second session POST carries the verification token',
    posts.length === 2 && JSON.parse(posts[1].body).verification === 'human');
}

{
  const server = fakeServer({ turnstile: true });
  const access = new AccessTicket({ sessionUrl: 'http://v/agent/session', fetch: server });
  const err = await rejection(access.fetch('http://v/agent/token'));
  check('no verify hook: a backend-failure that says why',
    err instanceof TalkieBackendError && err.reason === 'backend-failure' && /no verify hook/.test(err.message), err?.message);
}

{
  const server = fakeServer({ turnstile: true });
  const access = new AccessTicket({ sessionUrl: 'http://v/agent/session', fetch: server, verify: () => 'robot' });
  const err = await rejection(access.fetch('http://v/agent/token'));
  check('a failed check is a backend-failure carrying the server message',
    err?.reason === 'backend-failure' && /403/.test(err.message) && /bot check did not pass/.test(err.message), err?.message);
}

{
  const server = fakeServer({ turnstile: true });
  const access = new AccessTicket({
    sessionUrl: 'http://v/agent/session', fetch: server, verify: () => { throw new Error('widget blocked'); },
  });
  const err = await rejection(access.fetch('http://v/agent/token'));
  check('a verify hook that throws is a backend-failure', err?.reason === 'backend-failure' && /widget blocked/.test(err.message), err?.message);
}

{
  let hook = null;
  const server = fakeServer({ turnstile: true });
  const access = new AccessTicket({ sessionUrl: 'http://v/agent/session', fetch: server, getVerify: () => hook });
  hook = () => 'human';
  check('getVerify looks the hook up when it is needed, not at construction', (await access.fetch('http://v/agent/token')).ok);
}

// ── backends ────────────────────────────────────────────────────────────────
await withFetch(fakeServer(), async () => {
  const server = globalThis.fetch;
  const b = new VoiceAgentBackend({ baseUrl: 'http://v/' });
  const done = await b.prewarm();
  check('VoiceAgentBackend gets a ticket from ${baseUrl}/agent/session and mints its token',
    done.token && server.calls.some((c) => c.path === '/agent/session') && server.calls.at(-1).auth === 'Bearer ticket-1',
    server.calls.map((c) => c.path).join(' '));
  b.dispose();
});

await withFetch(fakeServer(), async () => {
  const server = globalThis.fetch;
  const b = new VoiceAgentBackend({ baseUrl: 'http://v', sessionUrl: 'http://gate/custom/agent/session', tokenUrl: 'http://gate/agent/token' });
  const done = await b.prewarm();
  check('VoiceAgentBackend honours sessionUrl',
    done.token && server.calls.some((c) => c.path === '/custom/agent/session' && c.method === 'POST'));
  b.dispose();
});

await withFetch(fakeServer(), async () => {
  const server = globalThis.fetch;
  const access = new AccessTicket({ sessionUrl: 'http://v/agent/session' });
  const a = new VoiceAgentBackend({ baseUrl: 'http://v', access });
  const b = new VoiceAgentBackend({ baseUrl: 'http://v', access });
  await a.prewarm();
  await b.prewarm();
  check('backends sharing an AccessTicket share one visitor ticket',
    server.calls.filter((c) => c.path === '/agent/session').length === 1);
  a.dispose(); b.dispose();
});

// Error mapping through startCapture() needs the browser shim: see voice-agent-backend.mjs.

await withFetch(fakeServer(), async () => {
  const server = globalThis.fetch;
  const b = new HttpBackend({ baseUrl: 'http://v' });
  const done = await b.prewarm();
  const stt = server.calls.filter((c) => c.path === '/stt/token');
  check('HttpBackend gets a ticket for /stt/token', done.token && stt.at(-1).auth === 'Bearer ticket-1',
    server.calls.map((c) => `${c.path}:${c.auth}`).join(' '));
  check('...and sends no ticket to its other routes',
    server.calls.filter((c) => c.path === '/chat/session').every((c) => c.auth === null));
  b.dispose();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
