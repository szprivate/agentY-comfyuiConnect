import { app } from "../../scripts/app.js";
import { backendBase } from "./agent_backend.js";
import { agentTagList, announceTagsChanged } from "./agent_tags.js";
import { untagPicture, clearCanvasTagAt } from "./agent_tag_ops.js";

// The bEpic viewer (ComfyUI-ImageViewer) is agentY's standard viewer. It does not
// know agentY; it looks for this one object on the page and, when it is there,
// offers "Tag for agentY..." and "Approve for agentY" in its history menu:
//
//   window.agentYViewerBridge = { version, state(), tag(...), approve(...), tags() }
//
// Kept to the few things the viewer may ask, so the contract is this file.
//
//   tag      POST /agentY/viewer/tag on the host: the picture becomes a project
//            reference, so #name resolves like an `agentY add tag` node's.
//   approve  fills the review collector on the canvas with the approved files and
//            says "continue" - exactly what editing the collector and pressing
//            "Continue with these" does. The run reads the collector off the live
//            canvas when it resumes, so nothing else has to be told.

const COLLECTOR = "AgentYImageCollector";
const REVIEW_KEY = "agentY_review_key";

function say(ok, message, extra) {
  return Object.assign({ ok, message }, extra || {});
}

// The collectors a review halt filled, newest-created last (node ids only grow).
function reviewCollectors() {
  const graph = (app.canvas && app.canvas.graph) || app.graph;
  const nodes = (graph && graph._nodes) || [];
  return nodes.filter((n) => n && n.type === COLLECTOR && n.properties && n.properties[REVIEW_KEY]);
}

function state() {
  return { halted: !!window.agentYReviewHalted };
}

async function tag({ tag, path, role }) {
  let res;
  try {
    res = await fetch(backendBase() + "/agentY/viewer/tag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, path, role: role || "" }),
    });
  } catch (_) {
    return say(false, "The agentY host is not running, so the tag could not be saved.");
  }
  let j = {};
  try { j = await res.json(); } catch (_) {}
  if (!res.ok || !j.ok) return say(false, j.error || `The agentY host refused it (HTTP ${res.status}).`);
  announceTagsChanged({ tagged: [{ tag: j.tag, path }] });
  return say(true, `Tagged as #${j.tag}. Write #${j.tag} in a prompt to use it.`, { tag: j.tag });
}

async function approve({ files }) {
  const list = (files || []).map(String).filter(Boolean);
  if (!list.length) return say(false, "There is nothing to approve.");
  if (!window.agentYReviewHalted) return say(false, "agentY is not waiting at a review stop.");
  const found = reviewCollectors();
  if (!found.length) {
    return say(false, "The review stop has no collector on this canvas - open the graph it stopped on.");
  }
  if (typeof window.agentYRunHooks !== "function") {
    return say(false, "The agentY panel is not loaded yet - open the agentY sidebar tab once.");
  }
  const node = found[found.length - 1];
  const w = (node.widgets || []).find((x) => x && x.name === "files");
  if (!w) return say(false, "The review collector has no files box.");
  w.value = list.join("\n");
  try { if (w.callback) w.callback(w.value, app.canvas, node); } catch (_) {}
  try { node.setDirtyCanvas(true, true); } catch (_) {}
  let msg = "";
  try { msg = window.agentYRunHooks("continue", {}) || ""; } catch (e) { msg = "Failed: " + e; }
  if (/^(No active|agentY is waiting|Failed)/.test(msg)) return say(false, msg);
  return say(true, `Approved ${list.length} ${list.length === 1 ? "file" : "files"} - continuing the run.`);
}

window.agentYViewerBridge = { version: 1, state, tag, approve };

// feedback  the annotation tool's "Send to agentY": { text, files: [path, ...] } goes
//           to the active conversation as the user's next message, with the
//           flattened pictures attached. At a review stop it is the answer "change
//           this" (the text says so); it never presses Continue. Added to the
//           object above rather than into its literal, so a viewer without it
//           (older build) just does not show the button.
async function feedback({ text, files }) {
  const list = (files || []).map(String).filter(Boolean);
  const body = String(text || "").trim();
  if (!body && !list.length) return say(false, "There is nothing to send.");
  if (typeof window.agentYSendFeedback !== "function") {
    return say(false, "The agentY panel is not loaded yet - open the agentY sidebar tab once.");
  }
  const halted = !!window.agentYReviewHalted;
  let msg = "";
  try { msg = window.agentYSendFeedback({ text: body, files: list }) || ""; }
  catch (e) { return say(false, "Failed: " + e); }
  return say(true, (halted ? "Review feedback sent. " : "") + msg, { halted });
}
window.agentYViewerBridge.feedback = feedback;

// tags     every agentY tag - the canvas's `agentY add tag` nodes and the
//          project's remembered references, the list the `#` menu offers - as
//          [{ tag, path, role, source }]. The viewer lists them in the filter at
//          the bottom of its history panel and shows the pictures wearing one.
//          Pass { fresh: true } to skip the short cache.
window.agentYViewerBridge.tags = (opts) => agentTagList(opts || {});

// untag    the viewer's "Remove tag #name": { tag, path } -> { ok, message, removed,
//          canvas: [{ id, title }] }. The remembered reference for that picture is
//          forgotten. A tag that comes from an `agentY add tag` node on the canvas is
//          NOT touched: `canvas` names the node(s), and the viewer asks the user
//          before it calls clearCanvasTag.
// clearCanvasTag  { tag, path }: clear the tag field of the canvas node(s) that put
//          the tag on that picture - only after the user said yes.
// manageTags      { anchor, tag }: open the Manage tags page beside `anchor` (the
//          viewer's own element, so it opens in the viewer's root and window).
// Every change is announced as the window event "agenty-tags-changed", which the
// viewer listens for to repaint its filter and badges.
window.agentYViewerBridge.untag = ({ tag, path } = {}) => untagPicture(String(tag || ""), String(path || ""));
window.agentYViewerBridge.clearCanvasTag = ({ tag, path } = {}) => clearCanvasTagAt(String(tag || ""), String(path || ""));
window.agentYViewerBridge.manageTags = (opts) => {
  if (typeof window.agentYOpenTagManager !== "function") return false;
  window.agentYOpenTagManager(opts || {});
  return true;
};
