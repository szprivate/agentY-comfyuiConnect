import { app } from "../../scripts/app.js";

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

// Widget layout version. widgets_values is positional, so an older file can only
// be read safely by knowing which layout wrote it — the same rule (and the same
// property) agent_hook.js follows, for the same reason.
//  v1 = [role]        (before the tag field)
//  v2 = [tag, role]
const SCHEMA_VERSION = 2;

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
      const prev = byName.get(tag);
      if (!prev) byName.set(tag, { tag, role });
      else if (!prev.role) prev.role = role;
    }
  }
  return [...byName.values()].sort((a, b) => a.tag.localeCompare(b.tag));
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

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
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
    if (t.role) {
      const role = document.createElement("span");
      role.className = "ay-tagmenu-role";
      role.textContent = t.role.length > 48 ? t.role.slice(0, 48) + "…" : t.role;
      row.appendChild(role);
    }
    // mousedown, not click: a click lands after the textarea has already lost
    // focus, and the selection we are about to replace goes with it.
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      accept(i);
    });
    row.addEventListener("mouseenter", () => {
      menu.sel = i;
      render();
    });
    menu.el.appendChild(row);
  });
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

function accept(i) {
  const item = menu.items[i];
  const ta = menu.ta;
  if (!item || !ta) return close();
  // The trailing space is load-bearing: without it the caret sits straight after
  // "#hero", which is exactly the token that opens the menu, so accepting an item
  // would immediately re-open it on the word just accepted.
  const insert = "#" + item.tag + " ";
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

// Re-evaluate the token under the caret and open, refilter, or close.
function refresh(ta) {
  if (!ta || ta.selectionStart !== ta.selectionEnd) return close();
  const m = TOKEN.exec(ta.value.slice(0, ta.selectionStart));
  if (!m) return close();
  const query = m[1] || "";
  const all = sceneTags();
  // No tags in the scene means nothing to offer. The menu is a consequence of
  // tags existing, so before the first one it stays out of the way entirely.
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
  if (!menu.el) {
    ensureStyle();
    menu.el = document.createElement("div");
    menu.el.className = "ay-tagmenu";
    document.body.appendChild(menu.el);
  }
  render();
}

// ── which boxes take the menu ───────────────────────────────────────────────

// element → the hook widget it belongs to, or null for "not ours". Resolved from
// the live graph the first time an event arrives from an element and remembered,
// so nothing here assumes WHEN ComfyUI builds its DOM widgets — the event itself
// proves the element exists and belongs to a node on the graph.
const OWNER = new WeakMap();

function hookWidgetFor(el) {
  if (OWNER.has(el)) return OWNER.get(el);
  let found = null;
  for (const g of graphs()) {
    for (const n of g._nodes || g.nodes || []) {
      if (!isType(n, HOOK_NODE)) continue;
      for (const w of n.widgets || []) {
        if (!w || w.name !== "directive") continue;
        const e = w.element || w.inputEl;
        if (e === el || (e && e.contains && e.contains(el))) found = { node: n, widget: w };
      }
    }
  }
  OWNER.set(el, found);
  return found;
}

function textareaFor(target) {
  if (!target || (target.tagName !== "TEXTAREA" && target.tagName !== "INPUT")) return null;
  return hookWidgetFor(target) ? target : null;
}

function onInput(e) {
  if (applying) return;
  const ta = textareaFor(e.target);
  if (ta) refresh(ta);
}

function onKeyDown(e) {
  const ta = textareaFor(e.target);
  // Nothing open means nothing to drive: every key belongs to the textarea.
  if (!ta || !isOpen() || menu.ta !== ta) return;
  const stop = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  switch (e.key) {
    case "ArrowDown":
      menu.sel = (menu.sel + 1) % menu.items.length;
      render();
      return stop();
    case "ArrowUp":
      menu.sel = (menu.sel - 1 + menu.items.length) % menu.items.length;
      render();
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
  const ta = textareaFor(e.target);
  if (ta) setTimeout(() => refresh(ta), 0);
  else if (!(menu.el && menu.el.contains(e.target))) close();
}

app.registerExtension({
  name: "agentY.tagMenu",
  setup() {
    // Capture phase: the canvas binds its own key handling, and the arrow keys
    // driving this menu must not also drive whatever is behind it.
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    // Anything that moves the box out from under the menu closes it, rather than
    // leaving it floating beside a caret that is no longer there: a scroll, a
    // wheel (which the textarea forwards to the canvas as a zoom), losing focus.
    document.addEventListener("scroll", () => close(), true);
    document.addEventListener("wheel", () => close(), true);
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
  if (v.length === 1) return { ...info, widgets_values: ["", v[0]] };
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
