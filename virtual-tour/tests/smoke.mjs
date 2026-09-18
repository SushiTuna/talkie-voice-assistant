// Builds a minimal glTF (10x10 floor + 4 walls, embedded base64 buffer) and
// smoke-tests the virtual-tour core logic under Babylon's NullEngine.
const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js");
import { Scene } from "@babylonjs/core/scene.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";

// ---- geometry: floor + 4 walls (quads, CCW seen from inside) ----
const V = []; // positions
const I = [];
let vi = 0;
function quad(a, b, c, d) {
  V.push(...a, ...b, ...c, ...d);
  I.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
  vi += 4;
}
quad([-5, 0, -5], [-5, 0, 5], [5, 0, 5], [5, 0, -5]);        // floor (normal +y)
quad([-5, 0, -5], [5, 0, -5], [5, 2.5, -5], [-5, 2.5, -5]);  // south wall
quad([5, 0, 5], [-5, 0, 5], [-5, 2.5, 5], [5, 2.5, 5]);      // north wall
quad([-5, 0, 5], [-5, 0, -5], [-5, 2.5, -5], [-5, 2.5, 5]);  // west wall
quad([5, 0, -5], [5, 0, 5], [5, 2.5, 5], [5, 2.5, -5]);      // east wall

const pos = new Float32Array(V);
const idx = new Uint16Array(I);
const pad = (n) => (n % 4 === 0 ? n : n + (4 - (n % 4)));
const bin = Buffer.alloc(pad(pos.byteLength + idx.byteLength));
Buffer.from(pos.buffer).copy(bin, 0);
Buffer.from(idx.buffer).copy(bin, pos.byteLength);
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3)
  for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], pos[i + k]);
    max[k] = Math.max(max[k], pos[i + k]);
  }

const gltf = {
  asset: { version: "2.0" },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: "Room" }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min, max },
    { bufferView: 1, componentType: 5123, count: idx.length, type: "SCALAR" },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
    { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
  ],
  buffers: [{ uri: `data:application/octet-stream;base64,${bin.toString("base64")}`, byteLength: bin.length }],
};

// ---- NullEngine smoke test ----
const engine = new NullEngine();
const scene = new Scene(engine);
const before = new Set(scene.meshes.map((m) => m.uniqueId));
const uri = `data:model/gltf+json;base64,${Buffer.from(JSON.stringify(gltf)).toString("base64")}`;
await ImportMeshAsync(uri, scene, { pluginExtension: ".gltf" });
const fresh = scene.meshes.filter((m) => !before.has(m.uniqueId));
console.log("meshes loaded:", fresh.length, fresh.map((m) => m.name).join(","));
if (!fresh.length) throw new Error("glTF parse produced no meshes");

for (const m of fresh) { m.checkCollisions = true; m.isPickable = true; }
scene.collisionsEnabled = true;

// bounds (same code path as main.js)
function boundsOf(list) {
  const mn = new Vector3(Infinity, Infinity, Infinity), mx = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const r of list) { const v = r.getHierarchyBoundingVectors(true); mn.minimizeInPlace(v.min); mx.maximizeInPlace(v.max); }
  return { min: mn, max: mx };
}
let { min: bmin, max: bmax } = boundsOf(fresh);
console.log("bounds min", bmin.asArray(), "max", bmax.asArray());
const horiz = Math.max(bmax.x - bmin.x, bmax.z - bmin.z);
console.log("horizontal size:", horiz.toFixed(2), "→ scale needed:", horiz > 40 || horiz < 5);

// spawn search (same algorithm as main.js)
const N = 16, pickable = (m) => m.checkCollisions && m.isEnabled();
let best = null;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x = bmin.x + ((bmax.x - bmin.x) * (i + 0.5)) / N;
  const z = bmin.z + ((bmax.z - bmin.z) * (j + 0.5)) / N;
  const down = new Ray(new Vector3(x, bmax.y + 1, z), Vector3.Down(), bmax.y - bmin.y + 4);
  const floor = scene.pickWithRay(down, pickable);
  if (!floor?.hit) continue;
  const floorY = floor.pickedPoint.y;
  const up = new Ray(new Vector3(x, floorY + 0.1, z), Vector3.Up(), 8);
  const ceil = scene.pickWithRay(up, pickable);
  const clearance = (ceil?.hit ? ceil.distance : 8) - 0.1;
  if (!best || clearance > best.clearance) best = { pos: new Vector3(x, floorY, z), clearance };
}
console.log("spawn:", best ? `${best.pos.asArray()} clearance ${best.clearance.toFixed(2)}` : "NONE");
if (!best || Math.abs(best.pos.y) > 0.01) throw new Error("spawn search failed");

// camera construction (no DOM attach)
const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera.js");
const fp = new FreeCamera("fp", best.pos.add(new Vector3(0, 1.22, 0)), scene);
fp.checkCollisions = true; fp.applyGravity = true;
fp.ellipsoid = new Vector3(0.35, 1.2, 0.35);
fp.keysUp = [87]; fp.keysDown = [83]; fp.keysLeft = [65]; fp.keysRight = [68];
scene.gravity = new Vector3(0, -9.81, 0);
scene.activeCamera = fp;
for (let k = 0; k < 30; k++) scene.render();
console.log("camera after 30 frames:", fp.position.asArray().map((n) => n.toFixed(2)));
console.log("SMOKE TEST PASSED");
engine.dispose();
