// The bot check for the Talkie voice assistant (index.html <talkie-assistant>).
//
// When the voice server sets TURNSTILE_SECRET_KEY, its POST /agent/session answers
// `verification_required` with a Cloudflare Turnstile site key, and <talkie-assistant> calls
// its `verify` hook with `{ provider, siteKey }`. This hook runs Turnstile and resolves to the
// token the server then checks with Cloudflare's siteverify. Nothing loads until the server
// asks: with the check off, Cloudflare's script is never fetched.
//
// Turnstile renders into a light-DOM box above the launcher. With appearance
// "interaction-only" most visitors never see it; a suspicious one gets a checkbox.
// https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const BOX_ID = "talkie-verify";

let loading = null;

/** Load Cloudflare's script once; resolves to `window.turnstile`. */
function loadTurnstile(doc) {
  const win = doc.defaultView;
  if (win.turnstile) return Promise.resolve(win.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (win.turnstile ? resolve(win.turnstile) : reject(new Error("Turnstile did not load")));
    script.onerror = () => { loading = null; reject(new Error("Could not load the bot check")); };
    doc.head.append(script);
  });
  return loading;
}

/**
 * A `verify` hook for <talkie-assistant>.
 * @param {Document} [doc]
 * @param {{ load?: (doc: Document) => Promise<any> }} [options] - `load` replaces the script
 *   loader (tests).
 * @returns {(challenge: { provider: string, siteKey: string | null }) => Promise<string>}
 */
export function createTurnstileVerify(doc = document, { load = loadTurnstile } = {}) {
  return async ({ provider, siteKey }) => {
    if (provider !== "turnstile" || !siteKey) {
      throw new Error(`Unsupported bot check: ${provider ?? "none"}`);
    }
    const turnstile = await load(doc);
    doc.getElementById(BOX_ID)?.remove();
    const box = doc.createElement("div");
    box.id = BOX_ID;
    box.className = "talkie-verify";
    doc.body.append(box);
    let widgetId = null;
    try {
      return await new Promise((resolve, reject) => {
        widgetId = turnstile.render(`#${BOX_ID}`, {
          sitekey: siteKey,
          appearance: "interaction-only",
          callback: resolve,
          "error-callback": (code) => reject(new Error(`Bot check failed (${code})`)),
          "expired-callback": () => reject(new Error("Bot check expired")),
        });
      });
    } finally {
      if (widgetId != null) turnstile.remove(widgetId);
      box.remove();
    }
  };
}

/** Give the page's <talkie-assistant> the hook. Safe before the embed bundle has loaded. */
export function wireTalkieVerify(doc = document) {
  const el = doc.querySelector("talkie-assistant");
  if (el) el.verify = createTurnstileVerify(doc);
}
