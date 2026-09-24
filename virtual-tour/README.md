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

## Voice assistant (Talkie)

The page embeds the Talkie voice assistant from the sibling `talkie-sdk/` the documented way
(`talkie-sdk/docs/integration.md`, "Drop-in embed"): one script and one element at the end of
`index.html`:

```html
<script src="/talkie/talkie-embed.js" defer></script>
<talkie-assistant api="/voice" profile="property" mode="conversation" label="Ask about this home"></talkie-assistant>
```

- **Bundle:** `server.mjs` builds `../talkie-sdk/src/embed.js` in memory with the options of
  `talkie-sdk/build.mjs` and serves it at `/talkie/talkie-embed.js` (+ `.map`), rebuilt when SDK
  sources change. It needs `npm install` in `talkie-sdk/` once; without it `/talkie/*` 404s and the
  rest of the page works as before. `talkie-sdk/dist/` is not used.
- **Persona:** `profile="property"` is the voice server's `agents/property.json`, written for this
  listing. Edit the agent's knowledge there, not here.
- **Voice server:** separate repo (`~/Develop/voice`), started as usual on :8000. The page reaches
  it through this server: `GET /voice/agent/context`, `GET /voice/agent/token` and
  `POST /voice/agent/session` (nothing else) are forwarded to `VOICE_API` (default
  `http://127.0.0.1:8000`), with the visitor's ticket (`Authorization`) and address
  (`X-Forwarded-For`, replaced, never appended). Same origin, so no CORS allow-list is needed, and
  it works through a tunnel. Without the voice server the launcher still opens; pressing Start
  shows the widget's error state.
- **Behind a load balancer:** set `TRUST_PROXY=1` so the proxy takes the visitor's address from
  the balancer's `X-Forwarded-For` (last entry) instead of the balancer's own. Only with exactly
  one proxy in front; otherwise leave it unset.
- **Behind Cloudflare** (a Cloudflare Tunnel, as in `../DEPLOY.md`): set `TRUST_PROXY=cloudflare`
  instead. The visitor's address is then the `CF-Connecting-IP` header Cloudflare sets. Only when
  nothing but Cloudflare can reach this server, since anyone else could send that header too.
- **Bot check** (`talkie-verify.js`): when the voice server sets `TURNSTILE_SECRET_KEY`, the
  assistant's `verify` hook loads Cloudflare Turnstile on demand and renders it in `.talkie-verify`
  above the launcher (invisible unless Turnstile needs a click). With the check off, nothing loads.
- **Sharing (`ngrok http 8080`):** gives the HTTPS the microphone needs on other devices. It also
  makes `/voice/agent/token` public. The voice server's per-IP and global caps and its 900 s
  session cap still apply, but set `TALKIE_TICKET_SECRET` and the Turnstile keys on it (its
  README, *Token access control*) before sharing the link widely, or stop the tunnel when you
  are done testing.
- **Microphone:** browsers only allow it on `localhost` or HTTPS.
- **Layout** (`styles.css`, "Talkie assistant"): widget uses the page's Hanken Grotesk (no extra
  Google Fonts request); on phones the launcher and panel sit above the sticky CTA bar; hidden in
  iOS pseudo-fullscreen, where it would cover the tour's controls.
- **Navigation tools** (`talkie-tools.js`, wired by `page.js`): the agent can move the visitor
  around the page. `show_room` flies the 3D tour to any anchor in `anchors.js` (or the dollhouse)
  via `window.tour.goTo`; on first use it starts the 3D load and answers at once rather than
  waiting for it. `go_to_section` scrolls to the overview, floor plan, 3D tour, gallery, location
  or booking form. Each returns what is now on screen (the anchor's label and caption) for the
  agent to talk about.
  The tool **definitions** (names, descriptions, parameter lists) live on the voice server, in the
  `tools` of its `property` profile (`~/Develop/voice/agents/property.json`), and reach the page
  through `/voice/agent/context`: edit a description there and refresh, no page release. The page
  leaves `el.tools` unset and only supplies the handlers (`onToolCall`), which must run here.
  Adding an anchor, a section (`SECTIONS`) or a landmark category therefore means updating the
  matching `enum` in the profile too; `node tests/talkie-tools.mjs` fails until the two agree
  (it reads the profile from `TALKIE_AGENTS_DIR`, default `~/Develop/voice/agents`, and skips
  those checks if it can't).
- **Conversation:** hands-free. Press **Start conversation** once; the agent greets the visitor,
  then they just talk and it answers and listens again. Talking over an answer interrupts it;
  **Stop** cuts an answer short; **End conversation** ends it. It ends itself after 60 s with
  nobody speaking (`idle-timeout`), since the mic streams to AssemblyAI the whole time.
  `mode="push-to-talk"` restores Start / Stop & Send; `barge-in="off"` if the agent keeps
  interrupting itself on loudspeakers.
- **Keys:** while the panel is open, Space starts the conversation or stops an answer, and Esc
  ends the conversation. Esc in pseudo-fullscreen does both that and exit fullscreen.

## Booking endpoint

`POST /api/tour-requests` (`server.mjs`, zero-dependency):

* JSON only, body ≤ 10 KB (413 above), bad JSON/fields → `400 { ok:false, errors:{field:msg} }`,
  any other method → 405.
* Honeypot field `company` non-empty → silent `200`, nothing stored.
* Every field re-validated server-side (name, email, phone 7–20 chars `+() -digits`,
  date ≥ tomorrow, time window morning/afternoon/evening, tour type in-person/video, message ≤ 1000).
* Valid entries are appended as `{ id, createdAt, …fields }` to **`data/tour-requests.json`**
  (created on demand, written atomically via temp file + rename). `data/` is git-ignored.

## Asset hosting (Cloudflare R2)

Models, the sky, textures and photos are **not in the repo**. They're served from the R2 bucket
`talkie-tour-assets` through the custom domain `https://assets.talkie-bird.online`. Every URL is
built from `ASSET_BASE` in `assets.js`; `index.html` and `styles.css` spell the same base out in
full. Keys mirror the old folders under a version prefix, for example
`v1/models/props/garage_ferrari_sf90.glb` and `v1/assets/hero.jpg`.

- **Upload** (`npm run upload-assets`, after `npx wrangler login`): puts every file in local
  `models/` and `assets/` into the bucket with its Content-Type and a one-year `immutable`
  Cache-Control. To change a file, restore the folders (from the backup or a rebuild), bump
  `VERSION` in `tools/upload-assets.mjs` and `ASSET_BASE` in `assets.js` (and the full URLs in
  `index.html` and `styles.css`) together, then upload. Old versions stay valid for cached pages.
- **Edge cache and CORS** (two rules on the `talkie-bird.online` zone, both matching
  `http.host eq "assets.talkie-bird.online"`):
  - *Cache Rule*: every file is eligible for cache, including `.glb` and `.env`, which Cloudflare
    doesn't cache by default. Edge and browser TTLs follow each object's Cache-Control.
  - *Response header Transform Rule*: `Access-Control-Allow-Origin: *` is set on every response,
    cached ones included. The 3D engine loads models and textures with CORS. R2's own per-origin
    CORS headers (`tools/r2-cors.json`) aren't enough behind the cache: Cloudflare ignores
    `Vary: Origin`, so whichever request filled the cache decided the headers for everyone, and
    cached images went out with no CORS header at all.
  - After changing either rule or the bucket's CORS, purge the `assets.talkie-bird.online`
    hostname (**Caching → Configuration → Purge Cache**).
- **Local dev** loads the same R2 files; `npm start` needs internet access for the tour.

## Swap the 3D model

The house is `HOUSE_MODEL` in `assets.js`, loaded from the bucket's `models/`. To use another
model:

1. Download a free interior model — e.g. from [Poly Pizza](https://poly.pizza/search/interior)
   (no login, CC licenses) or [Sketchfab](https://sketchfab.com) (login, “downloadable” filter).
2. Upload it as a self-contained `.glb` (see *Asset hosting* above) and set `HOUSE_MODEL` to its
   file name.
3. Reload the page.

The app auto-normalizes scale (files not in human scale are resized to ~14 m across) and
picks a spawn point with enough headroom via a floor/ceiling raycast grid. Re-derive
`anchors.js` if you swap models.

## Load performance

- **Asset compression** (`npm run optimize`, needs `brew install webp`): rebuilds the served
  models and pine textures from the originals in `models/source/`, `models/props/source/` and
  `assets/tex/source/`. The originals are **not in the repo** (kept in a separate backup), so only
  the optimized outputs ship. To rebuild, copy them back into those folders first. GLBs are lossy but tuned per asset (`ASSETS` in
  `tools/optimize-models.mjs`): textures resized per slot and re-encoded as WebP (colour q85,
  normal maps near-lossless), quantized meshopt geometry, the cars simplified to ~55 % of their
  triangles, and unused tangents and textures dropped. The house keeps float positions, because
  `cars.js` places the cars through its node matrix. The script aborts if a node, mesh or material
  name changes or a mesh loses more triangles than its budget. Check a change with before/after
  screenshots: run `SHOTS_DIR=tests/shots/before node tests/anchor-shots.mjs`, rebuild, then do the
  same run into `after`. The pine PNGs stay lossless WebP (`cwebp -exact`, pixel-checked). To
  optimize a new model, put it in a `source/` folder, add it to `ASSETS` and run the script
  (unoptimized models still load).
- **Pre-baked sky** (`npm run bake-sky`, with the server running): turns the 5.4 MB HDRI
  (restore it from the backup into `models/sky/source/` first) into Babylon `.env` cubes with prefiltered lighting and WebP faces:
  227 KB at 512 px for the full build, and 55 KB at 128 px for LITE mode (the default). The page no longer converts or prefilters
  the HDRI at load. RGBD encoding clips the sun disc at 255 in the reflections; the diffuse sky
  light comes from spherical harmonics computed before that clip. Re-run the bake after changing
  the HDRI.
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
- **LITE rendering on every device** (`LITE = true` in `main.js`; set it to `false` for the
  full-quality build). The canvas renders at CSS resolution, with a 1024 px shadow map, a 128 px sky
  cube and textures capped at 512 px. SSAO, MSAA, bloom, grain and the broadleaf trees are all off.
  The touch UI (tap hints, zoom buttons, finger-speed look) is separate (`TOUCH`, from
  `pointer: coarse`), so desktops keep the mouse/keyboard controls. The next bullet only applies
  to the full build.
- **Motion quality** (full build): frames are GPU-bound (M2, Retina: ~45–60 ms GPU vs ~7 ms CPU). While the view
  moves, the canvas renders at CSS resolution (instead of up to 1.5×) with 8-sample, cheap-blur SSAO —
  about half the GPU time; when it comes to rest, one last frame renders at full quality.
- **Cheaper at no visual cost**: the shadow map renders once (sun and casters are static; redrawn
  when the scene settles), and the warm interior point lights exclude the forest templates (Babylon evaluates every assigned light per
  pixel regardless of `range`).

## How it works

- `server.mjs` — static server (esbuild bundle, compression, ETags) + `/api/models` listing (now always empty; the tests use it as a liveness check) + `/api/tour-requests` booking endpoint + `/talkie/*` voice-assistant embed bundle + `/voice/*` proxy to the voice server.
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
- `models/props/` (on R2) — scenery models. `addBroadleafTrees()` in
  `perimeter.js` streams `broadleaf_trees.glb` in after the tour is ready and mixes it into the
  forest beyond ~20 m from the lot (conifers fill those spots if it fails to load, and in LITE mode).
- `anchors.js` / `listing.js` — data (viewpoints / copy).
- `engine.js` — every Babylon module the tour uses, loaded as one lazy chunk; points Babylon's
  meshopt decoder at `vendor/meshopt_decoder.js` (generated by `npm run optimize`) instead of its CDN.
- Import map in `index.html` resolves `@babylonjs/*` to the local npm packages (unbundled fallback).
- `assets/` (on R2) — hero + gallery stills captured from the model itself (see `.tmp/capture-assets.mjs`),
  the ground and pine textures (`assets/tex/`), and the logo.
- `assets.js` — `ASSET_BASE` (the R2 URL every asset is loaded from) and `HOUSE_MODEL`.

## Tests

```bash
npm run smoke         # headless NullEngine: glTF parse, bounds, spawn search, gravity
npm run test:talkie   # voice agent tools (schemas, room/section handling, error results) and the bot-check hook
npm run test:api      # boots server on a random port: 201/400/413/405/honeypot, restores data file; /talkie/* embed route, /voice/* proxy
npm run test:anchors  # headless Chrome: screenshots every anchor -> tests/shots/, fails on drift/blocked view
```

`tests/shots/page-1440.png` / `page-390.png` are QA renders of the funnel (headless Chrome,
console-error + horizontal-overflow checks).

## Attribution & license

CC0 assets from [Poly Haven](https://polyhaven.com) (no attribution required; credited anyway), in `models/sky/` and `assets/tex/`:

- HDRI [“Kloofendal 48d Partly Cloudy (Pure Sky)”](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) — Greg Zaal, Jarod Guest
- Textures [“Brick Pavement 02”](https://polyhaven.com/a/brick_pavement_02) and [“Asphalt 07”](https://polyhaven.com/a/asphalt_07) — Charlotte Baglioni
- Bark and needle maps from [“Pine Tree 01”](https://polyhaven.com/a/pine_tree_01) — Rob Tuytel, Rico Cilliers
  (`pine_branch.png` / `pine_tuft.png` are composed from its twig texture)
- Ground texture [“Leafy Grass”](https://polyhaven.com/a/leafy_grass) — Charlotte Baglioni

Broadleaf trees: **“Low Poly Tree Scene Free”** by *Nicholas-3D*,
[Sketchfab](https://sketchfab.com/3d-models/low-poly-tree-scene-free-89daa5e21f0d4f08a59dba0d566e88bd), licensed **CC BY 4.0** (credit required).
Modified: `models/props/broadleaf_trees.glb` keeps only the trees (grass, ground and water removed, textures
resized to ≤512 px).

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

Modified: `models/props/garage_ferrari_sf90.glb` / `garage_porsche_911_gt3.glb` are the original
downloads with node transforms baked,
meshes merged by material, scaled to real length (4.704 m / 4.573 m), wheels on y = 0, front on +z, and
quantized (KHR_mesh_quantization).

3D model: **“Modular House Cube 3 by Swanbuild Australia”** by *EDSAHERGOM STUDIO*,
[Sketchfab](https://sketchfab.com/3d-models/modular-house-cube-3-by-swanbuild-australia-fc4d35cfe8ee435993e0353dbecae7e0), licensed **CC BY 4.0** (credit required).
Keep the footer attribution intact if you share the tour — the CC BY 4.0 / CC BY-NC 4.0 models require it. The tour canvas itself carries no credit line; `#credit` was removed, so the footer is the only attribution on the page.
