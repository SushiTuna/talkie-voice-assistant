// Funnel-page logic: listing copy binding, gallery, floor-plan → tour hooks,
// scroll reveals, mobile sticky CTA, and the booking form (client side of Phase 4).
// The 3D tour itself lives in main.js (window.tour public API) — this file only calls it.
import { listing } from "./listing.js";
import { ROOM_ANCHORS } from "./anchors.js";
import { wireNeighborhood } from "./neighborhood.js";
import "./components/index.js";
import { Required, MaxLength, IsEmail, Pattern } from "@lion/ui/form-core.js";

const byId = (id) => document.getElementById(id);

// Safety net: ensure each tour-radio's choiceValue matches its choice-value attribute
// before the groups compute their initial modelValue.
for (const el of document.querySelectorAll("tour-radio[choice-value]")) {
  el.choiceValue = el.getAttribute("choice-value");
}

/* ------------------------------------------------------------------ copy binding */

function bindCopy() {
  const get = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), listing);
  for (const el of document.querySelectorAll("[data-bind]")) {
    const v = get(el.dataset.bind);
    if (v != null) el.textContent = String(v);
  }
  const email = byId("agentEmail");
  email.textContent = listing.agent.email;
  email.href = `mailto:${listing.agent.email}?subject=Tour%20request%20—%20${encodeURIComponent(listing.name)}`;
  const email2 = byId("agentEmail2");
  email2.textContent = email.textContent;
  email2.href = email.href;
  // Phone is a placeholder — render as text, not a tel: link.
  const ul = byId("highlights");
  for (const h of listing.highlights) {
    const li = document.createElement("li");
    li.className = "highlight reveal";
    li.innerHTML = `<p class="eyebrow"></p><p class="highlight-value"></p>`;
    li.children[0].textContent = h.label;
    li.children[1].textContent = h.value;
    ul.append(li);
  }
}

/* ------------------------------------------------------------------ gallery */

function buildGallery() {
  const wrap = byId("gallery");
  for (const id of listing.galleryIds) {
    const a = ROOM_ANCHORS.find((x) => x.id === id);
    if (!a) continue;
    const fig = document.createElement("figure");
    fig.className = "card reveal";
    fig.innerHTML = `
      <button class="card-media" type="button" data-anchor="${a.id}" aria-label="View ${a.label} in the 3D tour">
        <picture>
          <source type="image/webp" srcset="/assets/gallery-${a.id}.webp" />
          <img src="/assets/gallery-${a.id}.jpg" width="1200" height="675" loading="lazy"
               alt="${a.label} — ${a.caption}" />
        </picture>
      </button>
      <figcaption class="card-body">
        <div>
          <h3>${a.label}</h3>
          <p>${a.caption}</p>
        </div>
        <button class="btn btn-secondary card-3d" type="button" data-anchor="${a.id}">View in 3D</button>
      </figcaption>`;
    wrap.append(fig);
  }
  wrap.addEventListener("click", (e) => {
    const b = e.target.closest("[data-anchor]");
    if (b) goToRoom(b.dataset.anchor);
  });
}

/* ------------------------------------------------------------------ tour hooks */

function goToRoom(id) {
  // main.js's goTo() lazy-loads Babylon, scrolls the tour into view and animates the camera.
  if (window.tour?.goTo) window.tour.goTo(id);
}

function wireFloorPlan() {
  for (const g of document.querySelectorAll(".plan-room")) {
    const go = () => {
      document.querySelectorAll(".plan-room.active").forEach((x) => x.classList.remove("active"));
      g.classList.add("active");
      goToRoom(g.dataset.anchor);
    };
    g.addEventListener("click", go);
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  }
  // Keep the schematic in sync when the user walks or uses the room dock.
  new MutationObserver(() => {
    const on = document.querySelector('#anchorBar .pill[aria-pressed="true"]')?.dataset.anchor;
    if (!on) return;
    document.querySelectorAll(".plan-room").forEach((x) => x.classList.toggle("active", x.dataset.anchor === on));
  }).observe(byId("anchorBar"), { subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
}

/* ------------------------------------------------------------------ scroll animations */

// html.fx is set by an inline script in index.html unless prefers-reduced-motion is on; the
// styles for everything below are gated on it (styles.css "scroll animations").
const fx = document.documentElement.classList.contains("fx");

function wireReveal() {
  const els = document.querySelectorAll(".reveal, [data-stagger], .tour-frame");
  for (const box of document.querySelectorAll("[data-stagger]")) {
    [...box.children].forEach((c, i) => c.style.setProperty("--i", i));
  }
  // Floor-plan pieces sweep in from left to right: index by horizontal position.
  for (const el of document.querySelectorAll(".plan-room, .plan-static, .plan-deck, .plan > text")) {
    el.style.setProperty("--i", Math.round(el.getBBox().x / 70));
  }
  if (!fx || !("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("in"));
    return;
  }
  const frame = document.querySelector(".tour-frame");
  const settle = () => frame.classList.add("settled");
  frame.addEventListener("transitionend", (e) => { if (e.target === frame && e.propertyName === "transform") settle(); });

  const io = new IntersectionObserver((entries) => {
    // Elements that enter together (gallery rows, highlight tiles) are staggered in reading order.
    const shown = entries.filter((en) => en.isIntersecting).map((en) => en.target);
    const pos = new Map(shown.map((el) => [el, el.getBoundingClientRect()]));
    shown.sort((x, y) => pos.get(x).top - pos.get(y).top || pos.get(x).left - pos.get(y).left);
    shown.forEach((el, n) => {
      el.style.setProperty("--d", `${n * 110}ms`);
      el.classList.add("in");
      io.unobserve(el);
      if (el === frame) setTimeout(settle, 1600); // in case transitionend never fires
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  els.forEach((el) => io.observe(el));
}

function wireScrollFx() {
  const root = document.documentElement;
  const header = document.querySelector(".site-header");
  const hero = document.querySelector(".hero");
  const pics = [...document.querySelectorAll(".card-media picture")];

  // Current section → nav link (a thin band across the middle of the viewport).
  const links = new Map([...document.querySelectorAll(".main-nav a")].map((a) => [a.hash.slice(1), a]));
  const navIO = new IntersectionObserver((entries) => {
    entries.sort((x, y) => x.isIntersecting - y.isIntersecting); // leaving before entering
    for (const en of entries) {
      const a = links.get(en.target.id);
      if (en.isIntersecting) {
        links.forEach((l) => l.removeAttribute("aria-current"));
        a.setAttribute("aria-current", "true");
      } else a.removeAttribute("aria-current");
    }
  }, { rootMargin: "-45% 0px -54% 0px" });
  links.forEach((_, id) => { const sec = byId(id); if (sec) navIO.observe(sec); });

  let queued = false;
  const update = () => {
    queued = false;
    const y = window.scrollY, vh = window.innerHeight;
    const max = root.scrollHeight - vh;
    header.style.setProperty("--progress", max > 0 ? Math.min(1, y / max).toFixed(4) : "0");
    header.classList.toggle("scrolled", y > 8);
    if (!fx) return;
    hero.style.setProperty("--hp", Math.min(1, y / hero.offsetHeight).toFixed(4));
    // Gallery parallax: read every rect first, then write, so the loop doesn't force layouts.
    const offs = pics.map((p) => {
      const r = p.parentElement.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) return null;
      const t = Math.max(-0.5, Math.min(0.5, (r.top + r.height / 2) / vh - 0.5));
      return `${(t * -0.06 * r.height).toFixed(1)}px`; // within the img's 1.08 scale headroom
    });
    offs.forEach((o, i) => { if (o) pics[i].style.setProperty("--py", o); });
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue);
  update();
}

/* ------------------------------------------------------------------ mobile sticky CTA */

function wireMobileCta() {
  const bar = byId("mobileCta");
  const io = new IntersectionObserver(
    ([en]) => bar.classList.toggle("hidden", en.isIntersecting),
    { threshold: 0.15 }
  );
  io.observe(byId("contact"));
}

/* ------------------------------------------------------------------ light / dark theme */
// index.html's <head> already set html[data-theme] before first paint; this keeps it in sync.
// An explicit choice is saved; until then the page follows the system setting live.

function wireTheme() {
  const sw = byId("themeToggle"); // <tour-switch> (components/tour-switch.js); checked = dark
  const root = document.documentElement;
  const meta = document.querySelector('meta[name="theme-color"]');
  const system = matchMedia("(prefers-color-scheme: light)");
  const saved = () => { try { return localStorage.getItem("theme"); } catch { return null; } };
  const apply = (theme) => {
    root.dataset.theme = theme;
    if (meta) meta.content = theme === "light" ? "#f5f2ec" : "#0f1011";
  };
  const boot = root.dataset.theme === "light" ? "light" : "dark";
  apply(boot);
  sw.checked = boot === "dark";
  // Lion's role=switch button fires "checked-changed" (bubbles to the tour-switch host).
  let syncing = false; // programmatic syncs (system-preference changes) must not count as a choice
  sw.addEventListener("checked-changed", () => {
    const next = sw.checked ? "dark" : "light";
    apply(next);
    if (syncing) return;
    try { localStorage.setItem("theme", next); } catch { /* private mode: still switches, just not remembered */ }
  });
  system.addEventListener("change", (e) => {
    if (saved()) return;
    const next = e.matches ? "light" : "dark";
    apply(next);
    syncing = true;
    sw.checked = next === "dark";
    syncing = false;
  });
}

/* ------------------------------------------------------------------ booking form */
// Stepped form (index.html #contact): tour type → day → time window → details. Every choice is a
// native radio in a <label> card; this file adds the two-week day strip, the running summary next
// to the submit button, the error summary and the confirmation. server.mjs re-validates it all.

const TIME_WINDOWS = {
  morning: { label: "Morning", hours: "9 am – 12 pm", start: 9, end: 12 },
  afternoon: { label: "Afternoon", hours: "12 – 4 pm", start: 12, end: 16 },
  evening: { label: "Evening", hours: "4 – 7 pm", start: 16, end: 19 },
};
const TOUR_TYPES = { "in-person": "In person", video: "Video call" };
const DAYS_SHOWN = 13; // + the "later date" chip = two rows of seven

// Details-field rules, shared by validate() (error summary + #err-* spans) and the Lion
// validators on the tour-input fields (see wireForm).
const PHONE_RE = /^[\d+()\- ]{7,20}$/;
const MSG = {
  name: "Enter your full name.",
  email: "Enter an email address like name@example.com.",
  phone: "Enter a phone number: 7–20 digits, spaces or + ( ) -.",
  message: "Keep your message to 1000 characters or fewer.",
};

const pad = (n) => String(n).padStart(2, "0");
const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtDate = (iso, opts) => parseIso(iso).toLocaleDateString(undefined, opts);
const LONG_DATE = { weekday: "long", day: "numeric", month: "long", year: "numeric" };

function tomorrowLocal() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return isoLocal(d);
}

function buildDateChips() {
  const wrap = byId("dateChips");
  const now = new Date();
  const chip = (value, cls, inner, spoken) => {
    const radio = document.createElement("tour-radio");
    radio.className = `date-chip ${cls}`;
    radio.choiceValue = value;
    const label = document.createElement("label");
    label.slot = "label";
    label.innerHTML = `${inner}<span class="sr-only"></span>`;
    label.lastChild.textContent = spoken;
    radio.append(label);
    wrap.append(radio);
  };
  for (let i = 1; i <= DAYS_SHOWN; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const part = (o) => day.toLocaleDateString(undefined, o);
    chip(isoLocal(day), day.getDay() % 6 === 0 ? "is-weekend" : "",
      `<span class="dc-dow" aria-hidden="true">${part({ weekday: "short" })}</span>
       <span class="dc-day" aria-hidden="true">${day.getDate()}</span>
       <span class="dc-mon" aria-hidden="true">${part({ month: "short" })}</span>`,
      `${i === 1 ? "Tomorrow, " : ""}${part({ weekday: "long", day: "numeric", month: "long" })}`);
  }
  chip("other", "is-other",
    `<span class="dc-dow" aria-hidden="true">Later</span>
     <svg class="dc-other-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="1.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>
     <span class="dc-mon" aria-hidden="true">date</span>`,
    "A later date — choose it on a calendar");
}

function icsFile(data) {
  const tw = TIME_WINDOWS[data.timeWindow];
  const day = data.date.replaceAll("-", "");
  const esc = (s) => String(s).replace(/[\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Virtual tour//Tour request//EN", "BEGIN:VEVENT",
    `UID:${Date.now()}-${Math.random().toString(36).slice(2)}@tour-request`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${day}T${pad(tw.start)}0000`,
    `DTEND:${day}T${pad(tw.end)}0000`,
    `SUMMARY:${esc(`Tour request: ${listing.name} (awaiting confirmation)`)}`,
    `DESCRIPTION:${esc(`${TOUR_TYPES[data.tourType]} tour, ${tw.label.toLowerCase()} window. The agent will confirm an exact time by email.`)}`,
    `LOCATION:${esc(data.tourType === "video" ? "Video call" : listing.address)}`,
    "STATUS:TENTATIVE", "END:VEVENT", "END:VCALENDAR",
  ];
  return URL.createObjectURL(new Blob([lines.join("\r\n") + "\r\n"], { type: "text/calendar" }));
}

function validate(data) {
  const errors = {};
  if (!["in-person", "video"].includes(data.tourType)) errors.tourType = "Choose how you’d like to tour.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || "")) errors.date = "Pick a day for your visit.";
  else if (data.date < tomorrowLocal()) errors.date = "Choose tomorrow or a later day.";
  if (!TIME_WINDOWS[data.timeWindow]) errors.timeWindow = "Pick a time window.";
  if (!data.name || data.name.length > 120) errors.name = MSG.name;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email || "")) errors.email = MSG.email;
  if (!PHONE_RE.test(data.phone || "")) errors.phone = MSG.phone;
  if (data.message && data.message.length > 1000) errors.message = MSG.message;
  return errors;
}

function wireForm() {
  const form = byId("tourForm");
  const btn = byId("submitBtn");
  const status = byId("formStatus");
  const summary = byId("errorSummary");
  const summaryList = byId("errorSummaryList");
  const other = byId("f-date");
  const otherWrap = byId("dateOtherWrap");
  const message = byId("f-message");
  const count = byId("msg-count");

  buildDateChips();
  other.min = tomorrowLocal();

  const otherChosen = () => radioGroup("date")?.modelValue === "other";

  // tourType / timeWindow are Lion radio groups; read their modelValue instead of native radios.
  const radioGroup = (name) => form.querySelector(`tour-radio-group[name="${name}"]`);
  const groupValue = (name) => radioGroup(name)?.modelValue || "";
  radioGroup("timeWindow").validators = [
    new Required(null, { getMessage: () => "Pick a time window." }),
  ];
  radioGroup("date").validators = [
    new Required(null, { getMessage: () => "Pick a day for your visit." }),
  ];

  // The details fields are Lion fields too, with validators mirroring validate() exactly.
  // Display stays on the page side: their #err-* spans occupy slot="feedback" and
  // components/tour-input.js suppresses Lion's own message rendering (feedbackCondition),
  // so only one message per field is ever visible and aria-invalid stays page-controlled.
  const lionField = (name) => form.querySelector(`tour-input[name="${name}"], tour-input-email[name="${name}"], tour-textarea[name="${name}"]`);
  for (const [name, validators] of [
    ["name", [new Required(null, { getMessage: () => MSG.name }), new MaxLength(120, { getMessage: () => MSG.name })]],
    ["email", [new Required(null, { getMessage: () => MSG.email }), new IsEmail(null, { getMessage: () => MSG.email })]],
    ["phone", [new Required(null, { getMessage: () => MSG.phone }), new Pattern(PHONE_RE, { getMessage: () => MSG.phone })]],
    ["message", [new MaxLength(1000, { getMessage: () => MSG.message })]],
  ]) {
    const field = lionField(name);
    if (field) field.validators = validators;
  }

  // Focus target inside a radio group: the checked radio's native input, else the first one.
  const groupInput = (name) => {
    const g = radioGroup(name);
    return g?.querySelector("tour-radio[checked] input") || g?.querySelector("input");
  };

  // Field → its error element and where to send focus (DOM order = error summary order).
  const FIELDS = {
    tourType: { error: "err-type", target: () => groupInput("tourType") },
    date: { error: "err-date", target: () => (otherChosen() ? other : groupInput("date")) },
    timeWindow: { error: "err-time", target: () => groupInput("timeWindow") },
    name: { error: "err-name", input: "f-name" },
    email: { error: "err-email", input: "f-email" },
    phone: { error: "err-phone", input: "f-phone" },
    message: { error: "err-message", input: "f-message" },
  };
  const targetOf = (f) => (FIELDS[f].input ? byId(FIELDS[f].input) : FIELDS[f].target());

  const readForm = () => {
    const d = Object.fromEntries(new FormData(form).entries());
    d.tourType = groupValue("tourType");
    d.timeWindow = groupValue("timeWindow");
    d.date = groupValue("date");
    d.date = d.date === "other" ? d.dateOther || "" : d.date || "";
    delete d.dateOther;
    return d;
  };

  const setFieldError = (field, msg) => {
    const { error, input } = FIELDS[field];
    const el = byId(error);
    el.textContent = msg || "";
    if (input) byId(input).setAttribute("aria-invalid", msg ? "true" : "false");
    else el.closest("fieldset").toggleAttribute("data-invalid", !!msg);
    if (field === "date") other.setAttribute("aria-invalid", msg && otherChosen() ? "true" : "false");
    // Fixing a field also takes it off the summary list.
    if (!msg) {
      summaryList.querySelector(`[data-field="${field}"]`)?.remove();
      if (!summaryList.children.length) summary.hidden = true;
    }
  };

  function showErrors(errors) {
    for (const f of Object.keys(FIELDS)) setFieldError(f, errors[f]);
    summaryList.replaceChildren();
    for (const f of [...Object.keys(FIELDS), "form"]) {
      if (!errors[f]) continue;
      const li = document.createElement("li");
      li.dataset.field = f;
      if (f === "form") li.textContent = errors.form;
      else {
        const a = document.createElement("a");
        const t = targetOf(f);
        a.href = `#${t.id || "contact"}`;
        a.textContent = errors[f];
        a.addEventListener("click", (e) => {
          e.preventDefault();
          const el = targetOf(f);
          el.focus({ preventScroll: true });
          el.scrollIntoView({ block: "center", behavior: fx ? "smooth" : "auto" });
        });
        li.append(a);
      }
      summaryList.append(li);
    }
    summary.hidden = !summaryList.children.length;
    if (!summary.hidden) {
      summary.focus({ preventScroll: true });
      summary.scrollIntoView({ block: "center", behavior: fx ? "smooth" : "auto" });
    }
  }

  // Running summary beside the submit button (also the button's description for screen readers).
  const summaryText = byId("bookSummaryText");
  const updateSummary = () => {
    const d = readForm();
    const tw = TIME_WINDOWS[d.timeWindow];
    const okDate = /^\d{4}-\d{2}-\d{2}$/.test(d.date);
    const parts = [
      [TOUR_TYPES[d.tourType], "choose a tour type"],
      [okDate && fmtDate(d.date, { weekday: "short", day: "numeric", month: "short" }), "pick a day"],
      [tw && `${tw.label}, ${tw.hours}`, "pick a time"],
    ];
    summaryText.replaceChildren();
    parts.forEach(([val, todo], i) => {
      if (i) summaryText.append(" · ");
      if (val) summaryText.append(val);
      else {
        const s = document.createElement("span");
        s.className = "pending";
        s.textContent = todo;
        summaryText.append(s);
      }
    });
  };

  const updateCount = () => { count.textContent = `${message.value.length} / 1000 characters`; };

  form.addEventListener("change", (e) => {
    const field = { tourType: "tourType", date: "date", dateOther: "date", timeWindow: "timeWindow" }[e.target.name];
    if (field) setFieldError(field, "");
    updateSummary();
  });
  // Lion groups announce selection changes via model-value-changed (the native change event
  // comes from an input inside the group and may not carry the group's name).
  for (const name of ["tourType", "date", "timeWindow"]) {
    radioGroup(name)?.addEventListener("model-value-changed", () => {
      if (name === "date") {
        otherWrap.hidden = !otherChosen();
        if (!otherChosen()) other.setAttribute("aria-invalid", "false");
      }
      setFieldError(name, "");
      updateSummary();
    });
  }
  // Clear a field's error as soon as the user edits it.
  form.addEventListener("input", (e) => {
    const field = Object.keys(FIELDS).find((f) => FIELDS[f].input === e.target.id);
    if (field && e.target.getAttribute("aria-invalid") === "true") setFieldError(field, "");
    if (e.target === other) updateSummary();
    if (e.target === message) updateCount();
  });
  updateSummary();
  // The Lion groups settle their modelValue during their first (async) update; refresh once.
  queueMicrotask(updateSummary);

  const setBusy = (busy) => {
    btn.disabled = busy;
    if (busy) btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");
    btn.textContent = busy ? "Sending…" : "Request a tour";
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = readForm();
    const errors = validate(data);
    if (Object.keys(errors).length) {
      showErrors(errors);
      const n = Object.keys(errors).length;
      status.textContent = `${n} ${n === 1 ? "answer needs" : "answers need"} another look.`;
      return;
    }
    showErrors({});
    setBusy(true);
    status.textContent = "Sending your request…";
    try {
      const res = await fetch("/api/tour-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name.trim(),
          email: data.email.trim(),
          phone: data.phone.trim(),
          date: data.date,
          timeWindow: data.timeWindow,
          tourType: data.tourType,
          message: (data.message || "").trim(),
          company: data.company || "",
        }),
      });
      const json = await res.json().catch(() => null);
      // 201 = stored; 200 = honeypot, silently accepted
      if ((res.status === 201 || res.status === 200) && json?.ok) {
        confirmation(data);
        return;
      }
      if (res.status === 400 && json?.errors) {
        showErrors(json.errors);
        status.textContent = "Some details need another look.";
      } else {
        showErrors({ form: "Something went wrong sending your request. Your details are still here — please try again." });
        status.textContent = "";
      }
    } catch {
      showErrors({ form: "Network error — your details are still here. Please check your connection and try again." });
      status.textContent = "";
    }
    setBusy(false);
  });
}

function confirmation(data) {
  const tw = TIME_WINDOWS[data.timeWindow];
  const card = document.createElement("div");
  card.className = "confirm-card";
  card.innerHTML = `
    <div class="confirm-badge" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></div>
    <p class="eyebrow">Request received</p>
    <h3 tabindex="-1">Thank you, <span data-f="name"></span>.</h3>
    <p>The agent will confirm an exact time by email at <b data-f="email"></b>.</p>
    <dl class="confirm-details">
      <dt>Tour</dt><dd data-f="type"></dd>
      <dt>Day</dt><dd data-f="day"></dd>
      <dt>Time</dt><dd data-f="time"></dd>
    </dl>
    <div class="confirm-actions">
      <a class="btn btn-primary" data-f="ics" download="tour-request.ics">Add to calendar (.ics)</a>
      <a class="btn btn-secondary" href="#tour-section">Explore the 3D tour</a>
    </div>
    <p class="reassurance"></p>`;
  const f = (k) => card.querySelector(`[data-f="${k}"]`);
  f("name").textContent = data.name.trim();
  f("email").textContent = data.email.trim();
  f("type").textContent = TOUR_TYPES[data.tourType];
  f("day").textContent = fmtDate(data.date, LONG_DATE);
  f("time").textContent = `${tw.label}, ${tw.hours} (exact time to be confirmed)`;
  f("ics").href = icsFile(data);
  card.querySelector(".reassurance").textContent = listing.reassurance;
  const form = byId("tourForm");
  form.hidden = true;
  form.after(card);
  byId("formStatus").textContent = "Your tour request was sent.";
  const h = card.querySelector("h3");
  h.focus({ preventScroll: true });
  card.scrollIntoView({ block: "center", behavior: fx ? "smooth" : "auto" });
}

/* ------------------------------------------------------------------ boot */

bindCopy();
buildGallery();
wireFloorPlan();
wireReveal();
wireScrollFx();
wireMobileCta();
wireForm();
wireTheme();
wireNeighborhood();
