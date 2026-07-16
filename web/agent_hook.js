import { app } from "../../scripts/app.js";

// agentY hook node frontend:
//  • a distinct warm colour so it's obvious it's an agent annotation, not part
//    of the executing pipeline.
// The hook has a single, type-agnostic "out" output (declared in the V3 schema).
// The anchor *inputs* still auto-grow (a proper V3 Autogrow primitive); the
// outputs no longer do — a stage that yields several results forwards them all
// to the next hook via the agent (from the run_workflow_now result), and a baked
// subgraph's output count comes from the agent's exposed-outputs spec, not from
// extra slots on this node. The old output auto-grow added a confusing second
// output and mutated the slot array mid-connection; a single fixed output is
// simpler and unambiguous to wire.

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
      // and the auto-growing anchor inputs resize the node as wired.
      if (!this.size || (this.size[0] === 0 && this.size[1] === 0)) this.size = [300, 280];
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
