// Surroundings of the loaded lot. buildForest (used by the tour): asphalt lane + pine forest.
// buildPerimeter (previous suburban look): road + footpaths, neighbouring houses, trees,
// and a textured grass plane. Everything is generated in code (no extra assets) from a fixed seed,
// so the layout is identical on every load. Meshes are tagged `metadata.perimeter = true` so the
// renderer can keep them out of the shadow-caster list.
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import { CreateIcoSphere } from "@babylonjs/core/Meshes/Builders/icoSphereBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/core/Meshes/instancedMesh.js"; // side effect: enables mesh.createInstance()
import { createHouseKit } from "./houses.js";
import { createPineTemplates } from "./pines.js";
import { asset } from "./assets.js";
import { pbrSurface } from "./mood.js";

/** Small deterministic PRNG (mulberry32) so the neighbourhood doesn't change between loads. */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tag(mesh) {
  mesh.metadata = { ...(mesh.metadata || {}), perimeter: true };
  mesh.isPickable = false;
  return mesh;
}

function flatMat(name, hex, scene) {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.specularColor = new Color3(0.05, 0.05, 0.05);
  return m;
}

/**
 * Lawn with leaf litter for the surrounding plane: Poly Haven "Leafy Grass" (CC0,
 * assets/tex/leafy_grass_*) PBR maps, one repeat per 2.5 m. A soft mottle on a much larger,
 * non-integer repeat darkens the ambient light in patches so the 2.5 m tile doesn't show at a distance.
 * @param planeSize  edge length (m) of the square ground plane the material is for (UVs span 0..1)
 */
export function makeGrassMaterial(scene, planeSize = 2000) {
  const mat = pbrSurface(scene, "leafy_grass", { metres: 2.5, uvMetresPerUnit: planeSize, roughness: 0.95 });
  mat.name = "surroundingsMat";
  mat.albedoColor = new Color3(0.6, 0.78, 0.46); // sunlit meadow: greener and less orange than the scan
  mat.bumpTexture.level = 0.6;
  mat.environmentIntensity = 0.85;
  const mottle = mottleTexture(scene);
  mottle.uScale = mottle.vScale = planeSize / 37; // ~37 m per repeat, out of step with the 2.5 m tile
  mat.ambientTexture = mottle;
  mat.ambientTextureStrength = 1;
  return mat;
}

/** Seamless greyscale blotches (0.6–1.0) used as a large-scale ambient-occlusion variation. */
function mottleTexture(scene) {
  const size = 256;
  const tex = new DynamicTexture("grassMottle", { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  ctx.fillStyle = "#e6e6e6";
  ctx.fillRect(0, 0, size, size);
  const r = rng(11);
  for (let i = 0; i < 220; i++) {
    const x = r() * size, y = r() * size, rad = 10 + r() * 38;
    const v = r() < 0.6 ? 150 : 255; // mostly darker patches, a few brighter ones
    for (const [dx, dy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) { // wrap edges so tiles are seamless
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
      g.addColorStop(0, `rgba(${v},${v},${v},${0.18 + r() * 0.2})`);
      g.addColorStop(1, `rgba(${v},${v},${v},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x + dx, y + dy, rad, 0, Math.PI * 2); ctx.fill();
    }
  }
  tex.update();
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

/**
 * Soft darkening of the ground where the overcast sky is blocked: a rounded rectangle under the
 * raised house (the IBL/hemi light otherwise leaves the ground beneath it fully lit) and a disc
 * under every tree. Unlit, alpha-blended decals just above the ground; the sun's shadow map still
 * adds the directional shadow on top. Call again after more trees are planted — trees that
 * already have a decal are skipped.
 * @param footprint  { min, max } (Vector3, x/z used) of the house, or null to only do trees
 * @param y          height of the decals (just above the ground / paving they sit on)
 */
const occluded = new WeakSet();
let treeDecal = null;
export function addGroundOcclusion(scene, { footprint = null, y }) {
  if (footprint) {
    const margin = 1.2;
    const w = footprint.max.x - footprint.min.x + margin * 2, d = footprint.max.z - footprint.min.z + margin * 2;
    const house = tag(CreateGround("houseOcclusion", { width: w, height: d }, scene));
    house.position.set((footprint.min.x + footprint.max.x) / 2, y, (footprint.min.z + footprint.max.z) / 2);
    house.material = decalMaterial(scene, "houseOcclusionMat", roundedRectFalloff(scene, w, d, margin * 1.6), 0.62);
  }
  if (!treeDecal) {
    treeDecal = tag(CreateGround("treeOcclusion", { width: 1, height: 1 }, scene));
    treeDecal.material = decalMaterial(scene, "treeOcclusionMat", roundedRectFalloff(scene, 1, 1, 0.5), 0.4);
    treeDecal.isVisible = false; // template; instances are drawn
  }
  let added = 0;
  for (const m of scene.meshes) {
    const src = m.sourceMesh;
    if (!src || occluded.has(m) || !/^(pine|fir|cypress)[A-Z]$|^broadleafTpl\d+$/.test(src.name)) continue;
    occluded.add(m);
    // Canopy radius: broadleaves spread widest, cypresses are narrow; scaled like the tree.
    const rad = (/^broadleaf/.test(src.name) ? 3.4 : /^cypress/.test(src.name) ? 1.0 : 2.0) * m.scaling.y;
    const dcl = tag(treeDecal.createInstance(`treeOcc${m.name}`));
    dcl.position.set(m.position.x, y, m.position.z);
    dcl.scaling.set(rad * 2, 1, rad * 2);
    added++;
  }
  return added;
}

/** Black decal material whose opacity comes from `tex` (alpha), capped at `opacity`. */
function decalMaterial(scene, name, tex, opacity) {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = Color3.Black();
  mat.disableLighting = true;
  mat.opacityTexture = tex;
  mat.alpha = opacity;
  mat.zOffset = -2; // win the depth test against the ground a few cm below, even far away
  mat.backFaceCulling = true;
  return mat;
}

/** Alpha texture: opaque inside a w×d rectangle inset by `fade` metres, smoothly fading to 0 at its edge. */
function roundedRectFalloff(scene, w, d, fade) {
  const W = 256, H = Math.max(16, Math.round(256 * d / w));
  const tex = new DynamicTexture("occlusionFalloff", { width: W, height: H }, scene, true);
  const ctx = tex.getContext();
  const img = ctx.createImageData(W, H);
  const hx = w / 2 - fade, hz = d / 2 - fade; // inner (fully dark) half-extents
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const px = Math.abs(((i + 0.5) / W - 0.5) * w) - hx, pz = Math.abs(((j + 0.5) / H - 0.5) * d) - hz;
    const dist = Math.hypot(Math.max(px, 0), Math.max(pz, 0)); // metres outside the inner rectangle
    const t = Math.min(dist / fade, 1);
    const a = 1 - t * t * (3 - 2 * t); // smoothstep falloff
    const k = (j * W + i) * 4;
    img.data[k] = img.data[k + 1] = img.data[k + 2] = 0;
    img.data[k + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  tex.update();
  tex.hasAlpha = true;
  tex.getAlphaFromRGB = false;
  tex.wrapU = tex.wrapV = 0; // Texture.CLAMP_ADDRESSMODE
  return tex;
}

/**
 * @param scene   Babylon scene
 * @param min,max model bounds (Vector3) — nothing is placed inside them (plus a margin)
 * @param groundY height of the surrounding ground plane
 * @param frontZ  +1 or -1: which side of the lot faces the street (the side the tour starts on)
 * @param foliage { trees: Mesh[], bushes: Mesh[] } taken from the model; reused (instanced) for
 *                all planting so the neighbourhood matches the lot. Procedural trees if empty.
 */
export function buildPerimeter(scene, min, max, groundY, frontZ = 1, foliage = { trees: [], bushes: [] }) {
  const r = rng(20260918);
  const cx = (min.x + max.x) / 2;
  const blocked = []; // axis-aligned rects {x0,x1,z0,z1} already used
  const margin = 3;
  blocked.push({ x0: min.x - margin, x1: max.x + margin, z0: min.z - margin, z1: max.z + margin });
  const free = (x0, x1, z0, z1) => !blocked.some((b) => x0 < b.x1 && x1 > b.x0 && z0 < b.z1 && z1 > b.z0);

  // --- Street along the front of the lot -------------------------------------------------------
  const frontEdge = frontZ > 0 ? max.z : min.z;
  const roadZ = frontEdge + frontZ * 8;
  const ROAD_W = 7, PATH_W = 2, ROAD_LEN = 600;
  const roadTex = new DynamicTexture("roadTex", { width: 256, height: 64 }, scene, true);
  const rc = roadTex.getContext();
  rc.fillStyle = "#3b3d40"; rc.fillRect(0, 0, 256, 64);
  const nr = rng(3);
  for (let i = 0; i < 900; i++) { rc.fillStyle = `rgba(255,255,255,${nr() * 0.05})`; rc.fillRect(nr() * 256, nr() * 64, 2, 2); }
  rc.fillStyle = "#e8e2c8"; rc.fillRect(0, 30, 128, 4); // centre dash
  roadTex.update();
  roadTex.uScale = ROAD_LEN / 8; // one dash every 8 m
  roadTex.anisotropicFilteringLevel = 8;
  const road = tag(CreateGround("road", { width: ROAD_LEN, height: ROAD_W }, scene));
  road.position.set(cx, groundY + 0.02, roadZ);
  const roadMat = new StandardMaterial("roadMat", scene);
  roadMat.diffuseTexture = roadTex;
  roadMat.specularColor = new Color3(0.03, 0.03, 0.03);
  road.material = roadMat;
  const pathMat = flatMat("footpathMat", "#b9b6ad", scene);
  for (const side of [-1, 1]) {
    const path = tag(CreateGround(`footpath${side}`, { width: ROAD_LEN, height: PATH_W }, scene));
    path.position.set(cx, groundY + 0.05, roadZ + side * (ROAD_W / 2 + PATH_W / 2));
    path.material = pathMat;
  }
  blocked.push({ x0: cx - ROAD_LEN / 2, x1: cx + ROAD_LEN / 2, z0: roadZ - ROAD_W / 2 - PATH_W - 1, z1: roadZ + ROAD_W / 2 + PATH_W + 1 });

  // --- Neighbouring houses (see houses.js) ------------------------------------------------------
  const kit = createHouseKit(scene);
  const concrete = kit.flat("drivewayMat", "#a9a69e");
  const pavers = kit.flat("paverMat", "#b7a992");
  const fenceMats = [kit.flat("fenceWhite", "#efece4"), kit.flat("fenceTimber", "#7a5a40"), kit.flat("fenceDark", "#3a3a3a")];
  const kerb = roadZ; // houses face the road
  let houseCount = 0;
  /** Flat strip on the ground from z0 to z1 at x (world space). */
  const strip = (name, x, z0, z1, width, material, lift) => {
    const len = Math.abs(z1 - z0);
    if (len < 0.2) return;
    const g = tag(CreateGround(name, { width, height: len }, scene));
    g.position.set(x, groundY + lift, (z0 + z1) / 2);
    g.material = material;
  };
  const addHouse = (x, z, w, d) => {
    if (!free(x - w / 2 - 2, x + w / 2 + 2, z - d / 2 - 2, z + d / 2 + 2)) return false;
    const faces = kerb > z ? 1 : -1; // +1: front facade looks toward +z
    const house = kit.build(`nbHouse${houseCount}`, r, { w, d });
    const m = tag(house.mesh);
    m.position.set(x, groundY, z);
    m.rotation.y = faces > 0 ? 0 : Math.PI;
    m.checkCollisions = true;
    // Front yard: from the facade to the footpath edge.
    const facadeZ = z + faces * (d / 2);
    const pathEdgeZ = kerb - faces * (ROAD_W / 2 + PATH_W);
    const toWorldX = (lx) => x + faces * lx; // rotating by π mirrors local x
    strip(`nbPath${houseCount}`, toWorldX(house.doorX), facadeZ + faces * 0.9, pathEdgeZ, 1.2, pavers, 0.03);
    if (house.hasGarage) strip(`nbDrive${houseCount}`, toWorldX(house.garageX), facadeZ, pathEdgeZ, 3.2, concrete, 0.035);
    // Low front fence along the footpath with gaps for the path and driveway.
    if (r() < 0.7) {
      const fm = fenceMats[Math.floor(r() * fenceMats.length)];
      const fz = pathEdgeZ - faces * 0.3;
      const gaps = [[toWorldX(house.doorX), 0.8]];
      if (house.hasGarage) gaps.push([toWorldX(house.garageX), 1.8]);
      const parts = [];
      for (let fx = x - w / 2 - 1.5; fx <= x + w / 2 + 1.5; fx += 0.14) {
        if (gaps.some(([gx, hw]) => Math.abs(fx - gx) < hw)) continue;
        const picket = CreateBox("picket", { width: 0.08, height: 0.95, depth: 0.03 }, scene);
        picket.position.set(fx, groundY + 0.475, fz);
        parts.push(picket);
      }
      if (parts.length) {
        const fence = tag(Mesh.MergeMeshes(parts, true, true));
        fence.name = `nbFence${houseCount}`;
        fence.material = fm;
      }
    }
    blocked.push({ x0: x - w / 2 - 2, x1: x + w / 2 + 2, z0: z - d / 2 - 2, z1: z + d / 2 + 2 });
    houseCount++;
    return true;
  };
  // Across the street: a continuous row, set back ~7 m from the footpath.
  const acrossZ = roadZ + frontZ * (ROAD_W / 2 + PATH_W + 13);
  for (let x = cx - 150; x <= cx + 150; x += 19 + r() * 6) addHouse(x + (r() - 0.5) * 3, acrossZ + frontZ * r() * 2, 10 + r() * 4, 9 + r() * 3);
  // Same side of the street, left and right of the lot.
  const sameZ = roadZ - frontZ * (ROAD_W / 2 + PATH_W + 13);
  for (let x = max.x + 13; x <= cx + 150; x += 19 + r() * 6) addHouse(x, sameZ - frontZ * r() * 2, 10 + r() * 4, 9 + r() * 3);
  for (let x = min.x - 13; x >= cx - 150; x -= 19 + r() * 6) addHouse(x, sameZ - frontZ * r() * 2, 10 + r() * 4, 9 + r() * 3);

  // --- Trees & bushes (instanced) ---------------------------------------------------------------
  let trees = 0;
  const modelTrees = foliage.trees.map((m, i) => makeFoliageTemplate(m, `treeTpl${i}`));
  const modelBushes = foliage.bushes.map((m, i) => makeFoliageTemplate(m, `bushTpl${i}`));
  let addTree;
  if (modelTrees.length) {
    addTree = (x, z) => {
      if (!free(x - 1.5, x + 1.5, z - 1.5, z + 1.5)) return;
      const tpl = modelTrees[Math.floor(r() * modelTrees.length)];
      const t = tag(tpl.createInstance(`tree${trees++}`));
      const s = 0.75 + r() * 0.5;
      t.scaling.setAll(s);
      t.rotation.y = r() * Math.PI * 2;
      t.position.set(x, groundY, z);
    };
  } else {
    addTree = proceduralTrees(scene, r, free, groundY, () => trees++);
  }
  const addBush = (x, z) => {
    if (!modelBushes.length || !free(x - 0.8, x + 0.8, z - 0.8, z + 0.8)) return;
    const b = tag(modelBushes[Math.floor(r() * modelBushes.length)].createInstance(`bush${trees++}`));
    b.scaling.setAll(0.8 + r() * 0.8);
    b.rotation.y = r() * Math.PI * 2;
    b.position.set(x, groundY, z);
  };
  // Street trees along both footpaths.
  for (let x = cx - 150; x <= cx + 150; x += 11 + r() * 5) {
    addTree(x, roadZ - (ROAD_W / 2 + PATH_W + 1.2));
    addTree(x + 5, roadZ + (ROAD_W / 2 + PATH_W + 1.2));
  }
  // Scattered trees and a denser belt behind the lot.
  for (let i = 0; i < 260; i++) {
    const ang = r() * Math.PI * 2, dist = 12 + Math.pow(r(), 0.7) * 140;
    addTree(cx + Math.cos(ang) * dist, (min.z + max.z) / 2 + Math.sin(ang) * dist);
  }
  const backEdge = frontZ > 0 ? min.z : max.z;
  for (let x = min.x - 20; x <= max.x + 20; x += 3 + r() * 3) addTree(x + (r() - 0.5) * 2, backEdge - frontZ * (6 + r() * 8));
  // Bushes: along the lot-side footpath and around the lot.
  for (let x = cx - 120; x <= cx + 120; x += 4 + r() * 6) addBush(x, roadZ - frontZ * (ROAD_W / 2 + PATH_W + 2.5 + r()));
  for (let i = 0; i < 220; i++) {
    const ang = r() * Math.PI * 2, dist = 8 + Math.pow(r(), 0.8) * 90;
    addBush(cx + Math.cos(ang) * dist, (min.z + max.z) / 2 + Math.sin(ang) * dist);
  }

  return { houses: houseCount, trees };
}

/**
 * Alpine setting (the default look): no neighbours, just an asphalt lane along the front and a
 * pine forest — tall pines, firs and a few columnar cypresses — closing in around the lot,
 * densest behind the house. Same signature as buildPerimeter.
 */
export function buildForest(scene, min, max, groundY, frontZ = 1, foliage = { trees: [], bushes: [] }) {
  const r = rng(20260919);
  const cx = (min.x + max.x) / 2, cz = (min.z + max.z) / 2;
  const blocked = [];
  const margin = 3;
  blocked.push({ x0: min.x - margin, x1: max.x + margin, z0: min.z - margin, z1: max.z + margin });
  const free = (x0, x1, z0, z1) => !blocked.some((b) => x0 < b.x1 && x1 > b.x0 && z0 < b.z1 && z1 > b.z0);

  // --- Private lane along the front of the lot ---------------------------------------------------
  const LANE_W = 5, LANE_LEN = 420;
  const laneZ = (frontZ > 0 ? max.z : min.z) + frontZ * 6;
  const lane = tag(CreateGround("lane", { width: LANE_LEN, height: LANE_W }, scene));
  lane.position.set(cx, groundY + 0.02, laneZ);
  const laneMat = pbrSurface(scene, "asphalt_07", { metres: 2.5, uvMetresPerUnit: LANE_LEN, tone: 0.7, roughness: 0.9 });
  laneMat.albedoTexture.vScale = laneMat.bumpTexture.vScale = laneMat.metallicTexture.vScale = LANE_W / 2.5;
  lane.material = laneMat;
  lane.receiveShadows = true;
  blocked.push({ x0: cx - LANE_LEN / 2, x1: cx + LANE_LEN / 2, z0: laneZ - LANE_W / 2 - 1.5, z1: laneZ + LANE_W / 2 + 1.5 });

  // --- Conifers (instanced) --------------------------------------------------------------------------
  const kinds = createPineTemplates(scene);
  let trees = 0;
  const addTree = (x, z, kind) => {
    const rad = kind === "cypress" ? 0.8 : kind === "fir" ? 1.8 : 2.2;
    if (!free(x - rad, x + rad, z - rad, z + rad)) return false;
    const list = kinds[kind];
    const t = tag(list[Math.floor(r() * list.length)].createInstance(`${kind}${trees++}`));
    const s = 0.75 + r() * 0.55;
    t.scaling.set(s * (0.9 + r() * 0.2), s, s * (0.9 + r() * 0.2));
    t.rotation.y = r() * Math.PI * 2;
    t.position.set(x, groundY - 0.05, z);
    blocked.push({ x0: x - rad * 0.6, x1: x + rad * 0.6, z0: z - rad * 0.6, z1: z + rad * 0.6 });
    return true;
  };
  const pick = () => { const v = r(); return v < 0.5 ? "pine" : v < 0.88 ? "fir" : "cypress"; };
  // Mid/far forest mixes in broadleaf trees (models/props/broadleaf_trees.glb). They load after the
  // tour is ready, so here we only reserve their spots; addBroadleafTrees() fills them later.
  const lotR = Math.max(max.x - cx, max.z - cz);
  const broadleafSlots = [];
  const reserveBroadleaf = (x, z) => {
    const rad = 2.8;
    if (!free(x - rad, x + rad, z - rad, z + rad)) return;
    broadleafSlots.push({ x, z, s: 0.8 + r() * 0.5, rot: r() * Math.PI * 2, v: r() });
    blocked.push({ x0: x - rad * 0.6, x1: x + rad * 0.6, z0: z - rad * 0.6, z1: z + rad * 0.6 });
  };
  // Close ring: a few specimen trees framing the house (like the reference's garden pines/cypresses).
  for (let i = 0; i < 40; i++) {
    const ang = r() * Math.PI * 2, dist = Math.max(max.x - cx, max.z - cz) + 4 + r() * 10;
    addTree(cx + Math.cos(ang) * dist, cz + Math.sin(ang) * dist, r() < 0.3 ? "cypress" : "pine");
  }
  // Forest: denser with distance, thickest behind the house; the lane side stays open for the view.
  const backDir = -frontZ;
  for (let i = 0; i < 1400; i++) {
    const ang = r() * Math.PI * 2, dist = 14 + Math.pow(r(), 0.8) * 170;
    const x = cx + Math.cos(ang) * dist, z = cz + Math.sin(ang) * dist;
    const inFront = (z - cz) * frontZ > 0;
    if (inFront && Math.abs(x - cx) < 60 && (z - cz) * frontZ < 45 && r() < 0.8) continue; // keep the view open
    if (dist - lotR > 20 && r() < 0.35) reserveBroadleaf(x, z);
    else addTree(x, z, pick());
  }
  for (let x = min.x - 40; x <= max.x + 40; x += 2.5 + r() * 2.5) { // wall of trees behind the lot
    addTree(x + (r() - 0.5) * 2, (backDir > 0 ? max.z : min.z) + backDir * (7 + r() * 10), pick());
  }

  // --- Understorey: the model's own shrubs, scattered at the forest edge -------------------------
  const bushes = foliage.bushes.map((m, i) => makeFoliageTemplate(m, `bushTpl${i}`));
  if (bushes.length) {
    for (let i = 0; i < 260; i++) {
      const ang = r() * Math.PI * 2, dist = 9 + Math.pow(r(), 0.8) * 80;
      const x = cx + Math.cos(ang) * dist, z = cz + Math.sin(ang) * dist;
      if (!free(x - 0.8, x + 0.8, z - 0.8, z + 0.8)) continue;
      const b = tag(bushes[Math.floor(r() * bushes.length)].createInstance(`bush${i}`));
      b.scaling.setAll(0.8 + r() * 0.9);
      b.rotation.y = r() * Math.PI * 2;
      b.position.set(x, groundY, z);
    }
  }
  // If the broadleaf model can't load, its spots get conifers instead (same deterministic layout).
  const fillWithConifers = () => { for (const sl of broadleafSlots) addTree(sl.x, sl.z, sl.v < 0.6 ? "fir" : "pine"); };
  return { trees, broadleafSlots, fillWithConifers };
}

/**
 * Instance the broadleaf trees ("Low Poly Tree Scene Free" by Nicholas-3D, CC BY 4.0; trees-only
 * extract in models/props/) into the spots buildForest reserved. The file holds 23 placed copies
 * of two designs; each distinct design becomes one template (trunk + leaves merged, base at origin).
 */
export async function addBroadleafTrees(scene, slots, groundY, url = asset("models/props/broadleaf_trees.glb")) {
  const res = await ImportMeshAsync(url, scene);
  const byDesign = new Map(); // source geometry ids → one tree node that uses them
  for (const node of res.transformNodes.concat(res.meshes)) {
    if (!/^tree\d+$/.test(node.name)) continue;
    const parts = node.getChildMeshes(false).filter((m) => m.getTotalVertices() > 0);
    const key = parts.map((m) => (m.sourceMesh || m).geometry?.uniqueId).sort().join(",");
    const hasLeaves = parts.some((m) => /leaves/i.test((m.sourceMesh || m).material?.name || ""));
    if (hasLeaves && !byDesign.has(key)) byDesign.set(key, parts); // skip the bare-trunk prop
  }
  const templates = [];
  for (const parts of byDesign.values()) {
    const baked = parts.map((m) => {
      const src = m.sourceMesh || m;
      const c = src.clone(`${src.name}Bake`, null, true);
      c.makeGeometryUnique();
      c.parent = null;
      c.position.setAll(0); c.rotationQuaternion = null; c.rotation.setAll(0); c.scaling.setAll(1);
      c.bakeTransformIntoVertices(m.computeWorldMatrix(true));
      c.material = src.material;
      return c;
    });
    const t = Mesh.MergeMeshes(baked, true, true, undefined, false, true);
    t.refreshBoundingInfo();
    let bb = t.getBoundingInfo().boundingBox;
    t.bakeTransformIntoVertices(Matrix.Translation(-(bb.minimum.x + bb.maximum.x) / 2, -bb.minimum.y, -(bb.minimum.z + bb.maximum.z) / 2));
    t.refreshBoundingInfo();
    bb = t.getBoundingInfo().boundingBox;
    const h = bb.maximum.y - bb.minimum.y;
    // The designs are 7.5–9 m; mature broadleaves beside 13–18 m pines read better at ~12–13 m.
    t.scaling.setAll(12.5 / h);
    t.bakeCurrentTransformIntoVertices();
    t.name = `broadleafTpl${templates.length}`;
    t.isVisible = false;
    t.checkCollisions = false;
    templates.push(tag(t));
  }
  for (const m of res.meshes) m.dispose(false, false); // the imported layout; materials live on in the templates
  for (const n of res.transformNodes) n.dispose();
  // Matched to mood.js: deeper, less yellow leaves; matte (weak sky specular).
  for (const mat of new Set(templates.flatMap((t) => t.material?.subMaterials || [t.material]))) {
    if (!mat || !("albedoColor" in mat)) continue;
    const leaves = /leaves/i.test(mat.name);
    mat.albedoColor = leaves ? new Color3(0.55, 0.64, 0.5) : new Color3(0.62, 0.6, 0.58);
    mat.metallic = 0;
    mat.roughness = 0.9;
    mat.metallicF0Factor = 0.3;
    mat.environmentIntensity = 0.75;
    if (leaves) { mat.backFaceCulling = false; mat.twoSidedLighting = true; }
  }
  // Bigger design is the canopy tree; the smaller one reads as younger growth — weight toward the big one.
  templates.sort((a, b) => b.getTotalVertices() - a.getTotalVertices());
  slots.forEach((sl, i) => {
    const tpl = templates[sl.v < 0.65 || templates.length < 2 ? 0 : 1];
    const inst = tag(tpl.createInstance(`broadleaf${i}`));
    inst.scaling.set(sl.s * (0.9 + (sl.v * 7 % 1) * 0.2), sl.s, sl.s);
    inst.rotation.y = sl.rot;
    inst.position.set(sl.x, groundY - 0.05, sl.z);
  });
  return { templates: templates.length, trees: slots.length };
}

/**
 * Copy a foliage mesh from the model into a standalone template (geometry baked to world size,
 * origin at the base centre) that can be instanced anywhere. The original on the lot is untouched.
 */
function makeFoliageTemplate(src, name) {
  const t = src.clone(name, null, true);
  t.makeGeometryUnique(); // clones share geometry; don't bake into the original
  t.parent = null;
  t.position.setAll(0);
  t.rotationQuaternion = null;
  t.rotation.setAll(0);
  t.scaling.setAll(1);
  t.bakeTransformIntoVertices(src.computeWorldMatrix(true)); // flips winding itself if mirrored
  t.refreshBoundingInfo();
  const bb = t.getBoundingInfo().boundingBox;
  t.bakeTransformIntoVertices(Matrix.Translation(-(bb.minimum.x + bb.maximum.x) / 2, -bb.minimum.y, -(bb.minimum.z + bb.maximum.z) / 2));
  t.refreshBoundingInfo();
  // Alpha-tested (not blended) leaves: no sorting glitches between hundreds of overlapping trees.
  const mat = src.material.clone(`${name}Mat`);
  mat.transparencyMode = 1; // Material.MATERIAL_ALPHATEST
  mat.alphaCutOff = 0.4;
  mat.backFaceCulling = false;
  t.material = mat;
  t.checkCollisions = false;
  t.isVisible = false; // template only; instances are drawn
  return tag(t);
}

/** Fallback when the model has no foliage: simple low-poly trees (trunk + canopy). */
function proceduralTrees(scene, r, free, groundY, count) {
  const trunk = tag(CreateCylinder("treeTrunk", { diameterTop: 0.25, diameterBottom: 0.4, height: 1, tessellation: 7 }, scene));
  trunk.material = flatMat("trunkMat", "#5a4332", scene);
  trunk.isVisible = false;
  const canopies = ["#2f4a22", "#3a5626", "#2b4520", "#44602c"].map((c, i) => {
    const round = i % 2 === 0;
    const m = tag(round
      ? CreateIcoSphere(`canopy${i}`, { radius: 1, subdivisions: 2, flat: true }, scene)
      : CreateCylinder(`canopy${i}`, { diameterTop: 0, diameterBottom: 2, height: 2.4, tessellation: 8 }, scene));
    m.material = flatMat(`canopyMat${i}`, c, scene);
    m.isVisible = false;
    return { mesh: m, round };
  });
  return (x, z) => {
    if (!free(x - 1.5, x + 1.5, z - 1.5, z + 1.5)) return;
    const n = count();
    const s = 0.7 + r() * 0.5, trunkH = 2 + r() * 1.5;
    const t = tag(trunk.createInstance(`trunk${n}`));
    t.scaling.set(s, trunkH, s);
    t.position.set(x, groundY + trunkH / 2, z);
    t.checkCollisions = true;
    const kind = canopies[Math.floor(r() * canopies.length)];
    const c = tag(kind.mesh.createInstance(`crown${n}`));
    const cs = (1.4 + r() * 1.1) * s;
    if (kind.round) { c.scaling.set(cs, cs * (0.8 + r() * 0.4), cs); c.position.set(x, groundY + trunkH + cs * 0.6, z); }
    else { c.scaling.set(cs * 0.8, cs * 1.2, cs * 0.8); c.position.set(x, groundY + trunkH + cs * 1.2, z); }
    c.rotation.y = r() * Math.PI * 2;
  };
}
