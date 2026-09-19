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
4. **Interactive 3D tour** — `#tour` frame (lazy: Babylon + model load only when the section nears the viewport or “Start tour” is clicked). Anchor pill bar, fullscreen (with iOS pseudo-fullscreen fallback). No credit overlay on the canvas — attribution lives in the footer.
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

The tour auto-loads the first model file it finds directly in `models/` (subfolders such as
`models/props/` and `models/source/` are ignored):

1. Download a free interior model — e.g. from [Poly Pizza](https://poly.pizza/search/interior)
   (no login, CC licenses) or [Sketchfab](https://sketchfab.com) (login, “downloadable” filter).
2. Drop the file into `virtual-tour/models/`.
   - Supported: `.glb`, `.gltf` (+ sidecar `.bin`/textures in the same folder), `.obj` (+`.mtl`), `.fbx`.
3. Reload the page.

The app auto-normalizes scale (files not in human scale are resized to ~14 m across) and
picks a spawn point with enough headroom via a floor/ceiling raycast grid. Re-derive
`anchors.js` if you swap models.

## Load performance

- **Lossless asset compression** (`npm run optimize`, needs `brew install webp`): rebuilds the served
  models and pine textures from the originals in `models/source/`, `models/props/source/` and
  `assets/tex/source/`. Geometry is meshopt-compressed without quantization and PNGs become
  lossless WebP (`cwebp -exact`). The script decodes every output again and aborts if a single
  vertex attribute or pixel differs. To optimize a new house model, put it in `models/source/`,
  add it to `GLBS` in `tools/optimize-models.mjs` and run the script (unoptimized models still load).
- **Bundling**: `server.mjs` bundles `page.js`/`main.js` + Babylon in memory with esbuild
  (`/dist/*`, rebuilt on file change), and Babylon stays a lazy chunk (`engine.js`). Without esbuild
  it falls back to the raw modules plus the import map.
- **Transfer**: brotli/gzip for code, models and the HDR; ETags, so a reload only revalidates.
- **Parallel start**: the house `.glb` downloads while the engine chunk loads.
- **Setup raycasts** (spawn search, storey height, ~9 000 rays) run against
  temporary 64-triangle submeshes (`splitForPicking()` in `main.js`). Same triangles, same hits,
  ~10× faster; the original submeshes are restored before the first frame.
- **Render on demand** ("frame scheduling" in `main.js`): no frames while the tour is off screen or
  the tab is hidden; full rate only while the view moves, input arrives, a `goTo()` animates or
  data loads (plus 1.2 s after); otherwise none — the canvas keeps the last frame. Anything that changes the scene from outside the render loop must
  call `wake()`.
- **Motion quality**: frames are GPU-bound (M2, Retina: ~45–60 ms GPU vs ~7 ms CPU). While the view
  moves, the canvas renders at CSS resolution (instead of up to 1.5×) with 8-sample, cheap-blur SSAO —
  about half the GPU time; when it comes to rest, one last frame renders at full quality.
- **Cheaper at no visual cost**: the shadow map renders once (sun and casters are static; redrawn
  when the scene settles), and the warm interior point lights exclude the forest templates (Babylon evaluates every assigned light per
  pixel regardless of `range`).

## How it works

- `server.mjs` — static server (esbuild bundle, compression, ETags) + `/api/models` listing + `/api/tour-requests` booking endpoint.
- `main.js` — Babylon `FreeCamera` with gravity + ellipsoid collision (`checkCollisions` on all
  model meshes), pointer-lock mouse look, `ArcRotateCamera` dollhouse mode, anchor `goTo` API,
  lazy loading, fullscreen. Renders inside `#tour`, never the full viewport.
- `page.js` — funnel logic: listing copy binding, gallery cards, floor-plan → tour hooks,
  scroll reveals, mobile CTA bar, booking form client side.
- `mood.js` — the look (sunny alpine forest): clear HDRI skybox + image-based light with the key
  light aimed at the sky's sun disc (`SUN_YAW` / `SUN_ELEVATION`), 3D distant mountains (painted
  ring until they load), light exp2 haze, ACES + colour-curve grade, vignette, grain; re-skins the
  model by glTF material name (charcoal-bronze cladding, satin bronze frames, clear reflective
  glass), dry pavers and warm interior point lights.
- `perimeter.js` — `buildForest()` (used): asphalt lane + instanced pine forest + the model's
  shrubs. `buildPerimeter()` / `houses.js` — the previous suburban street (unused, kept).
- `pines.js` — procedural pine / fir / cypress templates (branch cards on bark trunks).
- `cars.js` — `addGarageCars()`: streams the Ferrari SF90 and Porsche 911 in after the tour is
  ready and parks them where the model's own cars were (shadow casters,
  invisible box colliders).
- `models/props/` — scenery models (not auto-loaded as the house). `addBroadleafTrees()` in
  `perimeter.js` streams `broadleaf_trees.glb` in after the tour is ready and mixes it into the
  forest beyond ~20 m from the lot (conifers fill those spots if it fails to load).
- `anchors.js` / `listing.js` — data (viewpoints / copy).
- `engine.js` — every Babylon module the tour uses, loaded as one lazy chunk; points Babylon's
  meshopt decoder at `vendor/meshopt_decoder.js` (generated by `npm run optimize`) instead of its CDN.
- Import map in `index.html` resolves `@babylonjs/*` to the local npm packages (unbundled fallback).
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

CC0 assets from [Poly Haven](https://polyhaven.com) (no attribution required; credited anyway), in `assets/env/` and `assets/tex/`:

- HDRI [“Kloofendal 48d Partly Cloudy (Pure Sky)”](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) — Greg Zaal, Jarod Guest
  (`assets/env/overcast_soil_puresky_2k.hdr`, the previous overcast sky, is kept but no longer loaded)
- Textures [“Brick Pavement 02”](https://polyhaven.com/a/brick_pavement_02) and [“Asphalt 07”](https://polyhaven.com/a/asphalt_07) — Charlotte Baglioni
- Bark and needle maps from [“Pine Tree 01”](https://polyhaven.com/a/pine_tree_01) — Rob Tuytel, Rico Cilliers
  (`pine_branch.png` / `pine_tuft.png` are composed from its twig texture)
- Ground texture [“Leafy Grass”](https://polyhaven.com/a/leafy_grass) — Charlotte Baglioni

Broadleaf trees: **“Low Poly Tree Scene Free”** by *Nicholas-3D*,
[Sketchfab](https://sketchfab.com/3d-models/low-poly-tree-scene-free-89daa5e21f0d4f08a59dba0d566e88bd), licensed **CC BY 4.0** (credit required).
Modified: `models/props/broadleaf_trees.glb` keeps only the trees (grass, ground and water removed, textures
resized to ≤1024 px); the original download is `models/props/low_poly_tree_scene_free.glb` (not loaded).

Distant mountains: **“Mountain low poly For distant mountains”** by *adventurer*,
[Sketchfab](https://sketchfab.com/3d-models/mountain-low-poly-for-distant-mountains-cb7f28b5ee0e4ddfb12700ff9d9d35c8), licensed **CC BY 4.0** (credit required).
`addDistantMountains()` in `mood.js` instances it around two horizon rings once the tour is ready.

Font: [**Hanken Grotesk**](https://fonts.google.com/specimen/Hanken+Grotesk) (Google Fonts, SIL Open Font License) —
an open-source stand-in for Typodermic's commercial [Movatif](https://www.myfonts.com/collections/movatif-font-typodermic).

Garage cars (`cars.js`), replacing the model's own cars, which were cut out of the house GLB:

- **“2021 Ferrari SF90 Spider”** by *Outlaw Games™*,
  [Sketchfab](https://sketchfab.com/3d-models/2021-ferrari-sf90-spider-94a830f22c974dc2a8d437fab830456f), licensed **CC BY-NC 4.0**
  (credit required, **non-commercial use only**).
- **“Porsche 911 GT3”** by *Outlaw Games™*,
  [Sketchfab](https://sketchfab.com/3d-models/porsche-911-gt3-593c83f3662a4a45a016f95dedd9f243), licensed **CC BY-NC 4.0**
  (credit required, **non-commercial use only**).

Modified: `models/props/garage_ferrari_sf90.glb` / `garage_porsche_911_gt3.glb` are the originals
(`2021_ferrari_sf90_spider.glb` / `porsche_911_gt3.glb`, not loaded) with node transforms baked,
meshes merged by material, scaled to real length (4.704 m / 4.573 m), wheels on y = 0, front on +z, and
quantized (KHR_mesh_quantization).

3D model: **“Modular House Cube 3 by Swanbuild Australia”** by *EDSAHERGOM STUDIO*,
[Sketchfab](https://sketchfab.com/3d-models/modular-house-cube-3-by-swanbuild-australia-fc4d35cfe8ee435993e0353dbecae7e0), licensed **CC BY 4.0** (credit required).
Keep the footer attribution intact if you share the tour — the CC BY 4.0 / CC BY-NC 4.0 models require it. The tour canvas itself carries no credit line; `#credit` was removed, so the footer is the only attribution on the page.
