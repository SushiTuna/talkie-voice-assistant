// Tests for talkie-tools.js — the voice agent's page-navigation tools. Plain Node: the tour
// (window.tour) and the page's sections are faked, so this checks what each call does and
// answers, not the 3D camera or the scroll itself.
//
// The tool definitions live in the voice server's `property` profile. When that file is
// reachable (TALKIE_AGENTS_DIR, default ~/Develop/voice/agents) they are checked here against
// this page's rooms, sections and place types; otherwise those checks are skipped, loudly.
// Usage: node tests/talkie-tools.mjs
import { SECTIONS, ROOMS, PLACE_TYPES, HANDLED_TOOLS, createToolHandler, wireTalkieTools } from "../talkie-tools.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${detail}`); }
}

/** A fake window.tour recording goTo calls; `ready` picks the loaded or first-use path. */
function fakeTour({ ready }) {
  const calls = [];
  return { calls, isReady: () => ready, goTo: async (id) => { calls.push(id); } };
}

/** Fake section elements recording scrollIntoView options. */
function fakePage() {
  const scrolled = [];
  const els = Object.fromEntries(Object.values(SECTIONS).map(({ id }) => [id, { scrollIntoView: (o) => scrolled.push({ id, ...o }) }]));
  return { scrolled, getElement: (id) => els[id] ?? null };
}

// ── definitions, from the voice server profile ──
// "parameters is not validated at session.update time. Malformed schemas ... break tool
// calling at runtime. Validate locally." — AssemblyAI client-side tools docs.
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
check("every go_to_section target exists in index.html",
  Object.values(SECTIONS).every(({ id }) => html.includes(`id="${id}"`)));

const agentsDir = process.env.TALKIE_AGENTS_DIR ?? join(homedir(), "Develop", "voice", "agents");
const profilePath = join(agentsDir, "property.json");
let serverTools = null;
try {
  serverTools = JSON.parse(await readFile(profilePath, "utf8")).tools ?? [];
} catch (err) {
  console.log(`SKIP tool definition checks: couldn't read ${profilePath} (${err.code ?? err.message}). ` +
    "Set TALKIE_AGENTS_DIR to the voice server's agents/ folder to run them.");
}

if (serverTools) {
  const byName = Object.fromEntries(serverTools.map((t) => [t.name, t]));
  check("the property profile declares exactly the tools this page handles",
    JSON.stringify(Object.keys(byName).sort()) === JSON.stringify([...HANDLED_TOOLS].sort()),
    `profile has ${Object.keys(byName).join(", ") || "none"}`);
  for (const tool of serverTools) {
    const p = tool.parameters;
    check(`${tool.name}: a function tool with a snake_case name`, tool.type === "function" && /^[a-z]+(_[a-z]+)+$/.test(tool.name));
    check(`${tool.name}: has a description`, typeof tool.description === "string" && tool.description.length > 40);
    check(`${tool.name}: parameters are a JSON Schema object`, p?.type === "object" && typeof p.properties === "object");
    check(`${tool.name}: every required field is declared`, (p?.required ?? []).every((k) => k in p.properties));
    check(`${tool.name}: every property is described and typed`,
      Object.values(p?.properties ?? {}).every((prop) => prop.type === "string" && prop.description && Array.isArray(prop.enum) && prop.enum.length));
  }
  const enumOf = (tool, prop) => [...(byName[tool]?.parameters?.properties?.[prop]?.enum ?? [])].sort();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify([...b].sort());
  check("show_room offers exactly the tour's anchors plus the dollhouse",
    same(enumOf("show_room", "room"), ROOMS.map((r) => r.id)), enumOf("show_room", "room").join(", "));
  check("go_to_section offers exactly this page's sections",
    same(enumOf("go_to_section", "section"), Object.keys(SECTIONS)), enumOf("go_to_section", "section").join(", "));
  check("show_nearby_places offers exactly 'nearest' plus the landmark categories",
    same(enumOf("show_nearby_places", "place_type"), PLACE_TYPES), enumOf("show_nearby_places", "place_type").join(", "));
}

// ── wiring ──
{
  const el = {};
  wireTalkieTools({ querySelector: () => el, getElementById: () => null });
  check("the page leaves el.tools unset, so the server profile's tools are used", !("tools" in el));
  check("...and supplies the handler", typeof el.onToolCall === "function");
}

// ── show_room ──
{
  const tour = fakeTour({ ready: true });
  const run = createToolHandler({ getTour: () => tour, getElement: () => null, reduceMotion: () => false });
  const res = await run({ name: "show_room", arguments: { room: "kitchen" } });
  check("show_room moves the tour to the room", tour.calls[0] === "kitchen");
  check("show_room answers with the room's name and caption for the agent to talk about",
    res.ok === true && res.now_showing === "Kitchen" && res.caption.includes("pantry"), JSON.stringify(res));
  check("a loaded tour gets no loading note", !("note" in res));
}
{
  let finish;
  const tour = { calls: [], isReady: () => false, goTo: (id) => { tour.calls.push(id); return new Promise((r) => { finish = r; }); } };
  const run = createToolHandler({ getTour: () => tour, getElement: () => null, reduceMotion: () => false });
  const res = await run({ name: "show_room", arguments: { room: "room-1" } });
  check("on first use the tour starts loading straight away", tour.calls[0] === "room-1");
  check("...and the agent is answered without waiting for the 3D load",
    res.ok === true && /loading/.test(res.note), JSON.stringify(res));
  finish();
}
{
  const tour = fakeTour({ ready: true });
  const run = createToolHandler({ getTour: () => tour, getElement: () => null, reduceMotion: () => false });
  const res = await run({ name: "show_room", arguments: { room: "attic" } });
  check("an unknown room is an error naming the valid ones, and nothing moves",
    tour.calls.length === 0 && res.error.includes("attic") && res.error.includes("kitchen"), JSON.stringify(res));
  const none = createToolHandler({ getTour: () => undefined, getElement: () => null, reduceMotion: () => false });
  check("no tour on the page is an error, not a crash",
    typeof (await none({ name: "show_room", arguments: { room: "kitchen" } })).error === "string");
}

// ── go_to_section ──
{
  const page = fakePage();
  const run = createToolHandler({ getTour: () => undefined, getElement: page.getElement, reduceMotion: () => false });
  const res = await run({ name: "go_to_section", arguments: { section: "booking_form" } });
  check("go_to_section scrolls the section into view, smoothly",
    page.scrolled[0]?.id === "contact" && page.scrolled[0].behavior === "smooth" && page.scrolled[0].block === "start",
    JSON.stringify(page.scrolled));
  check("go_to_section says where the visitor now is", res.ok === true && res.now_showing.includes("booking"));
  const still = createToolHandler({ getTour: () => undefined, getElement: page.getElement, reduceMotion: () => true });
  await still({ name: "go_to_section", arguments: { section: "gallery" } });
  check("reduced motion jumps instead of animating", page.scrolled[1]?.behavior === "auto");
  const bad = await run({ name: "go_to_section", arguments: { section: "pool" } });
  check("an unknown section is an error naming the valid ones", bad.error.includes("pool") && bad.error.includes("gallery"));
}

// ── show_nearby_places ──
{
  const page = fakePage();
  const clicked = [];
  const chips = { querySelector: (sel) => ({ click: () => clicked.push(sel) }) };
  const getElement = (id) => (id === "nbhdFilters" ? chips : page.getElement(id));
  const run = createToolHandler({ getTour: () => undefined, getElement, reduceMotion: () => false });

  const res = await run({ name: "show_nearby_places", arguments: { place_type: "school" } });
  check("show_nearby_places scrolls to the location section", page.scrolled[0]?.id === "location", JSON.stringify(page.scrolled));
  check("...and taps the matching category chip", clicked[0] === '[data-cat="school"]', JSON.stringify(clicked));
  check("...and returns only schools, nearest first, with distances",
    res.ok === true && res.places.length > 0 && res.places.every((p) => p.type === "schools" && /\d (m|km)$/.test(p.distance)),
    JSON.stringify(res));

  const near = await run({ name: "show_nearby_places", arguments: { place_type: "nearest" } });
  check("'nearest' taps the Nearest chip and returns one place per category",
    clicked[1] === '[data-cat="all"]' && new Set(near.places.map((p) => p.type)).size === near.places.length && near.places.length === 5,
    JSON.stringify(near));

  const bad = await run({ name: "show_nearby_places", arguments: { place_type: "casino" } });
  check("an unknown place_type is an error naming the valid ones, and nothing scrolls",
    bad.error.includes("casino") && bad.error.includes("church") && page.scrolled.length === 2, JSON.stringify(bad));
}
check("every show_nearby_places category has a chip id the page renders",
  PLACE_TYPES.length === 6 && html.includes('id="nbhdFilters"'));

// ── anything else ──
{
  const run = createToolHandler({ getTour: () => undefined, getElement: () => null, reduceMotion: () => false });
  check("an unknown tool is reported, not thrown", typeof (await run({ name: "open_pod_bay_doors", arguments: {} })).error === "string");
}

console.log(`${passed}/${passed + failed} talkie tool tests passed${failed ? " — FAILURES above" : ""}`);
process.exitCode = failed ? 1 : 0;
