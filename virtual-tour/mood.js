// The tour's look: a dark villa in an alpine pine forest on a sunny day — clear HDRI sky and
// image-based light with a warm sun matched to the sky's sun disc, 3D mountain ranges (painted
// ridgelines until they stream in) in light valley haze, a filmic grade, dark bronze facade, dry
// pavers, and warm light glowing inside.
// main.js calls these in order: setupAtmosphere → (model loads) → restyleModel → tunePost;
// addDistantMountains streams in after the tour is ready.
import { Vector3, Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/core/Meshes/instancedMesh.js"; // side effect: enables mesh.createInstance()
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture.js";
import { ColorCurves } from "@babylonjs/core/Materials/colorCurves.js";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration.js";
import { PointLight } from "@babylonjs/core/Lights/pointLight.js";

const ENV_URL = "/assets/env/kloofendal_48d_partly_cloudy_puresky_2k.hdr";
const TEX = "/assets/tex/";
export const FOG = "#b8c4cf";   // light valley haze; also the clear colour, so the far ground melts into the sky
const FOG_DENSITY = 0.0032;     // exp2: ~97% visible at 50 m, ~88% at 110 m
const SKY_LEVEL = 1.0;          // skybox brightness (the shared HDR's level)
// The key light comes from the sky's sun disc: 47.9° elevation (brightest texel of the HDR) and,
// with the sky unrotated, yaw 26.5° (0 = +z, toward +x; measured from a render). That lights the
// house front from behind-left of the opening Exterior view.
const SUN_ELEVATION = 47.9 * Math.PI / 180;
const SUN_YAW = 26.5 * Math.PI / 180;
const HDR_ROTATION = 0;
const WARM = new Color3(1.0, 0.64, 0.34); // ~2700 K lamp light

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ sky, light, fog, grade */

/**
 * Sunny HDRI as both skybox and image-based lighting, a ring of mountains in front of it, a warm
 * key light aimed from the sky's sun, light exp2 haze and a filmic grade. `fallbackSky` (the old gradient dome)
 * stays visible until the HDR has loaded, and for good if it fails.
 */
export function setupAtmosphere(scene, { hemi, sun, fallbackSky, envSize = 512 }) {
  const fog = Color3.FromHexString(FOG);
  scene.clearColor = Color4.FromColor3(fog, 1);
  scene.fogMode = 2; // Scene.FOGMODE_EXP2
  scene.fogDensity = FOG_DENSITY;
  scene.fogColor = fog;

  // Sunny: a strong warm key from the sky's sun disc gives crisp shadows; the blue sky dome (IBL)
  // and a little hemispheric light fill them.
  hemi.intensity = 0.3;
  hemi.diffuse = new Color3(0.82, 0.88, 1.0);
  hemi.groundColor = new Color3(0.3, 0.28, 0.22);
  hemi.specular = Color3.Black();
  const ch = Math.cos(SUN_ELEVATION); // light travels away from the sun
  sun.direction = new Vector3(-Math.sin(SUN_YAW) * ch, -Math.sin(SUN_ELEVATION), -Math.cos(SUN_YAW) * ch);
  sun.intensity = 3.2;
  sun.diffuse = new Color3(1.0, 0.95, 0.86);
  scene.ambientColor = new Color3(0.2, 0.2, 0.2);

  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = 1.0;
  ip.contrast = 1.12;
  ip.colorCurvesEnabled = true;
  const curves = new ColorCurves();
  curves.globalSaturation = 8;       // clear-day colour
  curves.shadowsHue = 215;           // slightly cool, sky-filled shadows…
  curves.shadowsDensity = 12;
  curves.shadowsSaturation = 12;
  curves.highlightsHue = 40;         // …warm sunlit highlights
  curves.highlightsDensity = 10;
  curves.highlightsSaturation = 10;
  ip.colorCurves = curves;
  ip.vignetteEnabled = true;
  ip.vignetteWeight = 1.2;
  ip.vignetteStretch = 0.4;
  ip.vignetteColor = new Color4(0.04, 0.05, 0.06, 0);
  ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;

  // --- HDRI sky + IBL ---------------------------------------------------------------------------
  const skybox = CreateBox("skyBox", { size: 1600 }, scene);
  skybox.infiniteDistance = true;
  skybox.isPickable = false;
  skybox.applyFog = false;
  skybox.setEnabled(false);
  const skyMat = new StandardMaterial("skyBoxMat", scene);
  skyMat.backFaceCulling = false;
  skyMat.disableLighting = true;
  skyMat.fogEnabled = false;
  skybox.material = skyMat;
  const hdr = new HDRCubeTexture(ENV_URL, scene, envSize, false, true, false, true, () => {
    skyMat.reflectionTexture = hdr;
    skyMat.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
    skyMat.reflectionTexture.level = SKY_LEVEL;
    skybox.setEnabled(true);
    fallbackSky?.setEnabled(false);
  }, (msg) => console.warn("HDR sky failed, keeping gradient sky:", msg));
  hdr.rotationY = HDR_ROTATION; // SUN_YAW was measured at this rotation; change both together
  scene.environmentTexture = hdr;
  scene.environmentIntensity = 1 / SKY_LEVEL; // the skybox dims the shared HDR (level); keep IBL at full strength

  // The orbit (dollhouse) camera sits ~60 m out: walking-distance haze would veil the house.
  scene.onBeforeRenderObservable.add(() => {
    scene.fogDensity = scene.activeCamera?.getClassName() === "ArcRotateCamera" ? FOG_DENSITY * 0.35 : FOG_DENSITY;
  });

  buildMountains(scene, fog);
  buildMistRing(scene, fog);
  return { skybox, hdr };
}

/** Periodic 1-D value noise in [0, 1) → [0, 1]; `ridged` folds each octave into sharp crests. */
function noise1(r, octaves, ridged = false) {
  const layers = [];
  for (let o = 0; o < octaves; o++) {
    const k = 6 << o; // control points in this octave (periodic, so the ring has no seam)
    layers.push({ k, pts: Array.from({ length: k }, () => r()), amp: Math.pow(0.55, o) });
  }
  return (x) => {
    let v = 0, norm = 0;
    for (const { k, pts, amp } of layers) {
      const f = ((x % 1) + 1) % 1 * k, i = Math.floor(f), t = f - i;
      const a = pts[i % k], b = pts[(i + 1) % k];
      let n = a + (b - a) * t * t * (3 - 2 * t);
      if (ridged) n = Math.pow(1 - Math.abs(2 * n - 1), 2);
      v += n * amp; norm += amp;
    }
    return v / norm;
  };
}

/** Mountain profile in [0, 1]: a few distinct massifs (smooth bumps) carved by ridged detail. */
function massifs(r, count, detailOctaves) {
  const peaks = Array.from({ length: count }, () => ({ c: r(), w: 0.025 + r() * 0.06, h: 0.45 + r() * 0.55 }));
  const detail = noise1(r, detailOctaves, true);
  const wobble = noise1(r, 3);
  return (x) => {
    let env = 0;
    for (const p of peaks) {
      let d = Math.abs(x - p.c); d = Math.min(d, 1 - d); // wrap around the ring
      env = Math.max(env, p.h * Math.exp(-Math.pow(d / p.w, 1.4)));
    }
    env = Math.max(env, 0.06 + wobble(x) * 0.26); // lower, rolling ranges between the massifs
    return env * (0.62 + 0.38 * detail(x));
  };
}

const RING_R = 700, RING_H = 420, RING_TOP = 360; // metres, relative to the eye (the ring follows the camera)

/**
 * A cylinder of painted mountain silhouettes around the horizon: four ridgelines, the farthest
 * snow-capped and palest, each dissolving into mist at its foot. Follows the camera (infinite
 * distance), unlit. Everything here is painted once at load; nothing runs per frame.
 */
function buildMountains(scene, fog) {
  const W = 4096, H = 512;
  const tex = new DynamicTexture("mountainsTex", { width: W, height: H }, scene, true);
  const ctx = tex.getContext();
  ctx.clearRect(0, 0, W, H);
  const r = rng(424242);
  const f = (c, k) => Math.round(c * 255 * k);
  const rgb = (c, k, a = 1) => `rgba(${f(c.r, k)},${f(c.g, k)},${f(c.b, k)},${a})`;
  // Canvas rows map onto the ring: row 0 = ring top (~27° above the eye), HORIZON = eye level.
  // base/amp are canvas fractions: a ridge sits between `base` (valley) and `base - amp` (peak).
  const HORIZON = RING_TOP / RING_H;
  // Far → near: paler and bluer with distance (aerial perspective); the snow line drops out
  // before the forested foothills.
  const layers = [
    { base: 0.8, amp: 0.74, peaks: 8, tone: new Color3(0.7, 0.73, 0.77), rock: 0.08, snow: 0.62 },
    { base: 0.8, amp: 0.55, peaks: 7, tone: new Color3(0.56, 0.58, 0.62), rock: 0.14, snow: 0.46 },
    { base: 0.82, amp: 0.34, peaks: 6, tone: new Color3(0.44, 0.46, 0.46), rock: 0.18, snow: 0.22 },
    { base: 0.84, amp: 0.18, peaks: 5, tone: new Color3(0.31, 0.33, 0.31), rock: 0.22, snow: 0 },
  ];
  const SNOW = new Color3(0.93, 0.95, 0.98);
  for (const L of layers) {
    const h = massifs(r, L.peaks, 6);
    const yAt = (x) => H * (L.base - h(x / W) * L.amp);
    const breakup = noise1(r, 3); // periodic, so the snow line wobbles without a seam
    const patches = noise1(r, 4);
    // One column per texel: shade by slope (light from the left) so faces and gullies read as rock,
    // fading from the ridge colour down into mist at the horizon.
    for (let x = 0; x < W; x++) {
      const y0 = yAt(x);
      const slope = (yAt(x + 14) - yAt(x - 14)) / 28; // >0: ridge falls to the right (lit face)
      const shade = 1 + Math.max(-0.16, Math.min(0.16, slope * 0.5));
      const g = ctx.createLinearGradient(0, y0, 0, H * HORIZON);
      g.addColorStop(0, rgb(L.tone, shade * 1.06));
      g.addColorStop(0.18, rgb(L.tone, 1 + (shade - 1) * 0.3));
      g.addColorStop(0.5, rgb(L.tone, 1.04));
      g.addColorStop(1, rgb(fog, 1));
      ctx.fillStyle = g;
      ctx.fillRect(x, y0, 1, H - y0);
      ctx.fillStyle = rgb(L.tone, shade * 1.3, 0.5); // crisp crest line against the sky
      ctx.fillRect(x, y0, 1, 1);
      // Snow caps: patchy, only on the highest crests, thinner where the face is steep.
      if (L.snow) {
        const crest = (L.base - y0 / H) / L.amp; // 0..1 ridge height at this column
        const cover = Math.min(1, Math.max(0, (crest - L.snow) / 0.18)) * (1 - Math.min(1, Math.abs(slope) * 2.2)) * (0.55 + 0.45 * patches(x / W));
        const depth = cover * (4 + 14 * breakup(x / W));
        if (cover > 0.02 && depth > 0.5) {
          const sg = ctx.createLinearGradient(0, y0, 0, y0 + depth);
          sg.addColorStop(0, rgb(SNOW, shade * 1.02, 0.85));
          sg.addColorStop(1, rgb(SNOW, shade, 0));
          ctx.fillStyle = sg;
          ctx.fillRect(x, y0, 1, depth);
        }
      }
    }
    // Gullies: dark strokes running down-slope from the crest, longer where it is steeper.
    for (let i = 0; i < 900 + Math.round(L.rock * 4000); i++) {
      const x = r() * W, top = yAt(x), s = (yAt(x + 14) - yAt(x - 14)) / 28;
      const len = Math.min(34, (6 + r() * 26) * (0.5 + Math.min(1.5, Math.abs(s) * 4)));
      const y = top + r() * (H * HORIZON - top) * 0.55;
      ctx.strokeStyle = `rgba(18,22,24,${L.rock * r()})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x - s * len * 0.4, y + len * 0.6, x - s * len, y + len);
      ctx.stroke();
    }
    // Scree: pale fans below the steepest sections.
    for (let i = 0; i < 260; i++) {
      const x = r() * W, top = yAt(x), s = (yAt(x + 14) - yAt(x - 14)) / 28;
      if (Math.abs(s) < 0.08) continue;
      const y = top + (H * HORIZON - top) * (0.35 + r() * 0.4), w = 6 + r() * 22;
      ctx.fillStyle = rgb(L.tone, 1.16, 0.1 + r() * 0.1);
      ctx.beginPath(); ctx.moveTo(x, y - w * 0.9); ctx.lineTo(x - w * 0.5, y); ctx.lineTo(x + w * 0.5, y); ctx.closePath(); ctx.fill();
    }
    // Valley mist: a soft band at this ridge's foot, so the next range reads as farther away.
    const mb = ctx.createLinearGradient(0, H * (HORIZON - 0.16), 0, H * HORIZON);
    mb.addColorStop(0, rgb(fog, 1.05, 0));
    mb.addColorStop(1, rgb(fog, 1.05, 0.2));
    ctx.fillStyle = mb;
    ctx.fillRect(0, H * (HORIZON - 0.16), W, H * 0.16);
  }
  // Low cloud banks drifting across the slopes.
  for (let i = 0; i < 90; i++) {
    const x = r() * W, y = H * (0.3 + r() * (HORIZON - 0.3)), rx = 80 + r() * 260, ry = 10 + r() * 26;
    const cg = ctx.createRadialGradient(x, y, 0, x, y, rx);
    cg.addColorStop(0, rgb(fog, 1.08, 0.35 + r() * 0.3));
    cg.addColorStop(1, rgb(fog, 1.08, 0));
    ctx.fillStyle = cg;
    ctx.save(); ctx.translate(x, y); ctx.scale(1, ry / rx); ctx.translate(-x, -y);
    ctx.beginPath(); ctx.arc(x, y, rx, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  tex.hasAlpha = true;
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.uScale = 2; // two distinct 180° panoramas would repeat visibly; 2 laps of a 4k strip read fine in fog

  const mat = new StandardMaterial("mountainsMat", scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.useAlphaFromDiffuseTexture = true;
  mat.disableLighting = true;
  mat.fogEnabled = false;
  mat.backFaceCulling = false;
  const ring = CreateCylinder("mountains", { height: RING_H, diameter: 2 * RING_R, tessellation: 96, cap: Mesh.NO_CAP, sideOrientation: Mesh.DOUBLESIDE }, scene);
  ring.material = mat;
  ring.position.y = RING_TOP - RING_H / 2; // top ~27° above the eye; the foot sinks below the horizon
  ring.infiniteDistance = true;
  ring.isPickable = false;
  ring.applyFog = false;
  ring.alphaIndex = 0; // draw before other blended meshes
  return ring;
}

const MIST_R = 640, MIST_H = 150, MIST_TOP = 95; // just inside the mountain ring, straddling the horizon

/**
 * Drifting valley mist: a nearer ring of soft blobs between the ridgelines and the trees. Painted
 * once; the drift is a texture u-offset per frame, so a settled view costs nothing extra.
 */
function buildMistRing(scene, fog) {
  const W = 2048, H = 256;
  const tex = new DynamicTexture("mountainsMistTex", { width: W, height: H }, scene, true);
  const ctx = tex.getContext();
  ctx.clearRect(0, 0, W, H);
  const r = rng(9182);
  const f = (c, k) => Math.round(c * 255 * k);
  const mist = (a) => `rgba(${f(fog.r, 1.06)},${f(fog.g, 1.06)},${f(fog.b, 1.06)},${a})`;
  for (let i = 0; i < 90; i++) {
    const x = r() * W, y = H * (0.3 + r() * 0.45), rx = 90 + r() * 300, ry = 12 + r() * 30;
    const a = 0.03 + r() * 0.06; // thin: a sunny valley haze, not rain mist
    for (const dx of [-W, 0, W]) { // wrap copies keep the scroll seamless
      const g = ctx.createRadialGradient(x + dx, y, 0, x + dx, y, rx);
      g.addColorStop(0, mist(a));
      g.addColorStop(1, mist(0));
      ctx.fillStyle = g;
      ctx.save(); ctx.translate(x + dx, y); ctx.scale(1, ry / rx); ctx.translate(-(x + dx), -y);
      ctx.beginPath(); ctx.arc(x + dx, y, rx, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
  // Fade the band's top and bottom edges so it never reads as a stripe.
  ctx.globalCompositeOperation = "destination-in";
  const v = ctx.createLinearGradient(0, 0, 0, H);
  v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(0.35, "rgba(0,0,0,1)");
  v.addColorStop(0.75, "rgba(0,0,0,1)"); v.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "source-over";
  tex.hasAlpha = true;
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;

  const mat = new StandardMaterial("mountainsMistMat", scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.useAlphaFromDiffuseTexture = true;
  mat.disableLighting = true;
  mat.fogEnabled = false;
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true; // blended haze: ordering comes from alphaIndex, not the depth buffer
  const ring = CreateCylinder("mountainsMist", { height: MIST_H, diameter: 2 * MIST_R, tessellation: 72, cap: Mesh.NO_CAP, sideOrientation: Mesh.DOUBLESIDE }, scene);
  ring.material = mat;
  ring.position.y = MIST_TOP - MIST_H / 2;
  ring.infiniteDistance = true;
  ring.isPickable = false;
  ring.applyFog = false;
  ring.alphaIndex = 1; // after the mountain ring
  if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    scene.onBeforeRenderObservable.add(() => { tex.uOffset = (performance.now() * 0.000006) % 1; }); // one lap ≈ 2.8 min
  }
  return ring;
}

// Two rings of the modelled mountain around the horizon (metres, relative to the eye like the
// painted ring they replace): lower foothills in front, taller snowy ranges behind, both beyond
// the mist ring (MIST_R) so the drifting mist still passes in front of them.
const PEAK_RINGS = [
  { r: 1450, count: 10, width: [1.4, 1.8], height: [1.6, 2.1], haze: 0.42, seed: 5151 },
  { r: 960, count: 9, width: [0.85, 1.1], height: [0.8, 1.1], haze: 0.28, seed: 6262 },
];
const PEAK_SINK = 40;                                  // bases sit below the horizon, hidden by the haze band
const HAZE_R = 700, HAZE_H = 130, HAZE_TOP = 85;       // between the mist ring and the nearest peaks

/**
 * Real 3D mountains on the horizon ("Mountain low poly For distant mountains" by adventurer,
 * CC BY 4.0; models/props/). One 5k-triangle heightfield, instanced around two rings with random
 * width, height and facing. Unfogged (the scene's exp2 mist would erase anything this far):
 * each ring instead fades toward the fog colour by its own `haze`, and a gradient band melts the
 * bases into the horizon. Replaces the painted ridgeline ring once loaded; that stays up if this fails.
 */
export async function addDistantMountains(scene, url = "/models/props/mountain_low_poly_for_distant_mountains.glb") {
  const res = await ImportMeshAsync(url, scene);
  const src = res.meshes.find((m) => m.getTotalVertices() > 0);
  const tpl = src.clone("peakTpl", null, true);
  tpl.makeGeometryUnique();
  tpl.parent = null;
  tpl.position.setAll(0); tpl.rotationQuaternion = null; tpl.rotation.setAll(0); tpl.scaling.setAll(1);
  tpl.bakeTransformIntoVertices(src.computeWorldMatrix(true)); // Sketchfab's Z-up root → Y-up
  for (const m of res.meshes) m.dispose(false, false);
  for (const n of res.transformNodes) n.dispose();
  tpl.refreshBoundingInfo();
  let bb = tpl.getBoundingInfo().boundingBox;
  tpl.bakeTransformIntoVertices(Matrix.Translation(-(bb.minimum.x + bb.maximum.x) / 2, -bb.minimum.y, -(bb.minimum.z + bb.maximum.z) / 2));
  tpl.refreshBoundingInfo();
  bb = tpl.getBoundingInfo().boundingBox;
  const alongZ = bb.maximum.z - bb.minimum.z > bb.maximum.x - bb.minimum.x; // long side faces the viewer
  tpl.isVisible = false;
  tpl.isPickable = false;
  tpl.checkCollisions = false;

  // Matte, cool rock: the export's 0.63 metallic reads as chrome under the overcast IBL.
  const fog = scene.fogColor;
  const base = tpl.material;
  base.metallic = 0;
  base.roughness = 1;
  base.metallicF0Factor = 0.2;
  base.fogEnabled = false;
  base.backFaceCulling = true;

  const out = [];
  for (const ring of PEAK_RINGS) {
    // Aerial perspective without fog: lit colour × (1 − haze) + fog × haze.
    const mat = base.clone(`peakMat${ring.seed}`);
    mat.albedoColor = new Color3(0.86, 0.92, 1).scale(1 - ring.haze); // cooler with distance
    mat.environmentIntensity = 1 - ring.haze * 0.5;
    mat.emissiveColor = fog.scale(ring.haze);
    const pmesh = tpl.clone(`peakTpl${ring.seed}`, null, true);
    pmesh.material = mat;
    pmesh.isVisible = false;
    const r = rng(ring.seed);
    const lerp = ([a, b], t) => a + (b - a) * t;
    for (let i = 0; i < ring.count; i++) {
      const a = ((i + 0.3 + r() * 0.4) / ring.count) * Math.PI * 2;
      const d = ring.r * (0.94 + r() * 0.12);
      const inst = pmesh.createInstance(`peak${ring.seed}_${i}`);
      const w = lerp(ring.width, r());
      inst.scaling.set(w, lerp(ring.height, r()), w);
      // Long axis along the ring's tangent; flip half of them so the same face doesn't repeat.
      inst.rotation.y = a + (alongZ ? Math.PI / 2 : 0) + (r() < 0.5 ? Math.PI : 0);
      inst.position.set(Math.sin(a) * d, -PEAK_SINK, Math.cos(a) * d);
      inst.infiniteDistance = true;
      inst.isPickable = false;
      inst.applyFog = false;
      out.push(inst);
    }
  }
  tpl.dispose(false, false);

  // Haze band: fog colour at the horizon fading out upward, in front of every mountain base.
  const H = 256;
  const tex = new DynamicTexture("peakHazeTex", { width: 4, height: H }, scene, false);
  const ctx = tex.getContext();
  const f = (c) => Math.round(c * 255 * 1.02);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  const horizon = HAZE_TOP / HAZE_H; // eye level, as a fraction down the band
  g.addColorStop(0, `rgba(${f(fog.r)},${f(fog.g)},${f(fog.b)},0)`);
  g.addColorStop(horizon * 0.55, `rgba(${f(fog.r)},${f(fog.g)},${f(fog.b)},0.35)`);
  g.addColorStop(horizon, `rgba(${f(fog.r)},${f(fog.g)},${f(fog.b)},1)`);
  g.addColorStop(1, `rgba(${f(fog.r)},${f(fog.g)},${f(fog.b)},1)`);
  ctx.clearRect(0, 0, 4, H);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, H);
  tex.hasAlpha = true;
  tex.update();
  const hmat = new StandardMaterial("peakHazeMat", scene);
  hmat.diffuseTexture = tex;
  hmat.emissiveTexture = tex;
  hmat.useAlphaFromDiffuseTexture = true;
  hmat.disableLighting = true;
  hmat.fogEnabled = false;
  hmat.backFaceCulling = false;
  hmat.disableDepthWrite = true;
  const haze = CreateCylinder("peakHaze", { height: HAZE_H, diameter: 2 * HAZE_R, tessellation: 72, cap: Mesh.NO_CAP, sideOrientation: Mesh.DOUBLESIDE }, scene);
  haze.material = hmat;
  haze.position.y = HAZE_TOP - HAZE_H / 2;
  haze.infiniteDistance = true;
  haze.isPickable = false;
  haze.applyFog = false;
  haze.alphaIndex = 0; // the painted ring's slot: before the mist ring

  scene.getMeshByName("mountains")?.setEnabled(false);
  return { peaks: out.length };
}

/* ------------------------------------------------------------------ model materials */

const MAT = {
  // vertical timber battens → dark bronze-charcoal battens (texture kept for the rhythm and grain)
  cladding: /^Timber_Cladding/,
  frame: /^Paint_-_Anthracite$|^Metal_-_Iron|^Metal_-_Stainless_Steel$/,
  roof: /^Roof_-_Corrugated/,
  glass: /^Glass_-_(Clear_Fast|Blue)$/,
  lamp: /^Glass_-_Lamp$/,
  slab: /^ED_CONCRETE$/,
  land: /^Land_Texture$|^GDLM55_mlambert3SG$/,
};

/** Metres covered by one repeat of `tex` on `mesh` (from its UV span), like main.js findModelGrass. */
function uvMetres(mesh) {
  const b = mesh.getBoundingInfo().boundingBox;
  const sizeX = b.maximumWorld.x - b.minimumWorld.x;
  const uv = mesh.getVerticesData("uv");
  let u0 = Infinity, u1 = -Infinity;
  for (let i = 0; uv && i < uv.length; i += 2) { u0 = Math.min(u0, uv[i]); u1 = Math.max(u1, uv[i]); }
  return uv ? sizeX / Math.max(u1 - u0, 1e-3) : sizeX;
}

/** PBR maps from assets/tex/<name>_{diff,nor_gl,rough}_1k.jpg, tiled so one repeat = `metres`. */
export function pbrSurface(scene, name, { metres, uvMetresPerUnit = 1, tone = 0.85, roughness = 0.9 }) {
  const m = new PBRMaterial(name + "Mat", scene);
  const rep = uvMetresPerUnit / metres;
  const t = (suffix) => {
    const tx = new Texture(`${TEX}${name}_${suffix}_1k.jpg`, scene);
    tx.uScale = tx.vScale = rep;
    tx.anisotropicFilteringLevel = 8;
    return tx;
  };
  m.albedoTexture = t("diff");
  m.albedoColor = new Color3(tone, tone, tone);
  m.bumpTexture = t("nor_gl");
  m.bumpTexture.level = 0.8;
  m.metallicTexture = t("rough");
  m.useRoughnessFromMetallicTextureGreen = true;  // greyscale map: G = roughness
  m.useMetallnessFromMetallicTextureBlue = false;
  m.useAmbientOcclusionFromMetallicTextureRed = false;
  m.metallic = 0;
  m.roughness = roughness; // multiplies the map
  m.environmentIntensity = 1;
  return m;
}

/**
 * Re-skin the loaded model (by glTF material name) and add warm interior lights.
 * @param anchors ROOM_ANCHORS — interior lights sit under the ceiling near the main rooms
 */
export function restyleModel(scene, { modelMeshes, anchors }) {
  const seen = new Set();
  for (const mesh of modelMeshes) {
    const mat = mesh.material;
    if (!mat || seen.has(mat) || !(mat instanceof PBRMaterial)) continue;
    seen.add(mat);
    mat.maxSimultaneousLights = 8; // sun + hemi + interior lights
    const n = mat.name;
    if (MAT.cladding.test(n)) {
      // The source texture is orange timber; a cool tint neutralises it to charcoal-bronze while
      // the batten rhythm and grain still show through.
      mat.albedoColor = new Color3(0.13, 0.155, 0.19);
      mat.metallic = 0.5;
      mat.roughness = 0.45;
    } else if (MAT.frame.test(n)) {
      // Satin dark bronze. Kept mostly dielectric with dimmed IBL: as a mirror metal the soffit
      // (same material) would reflect the bright lower hemisphere of the sky and glow white.
      mat.albedoColor = new Color3(0.1, 0.09, 0.08);
      mat.albedoTexture = null;
      mat.metallic = 0.15;
      mat.roughness = 0.65;
      mat.environmentIntensity = 0.12;
    } else if (MAT.roof.test(n)) {
      mat.albedoColor = new Color3(0.22, 0.21, 0.2);
      mat.metallic = 0.6;
      mat.roughness = 0.4;
    } else if (MAT.glass.test(n)) {
      // Clear, reflective glazing: mostly see-through, but the sky/trees reflect at grazing angles.
      mat.albedoColor = new Color3(0.02, 0.025, 0.03);
      mat.alpha = 0.16;
      mat.metallic = 0;
      mat.roughness = 0.03;
      mat.indexOfRefraction = 1.52;
      mat.useRadianceOverAlpha = true;
      mat.useSpecularOverAlpha = true;
      mat.environmentIntensity = 1.3;
    } else if (MAT.lamp.test(n)) {
      mat.emissiveColor = WARM;
      mat.emissiveIntensity = 4;
    } else if (MAT.slab.test(n)) {
      const pave = pbrSurface(scene, "brick_pavement_02", { metres: 2, uvMetresPerUnit: uvMetres(mesh), tone: 0.85, roughness: 0.9 });
      pave.maxSimultaneousLights = 8;
      for (const m of modelMeshes) if (m.material === mat) m.material = pave;
    } else if (MAT.land.test(n)) {
      mat.albedoColor = new Color3(0.5, 0.62, 0.42); // sunlit earth and grass, matched to the meadow
      mat.roughness = 1;
      mat.environmentIntensity = 0.6; // grazing-angle sky reflection made the lot read as pale concrete
    }
  }

  // Warm interior light: a lamp near the ceiling of the main rooms and one under the carport.
  const lights = [];
  const at = (id, dy, intensity, range) => {
    const a = anchors.find((x) => x.id === id);
    if (!a) return;
    const l = new PointLight(`warm-${id}`, new Vector3(a.pos[0], a.pos[1] + dy, a.pos[2]), scene);
    l.diffuse = WARM;
    l.specular = WARM.scale(0.6);
    l.intensity = intensity;
    l.range = range;
    lights.push(l);
  };
  at("lounge", 0.75, 70, 8);
  at("kitchen", 0.75, 55, 7);
  at("master-bedroom", 0.75, 45, 7);
  at("garage", 0.9, 30, 8);
  return { lights };
}

/** Post FX on the existing default pipeline: softer bloom for glowing windows, film grain. */
export function tunePost(pipeline) {
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.75;
  pipeline.bloomWeight = 0.22;
  pipeline.bloomKernel = 64;
  pipeline.bloomScale = 0.5;
  pipeline.grainEnabled = true;
  pipeline.grain.intensity = 7;
  pipeline.grain.animated = true;
  pipeline.sharpen.edgeAmount = 0.1;
}
