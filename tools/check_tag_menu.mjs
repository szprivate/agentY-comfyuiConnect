// Does typing `#` in a hook box stay cheap?
//
//     node tools/check_tag_menu.mjs
//
// The `#` menu froze the whole browser tab for tens of seconds, which made the
// menu it had just opened impossible to click. Nothing about it looked like a
// loop: `primeRemembered` warms a cache and calls back "a frame later", and the
// callback re-runs `refresh` so the menu can show what just arrived. But by then
// the cache was warm, so the callback fired again, and again — a promise chain
// with no macrotask anywhere in it, which starves the event loop completely. One
// keystroke measured seven million menu rebuilds; it only broke when the 30s TTL
// let a real request through.
//
// So this drives the REAL web/agent_tags.js through its real path — the `input`
// listener it installs, against a stubbed DOM — and COUNTS the work one
// keystroke causes. A cap stands in for the freeze: unbounded recursion here
// hangs node exactly as it hung the tab, so it has to unwind from somewhere the
// code under test does not catch.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert";

// ── a DOM, to the depth this file actually touches ──────────────────────────

// Counted where it cannot be swallowed. caretPoint() wraps its measuring in a
// try/catch, so a cap that throws from getComputedStyle is caught by the code
// under test and the harness hangs — informative once, useless as a check.
// Rebuilding the menu's rows starts by clearing them, and nothing catches that.
let renders = 0;
const CAP = 400;              // stands in for "the tab stopped answering"

function el(tag) {
  // `className` and `classList` are two views of ONE list, as in a browser: the
  // code under test writes rows through className and moves the highlight
  // through classList, and a stub where those are separate fields would report
  // a highlight that the real DOM had never moved.
  const cls = new Set();
  return {
    tagName: String(tag).toUpperCase(),
    id: "", textContent: "",
    style: {}, children: [],
    offsetLeft: 4, offsetTop: 6, offsetWidth: 300,
    get className() { return [...cls].join(" "); },
    set className(v) {
      cls.clear();
      for (const c of String(v || "").split(/\s+/)) if (c) cls.add(c);
    },
    classList: {
      toggle(c, on) { if (on) cls.add(c); else cls.delete(c); },
      add(c) { cls.add(c); },
      remove(c) { cls.delete(c); },
      contains(c) { return cls.has(c); },
    },
    set innerHTML(v) {
      if (!v) this.children.length = 0;
      if (this.className === "ay-tagmenu" && ++renders > CAP) throw new Error("CAP");
    },
    get innerHTML() { return ""; },
    appendChild(c) { c._parent = this; this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c._parent = null;
      return c;
    },
    // Really detaches. A no-op here leaves every closed menu in the body, and
    // the test then reads a dead one instead of the live menu.
    remove() { if (this._parent) this._parent.removeChild(this); },
    addEventListener(type, fn) { (this._ev ||= {})[type] = fn; },
    scrollIntoView() {},
    // Real containment, walked up the parent chain: the code under test asks
    // "did this happen inside the menu?" and answering "never" would make a
    // guard that depends on it look like it works when it does nothing.
    contains(other) {
      for (let n = other; n; n = n._parent) if (n === this) return true;
      return false;
    },
    getBoundingClientRect: () => ({ left: 20, top: 40, right: 220, bottom: 140,
                                    width: 200, height: 100 }),
  };
}

const listeners = {};
globalThis.document = {
  head: el("head"),
  body: el("body"),
  createElement: el,
  getElementById: (id) => document.head.children.find((c) => c.id === id) || null,
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
};
globalThis.window = { innerWidth: 1600, innerHeight: 900, addEventListener() {} };
globalThis.getComputedStyle = () => ({ lineHeight: "14px", fontSize: "12px" });

// A clock the test can move, so a 30-second cache can be expired without the
// test taking 30 seconds.
let skew = 0;
const realNow = Date.now;
Date.now = () => realNow.call(Date) + skew;
const expireCache = () => { skew += 60000; };

globalThis.Event = class {
  constructor(type, o) { this.type = type; Object.assign(this, o || {}); }
};

let fetches = 0;
globalThis.fetch = async () => {
  fetches++;
  await new Promise((r) => setTimeout(r, 0));    // a real request takes a tick
  return { json: async () => ({ entries: [
    { name: "hero_face", summary: "the face", path: "W:/ref/hero_face.png" },
    { name: "hero_coat", summary: "the coat", path: "W:/ref/hero_coat.png" },
  ] }) };
};

// ── the graph, and one hook box on it ───────────────────────────────────────

function textarea(value) {
  return {
    tagName: "TEXTAREA", value,
    selectionStart: value.length, selectionEnd: value.length,
    scrollLeft: 0, scrollTop: 0, offsetWidth: 300,
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    getBoundingClientRect: () => ({ left: 100, top: 200, right: 400, bottom: 260,
                                    width: 300, height: 60 }),
    dispatchEvent() {},
    focus() {},
  };
}

const box = textarea("#h");
const hook = { id: 1, type: "AgentYHook",
               widgets: [{ name: "directive", element: box }] };
// An `agentY add tag` on the canvas. Held back at first: a scene with no tag in
// it is the state the first `#` of a session is typed in, and it is the one the
// menu got wrong.
const tag = { id: 2, type: "AgentYRefNote", inputs: [], widgets: [
  { name: "tag", value: "hero_hands" }, { name: "role", value: "the hands" },
  { name: "remember", value: true }] };
const graph = { _nodes: [hook], links: {}, getNodeById(id) {
  return this._nodes.find((n) => n.id === id) || null; } };

const captured = [];
globalThis.__ay = { registerExtension: (e) => captured.push(e), graph };

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "agent_tags.js");
const text = readFileSync(SRC, "utf8").replace(
  /^import \{ app \} from .*$/m, "const app = globalThis.__ay;");
const copy = join(mkdtempSync(join(tmpdir(), "aytags-")), "agent_tags.mjs");
writeFileSync(copy, text, "utf8");
await import("file://" + copy.split(String.fromCharCode(92)).join("/"));

const ext = captured.find((e) => e.name === "agentY.tagMenu");
assert.ok(ext, "the tag-menu extension registered itself");
ext.setup();

// The cap unwinds through a promise chain, so it surfaces here rather than as a
// throw the test could catch directly.
process.on("unhandledRejection", (e) => {
  if (!(e instanceof Error) || e.message !== "CAP") throw e;
});

const type = (t) => {
  box.value = t;
  box.selectionStart = box.selectionEnd = t.length;
  for (const fn of listeners.input || []) fn({ target: box });
};
// Let every pending promise settle. A macrotask, so a starved event loop shows
// up here as this never returning — which is why the cap exists.
const settle = () => new Promise((r) => setTimeout(r, 20));

// ── the first `#` of a session, with nothing tagged on the canvas ───────────
//
// Nothing is known yet, so the menu has nothing to offer and closes. Re-opening
// it when the store answers therefore cannot key off the menu being OPEN — that
// is precisely the case where it is not, and keying off it left the menu shut
// until another key was pressed.

const menuEl = () => document.body.children.find((c) => c.className === "ay-tagmenu");

type("#h");
assert.ok(!menuEl(), "nothing is known yet, so nothing should be showing");
await settle();
await settle();

console.log(`renders after one '#h': ${renders}   fetches: ${fetches}`);
assert.ok(renders < CAP,
  `typing '#' never stopped rendering (hit the ${CAP} cap) — the tab is frozen`);
assert.ok(renders <= 4, `one keystroke cost ${renders} renders; expected a handful`);
assert.strictEqual(fetches, 1, "one keystroke should cost at most one request");
const late = menuEl();
assert.ok(late && late.children.length,
  "the menu never opened once the remembered references arrived");
console.log(`store-only: menu opened with ${late.children.length} entr(ies)`);

// ── a word, typed one letter at a time ──────────────────────────────────────

graph._nodes = [hook, tag];        // and now a tag on the canvas too
const before = { renders, fetches };
for (const t of ["#he", "#her", "#hero", "#hero_", "#hero_f"]) {
  type(t);
  await settle();
}
console.log(`renders over 5 more keystrokes: ${renders - before.renders}` +
            `   fetches: ${fetches - before.fetches}`);
assert.ok(renders - before.renders <= 10,
  "five keystrokes should be five renders, give or take");
assert.strictEqual(fetches, before.fetches,
  "the warm cache should serve every one of them without a new request");

// ── typing faster than the store can be read ────────────────────────────────
//
// Nothing is cached until the first read lands, so every letter typed in the
// meantime used to start a read of its own — one request per keystroke against
// a handler that walks the store on disk, on a project that may live on a
// network share.

expireCache();
const salvo = fetches;
for (const t of ["#h", "#he", "#her", "#hero"]) type(t);   // no await: all in flight
await settle();
await settle();
console.log("fetches for 4 keystrokes typed before the first answer: " +
            `${fetches - salvo}`);
assert.strictEqual(fetches - salvo, 1,
  "four keystrokes during one read should share that read, not start four");
assert.ok(renders < CAP, "the menu is still rebuilding after the shared read");

// ── hovering a row must not rebuild the menu ────────────────────────────────
//
// Highlighting used to re-render, which replaces every row with a new element.
// Replace the element under a stationary cursor and the browser re-fires
// `mouseenter` on whatever is now underneath, which asks for another rebuild:
// the same loop as the first phase, driven by real events instead of promises.

type("#hero");
await settle();
const open = menuEl();
assert.ok(open && open.children.length >= 2,
  "expected the menu open with several matches for '#hero'");
// Which row is lit is carried over from the last filter on purpose, so find it
// rather than assume the first.
const lit = open.children.findIndex((r) => r.classList.contains("sel"));
assert.ok(lit >= 0, "no row is highlighted at all");
const next = (lit + 1) % open.children.length;
const [wasLit, nowLit] = [open.children[lit], open.children[next]];

const steady = renders;
nowLit._ev.mouseenter();

assert.strictEqual(renders, steady, "hovering a row rebuilt the whole menu");
assert.strictEqual(menuEl().children[next], nowLit,
  "the hovered row was replaced by a new element under the cursor");
assert.ok(nowLit.classList.contains("sel"), "hovering did not move the highlight");
assert.ok(!wasLit.classList.contains("sel"), "the old row kept the highlight too");
console.log(`hover: ${renders - steady} rebuilds, highlight ${lit} -> ${next}`);

// ── scrolling the menu must not close the menu ──────────────────────────────
//
// A scroll anywhere means the box may have moved out from under the menu, so the
// menu closes. Scrolling the menu ITSELF is the exception: it has a max height,
// so a long list has to be scrollable, and closing on the very gesture that
// reveals the rest of it puts everything past the tenth entry out of reach.

const scrolled = (target) => {
  for (const fn of listeners.scroll || []) fn({ target });
};

scrolled(menuEl().children[0]);
assert.ok(menuEl(), "scrolling the menu closed it");

scrolled(box);
assert.ok(!menuEl(), "scrolling the page left the menu floating");
console.log("scroll: inside keeps it, outside closes it");

console.log("\nOK — the `#` menu stays cheap.");
