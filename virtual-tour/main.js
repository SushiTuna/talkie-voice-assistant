// Funnel-page bootstrap + Babylon tour.
// Babylon and the model are lazy: they load only when #tour comes within one viewport of being
// visible or the user clicks "Start tour". The tour renders inside #tour (never the whole page)
// and captures mouse/keyboard only after the user clicks the canvas (Esc releases).
import { ROOM_ANCHORS, DOLLHOUSE, ANCHOR_GROUPS } from "./anchors.js";

const byId = (id) => document.getElementById(id);
const tourEl = byId("tour");
const canvas = byId("renderCanvas");
const posterEl = byId("tourPoster");
const noModelEl = byId("noModel");
const badgeEl = byId("badge");
const hintEl = byId("tourHint");
const crosshairEl = byId("crosshair");
const anchorBarEl = byId("anchorBar");
const fsBtnEl = byId("fsBtn");
const fsLabelEl = byId("fsLabel");

// ---- tunables (kept from the standalone tour) ----
const WALK_SPEED = 0.34;     // FreeCamera speed units; ≈1.5 m/s at real scale
const JOG_SPEED = 0.8;       // ≈3.5 m/s
const EYE_HEIGHT = 1.6;      // metres; eye sits at the top of the collision ellipsoid
const STEP_HEIGHT = 0.35;    // metres; lower obstacles are stepped onto, not collided with
const GRAVITY = 9.81;
const CEILING_HEIGHT = 2.6;  // metres; used to infer real-world scale from the interior
const SKY_TOP = "#7d858c";     // fallback gradient sky until the HDRI (mood.js) has loaded
const SKY_HORIZON = "#9da2a2";
const GO_TO_MS = 700;        // animated camera move between anchors
const ROOM_RADIUS = 4.5;     // walking within this (XZ) of an anchor marks its pill active

const B = {}; // Babylon namespace, filled by loadBabylon()
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
// Phones and tablets: iOS Safari kills the WebGL context when a page uses too much GPU memory
// (the canvas goes black), and after that can refuse new contexts ("WebGL not supported").
// So touch devices get a lighter scene: CSS-resolution canvas, smaller shadow map, no SSAO,
// no MSAA/bloom/grain, textures capped at 512 px, a 128 px sky cube, and no broadleaf trees.
const LITE = window.matchMedia("(pointer: coarse)").matches;

let engine = null, scene = null, fpCam = null, arcCam = null, sun = null, hemi = null;
let modelMeshes = [], shadowMap = null, ssaoPipe = null;
let spawnPoint = null, mode = "walk", jogging = false, fallSpeed = 0;
let captured = false, ready = false, animating = false, pseudoFs = false;
let loadPromise = null;
let unsplitModel = () => {};

/* ------------------------------------------------------------------ lazy start */

function ensureTour() {
  if (!loadPromise) loadPromise = loadTour();
  return loadPromise;
}

// "Within one viewport of being visible" → extend the observer root 100% downward.
const lazyIO = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) {
    lazyIO.disconnect();
    ensureTour();
  }
}, { rootMargin: "0px 0px 100% 0px" });
lazyIO.observe(tourEl);

/* ------------------------------------------------------------------ babylon loading */

async function loadBabylon() {
  if (B.Engine) return;
  Object.assign(B, await import("./engine.js"));
}

function setProgress(pct, msg) {
  const bar = byId("loadBar");
  bar.style.width = `${Math.min(100, Math.max(0, Math.round(pct)))}%`;
  bar.parentElement?.setAttribute("aria-valuenow", String(Math.round(pct)));
  if (msg) byId("loadMsg").textContent = msg;
}

function showError(title, msg) {
  posterEl.hidden = true;
  noModelEl.querySelector("h2").textContent = title;
  noModelEl.querySelector("p").textContent = msg;
  byId("retryBtn").textContent = title === "No 3D model found" ? "I’ve added it — reload" : "Reload";
  noModelEl.hidden = false;
}

async function loadTour() {
  posterEl.classList.add("loading");
  setProgress(2, "Loading 3D engine…");
  try {
    // The engine code and the model download in parallel; the model is parsed once both are here.
    const fileP = findModelFile();
    const bytesP = fileP.then((file) => (file && /\.glb$/i.test(file) ? fetchModel(file) : null));
    bytesP.catch(() => {}); // awaited below; don't flag it as unhandled while the engine loads
    await loadBabylon();
    buildWorld();
    const file = await fileP;
    if (!file) {
      loadPromise = null;
      showError("No 3D model found", "Place a .glb / .gltf / .obj / .fbx file in models/ and reload.");
      return;
    }
    setProgress(6, `Fetching ${file}…`);
    const count = await loadModel(file, await bytesP);
    if (!count) throw new Error("no meshes in file");
    setProgress(97, "Preparing walkthrough…");
    buildCameras();
    ready = true;
    setProgress(100);
    posterEl.hidden = true;
    noModelEl.hidden = true;
    tourEl.classList.add("ready");
    buildAnchorBar();
    updateHud();
    onFsChange();
    const m = /^#room=([\w-]+)$/.exec(location.hash || "");
    if (m) goTo(m[1], { instant: true });
    else {
      // Open on the Exterior view instead of the auto spawn (under the raised house, which reads as a dark frame).
      const opening = ROOM_ANCHORS.find((a) => a.id === "exterior");
      if (opening) { animateTo(opening, true); setActivePill(opening.id); }
    }
  } catch (err) {
    console.error(err);
    loadPromise = null;
    if (/WebGL not supported/.test(err?.message)) {
      showError("3D isn’t available in this browser", "The browser refused a WebGL context. On iPhone, close this tab, open a new one and try again.");
    } else showError("Could not load model", String(err?.message || err));
  }
}

/* ------------------------------------------------------------------ scene setup */

function buildWorld() {
  engine = new B.Engine(canvas, !LITE, { stencil: true, preserveDrawingBuffer: !LITE }, !LITE);
  // Babylon downsizes image textures above this on upload (ThinEngine._prepareWebGLTexture).
  if (LITE) engine.getCaps().maxTextureSize = Math.min(engine.getCaps().maxTextureSize, 512);
  engine.onContextLostObservable.add(() => {
    sleep();
    const stage = ready ? "after loading" : `while ${byId("loadMsg").textContent.replace(/…$/, "").toLowerCase() || "loading"}`;
    console.error(`WebGL context lost ${stage}`);
    showError("The 3D view stopped", ready
      ? "The browser ran out of graphics memory. Reload to try again."
      : "The browser shut off 3D graphics as the view started. On iPhone, fully close Safari (swipe it away in the app switcher), reopen it and try again.");
  });
  // Sharp on Retina, but cap the resolution so SSAO stays affordable.
  engine.setHardwareScalingLevel(FULL_SCALE);
  scene = new B.Scene(engine);
  window.__engine = engine; // debugging hooks (also used by tests)
  window.__scene = scene;

  scene.collisionsEnabled = true;
  scene.skipPointerMovePicking = true;

  hemi = new B.HemisphericLight("hemi", new B.Vector3(0, 1, 0), scene);
  sun = new B.DirectionalLight("sun", new B.Vector3(-0.4, -1, 0.35), scene);
  sun.position.set(10, 15, -10);
  // Overcast HDRI sky + image-based light, misty mountains, fog and the colour grade (mood.js);
  // the gradient dome shows until the HDRI has loaded.
  B.mood.setupAtmosphere(scene, { hemi, sun, fallbackSky: buildSky(), envSize: LITE ? 128 : 512 });
  // New meshes (streamed trees and cars) and textures (HDR sky, maps) need frames to show up.
  scene.onNewMeshAddedObservable.add(() => wake());
  scene.onNewTextureAddedObservable.add(() => wake());
  wake();
}

/* ------------------------------------------------------------------ frame scheduling */
// One frame of this scene costs tens of milliseconds of main-thread time, which is what made the
// page stutter while scrolling. So a frame is only rendered when it could look different:
//   - never while #tour is off screen or the tab is hidden;
//   - at full rate while the view moves, input arrives, goTo() animates or data is loading;
//   - otherwise not at all: the canvas keeps showing the last frame.
//
// Frames are GPU-bound (~45–60 ms of GPU time on an M2 at Retina, CPU ~7 ms), so while the view
// moves they render in FAST quality: canvas at CSS resolution instead of up to 1.5×, and 8-sample
// SSAO with the cheap blur — about half the GPU time, and motion hides the difference. When the
// view comes to rest, one last frame renders in FULL quality, so a still view looks as before.
const FULL_SCALE = LITE ? 1 : 1 / Math.min(window.devicePixelRatio || 1, 1.5); // sharp on Retina, capped for SSAO
const WAKE_MS = 1200; // full rate this long after the last change (camera inertia, shader compiles)

let onScreen = false, looping = false, wakeUntil = 0, resuming = false, readyChecked = false, fast = false;
const lastView = new Float64Array(16).fill(NaN);

/** Render at full rate for at least `ms` from now (restarts the loop if it was idle). */
function wake(ms = WAKE_MS) {
  wakeUntil = Math.max(wakeUntil, performance.now() + ms);
  readyChecked = false;
  // The IntersectionObserver can miss a crossing (seen when the viewport is resized for a moment);
  // a stale "off screen" would freeze the tour, so double-check against the actual layout.
  if (!onScreen) {
    const r = tourEl.getBoundingClientRect();
    onScreen = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  }
  if (looping || !engine || !onScreen || document.hidden) return;
  looping = true;
  resuming = true;
  engine.runRenderLoop(renderFrame);
}

function sleep() {
  if (!looping) return;
  looping = false;
  engine.stopRenderLoop(renderFrame);
}

/** True if the active camera's view matrix differs from the previous call's. */
function viewChanged() {
  const m = scene.activeCamera?.getViewMatrix().m;
  if (!m) return false;
  let changed = false;
  for (let i = 0; i < 16; i++) {
    if (!(Math.abs(m[i] - lastView[i]) <= 1e-6)) { changed = true; lastView[i] = m[i]; }
  }
  return changed;
}

function renderFrame() {
  // Never let an exception escape: Babylon stops re-scheduling RAF if a frame throws.
  try {
    // First frame after a pause: advance animations by one frame, not by the length of the pause.
    scene.useConstantAnimationDeltaTime = resuming;
    resuming = false;
    if (mode === "walk" && fpCam && !animating) {
      fpCam.speed = jogging ? JOG_SPEED : WALK_SPEED;
      followGround(Math.min(engine.getDeltaTime(), 50) / 1000);
      if (spawnPoint && fpCam.position.y < spawnPoint.y - 10) {
        fpCam.position.copyFrom(spawnPoint).addInPlace(new B.Vector3(0, EYE_HEIGHT + 0.05, 0));
      }
    }
    if (scene.activeCamera) scene.render();
    trackNearbyAnchor();
  } catch (err) {
    console.error("render frame error:", err);
  }
  scheduleNext();
}

function scheduleNext() {
  const moving = viewChanged() || animating;
  if (moving || scene.isLoading || joy.active) wake();
  if (performance.now() < wakeUntil) {
    if (moving && ready) setFast(true);
    return;
  }
  // Coming to rest. Make sure nothing is still compiling (a mesh would stay invisible until the
  // next wake), then render one more frame: settled quality and a fresh shadow map.
  if (!readyChecked) {
    if (!scene.isReady(false)) { wake(300); return; }
    readyChecked = true;
    shadowMap?.resetRefreshCounter();
    setFast(false);
    return;
  }
  sleep();
}

function setFast(on) {
  if (on === fast || !engine) return;
  fast = on;
  engine.setHardwareScalingLevel(on ? Math.max(FULL_SCALE, 1) : FULL_SCALE);
  if (ssaoPipe) {
    ssaoPipe.samples = on ? 8 : 16;
    // Fewer samples need a bigger depth pad, or flat walls grow false self-occlusion blotches.
    ssaoPipe.epsilon = on ? 0.06 : 0.03;
    ssaoPipe.expensiveBlur = !on;
  }
}

function resizeEngine() {
  if (!engine) return;
  engine.resize(); // resizing clears the canvas, so it needs a fresh frame
  wake();
}

async function findModelFile() {
  try {
    const files = await (await fetch("/api/models")).json();
    return files[0] || null;
  } catch {
    return null;
  }
}

/**
 * Start outside: sample the lot on a grid for open-sky ground (the lowest surface, so never a roof)
 * with 2.5 m clear all around, and pick the one closest to the model's centre that looks straight
 * at a wall of the house. Falls back to any roomy open spot, then any open spot, then the centre.
 */
function findSpawn(min, max) {
  const N = 40;
  const CLEAR = 2.5;
  const pickable = (m) => m.checkCollisions && m.isEnabled();
  const cx = (min.x + max.x) / 2, cz = (min.z + max.z) / 2;
  const ground = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = min.x + ((max.x - min.x) * (i + 0.5)) / N;
      const z = min.z + ((max.z - min.z) * (j + 0.5)) / N;
      const down = new B.Ray(new B.Vector3(x, max.y + 1, z), B.Vector3.Down(), max.y - min.y + 4);
      const hits = (scene.multiPickWithRay(down, pickable) || []).sort((a, b) => a.distance - b.distance);
      if (!hits.length) continue;
      const floorY = hits[hits.length - 1].pickedPoint.y; // lowest surface = the ground
      const up = new B.Ray(new B.Vector3(x, floorY + 0.05, z), B.Vector3.Up(), 50);
      if (scene.pickWithRay(up, pickable)?.hit) continue; // under a roof, deck or tree
      ground.push({ pos: new B.Vector3(x, floorY, z), d: Math.hypot(x - cx, z - cz) });
    }
  }
  ground.sort((a, b) => a.d - b.d);
  const roomy = (pos) => {
    for (let k = 0; k < 16; k++) {
      const r = (k / 16) * Math.PI * 2;
      const ray = new B.Ray(new B.Vector3(pos.x, pos.y + 1, pos.z), new B.Vector3(Math.sin(r), 0, Math.cos(r)), CLEAR);
      if (scene.pickWithRay(ray, pickable)?.hit) return false;
    }
    // the lot must continue under our feet a little in every direction (don't start at its edge)
    for (let k = 0; k < 8; k++) {
      const r = (k / 8) * Math.PI * 2;
      const p = new B.Vector3(pos.x + Math.sin(r) * 1.5, pos.y + 1, pos.z + Math.cos(r) * 1.5);
      if (!scene.pickWithRay(new B.Ray(p, B.Vector3.Down(), 3), pickable)?.hit) return false;
    }
    return true;
  };
  // Prefer a spot where eye-level sight toward the centre lands on a wall 4–10 m away (the facade,
  // not the underside of a raised floor or a fence far off).
  const facesHouse = (pos) => {
    const eye = new B.Vector3(pos.x, pos.y + EYE_HEIGHT, pos.z);
    const dir = new B.Vector3(cx - pos.x, 0, cz - pos.z).normalize();
    const hit = scene.pickWithRay(new B.Ray(eye, dir, 10), pickable);
    return hit?.hit && hit.distance >= 4 && Math.abs(hit.getNormal(true)?.y ?? 1) < 0.3; // vertical surface
  };
  const roomyAll = ground.filter((g) => roomy(g.pos));
  const spot = roomyAll.find((g) => facesHouse(g.pos)) || roomyAll[0] || ground[0];
  return spot ? spot.pos.clone() : new B.Vector3(cx, min.y + 1.3, cz);
}

/** Gradient sky dome that follows the camera (never collides, never picked). */
function buildSky() {
  const tex = new B.DynamicTexture("skyGradient", { width: 4, height: 256 }, scene, false);
  const ctx = tex.getContext();
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  // Canvas top maps to the bottom of the sphere, so the gradient runs horizon → zenith.
  g.addColorStop(0, SKY_HORIZON);
  g.addColorStop(0.5, SKY_HORIZON);
  g.addColorStop(1, SKY_TOP);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  tex.update();
  const mat = new B.StandardMaterial("skyMat", scene);
  mat.emissiveTexture = tex;
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  mat.fogEnabled = false;
  const sky = B.CreateSphere("sky", { diameter: 1000, segments: 16 }, scene);
  sky.material = mat;
  sky.infiniteDistance = true;
  sky.isPickable = false;
  sky.applyFog = false;
  sky.renderingGroupId = 0;
  return sky;
}

/** Billboard trees and bushes in the model (alpha-textured, low-poly), split by height. */
function findModelFoliage() {
  const trees = [], bushes = [];
  for (const m of scene.meshes) {
    if (m.metadata?.perimeter || !/tree|bush|shrub|plant|palm|foliage/i.test(m.name)) continue;
    const tex = m.material?.albedoTexture || m.material?.diffuseTexture;
    if (!tex?.hasAlpha || m.getTotalVertices() > 200) continue; // cut-out billboards only
    const b = m.getBoundingInfo().boundingBox;
    const w = Math.max(b.maximumWorld.x - b.minimumWorld.x, b.maximumWorld.z - b.minimumWorld.z);
    if (w > 7) continue; // several plants merged into one mesh, spread across the lot
    (b.maximumWorld.y - b.minimumWorld.y > 3 ? trees : bushes).push(m);
  }
  return { trees, bushes };
}

/** Large grass plane just under the lot so the model doesn't float in a void. */
function buildSurroundingGround(y) {
  const ground = B.CreateGround("surroundings", { width: 2000, height: 2000 }, scene);
  ground.position.y = y;
  ground.material = B.makeGrassMaterial(scene, 2000);
  ground.checkCollisions = true; // walk around the lot instead of falling off its edge
  ground.isPickable = false;
  return ground;
}

function boundsOf(roots) {
  const min = new B.Vector3(Infinity, Infinity, Infinity);
  const max = new B.Vector3(-Infinity, -Infinity, -Infinity);
  for (const r of roots) {
    const v = r.getHierarchyBoundingVectors(true);
    min.minimizeInPlace(v.min);
    max.maximizeInPlace(v.max);
  }
  return { min, max };
}

function buildCameras() {
  const { min, max } = boundsOf(scene.meshes.filter((m) => m.checkCollisions));
  const size = max.subtract(min);
  const center = min.add(max).scale(0.5);
  spawnPoint = findSpawn(min, max);
  const groundY = spawnPoint.y - 0.08;
  buildSurroundingGround(groundY);
  // Dark bronze facade, clear glass, dry pavers, warm interior light.
  const { lights: warmLights } = B.mood.restyleModel(scene, { modelMeshes, anchors: ROOM_ANCHORS });
  // Lane on the side of the lot where the tour starts; pine forest all around; the model's shrubs as understorey.
  const forest = B.buildForest(scene, min, max, groundY, spawnPoint.z >= center.z ? 1 : -1, findModelFoliage());
  // Soft sky occlusion on the ground under the raised house and under each tree (the sun's
  // shadow map alone leaves the ground beneath the house lit by the sky dome).
  const roof = modelMeshes.find((m) => /^Roof_/.test(m.material?.name || ""));
  const rb = roof?.getBoundingInfo().boundingBox;
  const slab = modelMeshes.find((m) => /ED_CONCRETE/.test(m.name)); // by mesh name: restyleModel swapped its material
  const decalY = Math.max(groundY, slab ? slab.getBoundingInfo().boundingBox.maximumWorld.y : groundY) + 0.02;
  // The warm interior lights only reach a few metres, but Babylon evaluates every light a mesh is
  // assigned to on each of its pixels (range only fades it out in the shader). Keep them off the
  // forest templates (instances share their source's lights): hundreds of overlapping needle cards.
  const unlightForest = () => {
    const templates = scene.meshes.filter((m) => m.metadata?.perimeter && !m.isAnInstance && m.instances?.length);
    for (const l of warmLights) for (const t of templates) if (!l.excludedMeshes.includes(t)) l.excludedMeshes.push(t);
  };
  const occlude = () => { B.addGroundOcclusion(scene, { y: groundY + 0.02 }); unlightForest(); };
  occlude(); // conifers first, at grass height; the house call below then finds no new trees
  B.addGroundOcclusion(scene, { footprint: rb && { min: rb.minimumWorld, max: rb.maximumWorld }, y: decalY });
  // Broadleaf trees for the mid/far forest stream in after the tour is ready (5 MB); conifers if that fails.
  (LITE ? Promise.reject(new Error("skipped on touch devices")) : B.addBroadleafTrees(scene, forest.broadleafSlots, groundY)).then(occlude, (err) => {
    console.warn("broadleaf trees unavailable, planting conifers instead:", err);
    forest.fillWithConifers();
    occlude();
  });
  // 3D mountains on the horizon stream in the same way (2 MB); the painted ridgeline ring stays if that fails.
  B.mood.addDistantMountains(scene).catch((err) => console.warn("3D mountains unavailable, keeping painted ridges:", err));

  fpCam = new B.FreeCamera("fp", spawnPoint.add(new B.Vector3(0, EYE_HEIGHT + 0.05, 0)), scene);
  fpCam.checkCollisions = true;
  // Slim body (0.24 m wide) so doorways are easy to pass; spans eye → eye - 2*y (feet).
  // Body collides only from knee height (STEP_HEIGHT) up to the eye, so feet never snag; height
  // above the floor is handled by followGround() instead of Babylon's gravity.
  fpCam.ellipsoid = new B.Vector3(0.12, (EYE_HEIGHT - STEP_HEIGHT) / 2, 0.12);
  fpCam.ellipsoidOffset = new B.Vector3(0, 0, 0);
  fpCam.minZ = 0.05;
  fpCam.fov = 1.0;
  fpCam.angularSensibility = LITE ? 1100 : 1800; // a finger swipe covers fewer pixels than a mouse
  fpCam.inertia = 0.72;
  fpCam.speed = WALK_SPEED;
  fpCam.keysUp = [87, 38];    // W / ↑
  fpCam.keysDown = [83, 40];  // S / ↓
  fpCam.keysLeft = [65, 37];  // A / ←
  fpCam.keysRight = [68, 39]; // D / →
  fpCam.rotation.y = Math.atan2(center.x - spawnPoint.x, center.z - spawnPoint.z);
  // Walk, don't fly: FreeCamera moves along the full look vector (pitch included). Right after the
  // inputs run, and before Babylon applies the move, drop the vertical part and keep the speed.
  const checkInputs = fpCam.inputs.checkInputs.bind(fpCam.inputs);
  fpCam.inputs.checkInputs = () => {
    checkInputs();
    if (joy.active && captured && !animating) {
      // Joystick (touch screens): x strafes, y walks, along the ground at the keyboard's speed.
      const s = fpCam._computeLocalCameraSpeed(), yaw = fpCam.rotation.y;
      const side = joy.x * s, fwd = -joy.y * s;
      fpCam.cameraDirection.x += Math.cos(yaw) * side + Math.sin(yaw) * fwd;
      fpCam.cameraDirection.z += -Math.sin(yaw) * side + Math.cos(yaw) * fwd;
    }
    const d = fpCam.cameraDirection;
    const total = d.length();
    const horiz = Math.hypot(d.x, d.z);
    d.y = 0;
    if (horiz > 1e-6) { d.x *= total / horiz; d.z *= total / horiz; }
  };
  // NOTE: control is attached on demand by capture() — the page keeps scroll/keys until then.

  arcCam = new B.ArcRotateCamera("dollhouse", -Math.PI / 2, 0.85, size.length() * 1.35, center, scene);
  arcCam.minZ = 0.1;
  arcCam.upperBetaLimit = 1.45;
  arcCam.lowerRadiusLimit = size.length() * 0.35;
  arcCam.upperRadiusLimit = size.length() * 3;
  arcCam.wheelPrecision = 15;
  arcCam.panningSensibility = 0;

  scene.activeCamera = fpCam;
  setupRenderQuality([fpCam, arcCam]);
  // Ferrari SF90 + Porsche 911 under the carport, where the model's own cars were (~8 MB, streamed in).
  if (slab) {
    import("./cars.js").then((m) => m.addGarageCars(scene, {
      ref: slab, floorY: slab.getBoundingInfo().boundingBox.maximumWorld.y, shadows: sun.getShadowGenerator(),
    })).catch((err) => console.warn("garage cars unavailable:", err));
  }
  unsplitModel(); // last probe ray is cast; back to one draw call per mesh
  // The SSAO/post pipelines only attach to these two cameras — never render with a third one;
  // that is why goTo() animates the existing fp camera instead of creating a new one.
}

/** Shadows, ambient occlusion, anti-aliasing, tone mapping and texture filtering. */
function setupRenderQuality(cameras) {
  // Only the house casts shadows (keeps the shadow map sharp); the neighbourhood just receives them.
  // Meshes entirely below the surrounding ground (the model's buried soil block) are left out:
  // they can't shadow anything visible and would stretch the shadow frustum, blurring the shadows.
  const groundY = scene.getMeshByName("surroundings")?.position.y ?? -Infinity;
  const casters = modelMeshes.filter((m) => m.getTotalVertices() > 0 && m.getBoundingInfo().boundingBox.maximumWorld.y > groundY);

  // Soft sun shadows (PCF). The light's shadow frustum is fitted to the casters automatically.
  sun.autoCalcShadowZBounds = true;
  const shadows = new B.ShadowGenerator(LITE ? 1024 : 2048, sun);
  // Sun and casters never move, so the map is drawn once (RenderTargetTexture.REFRESHRATE_RENDER_ONCE)
  // and redrawn by scheduleNext() whenever the scene settles (e.g. after the cars stream in).
  shadowMap = shadows.getShadowMap();
  shadowMap.refreshRate = 0;
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = B.ShadowGenerator.QUALITY_HIGH;
  shadows.bias = 0.0005;
  shadows.normalBias = 0.02;
  shadows.setDarkness(0.2); // sunny: crisp, deep shadows; the sky's IBL still fills them (0 = pitch black)
  for (const m of casters) { shadows.addShadowCaster(m, false); m.receiveShadows = true; }
  for (const m of scene.meshes) if (m.name === "surroundings" || m.metadata?.perimeter) m.receiveShadows = true;

  // Crisp textures at grazing angles (floors, grass).
  for (const mat of scene.materials) for (const t of mat.getActiveTextures()) t.anisotropicFilteringLevel = 8;

  // Ambient occlusion: darkens corners and contact points so rooms read as 3D. Kept to contact
  // scale indoors: a wider radius smears metre-long grime along every wall/floor junction.
  if (!LITE && B.SSAO2RenderingPipeline.IsSupported) {
    const ssao = ssaoPipe = new B.SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 0.5, blurRatio: 1 }, cameras);
    ssao.radius = 0.4;          // metres (the model is at real scale)
    ssao.totalStrength = 0.7;
    ssao.epsilon = 0.03;        // depth-precision pad: flat walls must not self-occlude
    ssao.samples = 16;
    ssao.maxZ = 60;
    ssao.expensiveBlur = true;
  }

  // HDR post-processing: MSAA + FXAA, subtle bloom and sharpening; tone mapping comes from the scene config.
  const pipeline = new B.DefaultRenderingPipeline("quality", true, scene, cameras);
  pipeline.samples = 4;
  pipeline.fxaaEnabled = true;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.9;
  pipeline.bloomWeight = 0.15;
  pipeline.bloomKernel = 48;
  pipeline.sharpenEnabled = true;
  pipeline.sharpen.edgeAmount = 0.15;
  pipeline.imageProcessingEnabled = true;
  B.mood.tunePost(pipeline); // wider bloom for glowing windows + film grain
  if (LITE) {
    pipeline.samples = 1; // FXAA alone
    pipeline.bloomEnabled = false;
    pipeline.grainEnabled = false;
  }
  window.__quality = { ssao: ssaoPipe, shadows }; // debug/QA handle, like window.__scene
}

/**
 * Setup casts several thousand probe rays (spawn search, storey height), and
 * Babylon tests every triangle of a mesh whose bounds a ray touches. Meanwhile, split the big
 * meshes into ~CHUNK-triangle submeshes so rays skip whole chunks by their bounding boxes: same
 * triangles, same order, same hits, several times faster. Returns a function that restores the
 * original submeshes (one draw call per mesh again); call it before the first frame.
 */
function splitForPicking(meshes, CHUNK = 64) {
  // Ray.intersectsTriangle accepts hits up to `epsilon` (barycentric) outside a triangle, so a tight
  // chunk box could cull a hit the whole mesh would return. Test each chunk against its box grown
  // by 4·epsilon·(its longest edge), which covers them all.
  const eps = new B.Ray(B.Vector3.Zero(), B.Vector3.Up()).epsilon;
  const saved = [];
  for (const m of meshes) {
    const tris = m.getTotalIndices() / 3;
    if (m.subMeshes?.length !== 1 || tris < CHUNK * 2 || m.skeleton || m.morphTargetManager) continue;
    const pos = m.getVerticesData("position");
    const idx = m.getIndices();
    if (!pos || !idx) continue;
    const { materialIndex, verticesStart, verticesCount, indexStart, indexCount } = m.subMeshes[0];
    saved.push({ m, sub: [materialIndex, verticesStart, verticesCount, indexStart, indexCount] });
    // Exact index ranges (Mesh.subdivide() can leave the last few triangles out of every chunk).
    m.releaseSubMeshes();
    for (let start = 0; start < indexCount; start += CHUNK * 3) {
      B.SubMesh.CreateFromIndices(materialIndex, indexStart + start, Math.min(CHUNK * 3, indexCount - start), m);
    }
    m.refreshBoundingInfo();
    m.synchronizeInstances();
    for (const sm of m.subMeshes) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      let edge = 0;
      for (let t = sm.indexStart; t < sm.indexStart + sm.indexCount; t += 3) {
        for (let k = 0; k < 3; k++) {
          const a = idx[t + k] * 3, b = idx[t + ((k + 1) % 3)] * 3;
          edge = Math.max(edge, Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]));
          for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], pos[a + c]); hi[c] = Math.max(hi[c], pos[a + c]); }
        }
      }
      const pad = 4 * eps * edge;
      const min = new B.Vector3(lo[0] - pad, lo[1] - pad, lo[2] - pad);
      const max = new B.Vector3(hi[0] + pad, hi[1] + pad, hi[2] + pad);
      sm.canIntersects = (ray) => ray.intersectsBoxMinMax(min, max); // rays arrive in mesh-local space
    }
  }
  return () => {
    for (const { m, sub } of saved) {
      m.releaseSubMeshes();
      new B.SubMesh(...sub, m);
      m.synchronizeInstances();
    }
  };
}

/** Download a self-contained .glb with a progress bar (6–94 %); resolves to its bytes. */
async function fetchModel(file) {
  const res = await fetch(`/models/${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${file}`);
  // Content-Length is the compressed size when the server gzips; it sends the real one alongside.
  const total = Number(res.headers.get("x-decoded-length") || (res.headers.get("content-encoding") ? 0 : res.headers.get("content-length")));
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > total) throw new Error(`${file}: more bytes than announced`);
    out.set(value, loaded);
    loaded += value.length;
    setProgress(6 + (loaded / total) * 88);
  }
  return loaded === total ? out : out.subarray(0, loaded);
}

async function loadModel(file, bytes) {
  const before = new Set(scene.meshes.map((m) => m.uniqueId));
  if (bytes) {
    await B.ImportMeshAsync(bytes, scene, { pluginExtension: ".glb" });
  } else {
    await B.ImportMeshAsync(file, scene, {
      rootUrl: "/models/",
      onProgress: (event) => {
        if (event.total && event.loaded) setProgress(6 + (event.loaded / event.total) * 88);
      },
    });
  }
  const fresh = scene.meshes.filter((m) => !before.has(m.uniqueId));
  modelMeshes = fresh;
  unsplitModel = splitForPicking(fresh); // undone at the end of buildCameras()
  const freshIds = new Set(fresh.map((m) => m.uniqueId));
  // True roots: no fresh mesh anywhere in the ancestor chain (intermediate
  // glTF TransformNodes aren't in scene.meshes, so check parents recursively).
  const roots = fresh.filter((m) => {
    for (let p = m.parent; p; p = p.parent) if (freshIds.has(p.uniqueId)) return false;
    return true;
  });

  // Normalize to human scale (~14 m across) when the file uses cm or feet-ish units.
  const { min, max } = boundsOf(roots);
  const horiz = Math.max(max.x - min.x, max.z - min.z);
  window.__scaleDbg = { horiz: +horiz.toFixed(4) };
  if (horiz > 0 && (horiz > 40 || horiz < 5)) {
    const s = 14 / horiz;
    for (const r of roots) r.scaling.scaleInPlace(s);
    window.__scaleDbg.s1 = +s.toFixed(4);
  }

  for (const m of fresh) {
    // Invisible helper geometry (e.g. a fully transparent floor-plan sheet) must not become an invisible wall.
    const hidden = !m.isVisible || m.visibility === 0 || m.material?.alpha === 0;
    // Glass (any see-through material) is walk-through: sliding doors are modelled closed.
    const seeThrough = (m.material?.alpha ?? 1) < 1;
    m.checkCollisions = !hidden && !seeThrough;
    m.isPickable = !hidden;
  }

  // Many files (e.g. a house on a large lot) aren't sized by their footprint, so fine-tune scale
  // from the interior instead: make the most common floor-to-ceiling gap a real ceiling height.
  const storey = measureStoreyHeight(roots);
  window.__scaleDbg.storey = storey ? +storey.toFixed(4) : null;
  if (storey && (storey < CEILING_HEIGHT * 0.8 || storey > CEILING_HEIGHT * 1.25)) {
    const s = CEILING_HEIGHT / storey;
    window.__scaleDbg.s2 = +s.toFixed(4);
    for (const r of roots) r.scaling.scaleInPlace(s);
    for (const m of fresh) m.computeWorldMatrix(true);
  }
  window.__scaleDbg.preCalib = boundsOf(roots).min.asArray().map((n) => +n.toFixed(4));
  const cal = anchorCalibration();
  window.__scaleDbg.cal = +cal.toFixed(5);
  if (Math.abs(cal - 1) > 0.005) {
    for (const r of roots) r.scaling.scaleInPlace(cal);
    for (const m of fresh) m.computeWorldMatrix(true);
  }
  return fresh.length;
}

/**
 * The bundled model's floor-to-ceiling gap is ambiguous (the histogram's top bin is a mid-wall
 * ledge, not the ceiling), so the storey heuristic above can land on two different scales across
 * Babylon versions. anchors.js was verified in the scale where the interior floor sits at
 * y = -0.376 m; nudge the final scale so the floor under the room anchors matches that exactly.
 * Other models (or a re-derived anchors.js) fall through untouched (calibration = 1).
 */
function anchorCalibration() {
  const TARGET = -0.376;
  const pickable = (m) => m.checkCollisions && m.isEnabled() && !m.metadata?.perimeter && m.name !== "surroundings";
  const ys = [];
  for (const a of ROOM_ANCHORS) {
    if (a.pos[1] < 0) continue; // outdoor anchors can't calibrate the interior floor
    const hit = scene.pickWithRay(new B.Ray(new B.Vector3(a.pos[0], 0.5, a.pos[2]), B.Vector3.Down(), 3), pickable);
    if (hit?.hit && hit.pickedPoint.y > -0.45 && hit.pickedPoint.y < -0.25) ys.push(hit.pickedPoint.y);
  }
  if (ys.length < 5) return 1;
  ys.sort((a, b) => a - b);
  const k = TARGET / ys[Math.floor(ys.length / 2)];
  return k > 0.8 && k < 1.25 ? k : 1;
}

/** Most common vertical gap between stacked surfaces (floor→ceiling), or null if the model has no interior. */
function measureStoreyHeight(roots) {
  for (const m of scene.meshes) m.computeWorldMatrix(true);
  const { min, max } = boundsOf(roots);
  const height = max.y - min.y;
  const pickable = (m) => m.checkCollisions && m.isEnabled();
  const gaps = [];
  const N = 24;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = min.x + ((max.x - min.x) * (i + 0.5)) / N;
      const z = min.z + ((max.z - min.z) * (j + 0.5)) / N;
      const hits = scene.multiPickWithRay(new B.Ray(new B.Vector3(x, max.y + 1, z), B.Vector3.Down(), height + 2), pickable) || [];
      const ys = hits.map((h) => h.pickedPoint.y).sort((a, b) => a - b);
      for (let k = 1; k < ys.length; k++) {
        const g = ys[k] - ys[k - 1];
        if (g > height * 0.05) gaps.push(g); // skip slab/sheet thicknesses
      }
    }
  }
  if (gaps.length < 20) return null;
  // Histogram with bins of 5% of model height; the fullest bin is the typical storey.
  const bin = height * 0.05;
  const counts = new Map();
  for (const g of gaps) { const k = Math.round(g / bin); counts.set(k, counts.get(k) || 0); }
  const [bestBin] = [...counts].sort((a, b) => b[1] - a[1])[0];
  const inBin = gaps.filter((g) => Math.round(g / bin) === bestBin).sort((a, b) => a - b);
  return inBin[Math.floor(inBin.length / 2)];
}

/**
 * Keep the eye EYE_HEIGHT above the floor under the camera: glide up onto anything up to
 * STEP_HEIGHT (stairs, rugs, thresholds) and fall with gravity off anything higher.
 * Skipped while goTo() animates, so the flight isn't fought by the ground probe.
 */
function followGround(dt) {
  const p = fpCam.position;
  const from = new B.Vector3(p.x, p.y - EYE_HEIGHT + STEP_HEIGHT, p.z); // knee height: can't see over ledges
  const hit = scene.pickWithRay(new B.Ray(from, B.Vector3.Down(), 100), (m) => m.checkCollisions && m.isEnabled());
  const target = hit?.hit ? hit.pickedPoint.y + EYE_HEIGHT : -Infinity;
  if (target >= p.y - 0.001) {
    p.y += (target - p.y) * Math.min(1, dt * 12); // ease up the step
    fallSpeed = 0;
  } else {
    fallSpeed += GRAVITY * dt;
    p.y = Math.max(target, p.y - fallSpeed * dt);
    if (p.y === target) fallSpeed = 0;
  }
}

/* ------------------------------------------------------------------ input capture */

function lockPointer() {
  const p = canvas.requestPointerLock?.();
  if (p?.catch) p.catch(() => { /* user gesture required / unsupported */ });
}

function capture() {
  if (!ready || captured) return;
  captured = true;
  tourEl.classList.add("captured");
  canvas.focus();
  if (mode === "walk") { fpCam.attachControl(canvas, true); lockPointer(); }
  else arcCam.attachControl(canvas, true);
  updateHud();
}

function release() {
  if (!captured) return;
  captured = false;
  tourEl.classList.remove("captured");
  fpCam?.detachControl();
  arcCam?.detachControl();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  updateHud();
}

function updateHud() {
  crosshairEl.hidden = !(captured && mode === "walk");
  hintEl.hidden = !ready || captured;
  if (!ready) return;
  if (LITE) {
    badgeEl.innerHTML = mode === "walk"
      ? (captured ? "<b>Walk</b> — joystick to move · drag to look" : "<b>Walk</b> — tap the view to start")
      : (captured ? "<b>Dollhouse</b> — drag to orbit · pinch to zoom" : "<b>Dollhouse</b> — tap the view to orbit");
    return;
  }
  badgeEl.innerHTML = mode === "walk"
    ? (captured
      ? "<b>Walk mode</b> — WASD move · mouse look · Shift run · <b>V</b> dollhouse · Esc release"
      : "<b>Walk mode</b> — click the view to take control")
    : (captured
      ? "<b>Dollhouse view</b> — drag orbit · wheel zoom · <b>V</b> back to walk"
      : "<b>Dollhouse view</b> — click the view to orbit · <b>V</b> back to walk");
}

function setMode(next) {
  if (!fpCam || !arcCam || next === mode) return;
  mode = next;
  wake();
  tourEl.classList.toggle("dollhouse", mode === "dollhouse");
  if (mode === "dollhouse") {
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    fpCam.detachControl();
    scene.activeCamera = arcCam;
    if (captured) arcCam.attachControl(canvas, true);
    setActivePill(DOLLHOUSE.id);
  } else {
    arcCam.detachControl();
    scene.activeCamera = fpCam;
    if (captured) { fpCam.attachControl(canvas, true); lockPointer(); }
  }
  updateHud();
}

/* ------------------------------------------------------------------ goTo / anchors */

function animateTo(a, instant) {
  return new Promise((resolve) => {
    const place = () => {
      fpCam.position.set(a.pos[0], a.pos[1], a.pos[2]);
      fpCam.rotation.set(a.pitch, a.yaw, 0);
    };
    if (instant || reduceMotion.matches) { place(); resolve(); return; }
    const p0 = fpCam.position.clone(), r0 = fpCam.rotation.clone();
    const p1 = new B.Vector3(a.pos[0], a.pos[1], a.pos[2]);
    const dyaw = Math.atan2(Math.sin(a.yaw - r0.y), Math.cos(a.yaw - r0.y)); // shortest arc
    const dpitch = a.pitch - r0.x;
    animating = true;
    wake();
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / GO_TO_MS);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // ease-in-out
      B.Vector3.LerpToRef(p0, p1, e, fpCam.position);
      fpCam.rotation.x = r0.x + dpitch * e;
      fpCam.rotation.y = r0.y + dyaw * e;
      if (k < 1) requestAnimationFrame(step);
      else { animating = false; place(); resolve(); }
    };
    requestAnimationFrame(step);
  });
}

function scrollTourIntoView() {
  const r = tourEl.getBoundingClientRect();
  const mostlyVisible = r.top < window.innerHeight * 0.75 && r.bottom > window.innerHeight * 0.25;
  if (!mostlyVisible && !fsActive()) {
    tourEl.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "center" });
  }
}

/** Move the tour to a room anchor (or the dollhouse). Resolves when the camera has arrived. */
async function goTo(id, { instant = false } = {}) {
  await ensureTour();
  if (!scene) return;
  wake();
  const dollhouse = id === DOLLHOUSE.id;
  const anchor = ROOM_ANCHORS.find((a) => a.id === id);
  if (!dollhouse && !anchor) return;
  scrollTourIntoView();
  if (dollhouse) {
    setMode("dollhouse");
  } else {
    setMode("walk");
    await animateTo(anchor, instant);
    setActivePill(anchor.id);
  }
  try { history.replaceState(null, "", `#room=${id}`); } catch { /* exotic sandboxes */ }
}

/* Room dock (index.html #anchorBar): grouped pills in a toolbar under the 3D view.
   One Tab stop for the whole row (roving tabindex; arrows / Home / End move, Enter / Space go),
   Previous / Next step through the viewpoints in order, and the "Now viewing" line is a polite
   live region. On narrow screens and in fullscreen the row scrolls sideways (edge arrows). */
const TOUR_ORDER = [DOLLHOUSE, ...ANCHOR_GROUPS.flatMap((g) => ROOM_ANCHORS.filter((a) => a.group === g))];
const dock = {
  track: byId("dockTrack"), body: byId("dockBody"), toggle: byId("dockToggle"),
  prev: byId("dockPrev"), next: byId("dockNext"), name: byId("dockNowName"), cap: byId("dockNowCap"), count: byId("dockCount"),
};
const DOCK_KEY = "tour.dockCollapsed";
let pillsBuilt = false, activeId = null;

function buildAnchorBar() {
  if (pillsBuilt) return;
  pillsBuilt = true;
  const groups = [[DOLLHOUSE.group, [DOLLHOUSE]], ...ANCHOR_GROUPS.map((g) => [g, TOUR_ORDER.filter((a) => a.group === g)])];
  groups.forEach(([name, items], gi) => {
    const group = document.createElement("div");
    group.className = "pill-set";
    group.setAttribute("role", "group");
    const label = document.createElement("span");
    label.className = "pill-group";
    label.id = `pill-group-${gi}`;
    label.textContent = name;
    group.setAttribute("aria-labelledby", label.id);
    const row = document.createElement("div");
    row.className = "pill-row";
    for (const a of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill";
      b.dataset.anchor = a.id;
      b.tabIndex = -1;
      b.textContent = a.label;
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => goTo(a.id));
      row.append(b);
    }
    group.append(label, row);
    dock.track.append(group);
  });
  dock.track.querySelector(".pill").tabIndex = 0;

  dock.track.addEventListener("keydown", (e) => {
    const pills = [...dock.track.querySelectorAll(".pill")];
    const i = pills.indexOf(document.activeElement);
    if (i < 0) return;
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: pills.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    focusPill(pills[(to + pills.length) % pills.length]);
  });
  dock.track.addEventListener("focusin", (e) => { if (e.target.matches(".pill")) rove(e.target); });

  dock.prev.addEventListener("click", () => step(-1));
  dock.next.addEventListener("click", () => step(1));
  for (const b of anchorBarEl.querySelectorAll(".dock-scroll")) {
    b.addEventListener("click", () => {
      dock.track.scrollBy({ left: Number(b.dataset.dir) * dock.track.clientWidth * 0.7, behavior: smooth() });
    });
  }
  dock.track.addEventListener("scroll", updateScrollEdges, { passive: true });
  // First layout happens only once #tour is .ready, so re-centre the current room whenever the row resizes.
  new ResizeObserver(() => {
    updateScrollEdges();
    const on = dock.track.querySelector('.pill[aria-pressed="true"]');
    if (on) revealPill(on, "auto");
  }).observe(dock.track);

  let collapsed = false;
  try { collapsed = localStorage.getItem(DOCK_KEY) === "1"; } catch { /* storage blocked */ }
  setDockCollapsed(collapsed);
  dock.toggle.addEventListener("click", () => {
    const next = dock.toggle.getAttribute("aria-expanded") === "true";
    setDockCollapsed(next);
    try { localStorage.setItem(DOCK_KEY, next ? "1" : "0"); } catch { /* storage blocked */ }
  });
  setActivePill(activeId || DOLLHOUSE.id);
}

const smooth = () => (reduceMotion.matches ? "auto" : "smooth");

function rove(pill) {
  for (const b of dock.track.querySelectorAll(".pill")) b.tabIndex = b === pill ? 0 : -1;
}

function focusPill(pill) {
  rove(pill);
  pill.focus({ preventScroll: true });
  revealPill(pill);
}

// Scroll the row (never the page) so the pill is fully in view.
function revealPill(pill, behavior = smooth()) {
  const t = dock.track;
  if (t.scrollWidth <= t.clientWidth) return;
  const pad = 64, l = pill.offsetLeft, r = l + pill.offsetWidth; // clear the edge fade + arrow
  if (l - pad < t.scrollLeft) t.scrollTo({ left: l - pad, behavior });
  else if (r + pad > t.scrollLeft + t.clientWidth) t.scrollTo({ left: r + pad - t.clientWidth, behavior });
}

function updateScrollEdges() {
  const t = dock.track, max = t.scrollWidth - t.clientWidth;
  anchorBarEl.classList.toggle("can-left", max > 1 && t.scrollLeft > 1);
  anchorBarEl.classList.toggle("can-right", max > 1 && t.scrollLeft < max - 1);
}

function setDockCollapsed(collapsed) {
  dock.body.hidden = collapsed;
  anchorBarEl.classList.toggle("collapsed", collapsed);
  dock.toggle.setAttribute("aria-expanded", String(!collapsed));
  dock.toggle.querySelector(".dock-btn-text").textContent = collapsed ? "Show rooms" : "Hide rooms";
  if (!collapsed) requestAnimationFrame(() => {
    updateScrollEdges();
    const on = dock.track.querySelector('.pill[aria-pressed="true"]');
    if (on) revealPill(on);
  });
}

function step(dir) {
  const i = Math.max(0, TOUR_ORDER.findIndex((a) => a.id === activeId));
  goTo(TOUR_ORDER[(i + dir + TOUR_ORDER.length) % TOUR_ORDER.length].id);
}

function setActivePill(id) {
  activeId = id;
  if (!pillsBuilt) return;
  let on = null;
  for (const b of dock.track.querySelectorAll(".pill")) {
    const hit = b.dataset.anchor === id;
    b.setAttribute("aria-pressed", String(hit));
    if (hit) on = b;
  }
  const i = TOUR_ORDER.findIndex((a) => a.id === id);
  const a = TOUR_ORDER[i];
  if (!a) return;
  dock.name.textContent = a.label;
  dock.cap.textContent = a.id === DOLLHOUSE.id ? "Orbit the whole house" : a.caption;
  dock.count.textContent = `${i + 1} / ${TOUR_ORDER.length}`;
  const n = TOUR_ORDER.length, prev = TOUR_ORDER[(i - 1 + n) % n], next = TOUR_ORDER[(i + 1) % n];
  dock.prev.setAttribute("aria-label", `Previous room: ${prev.label}`);
  dock.next.setAttribute("aria-label", `Next room: ${next.label}`);
  dock.prev.title = `Previous: ${prev.label}`;
  dock.next.title = `Next: ${next.label}`;
  // Keep the single Tab stop on the current room, unless focus is already moving around the row.
  if (on && !dock.track.contains(document.activeElement)) rove(on);
  if (on && !dock.body.hidden) revealPill(on);
}

// Nice-to-have: highlight the pill of the room the walker is standing in.
let lastAnchorAt = 0, lastAnchorId = null;
function trackNearbyAnchor() {
  if (mode !== "walk" || !fpCam) return;
  const now = performance.now();
  if (now - lastAnchorAt < 250) return;
  lastAnchorAt = now;
  let best = null, bd = ROOM_RADIUS;
  for (const a of ROOM_ANCHORS) {
    const d = Math.hypot(fpCam.position.x - a.pos[0], fpCam.position.z - a.pos[2]);
    if (d < bd) { bd = d; best = a.id; }
  }
  if (best && best !== lastAnchorId) { lastAnchorId = best; setActivePill(best); }
}

/* ------------------------------------------------------------------ fullscreen */

function fsActive() {
  return document.fullscreenElement === tourEl || document.webkitFullscreenElement === tourEl || pseudoFs;
}

function enterFullscreen() {
  if (fsActive()) return;
  try {
    if (tourEl.requestFullscreen) tourEl.requestFullscreen().catch(() => setPseudoFs(true));
    else if (tourEl.webkitRequestFullscreen) tourEl.webkitRequestFullscreen();
    else setPseudoFs(true); // iOS Safari: no element fullscreen
  } catch {
    setPseudoFs(true);
  }
}

function exitFullscreen() {
  if (pseudoFs) { setPseudoFs(false); return; }
  try {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch { /* already out */ }
}

function setPseudoFs(on) {
  pseudoFs = on;
  tourEl.classList.toggle("pseudo-fullscreen", on);
  document.body.classList.toggle("fs-lock", on);
  onFsChange();
}

function onFsChange() {
  resizeEngine();
  const on = fsActive();
  tourEl.classList.toggle("is-fullscreen", on);
  if (fsLabelEl) fsLabelEl.textContent = on ? "Exit fullscreen" : "Fullscreen";
}

/* ------------------------------------------------------------------ wiring + public API */

/* Touch screens have no WASD: a thumb joystick in the corner walks (fpCam.inputs.checkInputs
   reads joy), and a one-finger drag elsewhere on the view looks around (Babylon's mouse input). */
const joy = window.__joy = { active: false, x: 0, y: 0 }; // also a debug/QA handle
function wireJoystick() {
  const pad = byId("joystick"), knob = pad.querySelector(".joy-knob");
  let id = null;
  const move = (e) => {
    const r = pad.getBoundingClientRect(), R = r.width / 2;
    let dx = e.clientX - (r.left + R), dy = e.clientY - (r.top + R);
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    joy.x = dx / R; joy.y = dy / R;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    joy.active = false; joy.x = joy.y = 0;
    knob.style.transform = "";
  };
  pad.addEventListener("pointerdown", (e) => {
    if (id !== null) return;
    e.preventDefault();
    id = e.pointerId;
    joy.active = true;
    // Keeps the drag when the thumb slides off the pad; can throw for touch pointers (seen in Chrome).
    try { pad.setPointerCapture(id); } catch { /* the pad still gets moves while the thumb is on it */ }
    move(e);
    wake();
  });
  pad.addEventListener("pointermove", (e) => { if (e.pointerId === id) move(e); });
  pad.addEventListener("pointerup", end);
  pad.addEventListener("pointercancel", end);
}

function wireTour() {
  if (LITE) {
    tourEl.classList.add("touch");
    hintEl.textContent = "Tap the view to take control";
    wireJoystick();
  }
  byId("startBtn").addEventListener("click", () => ensureTour());
  byId("retryBtn")?.addEventListener("click", () => location.reload());
  fsBtnEl.addEventListener("click", () => (fsActive() ? exitFullscreen() : enterFullscreen()));
  canvas.addEventListener("click", () => { if (ready) capture(); });
  canvas.addEventListener("keydown", (e) => {
    if (e.code === "KeyV" && !e.repeat && ready) setMode(mode === "walk" ? "dollhouse" : "walk");
    if (e.key === "Shift") jogging = true;
    if (e.key === "Escape") release();
  });
  canvas.addEventListener("keyup", (e) => { if (e.key === "Shift") jogging = false; });
  document.addEventListener("pointerlockchange", () => {
    if (captured && mode === "walk" && document.pointerLockElement !== canvas) release();
  });
  document.addEventListener("pointerdown", (e) => {
    if (captured && !tourEl.contains(e.target)) release();
  });
  document.addEventListener("keydown", (e) => {
    if (pseudoFs && e.key === "Escape") { e.preventDefault(); exitFullscreen(); }
  });
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  window.addEventListener("resize", resizeEngine);
  new ResizeObserver(resizeEngine).observe(canvas); // the dock under the view can change the canvas size on its own

  // Frame scheduling (see "frame scheduling"): render only while #tour is on screen, and wake
  // the loop on any input — Babylon applies camera input inside scene.render().
  new IntersectionObserver(([en]) => {
    onScreen = en.isIntersecting;
    if (onScreen) wake(); else sleep();
  }).observe(tourEl);
  document.addEventListener("visibilitychange", () => (document.hidden ? sleep() : wake()));
  for (const type of ["pointerdown", "pointerup", "keydown", "keyup"]) {
    tourEl.addEventListener(type, () => wake(), { passive: true });
  }
  // Mouse look / orbit / zoom only reach the cameras while captured; hovering alone changes nothing.
  for (const type of ["pointermove", "wheel"]) {
    tourEl.addEventListener(type, () => { if (captured) wake(); }, { passive: true });
  }
}

// Public API used by the page UI, gallery cards, floor plan and the QA tests.
window.tour = {
  goTo,
  enterFullscreen,
  exitFullscreen,
  // Plain snapshot (serialisable for tests); null until the tour has loaded.
  getCamera: () => {
    const c = scene?.activeCamera;
    if (!c) return null;
    return { mode, pos: c.position.asArray(), yaw: c.rotation?.y ?? null, pitch: c.rotation?.x ?? null, fullscreen: fsActive() };
  },
  isReady: () => ready,
  whenReady: () => ensureTour(),
  __dbg: () => ({ spawn: spawnPoint?.asArray(), surY: scene?.getMeshByName("surroundings")?.position.y, cam: fpCam?.position.asArray(),
    sched: { onScreen, looping, awakeMs: Math.round(wakeUntil - performance.now()), readyChecked, fast } }),
};

wireTour();
// Deep link on load: start loading right away so #room=<id> works even before the section scrolls in.
if (/^#room=[\w-]+$/.test(location.hash || "")) ensureTour();
