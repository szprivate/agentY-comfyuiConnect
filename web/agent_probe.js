/**
 * agent_probe.js — answer the host's questions about the page it cannot see.
 *
 * The host runs beside ComfyUI, not inside it. It receives the API prompt with
 * every message, which is enough to read and edit nodes, but two things live
 * only in the browser:
 *
 *   - what the graph LOOKS like. `app.canvas.canvas` is a real 2D canvas, so one
 *     `toDataURL()` gives the user's own view — their layout, their colours,
 *     their collapsed nodes. Re-rendering the JSON elsewhere draws a different
 *     picture of the same graph, which is not what "show me my workflow" means.
 *   - what ELSE is open. ComfyUI keeps several workflows in tabs. The prompt the
 *     panel posts is the active one and says nothing about the others.
 *
 * So the panel long-polls `/agentY/canvas_probe`, answers on
 * `/agentY/canvas_probe/reply`, and this file is everything it can be asked.
 * One connection, parked, independent of any turn — a tool blocked waiting for a
 * screenshot must not be waiting on the same channel that would deliver it.
 */
import { app } from "../../scripts/app.js";
// Imported for its side effect, not its exports: agent_backend.js installs the
// fetch wrapper that puts the session token on every /agentY/ request, and the
// two calls below are /agentY/ requests. This module gets its base URL from its
// constructor, so without this line the dependency would exist and be invisible
// — and reordering an import in agent_chat.js would silently 403 the probe.
import "./agent_backend.js";

// How long the host holds the poll open. Slightly under its own cap so the
// request ends server-side, on an empty answer, rather than as a client abort.
const POLL_WAIT = 25;
// After a failed poll (host down, network blip) — back off rather than spin.
const RETRY_MS = 4000;

// Below this zoom LiteGraph stops drawing node text — titles, widget names and
// values all vanish and nodes render as bare boxes. Measured on this build by
// sampling `canvas.low_quality` across zooms: true at 0.4, false from 0.5 up.
// More PIXELS do not help; only zoom does, which is why the budget below is
// spent on zoom first and image size second.
const TEXT_RENDERS_ABOVE = 0.5;
// Ceiling on the captured image. The backing store is 4 bytes a pixel, so this
// is ~96 MB while the shot is taken — enough for a large graph at readable zoom,
// short of the size where a browser quietly hands back a blank canvas.
const MAX_PIXELS = 24_000_000;
const MAX_SIDE = 8000;
const PAD = 60;              // graph units of margin around the outermost nodes

function ws() {
  try { return app.extensionManager && app.extensionManager.workflow; } catch (_) { return null; }
}

/**
 * Every workflow ComfyUI currently has open, active one marked.
 *
 * `openWorkflows` is the tab strip. Only the active one is in `app.graph` — the
 * others are stored state, not live graphs — which is exactly the distinction
 * the agent needs, and exactly the one it cannot make from the API prompt alone.
 */
export function openWorkflows() {
  const store = ws();
  if (!store || !Array.isArray(store.openWorkflows)) return [];
  const active = store.activeWorkflow;
  return store.openWorkflows.map((w) => {
    const isActive = w === active;
    const row = {
      name: w.filename || w.path || "untitled",
      path: w.path || "",
      active: isActive,
      modified: !!w.isModified,
      temporary: !!w.isTemporary,
    };
    // Node count only for the active tab: it is the only one whose graph is
    // loaded, and counting a background tab would mean parsing stored JSON to
    // answer a question nobody asked.
    if (isActive) {
      try { row.nodes = (app.graph && app.graph._nodes || []).length; } catch (_) {}
    }
    return row;
  });
}

/** Bounding box over *nodes*, in graph units, padded. */
function boundsOf(nodes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const [x, y] = n.pos;
    const w = n.size[0];
    // A collapsed node draws as its title bar, not its stored size.
    const h = n.flags && n.flags.collapsed ? 0 : n.size[1];
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y - 34);        // the title bar sits above pos.y
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  }
  return { x: x0 - PAD, y: y0 - PAD, w: (x1 - x0) + PAD * 2, h: (y1 - y0) + PAD * 2 };
}

// A node's multiline text lives in a <textarea> ComfyUI floats ABOVE the canvas,
// so `toDataURL` — which reads the canvas and nothing else — cannot see a word of
// it. Every prompt and every hook directive came out blank, which is most of what
// someone wants when they ask for a picture of their workflow.
//
// These are the textarea's own numbers, measured off a live one rather than
// guessed: it is inset 10 graph units on each side of the node, padded 2 more,
// and set in 10px monospace. CSS pixels ARE graph units here (the element's
// offsetWidth is exactly `node.size[0] - 20`; the zoom lives on a transform
// applied to its parent), so these carry straight into graph space.
const TEXT_INSET = 10;
const TEXT_PAD = 2;
const TEXT_SIZE = 10;
const TEXT_LINE = 1.2;          // textarea line-height: normal
const TEXT_COLOUR = "#dddddd";
const TEXT_BACKGROUND = "#222222";

/** Wrap *text* to *maxWidth*, honouring the newlines already in it. */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line ? line + " " + word : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Draw every DOM-backed text widget onto the canvas, where LiteGraph left a gap.
 *
 * Only textareas and text inputs: a DOM widget could be anything, and painting
 * some other widget's `value` over whatever it actually draws would be worse than
 * the blank box this exists to fix.
 */
function paintTextWidgets(ctx, canvas, nodes, scale) {
  const ox = canvas.ds.offset[0], oy = canvas.ds.offset[1];
  for (const node of nodes) {
    if (node.flags && node.flags.collapsed) continue;
    for (const w of (node.widgets || [])) {
      if (w.hidden) continue;
      const dom = w.element || w.inputEl;
      if (!dom || (dom.tagName !== "TEXTAREA" && dom.tagName !== "INPUT")) continue;
      const text = w.value == null ? "" : String(w.value);
      if (!text) continue;

      const boxW = node.size[0] - TEXT_INSET * 2;
      const boxH = (w.computedHeight || 0) - TEXT_INSET * 2;
      if (!(boxW > 0 && boxH > 0)) continue;      // no room / not laid out yet

      const x = (node.pos[0] + TEXT_INSET + ox) * scale;
      const y = (node.pos[1] + (w.y || 0) + TEXT_INSET + oy) * scale;
      const width = boxW * scale, height = boxH * scale;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();                                  // long text stops at the box
      ctx.fillStyle = TEXT_BACKGROUND;
      ctx.fillRect(x, y, width, height);
      ctx.fillStyle = TEXT_COLOUR;
      ctx.font = `${TEXT_SIZE * scale}px monospace`;
      ctx.textBaseline = "top";
      const pad = TEXT_PAD * scale;
      const lineHeight = TEXT_SIZE * TEXT_LINE * scale;
      let ty = y + pad;
      for (const line of wrapText(ctx, text, width - pad * 2)) {
        if (ty > y + height) break;                // the textarea would scroll
        ctx.fillText(line, x + pad, ty);
        ty += lineHeight;
      }
      ctx.restore();
    }
  }
}


/**
 * The graph as a PNG data URL: whole, fitted, with the user's view put back.
 *
 * Three things that look like details and are not:
 *
 * 1. The canvas is RESIZED for the capture rather than reusing the panel's
 *    viewport. Otherwise the output is shaped like the user's window: a tall
 *    graph gets letterboxed into a wide frame and shrunk to fit the short side,
 *    which is what made an 88-node graph come out at 0.05 zoom — legible
 *    nowhere, and mostly empty background.
 * 2. Assigning `el.width` RESETS the 2D context, which throws away the
 *    `ctx.scale(dpr, dpr)` ComfyUI installed. So during the capture one backing
 *    pixel is one graph unit at zoom 1 — no devicePixelRatio anywhere in the
 *    sizing — and afterwards that transform has to be put back by hand or the
 *    user's canvas is left drawing at 1/dpr in the corner of its own element.
 *    Measured, not assumed: at zoom 1 a WxH backing store reports exactly WxH
 *    of `ds.visible_area`.
 * 3. Restore is synchronous, in the same task. Nothing yields between changing
 *    the view and putting it back, so the browser never gets a frame to paint
 *    and the user does not see their canvas jump.
 * 4. Multiline text is not on the canvas at all — see `paintTextWidgets`, which
 *    puts it there.
 */
export function captureGraph(opts = {}) {
  const canvas = app && app.canvas;
  const graph = app && app.graph;
  const el = canvas && canvas.canvas;
  if (!el || !graph) return { error: "the ComfyUI canvas is not available" };

  let nodes = (graph._nodes || []).filter((n) => n && n.pos && n.size);
  let scoped = false;
  if (opts.only_selected) {
    const picked = nodes.filter((n) => n.is_selected);
    if (!picked.length) {
      return { error: "no nodes are selected on the canvas, so there is no "
                      + "selection to photograph" };
    }
    nodes = picked;
    scoped = true;
  }
  if (!nodes.length) return { error: "the canvas is empty — there is nothing to show" };

  // Everything that must go back exactly as it was.
  const was = {
    scale: canvas.ds.scale,
    x: canvas.ds.offset[0],
    y: canvas.ds.offset[1],
    w: el.width,
    h: el.height,
    info: canvas.show_info,
  };
  try {
    const box = boundsOf(nodes);

    // Zoom first: 1:1 unless the budget cannot pay for it. Never magnify — a
    // two-node graph blown up to fill a frame looks broken, and 1:1 is the size
    // the user actually works at. One backing pixel per graph unit at zoom 1,
    // for the reason in (2) above.
    let scale = 1;
    if (box.w * box.h > MAX_PIXELS) {
      scale = Math.sqrt(MAX_PIXELS / (box.w * box.h));
    }
    const longest = Math.max(box.w, box.h) * scale;
    if (longest > MAX_SIDE) scale *= MAX_SIDE / longest;

    const outW = Math.max(1, Math.round(box.w * scale));
    const outH = Math.max(1, Math.round(box.h * scale));

    el.width = outW;
    el.height = outH;
    // LiteGraph's own render-stats overlay (node count, FPS) is drawn over the
    // graph and belongs on a developer's screen, not in a picture someone is
    // being sent.
    canvas.show_info = false;
    canvas.ds.scale = scale;
    canvas.ds.offset[0] = -box.x;
    canvas.ds.offset[1] = -box.y;
    canvas.setDirty(true, true);
    canvas.draw(true, true);                    // synchronous redraw

    // Only when the rest of the text is being drawn too. Below that zoom
    // LiteGraph draws no labels, and prompts alone in an otherwise wordless
    // picture would be a strange half-measure — and unreadable at that size.
    const readable = scale >= TEXT_RENDERS_ABOVE;
    if (readable) paintTextWidgets(el.getContext("2d"), canvas, nodes, scale);

    const url = el.toDataURL("image/png");
    const out = {
      data_url: url,
      width: outW,
      height: outH,
      scale: Math.round(scale * 1000) / 1000,
      nodes: nodes.length,
      detail: readable ? "full" : "overview",
      scoped,
      workflow: (ws() && ws().activeWorkflow && ws().activeWorkflow.filename) || "",
    };
    if (!readable) {
      // Say it here rather than let the agent guess from a number: at this zoom
      // LiteGraph draws no node text at all, so the picture shows the shape of
      // the graph and nothing that could be read off it.
      out.note = "This graph is too large to photograph at readable zoom, so the "
               + "picture shows its layout and wiring but NO node text. To get a "
               + "readable picture of one part, ask the user to select those "
               + "nodes and take it again with only_selected.";
    }
    return out;
  } catch (err) {
    return { error: String((err && err.message) || err) };
  } finally {
    // Always, including on the error paths above: leaving the user's canvas
    // resized or zoomed out because a capture failed would be a worse bug than
    // the failed capture. Restoring the SIZE is not enough — assigning width
    // cleared the context transform, so ComfyUI's dpr scaling is reinstated
    // here too, exactly as its own resize handler sets it up.
    el.width = was.w;
    el.height = was.h;
    try {
      const dpr = window.devicePixelRatio || 1;
      if (dpr !== 1) el.getContext("2d").scale(dpr, dpr);
    } catch (_) { /* nothing better to do; the next window resize fixes it */ }
    canvas.show_info = was.info;
    canvas.ds.scale = was.scale;
    canvas.ds.offset[0] = was.x;
    canvas.ds.offset[1] = was.y;
    canvas.setDirty(true, true);
    canvas.draw(true, true);
  }
}

function answer(probe) {
  switch (probe.kind) {
    case "screenshot":
      return captureGraph(probe.payload || {});
    case "open_workflows":
      return { workflows: openWorkflows() };
    case "ping":
      return { ok: true };
    default:
      return { error: `unknown probe kind: ${probe.kind}` };
  }
}

/**
 * Park on the host's long-poll, answer whatever comes back, repeat.
 *
 * Runs for as long as the panel is mounted. Deliberately not gated on
 * `document.hidden` like the notification poll is: a screenshot request is worth
 * answering precisely when the user is looking somewhere else, because that is
 * when they are reading it in Slack.
 */
export class ProbeLoop {
  constructor(baseUrl) {
    this._base = baseUrl;
    this._stopped = false;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._stopped = false;
    this._loop();
  }

  stop() { this._stopped = true; this._running = false; }

  async _loop() {
    while (!this._stopped) {
      let probe = null;
      try {
        const r = await fetch(
          `${this._base()}/agentY/canvas_probe?wait=${POLL_WAIT}`,
          { cache: "no-store" });
        if (!r.ok) { await this._pause(); continue; }
        probe = (await r.json()).probe;
      } catch (_) {
        await this._pause();               // host down or restarting — try later
        continue;
      }
      if (!probe) continue;                // the poll simply expired; go again

      let data;
      try { data = answer(probe); }
      catch (err) { data = { error: String((err && err.message) || err) }; }

      try {
        await fetch(`${this._base()}/agentY/canvas_probe/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ probe_id: probe.probe_id, data }),
        });
      } catch (_) { /* the waiter times out on its own; nothing to salvage */ }
    }
  }

  _pause() { return new Promise((r) => setTimeout(r, RETRY_MS)); }
}
