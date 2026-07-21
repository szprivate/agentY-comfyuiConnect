import { app } from "../../scripts/app.js";

// agentY collector nodes (image / video) frontend.
//
// Each node stores a newline-separated list of ABSOLUTE file paths in its `files`
// widget (a normal multiline string, so it serializes into the workflow and the
// agent can read it with no pre-run). The buttons below call the ComfyUI-side
// /agent/pick_files route, which opens a NATIVE OS dialog and returns real
// on-disk paths (a browser can't read those itself), then append them to `files`.

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

function filesWidget(node) {
  return (node.widgets || []).find((w) => w && w.name === "files") || null;
}
function currentPaths(node) {
  const w = filesWidget(node);
  if (!w || !w.value) return [];
  return String(w.value).split("\n").map((s) => s.trim()).filter(Boolean);
}
function setPaths(node, paths) {
  const w = filesWidget(node);
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

for (const [nodeName, cfg] of Object.entries(COLLECTORS)) {
  app.registerExtension({
    name: "agentY.collector." + nodeName,
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData?.name !== nodeName) return;
      const onCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const r = onCreated ? onCreated.apply(this, arguments) : undefined;
        this.color = cfg.color;
        this.bgcolor = cfg.bgcolor;
        if (!this.title || this.title === nodeName) this.title = cfg.title;

        const b1 = this.addWidget("button", `+ Add ${cfg.noun}…`, null, () => addFrom(this, cfg, "files"));
        const b2 = this.addWidget("button", "+ Add folder…", null, () => addFrom(this, cfg, "folder"));
        const b3 = this.addWidget("button", "Clear", null, () => setPaths(this, []));
        // Buttons are transient UI — never serialize them into the workflow (only
        // the `files` string carries state).
        for (const b of [b1, b2, b3]) if (b) b.serialize = false;

        if (!this.size || this.size[0] < 300) this.size = [340, 260];
        return r;
      };
    },
  });
}
