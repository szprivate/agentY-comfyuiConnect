import { app } from "../../scripts/app.js";
import { eventTarget, eventInside, uiRoot, ensureStyleIn } from "./agent_ui_root.js";

// agentY tags — the `agentY add tag` node, and the `#` menu it feeds.
//
// The node is an annotation ON a wire: it says what the reference travelling
// that wire is FOR ("the face, not the styling"), and now also NAMES it. The
// name is the whole point of this file: once one tag exists anywhere in the
// scene, typing `#` in any `agentY hook` prompt box opens a menu of every tag
// on the canvas, so a directive can say `#hero_face` and mean one exact wire
// instead of describing it and hoping the agent picks the same input.
//
// Its class id is still `AgentYRefNote` — it was called "agentY ref note" before
// the tag field arrived, and the class id is what every saved graph and the whole
// agent side key off. Only the display name, the title and the fields changed.
const TAG_NODE = "AgentYRefNote";
const HOOK_NODE = "AgentYHook";
// The merged collector. Its class id still says "Image" — the two collectors
// became one node and the id is what every saved graph carries.
const COLLECTOR_NODE = "AgentYImageCollector";

// Widget layout version. widgets_values is positional, so an older file can only
// be read safely by knowing which layout wrote it — the same rule (and the same
// property) agent_hook.js follows, for the same reason.
//  v1 = [role]        (before the tag field)
//  v2 = [tag, role]
//  v3 = [tag, role, remember]   — appended, so a v2 file needs no shift, only
//                                 the default. The version is still stamped, so
//                                 nothing downstream has to infer it from length.
const SCHEMA_VERSION = 3;

// What a tag may contain. Everything else collapses to "_", so a tag typed with
// spaces still resolves — and `#` still finds it — rather than half-matching.
// Read-side only: the widget keeps whatever the user typed, because rewriting the
// field under a caret mid-word is worse than accepting a loose spelling.
export function normaliseTag(raw) {
  return String(raw || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/[^A-Za-z0-9_\-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function widgetValue(node, name) {
  const w = (node.widgets || []).find((x) => x && x.name === name);
  return w ? String(w.value ?? "") : "";
}

// Widget names a loader keeps its file under. Same list the agent side walks.
const FILE_WIDGETS = ["image", "video", "file", "filename", "audio"];

// The file a tag ultimately names, by walking its wire back to whatever feeds it.
// A collector wants the FILE, not the node — it is a list of paths, and a node id
// means nothing in it.
function fileBehind(graph, note) {
  let node = note;
  for (let hop = 0; hop < 4 && node; hop++) {
    const inp = (node.inputs || []).find((i) => i && i.name === "input");
    const link = inp && inp.link != null && graph.links ? graph.links[inp.link] : null;
    const src = link && graph.getNodeById ? graph.getNodeById(link.origin_id) : null;
    if (!src) return "";
    if (!isType(src, TAG_NODE)) {
      for (const name of FILE_WIDGETS) {
        const v = widgetValue(src, name).trim();
        if (v) return v;
      }
      return "";
    }
    node = src;
  }
  return "";
}

function isType(node, type) {
  return !!node && (node.type === type || node.comfyClass === type);
}

// Every graph the user could have a tag on: the root plus any subgraph, since a
// tag nested inside one still names a reference in the same scene. `app.graph` is
// whichever graph is OPEN, so starting from it alone would lose every tag the
// moment someone opens a subgraph.
function graphs() {
  const root = (app.graph && (app.graph.rootGraph || app.graph)) || null;
  if (!root) return [];
  const out = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const g = stack.pop();
    if (!g || seen.has(g)) continue;
    seen.add(g);
    out.push(g);
    for (const n of g._nodes || g.nodes || []) {
      if (n && n.subgraph) stack.push(n.subgraph);
    }
  }
  return out;
}

// Every tag in the scene, de-duplicated by name and sorted. Two nodes carrying
// the same tag is not an error — the same reference can be annotated in two
// places — so they collapse to one entry, keeping whichever role is non-empty.
export function sceneTags() {
  const byName = new Map();
  for (const g of graphs()) {
    for (const n of g._nodes || g.nodes || []) {
      if (!isType(n, TAG_NODE)) continue;
      const tag = normaliseTag(widgetValue(n, "tag"));
      if (!tag) continue;
      const role = widgetValue(n, "role").trim();
      const path = fileBehind(g, n);
      const prev = byName.get(tag);
      if (!prev) byName.set(tag, { tag, role, path, source: "canvas" });
      else {
        if (!prev.role) prev.role = role;
        if (!prev.path) prev.path = path;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

// References remembered for the PROJECT — tags whose `remember` switch was on in
// some graph, written to project memory. They resolve in a canvas that has never
// seen the tag node, which is the whole reason they exist.
//
// Fetched and cached for a short while: the store is on disk and changes rarely,
// while the menu opens on a keystroke. The cache only decides what the menu can
// OFFER — a name is only ever inserted from an entry that came back from the
// server, so the worst a stale one can do is list a reference that has since been
// renamed, and the next read past the TTL drops it.
let REMEMBERED = null;
let REMEMBERED_AT = 0;
let INFLIGHT = null;
const REMEMBERED_TTL = 30000;

const isWarm = () => !!REMEMBERED && Date.now() - REMEMBERED_AT < REMEMBERED_TTL;

function remembered() {
  if (isWarm()) return Promise.resolve(REMEMBERED);
  // ONE request, however many keystrokes arrive while it is in the air. Nothing
  // is cached until the first one lands, so without this every letter typed
  // after `#` started a request of its own — against a handler that reads the
  // store off disk, which on a project living on a network share is not free.
  if (INFLIGHT) return INFLIGHT;
  INFLIGHT = fetch("/agent/pm_names", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => (d.entries || [])
      .filter((e) => e && e.path)
      .map((e) => ({ tag: e.name, role: e.summary || "", path: e.path,
                     source: "memory" })))
    .catch(() => [])
    .then((list) => {
      REMEMBERED = list;
      REMEMBERED_AT = Date.now();
      INFLIGHT = null;
      return list;
    });
  return INFLIGHT;
}

// Every tag the `#` menu would offer, as one list: the scene's `agentY add tag`
// nodes first, then the project's remembered references the scene does not
// already name. The bEpic viewer reads this (window.agentYViewerBridge.tags) to
// list agentY's tags in its history filter, so there is ONE source of tags and
// the viewer builds no second one. `fresh` skips the 30 s cache, for a menu the
// user has just opened.
export async function agentTagList({ fresh = false } = {}) {
  if (fresh) REMEMBERED_AT = 0;
  const scene = sceneTags();
  let kept = [];
  try { kept = await remembered(); } catch (_) { kept = []; }
  const names = new Set(scene.map((t) => t.tag));
  return scene.concat(kept.filter((t) => t && t.tag && !names.has(t.tag)));
}

// Warm the cache without blocking the keystroke that needs it, and call back
// ONLY when something has actually arrived that the menu has not shown yet.
//
// That last word is the whole function. This used to call back on every prime,
// warm cache or not — and since `refresh` primes and the callback re-runs
// `refresh`, a warm cache closed the circle: promise, callback, refresh, prime,
// promise. A resolved promise settles in a MICROTASK, and microtasks drain
// completely before the browser renders or handles a click, so the loop never
// gave the thread back. One `#` measured seven million menu rebuilds, the tab
// froze until the 30s TTL let a real request through, and the menu it had just
// opened could not be clicked. A warm cache has nothing to announce.
//
// Keystrokes arriving while the read is still in the air DO each get a callback;
// they share the one request (see above) and land together, and re-running a
// refresh that reads the caret afresh is both cheap and correct.
function primeRemembered(onReady) {
  if (isWarm()) return;
  remembered().then((list) => { if (list.length && onReady) onReady(); });
}

// ── the `#` menu ────────────────────────────────────────────────────────────

// `#` only opens the menu at the START of a word. Mid-word it is a character like
// any other — "shot#3", a hex colour, an id — and a menu that appears there is a
// menu in the way.
const TOKEN = /(?:^|[\s([{<,;:!?"'])#([A-Za-z0-9_-]*)$/;

const STYLE_ID = "agentY-tag-menu-style";
const CSS = `
.ay-tagmenu {
  position: fixed; z-index: 10000; min-width: 180px; max-width: 340px;
  max-height: 240px; overflow-y: auto; padding: 4px;
  background: #1e1e1e; border: 1px solid #444; border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0,0,0,.5);
  font-family: system-ui, sans-serif; font-size: 12px; color: #ddd;
}
.ay-tagmenu-item {
  padding: 4px 8px; border-radius: 4px; cursor: pointer; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.ay-tagmenu-item.sel { background: #3a5a8c; }
.ay-tagmenu-item .ay-tagmenu-name { color: #9ecbff; }
.ay-tagmenu-item.sel .ay-tagmenu-name { color: #fff; }
.ay-tagmenu-item .ay-tagmenu-role { color: #999; margin-left: 8px; }
.ay-tagmenu-item.sel .ay-tagmenu-role { color: #dde; }
`;

function ensureStyle(parent) {
  ensureStyleIn(parent, STYLE_ID, CSS);
}

// Open state. `start`/`end` bracket the `#query` being replaced, so accepting an
// item overwrites exactly what was typed and nothing either side of it.
const menu = { el: null, ta: null, items: [], sel: 0, start: 0, end: 0 };
let applying = false;

function close() {
  if (menu.el) menu.el.remove();
  menu.el = null;
  menu.ta = null;
  menu.items = [];
}

const isOpen = () => !!menu.el;

// Where the caret actually is on screen. A textarea gives no caret coordinates,
// so the text before it is laid out in a hidden copy of the box and the marker's
// offset is measured there. The copy is unscaled CSS pixels while the real box is
// inside the canvas's transform, hence the scale factor off the client rect —
// without it the menu drifts further from the caret the more you zoom in.
function caretPoint(ta) {
  const rect = ta.getBoundingClientRect();
  try {
    const scale = ta.offsetWidth ? rect.width / ta.offsetWidth : 1;
    const cs = getComputedStyle(ta);
    const mirror = document.createElement("div");
    for (const p of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
                     "textTransform", "wordSpacing", "lineHeight", "paddingTop", "paddingRight",
                     "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
                     "borderBottomWidth", "borderLeftWidth", "boxSizing", "textIndent"]) {
      mirror.style[p] = cs[p];
    }
    Object.assign(mirror.style, {
      position: "absolute", top: "0px", left: "-9999px", visibility: "hidden",
      whiteSpace: "pre-wrap", overflowWrap: "break-word",
      width: ta.offsetWidth + "px",
    });
    mirror.textContent = ta.value.slice(0, ta.selectionStart);
    const marker = document.createElement("span");
    marker.textContent = "\u200b";   // a zero-width marker: measured, never seen
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const x = marker.offsetLeft;
    const y = marker.offsetTop;
    document.body.removeChild(mirror);
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 12) * 1.2;
    return {
      left: rect.left + (x - ta.scrollLeft) * scale,
      top: rect.top + (y - ta.scrollTop + lh) * scale,
    };
  } catch (_) {
    return { left: rect.left, top: rect.bottom };
  }
}

function render() {
  menu.el.innerHTML = "";
  menu.items.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "ay-tagmenu-item" + (i === menu.sel ? " sel" : "");
    const name = document.createElement("span");
    name.className = "ay-tagmenu-name";
    name.textContent = "#" + t.tag;
    row.appendChild(name);
    // In a collector the file is the thing being chosen, so show its name; in a
    // prompt box the role is what tells the two references apart.
    const wantsPath = (ownerFor(menu.ta) || {}).inserts === "path";
    const sub = wantsPath
      ? (String(t.path || "").split(/[\\/]/).pop() || "")
      : (t.role || "");
    if (sub) {
      const role = document.createElement("span");
      role.className = "ay-tagmenu-role";
      role.textContent = (t.source === "memory" ? "★ " : "") +
        (sub.length > 48 ? sub.slice(0, 48) + "…" : sub);
      row.appendChild(role);
    } else if (t.source === "memory") {
      const star = document.createElement("span");
      star.className = "ay-tagmenu-role";
      star.textContent = "★ remembered";
      row.appendChild(star);
    }
    // mousedown, not click: a click lands after the textarea has already lost
    // focus, and the selection we are about to replace goes with it.
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      accept(i);
    });
    row.addEventListener("mouseenter", () => select(i));
    menu.el.appendChild(row);
  });
  const owner = ownerFor(menu.ta) || {};
  if (owner.anchor === "above") return placeAbove(menu.ta, owner.within);
  const at = caretPoint(menu.ta);
  menu.el.style.left = Math.round(at.left) + "px";
  menu.el.style.top = Math.round(at.top) + "px";
  // Keep it on screen: flip above the caret rather than hang off the bottom.
  const box = menu.el.getBoundingClientRect();
  if (box.bottom > window.innerHeight - 4) {
    menu.el.style.top = Math.max(4, Math.round(at.top - box.height - 18)) + "px";
  }
  if (box.right > window.innerWidth - 4) {
    menu.el.style.left = Math.max(4, Math.round(window.innerWidth - box.width - 4)) + "px";
  }
}

// Over the box, inside the panel that holds it. The sidebar mount element has no
// height of its own (the whole panel scrolls), so the panel's rect cannot be used
// for the vertical; the box is the anchor, and the panel only bounds the sides.
function placeAbove(ta, within) {
  const win = ta.ownerDocument.defaultView || window;
  const r = ta.getBoundingClientRect();
  const bounds = (within && within.getBoundingClientRect()) || r;
  const left0 = Math.max(bounds.left, 4);
  const maxW = Math.max(120, Math.min(bounds.right, win.innerWidth) - left0 - 4);
  menu.el.style.maxWidth = maxW + "px";
  menu.el.style.left = Math.round(left0 + 4) + "px";
  const h = menu.el.getBoundingClientRect().height;
  menu.el.style.top = Math.max(4, Math.round(r.top - h - 6)) + "px";
  const box = menu.el.getBoundingClientRect();
  if (box.right > bounds.right - 2) {
    menu.el.style.left = Math.max(4, Math.round(bounds.right - box.width - 4)) + "px";
  }
}

// Move the highlight — WITHOUT rebuilding the rows.
//
// Highlighting used to re-render, which replaces every row with a new element.
// Replace the element under a stationary cursor and the browser re-fires
// `mouseenter` on whatever is now underneath, which asks for another rebuild:
// the same loop as above, driven by real events instead of promises. It also
// dragged the menu back to the caret on every hover. Nothing about a changed
// selection needs new elements — it is one class.
function select(i) {
  if (!menu.el || i === menu.sel || i < 0 || i >= menu.items.length) return;
  menu.sel = i;
  const rows = menu.el.children;
  for (let n = 0; n < rows.length; n++) rows[n].classList.toggle("sel", n === menu.sel);
  const row = rows[menu.sel];
  if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
}

function accept(i) {
  const item = menu.items[i];
  const ta = menu.ta;
  if (!item || !ta) return close();
  const wantsPath = (ownerFor(ta) || {}).inserts === "path";
  // A collector gets the FILE, on its own line, exactly as the picker would have
  // added it. The trailing space on a name is load-bearing: without it the caret
  // sits straight after "#hero", which is the token that opens the menu, so
  // accepting would immediately re-open it on the word just accepted.
  const insert = wantsPath
    ? String(item.path || "").trim() + "\n"
    : "#" + item.tag + " ";
  if (wantsPath && !insert.trim()) return close();
  const before = ta.value.slice(0, menu.start);
  const after = ta.value.slice(menu.end);
  applying = true;
  try {
    ta.value = before + insert + after;
    const caret = before.length + insert.length;
    ta.setSelectionRange(caret, caret);
    // The widget's value is bound to this element by its own `input` listener, so
    // writing .value directly is invisible to it until the event is replayed —
    // and a directive the node does not know about is a directive that never
    // reaches the agent.
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  } finally {
    applying = false;
  }
  close();
  ta.focus();
}

// The box the last refresh ran for, which is NOT the same as "the menu is open":
// a `#` typed before the store has been read has nothing to offer yet and closes
// the menu, and that is exactly the moment the arriving entries are for.
let lastBox = null;

// Re-evaluate the token under the caret and open, refilter, or close.
function refresh(ta) {
  lastBox = ta;
  if (!ta || ta.selectionStart !== ta.selectionEnd) return close();
  const m = TOKEN.exec(ta.value.slice(0, ta.selectionStart));
  if (!m) return close();
  const query = m[1] || "";
  const inserts = (ownerFor(ta) || {}).inserts || "name";
  // A collector holds files, so a tag with no file behind it has nothing to give
  // it — offering the name there would insert an empty line.
  const onCanvas = sceneTags().filter((t) => inserts !== "path" || t.path);
  const seen = new Set(onCanvas.map((t) => t.tag));
  // Then what the PROJECT remembers, minus anything the canvas already names —
  // the tag in front of you is the more specific statement, same rule the agent
  // side resolves by. Only reached once the cache is warm; the prime below fills
  // it once, then re-opens the menu, so the first `#` of a session catches up by
  // itself rather than waiting for another keystroke.
  const fromMemory = (REMEMBERED || []).filter((t) => !seen.has(t.tag));
  const all = [...onCanvas, ...fromMemory];
  primeRemembered(() => { if (lastBox === ta) refresh(ta); });
  // Nothing to offer. The menu is a consequence of tags existing, so before the
  // first one it stays out of the way entirely.
  if (!all.length) return close();
  const q = query.toLowerCase();
  const starts = all.filter((t) => t.tag.toLowerCase().startsWith(q));
  const contains = all.filter((t) => !t.tag.toLowerCase().startsWith(q)
    && t.tag.toLowerCase().includes(q));
  const items = [...starts, ...contains];
  if (!items.length) return close();
  // Keep the highlight on the tag it was on while the list is narrowing, so
  // typing one more letter does not silently move Enter onto a different tag.
  const keep = isOpen() && menu.ta === ta ? menu.items[menu.sel] : null;
  menu.items = items;
  menu.ta = ta;
  menu.start = ta.selectionStart - query.length - 1;   // back past the "#" itself
  menu.end = ta.selectionStart;
  const again = keep ? items.findIndex((t) => t.tag === keep.tag) : -1;
  menu.sel = again >= 0 ? again : 0;
  // Mounted beside the box, not on the page: in the viewer the box is inside a
  // shadow root, where the page's stylesheet and body do not apply (agent_ui_root.js).
  const parent = uiRoot(ta);
  if (menu.el && menu.el.parentNode !== parent) { menu.el.remove(); menu.el = null; }
  if (!menu.el) {
    ensureStyle(parent);
    menu.el = ta.ownerDocument.createElement("div");
    menu.el.className = "ay-tagmenu";
    parent.appendChild(menu.el);
  } else ensureStyle(parent);
  render();
}

// ── which boxes take the menu ───────────────────────────────────────────────

// element → the hook widget it belongs to, or null for "not ours". Resolved from
// the live graph the first time an event arrives from an element and remembered,
// so nothing here assumes WHEN ComfyUI builds its DOM widgets — the event itself
// proves the element exists and belongs to a node on the graph.
const OWNER = new WeakMap();

// Which boxes take the menu, and what each one wants inserted:
//   • an `agentY hook` prompt takes the NAME — `#hero_face` is a pointer, and the
//     agent resolves it against the graph and the project's memory.
//   • an `agentY collector` files list takes the PATH. The collector is a literal
//     list of files (that is what lets the agent read it with no pre-run, and what
//     makes a normal Queue behave identically), so the menu is a way to FIND the
//     file, not a level of indirection to store in it.
const BOXES = [
  { type: HOOK_NODE, widget: "directive", inserts: "name" },
  { type: COLLECTOR_NODE, widget: "files", inserts: "path" },
];

// Any other textarea can take the menu too: the sidebar composer registers itself
// here, so there is ONE menu (one tag source, one renderer, one key handler) and
// not a second copy in agent_chat.js. `anchor: "above"` is for a box at the foot
// of a panel: the menu sits over the box, inside `within`, instead of following
// the caret to wherever the panel ends.
export function registerTagBox(el, opts = {}) {
  if (!el) return;
  if (el.ownerDocument) watchDocument(el.ownerDocument);
  OWNER.set(el, { node: null, widget: null, inserts: opts.inserts || "name",
                  anchor: opts.anchor || "caret", within: opts.within || null });
}

function ownerFor(el) {
  if (OWNER.has(el)) return OWNER.get(el);
  let found = null;
  for (const g of graphs()) {
    for (const n of g._nodes || g.nodes || []) {
      const box = BOXES.find((b) => isType(n, b.type));
      if (!box) continue;
      for (const w of n.widgets || []) {
        if (!w || w.name !== box.widget) continue;
        const e = w.element || w.inputEl;
        if (e === el || (e && e.contains && e.contains(el))) {
          found = { node: n, widget: w, inserts: box.inserts };
        }
      }
    }
  }
  OWNER.set(el, found);
  return found;
}

function textareaFor(e) {
  const target = eventTarget(e);
  if (!target || (target.tagName !== "TEXTAREA" && target.tagName !== "INPUT")) return null;
  return ownerFor(target) ? target : null;
}

function onInput(e) {
  if (applying) return;
  const ta = textareaFor(e);
  if (ta) refresh(ta);
}

function onKeyDown(e) {
  const ta = textareaFor(e);
  // Nothing open means nothing to drive: every key belongs to the textarea.
  if (!ta || !isOpen() || menu.ta !== ta) return;
  // The menu uses plain keys only. Alt/Ctrl/Meta combos (word jumps, select
  // all, undo ...) are the textarea's, open menu or not.
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const stop = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  switch (e.key) {
    case "ArrowDown":
      select((menu.sel + 1) % menu.items.length);
      return stop();
    case "ArrowUp":
      select((menu.sel - 1 + menu.items.length) % menu.items.length);
      return stop();
    case "Enter":
    case "Tab":
      accept(menu.sel);
      return stop();
    case "Escape":
      close();
      return stop();
    case "ArrowLeft":
    case "ArrowRight":
    case "Home":
    case "End":
      // The caret is leaving the token; let it, then re-read where it landed.
      setTimeout(() => refresh(ta), 0);
      return;
    default:
      return;
  }
}

// A click inside the box moves the caret without typing; a click outside, a
// scroll, or losing the window all mean the menu no longer points at anything.
function onPointerDown(e) {
  const ta = textareaFor(e);
  if (ta) setTimeout(() => refresh(ta), 0);
  else if (!eventInside(e, menu.el)) close();
}

// The menu's listeners, on one document. The page's is wired in setup(); a viewer
// popped out into its own window is a second document, and events there never
// reach the first one's listeners, so the panel host calls this for it too.
const WATCHED = new WeakSet();
export function watchDocument(doc) {
  if (!doc || WATCHED.has(doc)) return;
  WATCHED.add(doc);
  // Capture phase: the canvas binds its own key handling, and the arrow keys
  // driving this menu must not also drive whatever is behind it.
  doc.addEventListener("input", onInput, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("mousedown", onPointerDown, true);
  // Anything that moves the box out from under the menu closes it, rather than
  // leaving it floating beside a caret that is no longer there: a scroll, a
  // wheel (which the textarea forwards to the canvas as a zoom), losing focus.
  // Scrolling the menu ITSELF is the exception — it has a max height, so a long
  // list has to be scrollable, and closing on the gesture that reveals the rest
  // of it is a menu that cannot be reached past the tenth entry.
  const elsewhere = (e) => {
    if (menu.el && e && eventInside(e, menu.el)) return false;
    // The composer's menu is tied to the box, not the page: the chat log
    // scrolling while the agent streams does not move it.
    if (menu.ta && (ownerFor(menu.ta) || {}).anchor === "above") return false;
    return true;
  };
  doc.addEventListener("scroll", (e) => { if (elsewhere(e)) close(); }, true);
  doc.addEventListener("wheel", (e) => { if (elsewhere(e)) close(); }, true);
}

app.registerExtension({
  name: "agentY.tagMenu",
  setup() {
    watchDocument(document);
    window.addEventListener("blur", () => close());
  },
});

// ── the tag node itself ─────────────────────────────────────────────────────

// v1 files carry [role]; the tag field is now first, so the one value in them
// would be read as the tag and the sentence the user wrote would vanish into a
// name. Shift it back, then stamp the version so this is decided once and never
// guessed again.
function migrateWidgetValues(info) {
  if (!info || !Array.isArray(info.widgets_values)) return info;   // named: self-describing
  if (Number((info.properties || {}).agentY_schema || 0) >= SCHEMA_VERSION) return info;
  const v = info.widgets_values;
  // v1 [role] -> v2 [tag, role]: the one value would otherwise be read as the
  // tag and the sentence the user wrote would vanish into a name.
  if (v.length === 1) return { ...info, widgets_values: ["", v[0], false] };
  // v2 [tag, role] -> v3: `remember` was appended, so nothing shifts.
  if (v.length === 2) return { ...info, widgets_values: [v[0], v[1], false] };
  return info;
}

// The node's old display name, left behind in the title by any frontend that
// serialises it. Nothing reads the title, but a node still labelled "agentY ref
// note" beside a menu of tags looks like a different node.
const OLD_TITLES = new Set(["agentY ref note", "AgentYRefNote"]);

app.registerExtension({
  name: "agentY.tagNode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TAG_NODE) return;

    const configure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (info) {
      const r = configure ? configure.call(this, migrateWidgetValues(info)) : undefined;
      this.properties = this.properties || {};
      this.properties.agentY_schema = SCHEMA_VERSION;
      if (OLD_TITLES.has(String(this.title || "").trim())) this.title = "agentY add tag";
      return r;
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      this.properties = this.properties || {};
      this.properties.agentY_schema = SCHEMA_VERSION;
      if (!this.title || OLD_TITLES.has(String(this.title).trim())) this.title = "agentY add tag";
      return r;
    };
  },
});
