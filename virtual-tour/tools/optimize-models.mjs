// Rebuilds the served models/textures from their originals in */source/.
//   GLB: lossy, tuned per asset in ASSETS and checked by before/after screenshots
//        (SHOTS_DIR=… node tests/anchor-shots.mjs), since nothing here is bit-exact any more:
//        quantized + meshopt-filtered geometry (KHR_mesh_quantization, EXT_meshopt_compression),
//        textures resized per slot and re-encoded as lossy WebP, the cars simplified, tangents
//        dropped where no normal map reads them, and textures restyleModel (mood.js) discards removed.
//        Every node, mesh and material keeps its name (the page matches them by regex).
//   PNG: lossless WebP with `-exact`, which keeps the colour under fully transparent pixels (it
//        bleeds into visible texels through mipmaps/filtering, so dropping it would show).
// Aborts if a name, node or material goes missing or a mesh loses more triangles than its budget.
// Also regenerates vendor/meshopt_decoder.js, which the page loads to decode.
//
// Usage: npm run optimize          (needs `cwebp` on PATH: brew install webp)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO, PropertyType } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP } from "@gltf-transform/extensions";
import { dedup, meshopt, quantize, reorder, prune, simplify, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Per asset: `px` caps colour maps and `dataPx` normal/roughness maps (longest side, never upscaled);
// `pxFor` lowers the cap for materials whose name matches; `simplify` is meshoptimizer's target
// triangle ratio and max error (fraction of the mesh extent), `minTris` the lowest ratio accepted.
const ASSETS = [
  {
    src: "models/source/modular_house_cube_3_by_swanbuild_australia.glb",
    px: 1024, dataPx: 1024,
    pxFor: [[/^GDLM6\d_/, 512]], // the people and small props: never seen from closer than a metre or so
    dropBaseColor: /^(ED_CONCRETE|Metal_-_Iron)$/, // restyleModel swaps in pavers / nulls the albedo
    stripTangents: true, keepTangents: /^ED_CONCRETE$/, // the pavers restyleModel puts there have a normal map
    // Positions stay float: quantizing adds a scale/offset to every node, and cars.js places the cars
    // through the house's node matrix (house-local coordinates), which would then put them elsewhere.
    floatPositions: true,
  },
  { src: "models/props/source/garage_ferrari_sf90.glb", px: 1024, dataPx: 1024, simplify: { ratio: 0.5, error: 0.0005 }, minTris: 0.45 },
  { src: "models/props/source/garage_porsche_911_gt3.glb", px: 1024, dataPx: 1024, simplify: { ratio: 0.5, error: 0.0005 }, minTris: 0.45 },
  { src: "models/props/source/broadleaf_trees.glb", px: 512, dataPx: 512 }, // mid/far forest only
  { src: "models/props/source/mountain_low_poly_for_distant_mountains.glb", px: 512, dataPx: 256 }, // horizon only
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

const SLOTS = { BaseColor: "color", Emissive: "color", Normal: "normal" }; // anything else: "data"

/** Material names, slot kinds and alpha use of `tex`. */
function usesOf(tex) {
  const mats = new Set(), kinds = new Set();
  let alpha = false;
  for (const mat of tex.listParents()) {
    if (mat.propertyType !== PropertyType.MATERIAL) { kinds.add("data"); continue; } // clearcoat, specular…
    mats.add(mat.getName());
    let found = false;
    for (const [slot, kind] of Object.entries(SLOTS)) {
      if (mat[`get${slot}Texture`]() !== tex) continue;
      kinds.add(kind); found = true;
      if (slot === "BaseColor" && mat.getAlphaMode() !== "OPAQUE") alpha = true;
    }
    if (!found) kinds.add("data");
  }
  return { mats: [...mats], kind: kinds.has("color") ? "color" : kinds.has("normal") ? "normal" : "data", alpha };
}

/**
 * Lossy WebP, resized to the asset's cap. Colour maps: quality 85 with sharp YUV. Normal maps:
 * near-lossless (no chroma subsampling, which would bend the XY vectors). Alpha: exact, full quality
 * (MASK cut-outs flicker at the edges otherwise). Returns null when that wouldn't save anything.
 */
async function compressTexture(tex, asset) {
  const src = Buffer.from(tex.getImage());
  const { mats, kind, alpha } = usesOf(tex);
  let cap = kind === "color" ? asset.px : asset.dataPx;
  for (const [re, px] of asset.pxFor ?? []) if (mats.some((m) => re.test(m))) cap = Math.min(cap, px);
  const meta = await sharp(src).metadata();
  const resized = Math.max(meta.width, meta.height) > cap;
  let img = sharp(src);
  if (resized) img = img.resize({ width: cap, height: cap, fit: "inside", kernel: "lanczos3" });
  const out = await img.webp(kind === "normal"
    ? { nearLossless: true, quality: 60, effort: 6, alphaQuality: 100, exact: alpha }
    : { quality: 85, smartSubsample: true, effort: 6, alphaQuality: 100, exact: alpha }).toBuffer();
  if (!resized && out.length > src.length * 0.9) return null;
  const m2 = await sharp(out).metadata();
  return { out, note: `${kind}${alpha ? "+alpha" : ""} ${meta.width}x${meta.height}→${m2.width}x${m2.height} ${kb(src.length)}→${kb(out.length)}` };
}

const triangles = (doc) => doc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives().map((p) => {
  const idx = p.getIndices();
  return [`${mesh.getName()}/${mesh.listPrimitives().indexOf(p)}`, (idx ? idx.getCount() : p.getAttribute("POSITION").getCount()) / 3];
}));
const names = (doc) => JSON.stringify(["listNodes", "listMeshes", "listMaterials"]
  .map((l) => doc.getRoot()[l]().map((x) => x.getName()).sort()));

const report = [];
for (const asset of ASSETS) {
  const rel = asset.src;
  const src = join(ROOT, rel);
  const out = join(ROOT, dirname(dirname(rel)), basename(rel));
  const prevSize = statSync(out, { throwIfNoEntry: false })?.size;
  const doc = await io.read(src);
  const before = { names: names(doc), tris: new Map(triangles(doc)) };

  if (asset.dropBaseColor) {
    for (const mat of doc.getRoot().listMaterials()) if (asset.dropBaseColor.test(mat.getName())) mat.setBaseColorTexture(null);
  }
  if (asset.stripTangents) {
    for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat?.getNormalTexture() && !asset.keepTangents?.test(mat?.getName() ?? "")) prim.setAttribute("TANGENT", null);
    }
  }
  await doc.transform(
    prune({ propertyTypes: [PropertyType.TEXTURE, PropertyType.ACCESSOR], keepAttributes: true, keepLeaves: true }),
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE] }),
    weld(),
    ...(asset.simplify ? [simplify({ simplifier: MeshoptSimplifier, lockBorder: true, ...asset.simplify })] : []),
  );

  const texNotes = [];
  for (const tex of doc.getRoot().listTextures()) {
    const r = await compressTexture(tex, asset);
    if (!r) continue;
    tex.setImage(new Uint8Array(r.out)).setMimeType("image/webp");
    texNotes.push(r.note);
  }
  if (doc.getRoot().listTextures().some((t) => t.getMimeType() === "image/webp")) doc.createExtension(EXTTextureWebP).setRequired(true);

  if (asset.floatPositions) {
    // Everything but POSITION quantized; meshopt without filters (QUANTIZE method).
    await doc.transform(reorder({ encoder: MeshoptEncoder, target: "size" }), quantize({ pattern: /^(NORMAL|TANGENT|TEXCOORD_\d+|COLOR_\d+)$/ }));
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  } else {
    // "high": positions/UVs/colours quantized, normals octahedral-filtered by the encoder.
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: "high" }));
  }
  await io.write(out, doc);

  const after = await io.read(out);
  if (names(after) !== before.names) throw new Error(`${rel}: a node, mesh or material name changed`);
  const minTris = asset.minTris ?? 0.999;
  for (const [key, n] of triangles(after)) {
    const n0 = before.tris.get(key);
    if (n0 === undefined || n < n0 * minTris) throw new Error(`${rel}: ${key} has ${n} of ${n0} triangles (budget ${minTris})`);
  }
  const t0 = [...before.tris.values()].reduce((a, b) => a + b, 0), t1 = triangles(after).reduce((a, [, n]) => a + n, 0);
  report.push({ file: basename(out), prev: prevSize, size: statSync(out).size, tris: `${t0} → ${t1}` });
  console.log(`${basename(out)}: ${prevSize ? kb(prevSize) : "–"} → ${kb(statSync(out).size)}, triangles ${t0} → ${t1}`);
  for (const n of texNotes) console.log(`    ${n}`);
}
const mb = (n) => (n / 1048576).toFixed(2);
console.table(report.map((r) => ({ file: r.file, "previous build MB": r.prev ? mb(r.prev) : "–", "after MB": mb(r.size),
  saved: r.prev ? `${Math.round((1 - r.size / r.prev) * 100)}%` : "–", triangles: r.tris })));

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
