/**
 * Docs page — the README, rendered as the Guide.
 *
 * The markdown is fetched from the dev server, never copied, so the page can't drift from the
 * docs. Addresses keep the `#guide/<heading>` shape so links into a section stay shareable.
 */

import '../lion.js';
import { mountShell } from '../shell.js';
import { marked } from 'marked';

mountShell('docs');

const DOC = { id: 'guide', file: '../README.md' };

const panel = document.querySelector(`[data-doc="${DOC.id}"]`);

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

/** `#guide/some-heading` → the heading id; `#guide` or anything else → undefined. */
function parseHash(hash) {
  const [id, anchor] = decodeURIComponent(hash.replace(/^#/, '')).split('/');
  return id === DOC.id ? anchor : undefined;
}

/** Keep the address bar pointing at the section in view, so it can be shared. */
function setHash(anchor) {
  history.replaceState(null, '', `#${DOC.id}${anchor ? `/${anchor}` : ''}`);
}

function goTo(anchor) {
  scrollToId(anchor);
  setHash(anchor);
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
      link.href = `#${DOC.id}/${id}`;
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        goTo(id);
      });
      continue;
    }
    const [path, anchor] = href.split('#');
    if (path.split('/').pop() === 'README.md') {
      link.href = `#${DOC.id}${anchor ? `/${anchor}` : ''}`;
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (anchor) goTo(decodeURIComponent(anchor));
      });
      continue;
    }
    // Anything else (other docs, source files, images) resolves against the README's own URL.
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
function buildToc(root) {
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
    a.href = `#${DOC.id}/${h.id}`;
    a.textContent = h.textContent;
    a.dataset.level = h.tagName.slice(1);
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      goTo(h.id);
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

async function render() {
  const fileUrl = new URL(DOC.file, location.href);
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
    wireLinks(body, fileUrl);
    addCopyButtons(body);
    const article = document.createElement('article');
    article.className = 'docs-article';
    article.append(...body.childNodes);
    panel.replaceChildren(article);
    const toc = buildToc(article);
    if (toc) panel.prepend(toc);
    panel.classList.toggle('has-toc', !!toc);
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'error-msg';
    p.textContent = `Couldn't load ${DOC.file} (${err.message}). Run the site with npm run site.`;
    panel.replaceChildren(p);
  }
}

window.addEventListener('hashchange', () => {
  const anchor = parseHash(location.hash);
  if (anchor) scrollToId(anchor);
});

await render();
const initialAnchor = parseHash(location.hash);
if (initialAnchor) scrollToId(initialAnchor);
else setHash();
