import { app } from "../../scripts/app.js";

// agentY hook node frontend:
//  • a distinct warm colour so it's obvious it's an agent annotation, not part
//    of the executing pipeline.
//  • only the switches the selected `purpose` actually reads are shown.
// The hook has a single, type-agnostic "out" output (declared in the V3 schema).
// The anchor *inputs* still auto-grow (a proper V3 Autogrow primitive); the
// outputs no longer do — a stage that yields several results forwards them all
// to the next hook via the agent (from the run_workflow_now result), and a baked
// subgraph's output count comes from the agent's exposed-outputs spec, not from
// extra slots on this node. The old output auto-grow added a confusing second
// output and mutated the slot array mid-connection; a single fixed output is
// simpler and unambiguous to wire.

// `bake_to_canvas`, `freeze` and `memorize` were one question asked three ways —
// "should what this hook produced outlive the run?" — of different products.
// They are now the single `remember` switch, resolved by purpose on the agent
// side. Only its LABEL differs, because what keeping it means differs:
//  • make_workflow produces a workflow → keeping it means nesting a subgraph,
//    which everyone calls baking. bake_hooks_to_canvas consults it.
//  • everything else produces a result → keeping it means memorizing it to
//    agent/memory/ beside the outputs, which hook_cache does.
// qa and iterate produce nothing to keep: a qa hook is expressly told never to
// place_canvas_text and an iterate hook runs through iterate_step, so the switch
// has never done anything at all there and is hidden.
const PRODUCES_A_RESULT = ["inline_parameter", "text", "general_request"];
const SHOWN_FOR = {
  remember: ["make_workflow", ...PRODUCES_A_RESULT],
};

// The switch is one bit but two words, because "bake" and "memorize" are what
// the two products are actually called and calling a subgraph "memorized" would
// be a worse lie than carrying two labels.
const LABELS = {
  make_workflow: { on: "bake into subgraph", off: "re-generate every time" },
  _: { on: "memorize result", off: "run every time" },
};

// Bumped whenever the widget LIST changes. widgets_values is positional, so the
// only safe way to read an old file is to know which layout wrote it — and the
// bug this replaces is exactly what guessing from length costs: the `ignore`
// removal left a "length === 5 means the old layout" rule behind, then `memorize`
// made the CURRENT layout five values too, and every hook saved after that came
// back shifted (freeze read as bake_to_canvas, memorize read as freeze). From
// here on the file says which layout it is and nothing has to be inferred.
const SCHEMA_VERSION = 3;

// v3 = [directive, purpose, remember]
function migrateWidgetValues(info) {
  // Newer frontends may serialise widget values as an object keyed by name.
  // Those carry their own names and need nothing.
  if (!info || !Array.isArray(info.widgets_values)) return info;
  if (Number((info.properties || {}).agentY_schema || 0) >= SCHEMA_VERSION) return info;
  const v = info.widgets_values;
  const on = (x) => x === true || x === "true";
  const purpose = String(v[1] || "");
  const isWorkflow = purpose === "make_workflow";
  if (v.length >= 5) {
    // [directive, purpose, bake_to_canvas, freeze, memorize] — the layout from
    // before the first merge. Take whichever switch this purpose actually read:
    // a make_workflow hook read bake_to_canvas, everything else read memorize.
    //
    // A canvas last saved before 27 Jul had [directive, purpose, ignore,
    // bake_to_canvas, freeze] here, which is positionally identical and cannot be
    // told apart. That one is read wrong, deliberately: the later layout is the
    // common one, the switch is visible on the node, and a graph untouched since
    // July is one click to correct.
    return { ...info, widgets_values: [v[0], v[1], isWorkflow ? on(v[2]) : on(v[4])] };
  }
  if (v.length === 4) {
    // [directive, purpose, bake, memorize] — the two-switch layout (v2). Same
    // rule: bake was the one make_workflow read, memorize the one the rest did.
    //
    // Positionally identical to the pre-27-Jul [directive, purpose,
    // bake_to_canvas, freeze] layout, and read as v2 for the same reason.
    return { ...info, widgets_values: [v[0], v[1], isWorkflow ? on(v[2]) : on(v[3])] };
  }
  if (v.length === 3) {
    // Either v3 already (unlikely — it would carry the property) or the oldest
    // [directive, purpose, ignore] layout. Coercing to a boolean is right for
    // both: `ignore` is long gone and OFF is the safe default for a keep switch.
    return { ...info, widgets_values: [v[0], v[1], on(v[2])] };
  }
  return info;  // two or fewer: older than any switch, positions unchanged
}

// The label follows the purpose; the value does not change with it.
function applyPurposeLabel(node) {
  const w = (node.widgets || []).find((x) => x && x.name === "remember");
  if (!w) return;
  const purpose = String(((node.widgets || []).find((x) => x && x.name === "purpose") || {}).value || "");
  const text = LABELS[purpose] || LABELS._;
  if (w.options) {
    w.options.on = text.on;
    w.options.off = text.off;
  }
  w.label_on = text.on;
  w.label_off = text.off;
}

// Approx height of one widget row, for growing/shrinking the node as switches
// appear and disappear.
const ROW = (window.LiteGraph?.NODE_WIDGET_HEIGHT || 20) + 4;

function getWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name) || null;
}

// Hiding is presentation only: `hidden` is not `options.serialize`, so a hidden
// switch still round-trips through widgets_values and keeps its position. A
// widget dropped from the array instead would shift every value after it — the
// exact failure migrateWidgetValues above exists to undo.
//
// `mode`: "init" (fresh node, no resize), "purpose" (the user changed it —
// grow/shrink by the number of rows that appeared/disappeared), "configure" (a
// loaded graph — only ever grow, never shrink: the saved height is the user's,
// and a graph saved before this change is simply a couple of rows roomier).
function applyPurposeVisibility(node, mode) {
  const purpose = String((getWidget(node, "purpose") || {}).value || "");
  applyPurposeLabel(node);   // same trigger, same three call sites — keep them in step
  let delta = 0;
  for (const [name, purposes] of Object.entries(SHOWN_FOR)) {
    const w = getWidget(node, name);
    if (!w) continue;
    const wasHidden = w.__ayHidden;
    const nextHidden = !purposes.includes(purpose);
    w.hidden = nextHidden;
    w.__ayHidden = nextHidden;
    if (wasHidden !== undefined && wasHidden !== nextHidden) delta += nextHidden ? -1 : 1;
  }
  if (mode === "purpose" && delta && node.size) {
    node.size[1] = Math.max(node.size[1] + delta * ROW, 120);
  } else if (mode === "configure" && node.size && node.computeSize) {
    const min = node.computeSize();
    if (node.size[0] < min[0]) node.size[0] = min[0];
    if (node.size[1] < min[1]) node.size[1] = min[1];
  }
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "agentY.hookNode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "AgentYHook") return;

    // Read an older layout into the current one, then STAMP the version so the
    // next save says which layout it is and nothing has to be guessed again.
    const configure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (info) {
      const r = configure ? configure.call(this, migrateWidgetValues(info)) : undefined;
      this.properties = this.properties || {};
      this.properties.agentY_schema = SCHEMA_VERSION;
      // The purpose arrives during configure, so visibility is settled after it.
      applyPurposeVisibility(this, "configure");
      return r;
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      this.color = "#5c3a28";
      this.bgcolor = "#3a2a20";
      if (!this.title || this.title === "AgentYHook") this.title = "agentY hook";
      this.properties = this.properties || {};
      this.properties.agentY_schema = SCHEMA_VERSION;
      // Only seed the size on a fresh node; a restored node keeps its saved size,
      // and the auto-growing anchor inputs resize the node as wired.
      if (!this.size || (this.size[0] === 0 && this.size[1] === 0)) this.size = [300, 280];

      // Re-hide/show as the purpose changes. Wrapped rather than replaced: the
      // combo's own callback is what commits the value.
      const purpose = getWidget(this, "purpose");
      if (purpose) {
        const orig = purpose.callback;
        const node = this;
        purpose.callback = function (...args) {
          const rr = orig ? orig.apply(this, args) : undefined;
          applyPurposeVisibility(node, "purpose");
          return rr;
        };
      }
      applyPurposeVisibility(this, "init");
      return r;
    };
  },
});

// The agentY text node holds a string the agent wrote when answering a 'text'
// hook. A cool slate palette sets it apart from the warm hook / green python
// nodes; its output is a fixed STRING, so no auto-grow here.
app.registerExtension({
  name: "agentY.textNode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "AgentYText") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      this.color = "#28405c";
      this.bgcolor = "#20303a";
      if (!this.title || this.title === "AgentYText") this.title = "agentY text";
      if (!this.size || (this.size[0] === 0 && this.size[1] === 0)) this.size = [320, 200];
      return r;
    };
  },
});

// The batch expander sits between a collector and the numbered image slots on a
// model node. Teal like the image collector it usually follows, so the pair reads
// as one idea on the canvas.
app.registerExtension({
  name: "agentY.expandBatch",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "AgentYImageBatchExpand") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      this.color = "#264a4a";
      this.bgcolor = "#1c3030";
      if (!this.title || this.title === "AgentYImageBatchExpand") {
        this.title = "agentY expand image batch";
      }
      if (!this.size || (this.size[0] === 0 && this.size[1] === 0)) this.size = [260, 240];
      return r;
    };
  },
});

// The agentY python node (used when baking computed values) shares the warm
// agentY palette. Its outputs are declared/fixed, so no output auto-grow here.
app.registerExtension({
  name: "agentY.pythonNode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "AgentYPython") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      this.color = "#2f4a3a";
      this.bgcolor = "#20302a";
      if (!this.title || this.title === "AgentYPython") this.title = "agentY python";
      if (!this.size || (this.size[0] === 0 && this.size[1] === 0)) this.size = [340, 220];
      return r;
    };
  },
});
