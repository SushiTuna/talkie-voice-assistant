/**
 * Visitor tickets for the voice server's token routes.
 *
 * When the server sets `TALKIE_TICKET_SECRET`, `/agent/token` and `/stt/token` answer
 * `401 { detail: { code: 'ticket_required' } }` until the request carries
 * `Authorization: Bearer <ticket>`. A ticket comes from `POST /agent/session`, which may first
 * ask for a bot check: `401 { detail: { code: 'verification_required', provider, site_key } }`.
 * The page answers that through `verify`, e.g. by running Cloudflare Turnstile.
 *
 * Nothing here runs against a server without tickets: the first token request succeeds and no
 * session is ever requested. One `AccessTicket` should live as long as the page's visitor, so
 * the server's per-visitor quota counts them once; `<talkie-assistant>` keeps one across opens.
 */

import { TalkieBackendError } from './backend.js';

/** Re-fetch this long before the server's expiry, so a ticket never lapses mid-request. */
const EXPIRY_MARGIN_MS = 30_000;

/** Codes on a token route's 401 that a fresh ticket fixes. */
const TICKET_CODES = new Set(['ticket_required', 'ticket_invalid']);

/** The `detail.code` of a JSON error body, or null. Reads a clone; `res` stays unread. */
async function errorCode(res) {
  try {
    const body = await res.clone().json();
    return typeof body?.detail?.code === 'string' ? body.detail.code : null;
  } catch {
    return null;
  }
}

async function errorDetail(res) {
  try {
    const body = await res.json();
    return body?.detail && typeof body.detail === 'object' ? body.detail : {};
  } catch {
    return {};
  }
}

export class AccessTicket {
  /** @type {string} */ #sessionUrl;
  /** @type {() => ((challenge: object) => Promise<string> | string) | null} */ #getVerify;
  /** @type {typeof fetch} */ #fetch;
  /** @type {{ ticket: string, until: number } | null} */ #held = null;
  /** @type {Promise<string> | null} */ #pending = null;

  /**
   * @param {object} options
   * @param {string} options.sessionUrl - The server's `POST /agent/session` route.
   * @param {((challenge: { provider: string, siteKey: string | null }) => Promise<string> | string)
   *   | (() => any) | null} [options.verify] - Runs the bot check the server asks for and
   *   resolves to its token. Pass `getVerify` instead to look the hook up per use.
   * @param {() => any} [options.getVerify] - Returns the current `verify` hook.
   * @param {typeof fetch} [options.fetch]
   */
  constructor({ sessionUrl, verify = null, getVerify = null, fetch: doFetch = null }) {
    this.#sessionUrl = sessionUrl;
    this.#getVerify = getVerify ?? (() => verify);
    this.#fetch = doFetch ?? ((...args) => globalThis.fetch(...args));
  }

  /**
   * `fetch(url, init)`, with the ticket attached once the server has asked for one. On a
   * ticket refusal, gets a new ticket and retries once. Network errors reject as fetch does.
   * @returns {Promise<Response>}
   */
  async fetch(url, init = {}) {
    const held = this.#current();
    const res = await this.#fetch(url, held ? this.#withTicket(init, held) : init);
    if (res.status !== 401 || !TICKET_CODES.has(await errorCode(res))) return res;
    this.#held = null;
    const ticket = await this.#obtain();
    return this.#fetch(url, this.#withTicket(init, ticket));
  }

  /** Forget the ticket, e.g. when the visitor signs out. */
  clear() {
    this.#held = null;
  }

  #current() {
    return this.#held && Date.now() < this.#held.until ? this.#held.ticket : null;
  }

  #withTicket(init, ticket) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${ticket}`);
    return { ...init, headers };
  }

  /** One session request at a time: prewarm and Start can both ask for a ticket at once. */
  #obtain() {
    this.#pending ??= this.#requestTicket().finally(() => { this.#pending = null; });
    return this.#pending;
  }

  async #requestTicket() {
    let res = await this.#post({});
    if (res.status === 401 && (await errorCode(res)) === 'verification_required') {
      const detail = await errorDetail(res);
      const verify = this.#getVerify();
      if (typeof verify !== 'function') {
        throw new TalkieBackendError(
          'backend-failure',
          `The voice server asks for a ${detail.provider || 'bot'} check, and the page set no verify hook.`,
        );
      }
      let verification;
      try {
        verification = await verify({ provider: detail.provider ?? null, siteKey: detail.site_key ?? null });
      } catch (err) {
        throw new TalkieBackendError('backend-failure', `Bot check failed: ${err?.message || err}`);
      }
      res = await this.#post({ verification });
    }
    if (!res.ok) {
      const detail = await errorDetail(res);
      throw new TalkieBackendError(
        'backend-failure',
        `POST ${this.#sessionUrl} failed: HTTP ${res.status}${detail.message ? ` (${detail.message})` : ''}`,
      );
    }
    const body = await res.json();
    if (typeof body?.ticket !== 'string' || !body.ticket) {
      throw new TalkieBackendError('backend-failure', 'Session response carried no ticket.');
    }
    const lifeMs = Math.max(0, (Number(body.expires_in_seconds) || 0) * 1000 - EXPIRY_MARGIN_MS);
    this.#held = { ticket: body.ticket, until: Date.now() + lifeMs };
    return body.ticket;
  }

  #post(body) {
    return this.#fetch(this.#sessionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
