// Analyzes a real GLB with the same logic as main.js: import, bounds, scale, spawn search.
import { readFileSync } from "node:fs";
const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js");
import { Scene } from "@babylonjs/core/scene.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";

const file = process.argv[2];
const engine = new NullEngine();
const scene = new Scene(engine);
const before = new Set(scene.meshes.map((m) => m.uniqueId));
const buf = new Uint8Array(readFileSync(file));
await ImportMeshAsync(buf, scene, { pluginExtension: ".glb" });
const fresh = scene.meshes.filter((m) => !before.has(m.uniqueId));
for (const m of fresh) { m.checkCollisions = true; m.isPickable = true; }
scene.collisionsEnabled = true;

function boundsOf(list) {
  const mn = new Vector3(Infinity, Infinity, Infinity), mx = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const r of list) { const v = r.getHierarchyBoundingVectors(true); mn.minimizeInPlace(v.min); mx.maximizeInPlace(v.max); }
  return { min: mn, max: mx };
}
const freshIds = new Set(fresh.map((m) => m.uniqueId));
const roots = fresh.filter((m) => {
  for (let p = m.parent; p; p = p.parent) if (freshIds.has(p.uniqueId)) return false;
  return true;
});
let { min, max } = boundsOf(roots);
const horiz = Math.max(max.x - min.x, max.z - min.z);
console.log(`file=${file} meshes=${fresh.length} materials=${scene.materials.length}`);
console.log(`bounds min=[${min.asArray().map(n=>n.toFixed(2))}] max=[${max.asArray().map(n=>n.toFixed(2))}] horiz=${horiz.toFixed(2)}m`);
if (horiz > 40 || horiz < 5) {
  const s = 14 / horiz;
  for (const r of roots) r.scaling.scaleInPlace(s);
  ({ min, max } = boundsOf(roots));
  console.log(`scaled by ${s.toFixed(3)} -> horiz=${(max.x-min.x).toFixed(1)}x${(max.z-min.z).toFixed(1)}`);
}
const N = 24, pickable = (m) => m.checkCollisions && m.isEnabled();
let best = null, hits = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x = min.x + ((max.x - min.x) * (i + 0.5)) / N;
  const z = min.z + ((max.z - min.z) * (j + 0.5)) / N;
  const floor = scene.pickWithRay(new Ray(new Vector3(x, max.y + 1, z), Vector3.Down(), max.y - min.y + 4), pickable);
  if (!floor?.hit) continue;
  hits++;
  const floorY = floor.pickedPoint.y;
  const ceil = scene.pickWithRay(new Ray(new Vector3(x, floorY + 0.1, z), Vector3.Up(), 8), pickable);
  const clearance = (ceil?.hit ? ceil.distance : 8) - 0.1;
  if (!best || clearance > best.clearance) best = { pos: new Vector3(x, floorY, z), clearance };
}
console.log(`floor hits: ${hits}/${N*N}, best spawn=${best ? `${best.pos.asArray().map(n=>n.toFixed(1))} clearance=${best.clearance.toFixed(2)}` : "NONE"}`);
engine.dispose();
