/**
 * Pure utilities for generating embed snippets and building a `<talkie-assistant>` element.
 *
 * No DOM. Intended for use on the site's console page to generate copyable HTML.
 */

/* ------------------------------------------------------------------- defaults */

export const DEFAULTS = {
  api: 'http://localhost:8000',
  'token-url': '',
  profile: '',
  'system-prompt': '',
  voice: '',
  heading: '',
  subtitle: '',
  label: '',
  mode: 'conversation',
  'idle-timeout': '60',
  'barge-in': 'on',
  layout: 'auto',
  fonts: 'off',
};

/* ---------------------------------------------------------------- helpers */

// Escape &, ", <, > — order of & first matters.
function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build two lines of embed markup: one `<script>` tag and one `<talkie-assistant>` tag.
 *
 * @param {object} opts
 * @param {string} [opts.scriptSrc='/path/to/talkie-embed.js']
 * @param {Record<string,string>} [opts.attrs] — extra attributes to pass through.
 *   `api` is always emitted. Any other attribute is emitted only when it is a non-empty
 *   string different from `DEFAULTS`.
 * @param {Record<string,string>} [opts.theme] — keys must start with `--talkie-` and have
 *   non-empty values; rendered as the last attribute (`style="…"`).
 * @returns {string} exactly two lines joined by `\n`
 */
export function buildSnippet({ scriptSrc = '/path/to/talkie-embed.js', attrs = {}, theme = {} } = {}) {
  // Collect talkie-assistant attributes.
  const parts = [];

  // Always emit api.
  parts.push(`api="${esc(attrs.api || DEFAULTS.api)}"`);

  // Emit any other DEFAULTS key whose value differs (and is non-empty).
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'api') continue;
    const def = DEFAULTS[key];
    const val = attrs[key];
    if (val == null || val === '' || val === def) continue;

    // Special rules.
    if (key === 'barge-in' && val !== 'off') continue;  // barge-in only when "off".
    if (key === 'fonts' && val !== 'google') continue;   // fonts only when "google".

    parts.push(`${key}="${esc(val)}"`);
  }

  // Theme → style attribute (last).
  const themeAttrs = Object.entries(theme)
    .filter(([k, v]) => k.startsWith('--talkie-') && v != null && v !== '')
    .map(([k, v]) => `${k}: ${esc(v)}`)
    .join('; ');
  if (themeAttrs) {
    parts.push(`style="${themeAttrs}"`);
  }

  const attrStr = parts.length ? ' ' + parts.join(' ') : '';

  return `<script src="${esc(scriptSrc)}" defer></script>\n<talkie-assistant${attrStr}></talkie-assistant>`;
}
