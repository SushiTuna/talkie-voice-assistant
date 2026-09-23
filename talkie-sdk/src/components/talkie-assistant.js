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
 *   label          Launcher hover label. Default `<heading> · Voice`.
 *   heading        The assistant's name: the panel's eyebrow and the launcher's accessible
 *                  name. Default `Product Expert`.
 *   subtitle       The line on the Start screen. Default `Ask about features, pricing,
 *                  integrations, or compatibility.` Conversation mode puts `Just talk.` first.
 *   mode           `conversation` (default): the mic stays open and the agent takes turns
 *                  by itself, speaks its greeting and can be talked over. `push-to-talk`:
 *                  Start Recording / Stop & Send, one question at a time.
 *   idle-timeout   Conversation mode: seconds of silence before it ends itself. Default 60;
 *                  0 never ends it (the mic then streams until closed).
 *   barge-in       `off` stops the caller interrupting a reply by talking (conversation
 *                  mode). Try it if the agent keeps cutting itself off on loudspeakers.
 *   layout         `auto` (default): a bottom sheet on phones (max-width 600px), a floating
 *                  panel above the launcher elsewhere. `sheet` or `floating` forces one.
 *                  The sheet sits on the bottom edge; lift it with
 *                  `--talkie-sheet-offset-bottom` when the page has a bottom bar.
 *   fonts          `google` loads the widget's typefaces from Google Fonts. Off by default:
 *                  that request sends each visitor's IP to Google, which is the host page's
 *                  call to make, not the widget's.
 *
 * Properties (script only — functions and objects cannot be attributes):
 *   tools          Function-tool definitions for the agent, in the Voice Agent API's shape.
 *                  Unset, the profile's `tools` from `/agent/context` are used instead; the
 *                  page still runs every call, so it needs `onToolCall` either way.
 *   onToolCall     `({ name, arguments, call_id }) => result`, run for each tool call; its
 *                  (awaited) value goes back to the agent. Throw to report a failure.
 * Both are read on each open, and may be set before this element is defined:
 *
 *   const el = document.querySelector('talkie-assistant');
 *   el.tools = [{ type: 'function', name: 'go_to_room', description: '…', parameters: {…} }];
 *   el.onToolCall = ({ name, arguments: args }) => navigate(args.room);
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

/** Viewports that get the bottom-sheet layout under `layout="auto"`. */
const SHEET_QUERY = '(max-width: 600px)';

/** Copy attributes passed on as they are, and the child elements that take each one. */
const COPY_TARGETS = { heading: ['launcher', 'widget'], subtitle: ['widget'] };

/** Conversation mode ends itself after this much silence unless `idle-timeout` says otherwise. */
const DEFAULT_IDLE_TIMEOUT_S = 60;

export class TalkieAssistant extends HTMLElement {
  static get observedAttributes() {
    return ['label', 'layout', ...Object.keys(COPY_TARGETS)];
  }

  /** @type {HTMLElement | null} */ #launcher = null;
  /** @type {HTMLElement | null} */ #widget = null;
  /** @type {VoiceAgentBackend | null} */ #backend = null;
  /** @type {Promise<object | null> | null} Server context, fetched once per mount. */ #context = null;
  /** @type {object | null} The context once it has resolved, for the synchronous open path. */ #contextValue = null;
  /** @type {boolean} Guards against a double-click opening two sessions. */ #opening = false;
  /** @type {Array<object> | null} */ #tools = null;
  /** @type {((call: object) => any) | null} */ #onToolCall = null;
  /** @type {MediaQueryList | null} */ #sheetQuery = null;

  constructor() {
    super();
    this._onLaunch = this._onLaunch.bind(this);
    this._onOpen = this._onOpen.bind(this);
    this._onClose = this._onClose.bind(this);
    this._onPageHide = this._onPageHide.bind(this);
    this._onMinimize = this._onMinimize.bind(this);
    this._onRestore = this._onRestore.bind(this);
    this._onStateChange = this._onStateChange.bind(this);
    this._applyLayout = this._applyLayout.bind(this);
  }

  // ── configuration, read fresh on each open so attribute edits take effect ──

  get api() {
    return (this.getAttribute('api') || DEFAULT_API).replace(/\/+$/, '');
  }

  get tokenUrl() {
    return this.getAttribute('token-url') || `${this.api}/agent/token`;
  }

  /** @returns {'conversation' | 'push-to-talk'} */
  get mode() {
    return this.getAttribute('mode') === 'push-to-talk' ? 'push-to-talk' : 'conversation';
  }

  /** @returns {number} Seconds; 0 disables the limit. */
  get idleTimeout() {
    const raw = this.getAttribute('idle-timeout');
    const n = raw === null ? DEFAULT_IDLE_TIMEOUT_S : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_TIMEOUT_S;
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

  /** Function-tool definitions sent to the agent on the next open. */
  get tools() {
    return this.#tools;
  }

  set tools(value) {
    this.#tools = Array.isArray(value) && value.length ? value : null;
  }

  /** Runs each tool call the agent makes; its resolved value is the tool result. */
  get onToolCall() {
    return this.#onToolCall;
  }

  set onToolCall(fn) {
    this.#onToolCall = typeof fn === 'function' ? fn : null;
  }

  // ── lifecycle ──

  connectedCallback() {
    // A page script may set these before the embed bundle defines this element; that makes
    // own properties on the plain element that hide the accessors. Re-apply them. Here rather
    // than in the constructor: an upgrade runs both, and this is also reachable from a test.
    for (const prop of ['tools', 'onToolCall']) {
      if (Object.prototype.hasOwnProperty.call(this, prop)) {
        const value = this[prop];
        delete this[prop];
        this[prop] = value;
      }
    }
    if (this.#widget) return; // moved within the page; already mounted
    if (this.getAttribute('fonts') === 'google') loadFonts(this.ownerDocument);

    this.#launcher = this.ownerDocument.createElement('talkie-launcher');
    if (this.hasAttribute('label')) this.#launcher.setAttribute('label', this.getAttribute('label'));
    this.#launcher.style.zIndex = Z_INDEX;

    this.#widget = this.ownerDocument.createElement('talkie-widget');
    this.#widget.style.position = 'fixed';
    this.#widget.style.zIndex = Z_INDEX;
    const win = this.ownerDocument.defaultView;
    this.#sheetQuery = typeof win?.matchMedia === 'function' ? win.matchMedia(SHEET_QUERY) : null;
    this.#sheetQuery?.addEventListener?.('change', this._applyLayout);
    this._applyLayout();

    for (const name of Object.keys(COPY_TARGETS)) this.#forwardCopy(name, this.getAttribute(name));

    this.append(this.#launcher, this.#widget);
    this.addEventListener('talkie-launch', this._onLaunch);
    this.#widget.addEventListener('talkie-open', this._onOpen);
    this.#widget.addEventListener('talkie-close', this._onClose);
    this.#widget.addEventListener('talkie-minimize', this._onMinimize);
    this.#widget.addEventListener('talkie-restore', this._onRestore);
    this.#widget.addEventListener('talkie-state-change', this._onStateChange);
    // disconnectedCallback does not run when the tab closes, and an open agent session
    // otherwise lingers at the vendor until its resume window lapses.
    this.ownerDocument.defaultView?.addEventListener('pagehide', this._onPageHide);

    // Fetched ahead of the first open so opening is not held up by it. Cheap, and it
    // mints nothing: the token is only requested once the widget opens.
    this.#context = Promise.resolve(this._loadContext()).then((ctx) => (this.#contextValue = ctx));
  }

  disconnectedCallback() {
    // A move within the document disconnects and reconnects in the same task.
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.removeEventListener('talkie-launch', this._onLaunch);
      this.ownerDocument.defaultView?.removeEventListener('pagehide', this._onPageHide);
      this.#sheetQuery?.removeEventListener?.('change', this._applyLayout);
      this.#sheetQuery = null;
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
    if (name === 'layout') {
      if (this.#widget) this._applyLayout();
      return;
    }
    if (name === 'label' && this.#launcher) {
      if (value === null) this.#launcher.removeAttribute('label');
      else this.#launcher.setAttribute('label', value);
    }
    if (name in COPY_TARGETS && this.#widget) this.#forwardCopy(name, value);
  }

  /** Set (or, for null, remove) a copy attribute on the children that show it. */
  #forwardCopy(name, value) {
    const children = { launcher: this.#launcher, widget: this.#widget };
    for (const target of COPY_TARGETS[name]) {
      if (value === null) children[target].removeAttribute(name);
      else children[target].setAttribute(name, value);
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

  /** Hide the panel and keep the conversation going; the launcher shows it is still on. */
  minimize() {
    this.#widget?.minimize();
  }

  /** Bring a minimized panel back. */
  restore() {
    this.#widget?.restore();
  }

  /** Close the assistant and end its agent session. */
  close() {
    this.#widget?.hide('closed by host');
  }

  // ── internals ──

  _onLaunch(e) {
    // The launcher's event is ours alone; a host page listening higher up has no use for it.
    e.stopPropagation();
    if (this.#widget?.minimized) this.#widget.restore();
    else this.open();
  }

  /** @returns {'sheet' | 'floating'} */
  get layout() {
    const attr = this.getAttribute('layout');
    if (attr === 'sheet' || attr === 'floating') return attr;
    return this.#sheetQuery?.matches ? 'sheet' : 'floating';
  }

  /**
   * Place the widget for the current layout. Floating: above the launcher, which sits 28px
   * from the corner and is 60px tall; the width cap keeps a 16px gutter on a phone and the
   * widget's own :host caps it at 430px. Sheet: the full width of the bottom edge.
   */
  _applyLayout() {
    const w = this.#widget;
    if (!w) return;
    if (this.layout === 'sheet') {
      w.layout = 'sheet';
      Object.assign(w.style, {
        left: '0', right: '0', width: 'auto',
        bottom: 'var(--talkie-sheet-offset-bottom, 0px)',
      });
    } else {
      w.layout = undefined;
      w.removeAttribute('layout');
      Object.assign(w.style, {
        left: '', right: '28px', width: 'min(430px, calc(100vw - 32px))', bottom: '104px',
      });
    }
  }

  _onMinimize() {
    if (!this.#launcher) return;
    this.#launcher.state = this.#widget?.state ?? 'idle';
    this.#launcher.active = true;
    this.#launcher.open = false;
  }

  _onRestore() {
    if (!this.#launcher) return;
    this.#launcher.active = false;
    this.#launcher.open = true;
  }

  _onStateChange(e) {
    if (this.#launcher) this.#launcher.state = e.detail?.to ?? 'idle';
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
    const conversation = this.mode === 'conversation';
    this.#widget.mode = this.mode;
    this.#widget.idleTimeout = this.idleTimeout;
    this.#backend = this._createBackend({
      // Conversation only: in push-to-talk the greeting would land while the caller is
      // already being recorded (README), and nothing can barge in on a closed mic.
      greeting: conversation ? (context?.greeting || undefined) : undefined,
      bargeIn: conversation && this.getAttribute('barge-in') !== 'off',
      tokenUrl: this.tokenUrl,
      systemPrompt: context?.system_prompt ?? this.getAttribute('system-prompt') ?? FALLBACK_PROMPT,
      keyterms: context?.keyterms ?? undefined,
      voice: context?.voice ?? this.getAttribute('voice') ?? undefined,
      tools: this.#sessionTools(context),
      // Looked up per call, so a handler replaced while the panel is open is the one used.
      onToolCall: (call) => {
        if (!this.#onToolCall) throw new Error(`No handler for tool "${call.name}"`);
        return this.#onToolCall(call);
      },
    });
    this.#widget.backend = this.#backend;
    // Token and audio graph only. The mic stays shut until the caller presses Start:
    // opening a chat panel is not consent to the browser's recording indicator.
    this.#backend.prewarm({ mic: false });
  }

  /**
   * The page's tools when it set any (it holds their handlers), else the server profile's.
   * @returns {Array<object> | undefined}
   */
  #sessionTools(context) {
    if (this.#tools) return this.#tools;
    const served = Array.isArray(context?.tools) && context.tools.length ? context.tools : undefined;
    if (served && !this.#onToolCall) {
      console.warn(
        `[talkie] the server profile declares tools (${served.map((t) => t.name).join(', ')}) `
        + 'but no onToolCall is set, so every call will fail. Set el.onToolCall.',
      );
    }
    return served;
  }

  /**
   * Build the session's backend. A seam for tests and subclasses; not part of the public API.
   * @param {object} options - `VoiceAgentBackend` constructor options.
   * @returns {VoiceAgentBackend}
   */
  _createBackend(options) {
    return new VoiceAgentBackend(options);
  }

  _onClose() {
    if (this.#launcher) {
      this.#launcher.open = false;
      this.#launcher.active = false;
    }
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
  /**
   * The session's persona: the server's `/agent/context` reply, or null for the fallback.
   * A seam for tests and subclasses; not part of the public API.
   * @returns {Promise<object | null> | object | null}
   */
  _loadContext() {
    return this.#fetchContext();
  }

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
