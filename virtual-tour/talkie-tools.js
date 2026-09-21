// Tools for the Talkie voice assistant (index.html <talkie-assistant>): let the agent move the
// visitor around this page — a room in the 3D tour, or a section of the listing.
//
// Declared in the AssemblyAI Voice Agent API's function-tool shape; the agent calls them and
// the SDK returns each handler's value as the tool result. The model reads the descriptions and
// any `error` text verbatim, so they say when to call and what to ask next.
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools
import { ROOM_ANCHORS, DOLLHOUSE } from "./anchors.js";

/** Spoken-name hints the anchor labels alone don't give ("Room 1" is a bedroom). */
const ROOM_HINTS = {
  "room-1": "bedroom 2, the nursery",
  "room-2": "bedroom 3",
  "room-3": "bedroom 4",
  "master-bedroom": "main bedroom",
  garage: "carport",
  rumpus: "second living area",
  dollhouse: "overview of the whole house from above",
};

const ROOMS = [DOLLHOUSE, ...ROOM_ANCHORS];

/** Page sections the agent may scroll to: tool value → element id + what to call it. */
export const SECTIONS = {
  overview: { id: "top", label: "the top of the listing" },
  floor_plan: { id: "floor-plan", label: "the floor plan" },
  "3d_tour": { id: "tour-section", label: "the 3D tour" },
  gallery: { id: "residence", label: "the photo gallery" },
  location: { id: "location", label: "the location map" },
  booking_form: { id: "contact", label: "the tour booking form" },
};

export const TALKIE_TOOLS = [
  {
    type: "function",
    name: "show_room",
    description:
      "Show the visitor a room of this house in the 3D virtual tour on the page. Call this whenever they ask to see, " +
      "go to, look at or be taken to a room or part of the house, or say 'show me' about one. Prefer calling it over " +
      "describing a room they asked to see.",
    parameters: {
      type: "object",
      properties: {
        room: {
          type: "string",
          enum: ROOMS.map((r) => r.id),
          description:
            "Room id, lowercase. Pick the closest match: " +
            ROOMS.map((r) => `${r.id} (${ROOM_HINTS[r.id] ?? r.label.toLowerCase()})`).join(", ") +
            ". E.g. 'the kitchen' → kitchen, 'the nursery' → room-1, 'the whole house' → dollhouse.",
        },
      },
      required: ["room"],
    },
  },
  {
    type: "function",
    name: "go_to_section",
    description:
      "Scroll the page to one of its sections. Call this when the visitor asks to see the floor plan, the photos, " +
      "the location or neighbourhood map, the 3D tour, or to book or schedule a viewing (booking_form).",
    parameters: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: Object.keys(SECTIONS),
          description:
            "Section id, lowercase. E.g. 'where is it' → location, 'pictures' → gallery, " +
            "'I want to book a viewing' → booking_form, 'back to the top' → overview.",
        },
      },
      required: ["section"],
    },
  },
];

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

    return { error: `Unknown tool '${name}'.` };
  };
}

/** Give the page's <talkie-assistant> these tools. Safe before the embed bundle has loaded. */
export function wireTalkieTools(doc = document) {
  const el = doc.querySelector("talkie-assistant");
  if (!el) return;
  el.tools = TALKIE_TOOLS;
  el.onToolCall = createToolHandler({
    getTour: () => window.tour,
    getElement: (id) => doc.getElementById(id),
    reduceMotion: () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
}
