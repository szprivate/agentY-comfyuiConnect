import { app } from "../../scripts/app.js";

// The flow nodes of a hook pipeline: agentY loop start / agentY loop break.
// Neither does work; they mark which hooks repeat and when the repeating ends
// (the host reads them - src/utils/hook_flow.py). Here: their colour, and the
// line under the title that says where a running loop stands.

export const FLOW_PURPOSE = { AgentYLoopStart: "loop_start", AgentYLoopBreak: "loop_break" };

export function flowPurpose(node) {
  return (node && (FLOW_PURPOSE[node.type] || FLOW_PURPOSE[node.comfyClass])) || "";
}

// { state: "running" | "met" | "out_of_rounds", round, max_rounds, forward: [names] }
// -> the line shown on the break node. Pure, so it can be tested without a canvas.
export function flowStateLine(s) {
  if (!s || !s.state) return "";
  const of = s.max_rounds ? ` of ${s.max_rounds}` : "";
  if (s.state === "running") return `round ${s.round || 1}${of} — not there yet`;
  const sent = (s.forward || []).length ? ` → ${s.forward.join(", ")}` : "";
  if (s.state === "met") return `✓ met in round ${s.round}${sent}`;
  if (s.state === "out_of_rounds") return `✗ not met after ${s.round} — best attempt${sent}`;
  return "";
}

const COLOR = "#2f4858";
const BGCOLOR = "#243642";

app.registerExtension({
  name: "agentY.flow",
  nodeCreated(node) {
    if (!flowPurpose(node)) return;
    node.color = node.color || COLOR;
    node.bgcolor = node.bgcolor || BGCOLOR;
    const drawn = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
      if (drawn) drawn.apply(this, arguments);
      const line = flowStateLine(this.agentYFlowState);
      if (!line || this.flags?.collapsed) return;
      ctx.save();
      ctx.font = "12px sans-serif";
      ctx.fillStyle = this.agentYFlowState.state === "met" ? "#7ad18a"
        : this.agentYFlowState.state === "out_of_rounds" ? "#e0a05a" : "#9fb7c9";
      ctx.fillText(line, 10, this.size[1] + 16);
      ctx.restore();
    };
  },
});
