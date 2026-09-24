/**
 * Docs page — README, integration guide and production checklist, one lion-tabs panel each.
 *
 * The markdown is fetched from the dev server, never copied, so the page can't drift from the
 * docs. Each panel renders once, on first show.
 */

import '../lion.js';
import { mountShell } from '../shell.js';
import { marked } from 'marked';

mountShell('docs');

const DOCS = [
  { id: 'guide', file: '../README.md' },
  { id: 'integration', file: '../docs/integration.md' },
  { id: 'checklist', file: '../docs/production-checklist.md' },
];

/** Markdown file name → tab index, whatever path prefix a link uses. */
const TAB_BY_FILE = new Map([
  ['README.md', 0],
  ['integration.md', 1],
  ['production-checklist.md', 2],
]);

const tabs = /** @type {any} */ (document.getElementById('tabs-bar'));
const loaded = new Set();
/** The doc being rendered, so in-page links can carry its tab id. */
let rendering = -1;
const currentIndex = () => (rendering === -1 ? tabs.selectedIndex : rendering);

function slugger() {
  const used = new Map();
  return (text) => {
    const base = text.toLowerCase().trim().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'section';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

function scrollToId(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Select a tab and, once its panel has rendered, scroll to an anchor inside it. */
async function show(index, anchor) {
  if (tabs.selectedIndex !== index) tabs.selectedIndex = index;
  await render(index);
  if (anchor) {
    scrollToId(anchor);
    setHash(index, anchor);
  }
}

/** `#integration` or `#guide/some-heading` → [tab index, anchor]; unknown → [-1]. */
function parseHash(hash) {
  const [id, anchor] = decodeURIComponent(hash.replace(/^#/, '')).split('/');
  return [DOCS.findIndex((d) => d.id === id), anchor];
}

/** Keep the address bar pointing at the current tab (and section) so it can be shared. */
function setHash(index, anchor) {
  const doc = DOCS[index];
  if (doc) history.replaceState(null, '', `#${doc.id}${anchor ? `/${anchor}` : ''}`);
}

function wireLinks(root, fileUrl) {
  for (const link of root.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (/^https?:\/\//i.test(href)) {
      link.target = '_blank';
      link.rel = 'noopener';
      continue;
    }
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      link.href = `#${DOCS[currentIndex()]?.id}/${id}`;
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        scrollToId(id);
        setHash(tabs.selectedIndex, id);
      });
      continue;
    }
    const [path, anchor] = href.split('#');
    const tabIndex = TAB_BY_FILE.get(path.split('/').pop());
    if (tabIndex !== undefined) {
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        show(tabIndex, anchor && decodeURIComponent(anchor));
      });
      continue;
    }
    // Anything else (source files, images) resolves against the markdown file's own URL.
    link.href = new URL(href, fileUrl).href;
  }
}

function addCopyButtons(root) {
  for (const pre of root.querySelectorAll('pre')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Copy failed';
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
    pre.append(btn);
  }
}

/** An "On this page" list of the doc's h2s (h3s indented), highlighting the section in view. */
function buildToc(root, docId) {
  const heads = [...root.querySelectorAll('h2, h3')];
  if (heads.filter((h) => h.tagName === 'H2').length < 2) return null;
  const nav = document.createElement('nav');
  nav.className = 'docs-toc';
  nav.setAttribute('aria-label', 'On this page');
  const title = document.createElement('p');
  title.className = 'docs-toc-title';
  title.textContent = 'On this page';
  const list = document.createElement('ul');
  const linkFor = new Map();
  for (const h of heads) {
    const a = document.createElement('a');
    a.href = `#${docId}/${h.id}`;
    a.textContent = h.textContent;
    a.dataset.level = h.tagName.slice(1);
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      scrollToId(h.id);
      setHash(tabs.selectedIndex, h.id);
    });
    const li = document.createElement('li');
    li.append(a);
    list.append(li);
    linkFor.set(h, a);
  }
  nav.append(title, list);

  // The current section is the last heading above the top ~third of the viewport.
  const visible = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target);
      else visible.delete(e.target);
    }
    const first = heads.find((h) => visible.has(h));
    if (!first) return;
    for (const a of linkFor.values()) a.removeAttribute('aria-current');
    const active = linkFor.get(first);
    active.setAttribute('aria-current', 'location');
    active.scrollIntoView({ block: 'nearest' });
  }, { rootMargin: '-64px 0px -60% 0px' });
  for (const h of heads) observer.observe(h);
  return nav;
}

async function render(index) {
  const doc = DOCS[index];
  if (!doc || loaded.has(doc.id)) return;
  loaded.add(doc.id);
  // lion-tabs replaces panel ids with its own (for aria-controls), so find panels by data-doc.
  const panel = tabs.querySelector(`[data-doc="${doc.id}"]`);
  const fileUrl = new URL(doc.file, location.href);
  const loading = document.createElement('p');
  loading.className = 'loading-msg';
  loading.textContent = 'Loading…';
  panel.replaceChildren(loading);
  try {
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(String(res.status));
    const body = document.createElement('div');
    // Our own repo docs, not user input.
    body.innerHTML = marked.parse(await res.text());
    const slug = slugger();
    for (const h of body.querySelectorAll('h1, h2, h3')) h.id = slug(h.textContent);
    for (const table of body.querySelectorAll('table')) {
      const wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      table.replaceWith(wrap);
      wrap.append(table);
    }
    rendering = index;
    wireLinks(body, fileUrl);
    rendering = -1;
    addCopyButtons(body);
    const article = document.createElement('article');
    article.className = 'docs-article';
    article.append(...body.childNodes);
    panel.replaceChildren(article);
    const toc = buildToc(article, doc.id);
    if (toc) panel.prepend(toc);
    panel.classList.toggle('has-toc', !!toc);
  } catch (err) {
    loaded.delete(doc.id);
    const p = document.createElement('p');
    p.className = 'error-msg';
    p.textContent = `Couldn't load ${doc.file} (${err.message}). Run the site with npm run site.`;
    panel.replaceChildren(p);
  }
}

tabs.addEventListener('selected-changed', () => {
  if (!DOCS[tabs.selectedIndex]) return;
  const [index] = parseHash(location.hash);
  if (index !== tabs.selectedIndex) setHash(tabs.selectedIndex);
  render(tabs.selectedIndex);
});

window.addEventListener('hashchange', () => {
  const [index, anchor] = parseHash(location.hash);
  if (index !== -1) show(index, anchor);
});

// lion-tabs picks its initial selection on first update; set ours after that.
await tabs.updateComplete;
const [initial, initialAnchor] = parseHash(location.hash);
show(initial === -1 ? 0 : initial, initialAnchor);
