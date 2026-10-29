import { app } from "../../scripts/app.js";
import { backendBase } from "./agent_backend.js";
import { closeHostDialogs } from "./agent_settings.js";
import { uiRoot, ensureStyleIn } from "./agent_ui_root.js";

// agentY conversations - the "Manage conversations" page, and the helpers the
// sidebar's conversation menu (agent_chat.js) shares with it.
//
// The page looks like the agentY Settings modal (same palette, card, head and
// foot) and has the same two traps handled:
//   * it is appended to <body>, so while ComfyUI's own modal Settings dialog is
//     open it inherits pointer-events:none and nothing in it can be clicked
//     (connect commit 6c01950). Same fix: the overlay sets pointer-events:auto
//     itself, and the host dialog is closed first.
//   * the delete confirmation lives IN the page. window.confirm would be blocked
//     behind a modal and cannot say how many conversations are about to go.
//
// The host owns the data: GET /agentY/threads?detail=1, GET /agentY/threads/<id>,
// POST /agentY/threads/<id>/rename, POST /agentY/threads/delete.

// ── pure helpers (also what the tests drive) ────────────────────────────────

export const COLUMNS = [
  { key: "title", label: "Title" },
  { key: "created_at", label: "Created" },
  { key: "updated_at", label: "Last active" },
  { key: "message_count", label: "Msgs" },
  { key: "size_chars", label: "Size" },
  { key: "preview", label: "First message" },
];

export function sortRows(rows, key, dir = 1) {
  const num = key.endsWith("_at") || key === "message_count" || key === "size_chars";
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    const c = num ? (Number(x) || 0) - (Number(y) || 0)
                  : String(x || "").localeCompare(String(y || ""), undefined, { sensitivity: "base" });
    return c * dir;
  });
}

export function filterRows(rows, q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => `${r.title || ""}\n${r.preview || ""}`.toLowerCase().includes(needle));
}

export function fmtSize(chars) {
  const n = Number(chars) || 0;
  return n < 1000 ? n + " ch" : n < 1e6 ? (n / 1000).toFixed(1) + " k" : (n / 1e6).toFixed(1) + " M";
}

export function fmtDate(t) {
  const n = Number(t);
  if (!n) return "";
  const d = new Date(n * 1000);
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function confirmText(n) {
  return `Delete ${n} conversation${n === 1 ? "" : "s"}? This cannot be undone.`;
}

// ── host calls ──────────────────────────────────────────────────────────────

const json = { "Content-Type": "application/json" };

export async function renameConversation(id, title) {
  const r = await fetch(backendBase() + "/agentY/threads/" + encodeURIComponent(id) + "/rename",
    { method: "POST", headers: json, body: JSON.stringify({ title }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
  return d.title || title;
}

// -> { deleted, deleted_ids, skipped }: skipped are conversations with a turn
// running, which the host refuses to delete.
export async function deleteConversations(ids) {
  const r = await fetch(backendBase() + "/agentY/threads/delete",
    { method: "POST", headers: json, body: JSON.stringify({ ids }) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

export async function searchConversations(q) {
  const r = await fetch(backendBase() + "/agentY/threads/search?q=" + encodeURIComponent(q),
    { cache: "no-store" });
  return r.ok ? r.json() : [];
}

// ── the page ────────────────────────────────────────────────────────────────

function h(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "className") e.className = v;
    else if (k === "textContent") e.textContent = v;
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c) e.append(c);
  return e;
}

const STYLE_ID = "agentY-conversations-style";
const STYLES = `
  .ayc-overlay{position:fixed;inset:0;background:rgba(8,9,12,.6);z-index:10000;display:flex;pointer-events:auto;
    align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;}
  .ayc-card{background:#15171c;color:#e6e8ec;border:1px solid #2c313b;border-radius:9px;pointer-events:auto;
    width:min(1040px,95vw);height:min(720px,90vh);display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.6);overflow:hidden;}
  .ayc-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #2c313b;background:#1e2128;}
  .ayc-head h2{font-size:15px;margin:0;font-weight:650;flex:1;}
  .ayc-main{display:flex;flex:1;min-height:0;}
  .ayc-list{flex:1 1 60%;min-width:0;overflow:auto;}
  .ayc-view{flex:1 1 40%;min-width:0;border-left:1px solid #2c313b;display:flex;flex-direction:column;background:#1e2128;}
  .ayc-list::-webkit-scrollbar,.ayc-msgs::-webkit-scrollbar{width:8px;}
  .ayc-list::-webkit-scrollbar-thumb,.ayc-msgs::-webkit-scrollbar-thumb{background:#262b34;border-radius:8px;}
  .ayc-table{width:100%;border-collapse:collapse;font-size:12.5px;}
  .ayc-table th{position:sticky;top:0;background:#1e2128;text-align:left;font-size:11px;text-transform:uppercase;
    letter-spacing:.05em;color:#9aa0aa;padding:8px 10px;cursor:pointer;user-select:none;white-space:nowrap;}
  .ayc-table th:hover{color:#e6e8ec;}
  .ayc-table td{padding:7px 10px;border-top:1px solid #2c313b;vertical-align:top;}
  .ayc-table tr.ayc-row{cursor:pointer;}
  .ayc-table tr.ayc-row:hover td{background:#1b1e25;}
  .ayc-table tr.ayc-sel td{background:#262b34;box-shadow:inset 3px 0 0 #6f97ff;}
  .ayc-table td.ayc-prev{color:#9aa0aa;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .ayc-table td.ayc-t{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .ayc-table td.ayc-n{white-space:nowrap;color:#c3c8d0;}
  .ayc-table input[type=checkbox]{width:15px;height:15px;accent-color:#6f97ff;cursor:pointer;}
  .ayc-input{background:#161a20;color:#e6e8ec;border:1px solid #2c313b;border-radius:7px;padding:6px 9px;font-size:12.5px;outline:none;min-width:0;}
  .ayc-input:focus{border-color:#6f97ff;}
  .ayc-btn{background:#1e2128;color:#e6e8ec;border:1px solid #2c313b;border-radius:7px;padding:7px 14px;cursor:pointer;font-size:12.5px;pointer-events:auto;}
  .ayc-btn:hover{border-color:#6f97ff;}
  .ayc-btn[disabled]{opacity:.45;cursor:default;}
  .ayc-btn.primary{background:#6f97ff;color:#fff;border-color:#6f97ff;font-weight:650;}
  .ayc-btn.danger{background:#e5736f;color:#fff;border-color:#e5736f;font-weight:650;}
  .ayc-viewhead{padding:12px 14px;border-bottom:1px solid #2c313b;display:flex;flex-direction:column;gap:8px;}
  .ayc-viewhead .ayc-actions{display:flex;gap:8px;flex-wrap:wrap;}
  .ayc-msgs{flex:1;overflow:auto;padding:10px 14px;display:flex;flex-direction:column;gap:8px;}
  .ayc-m{font-size:12.5px;white-space:pre-wrap;word-break:break-word;border-radius:7px;padding:7px 10px;background:#15171c;border:1px solid #2c313b;}
  .ayc-m.user{border-left:3px solid #6f97ff;}
  .ayc-m b{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#9aa0aa;margin-bottom:3px;}
  .ayc-foot{display:flex;gap:10px;align-items:center;padding:12px 18px;border-top:1px solid #2c313b;background:#1e2128;}
  .ayc-msg{font-size:12px;color:#9aa0aa;flex:1;}
  .ayc-empty{padding:30px;text-align:center;color:#9aa0aa;font-size:12.5px;}
  .ayc-card [hidden]{display:none !important;}
  `;

function injectStyles() {
  ensureStyleIn(document.body, STYLE_ID, STYLES);
}

let openPage = null;

// ctx = { currentId, onOpen(id), onRenamed(id, title), onDeleted(ids) }
export async function openConversationManager(ctx = {}) {
  if (openPage) return;
  injectStyles();
  await closeHostDialogs();

  const state = { rows: [], sortKey: "updated_at", dir: -1, q: "", checked: new Set(),
                  inspect: null, confirming: false };

  const overlay = h("div", { className: "ayc-overlay" });
  const card = h("div", { className: "ayc-card" });
  overlay.append(card);
  const filter = h("input", { className: "ayc-input", placeholder: "Filter by title or first message…",
    style: "width:260px" });
  const closeBtn = h("button", { className: "ayc-btn", textContent: "Close" });
  card.append(h("div", { className: "ayc-head" },
    [h("h2", { textContent: "Manage conversations" }), filter, closeBtn]));

  const list = h("div", { className: "ayc-list" });
  const view = h("div", { className: "ayc-view" });
  card.append(h("div", { className: "ayc-main" }, [list, view]));

  const msg = h("div", { className: "ayc-msg" });
  const delBtn = h("button", { className: "ayc-btn danger", textContent: "Delete selected (0)", disabled: true });
  const yesBtn = h("button", { className: "ayc-btn danger", textContent: "Yes, delete", hidden: true });
  const noBtn = h("button", { className: "ayc-btn", textContent: "Cancel", hidden: true });
  card.append(h("div", { className: "ayc-foot" }, [msg, noBtn, yesBtn, delBtn]));

  const say = (t) => { msg.textContent = t || ""; };
  const visible = () => sortRows(filterRows(state.rows, state.q), state.sortKey, state.dir);

  const syncFoot = () => {
    const n = state.checked.size;
    delBtn.textContent = `Delete selected (${n})`;
    delBtn.disabled = n === 0;
    delBtn.hidden = state.confirming;
    yesBtn.hidden = noBtn.hidden = !state.confirming;
    if (state.confirming) say(confirmText(n));
  };

  function renderList() {
    list.replaceChildren();
    const rows = visible();
    if (!rows.length) {
      list.append(h("div", { className: "ayc-empty", textContent: state.rows.length ? "No conversation matches." : "No conversations." }));
      return syncFoot();
    }
    const all = h("input", { type: "checkbox", title: "Select all shown" });
    all.checked = rows.every((r) => state.checked.has(r.id));
    all.addEventListener("click", (e) => e.stopPropagation());
    all.addEventListener("change", () => {
      for (const r of rows) all.checked ? state.checked.add(r.id) : state.checked.delete(r.id);
      state.confirming = false;
      renderList();
    });
    const head = h("tr", {}, [h("th", {}, all), ...COLUMNS.map((c) => {
      const th = h("th", { textContent: c.label + (state.sortKey === c.key ? (state.dir > 0 ? " ▲" : " ▼") : "") });
      th.addEventListener("click", () => {
        if (state.sortKey === c.key) state.dir = -state.dir; else { state.sortKey = c.key; state.dir = c.key === "title" ? 1 : -1; }
        renderList();
      });
      return th;
    })]);
    const body = h("tbody");
    for (const r of rows) {
      const cb = h("input", { type: "checkbox" });
      cb.checked = state.checked.has(r.id);
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        cb.checked ? state.checked.add(r.id) : state.checked.delete(r.id);
        state.confirming = false;
        syncFoot();
        all.checked = rows.every((x) => state.checked.has(x.id));
      });
      const tr = h("tr", { className: "ayc-row" + (state.inspect === r.id ? " ayc-sel" : "") }, [
        h("td", {}, cb),
        h("td", { className: "ayc-t", textContent: (r.running ? "🟢 " : "") + (r.title || "New chat"), title: r.title || "" }),
        h("td", { className: "ayc-n", textContent: fmtDate(r.created_at) }),
        h("td", { className: "ayc-n", textContent: fmtDate(r.updated_at) }),
        h("td", { className: "ayc-n", textContent: String(r.message_count ?? 0) }),
        h("td", { className: "ayc-n", textContent: fmtSize(r.size_chars) }),
        h("td", { className: "ayc-prev", textContent: r.preview || "", title: r.preview || "" }),
      ]);
      tr.addEventListener("click", () => inspect(r.id));
      body.append(tr);
    }
    list.append(h("table", { className: "ayc-table" }, [h("thead", {}, head), body]));
    syncFoot();
  }

  async function inspect(id) {
    state.inspect = id;
    renderList();
    view.replaceChildren(h("div", { className: "ayc-empty", textContent: "Loading…" }));
    let t = null;
    try {
      const r = await fetch(backendBase() + "/agentY/threads/" + encodeURIComponent(id), { cache: "no-store" });
      if (r.ok) t = await r.json();
    } catch (_) {}
    if (state.inspect !== id) return;
    if (!t) return view.replaceChildren(h("div", { className: "ayc-empty", textContent: "Could not read this conversation." }));
    const title = h("input", { className: "ayc-input", value: t.title || "" });
    const rename = h("button", { className: "ayc-btn", textContent: "Rename" });
    const open = h("button", { className: "ayc-btn primary", textContent: "Open" });
    const doRename = async () => {
      const v = title.value.trim();
      if (!v) return;
      try {
        const saved = await renameConversation(id, v);
        const row = state.rows.find((x) => x.id === id);
        if (row) row.title = saved;
        title.value = saved;
        if (ctx.onRenamed) ctx.onRenamed(id, saved);
        say("Renamed.");
        renderList();
      } catch (e) { say("Rename failed: " + e.message); }
    };
    rename.addEventListener("click", doRename);
    title.addEventListener("keydown", (e) => { if (e.key === "Enter") doRename(); });
    open.addEventListener("click", () => { close(); if (ctx.onOpen) ctx.onOpen(id); });
    const msgs = h("div", { className: "ayc-msgs" });
    for (const m of t.messages || []) {
      msgs.append(h("div", { className: "ayc-m " + (m.role || "") },
        [h("b", { textContent: (m.role || "") + (m.created_at ? " · " + fmtDate(m.created_at) : "") }), m.content || ""]));
    }
    if (!msgs.children.length) msgs.append(h("div", { className: "ayc-empty", textContent: "No messages." }));
    view.replaceChildren(
      h("div", { className: "ayc-viewhead" }, [title, h("div", { className: "ayc-actions" }, [open, rename])]), msgs);
  }

  function close() {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    openPage = null;
  }
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (state.confirming) { state.confirming = false; syncFoot(); say(""); } else close();
  };
  document.addEventListener("keydown", onKey, true);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  filter.addEventListener("input", () => { state.q = filter.value; renderList(); });
  delBtn.addEventListener("click", () => { state.confirming = true; syncFoot(); });
  noBtn.addEventListener("click", () => { state.confirming = false; syncFoot(); say(""); });
  yesBtn.addEventListener("click", async () => {
    const ids = [...state.checked];
    yesBtn.disabled = true;
    try {
      const res = await deleteConversations(ids);
      const gone = new Set(res.deleted_ids || []);
      state.rows = state.rows.filter((r) => !gone.has(r.id));
      for (const id of gone) state.checked.delete(id);
      if (gone.has(state.inspect)) { state.inspect = null; view.replaceChildren(); }
      state.confirming = false;
      renderList();
      const skipped = (res.skipped || []).length;
      say(`Deleted ${res.deleted}.` + (skipped ? ` ${skipped} not deleted: a turn is running in it.` : ""));
      if (gone.size && ctx.onDeleted) ctx.onDeleted([...gone]);
    } catch (e) {
      say("Delete failed: " + e.message);
    } finally { yesBtn.disabled = false; }
  });

  // Beside the panel that asked, not on the page: the viewer hides the page body
  // and keeps the panel in a shadow root (agent_ui_root.js).
  const parent = uiRoot(ctx.anchor);
  ensureStyleIn(parent, STYLE_ID, STYLES);
  parent.append(overlay);
  openPage = { close };
  view.append(h("div", { className: "ayc-empty", textContent: "Click a conversation to read it." }));
  try {
    const r = await fetch(backendBase() + "/agentY/threads?detail=1", { cache: "no-store" });
    state.rows = r.ok ? await r.json() : [];
    if (!r.ok) say("The agentY host did not answer.");
  } catch (_) { say("The agentY host is not reachable."); }
  renderList();
  filter.focus();
}

window.agentYOpenConversations = openConversationManager;
app.registerExtension({ name: "agentY.conversations" });
