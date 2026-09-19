// Contact-section neighborhood map: the property plus nearby landmarks (landmarks.js) on a Leaflet
// map, with category chips and a nearest-first list that flies the map to each place.
// The list renders straight away; Leaflet (+ its CSS) is only fetched once the map nears the
// viewport. Basemap: OpenStreetMap's standard tiles (no API key), toned per theme in styles.css.
import { PROPERTY, CATEGORIES, LANDMARKS } from "./landmarks.js";

const byId = (id) => document.getElementById(id);

const ICONS = {
  police: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/>',
  school: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3.5 2.2 8.5 2.2 12 0v-5"/>',
  hospital: '<path d="M9 4h6v5h5v6h-5v5H9v-5H4V9h5z"/>',
  mall: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  church: '<path d="M12 2v5M10 4h4"/><path d="M6 21v-9l6-5 6 5v9z"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
};
const svg = (cat) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[cat]}</svg>`;

// Usage policy: https://operations.osmfoundation.org/policies/tiles/ (attribution required, no bulk use).
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Great-circle distance in metres. */
function distance(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtKm = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const catLabel = (id) => CATEGORIES.find((c) => c.id === id).label;
const directions = (p) =>
  `https://www.google.com/maps/dir/?api=1&origin=${PROPERTY.lat},${PROPERTY.lng}&destination=${p.lat},${p.lng}`;

const places = LANDMARKS
  .map((p, i) => ({ ...p, i, m: distance(PROPERTY, p) }))
  .sort((a, b) => a.m - b.m);

export function wireNeighborhood() {
  const mapEl = byId("nbhdMap");
  const list = byId("nbhdList");
  const chips = byId("nbhdFilters");
  if (!mapEl) return;
  byId("nbhdArea").textContent = PROPERTY.area;

  let filter = "all";
  let api = null; // set once Leaflet has loaded

  chips.innerHTML = [{ id: "all", label: "Nearest" }, ...CATEGORIES]
    .map((c) => `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${c.id === "all"}">${
      c.id === "all" ? "" : `<span class="chip-ico">${svg(c.id)}</span>`}${c.label}</button>`)
    .join("");

  // "Nearest" shows the closest place in each category; a category chip shows all of that kind.
  const visible = () =>
    filter === "all"
      ? CATEGORIES.map((c) => places.find((p) => p.cat === c.id))
      : places.filter((p) => p.cat === filter);

  const renderList = () => {
    list.innerHTML = "";
    for (const p of visible()) {
      const li = document.createElement("li");
      li.innerHTML = `
        <button type="button" class="nbhd-item" data-i="${p.i}">
          <span class="lm-dot lm-${p.cat}">${svg(p.cat)}</span>
          <span class="nbhd-text"><span class="nbhd-cat"></span><span class="nbhd-name"></span></span>
          <span class="nbhd-dist">${fmtKm(p.m)}</span>
        </button>`;
      li.querySelector(".nbhd-cat").textContent = catLabel(p.cat);
      li.querySelector(".nbhd-name").textContent = p.name;
      list.append(li);
    }
  };

  chips.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    filter = b.dataset.cat;
    for (const c of chips.children) c.setAttribute("aria-pressed", String(c === b));
    renderList();
    api?.show(visible());
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest(".nbhd-item");
    if (!b) return;
    for (const x of list.querySelectorAll(".nbhd-item")) x.classList.toggle("active", x === b);
    api?.focus(Number(b.dataset.i));
  });
  renderList();

  const load = async () => {
    try {
      api = await createMap(mapEl, (i) => {
        for (const x of list.querySelectorAll(".nbhd-item")) x.classList.toggle("active", Number(x.dataset.i) === i);
      });
      api.show(visible());
    } catch (err) {
      console.warn("Neighborhood map failed to load:", err);
      mapEl.classList.add("nbhd-map-failed");
      mapEl.textContent = "Map unavailable right now — the nearby places are listed below.";
    }
  };
  if (!("IntersectionObserver" in window)) return void load();
  const io = new IntersectionObserver(([en]) => {
    if (en.isIntersecting) { io.disconnect(); load(); }
  }, { rootMargin: "600px 0px" });
  io.observe(mapEl);
}

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
  return new Promise((ok, fail) => {
    const l = Object.assign(document.createElement("link"), { rel: "stylesheet", href });
    l.onload = ok; l.onerror = fail;
    document.head.append(l);
  });
}

async function createMap(el, onSelect) {
  const [mod] = await Promise.all([import("leaflet"), loadCss("/node_modules/leaflet/dist/leaflet.css")]);
  const L = mod.default ?? mod; // esbuild bundles Leaflet's CommonJS build; the raw ESM build has named exports only

  const map = L.map(el, {
    center: [PROPERTY.lat, PROPERTY.lng],
    zoom: 15,
    scrollWheelZoom: false, // don't hijack page scrolling; +/- and pinch still zoom
    dragging: !L.Browser.mobile, // one-finger swipes keep scrolling the page on phones
    zoomControl: false,
  });
  L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19, className: "nbhd-tiles" }).addTo(map);

  const home = L.marker([PROPERTY.lat, PROPERTY.lng], {
    icon: L.divIcon({
      className: "pin-home", iconSize: [44, 44], iconAnchor: [22, 22], popupAnchor: [0, -20],
      html: `<span class="pin-pulse"></span><span class="pin-core">${svg("home")}</span>`,
    }),
    zIndexOffset: 1000, keyboard: true, title: "The property",
  }).addTo(map);
  const homeBox = document.createElement("div");
  homeBox.innerHTML = `<p class="pop-cat">The property</p><p class="pop-name"></p>
    <a class="pop-link" href="https://www.google.com/maps/search/?api=1&query=${PROPERTY.lat},${PROPERTY.lng}" target="_blank" rel="noopener">Open in Google Maps ↗</a>`;
  homeBox.querySelector(".pop-name").textContent = PROPERTY.area;
  home.bindPopup(homeBox);

  const markers = new Map();
  const layer = L.layerGroup().addTo(map);
  for (const p of places) {
    const m = L.marker([p.lat, p.lng], {
      title: p.name,
      icon: L.divIcon({
        className: `pin-lm lm-${p.cat}`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14],
        html: `<span class="lm-dot lm-${p.cat}">${svg(p.cat)}</span>`,
      }),
    });
    const box = document.createElement("div");
    box.innerHTML = `<p class="pop-cat"></p><p class="pop-name"></p>
      <a class="pop-link" href="${directions(p)}" target="_blank" rel="noopener">Directions ↗</a>`;
    box.querySelector(".pop-cat").textContent = `${catLabel(p.cat)} · ${fmtKm(p.m)} away`;
    box.querySelector(".pop-name").textContent = p.name;
    m.bindPopup(box);
    m.on("click", () => onSelect(p.i));
    markers.set(p.i, m);
  }

  // Dashed lines from the home to whichever places are shown.
  const links = L.layerGroup().addTo(map);

  const api = {
    show(list) {
      layer.clearLayers();
      links.clearLayers();
      for (const p of list) {
        layer.addLayer(markers.get(p.i));
        links.addLayer(L.polyline([[PROPERTY.lat, PROPERTY.lng], [p.lat, p.lng]], {
          className: `nbhd-link lm-${p.cat}`, weight: 1.5, dashArray: "3 6", interactive: false,
        }));
      }
      const b = L.latLngBounds([[PROPERTY.lat, PROPERTY.lng], ...list.map((p) => [p.lat, p.lng])]);
      map.flyToBounds(b, { padding: [36, 36], maxZoom: 16, duration: 0.8 });
    },
    focus(i) {
      const m = markers.get(i);
      if (!layer.hasLayer(m)) layer.addLayer(m);
      map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 16), { duration: 0.8 });
      map.once("moveend", () => m.openPopup());
    },
  };
  // The grid column can change size after load (fonts, reveal animations).
  new ResizeObserver(() => map.invalidateSize()).observe(el);
  return api;
}
