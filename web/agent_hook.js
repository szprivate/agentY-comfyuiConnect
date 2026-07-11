import { app } from "../../scripts/app.js";

// agentY hook node frontend:
//  • a distinct warm colour so it's obvious it's an agent annotation, not part
//    of the executing pipeline;
//  • auto-growing OUTPUT slots. The V3 schema auto-grows the anchor *inputs*
//    (Autogrow), but V3 has no dynamic-output primitive, so we grow the outputs
//    here: whenever the last output gets wired, a fresh empty AnyType output
//    appears, letting a workflow-standin export several results (image, video,
//    string, int, float — the slots are type-agnostic "*") to the next hook.

function hasLinks(slot) {
  return !!(slot && slot.links && slot.links.length);
}

// Keep exactly one trailing empty output so the user can always wire one more,
// without leaving a growing tail of empties behind.
function growOutputs(node) {
  if (!node || node._agentYGrowing) return;
  node._agentYGrowing = true;
  try {
    node.outputs = node.outputs || [];
    // Trim: while the last two outputs are both empty, drop the last (keep one).
    while (
      node.outputs.length > 1 &&
      !hasLinks(node.outputs[node.outputs.length - 1]) &&
      !hasLinks(node.outputs[node.outputs.length - 2])
    ) {
      node.removeOutput(node.outputs.length - 1);
    }
    // Ensure a trailing empty slot exists.
    const n = node.outputs.length;
    if (n === 0 || hasLinks(node.outputs[n - 1])) node.addOutput("out", "*");
  } catch (e) {
    console.error("[agentY-comfyuiConnect] output auto-grow failed:", e);
  } finally {
    node._agentYGrowing = false;
  }
}

app.registerExtension({
  name: "agentY.hookNode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "AgentYHook") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      this.color = "#5c3a28";
      this.bgcolor = "#3a2a20";
      if (!this.title || this.title === "AgentYHook") this.title = "agentY hook";
      // Only seed the size on a fresh node; a restored node keeps its saved size,
      // and the auto-growing anchor inputs / outputs resize the node as wired.
      if (!this.size || (this.size[0] === 0 && this.size[1] === 0)) this.size = [300, 280];
      // Seed the trailing empty output once the node is on the graph.
      setTimeout(() => growOutputs(this), 0);
      return r;
    };

    // Grow outputs whenever an output connection changes.
    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, index, connected, link_info, ioSlot) {
      const r = onConn ? onConn.apply(this, arguments) : undefined;
      if (type === LiteGraph.OUTPUT) growOutputs(this);
      return r;
    };

    // A graph load restores saved slots without firing onConnectionsChange —
    // re-seed the trailing empty so a reopened chain stays extendable.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => growOutputs(this), 0);
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
