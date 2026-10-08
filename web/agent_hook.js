import { app } from "../../scripts/app.js";

// agentY hook node frontend: its colour, the label of its keep switch, and the
// helper that wires a node into a free `anchor` slot.
//
// A hook is one stage of work. It has three kinds of socket, and they mean three
// different things (see AgentYHook in __init__.py):
//  • `exec` in/out - WHEN: the execution wire, drawn through hook, loop and
//    review nodes (web/agent_flow.js reads it);
//  • `anchor` inputs - WHAT IT READS, auto-growing;
//  • `out` - WHAT IT PRODUCES, a single type-agnostic output.

// The purposes as the node's dropdown names them, and as the host knows them.
// The first produces an input's value: one value sets it, several sweep it.
export const PARAMETER_PURPOSE = "set / sweep parameter";
export const WORKFLOW_PURPOSE = "make workflow";
export const TEXT_PURPOSE = "text only";
export const PURPOSES = [PARAMETER_PURPOSE, WORKFLOW_PURPOSE, TEXT_PURPOSE];
const HOST_NAME = { [PARAMETER_PURPOSE]: "set_parameter", [WORKFLOW_PURPOSE]: "make_workflow",
                    [TEXT_PURPOSE]: "text_only" };

// What the purposes were called before the hook was split up. A hook loaded
// from an older graph keeps working under the new name; `human_review` and `qa`
// are not here because they are no longer hooks at all (agentY review).
const RENAMED = { inline_parameter: PARAMETER_PURPOSE, set_parameter: PARAMETER_PURPOSE,
                  make_workflow: WORKFLOW_PURPOSE, text: TEXT_PURPOSE, text_only: TEXT_PURPOSE,
                  general_request: TEXT_PURPOSE };

/** The purpose as the node's dropdown offers it. */
export function currentPurpose(value) {
  const v = String(value || "");
  if (PURPOSES.includes(v)) return v;
  return RENAMED[v] || PARAMETER_PURPOSE;
}

/** The purpose as the host knows it. */
export function hostPurpose(value) {
  return HOST_NAME[currentPurpose(value)];
}

// A hook IS its directive: a blank one is a no-op nobody wants sent. Exported
// because agent_chat.js decides what to send and this is the rule it applies.
export function hookReaches(purpose, directive) {
  return String(directive || "").trim() !== "";
}

// The keep switch is one bit but two words, because "bake" and "memorize" are
// what the two products are actually called:
//  • "make workflow" produces a workflow -> keeping it means nesting a subgraph;
//  • the other two produce a result -> keeping it means memorizing it.
const LABELS = {
  make_workflow: { on: "bake into subgraph", off: "re-generate every time" },
  _: { on: "memorize result", off: "run every time" },
};

function getWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name) || null;
}

// Connect `node`'s first output into a free `anchors.anchorN` on `hook` (a hook
// or a review node - both grow `anchor` inputs the same way).
//
// The slots auto-grow, but only in response to a connection: a workflow loaded
// from disk comes back with exactly the slots it was saved with. So when every
// one is taken, one is added here, using the name ComfyUI's own autogrow would
// give it (`<container>.<prefix><n>`). Returns whether the wire actually went
// in; the caller says so either way, because "I put it beside the node" and "it
// feeds the next stage" are different promises.
export function wireIntoAnchor(node, hook) {
  const anchors = (hook.inputs || [])
    .map((inp, i) => ({ inp, i }))
    .filter(({ inp }) => inp && /^anchors?[.\d]/i.test(String(inp.name || "")));
  if (!anchors.length) return false;
  let slot = anchors.findIndex(({ inp }) => inp.link == null);
  slot = slot >= 0 ? anchors[slot].i : -1;
  if (slot < 0) {
    // All taken. Grow one rather than overwrite a link the user drew.
    try {
      const last = String(anchors[anchors.length - 1].inp.name || "");
      const dot = last.lastIndexOf(".");
      const container = dot > 0 ? last.slice(0, dot) : "anchors";
      const leaf = dot > 0 ? last.slice(dot + 1) : last;
      const n = parseInt((leaf.match(/\d+$/) || ["0"])[0], 10) + 1;
      const prefix = leaf.replace(/\d+$/, "") || "anchor";
      hook.addInput(`${container}.${prefix}${n}`, "*");
      slot = hook.inputs.length - 1;
    } catch (_) {
      return false;
    }
  }
  try {
    node.connect(0, hook, slot);
  } catch (_) {
    return false;
  }
  const inp = (hook.inputs || [])[slot];
  return !!(inp && inp.link != null);
}

// The label follows the purpose; the value does not change with it.
function applyPurposeLabel(node) {
  const w = getWidget(node, "remember");
  if (!w) return;
  const purpose = hostPurpose((getWidget(node, "purpose") || {}).value);
  const text = LABELS[purpose] || LABELS._;
  if (w.options) {
    w.options.on = text.on;
    w.options.off = text.off;
  }
  w.label_on = text.on;
  w.label_off = text.off;
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "agentY.hookNode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "AgentYHook") return;

    const configure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (info) {
      const r = configure ? configure.call(this, info) : undefined;
      // A purpose from before the rename is carried over, not left as a value
      // the dropdown does not offer.
      const purpose = getWidget(this, "purpose");
      if (purpose) purpose.value = currentPurpose(purpose.value);
      applyPurposeLabel(this);
      return r;
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      this.color = "#5c3a28";
      this.bgcolor = "#3a2a20";
      if (!this.title || this.title === "AgentYHook") this.title = "agentY hook";
      // Only seed the size on a fresh node; a restored node keeps its saved size,
      // and the auto-growing anchor inputs resize the node as wired.
      if (!this.size || (this.size[0] === 0 && this.size[1] === 0)) this.size = [300, 300];

      // Wrapped rather than replaced: the combo's own callback commits the value.
      const purpose = getWidget(this, "purpose");
      if (purpose) {
        const orig = purpose.callback;
        const node = this;
        purpose.callback = function (...args) {
          const rr = orig ? orig.apply(this, args) : undefined;
          applyPurposeLabel(node);
          return rr;
        };
      }
      applyPurposeLabel(this);
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
    // What the snippet produced, shown on the node after a run: one line per
    // output (`out0: 42`, a tensor by its shape). Files it saved come back as the
    // run's images and are previewed by ComfyUI itself.
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      showPythonResult(this, (message && message.text) || []);
      return r;
    };
  },
});

export function showPythonResult(node, lines) {
  const text = (Array.isArray(lines) ? lines : [lines]).map(String).join(String.fromCharCode(10))
    || "(no outputs set)";
  let w = (node.widgets || []).find((x) => x && x.name === "result");
  if (!w) {
    // Read-only and never saved: it describes the last run, and a stale copy in
    // the workflow file would read as a value the node was given.
    const box = document.createElement("textarea");
    box.readOnly = true;
    box.className = "comfy-multiline-input";
    box.style.opacity = "0.85";
    box.placeholder = "result of the last run";
    if (typeof node.addDOMWidget === "function") {
      w = node.addDOMWidget("result", "customtext", box, {
        getValue: () => box.value,
        setValue: (v) => { box.value = String(v ?? ""); },
        serialize: false,
      });
      if (w) w.serialize = false;
    } else {
      w = node.addWidget("text", "result", "", () => {}, { serialize: false });
      if (w) w.serialize = false;
    }
    if (!w) return;
    w.__ayBox = box;
  }
  w.value = text;
  if (w.__ayBox) w.__ayBox.value = text;
  node.setDirtyCanvas?.(true, true);
}
