// The tour's look: a dark villa in a misty alpine pine forest just after rain — overcast HDRI sky
// and image-based light, mountain silhouettes fading into mist, fog, a cool filmic grade, dark
// bronze facade, wet pavers with planar reflections, warm light glowing inside, and falling rain.
// main.js calls these in order: setupAtmosphere → (model loads) → restyleModel → tunePost → createRain.
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Plane } from "@babylonjs/core/Maths/math.plane.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture.js";
import { MirrorTexture } from "@babylonjs/core/Materials/Textures/mirrorTexture.js";
import { ColorCurves } from "@babylonjs/core/Materials/colorCurves.js";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration.js";
import { PointLight } from "@babylonjs/core/Lights/pointLight.js";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem.js";
import "@babylonjs/core/Particles/particleSystemComponent.js"; // side effect: scene renders particle systems

const ENV_URL = "/assets/env/overcast_soil_puresky_2k.hdr";
const TEX = "/assets/tex/";
export const FOG = "#9da2a2";   // mist; also the clear colour, so the far ground melts into the sky
const FOG_DENSITY = 0.0084;     // exp2: ~84% visible at 50 m, ~43% at 110 m
const SKY_LEVEL = 0.88;         // skybox brightness (the shared HDR's level)
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
 * Overcast HDRI as both skybox and image-based lighting, a ring of misty mountains in front of
 * it, soft cool key light, exp2 fog and a filmic grade. `fallbackSky` (the old gradient dome)
 * stays visible until the HDR has loaded, and for good if it fails.
 */
export function setupAtmosphere(scene, { hemi, sun, fallbackSky }) {
  const fog = Color3.FromHexString(FOG);
  scene.clearColor = Color4.FromColor3(fog, 1);
  scene.fogMode = 2; // Scene.FOGMODE_EXP2
  scene.fogDensity = FOG_DENSITY;
  scene.fogColor = fog;

  // Overcast: the sky dome does most of the lighting (IBL); the "sun" is a weak, cool, high key
  // that only gives soft direction and contact shadows.
  hemi.intensity = 0.3;
  hemi.diffuse = new Color3(0.78, 0.82, 0.86);
  hemi.groundColor = new Color3(0.22, 0.24, 0.2);
  hemi.specular = Color3.Black();
  sun.direction = new Vector3(-0.3, -1, 0.45).normalize();
  sun.intensity = 0.9;
  sun.diffuse = new Color3(0.9, 0.93, 0.97);
  scene.ambientColor = new Color3(0.18, 0.19, 0.2);

  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = 1.18;
  ip.contrast = 1.18;
  ip.colorCurvesEnabled = true;
  const curves = new ColorCurves();
  curves.globalSaturation = -18;     // muted, rainy palette
  curves.shadowsHue = 200;           // teal-blue shadows…
  curves.shadowsDensity = 22;
  curves.shadowsSaturation = 20;
  curves.highlightsHue = 35;         // …warm highlights (interior light, wet reflections)
  curves.highlightsDensity = 12;
  curves.highlightsSaturation = 15;
  ip.colorCurves = curves;
  ip.vignetteEnabled = true;
  ip.vignetteWeight = 1.8;
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
  const hdr = new HDRCubeTexture(ENV_URL, scene, 512, false, true, false, true, () => {
    skyMat.reflectionTexture = hdr;
    skyMat.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
    skyMat.reflectionTexture.level = SKY_LEVEL; // heavy overcast: keep the cloud layer grey, not blown out
    skybox.setEnabled(true);
    fallbackSky?.setEnabled(false);
  }, (msg) => console.warn("HDR sky failed, keeping gradient sky:", msg));
  hdr.rotationY = 1.9; // brightest part of the cloud layer behind-left of the opening view
  scene.environmentTexture = hdr;
  scene.environmentIntensity = 1 / SKY_LEVEL; // the skybox dims the shared HDR (level); keep IBL at full strength

  // The orbit (dollhouse) camera sits ~60 m out: walking-distance mist would hide the house.
  scene.onBeforeRenderObservable.add(() => {
    scene.fogDensity = scene.activeCamera?.getClassName() === "ArcRotateCamera" ? FOG_DENSITY * 0.35 : FOG_DENSITY;
  });

  buildMountains(scene, fog);
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
 * A cylinder of painted mountain silhouettes around the horizon: three ridgelines, the farthest
 * palest, each dissolving into mist at its foot. Follows the camera (infinite distance), unlit.
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
  const layers = [
    { base: 0.8, amp: 0.72, peaks: 9, tone: new Color3(0.74, 0.76, 0.78), rock: 0.1 },  // far, pale peaks
    { base: 0.8, amp: 0.5, peaks: 7, tone: new Color3(0.58, 0.6, 0.61), rock: 0.16 },
    { base: 0.82, amp: 0.26, peaks: 6, tone: new Color3(0.44, 0.47, 0.45), rock: 0.2 }, // near, forested foothills
  ];
  for (const L of layers) {
    const h = massifs(r, L.peaks, 6);
    const yAt = (x) => H * (L.base - h(x / W) * L.amp);
    // One column per texel: shade by slope (light from the left) so faces and gullies read as rock,
    // fading from the ridge colour down into mist at the horizon.
    for (let x = 0; x < W; x++) {
      const y0 = yAt(x);
      const slope = (yAt(x + 14) - yAt(x - 14)) / 28; // >0: ridge falls to the right (lit face)
      const shade = 1 + Math.max(-0.16, Math.min(0.16, slope * 0.5));
      // Slope shading only near the crest (real faces break up lower down), then plain rock, then mist.
      const g = ctx.createLinearGradient(0, y0, 0, H * HORIZON);
      g.addColorStop(0, rgb(L.tone, shade * 1.06));
      g.addColorStop(0.18, rgb(L.tone, 1 + (shade - 1) * 0.3));
      g.addColorStop(0.5, rgb(L.tone, 1.04));
      g.addColorStop(1, rgb(fog, 1));
      ctx.fillStyle = g;
      ctx.fillRect(x, y0, 1, H - y0);
    }
    // Rock striations: short dark streaks down the faces, stronger on the near ranges.
    for (let i = 0; i < 2600; i++) {
      const x = r() * W, top = yAt(x), y = top + r() * (H * HORIZON - top) * 0.6;
      ctx.strokeStyle = `rgba(18,22,24,${L.rock * r()})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (r() - 0.5) * 8, y + 6 + r() * 26); ctx.stroke();
    }
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
export function wetSurface(scene, name, { metres, uvMetresPerUnit = 1, darken = 0.55, roughness = 0.55 }) {
  const m = new PBRMaterial(name + "Wet", scene);
  const rep = uvMetresPerUnit / metres;
  const t = (suffix) => {
    const tx = new Texture(`${TEX}${name}_${suffix}_1k.jpg`, scene);
    tx.uScale = tx.vScale = rep;
    tx.anisotropicFilteringLevel = 8;
    return tx;
  };
  m.albedoTexture = t("diff");
  m.albedoColor = new Color3(darken, darken, darken * 1.02); // wet stone is darker and more saturated
  m.bumpTexture = t("nor_gl");
  m.bumpTexture.level = 0.8;
  m.metallicTexture = t("rough");
  m.useRoughnessFromMetallicTextureGreen = true;  // greyscale map: G = roughness
  m.useMetallnessFromMetallicTextureBlue = false;
  m.useAmbientOcclusionFromMetallicTextureRed = false;
  m.metallic = 0;
  m.roughness = roughness; // multiplies the map: low = wet sheen, dry-ish joints stay rougher
  m.environmentIntensity = 1.1;
  return m;
}

/**
 * Re-skin the loaded model (by glTF material name), add warm interior lights and a planar
 * "wet ground" mirror under the carport and street. Returns the mirror so the perimeter's lane
 * can share it.
 * @param anchors ROOM_ANCHORS — interior lights sit under the ceiling near the main rooms
 */
export function restyleModel(scene, { modelMeshes, anchors, groundY }) {
  const slab = modelMeshes.find((m) => MAT.slab.test(m.material?.name || ""));
  const paveY = slab ? slab.getBoundingInfo().boundingBox.maximumWorld.y : groundY;
  // 512 px: the reflection is blurred (rain-rippled) anyway; 1024 cost ~2 ms more GPU per frame.
  const mirror = new MirrorTexture("wetMirror", 512, scene, true);
  mirror.mirrorPlane = new Plane(0, -1, 0, paveY); // -y + d = 0 → reflect across y = paveY
  mirror.adaptiveBlurKernel = 20; // rain-rippled water, not a polished floor
  mirror.level = 0.9;
  mirror.renderList = modelMeshes.filter((m) => m.getTotalVertices() > 0 && !MAT.slab.test(m.material?.name || "") && !MAT.land.test(m.material?.name || ""));
  const sky = scene.getMeshByName("skyBox");
  if (sky) mirror.renderList.push(sky);
  const mtn = scene.getMeshByName("mountains");
  if (mtn) mirror.renderList.push(mtn);

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
      const wet = wetSurface(scene, "brick_pavement_02", { metres: 2, uvMetresPerUnit: uvMetres(mesh), darken: 0.5, roughness: 0.5 });
      wet.reflectionTexture = mirror;
      wet.maxSimultaneousLights = 8;
      for (const m of modelMeshes) if (m.material === mat) m.material = wet;
    } else if (MAT.land.test(n)) {
      mat.albedoColor = new Color3(0.42, 0.47, 0.4); // damp, darker earth and grass
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
  return { mirror, lights };
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

/* ------------------------------------------------------------------ rain */

/**
 * Rain streaks around the active camera. Drops never fall through roofs or ceilings: a coarse
 * height map of the top surface over the lot (raycast once) retires any drop that sinks below it,
 * so standing indoors or under the carport stays dry while rain is visible outside.
 * @returns {{ setEnabled(on: boolean): void, isEnabled(): boolean }}
 */
export function createRain(scene, { bounds, groundY, enabled }) {
  const tex = new DynamicTexture("rainDrop", { width: 16, height: 128 }, scene, true);
  const c = tex.getContext();
  const g = c.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.7, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.fillRect(6, 0, 4, 128);
  tex.hasAlpha = true;
  tex.update();

  const ps = new ParticleSystem("rain", 9000, scene);
  ps.particleTexture = tex;
  ps.emitter = new Vector3();
  ps.minEmitBox = new Vector3(-18, 9, -18);
  ps.maxEmitBox = new Vector3(18, 13, 18);
  ps.direction1 = new Vector3(0.9, -12, 0.4);
  ps.direction2 = new Vector3(1.3, -12, 0.7);
  ps.minEmitPower = 0.95;
  ps.maxEmitPower = 1.05;
  ps.updateSpeed = 1 / 60;        // time units = seconds at 60 fps (lifetime/velocity below are real-ish)
  ps.minLifeTime = ps.maxLifeTime = 1.9;
  ps.emitRate = 4200;
  ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
  ps.minSize = 0.022; ps.maxSize = 0.034;
  ps.minScaleX = ps.maxScaleX = 1;
  ps.minScaleY = 22; ps.maxScaleY = 36;
  ps.color1 = new Color4(0.86, 0.89, 0.92, 0.5);
  ps.color2 = new Color4(0.78, 0.82, 0.87, 0.32);
  ps.colorDead = new Color4(0.75, 0.8, 0.86, 0);
  ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  ps.isLocal = false;

  // Top-surface height map (0.5 m cells) over the model bounds.
  const CELL = 0.5;
  const nx = Math.ceil((bounds.max.x - bounds.min.x) / CELL) + 1;
  const nz = Math.ceil((bounds.max.z - bounds.min.z) / CELL) + 1;
  const top = new Float32Array(nx * nz).fill(groundY);
  const pickable = (m) => m.isPickable && m.isEnabled() && !m.metadata?.perimeter && m.name !== "surroundings" && m.name !== "skyBox";
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = bounds.min.x + i * CELL, z = bounds.min.z + j * CELL;
    const hit = scene.pickWithRay(new Ray(new Vector3(x, bounds.max.y + 2, z), Vector3.Down(), bounds.max.y - groundY + 4), pickable);
    if (hit?.hit) top[i * nz + j] = hit.pickedPoint.y;
  }
  const surfaceAt = (x, z) => {
    const i = Math.round((x - bounds.min.x) / CELL), j = Math.round((z - bounds.min.z) / CELL);
    return i < 0 || j < 0 || i >= nx || j >= nz ? groundY : top[i * nz + j];
  };

  const follow = scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera;
    if (!cam) return;
    // orbit (dollhouse) camera: rain over the house, not around the far-away eye
    const p = cam.getClassName() === "ArcRotateCamera" ? cam.target : cam.position;
    ps.emitter.copyFrom(p);
    for (const d of ps.particles) {
      if (d.position.y < surfaceAt(d.position.x, d.position.z)) d.age = d.lifeTime;
    }
  });

  let on = false;
  const setEnabled = (v) => {
    if (v === on) return;
    on = v;
    if (on) ps.start(); else ps.stop();
  };
  setEnabled(!!enabled);
  return { setEnabled, isEnabled: () => on, dispose: () => { scene.onBeforeRenderObservable.remove(follow); ps.dispose(); } };
}
