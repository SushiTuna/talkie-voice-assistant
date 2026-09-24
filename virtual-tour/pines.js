// Procedural conifers for the forest around the lot. Real CC0 textures (Poly Haven "pine_tree_01":
// bark + needle twigs, composed into branch/tuft cards in assets/tex/) on light card geometry, so
// hundreds of instances stay cheap. Three species:
//   pine    — tall bare trunk, crown of flat needle pads on upswept limbs (Scots/Japanese pine)
//   fir     — dense cone of drooping whorls almost to the ground
//   cypress — narrow column (fir whorls with short branches), like the Italian cypresses in the reference
// Each template is one mesh (trunk submesh + needle submesh) meant for createInstance().
import { Vector3, Matrix, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { asset } from "./assets.js";

const TEX = asset("assets/tex/");

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Collects textured quads (cards) with foliage normals that point away from the crown's axis. */
class CardBuilder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.idx = []; }
  /**
   * Quad in local space: x from 0..len (u 0..1), y from -h/2..h/2 (v 0..1), then transformed by m.
   * `centre` bends normals outward from the tree axis (soft, volumetric shading on flat cards).
   */
  quad(m, len, h, centreY, x0 = 0) {
    const base = this.pos.length / 3;
    const corners = [[x0, -h / 2, 0, 0, 0], [x0 + len, -h / 2, 0, 1, 0], [x0 + len, h / 2, 0, 1, 1], [x0, h / 2, 0, 0, 1]];
    for (const [x, y, z, u, v] of corners) {
      const p = Vector3.TransformCoordinates(new Vector3(x, y, z), m);
      this.pos.push(p.x, p.y, p.z);
      const n = new Vector3(p.x, (p.y - centreY) * 0.6, p.z);
      if (n.lengthSquared() < 1e-4) n.set(0, 1, 0);
      n.normalize();
      n.y += 0.2; // bias up a little: canopies are lit mostly from the overcast sky
      n.normalize();
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(u, v);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  mesh(name, scene) {
    const m = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.pos; vd.normals = this.nrm; vd.uvs = this.uv; vd.indices = this.idx;
    vd.applyToMesh(m);
    return m;
  }
}

/** Rotation that yaws around Y, then pitches the local +x axis up (positive) or down (negative), then rolls around it. */
function orient(yaw, pitch, roll) {
  const q = Quaternion.RotationYawPitchRoll(0, 0, 0);
  const qRoll = Quaternion.RotationAxis(new Vector3(1, 0, 0), roll);
  const qPitch = Quaternion.RotationAxis(new Vector3(0, 0, 1), pitch);
  const qYaw = Quaternion.RotationAxis(new Vector3(0, 1, 0), -yaw);
  qYaw.multiplyToRef(qPitch, q); // yaw ∘ pitch
  q.multiplyInPlace(qRoll);      // ∘ roll
  return q;
}

function limb(scene, from, to, radius) {
  const d = to.subtract(from);
  const len = d.length();
  const c = CreateCylinder("limb", { height: len, diameterTop: radius * 1.2, diameterBottom: radius * 2, tessellation: 5 }, scene);
  c.position = from.add(d.scale(0.5));
  const axis = Vector3.Cross(Vector3.Up(), d.normalize());
  const ang = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(Vector3.Up(), d.normalize()))));
  c.rotationQuaternion = axis.lengthSquared() < 1e-8 ? Quaternion.Identity() : Quaternion.RotationAxis(axis.normalize(), ang);
  c.bakeCurrentTransformIntoVertices();
  return c;
}

function materials(scene) {
  if (scene.__pineMats) return scene.__pineMats;
  const bark = new PBRMaterial("pineBark", scene);
  bark.albedoTexture = new Texture(TEX + "pine_bark_diff_1k.jpg", scene);
  bark.bumpTexture = new Texture(TEX + "pine_bark_nor_gl_1k.jpg", scene);
  for (const t of [bark.albedoTexture, bark.bumpTexture]) { t.uScale = 1; t.vScale = 4; }
  bark.albedoColor = new Color3(0.72, 0.68, 0.64);
  bark.metallic = 0; bark.roughness = 0.85;

  const mk = (name, file) => {
    const m = new PBRMaterial(name, scene);
    const t = new Texture(TEX + file, scene);
    t.hasAlpha = true;
    t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE;
    m.albedoTexture = t;
    m.useAlphaFromAlbedoTexture = true;
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
    m.alphaCutOff = 0.45;
    m.backFaceCulling = false;
    m.twoSidedLighting = true;
    m.metallic = 0; m.roughness = 0.9;
    m.metallicF0Factor = 0.3;     // needles are matte: weak sky specular (it read as frost from above)
    m.environmentIntensity = 0.75;
    // Pull the dry yellow tips of the twig photo toward the deep blue-green of wet pines.
    m.albedoColor = new Color3(0.34, 0.45, 0.36);
    // Thin needles let light through: a touch of translucency keeps backlit crowns from going black.
    m.subSurface.isTranslucencyEnabled = true;
    m.subSurface.translucencyIntensity = 0.2;
    m.subSurface.tintColor = new Color3(0.45, 0.6, 0.3);
    return m;
  };
  scene.__pineMats = { bark, branch: mk("pineBranch", "pine_branch.webp"), tuft: mk("pineTuft", "pine_tuft.webp") };
  return scene.__pineMats;
}

/** Merge wood (trunk + limbs) and needle cards into one mesh with a 3-slot multi-material. */
function assemble(name, scene, wood, branchCards, tuftCards) {
  const mats = materials(scene);
  const trunk = Mesh.MergeMeshes(wood, true, true);
  const parts = [trunk, branchCards.mesh(name + "B", scene), tuftCards.mesh(name + "T", scene)];
  // One submesh per part (material index 0/1/2), then a shared multi-material over them.
  const merged = Mesh.MergeMeshes(parts, true, true, undefined, true, false);
  merged.name = name;
  merged.subMeshes.forEach((sm, i) => { sm.materialIndex = i; });
  scene.__pineMulti ||= Object.assign(new MultiMaterial("pineMulti", scene), { subMaterials: [mats.bark, mats.branch, mats.tuft] });
  merged.material = scene.__pineMulti;
  return merged;
}

/**
 * Conifer from whorls of branch cards around a trunk. Each branch = a flat card (silhouette) plus a
 * crossed card (reads from above/below). Options:
 *   spread     branch length multiplier            clear     bare trunk height (m)
 *   gap        metres between whorls               perWhorl  branches per whorl (min)
 *   lift(t)    branch pitch at crown height t∈[0,1] (+ = upswept)
 *   reach(t)   branch length profile (m) at t
 */
function whorled(name, scene, seed, H, { spread = 1, clear = 1, gap = 0.4, perWhorl = 6, lift, reach, trunkD = 0.36 }) {
  const r = rng(seed);
  const wood = [CreateCylinder("trunk", { height: H, diameterTop: 0.06, diameterBottom: trunkD, tessellation: 8 }, scene)];
  wood[0].position.y = H / 2;
  wood[0].bakeCurrentTransformIntoVertices();
  const branches = new CardBuilder(), tufts = new CardBuilder();
  const centreY = clear + (H - clear) * 0.45;
  for (let y = clear; y < H - 0.3; y += gap * (0.8 + r() * 0.5)) {
    const t = (y - clear) / (H - clear);
    const n = perWhorl + Math.floor(r() * 3);
    const twist = r() * Math.PI;
    for (let i = 0; i < n; i++) {
      if (r() < 0.15) continue; // gaps make the crown irregular
      const len = reach(t) * spread * (0.75 + r() * 0.5);
      const yaw = twist + (i / n) * Math.PI * 2 + (r() - 0.5) * 0.5;
      const pitch = lift(t) + (r() - 0.5) * 0.15;
      const pos = new Vector3(0, y, 0);
      branches.quad(Matrix.Compose(new Vector3(1, 1, 1), orient(yaw, pitch, Math.PI / 2 + (r() - 0.5) * 0.4), pos), len, len * 0.55, centreY);
      branches.quad(Matrix.Compose(new Vector3(1, 1, 1), orient(yaw, pitch, (r() - 0.5) * 0.4), pos), len, len * 0.4, centreY);
      if (len > 1.6) { // long branches get a visible bare limb near the trunk
        // same direction orient() gives the card's +x axis: (cos yaw·cos pitch, sin pitch, sin yaw·cos pitch)
        const d = new Vector3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch));
        wood.push(limb(scene, pos, pos.add(d.scale(len * 0.35)), 0.035));
      }
    }
  }
  for (let i = 0; i < 3; i++) {
    const s = 0.7 * spread + 0.4;
    tufts.quad(Matrix.Compose(new Vector3(1, 1, 1), orient(r() * Math.PI, 0, (i / 3) * Math.PI), new Vector3(0, H - s * 0.35, 0)), s, s * 1.3, centreY, -s / 2);
  }
  return assemble(name, scene, wood, branches, tufts);
}

// Scots-type pine: tall clear trunk, open irregular crown of long, upswept branches.
const buildPine = (name, scene, seed, H) => whorled(name, scene, seed, H, {
  clear: H * 0.5, gap: 0.7, perWhorl: 4, trunkD: 0.5,
  reach: (t) => 2.6 * Math.pow(1 - t, 0.6) + 0.6,
  lift: (t) => -0.12 + t * 0.45,
});
// Fir: dense cone of drooping whorls almost to the ground.
const buildFir = (name, scene, seed, H, spread, clear) => whorled(name, scene, seed, H, {
  spread, clear, gap: 0.38, perWhorl: 6, trunkD: 0.36 * spread + 0.12,
  reach: (t) => Math.pow(1 - t, 0.85) * 3.0 + 0.35,
  lift: (t) => -(0.15 + (1 - t) * 0.35),
});

/**
 * Hidden template meshes to instance. Heights are nominal; scale instances for variety.
 * @returns {{ pine: Mesh[], fir: Mesh[], cypress: Mesh[] }}
 */
export function createPineTemplates(scene) {
  const hide = (m) => { m.isVisible = false; m.isPickable = false; m.checkCollisions = false; m.metadata = { perimeter: true }; return m; };
  return {
    pine: [buildPine("pineA", scene, 11, 16), buildPine("pineB", scene, 23, 13), buildPine("pineC", scene, 37, 18)].map(hide),
    fir: [buildFir("firA", scene, 5, 12, 1, 1.0), buildFir("firB", scene, 9, 9, 0.85, 0.6)].map(hide),
    cypress: [buildFir("cypressA", scene, 17, 9, 0.32, 0.4)].map(hide),
  };
}
