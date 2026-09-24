/**
 * Shared site shell: a sticky header with navigation, a live-toggle switch,
 * and a voice-server URL input — all persisted to `localStorage` (best-effort).
 */

/* ------------------------------------------------------------------- storage */

const STORAGE_KEY = 'talkie-site:backend';

function readBackendSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* noop — fall through to defaults */ }
  return { backend: 'mock', api: 'http://localhost:8000' };
}

function writeBackendSettings({ backend, api }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ backend, api }));
  } catch { /* best effort; silent fail */ }
}

/** Read the last saved settings from storage. */
export function getBackendSettings() {
  return readBackendSettings();
}

let lastSettings = null;
/** Save settings back to storage and dispatch a change event. */
function setBackendSettings(settings) {
  const key = `${settings.backend}:${settings.api}`;
  if (lastSettings === key) return;
  lastSettings = key;
  writeBackendSettings(settings);
  window.dispatchEvent(
    new CustomEvent('talkie-site-backend', { detail: { ...settings } }),
  );
}

/* ------------------------------------------------------------------- DOM helpers */

// Create a Lion element by tag name and apply attribute + property assignments.
function createLion(tag, attrs, props) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const [k, v] of Object.entries(props || {})) {
    // Some Lion properties shadow native ones.
    if (k === 'checked') el.checked = v;
    else if (k === 'modelValue') el.modelValue = v;
    else el[k] = v;
  }
  return el;
}

/* ------------------------------------------------------------------- mount */

/**
 * Render the site header with nav links and controls.
 *
 * @param {string} currentActive — page slug ('index'|'playground'|'console'|'docs')
 */
export function mountShell(currentActive) {
  let header = document.getElementById('site-header');
  if (!header) {
    header = document.createElement('header');
    header.id = 'site-header';
  }
  header.innerHTML = '';
  header.classList.add('site-header');

  // Skip link: the header's controls sit before every page's main content.
  if (!document.querySelector('.skip-link') && document.getElementById('main')) {
    const skip = document.createElement('a');
    skip.href = '#main';
    skip.className = 'skip-link';
    skip.textContent = 'Skip to content';
    document.body.prepend(skip);
  }

  // Brand
  const brand = document.createElement('a');
  brand.href = '/site/';
  brand.textContent = 'Talkie';
  brand.classList.add('site-brand');
  header.appendChild(brand);

  // Nav
  const nav = document.createElement('nav');
  nav.classList.add('site-nav');
  nav.setAttribute('aria-label', 'Site');

  const pages = [
    { label: 'Overview', href: '/site/', active: currentActive === 'index' },
    { label: 'Playground', href: '/site/playground', active: currentActive === 'playground' },
    { label: 'Persona console', href: '/site/console', active: currentActive === 'console' },
    { label: 'Docs', href: '/site/docs', active: currentActive === 'docs' },
  ];

  for (const pg of pages) {
    const a = document.createElement('a');
    a.href = pg.href;
    a.textContent = pg.label;
    if (pg.active) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }
  header.appendChild(nav);
  // On phones the nav scrolls sideways; start it with the current page in view.
  requestAnimationFrame(() => {
    const current = nav.querySelector('[aria-current]');
    if (current && nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft = current.offsetLeft - nav.offsetLeft - 8;
    }
  });

  // Settings row
  const settings = readBackendSettings();
  const controls = document.createElement('div');
  controls.classList.add('site-controls');

  // Live toggle
  const liveSwitch = createLion('lion-switch', { label: 'Live voice server' }, { checked: settings.backend === 'live' });
  liveSwitch.addEventListener('model-value-changed', () => {
    const isLive = liveSwitch.checked;
    setBackendSettings({ backend: isLive ? 'live' : 'mock', api: apiInput.modelValue || settings.api });
    apiInput.hidden = !isLive;
    if (isLive) requestAnimationFrame(() => apiInput.focus());
  });
  controls.appendChild(liveSwitch);

  // API input
  const apiInput = createLion('lion-input', { label: 'Voice server URL' }, { modelValue: settings.api, id: 'api-input' });
  apiInput.hidden = settings.backend !== 'live';
  apiInput.placeholder = 'http://localhost:8000';
  // Every keystroke fires this, and each change rebuilds the page's preview: wait for a pause.
  let typingTimer = 0;
  apiInput.addEventListener('model-value-changed', () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      setBackendSettings({ backend: liveSwitch.checked ? 'live' : 'mock', api: apiInput.modelValue });
    }, 500);
  });
  controls.appendChild(apiInput);

  header.appendChild(controls);
  if (!header.isConnected) document.body.prepend(header);
}
