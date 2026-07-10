import { app } from "../../scripts/app.js";

// Give the agentY hook node a distinct warm color so it's obvious it's an agent
// annotation and not part of the executing pipeline.
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
      // and the auto-growing anchor inputs resize the node as they're wired.
      if (!this.size || (this.size[0] === 0 && this.size[1] === 0)) this.size = [300, 260];
      return r;
    };
  },
});
