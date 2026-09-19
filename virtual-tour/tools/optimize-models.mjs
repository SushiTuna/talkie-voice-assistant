// Rebuilds the served models/textures from their originals in */source/, losslessly, and proves it:
//   GLB: meshopt-compressed geometry (EXT_meshopt_compression, no quantization, no filters, so
//        every vertex attribute is bit-exact) and PNG textures re-encoded as lossless WebP.
//   PNG: lossless WebP with `-exact`, which keeps the colour under fully transparent pixels (it
//        bleeds into visible texels through mipmaps/filtering, so dropping it would show).
// Every output is decoded again and compared with its original (triangles, nodes, pixels); any
// difference aborts. Also regenerates vendor/meshopt_decoder.js, which the page loads to decode.
//
// Usage: npm run optimize          (needs `cwebp` on PATH: brew install webp)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { NodeIO, PropertyType } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP } from "@gltf-transform/extensions";
import { dedup, reorder } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GLBS = [
  "models/source/modular_house_cube_3_by_swanbuild_australia.glb",
  "models/props/source/garage_ferrari_sf90.glb",
  "models/props/source/garage_porsche_911_gt3.glb",
  "models/props/source/broadleaf_trees.glb",
];
const PNGS = ["assets/tex/source/pine_branch.png", "assets/tex/source/pine_tuft.png"];

const tmp = mkdtempSync(join(tmpdir(), "optimize-models-"));
let tmpN = 0;
function webpExact(png) {
  const i = join(tmp, `${tmpN}.png`), o = join(tmp, `${tmpN++}.webp`);
  writeFileSync(i, png);
  execFileSync("cwebp", ["-quiet", "-lossless", "-exact", "-z", "9", "-metadata", "icc", i, "-o", o]);
  return readFileSync(o);
}
const rgba = (buf) => sharp(buf).ensureAlpha().raw().toBuffer();
async function assertSamePixels(a, b, what) {
  if (!(await rgba(a)).equals(await rgba(b))) throw new Error(`${what}: pixels differ after WebP encoding`);
}
/** Only plain 8-bit PNGs: WebP can't carry 16-bit data or gAMA/cHRM colour tags. */
async function webpSafe(png) {
  const meta = await sharp(png).metadata();
  const header = png.subarray(0, png.indexOf("IDAT")).toString("latin1");
  return meta.depth === "uchar" && !/gAMA|cHRM|iCCP|sRGB/.test(header);
}
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });

/** Triangles (as vertex-attribute tuples, rotation-normalised) and nodes, order-independent. */
async function signature(path) {
  const doc = await io.read(path);
  const prims = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    mesh.listPrimitives().forEach((prim, p) => {
      const sems = prim.listSemantics().sort();
      const idx = prim.getIndices()?.getArray();
      const n = idx ? idx.length : prim.getAttribute("POSITION").getCount();
      const corner = (i) => sems.map((s) => prim.getAttribute(s).getElement(i, []).join(",")).join("|");
      const tris = [];
      for (let t = 0; t < n; t += 3) {
        const c = [0, 1, 2].map((k) => corner(idx ? idx[t + k] : t + k));
        const r = c.indexOf([...c].sort()[0]); // same triangle, same winding, any start corner
        tris.push(`${c[r]}#${c[(r + 1) % 3]}#${c[(r + 2) % 3]}`);
      }
      const h = createHash("sha1").update(tris.sort().join("\n")).digest("hex");
      prims.push(`${mesh.getName()}/${p}/${prim.getMode()}/${prim.getMaterial()?.getName()}/${h}`);
    });
  }
  const nodes = doc.getRoot().listNodes().map((n) => `${n.getName()} ${n.getMatrix().join(",")} ${n.getMesh()?.getName()}`);
  return JSON.stringify([prims.sort(), nodes.sort()]);
}

for (const rel of GLBS) {
  const src = join(ROOT, rel);
  const out = join(ROOT, dirname(dirname(rel)), basename(rel));
  const doc = await io.read(src);
  await doc.transform(
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE] }),
    reorder({ encoder: MeshoptEncoder, target: "size" }),
  );
  let webp = false;
  for (const tex of doc.getRoot().listTextures()) {
    if (tex.getMimeType() !== "image/png") continue;
    const png = Buffer.from(tex.getImage());
    if (!(await webpSafe(png))) continue;
    const w = webpExact(png);
    if (w.length > png.length * 0.95) continue;
    await assertSamePixels(png, w, `${rel} texture "${tex.getName()}"`);
    tex.setImage(new Uint8Array(w)).setMimeType("image/webp");
    webp = true;
  }
  if (webp) doc.createExtension(EXTTextureWebP).setRequired(true);
  doc.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE }); // QUANTIZE = no lossy filters
  await io.write(out, doc);
  if ((await signature(src)) !== (await signature(out))) throw new Error(`${rel}: geometry changed`);
  console.log(`${basename(out)}: ${kb(statSync(src).size)} → ${kb(statSync(out).size)} (geometry identical)`);
}

for (const rel of PNGS) {
  const src = join(ROOT, rel);
  const out = join(ROOT, dirname(dirname(rel)), basename(rel).replace(/\.png$/i, ".webp"));
  const png = readFileSync(src);
  if (!(await webpSafe(png))) throw new Error(`${rel}: not a plain 8-bit PNG, can't convert losslessly`);
  const w = webpExact(png);
  await assertSamePixels(png, w, rel);
  writeFileSync(out, w);
  console.log(`${basename(out)}: ${kb(png.length)} → ${kb(w.length)} (pixels identical)`);
}

const decoder = readFileSync(join(ROOT, "node_modules/meshoptimizer/meshopt_decoder.mjs"), "utf8");
const version = JSON.parse(readFileSync(join(ROOT, "node_modules/meshoptimizer/package.json"), "utf8")).version;
writeFileSync(join(ROOT, "vendor/meshopt_decoder.js"),
  `// meshoptimizer ${version} decoder (MIT, github.com/zeux/meshoptimizer) as a classic script defining\n` +
  "// the global MeshoptDecoder, which Babylon's EXT_meshopt_compression loader expects. Generated from\n" +
  "// node_modules/meshoptimizer/meshopt_decoder.mjs by tools/optimize-models.mjs — don't edit.\n" +
  decoder.replace(/^export \{ MeshoptDecoder \};\s*$/m, ""));
console.log(`meshopt_decoder.js: meshoptimizer ${version}`);
rmSync(tmp, { recursive: true, force: true });
