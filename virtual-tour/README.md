# Modular House Cube 3 — 3D Virtual Tour + Listing Funnel

A locally hosted, Matterport/GoThru-style 3D virtual tour wrapped in a single-page
real-estate funnel whose one goal is **booking a property tour**. Built on
[Babylon.js](https://www.babylonjs.com/) (served entirely from `node_modules` — no CDN
JavaScript) and a zero-dependency Node server.

**Model bundled:** [“Modular House Cube 3 by Swanbuild Australia”](https://sketchfab.com/3d-models/modular-house-cube-3-by-swanbuild-australia-fc4d35cfe8ee435993e0353dbecae7e0)
by [EDSAHERGOM STUDIO](https://sketchfab.com/edsahergom), downloaded from Sketchfab, CC BY 4.0 — a textured PBR house
(77 meshes, 67 materials, 45 textures, ~21.6 MB).

## Run

```bash
cd virtual-tour
npm install        # once
npm start          # -> http://localhost:8080
```

## Page structure (funnel)

`index.html` → one page, in order:

1. **Sticky header** — wordmark, section links (Tour · Residence · Floor plan · Contact), “Schedule a tour”.
2. **Hero** — full-bleed render (`assets/hero.jpg/.webp`, captured from the model), listing title, tagline, facts line, CTA buttons.
3. **Intro + highlights** — copy from `listing.js`, 4 highlight tiles.
4. **Interactive 3D tour** — `#tour` frame (lazy: Babylon + model load only when the section nears the viewport or “Start tour” is clicked). Anchor pill bar, fullscreen (with iOS pseudo-fullscreen fallback), CC BY 4.0 credit inside the frame.
5. **Residence gallery** — cards built by `page.js` from `anchors.js` + `assets/gallery-*.jpg`; “View in 3D” jumps the tour to that room.
6. **Floor plan** — schematic SVG (hand-built, not the model texture); each room is clickable → `window.tour.goTo(id)`.
7. **Schedule a tour form** — accessible client validation + `POST /api/tour-requests`.
8. **Footer** — contact placeholders, model credit, “Built with Babylon.js”. Mobile gets a sticky bottom CTA bar (hidden while the form is on screen).

All listing copy (name, tagline, price, address, agent, facts) lives in **one object** in
`listing.js` — placeholders only. Edit it there.

## The tour API

`main.js` exposes `window.tour = { goTo(id, { instant }?), enterFullscreen(), exitFullscreen(), getCamera(), isReady(), whenReady() }`.
`goTo` animates the walk camera to an anchor (700 ms; instant under `prefers-reduced-motion`),
updates `#room=<id>` in the URL (deep-linkable) and scrolls the tour into view.

## Anchors (room viewpoints)

`anchors.js` exports `ROOM_ANCHORS` (15 entries: `id`, `label`, `group`, `caption`, `pos` =
eye position `[x, y, z]` in world space after scale normalisation, `yaw`, `pitch`), plus
`DOLLHOUSE` and `ANCHOR_GROUPS`. To adjust a viewpoint, edit its numbers and re-run
`npm run test:anchors` — it screenshots every anchor and fails on camera drift (>0.15 m)
or a blocked view (<1 m sight line). The gallery and floor plan reference anchors by `id`.

**Gotcha:** the SSAO2/post pipelines only attach to the `fp` and `dollhouse` cameras — a new
camera added at runtime renders black. Reuse those two (or attach the pipelines).

## Controls

| Input | Action |
|---|---|
| Click canvas | Take control (Esc releases; page scroll/keys are untouched until then) |
| `W A S D` / arrow keys | Walk (first-person) |
| Mouse | Look around (pointer lock) |
| `Shift` | Jog |
| `V` | Toggle **dollhouse / orbit view** (wheel zooms; wheel over canvas doesn’t scroll the page) |
| `Esc` | Release pointer / exit (pseudo-)fullscreen |

## Booking endpoint

`POST /api/tour-requests` (`server.mjs`, zero-dependency):

* JSON only, body ≤ 10 KB (413 above), bad JSON/fields → `400 { ok:false, errors:{field:msg} }`,
  any other method → 405.
* Honeypot field `company` non-empty → silent `200`, nothing stored.
* Every field re-validated server-side (name, email, phone 7–20 chars `+() -digits`,
  date ≥ tomorrow, time window morning/afternoon/evening, tour type in-person/video, message ≤ 1000).
* Valid entries are appended as `{ id, createdAt, …fields }` to **`data/tour-requests.json`**
  (created on demand, written atomically via temp file + rename). `data/` is git-ignored.

## Swap the 3D model

The tour auto-loads the first model file it finds in `models/`:

1. Download a free interior model — e.g. from [Poly Pizza](https://poly.pizza/search/interior)
   (no login, CC licenses) or [Sketchfab](https://sketchfab.com) (login, “downloadable” filter).
2. Drop the file into `virtual-tour/models/`.
   - Supported: `.glb`, `.gltf` (+ sidecar `.bin`/textures in the same folder), `.obj` (+`.mtl`), `.fbx`.
3. Reload the page.

The app auto-normalizes scale (files not in human scale are resized to ~14 m across) and
picks a spawn point with enough headroom via a floor/ceiling raycast grid. Re-derive
`anchors.js` if you swap models.

## How it works

- `server.mjs` — zero-dependency static server + `/api/models` listing + `/api/tour-requests` booking endpoint.
- `main.js` — Babylon `FreeCamera` with gravity + ellipsoid collision (`checkCollisions` on all
  model meshes), pointer-lock mouse look, `ArcRotateCamera` dollhouse mode, anchor `goTo` API,
  lazy loading, fullscreen. Renders inside `#tour`, never the full viewport.
- `page.js` — funnel logic: listing copy binding, gallery cards, floor-plan → tour hooks,
  scroll reveals, mobile CTA bar, booking form client side.
- `anchors.js` / `listing.js` — data (viewpoints / copy). `perimeter.js`, `houses.js` — generated
  neighbourhood dressing.
- Import map in `index.html` resolves `@babylonjs/*` to the local npm packages.
- `assets/` — hero + gallery stills captured from the model itself (see `.tmp/capture-assets.mjs`).

## Tests

```bash
npm run smoke         # headless NullEngine: glTF parse, bounds, spawn search, gravity
npm run test:api      # boots server on a random port: 201/400/413/405/honeypot, restores data file
npm run test:anchors  # headless Chrome: screenshots every anchor -> tests/shots/, fails on drift/blocked view
```

`tests/shots/page-1440.png` / `page-390.png` are QA renders of the funnel (headless Chrome,
console-error + horizontal-overflow checks).

## Attribution & license

3D model: **“Modular House Cube 3 by Swanbuild Australia”** by *EDSAHERGOM STUDIO*,
[Sketchfab](https://sketchfab.com/3d-models/modular-house-cube-3-by-swanbuild-australia-fc4d35cfe8ee435993e0353dbecae7e0), licensed **CC BY 4.0** (credit required).
Keep the in-app credit line intact if you share the tour.
