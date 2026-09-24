// Static assets (3D models, sky, textures, photos) live in the Cloudflare R2 bucket
// "talkie-tour-assets", served through assets.talkie-bird.online. They aren't in the repo:
// tools/upload-assets.mjs puts them under a version prefix, so a changed file goes up as v2/… and
// only this line changes (the files are cached as immutable). index.html and styles.css spell the
// same base out in full.
export const ASSET_BASE = "https://assets.talkie-bird.online/v1";

/** Absolute URL of an asset, from its path in the bucket ("models/props/x.glb"). */
export const asset = (path) => `${ASSET_BASE}/${path.replace(/^\//, "")}`;

/** The house the tour loads (the bucket's models/ holds only this one at the top level). */
export const HOUSE_MODEL = "modular_house_cube_3_by_swanbuild_australia.glb";
