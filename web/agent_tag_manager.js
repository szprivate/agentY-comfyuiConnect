import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { closeHostDialogs } from "./agent_settings.js";
import { uiRoot, ensureStyleIn } from "./agent_ui_root.js";
import { TAGS_CHANGED, tagKey } from "./agent_tags.js";
import {
  checkTagName, deleteEverywhere, filterTagRows, loadTagRows, mergeInto, removeImage, renameEverywhere,
  sortTagRows, sourceText,
} from "./agent_tag_ops.js";

// agentY tags - the "Manage tags" page.
//
// Same look and the same plumbing as "Manage conversations" (agent_conversations.js):
// opened from the panel's ⋯ menu, from the bEpic viewer's history filter and from
// the `#` menu; mounted beside whatever asked (uiRoot: the viewer's shadow root,
// the popout's document, or the page), with its stylesheet carried into that root
// and its listeners on that root's document; every confirmation in the page.
//
// Left: every tag (name, where it lives, how many pictures), sortable, filterable.
// Right: the picked tag's pictures as a grid of thumbnails (/bepic/thumb, loaded as
// they scroll into view, a few at a time, capped), with the actions.
//
// Nothing a user or the agent wrote is ever parsed as HTML here: names, roles, file
// names and paths are all set as textContent or attribute values.

export const COLUMNS = [
  { key: "tag", label: "Tag" },
  { key: "source", label: "Where" },
  { key: "images", label: "Pictures" },
];

// Thumbnails: at most this many tiles, and this many loading at once - the same
// discipline as the viewer's history strip (THUMB_LOADS_MAX there).
export const GRID_CAP = 120;
const THUMB_LOADS = 4;

/** The thumbnail URL for a picture: by path, or - for a canvas loader's
 *  input-relative name - by filename in ComfyUI's input folder. */
export function thumbUrl(path) {
  const p = String(path || "");
  let q;
  if (/^([A-Za-z]:)?[\\/]/.test(p)) q = `path=${encodeURIComponent(p)}`;
  else {
    const parts = p.replace(/\\/g, "/").split("/");
    const file = parts.pop() || "";
    q = `filename=${encodeURIComponent(file)}&type=input`;
    if (parts.length) q += `&subfolder=${encodeURIComponent(parts.join("/"))}`;
  }
  const rel = api && typeof api.apiURL === "function" ? api.apiURL(`/bepic/thumb?${q}`) : `/bepic/thumb?${q}`;
  try { return new URL(rel, window.location.href).href; } catch (_) { return rel; }
}

/** Show `path` in the bEpic viewer: the history item when it is there, else a push. */
export async function openInViewer(path) {
  const v = window.bEpicViewerApi;
  try { if (v && typeof v.showPath === "function" && v.showPath(path)) return true; } catch (_) {}
  if (!/^([A-Za-z]:)?[\\/]/.test(String(path || ""))) return false;
  try {
    const url = api && typeof api.apiURL === "function" ? api.apiURL("/bepic/push") : "/bepic/push";
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [path], tab_name: "agentY", focus: true }) });
    return r.ok;
  } catch (_) { return false; }
}

const STYLE_ID = "agentY-tag-manager-style";
const STYLES = `
  .ayt-overlay{position:fixed;inset:0;background:rgba(8,9,12,.6);z-index:10000;display:flex;pointer-events:auto;
    align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;}
  .ayt-card{background:#15171c;color:#e6e8ec;border:1px solid #2c313b;border-radius:9px;pointer-events:auto;
    width:min(1080px,95vw);height:min(740px,90vh);display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.6);overflow:hidden;}
  .ayt-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #2c313b;background:#1e2128;flex-wrap:wrap;}
  .ayt-head h2{font-size:15px;margin:0;font-weight:650;flex:1;}
  .ayt-main{display:flex;flex:1;min-height:0;}
  .ayt-list{flex:0 1 38%;min-width:0;overflow:auto;}
  .ayt-view{flex:1 1 62%;min-width:0;border-left:1px solid #2c313b;display:flex;flex-direction:column;background:#1e2128;}
  .ayt-list::-webkit-scrollbar,.ayt-grid::-webkit-scrollbar{width:8px;}
  .ayt-list::-webkit-scrollbar-thumb,.ayt-grid::-webkit-scrollbar-thumb{background:#262b34;border-radius:8px;}
  .ayt-table{width:100%;border-collapse:collapse;font-size:12.5px;}
  .ayt-table th{position:sticky;top:0;background:#1e2128;text-align:left;font-size:11px;text-transform:uppercase;
    letter-spacing:.05em;color:#9aa0aa;padding:8px 10px;cursor:pointer;user-select:none;white-space:nowrap;}
  .ayt-table th:hover{color:#e6e8ec;}
  .ayt-table td{color:#e6e8ec;padding:7px 10px;border-top:1px solid #2c313b;vertical-align:top;}
  .ayt-table tr.ayt-row{cursor:pointer;}
  .ayt-table tr.ayt-row:hover td{background:#1b1e25;}
  .ayt-table tr.ayt-sel td{background:#262b34;box-shadow:inset 3px 0 0 #6f97ff;}
  .ayt-table td.ayt-t{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9ecbff;}
  .ayt-table td.ayt-n{white-space:nowrap;color:#c3c8d0;}
  .ayt-input{background:#161a20;color:#e6e8ec;border:1px solid #2c313b;border-radius:7px;padding:6px 9px;font-size:12.5px;outline:none;min-width:0;}
  .ayt-input:focus{border-color:#6f97ff;}
  .ayt-btn{background:#1e2128;color:#e6e8ec;border:1px solid #2c313b;border-radius:7px;padding:6px 12px;cursor:pointer;font-size:12.5px;pointer-events:auto;}
  .ayt-btn:hover{border-color:#6f97ff;}
  .ayt-btn[disabled]{opacity:.45;cursor:default;}
  .ayt-btn.primary{background:#6f97ff;color:#fff;border-color:#6f97ff;font-weight:650;}
  .ayt-btn.danger{background:#e5736f;color:#fff;border-color:#e5736f;font-weight:650;}
  .ayt-btn.small{padding:3px 8px;font-size:11.5px;}
  .ayt-viewhead{padding:12px 14px;border-bottom:1px solid #2c313b;display:flex;flex-direction:column;gap:8px;}
  .ayt-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
  .ayt-note{font-size:11.5px;color:#9aa0aa;}
  .ayt-note.warn{color:#f5a524;}
  .ayt-grid{flex:1;overflow:auto;padding:12px 14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));
    gap:10px;align-content:start;}
  .ayt-tile{background:#15171c;border:1px solid #2c313b;border-radius:7px;overflow:hidden;display:flex;flex-direction:column;}
  .ayt-tile .ayt-img{height:110px;background:#0e1014;display:flex;align-items:center;justify-content:center;}
  .ayt-tile img{max-width:100%;max-height:110px;object-fit:contain;display:block;}
  .ayt-tile .ayt-fn{font-size:12px;padding:6px 8px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .ayt-tile .ayt-path{font-size:10.5px;color:#9aa0aa;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .ayt-tile .ayt-from{font-size:10.5px;color:#9aa0aa;padding:2px 8px 0;}
  .ayt-tile .ayt-tilebtns{display:flex;gap:6px;padding:6px 8px 8px;flex-wrap:wrap;}
  .ayt-foot{display:flex;gap:10px;align-items:center;padding:12px 18px;border-top:1px solid #2c313b;background:#1e2128;}
  .ayt-msg{font-size:12px;color:#9aa0aa;flex:1;}
  .ayt-empty{padding:30px;text-align:center;color:#9aa0aa;font-size:12.5px;}
  .ayt-card [hidden]{display:none !important;}
  `;

let openPage = null;

// ctx = { anchor (the element that asked: decides root and window), select (a tag name to open on) }
export async function openTagManager(ctx = {}) {
  if (openPage) { openPage.focus(ctx.select); return; }
  await closeHostDialogs();
  const parent = uiRoot(ctx.anchor);
  const doc = parent.ownerDocument || document;
  const win = doc.defaultView || window;

  const h = (tag, props = {}, kids = []) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "className") e.className = v;
      else if (k === "textContent") e.textContent = v;
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const c of [].concat(kids)) if (c) e.append(c);
    return e;
  };

  const state = { rows: [], sortKey: "tag", dir: 1, q: "", inspect: ctx.select ? String(ctx.select) : null,
                  pending: null, hostError: "" };

  const overlay = h("div", { className: "ayt-overlay" });
  const card = h("div", { className: "ayt-card" });
  overlay.append(card);
  const filter = h("input", { className: "ayt-input", placeholder: "Filter tags or file names…", style: "width:240px" });
  const closeBtn = h("button", { className: "ayt-btn", textContent: "Close" });
  card.append(h("div", { className: "ayt-head" }, [h("h2", { textContent: "Manage tags" }), filter, closeBtn]));
  const list = h("div", { className: "ayt-list" });
  const view = h("div", { className: "ayt-view" });
  card.append(h("div", { className: "ayt-main" }, [list, view]));
  const msg = h("div", { className: "ayt-msg" });
  const yesBtn = h("button", { className: "ayt-btn danger", textContent: "Yes", hidden: true });
  const noBtn = h("button", { className: "ayt-btn", textContent: "Cancel", hidden: true });
  card.append(h("div", { className: "ayt-foot" }, [msg, noBtn, yesBtn]));

  const say = (t) => { msg.textContent = t || ""; };
  const visible = () => sortTagRows(filterTagRows(state.rows, state.q), state.sortKey, state.dir);
  const current = () => state.rows.find((r) => r.key === state.inspect || r.tag === state.inspect) || null;

  // An action waiting for "Yes": its sentence in the foot, the buttons beside it.
  const ask = (text, run, yesLabel = "Yes") => {
    state.pending = { text, run };
    yesBtn.textContent = yesLabel;
    yesBtn.hidden = noBtn.hidden = false;
    say(text);
    yesBtn.focus();
  };
  // Our own change announces itself too; the reload after it is the one that counts.
  const act = async (run) => { state.acting = true; try { await run(); } finally { state.acting = false; } };
  const unask = () => { state.pending = null; yesBtn.hidden = noBtn.hidden = true; };

  function renderList() {
    list.replaceChildren();
    const rows = visible();
    if (!rows.length) {
      list.append(h("div", { className: "ayt-empty", textContent: state.rows.length ? "No tag matches." : "No tags yet. Tag a picture in the viewer (right-click → Tag for agentY) or add an `agentY add tag` node." }));
      return;
    }
    const head = h("tr", {}, COLUMNS.map((c) => {
      const th = h("th", { textContent: c.label + (state.sortKey === c.key ? (state.dir > 0 ? " ▲" : " ▼") : "") });
      th.addEventListener("click", () => {
        if (state.sortKey === c.key) state.dir = -state.dir; else { state.sortKey = c.key; state.dir = c.key === "images" ? -1 : 1; }
        renderList();
      });
      return th;
    }));
    const body = h("tbody");
    const sel = current();
    for (const r of rows) {
      const tr = h("tr", { className: "ayt-row" + (sel && sel.key === r.key ? " ayt-sel" : "") }, [
        h("td", { className: "ayt-t", textContent: "#" + r.tag, title: r.role || r.tag }),
        h("td", { className: "ayt-n", textContent: sourceText(r) }),
        h("td", { className: "ayt-n", textContent: String(r.images.length) }),
      ]);
      tr.dataset.key = r.key;
      tr.addEventListener("click", () => { unask(); say(""); inspect(r.key); });
      body.append(tr);
    }
    list.append(h("table", { className: "ayt-table" }, [h("thead", {}, head), body]));
  }

  // ── thumbnails, a few at a time as they come into view ──────────────────────
  let loader = null;
  function makeLoader(root) {
    if (loader) loader.stop();
    const queue = [], inflight = new Set();
    const pump = () => {
      while (inflight.size < THUMB_LOADS && queue.length) {
        const img = queue.shift();
        if (!img.isConnected || !img._ayUrl) continue;
        inflight.add(img);
        const done = () => { inflight.delete(img); pump(); };
        img.onload = done;
        img.onerror = () => { img.style.visibility = "hidden"; done(); };
        img.src = img._ayUrl;
        img._ayUrl = null;
      }
    };
    const IO = win.IntersectionObserver || window.IntersectionObserver;
    const io = IO ? new IO((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); queue.push(e.target); }
      pump();
    }, { root, rootMargin: "200px" }) : null;
    loader = {
      add(img, url) { img._ayUrl = url; if (io) io.observe(img); else { queue.push(img); pump(); } },
      stop() { if (io) io.disconnect(); queue.length = 0; },
    };
    return loader;
  }

  function inspect(key) {
    state.inspect = key;
    renderList();
    const r = current();
    if (!r) { view.replaceChildren(h("div", { className: "ayt-empty", textContent: "Click a tag to see its pictures." })); return; }
    const canvasNodes = r.nodes || [];
    const nodeText = canvasNodes.length === 1 ? `canvas node #${canvasNodes[0].id} '${canvasNodes[0].title}'`
      : `${canvasNodes.length} canvas nodes (${canvasNodes.map((n) => "#" + n.id).join(", ")})`;

    const name = h("input", { className: "ayt-input", value: r.tag, style: "flex:1;min-width:120px" });
    const renameBtn = h("button", { className: "ayt-btn", textContent: "Rename" });
    const others = state.rows.filter((x) => x.key !== r.key);
    const mergeSel = h("select", { className: "ayt-input", title: "The tag this one is merged into" });
    mergeSel.append(h("option", { value: "", textContent: "Merge into…" }));
    for (const o of sortTagRows(others, "tag", 1)) mergeSel.append(h("option", { value: o.tag, textContent: "#" + o.tag }));
    const keepSel = h("select", { className: "ayt-input", title: "Both tags have a remembered picture: which one the merged tag keeps", hidden: true });
    keepSel.append(h("option", { value: "into", textContent: "keep its picture" }),
                   h("option", { value: "from", textContent: `keep #${r.tag}'s picture` }));
    const mergeBtn = h("button", { className: "ayt-btn", textContent: "Merge", disabled: true });
    const delBtn = h("button", { className: "ayt-btn danger", textContent: "Delete tag…" });
    mergeSel.addEventListener("change", () => {
      const into = others.find((o) => o.tag === mergeSel.value);
      mergeBtn.disabled = !into;
      keepSel.hidden = !(into && into.memory && r.memory);
    });

    const notes = h("div", { className: "ayt-note" });
    const lines = [];
    if (canvasNodes.length) lines.push(`On the open canvas: ${nodeText}. Renaming or deleting asks first, then edits the node's tag field.`);
    if (r.memory) lines.push(`Remembered in the project${r.memory.origin === "viewer" ? " (tagged in the viewer)" : r.memory.origin === "canvas" ? " (a tag node's remember switch)" : ""}.`);
    if (canvasNodes.length && r.memory && r.memory.origin === "canvas") lines.push("A tag node with remember on writes the remembered tag again on the next run.");
    notes.textContent = lines.join(" ");
    if (state.hostError && !r.memory && !canvasNodes.length) notes.textContent = state.hostError;

    const busy = (on) => { for (const b of [renameBtn, mergeBtn, delBtn]) b.disabled = on; };
    const after = async (res, keyAfter) => {
      busy(false);
      if (!res.ok) { say(res.message || "That did not work."); return; }
      await reload(keyAfter);
      say(res.message || "Done.");
    };

    const doRename = () => {
      const { name: to, error } = checkTagName(name.value);
      if (error) { say(error); name.focus(); return; }
      if (to === r.tag) return;
      if (!r.memory && state.hostError && !canvasNodes.length) { say(state.hostError); return; }
      const run = async () => { busy(true); await after(await renameEverywhere(r, to, { withCanvas: canvasNodes.length > 0 }), to); };
      if (canvasNodes.length) ask(`Rename #${r.tag} to #${to}? This also edits the tag field of ${nodeText}. Hook prompts that say #${r.tag} are not rewritten.`, run, "Rename");
      else act(run);
    };
    renameBtn.addEventListener("click", doRename);
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") doRename(); });
    mergeBtn.addEventListener("click", () => {
      const into = mergeSel.value;
      if (!into) return;
      const parts = [`Merge #${r.tag} into #${into}? Afterwards only #${into} exists.`];
      if (canvasNodes.length) parts.push(`The tag field of ${nodeText} becomes #${into}.`);
      if (!keepSel.hidden) parts.push(keepSel.value === "from" ? `#${into} will point at #${r.tag}'s picture; its own is untagged.` : `#${r.tag}'s remembered picture is untagged.`);
      ask(parts.join(" "), async () => {
        busy(true);
        await after(await mergeInto(r, into, { keep: keepSel.hidden ? "into" : keepSel.value, withCanvas: canvasNodes.length > 0 }), into);
      }, "Merge");
    });
    delBtn.addEventListener("click", () => {
      const parts = [`Delete #${r.tag}?`];
      if (r.memory) parts.push("The remembered tag is forgotten; the pictures stay where they are.");
      if (canvasNodes.length) parts.push(`The tag field of ${nodeText} is cleared.`);
      parts.push(`Hook prompts that say #${r.tag} will no longer find it.`);
      ask(parts.join(" "), async () => { busy(true); await after(await deleteEverywhere(r, { withCanvas: canvasNodes.length > 0 }), null); }, "Delete");
    });

    const grid = h("div", { className: "ayt-grid" });
    const L = makeLoader(grid);
    const shown = r.images.slice(0, GRID_CAP);
    for (const img of shown) {
      const pic = h("img", { alt: "", loading: "lazy", decoding: "async" });
      L.add(pic, thumbUrl(img.path));
      const openBtn = h("button", { className: "ayt-btn small", textContent: "Open in viewer" });
      openBtn.addEventListener("click", async () => {
        const ok = await openInViewer(img.path);
        if (ok) close(); else say("The viewer could not open it here.");
      });
      const rmBtn = h("button", { className: "ayt-btn small", textContent: "Remove from tag" });
      rmBtn.addEventListener("click", () => {
        const fromCanvas = img.from.includes("canvas");
        const nodes = img.nodes.length ? img.nodes : [];
        const where = nodes.length === 1 ? `canvas node #${nodes[0].id} '${nodes[0].title}'` : `${nodes.length} canvas nodes`;
        const text = fromCanvas
          ? `Take #${r.tag} off ${img.name}? This picture is tagged by ${where}; its tag field is cleared.`
          : `Take #${r.tag} off ${img.name}?`;
        ask(text, async () => { busy(true); await after(await removeImage(r, img, { withCanvas: fromCanvas }), r.key); }, "Remove");
      });
      const tile = h("div", { className: "ayt-tile", title: img.path }, [
        h("div", { className: "ayt-img" }, pic),
        h("div", { className: "ayt-fn", textContent: img.name }),
        h("div", { className: "ayt-path", textContent: img.path }),
        h("div", { className: "ayt-from", textContent: [img.from.includes("canvas") ? "canvas" : "", img.from.includes("memory") ? "remembered" : "", img.exists === false ? "file missing" : ""].filter(Boolean).join(" · ") }),
        h("div", { className: "ayt-tilebtns" }, [openBtn, rmBtn]),
      ]);
      tile.dataset.path = img.path;
      grid.append(tile);
    }
    if (!r.images.length) grid.append(h("div", { className: "ayt-empty", textContent: "No picture is behind this tag (a tag node not wired to a loader)." }));
    if (r.images.length > shown.length) grid.append(h("div", { className: "ayt-note", textContent: `${r.images.length - shown.length} more not shown.` }));

    view.replaceChildren(
      h("div", { className: "ayt-viewhead" }, [
        h("div", { className: "ayt-actions" }, [name, renameBtn]),
        h("div", { className: "ayt-actions" }, [mergeSel, keepSel, mergeBtn, delBtn]),
        notes,
      ]),
      grid);
  }

  async function reload(selectKey) {
    const { rows, hostError } = await loadTagRows();
    state.rows = rows;
    state.hostError = hostError;
    if (hostError) say(hostError + " Remembered tags are shown, but cannot be changed.");
    const want = selectKey === undefined ? state.inspect : selectKey;
    const hit = want ? rows.find((r) => r.key === want || r.tag === want || r.key === tagKey(want)) : null;
    state.inspect = hit ? hit.key : null;
    if (hit) inspect(hit.key);
    else { renderList(); view.replaceChildren(h("div", { className: "ayt-empty", textContent: "Click a tag to see its pictures." })); }
  }

  // Someone else changed tags (the viewer's Remove tag, a Tag for agentY): read again.
  let busyReload = false;
  const onChanged = async () => {
    if (busyReload || state.pending || state.acting) return;
    busyReload = true;
    try { await reload(); } finally { busyReload = false; }
  };

  function close() {
    doc.removeEventListener("keydown", onKey, true);
    window.removeEventListener(TAGS_CHANGED, onChanged);
    if (loader) loader.stop();
    overlay.remove();
    openPage = null;
  }
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (state.pending) { unask(); say(""); } else close();
  };
  doc.addEventListener("keydown", onKey, true);
  window.addEventListener(TAGS_CHANGED, onChanged);
  // The viewer and ComfyUI have their own hotkeys; typing here must not reach them.
  for (const type of ["keydown", "keyup", "keypress"]) card.addEventListener(type, (e) => e.stopPropagation());
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  filter.addEventListener("input", () => { state.q = filter.value; renderList(); });
  noBtn.addEventListener("click", () => { unask(); say(""); });
  yesBtn.addEventListener("click", async () => {
    const p = state.pending;
    unask();
    if (p) await act(p.run);
  });

  ensureStyleIn(parent, STYLE_ID, STYLES);
  parent.append(overlay);
  openPage = { close, focus: (tag) => { if (tag) reload(String(tag)); } };
  view.append(h("div", { className: "ayt-empty", textContent: "Loading…" }));
  await reload(state.inspect);
  filter.focus();
}

window.agentYOpenTagManager = openTagManager;
app.registerExtension({ name: "agentY.tagManager" });
