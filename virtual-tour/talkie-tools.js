// Tool handlers for the Talkie voice assistant (index.html <talkie-assistant>): let the agent move
// the visitor around this page — a room in the 3D tour, a section of the listing, or the nearby
// places on the neighbourhood map.
//
// The tool *definitions* (names, descriptions, parameter schemas) live on the voice server, in
// the `property` profile (~/Develop/voice/agents/property.json, served by /agent/context), so
// the agent's instructions can change without a page release. The page leaves `el.tools` unset,
// which makes <talkie-assistant> use the profile's tools, and supplies only what has to run
// here: the handler. tests/talkie-tools.mjs checks the profile's enums still match ROOMS,
// SECTIONS and CATEGORIES below. The model reads handler results and `error` text verbatim.
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools
import { ROOM_ANCHORS, DOLLHOUSE } from "./anchors.js";
import { CATEGORIES } from "./landmarks.js";
import { places, fmtKm } from "./neighborhood.js";

/** Every room show_room accepts: the dollhouse overview plus the tour's anchors. */
export const ROOMS = [DOLLHOUSE, ...ROOM_ANCHORS];

/** Page sections go_to_section may scroll to: tool value → element id + what to call it. */
export const SECTIONS = {
  overview: { id: "top", label: "the top of the listing" },
  floor_plan: { id: "floor-plan", label: "the floor plan" },
  "3d_tour": { id: "tour-section", label: "the 3D tour" },
  gallery: { id: "residence", label: "the photo gallery" },
  location: { id: "location", label: "the location map" },
  booking_form: { id: "contact", label: "the tour booking form" },
};

/** The place_type values show_nearby_places accepts: "nearest" plus each landmark category. */
export const PLACE_TYPES = ["nearest", ...CATEGORIES.map((c) => c.id)];

/** The tools this page can run; the server profile must declare exactly these. */
export const HANDLED_TOOLS = ["show_room", "go_to_section", "show_nearby_places"];

/**
 * Build the handler the assistant runs for each tool call.
 * @param {object} env
 * @param {() => object | undefined} env.getTour - `window.tour` (main.js), read per call: it
 *   appears once the tour module has run.
 * @param {(id: string) => Element | null} env.getElement
 * @param {() => boolean} env.reduceMotion
 * @returns {(call: { name: string, arguments: object }) => Promise<object>}
 */
export function createToolHandler({ getTour, getElement, reduceMotion }) {
  return async ({ name, arguments: args = {} }) => {
    if (name === "show_room") {
      const room = ROOMS.find((r) => r.id === args.room);
      if (!room) {
        return { error: `Unknown room '${args.room}'. Valid rooms: ${ROOMS.map((r) => r.id).join(", ")}. Ask the visitor which one they mean.` };
      }
      const tour = getTour();
      if (!tour?.goTo) return { error: "The 3D tour is not available on this page right now. Describe the room instead." };
      const view = { ok: true, now_showing: room.label, caption: room.caption };
      if (tour.isReady?.()) {
        await tour.goTo(room.id); // ~0.7 s camera move; the agent answers once it has arrived
        return view;
      }
      // The first use loads the whole 3D scene, which can take a while. Don't hold the agent's
      // answer on it: start it, and say so.
      tour.goTo(room.id).catch(() => {});
      return { ...view, note: "The 3D tour is loading and will open on this room in a moment." };
    }

    if (name === "go_to_section") {
      const section = SECTIONS[args.section];
      const el = section && getElement(section.id);
      if (!el) {
        return { error: `Unknown section '${args.section}'. Valid sections: ${Object.keys(SECTIONS).join(", ")}.` };
      }
      // Sections carry scroll-margin-top (styles.css), so the sticky header doesn't cover them.
      el.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
      return { ok: true, now_showing: section.label };
    }

    if (name === "show_nearby_places") {
      const type = args.place_type;
      const cat = CATEGORIES.find((c) => c.id === type);
      if (type !== "nearest" && !cat) {
        return { error: `Unknown place_type '${type}'. Valid: ${PLACE_TYPES.join(", ")}.` };
      }
      const el = getElement(SECTIONS.location.id);
      if (!el) return { error: "The location map is not on this page. Say you can't show it right now." };
      el.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
      // Same chips a visitor would tap (neighborhood.js): "all" is the "Nearest" chip.
      getElement("nbhdFilters")?.querySelector(`[data-cat="${cat ? cat.id : "all"}"]`)?.click();
      const found = cat
        ? places.filter((p) => p.cat === cat.id)
        : CATEGORIES.map((c) => places.find((p) => p.cat === c.id)).filter(Boolean);
      return {
        ok: true,
        now_showing: `the location map, ${cat ? cat.label.toLowerCase() : "the nearest place of each kind"}`,
        places: found.map((p) => ({
          name: p.name,
          type: CATEGORIES.find((c) => c.id === p.cat).label.toLowerCase(),
          distance: fmtKm(p.m),
        })),
        note: "Distances are straight-line from the home, not driving distance.",
      };
    }

    return { error: `Unknown tool '${name}'.` };
  };
}

/**
 * Give the page's <talkie-assistant> the tool handler. The definitions come from the server
 * profile, so `el.tools` stays unset. Safe before the embed bundle has loaded.
 */
export function wireTalkieTools(doc = document) {
  const el = doc.querySelector("talkie-assistant");
  if (!el) return;
  el.onToolCall = createToolHandler({
    getTour: () => window.tour,
    getElement: (id) => doc.getElementById(id),
    reduceMotion: () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
}
