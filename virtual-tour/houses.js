// Procedural suburban houses for the neighbourhood: textured walls (brick / weatherboard / render),
// gable roofs with eaves (tile / corrugated), framed windows with sills, front door with step and
// awning, optional garage door and chimney, one or two storeys. Each house is merged into a single
// multi-material mesh to keep draw calls low. Textures are drawn on canvases (no image assets).
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import "@babylonjs/core/Materials/multiMaterial.js";

const STOREY = 2.8; // metres floor-to-floor

/** Canvas-drawn tileable textures; `metres` = real-world size one texture repeat covers. */
function canvasTexture(scene, name, size, draw) {
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  draw(tex.getContext(), size);
  tex.update();
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

function makeTextures(scene) {
  const noise = (ctx, s, n, alpha) => {
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? "0,0,0" : "255,255,255"},${Math.random() * alpha})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
  };
  return {
    // 1 repeat = 1 m: 13 courses of 75 mm bricks, stretcher bond.
    brick: canvasTexture(scene, "brickTex", 512, (ctx, s) => {
      ctx.fillStyle = "#c9c1b4"; ctx.fillRect(0, 0, s, s); // mortar
      const rows = 13, bh = s / rows, bw = s / 4.3;
      for (let r = 0; r < rows; r++) for (let c = -1; c < 6; c++) {
        const x = c * bw + (r % 2 ? bw / 2 : 0);
        const shade = 150 + Math.random() * 45;
        ctx.fillStyle = `rgb(${shade},${shade * 0.52},${shade * 0.38})`;
        ctx.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
      }
      noise(ctx, s, 5000, 0.12);
    }),
    // 1 repeat = 1 m: 6 painted boards with shadow lines (white, tinted by material colour).
    weatherboard: canvasTexture(scene, "boardTex", 256, (ctx, s) => {
      const n = 6, h = s / n;
      for (let i = 0; i < n; i++) {
        const g = ctx.createLinearGradient(0, i * h, 0, (i + 1) * h);
        g.addColorStop(0, "#d8d8d8"); g.addColorStop(0.85, "#ffffff"); g.addColorStop(1, "#8a8a8a");
        ctx.fillStyle = g; ctx.fillRect(0, i * h, s, h);
      }
      noise(ctx, s, 1500, 0.05);
    }),
    // 1 repeat = 2 m: smooth render with faint trowel variation (white, tinted).
    render: canvasTexture(scene, "renderTex", 256, (ctx, s) => {
      ctx.fillStyle = "#f4f4f4"; ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 300; i++) {
        ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.03})`;
        ctx.beginPath(); ctx.arc(Math.random() * s, Math.random() * s, 4 + Math.random() * 20, 0, 7); ctx.fill();
      }
      noise(ctx, s, 3000, 0.06);
    }),
    // 1 repeat = 1 m: overlapping terracotta-style tile rows (white-ish, tinted).
    tiles: canvasTexture(scene, "tileTex", 256, (ctx, s) => {
      const rows = 3, cols = 4, th = s / rows, tw = s / cols;
      for (let r = 0; r < rows; r++) for (let c = -1; c <= cols; c++) {
        const x = c * tw + (r % 2 ? tw / 2 : 0), v = 200 + Math.random() * 55;
        const g = ctx.createLinearGradient(x, 0, x + tw, 0);
        g.addColorStop(0, `rgb(${v * 0.7},${v * 0.7},${v * 0.7})`); g.addColorStop(0.5, `rgb(${v},${v},${v})`); g.addColorStop(1, `rgb(${v * 0.7},${v * 0.7},${v * 0.7})`);
        ctx.fillStyle = g; ctx.fillRect(x, r * th, tw, th);
        ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(x, (r + 1) * th - 5, tw, 5);
      }
    }),
    // 1 repeat = 1 m: corrugated sheet ribs.
    corrugated: canvasTexture(scene, "corrTex", 128, (ctx, s) => {
      const ribs = 8, w = s / ribs;
      for (let i = 0; i < ribs; i++) {
        const g = ctx.createLinearGradient(i * w, 0, (i + 1) * w, 0);
        g.addColorStop(0, "#9a9a9a"); g.addColorStop(0.5, "#ffffff"); g.addColorStop(1, "#9a9a9a");
        ctx.fillStyle = g; ctx.fillRect(i * w, 0, w, s);
      }
    }),
    // Sectional garage door: horizontal panels, 1 repeat = the whole door.
    garage: canvasTexture(scene, "garageTex", 256, (ctx, s) => {
      ctx.fillStyle = "#ececec"; ctx.fillRect(0, 0, s, s);
      for (let i = 1; i < 5; i++) { ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(0, (i * s) / 5 - 2, s, 3); ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fillRect(0, (i * s) / 5 + 1, s, 2); }
    }),
  };
}

export function createHouseKit(scene) {
  const tex = makeTextures(scene);
  const mats = new Map();
  const mat = (key, make) => { if (!mats.has(key)) mats.set(key, make()); return mats.get(key); };
  const texMat = (name, texture, tint, spec = 0.04) => mat(name, () => {
    const m = new StandardMaterial(name, scene);
    m.diffuseTexture = texture;
    m.diffuseColor = Color3.FromHexString(tint);
    m.specularColor = new Color3(spec, spec, spec);
    m.backFaceCulling = false;
    m.twoSidedLighting = true;
    return m;
  });
  const flat = (name, hex, spec = 0.05, power = 32) => mat(name, () => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = Color3.FromHexString(hex);
    m.specularColor = new Color3(spec, spec, spec);
    m.specularPower = power;
    return m;
  });

  const WALLS = [
    { kind: "brick", tint: "#ffffff", metres: 1 },
    { kind: "brick", tint: "#e2d2c2", metres: 1 },
    { kind: "weatherboard", tint: "#f2efe6", metres: 1 },
    { kind: "weatherboard", tint: "#c9d3d6", metres: 1 },
    { kind: "weatherboard", tint: "#bcc6b1", metres: 1 },
    { kind: "weatherboard", tint: "#e8dcc4", metres: 1 },
    { kind: "render", tint: "#efe9dd", metres: 2 },
    { kind: "render", tint: "#d8d3cb", metres: 2 },
  ];
  const ROOFS = [
    { kind: "tiles", tint: "#b8603f" },
    { kind: "tiles", tint: "#8f8f8f" },
    { kind: "corrugated", tint: "#4b4f54" },
    { kind: "corrugated", tint: "#7c8a8f" },
    { kind: "corrugated", tint: "#6d5a4a" },
  ];
  const TRIMS = ["#ffffff", "#f3f0e8", "#3b3b3b", "#5a4a3c"];
  const DOORS = ["#7a2e2a", "#23364d", "#3d5a3f", "#6b4a2e", "#2f2f2f"];

  /** Accumulates textured quads/triangles with UVs in metres, then becomes one mesh. */
  class Builder {
    constructor() { this.p = []; this.i = []; this.uv = []; }
    quad(a, b, c, d, uLen, vLen, uvScale) {
      const o = this.p.length / 3;
      for (const v of [a, b, c, d]) this.p.push(v.x, v.y, v.z);
      const u = uLen / uvScale, w = vLen / uvScale;
      this.uv.push(0, 0, u, 0, u, w, 0, w);
      this.i.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    tri(a, b, c, uvA, uvB, uvC) {
      const o = this.p.length / 3;
      for (const v of [a, b, c]) this.p.push(v.x, v.y, v.z);
      this.uv.push(...uvA, ...uvB, ...uvC);
      this.i.push(o, o + 1, o + 2);
    }
    mesh(name, material) {
      const vd = new VertexData();
      vd.positions = this.p; vd.indices = this.i; vd.uvs = this.uv;
      vd.normals = []; VertexData.ComputeNormals(this.p, this.i, vd.normals);
      const m = new Mesh(name, scene);
      vd.applyToMesh(m);
      m.material = material;
      return m;
    }
  }
  const V = (x, y, z) => new Vector3(x, y, z);

  /**
   * Build one house in local space (front facade faces +z, footprint centred on the origin,
   * ground at y = 0) and merge it into a single mesh.
   */
  function build(name, r, { w, d }) {
    const storeys = r() < 0.35 ? 2 : 1;
    const H = storeys * STOREY;
    const wallDef = WALLS[Math.floor(r() * WALLS.length)];
    const wallMat = texMat(`wall_${wallDef.kind}_${wallDef.tint}`, tex[wallDef.kind], wallDef.tint);
    const roofDef = ROOFS[Math.floor(r() * ROOFS.length)];
    const roofMat = texMat(`roof_${roofDef.kind}_${roofDef.tint}`, tex[roofDef.kind], roofDef.tint, roofDef.kind === "corrugated" ? 0.25 : 0.05);
    const trimHex = TRIMS[Math.floor(r() * TRIMS.length)];
    const trim = flat(`trim_${trimHex}`, trimHex, 0.1);
    const glass = flat("glass", "#26323d", 0.9, 128);
    const doorHex = DOORS[Math.floor(r() * DOORS.length)];
    const doorMat = flat(`door_${doorHex}`, doorHex, 0.2);
    const stepMat = flat("step", "#a8a49b");
    const parts = [];

    // Walls (UVs in metres so textures are life-size on every house).
    const walls = new Builder();
    const hw = w / 2, hd = d / 2;
    walls.quad(V(-hw, 0, hd), V(hw, 0, hd), V(hw, H, hd), V(-hw, H, hd), w, H, wallDef.metres);
    walls.quad(V(hw, 0, -hd), V(-hw, 0, -hd), V(-hw, H, -hd), V(hw, H, -hd), w, H, wallDef.metres);
    walls.quad(V(hw, 0, hd), V(hw, 0, -hd), V(hw, H, -hd), V(hw, H, hd), d, H, wallDef.metres);
    walls.quad(V(-hw, 0, -hd), V(-hw, 0, hd), V(-hw, H, hd), V(-hw, H, -hd), d, H, wallDef.metres);

    // Gable roof. Ridge runs along x (parallel to the street) or along z (gable end to the street).
    const ridgeX = r() < 0.65;
    const pitch = (20 + r() * 15) * (Math.PI / 180);
    const oh = 0.45; // eave overhang
    const span = ridgeX ? d : w, run = ridgeX ? w : d;
    const rise = (span / 2) * Math.tan(pitch);
    const slope = Math.hypot(span / 2 + oh, rise + oh * Math.tan(pitch));
    const roof = new Builder();
    const eY = H - oh * Math.tan(pitch); // eave height (lowered by the overhang)
    if (ridgeX) {
      const x0 = -hw - oh, x1 = hw + oh, zE = hd + oh;
      roof.quad(V(x0, eY, zE), V(x1, eY, zE), V(x1, H + rise, 0), V(x0, H + rise, 0), run + 2 * oh, slope, 1);
      roof.quad(V(x1, eY, -zE), V(x0, eY, -zE), V(x0, H + rise, 0), V(x1, H + rise, 0), run + 2 * oh, slope, 1);
      walls.tri(V(hw, H, hd), V(hw, H, -hd), V(hw, H + rise, 0), [0, 0], [d / wallDef.metres, 0], [d / 2 / wallDef.metres, rise / wallDef.metres]);
      walls.tri(V(-hw, H, -hd), V(-hw, H, hd), V(-hw, H + rise, 0), [0, 0], [d / wallDef.metres, 0], [d / 2 / wallDef.metres, rise / wallDef.metres]);
    } else {
      const z0 = -hd - oh, z1 = hd + oh, xE = hw + oh;
      roof.quad(V(xE, eY, z1), V(xE, eY, z0), V(0, H + rise, z0), V(0, H + rise, z1), run + 2 * oh, slope, 1);
      roof.quad(V(-xE, eY, z0), V(-xE, eY, z1), V(0, H + rise, z1), V(0, H + rise, z0), run + 2 * oh, slope, 1);
      walls.tri(V(-hw, H, hd), V(hw, H, hd), V(0, H + rise, hd), [0, 0], [w / wallDef.metres, 0], [w / 2 / wallDef.metres, rise / wallDef.metres]);
      walls.tri(V(hw, H, -hd), V(-hw, H, -hd), V(0, H + rise, -hd), [0, 0], [w / wallDef.metres, 0], [w / 2 / wallDef.metres, rise / wallDef.metres]);
    }
    parts.push(walls.mesh(`${name}_walls`, wallMat), roof.mesh(`${name}_roof`, roofMat));
    // Fascia boards along the eaves.
    for (const s of [-1, 1]) {
      const f = ridgeX
        ? CreateBox(`${name}_fascia`, { width: w + 2 * oh, height: 0.18, depth: 0.04 }, scene)
        : CreateBox(`${name}_fascia`, { width: 0.04, height: 0.18, depth: d + 2 * oh }, scene);
      if (ridgeX) f.position.set(0, eY - 0.05, s * (hd + oh)); else f.position.set(s * (hw + oh), eY - 0.05, 0);
      f.material = trim; parts.push(f);
    }

    const box = (n, bw, bh, bd, x, y, z, m) => {
      const b = CreateBox(`${name}_${n}`, { width: bw, height: bh, depth: bd }, scene);
      b.position.set(x, y, z); b.material = m; parts.push(b); return b;
    };
    /** Framed window centred at (u along the wall, y) on a wall; `face` = +z | -z | +x | -x. */
    const window = (face, u, y, ww, wh) => {
      const out = 0.03;
      const [nx, nz] = { "+z": [0, 1], "-z": [0, -1], "+x": [1, 0], "-x": [-1, 0] }[face];
      const along = nz !== 0; // wall runs along x
      const px = along ? u : nx * (hw + out), pz = along ? nz * (hd + out) : u;
      const dims = (a, h, t) => (along ? [a, h, t] : [t, h, a]);
      box("frame", ...dims(ww + 0.14, wh + 0.14, 0.06), px, y, pz, trim);
      box("glass", ...dims(ww, wh, 0.03), px + nx * 0.03, y, pz + nz * 0.03, glass);
      box("mullion", ...dims(0.05, wh, 0.04), px + nx * 0.04, y, pz + nz * 0.04, trim);
      box("sill", ...dims(ww + 0.3, 0.05, 0.16), px + nx * 0.06, y - wh / 2 - 0.1, pz + nz * 0.06, trim);
    };

    // Front facade: door (+ step, awning), optional garage, windows filling the rest.
    const hasGarage = storeys === 1 ? r() < 0.55 && w > 10 : r() < 0.4;
    const garageW = 2.8, garageX = hasGarage ? hw - 0.6 - garageW / 2 : Infinity;
    const doorX = hasGarage ? -hw + 1.6 + r() * Math.max(0, w - garageW - 5) : (r() - 0.5) * (w - 3);
    box("door", 1.0, 2.1, 0.06, doorX, 1.05 + 0.15, hd + 0.03, doorMat);
    box("doorframe", 1.2, 2.25, 0.04, doorX, 1.12 + 0.15, hd + 0.01, trim);
    box("step", 1.8, 0.15, 0.9, doorX, 0.075, hd + 0.45, stepMat);
    box("awning", 1.8, 0.08, 1.0, doorX, 2.55, hd + 0.5, roofMat);
    if (hasGarage) {
      const g = box("garage", garageW, 2.2, 0.06, garageX, 1.1, hd + 0.03, texMat("garageDoor", tex.garage, "#ffffff", 0.1));
      box("garageframe", garageW + 0.2, 2.3, 0.04, garageX, 1.15, hd + 0.01, trim);
      g.metadata = { garage: true };
    }
    const blockedFront = (x, half) => Math.abs(x - doorX) < half + 0.9 || (hasGarage && Math.abs(x - garageX) < half + garageW / 2 + 0.3);
    for (let s = 0; s < storeys; s++) {
      const y = s * STOREY + 1.45, wh = s === 0 ? 1.3 : 1.2;
      for (let x = -hw + 1.3; x <= hw - 1.3; x += 2.4 + r() * 0.6) {
        const ww = 1.2 + r() * 0.6;
        if (s === 0 && blockedFront(x, ww / 2)) continue;
        if (x + ww / 2 > hw - 0.4) continue;
        window("+z", x, y, ww, wh);
      }
      // Sides and back.
      for (const face of ["+x", "-x"]) for (let z = -hd + 1.5; z <= hd - 1.5; z += 3 + r()) if (r() < 0.7) window(face, z, y, 0.9, 1.1);
      for (let x = -hw + 1.5; x <= hw - 1.5; x += 3 + r()) if (r() < 0.6) window("-z", x, y, 1.1, 1.1);
    }

    // Chimney on some roofs.
    if (r() < 0.4) {
      const cx = (r() - 0.5) * (w - 3), cz = (r() - 0.5) * (d - 3);
      box("chimney", 0.6, rise + 1.4, 0.6, cx, H + (rise + 1.4) / 2, cz, texMat(`wall_brick_#ffffff`, tex.brick, "#ffffff"));
    }

    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    merged.name = name;
    return { mesh: merged, hasGarage, garageX, doorX, height: H + rise };
  }

  return { build, flat };
}
