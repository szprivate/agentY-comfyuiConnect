import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { backendBase } from "./agent_backend.js";
import { watchDocument } from "./agent_tags.js";

// Where the agentY panel is shown, and what can be dropped on it.
//
// There is ONE panel per page (see AgentChat in agent_chat.js): its DOM is built
// once and re-parented into whichever place shows it. The sidebar tab is one such
// place; the bEpic viewer (ComfyUI-ImageViewer) offers a second, a dock panel. The
// panel is MOVED, not copied, so both "views" are trivially the same conversation:
// the stream, the tool cards, the approval cards, Send and Stop are one set of
// objects. Nothing about the host, the SSE streams or the canvas side effects is
// done twice.
//
// The two sides meet in two small objects on the page, and nothing else is shared:
//
//   window.agentYPanelHost  (this file)
//       mountInto(el, { where, back })   move the panel into el (the viewer's body)
//       toSidebar({ quiet })             give it back to the sidebar tab
//       where()                          "sidebar" | "viewer"
//   window.bEpicViewerApi   (the viewer; every use is optional)
//       openAgentPanel() / closeAgentPanel() / extractFrame(item)
//
// Also here: drag and drop onto the panel. A file from the desktop, or a picture
// dragged out of the viewer (history strip, file browser, the frame on screen), ends
// up in `chat.attachments` as {path, name} - the same shape the paperclip makes.

const BEPIC_TYPE = "application/x-bepic-history";
const SIDEBAR_TAB = "agentY-chat";

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style") Object.assign(n.style, v);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
}

// Lucide arrow-up-right / arrow-down-left (ISC): "out to the viewer" / "back here".
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" `
  + `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON_OUT = svg('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>');
const ICON_BACK = svg('<path d="M17 7 7 17"/><path d="M17 17H7V7"/>');

const CSS = `
.ay-viewer-btn{flex-shrink:0;}
.ay-bar select{min-width:60px;}
.ay-wrap.ay-drop-hover{outline:2px dashed var(--ay-accent,#6f97ff);outline-offset:-6px;}
.ay-wrap.ay-drop-hover::after{content:"Drop to attach";position:absolute;left:50%;top:44px;transform:translateX(-50%);
  background:rgba(21,23,28,.92);color:var(--ay-accent,#6f97ff);font-size:12px;padding:4px 12px;border-radius:5px;
  pointer-events:none;z-index:60;}
.ay-away{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;
  padding:24px;text-align:center;box-sizing:border-box;color:#9aa0aa;background:#15171c;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:1.5;}
.ay-away button{background:#262b34;color:#e6e8ec;border:1px solid #2c313b;border-radius:7px;padding:7px 12px;
  font-size:12.5px;cursor:pointer;}
.ay-away button:hover{border-color:#6f97ff;}
`;

function ensureStyles() {
  if (document.getElementById("agentY-panel-host-styles")) return;
  document.head.append(el("style", { id: "agentY-panel-host-styles", textContent: CSS }));
}

// The panel's CSS is a <style> in the ComfyUI document. The viewer shows it inside
// a shadow root (docked) or another document (popped out), where that stylesheet
// does not reach: carry a copy of every agentY stylesheet over. The viewer copies
// a shadow root's styles into its popout window by itself, so a copy made in the
// shadow root survives an undock.
function carryStyles(target) {
  const root = target.getRootNode ? target.getRootNode() : document;
  if (!root || root === document) return;
  const into = root.head || root;      // a Document has a head; a ShadowRoot is its own
  for (const s of document.head.querySelectorAll('style[id^="agentY"]')) {
    const mark = `[data-ay-copy="${s.id}"]`;
    let c = into.querySelector("style" + mark);
    if (!c) { c = el("style"); c.dataset.ayCopy = s.id; into.append(c); }
    if (c.textContent !== s.textContent) c.textContent = s.textContent;
  }
}

const basename = (p) => String(p || "").replace(/\\/g, "/").split("/").pop() || "file";
const isAbs = (p) => /^([a-zA-Z]:[\\/]|[\\/]{2}|[\\/])/.test(String(p || ""));

// Where the bytes of a viewer item can be fetched when it is not a file on disk the
// host can read - the same three routes the viewer itself uses to show it.
function fetchUrlOf(p) {
  if (p.url) return p.url;
  if (p.path) {
    const route = p.external ? "/bepic/view_file" : "/bepic/raw_view";
    return api.apiURL(`${route}?path=${encodeURIComponent(p.path)}`);
  }
  if (p.filename) {
    let q = `?filename=${encodeURIComponent(p.filename)}`;
    if (p.type) q += `&type=${p.type}`;
    if (p.subfolder) q += `&subfolder=${encodeURIComponent(p.subfolder)}`;
    return api.apiURL(`/view${q}`);
  }
  return "";
}

async function uploadBlob(blob, name) {
  const fd = new FormData();
  fd.append("file", new File([blob], name, { type: blob.type || "application/octet-stream" }));
  const r = await fetch(backendBase() + "/agentY/upload", { method: "POST", body: fd });
  if (!r.ok) throw new Error(`upload failed (HTTP ${r.status})`);
  const j = await r.json();
  return { path: j.path, name: j.name };
}

// One dragged viewer item -> an attachment {path, name}, or null (already reported).
// A picture already on disk is attached where it lies, with no copy: that is what a
// selected loader node on the canvas does too. Anything the host cannot read by
// path (a frame the viewer holds only in the browser, a ComfyUI output) is fetched
// and uploaded like a file from the paperclip.
async function attachmentOf(chat, item) {
  let it = item;
  if (it.extractFrame != null) {
    // "Frame N of this clip": only the viewer can make that a picture.
    const viewer = window.bEpicViewerApi;
    if (!viewer || typeof viewer.extractFrame !== "function") {
      chat._sys("❌ The viewer is needed to take a frame out of a clip, and it is not loaded.");
      return null;
    }
    it = await viewer.extractFrame(it);
    if (!it) return null;               // the viewer said why
  }
  if (it.isSequence && it.seqDir) {
    return { path: it.seqDir, name: `${basename(it.seqDir)} (${it.seqCount || "?"} frames)` };
  }
  if (!it.dropped && isAbs(it.path)) return { path: it.path, name: basename(it.path) };
  const url = fetchUrlOf(it);
  if (!url) { chat._sys("❌ That picture has no file to attach."); return null; }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch failed (HTTP ${resp.status})`);
  const blob = await resp.blob();
  let name = basename(it.filename || it.path || (it.kind === "video" ? "video.mp4" : "image.png"));
  if (!/\.[A-Za-z0-9]{2,5}$/.test(name)) name += it.kind === "video" ? ".mp4" : ".png";
  return await uploadBlob(blob, name);
}

function carries(e, type) {
  try { return Array.from(e.dataTransfer?.types || []).includes(type); } catch (_) { return false; }
}

export function installPanelHost(chat) {
  ensureStyles();
  chat._where = "sidebar";       // "sidebar" | "viewer"
  chat._sidebarEl = null;        // the sidebar tab's mount point, when one is on screen
  chat._viewerEl = null;         // the viewer panel's body, while the panel is there
  chat._viewerBack = null;

  // ── the header button: ↗ open in viewer / ↙ back to the sidebar ──
  const bar = chat.wrap.querySelector(".ay-bar");
  chat.viewerBtn = el("button", { className: "ay-btn ay-viewer-btn" });
  chat.viewerBtn.addEventListener("click", () => {
    if (chat._where === "viewer") chat.backToSidebar(); else chat.openInViewer();
  });
  if (bar) bar.append(chat.viewerBtn);
  chat._syncViewerBtn = () => {
    const inViewer = chat._where === "viewer";
    chat.viewerBtn.innerHTML = inViewer ? ICON_BACK : ICON_OUT;
    chat.viewerBtn.title = inViewer ? "Back to the sidebar" : "Open in the viewer";
  };
  chat._syncViewerBtn();

  // The sidebar tab while the panel is in the viewer.
  chat._showAway = (elm) => {
    elm.innerHTML = "";
    elm.classList.remove("ay-host");
    const bring = el("button", { textContent: "Bring it back here" });
    bring.addEventListener("click", () => chat.backToSidebar());
    const show = el("button", { textContent: "Show it in the viewer" });
    show.addEventListener("click", () => chat.openInViewer());
    elm.append(el("div", { className: "ay-away" }, [
      el("div", { textContent: "agentY is open in the bEpic viewer." }), bring, show,
    ]));
  };

  chat.openInViewer = () => {
    const v = window.bEpicViewerApi;
    if (!v || typeof v.openAgentPanel !== "function") {
      chat._sys("⚠️ The bEpic viewer isn't loaded — install ComfyUI-ImageViewer and reload the page.");
      return;
    }
    v.openAgentPanel();
  };

  const openSidebarTab = () => {
    try {
      const em = app && app.extensionManager;
      const store = (em && em.sidebarTab) || em;
      if (store && typeof store.toggleSidebarTab === "function" && store.activeSidebarTabId !== SIDEBAR_TAB) {
        store.toggleSidebarTab(SIDEBAR_TAB);
      }
    } catch (_) {}
  };

  // Hand the panel back. The viewer puts its dock panel away, which calls
  // toSidebar({quiet}) below; the rest is making the sidebar visible.
  chat.backToSidebar = () => {
    const v = window.bEpicViewerApi;
    if (v && typeof v.closeAgentPanel === "function") { try { v.closeAgentPanel(); } catch (_) {} }
    if (chat._where === "viewer") chat.toSidebar({ quiet: true });   // the viewer is gone: do it ourselves
    openSidebarTab();
  };

  chat.mountInto = (elm, opts = {}) => {
    if (!elm) return;
    chat._where = opts.where || "viewer";
    chat._viewerEl = elm;
    chat._viewerBack = opts.back || null;
    carryStyles(elm);
    watchDocument(elm.ownerDocument);   // a popped-out viewer is another document
    chat.mount(elm);
    chat._syncViewerBtn();
    // The sidebar, if it is on screen, now says where the panel went.
    if (chat._sidebarEl && chat._sidebarEl.isConnected && chat._sidebarEl !== elm) chat._showAway(chat._sidebarEl);
  };

  chat.toSidebar = () => {
    if (chat._where !== "viewer") return;
    chat._where = "sidebar";
    chat._viewerEl = null;
    chat._viewerBack = null;
    if (chat._sidebarEl && chat._sidebarEl.isConnected) chat.mount(chat._sidebarEl);
    else chat.wrap.remove();      // no sidebar on screen: kept alive off-screen, as when you leave the tab
    chat._syncViewerBtn();
  };

  // ── attachments ──
  chat.attachFiles = async (files) => {
    for (const f of Array.from(files || [])) {
      try {
        const a = await uploadBlob(f, f.name || "upload");
        chat.attachments.push(a);
      } catch (e) { chat._sys("❌ Upload failed: " + e); }
    }
    chat._renderAttachments();
  };

  // What the viewer drags: {items: [...]} (a bare item is tolerated).
  chat.attachViewerItems = async (items) => {
    for (const item of (items || []).filter(Boolean)) {
      try {
        const a = await attachmentOf(chat, item);
        if (a && !chat.attachments.some((x) => x.path === a.path)) chat.attachments.push(a);
      } catch (e) { chat._sys("❌ Could not attach: " + e); }
    }
    chat._renderAttachments();
  };

  // ── drop onto the panel ──
  const wrap = chat.wrap;
  const accepts = (e) => carries(e, BEPIC_TYPE) || carries(e, "Files");
  const over = (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();      // ComfyUI would open a dropped picture as a workflow / loader node
    try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
    wrap.classList.add("ay-drop-hover");
  };
  wrap.addEventListener("dragenter", over);
  wrap.addEventListener("dragover", over);
  wrap.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
    wrap.classList.remove("ay-drop-hover");
  });
  wrap.addEventListener("drop", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.remove("ay-drop-hover");
    let payload = null;
    if (carries(e, BEPIC_TYPE)) {
      try { payload = JSON.parse(e.dataTransfer.getData(BEPIC_TYPE)); } catch (_) {}
    }
    if (payload) {
      chat.attachViewerItems(Array.isArray(payload.items) ? payload.items : [payload]);
    } else if (e.dataTransfer.files && e.dataTransfer.files.length) {
      chat.attachFiles(Array.from(e.dataTransfer.files));
    }
  });
}
