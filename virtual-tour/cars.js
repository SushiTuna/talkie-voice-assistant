// The two cars parked under the house. The model's own cars were cut out of the GLB; these replace
// them at the same spots. Both files are prepared offline (meshes merged by material, real-world
// length, wheels on y = 0, centred, front towards +z, quantized):
//   garage_ferrari_sf90.glb  ← props/2021_ferrari_sf90_spider.glb   (4.704 m long)
//   garage_porsche_911_gt3.glb ← props/porsche_911_gt3.glb        (4.573 m)
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";

const HEADLIGHT = new Color3(1.0, 0.95, 0.85); // cool-warm LED white
const TAILLIGHT = new Color3(1.0, 0.04, 0.02);

/**
 * Switch the car's lamps on. Both models share one textured material ("LightA") for the front and
 * rear lamp units, so that mesh is split by triangle into front and rear halves (along the car's
 * length) with a white-glowing and a red-glowing copy of the material; the red "RED_GLASS" tail-lamp
 * covers glow too. Flat emissive colour, not the lamp texture: the atlas is mostly dark grey there,
 * which left the lamps looking off. Bright enough to cross the pipeline's bloom threshold.
 */
function lightsOn(meshes) {
  for (const mesh of meshes) {
    const mat = mesh.material;
    if (mat?.name === "RED_GLASS") {
      mat.emissiveColor = TAILLIGHT;
      mat.emissiveIntensity = 2;
      continue;
    }
    if (!/LightA_Material$/.test(mat?.name ?? "")) continue;
    const pos = mesh.getVerticesData("position");
    const idx = mesh.getIndices();
    if (!pos || !idx) continue;
    // Front is +z in the mesh's own (glTF) space; split at the middle of the lamp mesh's z range.
    let z0 = Infinity, z1 = -Infinity;
    for (let i = 2; i < pos.length; i += 3) { z0 = Math.min(z0, pos[i]); z1 = Math.max(z1, pos[i]); }
    const mid = (z0 + z1) / 2;
    const front = [], rear = [];
    for (let i = 0; i < idx.length; i += 3) {
      const z = pos[idx[i] * 3 + 2] + pos[idx[i + 1] * 3 + 2] + pos[idx[i + 2] * 3 + 2];
      (z > mid * 3 ? front : rear).push(idx[i], idx[i + 1], idx[i + 2]);
    }
    const glow = (suffix, color, intensity) => {
      const m = mat.clone(mat.name + suffix);
      m.emissiveColor = color;
      m.emissiveIntensity = intensity;
      return m;
    };
    const multi = new MultiMaterial(mat.name + "-lit", mesh.getScene());
    multi.subMaterials.push(glow("-head", HEADLIGHT, 1.6), glow("-tail", TAILLIGHT, 1.4));
    const n = mesh.getTotalVertices();
    mesh.setIndices([...front, ...rear], n);
    mesh.subMeshes = [];
    new SubMesh(0, 0, n, 0, front.length, mesh);
    new SubMesh(1, 0, n, front.length, rear.length, mesh);
    mesh.material = multi;
  }
}

// Parking spots in the house model's raw (glTF mesh) units — the centres of the original cars —
// and the direction their headlights faced (raw +z). Converted to world space through a model mesh.
const SPOTS = [
  { url: "/models/props/garage_ferrari_sf90.glb", name: "ferrari", raw: [2225, -3380, 1900] },
  { url: "/models/props/garage_porsche_911_gt3.glb", name: "porsche", raw: [7000, -3380, 1900] },
];

/**
 * Load both cars and park them. They cast and receive shadows, and
 * get an invisible box collider so the walk camera goes around them rather than onto the roof.
 * @param ref      a mesh of the house model (its world matrix maps raw model units → world)
 * @param floorY   world height the tyres stand on (top of the paving)
 * @param shadows  the sun's ShadowGenerator (optional)
 */
export async function addGarageCars(scene, { ref, floorY, shadows = null }) {
  const W = ref.computeWorldMatrix(true);
  const results = await Promise.allSettled(SPOTS.map(async (spot) => {
    const res = await ImportMeshAsync(spot.url, scene);
    const centre = Vector3.TransformCoordinates(new Vector3(...spot.raw), W);
    const ahead = Vector3.TransformCoordinates(new Vector3(spot.raw[0], spot.raw[1], spot.raw[2] + 1000), W).subtract(centre);
    const holder = new TransformNode(`car-${spot.name}`, scene);
    holder.position.set(centre.x, floorY, centre.z);
    holder.rotation.y = Math.atan2(ahead.x, ahead.z); // model front (+z) → the original car's heading
    res.meshes[0].parent = holder; // glTF __root__ (handedness flip keeps the front on +z)

    const meshes = res.meshes.filter((m) => m.getTotalVertices() > 0);
    for (const m of meshes) {
      m.isPickable = false;
      m.checkCollisions = false; // the box below handles collisions (cheaper, and no climbing the roof)
      m.receiveShadows = true;
      shadows?.addShadowCaster(m, false);
      if (m.material) m.material.maxSimultaneousLights = 8; // sun + hemi + the warm carport lights
    }
    // The body paint ships with a full mirror clear coat (intensity 1, roughness 0). Under the bright
    // overcast HDRI plus the exposure/contrast grade it reflects white sky over the whole body and
    // washes the colour out; a faint, slightly soft coat on a glossier base keeps the paint's hue.
    for (const mat of new Set(meshes.map((m) => m.material))) {
      if (!/Paint_Material$/.test(mat?.name ?? "") || !mat.clearCoat?.isEnabled) continue;
      mat.clearCoat.intensity = 0.12;
      mat.clearCoat.roughness = 0.15;
      mat.roughness = 0.4;
    }
    lightsOn(meshes);

    const { min, max } = holder.getHierarchyBoundingVectors(true);
    const box = CreateBox(`car-${spot.name}-collider`, {
      width: max.x - min.x, height: max.y - min.y, depth: max.z - min.z,
    }, scene);
    box.position.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    box.isVisible = false;
    box.isPickable = false;
    box.checkCollisions = true;
    return holder;
  }));
  for (const r of results) if (r.status === "rejected") console.warn("garage car unavailable:", r.reason);
  return results.filter((r) => r.status === "fulfilled").map((r) => r.value);
}
