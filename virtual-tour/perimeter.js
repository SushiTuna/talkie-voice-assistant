// Procedural neighbourhood around the loaded lot: road + footpaths, neighbouring houses, trees,
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
import "@babylonjs/core/Meshes/instancedMesh.js"; // side effect: enables mesh.createInstance()
import { createHouseKit } from "./houses.js";

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
 * Grass for the surrounding plane. If the model has its own ground material, clone it (same PBR
 * look as the lot) and tile only the greenest patch of its texture — lot textures usually have
 * dirt/paths around the edges — mirrored so seams don't show, at the model's own texture scale.
 * Otherwise (or until that crop is ready) a mottled procedural grass is used.
 * @param source      the model's ground material (optional)
 * @param tileMeters  how many metres the whole source texture covers on the model
 */
export function makeGrassMaterial(scene, source = null, tileMeters = 10) {
  const srcTex = source?.albedoTexture || source?.diffuseTexture;
  const procedural = proceduralGrassTexture(scene);
  if (!srcTex) {
    const mat = new StandardMaterial("surroundingsMat", scene);
    mat.diffuseTexture = procedural;
    mat.specularColor = Color3.Black();
    return mat;
  }
  const mat = source.clone("surroundingsMat");
  mat.bumpTexture = null; // the lot's normal map is laid out for the lot, not a tile
  const setTex = (t) => { if ("albedoTexture" in mat) mat.albedoTexture = t; else mat.diffuseTexture = t; };
  setTex(procedural);
  greenestPatch(scene, srcTex).then((patch) => {
    if (!patch) return;
    const metres = (patch.size / srcTex.getSize().width) * tileMeters;
    patch.texture.uScale = patch.texture.vScale = 2000 / metres;
    setTex(patch.texture);
    procedural.dispose();
  }).catch(() => { /* keep procedural grass */ });
  return mat;
}

/** Crop the greenest square region (2×2 cells of an 8×8 grid) of a texture into a tileable texture. */
async function greenestPatch(scene, srcTex) {
  const { width: W, height: H } = srcTex.getSize();
  const px = await srcTex.readPixels();
  if (!px || !W || !H) return null;
  const G = 8, cw = Math.floor(W / G), ch = Math.floor(H / G);
  const score = [];
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = gy * ch; y < (gy + 1) * ch; y += 4) for (let x = gx * cw; x < (gx + 1) * cw; x += 4) {
      const i = (y * W + x) * 4; r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
    }
    score[gy * G + gx] = (g - (r + b) / 2) / n; // greenness
  }
  let best = null;
  for (let gy = 0; gy < G - 1; gy++) for (let gx = 0; gx < G - 1; gx++) {
    const s = score[gy * G + gx] + score[gy * G + gx + 1] + score[(gy + 1) * G + gx] + score[(gy + 1) * G + gx + 1];
    if (!best || s > best.s) best = { s, gx, gy };
  }
  if (!best || best.s <= 0) return null; // nothing green in the texture
  const inset = 6, size = Math.min(cw, ch) * 2 - inset * 2;
  const x0 = best.gx * cw + inset, y0 = best.gy * ch + inset;
  const tex = new DynamicTexture("grassPatch", { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const si = ((y0 + y) * W + (x0 + x)) * 4, di = (y * size + x) * 4;
    img.data[di] = px[si]; img.data[di + 1] = px[si + 1]; img.data[di + 2] = px[si + 2]; img.data[di + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  tex.update();
  tex.wrapU = tex.wrapV = 2; // Texture.MIRROR_ADDRESSMODE: seamless without a tileable source
  tex.anisotropicFilteringLevel = 8;
  return { texture: tex, size };
}

/** Mottled procedural grass, tiled every ~10 m. */
function proceduralGrassTexture(scene) {
  const size = 512;
  const tex = new DynamicTexture("grassTex", { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  ctx.fillStyle = "#5f6e3f";
  ctx.fillRect(0, 0, size, size);
  const r = rng(7);
  for (let i = 0; i < 2500; i++) {
    const x = r() * size, y = r() * size, rad = 2 + r() * 14;
    const shade = r() < 0.5 ? `rgba(70,84,40,${0.15 + r() * 0.25})` : `rgba(128,140,82,${0.1 + r() * 0.2})`;
    ctx.fillStyle = shade;
    for (const [dx, dy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) { // wrap edges so tiles are seamless
      ctx.beginPath(); ctx.arc(x + dx, y + dy, rad, 0, Math.PI * 2); ctx.fill();
    }
  }
  tex.update();
  tex.uScale = tex.vScale = 200; // 2000 m plane / 200 = 10 m per tile
  tex.anisotropicFilteringLevel = 8;
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
