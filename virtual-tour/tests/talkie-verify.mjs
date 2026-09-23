// Tests for talkie-verify.js — the Turnstile hook the voice server's bot check calls. Plain
// Node: the document and Cloudflare's `turnstile` object are faked, so this checks the hook's
// contract (what it renders, resolves and cleans up), not Cloudflare's widget itself.
// Usage: node tests/talkie-verify.mjs
import { createTurnstileVerify, wireTalkieVerify } from "../talkie-verify.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${detail}`); }
}

/** Just enough document: create, append, find by id, remove. */
function fakeDoc() {
  const byId = new Map();
  const body = {
    children: [],
    append(node) { this.children.push(node); if (node.id) byId.set(node.id, node); },
  };
  return {
    body,
    createElement: (tag) => {
      const node = { tag, id: "", className: "", remove() {
        body.children = body.children.filter((n) => n !== node);
        if (byId.get(node.id) === node) byId.delete(node.id);
      } };
      return node;
    },
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: () => null,
  };
}

/** A fake `turnstile` that answers each render with `outcome`. */
function fakeTurnstile(outcome) {
  const t = { rendered: [], removed: [] };
  t.render = (container, opts) => {
    t.rendered.push({ container, opts });
    queueMicrotask(() => {
      if (outcome === "pass") opts.callback("tok-123");
      else if (outcome === "error") opts["error-callback"]("110200");
      else if (outcome === "expire") opts["expired-callback"]();
    });
    return `w${t.rendered.length}`;
  };
  t.remove = (id) => t.removed.push(id);
  return t;
}

async function rejection(p) {
  try { await p; return null; } catch (err) { return err; }
}

{
  const doc = fakeDoc();
  const turnstile = fakeTurnstile("pass");
  let loads = 0;
  const verify = createTurnstileVerify(doc, { load: async () => { loads++; return turnstile; } });
  const token = await verify({ provider: "turnstile", siteKey: "1x00000000000000000000BB" });
  check("resolves to the Turnstile token", token === "tok-123");
  const { container, opts } = turnstile.rendered[0];
  check("renders into its own box with the server's site key", container === "#talkie-verify" && opts.sitekey === "1x00000000000000000000BB");
  check("stays hidden unless the visitor must interact", opts.appearance === "interaction-only");
  check("removes the widget and its box afterwards", turnstile.removed[0] === "w1" && doc.body.children.length === 0);
  check("loads the script only when asked", loads === 1);
}

for (const [outcome, pattern] of [["error", /failed \(110200\)/], ["expire", /expired/]]) {
  const doc = fakeDoc();
  const turnstile = fakeTurnstile(outcome);
  const verify = createTurnstileVerify(doc, { load: async () => turnstile });
  const err = await rejection(verify({ provider: "turnstile", siteKey: "k" }));
  check(`a Turnstile ${outcome} rejects, and cleans up`, pattern.test(err?.message ?? "") && doc.body.children.length === 0, err?.message);
}

{
  const verify = createTurnstileVerify(fakeDoc(), { load: async () => { throw new Error("should not load"); } });
  const err = await rejection(verify({ provider: "recaptcha", siteKey: "k" }));
  check("an unknown provider is refused without loading anything", /Unsupported bot check: recaptcha/.test(err?.message ?? ""), err?.message);
  const err2 = await rejection(verify({ provider: "turnstile", siteKey: null }));
  check("a missing site key is refused", /Unsupported/.test(err2?.message ?? ""), err2?.message);
}

{
  const el = {};
  wireTalkieVerify({ querySelector: (sel) => (sel === "talkie-assistant" ? el : null) });
  check("wireTalkieVerify sets the assistant's verify hook", typeof el.verify === "function");
  wireTalkieVerify({ querySelector: () => null });
  check("wireTalkieVerify is a no-op without an assistant on the page", true);
}

console.log(`\n${passed}/${passed + failed} talkie verify tests passed`);
process.exit(failed ? 1 : 0);
