// Tests for talkie-tools.js — the voice agent's page-navigation tools. Plain Node: the tour
// (window.tour) and the page's sections are faked, so this checks the tool definitions and
// what each call does and answers, not the 3D camera or the scroll itself.
// Usage: node tests/talkie-tools.mjs
import { TALKIE_TOOLS, SECTIONS, createToolHandler } from "../talkie-tools.js";
import { ROOM_ANCHORS, DOLLHOUSE } from "../anchors.js";
import { readFile } from "node:fs/promises";

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

// ── definitions: the API does not validate schemas, so check them here ──
// "parameters is not validated at session.update time. Malformed schemas ... break tool
// calling at runtime. Validate locally." — AssemblyAI client-side tools docs.
for (const tool of TALKIE_TOOLS) {
  const p = tool.parameters;
  check(`${tool.name}: a function tool with a snake_case name`, tool.type === "function" && /^[a-z]+(_[a-z]+)+$/.test(tool.name));
  check(`${tool.name}: has a description`, tool.description.length > 40);
  check(`${tool.name}: parameters are a JSON Schema object`, p.type === "object" && typeof p.properties === "object");
  check(`${tool.name}: every required field is declared`, p.required.every((k) => k in p.properties));
  check(`${tool.name}: every property is described and typed`,
    Object.values(p.properties).every((prop) => prop.type === "string" && prop.description && Array.isArray(prop.enum) && prop.enum.length));
}
const roomEnum = TALKIE_TOOLS.find((t) => t.name === "show_room").parameters.properties.room.enum;
check("show_room offers exactly the tour's anchors plus the dollhouse",
  JSON.stringify([...roomEnum].sort()) === JSON.stringify([DOLLHOUSE.id, ...ROOM_ANCHORS.map((a) => a.id)].sort()));
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
check("every go_to_section target exists in index.html",
  Object.values(SECTIONS).every(({ id }) => html.includes(`id="${id}"`)));

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

// ── anything else ──
{
  const run = createToolHandler({ getTour: () => undefined, getElement: () => null, reduceMotion: () => false });
  check("an unknown tool is reported, not thrown", typeof (await run({ name: "open_pod_bay_doors", arguments: {} })).error === "string");
}

console.log(`${passed}/${passed + failed} talkie tool tests passed${failed ? " — FAILURES above" : ""}`);
process.exitCode = failed ? 1 : 0;
