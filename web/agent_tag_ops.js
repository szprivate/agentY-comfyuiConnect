import { backendBase } from "./agent_backend.js";
import {
  agentTagList, announceTagsChanged, canvasTagNodes, normaliseTag, samePath, sceneTags, tagKey,
  writeCanvasTag,
} from "./agent_tags.js";

// What can be done to an agentY tag, for the Manage tags page (agent_tag_manager.js)
// and the bEpic viewer's "Remove tag #name" (agent_viewer_bridge.js).
//
// A tag lives in one or both of two places, and each is changed where it lives:
//   * remembered - an entry in the project's memory (one name, one file), made by
//     the viewer's "Tag for agentY", a tag node's `remember` switch or the agent.
//     The agentY host changes those: /agentY/tags, /tags/rename, /tags/delete,
//     /tags/untag, /tags/merge (src/utils/tag_memory.py).
//   * canvas - the tag field of an `agentY add tag` node in the open graph. That is
//     the user's graph, so it is only written after they confirmed it, by the page
//     that asked; these helpers do the writing (writeCanvasTag in agent_tags.js).
// Every change ends in announceTagsChanged, which the `#` menu, the viewer and an
// open Manage page all listen for.

// The rule the host applies to a new name (tag_memory.valid_name), so the page can
// say what is wrong before asking.
export const MAX_TAG_NAME = 64;
export function checkTagName(raw) {
  const name = normaliseTag(raw);
  if (!name || !/[A-Za-z]/.test(name)) return { name: "", error: "A tag needs a name with at least one letter, like hero_face." };
  if (name.length > MAX_TAG_NAME) return { name: "", error: `A tag name can be at most ${MAX_TAG_NAME} characters long.` };
  return { name, error: "" };
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function hostCall(path, body) {
  let res;
  try {
    res = await fetch(backendBase() + path, body === undefined ? { cache: "no-store" }
      : { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  } catch (_) {
    return { ok: false, status: 0, error: "The agentY host is not running." };
  }
  let j = {};
  try { j = await res.json(); } catch (_) {}
  if (!res.ok || !j.ok) return Object.assign({}, j, { ok: false, status: res.status,
    error: j.error || `The agentY host refused it (HTTP ${res.status}).` });
  return Object.assign({}, j, { ok: true, status: res.status });
}

export const hostTags = () => hostCall("/agentY/tags");
export const hostRename = (tag, to) => hostCall("/agentY/tags/rename", { tag, to });
export const hostDelete = (tag) => hostCall("/agentY/tags/delete", { tag });
export const hostUntag = (tag, path) => hostCall("/agentY/tags/untag", { tag, path });
export const hostMerge = (from, into, keep) => hostCall("/agentY/tags/merge", { from, into, keep: keep || "into" });

// ── the list: one row per tag, wherever it lives ─────────────────────────────

/**
 * Rows for the Manage tags page.
 * `remembered`: the host's /agentY/tags list ([{tag, key, origin, role, path, name, exists}]);
 * `scene`: sceneTags() ([{tag, role, nodes: [{id, title, path}], paths}]).
 * -> [{ tag, key, sources: ["canvas"|"remembered"|"viewer"], nodes, memory, images: [{path, name, from, exists, nodes}] }]
 */
export function buildTagRows(remembered, scene) {
  const rows = new Map();
  const row = (tag) => {
    const key = tagKey(tag);
    if (!key) return null;
    if (!rows.has(key)) rows.set(key, { tag, key, sources: [], nodes: [], memory: null, images: [], role: "" });
    return rows.get(key);
  };
  const addImage = (r, path, from, extra) => {
    if (!path) return;
    let img = r.images.find((i) => samePath(i.path, path));
    if (!img) {
      img = { path, name: String(path).split(/[\\/]/).pop() || String(path), from: [], exists: true, nodes: [] };
      r.images.push(img);
    }
    if (!img.from.includes(from)) img.from.push(from);
    if (extra && extra.exists === false) img.exists = false;
    if (extra && extra.node) img.nodes.push(extra.node);
    // A full path beats a canvas loader's input-relative name.
    if (/^([A-Za-z]:)?[\\/]/.test(String(path)) && !/^([A-Za-z]:)?[\\/]/.test(String(img.path))) img.path = path;
  };
  for (const t of scene || []) {
    const r = row(t.tag);
    if (!r) continue;
    if (!r.sources.includes("canvas")) r.sources.push("canvas");
    if (!r.role && t.role) r.role = t.role;
    for (const n of t.nodes || []) {
      r.nodes.push(n);
      addImage(r, n.path, "canvas", { node: n });
    }
    if (!(t.nodes || []).length && t.path) addImage(r, t.path, "canvas");
  }
  for (const m of remembered || []) {
    const r = row(m.tag);
    if (!r) continue;
    // The written name wins over a canvas spelling of it only when the canvas has none.
    if (!r.sources.length) r.tag = m.tag;
    const src = m.origin === "viewer" ? "viewer" : "remembered";
    if (!r.sources.includes(src)) r.sources.push(src);
    r.memory = m;
    if (!r.role && m.role) r.role = m.role;
    addImage(r, m.path, "memory", { exists: m.exists !== false });
  }
  return [...rows.values()];
}

export function sourceText(row) {
  const out = [];
  if (row.nodes && row.nodes.length) {
    out.push(row.nodes.length === 1 ? `canvas node #${row.nodes[0].id}` : `${row.nodes.length} canvas nodes`);
  } else if ((row.sources || []).includes("canvas")) out.push("canvas");
  if ((row.sources || []).includes("viewer")) out.push("viewer");
  if ((row.sources || []).includes("remembered")) out.push("remembered");
  return out.join(" · ");
}

export function sortTagRows(rows, key, dir = 1) {
  const val = (r) => key === "images" ? r.images.length
    : key === "source" ? sourceText(r) : String(r.tag || "");
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y), undefined, { sensitivity: "base" });
    return c * dir || String(a.tag).localeCompare(String(b.tag), undefined, { sensitivity: "base" });
  });
}

export function filterTagRows(rows, q) {
  const needle = String(q || "").trim().replace(/^#/, "").toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => `${r.tag}\n${r.role || ""}\n${r.images.map((i) => i.name).join("\n")}`
    .toLowerCase().includes(needle));
}

/** Every tag as rows: the host's list and the open canvas. `{ rows, hostError }`. */
export async function loadTagRows() {
  const scene = sceneTags();
  const host = await hostTags();
  if (host.ok) return { rows: buildTagRows(host.tags || [], scene), hostError: "" };
  // The host is down: what the `#` menu would offer, read-only for remembered ones.
  let list = [];
  try { list = await agentTagList({ fresh: true }); } catch (_) { list = []; }
  const kept = list.filter((t) => t.source === "memory")
    .map((t) => ({ tag: t.tag, key: tagKey(t.tag), origin: t.origin || "", role: t.role, path: t.path,
                   name: String(t.path || "").split(/[\\/]/).pop(), exists: true }));
  return { rows: buildTagRows(kept, scene), hostError: host.error || "The agentY host is not reachable." };
}

// ── the changes ──────────────────────────────────────────────────────────────

export function nodesSentence(found) {
  if (!found.length) return "";
  const f = found[0];
  const more = found.length > 1 ? ` and ${found.length - 1} more` : "";
  return `canvas node #${f.id} '${f.title}'${more}`;
}

/**
 * Take `tag` off the picture at `path` - the viewer's "Remove tag #name".
 * Removes the remembered reference when it is that picture. A tag that (also)
 * comes from a canvas node is NOT cleared here: the answer names the node(s) in
 * `canvas`, and the caller asks the user before calling clearCanvasTagAt.
 * -> { ok, message, removed: bool, canvas: [{id, title}] }
 */
export async function untagPicture(tag, path) {
  const found = canvasTagNodes(tag, path);
  const canvas = found.map((f) => ({ id: f.id, title: f.title }));
  const r = await hostUntag(tag, path);
  const removed = !!r.ok;
  if (removed) announceTagsChanged({ untagged: [{ tag, path }] });
  let message;
  if (found.length) {
    message = (removed ? `Removed the remembered #${tag}. ` : "")
      + `This tag comes from ${nodesSentence(found)} - remove it there, or clear that node's tag field.`;
  } else if (removed) message = `Removed #${tag} from this picture.`;
  else if (r.status === 404) message = `#${tag} is not remembered for this picture.`;
  else message = r.error || "The tag could not be removed.";
  return { ok: removed || (!found.length && r.status === 404), message, removed, canvas,
           notRemembered: r.status === 404 };
}

/** Clear the tag field of the canvas nodes that put `tag` on `path` (after the user said yes). */
export function clearCanvasTagAt(tag, path) {
  const found = canvasTagNodes(tag, path);
  const n = writeCanvasTag(found, "");
  if (n) announceTagsChanged({ untagged: [{ tag, path }] });
  return { ok: n > 0, cleared: n,
           message: n ? `Cleared the tag field of ${nodesSentence(found)}.` : `No canvas node puts #${tag} on that picture any more.` };
}

/** Rename everywhere it lives (canvas nodes only when `withCanvas`). */
export async function renameEverywhere(row, to, { withCanvas = false } = {}) {
  const { name, error } = checkTagName(to);
  if (error) return { ok: false, message: error };
  const notes = [];
  let ok = true;
  if (row.memory) {
    const r = await hostRename(row.memory.tag, name);
    if (!r.ok) return { ok: false, message: r.error };
    if (r.warning) notes.push(r.warning);
  }
  if (withCanvas) {
    const n = writeCanvasTag(canvasTagNodes(row.tag), name);
    if (n) notes.push(`Renamed the tag field of ${n} canvas node${n === 1 ? "" : "s"}.`);
  }
  if (!row.memory && !withCanvas) ok = false;
  announceTagsChanged({ renamed: { from: row.tag, to: name } });
  if (!notes.some((t) => t.startsWith("Hook prompts"))) {
    notes.push(`Hook prompts and messages that say #${row.tag} were not changed: edit them to say #${name}.`);
  }
  return { ok, name, message: notes.join(" ") };
}

/** Delete the tag: forget the remembered entry, clear canvas nodes when `withCanvas`. */
export async function deleteEverywhere(row, { withCanvas = false } = {}) {
  const notes = [];
  if (row.memory) {
    const r = await hostDelete(row.memory.tag);
    if (!r.ok && r.status !== 404) return { ok: false, message: r.error };
    notes.push(`Forgot the remembered #${row.tag}.`);
  }
  if (withCanvas) {
    const n = writeCanvasTag(canvasTagNodes(row.tag), "");
    if (n) notes.push(`Cleared the tag field of ${n} canvas node${n === 1 ? "" : "s"}.`);
  }
  announceTagsChanged({ deleted: [row.tag] });
  return { ok: true, message: notes.join(" ") };
}

/** Take one picture out of a tag (the grid's "Remove from tag"). */
export async function removeImage(row, img, { withCanvas = false } = {}) {
  const notes = [];
  if (img.from.includes("memory") && row.memory) {
    const r = await hostUntag(row.memory.tag, row.memory.path);
    if (!r.ok && r.status !== 404) return { ok: false, message: r.error };
    notes.push(`Removed the remembered #${row.tag} from ${img.name}.`);
  }
  if (withCanvas && img.from.includes("canvas")) {
    const n = writeCanvasTag(canvasTagNodes(row.tag, img.path), "");
    if (n) notes.push(`Cleared the tag field of ${n} canvas node${n === 1 ? "" : "s"}.`);
  }
  announceTagsChanged({ untagged: [{ tag: row.tag, path: img.path }] });
  return { ok: true, message: notes.join(" ") };
}

/** Merge `row` into the tag `into` (a name); canvas nodes retagged when `withCanvas`. */
export async function mergeInto(row, into, { keep = "into", withCanvas = false } = {}) {
  const { name, error } = checkTagName(into);
  if (error) return { ok: false, message: error };
  if (tagKey(name) === row.key) return { ok: false, message: "Those are the same tag." };
  const notes = [];
  if (row.memory) {
    const r = await hostMerge(row.memory.tag, name, keep);
    if (!r.ok) return { ok: false, message: r.error };
    if (r.dropped) notes.push(`${String(r.dropped).split(/[\\/]/).pop()} is no longer tagged.`);
    if (r.warning) notes.push(r.warning);
  }
  if (withCanvas) {
    const n = writeCanvasTag(canvasTagNodes(row.tag), name);
    if (n) notes.push(`Retagged ${n} canvas node${n === 1 ? "" : "s"} #${name}.`);
  }
  announceTagsChanged({ renamed: { from: row.tag, to: name }, merged: true });
  return { ok: true, name, message: notes.join(" ") || `Merged into #${name}.` };
}
