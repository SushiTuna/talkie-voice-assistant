/**
 * <talkie-assistant> — the whole voice assistant as one tag, configured by attributes.
 *
 * `<talkie-widget>` is deliberately unopinionated: it needs a `backend` object assigned
 * from script and a place on the page. That suits an app that owns its layout, but not a
 * page that just wants the assistant. This element is that page's version: it mounts the
 * launcher and the widget, positions them, and builds a `VoiceAgentBackend` from its
 * attributes, so no script beyond the embed file is needed.
 *
 *   <talkie-assistant api="https://voice.example.com" profile="it-support"></talkie-assistant>
 *
 * Attributes (all optional):
 *   api            Origin of the voice server. Default `http://localhost:8000`.
 *   token-url      Token route, if not `${api}/agent/token`.
 *   profile        Server agent profile, passed to `${api}/agent/context?profile=`.
 *   system-prompt  Used only when the server has no context route or it fails.
 *   voice          Output voice, when the server context does not name one.
 *   label          Launcher hover label.
 *   fonts          `google` loads the widget's typefaces from Google Fonts. Off by default:
 *                  that request sends each visitor's IP to Google, which is the host page's
 *                  call to make, not the widget's.
 *
 * Light DOM on purpose: the launcher and widget already isolate their own styles in shadow
 * roots, and staying in the light DOM lets a host page still target them if it must.
 */

import { VoiceAgentBackend } from '../backends/voice-agent-backend.js';

const DEFAULT_API = 'http://localhost:8000';
const FALLBACK_PROMPT = 'You are a concise voice assistant. Answer in one or two sentences.';
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600..700&family=Instrument+Sans:wght@400&display=swap';

/**
 * High enough to clear typical host-page headers and modals. The launcher's own `:host`
 * says 60, which is fine on the demo page and buried under most real sites; an inline
 * style on the host element outranks `:host`, so it is set here rather than there.
 */
const Z_INDEX = '2147483000';

export class TalkieAssistant extends HTMLElement {
  static get observedAttributes() {
    return ['label'];
  }

  /** @type {HTMLElement | null} */ #launcher = null;
  /** @type {HTMLElement | null} */ #widget = null;
  /** @type {VoiceAgentBackend | null} */ #backend = null;
  /** @type {Promise<object | null> | null} Server context, fetched once per mount. */ #context = null;
  /** @type {object | null} The context once it has resolved, for the synchronous open path. */ #contextValue = null;
  /** @type {boolean} Guards against a double-click opening two sessions. */ #opening = false;

  constructor() {
    super();
    this._onLaunch = this._onLaunch.bind(this);
    this._onOpen = this._onOpen.bind(this);
    this._onClose = this._onClose.bind(this);
    this._onPageHide = this._onPageHide.bind(this);
  }

  // ── configuration, read fresh on each open so attribute edits take effect ──

  get api() {
    return (this.getAttribute('api') || DEFAULT_API).replace(/\/+$/, '');
  }

  get tokenUrl() {
    return this.getAttribute('token-url') || `${this.api}/agent/token`;
  }

  get contextUrl() {
    const profile = this.getAttribute('profile');
    return `${this.api}/agent/context${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`;
  }

  /** The widget, for callers who want its `talkie-*` events. Null until mounted. */
  get widget() {
    return this.#widget;
  }

  /** The live backend, or null while the assistant is closed. */
  get backend() {
    return this.#backend;
  }

  // ── lifecycle ──

  connectedCallback() {
    if (this.#widget) return; // moved within the page; already mounted
    if (this.getAttribute('fonts') === 'google') loadFonts(this.ownerDocument);

    this.#launcher = this.ownerDocument.createElement('talkie-launcher');
    if (this.hasAttribute('label')) this.#launcher.setAttribute('label', this.getAttribute('label'));
    this.#launcher.style.zIndex = Z_INDEX;

    this.#widget = this.ownerDocument.createElement('talkie-widget');
    // Above the launcher, which sits 28px from the corner and is 60px tall. The width cap
    // keeps a 16px gutter on a phone; the widget's own :host caps it at 430px.
    Object.assign(this.#widget.style, {
      position: 'fixed',
      right: '28px',
      bottom: '104px',
      width: 'min(430px, calc(100vw - 32px))',
      zIndex: Z_INDEX,
    });

    this.append(this.#launcher, this.#widget);
    this.addEventListener('talkie-launch', this._onLaunch);
    this.#widget.addEventListener('talkie-open', this._onOpen);
    this.#widget.addEventListener('talkie-close', this._onClose);
    // disconnectedCallback does not run when the tab closes, and an open agent session
    // otherwise lingers at the vendor until its resume window lapses.
    this.ownerDocument.defaultView?.addEventListener('pagehide', this._onPageHide);

    // Fetched ahead of the first open so opening is not held up by it. Cheap, and it
    // mints nothing: the token is only requested once the widget opens.
    this.#context = this.#fetchContext().then((ctx) => (this.#contextValue = ctx));
  }

  disconnectedCallback() {
    // A move within the document disconnects and reconnects in the same task.
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.removeEventListener('talkie-launch', this._onLaunch);
      this.ownerDocument.defaultView?.removeEventListener('pagehide', this._onPageHide);
      this.#endSession();
      this.#launcher?.remove();
      this.#widget?.remove();
      this.#launcher = null;
      this.#widget = null;
      this.#context = null;
      this.#contextValue = null;
    });
  }

  attributeChangedCallback(name, _old, value) {
    if (name === 'label' && this.#launcher) {
      if (value === null) this.#launcher.removeAttribute('label');
      else this.#launcher.setAttribute('label', value);
    }
  }

  // ── public API ──

  /** Open the assistant. The agent session itself starts in `_onOpen`. */
  async open() {
    if (!this.#widget || this.#widget.open || this.#opening) return;
    this.#opening = true;
    try {
      // Waiting here means the session is built with the server's persona rather than the
      // fallback. Locally this resolved long before the click; it only matters on a slow link.
      await this.#context;
      this.#widget?.show();
    } finally {
      this.#opening = false;
    }
  }

  /** Close the assistant and end its agent session. */
  close() {
    this.#widget?.hide('closed by host');
  }

  // ── internals ──

  _onLaunch(e) {
    // The launcher's event is ours alone; a host page listening higher up has no use for it.
    e.stopPropagation();
    this.open();
  }

  /**
   * Start the agent session whenever the widget opens, by whatever route — this element's
   * open(), or a host calling `widget.show()` directly. Runs synchronously inside show(),
   * so the backend is in place before the caller can press Start.
   */
  _onOpen() {
    if (this.#launcher) this.#launcher.open = true;
    if (this.#backend) return;
    const context = this.#contextValue;
    this.#backend = new VoiceAgentBackend({
      tokenUrl: this.tokenUrl,
      systemPrompt: context?.system_prompt ?? this.getAttribute('system-prompt') ?? FALLBACK_PROMPT,
      keyterms: context?.keyterms ?? undefined,
      voice: context?.voice ?? this.getAttribute('voice') ?? undefined,
    });
    this.#widget.backend = this.#backend;
    // Token and audio graph only. The mic stays shut until the caller presses Start:
    // opening a chat panel is not consent to the browser's recording indicator.
    this.#backend.prewarm({ mic: false });
  }

  _onClose() {
    if (this.#launcher) this.#launcher.open = false;
    this.#endSession();
  }

  _onPageHide() {
    this.#endSession();
  }

  /**
   * Dispose the backend. A session holds a vendor slot even while idle, so the next open
   * builds a fresh one rather than keeping this one alive behind a closed panel.
   */
  #endSession() {
    this.#backend?.dispose();
    this.#backend = null;
    if (this.#widget) this.#widget.backend = null;
  }

  /** @returns {Promise<object | null>} The server's agent context, or null without one. */
  async #fetchContext() {
    try {
      const res = await fetch(this.contextUrl);
      if (!res.ok) {
        console.warn(`[talkie] ${this.contextUrl} returned ${res.status}; using the fallback prompt.`);
        return null;
      }
      return await res.json();
    } catch (err) {
      // Not fatal: the agent still answers, just without the server's persona. The token
      // route, which is fatal, reports its own failure when the caller presses Start.
      console.warn(`[talkie] could not load ${this.contextUrl}:`, err?.message ?? err);
      return null;
    }
  }
}

/** Add the widget's typefaces once per document. */
function loadFonts(doc) {
  if (doc.querySelector(`link[href="${FONT_HREF}"]`)) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONT_HREF;
  doc.head.append(link);
}
