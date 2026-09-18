// Funnel-page logic: listing copy binding, gallery, floor-plan → tour hooks,
// scroll reveals, mobile sticky CTA, and the booking form (client side of Phase 4).
// The 3D tour itself lives in main.js (window.tour public API) — this file only calls it.
import { listing } from "./listing.js";
import { ROOM_ANCHORS } from "./anchors.js";

const byId = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

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
  // Keep the schematic in sync when the user walks or uses the pills.
  new MutationObserver(() => {
    const on = document.querySelector('#anchorBar .pill[aria-pressed="true"]')?.dataset.anchor;
    if (!on) return;
    document.querySelectorAll(".plan-room").forEach((x) => x.classList.toggle("active", x.dataset.anchor === on));
  }).observe(byId("anchorBar"), { subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
}

/* ------------------------------------------------------------------ scroll reveal */

function wireReveal() {
  const els = document.querySelectorAll(".reveal");
  if (reduceMotion.matches || !("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
  els.forEach((el) => io.observe(el));
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

/* ------------------------------------------------------------------ booking form */

const TIME_WINDOWS = { morning: "Morning (9–12)", afternoon: "Afternoon (12–4)", evening: "Evening (4–7)" };

function tomorrowLocal() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function validate(data) {
  const errors = {};
  if (!data.name || data.name.length > 120) errors.name = "Please enter your full name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email || "")) errors.email = "Please enter a valid email address.";
  if (!/^[\d+()\- ]{7,20}$/.test(data.phone || "")) errors.phone = "Phone: 7–20 characters (digits, spaces, + ( ) -).";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || "")) errors.date = "Please pick a preferred date.";
  else if (data.date < tomorrowLocal()) errors.date = "Please choose tomorrow or later.";
  if (!TIME_WINDOWS[data.timeWindow]) errors.timeWindow = "Please choose a time window.";
  if (!["in-person", "video"].includes(data.tourType)) errors.tourType = "Please choose a tour type.";
  if (data.message && data.message.length > 1000) errors.message = "Message is limited to 1000 characters.";
  return errors;
}

const FIELD_INPUT = {
  name: "f-name", email: "f-email", phone: "f-phone", date: "f-date",
  timeWindow: "f-time", message: "f-message", tourType: null, form: null,
};
const FIELD_ERROR = {
  name: "err-name", email: "err-email", phone: "err-phone", date: "err-date",
  timeWindow: "err-time", message: "err-message", tourType: null, form: "formError",
};

function showErrors(errors) {
  for (const [field, id] of Object.entries(FIELD_INPUT)) {
    const input = id && byId(id);
    if (input) {
      input.setAttribute("aria-invalid", errors[field] ? "true" : "false");
      const err = byId(FIELD_ERROR[field]);
      if (err) err.textContent = errors[field] || "";
    }
  }
  let banner = byId("formError");
  if (errors.form) {
    if (!banner) {
      banner = document.createElement("p");
      banner.id = "formError";
      banner.className = "form-banner-error";
      byId("tourForm").prepend(banner);
    }
    banner.textContent = errors.form;
  } else if (banner) banner.remove();
  const first = Object.keys(errors).find((k) => FIELD_INPUT[k]);
  if (first && FIELD_INPUT[first]) byId(FIELD_INPUT[first]).focus();
}

function confirmation(data) {
  const card = document.createElement("div");
  card.className = "confirm-card";
  card.innerHTML = `
    <p class="eyebrow">Request received</p>
    <h3>Thank you, <span id="cf-name"></span>.</h3>
    <p>We’ve pencilled you in for <b id="cf-when"></b> and will confirm by email at <b id="cf-email"></b>.
    ${"" /* reassurance repeated below */}</p>
    <p class="reassurance" data-bind="reassurance">${listing.reassurance}</p>`;
  card.querySelector("#cf-name").textContent = data.name;
  card.querySelector("#cf-when").textContent =
    `${data.date} · ${TIME_WINDOWS[data.timeWindow]} · ${data.tourType === "video" ? "Video call" : "In-person"}`;
  card.querySelector("#cf-email").textContent = data.email;
  const form = byId("tourForm");
  form.hidden = true;
  form.after(card);
  byId("formStatus").textContent = "Your tour request was sent successfully.";
  card.querySelector("h3").tabIndex = -1;
  card.querySelector("h3").focus();
}

function wireForm() {
  const dateInput = byId("f-date");
  dateInput.min = tomorrowLocal();
  const form = byId("tourForm");
  const btn = byId("submitBtn");
  const status = byId("formStatus");

  const formData = () => Object.fromEntries(new FormData(form).entries());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = formData();
    const errors = validate(data);
    if (Object.keys(errors).length) {
      showErrors(errors);
      status.textContent = "Please correct the highlighted fields.";
      return;
    }
    showErrors({});
    btn.disabled = true;
    btn.textContent = "Sending…";
    status.textContent = "";
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
      if (res.status === 200 && json?.ok) {
        confirmation(data); // honeypot silently accepted
        return;
      }
      if (res.status === 201 && json?.ok) {
        confirmation(data);
        return;
      }
      if (res.status === 400 && json?.errors) {
        showErrors(json.errors);
        status.textContent = "Some details need another look — please check the highlighted fields.";
      } else {
        status.textContent = "Something went wrong sending your request. Your details are still here — please try again.";
      }
    } catch {
      status.textContent = "Network error — your details are still here. Please try again.";
    }
    btn.disabled = false;
    btn.textContent = "Request a tour";
  });

  // Clear a field's error as soon as the user edits it.
  form.addEventListener("input", (e) => {
    const entry = Object.entries(FIELD_INPUT).find(([, id]) => id && e.target.id === id);
    if (entry && e.target.getAttribute("aria-invalid") === "true") {
      e.target.setAttribute("aria-invalid", "false");
      byId(FIELD_ERROR[entry[0]]).textContent = "";
    }
  });
}

/* ------------------------------------------------------------------ boot */

bindCopy();
buildGallery();
wireFloorPlan();
wireReveal();
wireMobileCta();
wireForm();
