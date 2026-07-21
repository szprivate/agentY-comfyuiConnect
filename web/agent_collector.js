import { app } from "../../scripts/app.js";

// agentY collector nodes (image / video) frontend.
//
// Each node stores a newline-separated list of ABSOLUTE file paths in its `files`
// widget (a normal multiline string, so it serializes into the workflow and the
// agent can read it with no pre-run). The buttons below call the ComfyUI-side
// /agent/pick_files route, which opens a NATIVE OS dialog and returns real
// on-disk paths (a browser can't read those itself), then append them to `files`.
//
// The `load_incrementally` toggle (a backend schema widget) makes the node emit
// just one file per Queue Prompt, stepping through the list. This file also adds a
// frontend-only `reset_increment` toggle: while `load_incrementally` is on it is
// shown, and when armed it resets the backend cursor to the first file on the NEXT
// Queue click — fired once per click (even with batch count > 1) via a one-shot
// patch on app.queuePrompt, then auto-disarmed so stepping resumes.

const COLLECTORS = {
  AgentYImageCollector: {
    kind: "image", noun: "images", title: "agentY image collector",
    color: "#264a4a", bgcolor: "#1c3030",
  },
  AgentYVideoCollector: {
    kind: "video", noun: "videos", title: "agentY video collector",
    color: "#3a2a4a", bgcolor: "#2a2030",
  },
};

// Approx height of one widget row, used to grow/shrink the node when the reset
// toggle appears/disappears (so we preserve the user's width and extra height
// rather than snapping the whole node back to its computed minimum).
const ROW = (window.LiteGraph?.NODE_WIDGET_HEIGHT || 20) + 4;

// ComfyUI serves the frontend and the /agent/* routes from the same origin.
function backendOrigin() {
  try { return window.location.origin; } catch (_) { return ""; }
}

function notify(msg, kind) {
  try {
    const t = app?.extensionManager?.toast;
    if (t && t.add) { t.add({ severity: kind || "info", summary: "agentY collector", detail: msg, life: 5000 }); return; }
  } catch (_) {}
  console[(kind === "error") ? "error" : "log"]("[agentY collector] " + msg);
}

async function pickPaths(kind, mode) {
  const r = await fetch(backendOrigin() + "/agent/pick_files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, mode }),
  });
  let j = {};
  try { j = await r.json(); } catch (_) {}
  if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
  return Array.isArray(j.paths) ? j.paths : [];
}

function getWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name) || null;
}
function currentPaths(node) {
  const w = getWidget(node, "files");
  if (!w || !w.value) return [];
  return String(w.value).split("\n").map((s) => s.trim()).filter(Boolean);
}
function setPaths(node, paths) {
  const w = getWidget(node, "files");
  if (!w) return;
  w.value = paths.join("\n");
  try { if (w.callback) w.callback(w.value, app.canvas, node); } catch (_) {}
  node.setDirtyCanvas(true, true);
}

function addFrom(node, cfg, mode) {
  pickPaths(cfg.kind, mode)
    .then((picked) => {
      if (!picked.length) return; // cancelled
      const merged = currentPaths(node);
      const seen = new Set(merged);
      let added = 0;
      for (const p of picked) if (!seen.has(p)) { seen.add(p); merged.push(p); added++; }
      setPaths(node, merged);
      notify(`Added ${added} ${cfg.noun} (${merged.length} total).`);
    })
    .catch((e) => {
      notify(`Picker failed: ${e.message}. You can also paste absolute paths into the field (one per line).`, "error");
    });
}

// Show `reset_increment` only while `load_incrementally` is on, and never leave it
// armed while hidden. `mode`: "init" (creation, no resize), "toggle" (user flipped
// load_incrementally — grow/shrink by one row), "configure" (loaded graph — grow to
// fit if the toggle is shown).
function applyResetVisibility(node, mode) {
  const inc = getWidget(node, "load_incrementally");
  const rst = getWidget(node, "reset_increment");
  if (!rst) return;
  const show = !!(inc && inc.value);
  const prevHidden = rst.__ayHidden;
  const nextHidden = !show;
  if (nextHidden && rst.value) rst.value = false;
  rst.hidden = nextHidden;
  rst.__ayHidden = nextHidden;
  if (mode === "toggle" && prevHidden !== undefined && prevHidden !== nextHidden && node.size) {
    node.size[1] += nextHidden ? -ROW : ROW;
  } else if (mode === "configure" && show && node.size) {
    const min = node.computeSize();
    if (node.size[1] < min[1]) node.size[1] = min[1];
    if (node.size[0] < min[0]) node.size[0] = min[0];
  }
  node.setDirtyCanvas(true, true);
}

for (const [nodeName, cfg] of Object.entries(COLLECTORS)) {
  app.registerExtension({
    name: "agentY.collector." + nodeName,
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData?.name !== nodeName) return;

      const onCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const r = onCreated ? onCreated.apply(this, arguments) : undefined;
        const node = this;
        node.color = cfg.color;
        node.bgcolor = cfg.bgcolor;
        if (!node.title || node.title === nodeName) node.title = cfg.title;

        // A frontend-only, one-shot "reset cursor on next Queue" arm. Added before
        // the buttons so it renders right under the `load_incrementally` schema
        // widget. Not serialized — it's transient state, off on every reload.
        const reset = node.addWidget(
          "toggle", "reset_increment", false, () => {},
          { on: "reset on next Queue", off: "off" },
        );
        if (reset) reset.serialize = false;

        const b1 = node.addWidget("button", `+ Add ${cfg.noun}…`, null, () => addFrom(node, cfg, "files"));
        const b2 = node.addWidget("button", "+ Add folder…", null, () => addFrom(node, cfg, "folder"));
        const b3 = node.addWidget("button", "Clear", null, () => setPaths(node, []));
        // Buttons are transient UI — never serialize them into the workflow (only
        // the `files` string carries state).
        for (const b of [b1, b2, b3]) if (b) b.serialize = false;

        // Re-hide/show the reset toggle whenever load_incrementally flips.
        const inc = getWidget(node, "load_incrementally");
        if (inc) {
          const origCb = inc.callback;
          inc.callback = function (v) {
            const rr = origCb ? origCb.apply(this, arguments) : undefined;
            applyResetVisibility(node, "toggle");
            return rr;
          };
        }

        if (!node.size || node.size[0] < 300) node.size = [340, 280];
        applyResetVisibility(node, "init");
        return r;
      };

      // A loaded graph sets load_incrementally during configure (after creation),
      // so re-apply visibility once the value is in.
      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        const rr = onConfigure ? onConfigure.apply(this, arguments) : undefined;
        applyResetVisibility(this, "configure");
        return rr;
      };
    },
  });
}

// Reset the backend cursor for every armed collector, ONCE, before a Queue.
async function resetArmedCollectors() {
  const graph = app.graph;
  const nodes = (graph && (graph._nodes || graph.nodes)) || [];
  const ids = [];
  for (const n of nodes) {
    const cls = n && (n.comfyClass || n.type);
    if (!cls || !COLLECTORS[cls]) continue;
    const inc = getWidget(n, "load_incrementally");
    const rst = getWidget(n, "reset_increment");
    if (inc && inc.value && rst && rst.value) {
      ids.push(String(n.id));
      rst.value = false; // one-shot: disarm so the next queues keep stepping
      if (n.setDirtyCanvas) n.setDirtyCanvas(true, true);
    }
  }
  if (!ids.length) return;
  await fetch(backendOrigin() + "/agent/reset_collector_cursor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_ids: ids }),
  });
}

// One-shot patch: app.queuePrompt(number, batchCount) is called exactly once per
// Queue-button click (the batch loop lives inside it), so resetting here fires
// once regardless of batch count — the cursor rewinds, then the batch steps from
// the first file.
app.registerExtension({
  name: "agentY.collector.queueReset",
  async setup() {
    const orig = app.queuePrompt;
    if (typeof orig !== "function" || orig.__ayReset) return;
    const wrapped = async function () {
      try { await resetArmedCollectors(); }
      catch (e) { console.error("[agentY collector] cursor reset failed:", e); }
      return orig.apply(this, arguments);
    };
    wrapped.__ayReset = true;
    app.queuePrompt = wrapped;
  },
});
