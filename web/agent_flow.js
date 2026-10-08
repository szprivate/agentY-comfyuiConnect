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

// The node's title with the loop's state after it: "agentY loop break · round 2 of 4".
// The title is what both node renderers show, which a line drawn under the node
// is not (the Vue renderer never calls onDrawForeground).
export const FLOW_TITLE_SEP = " · ";
export function flowTitle(title, state) {
  const base = String(title || "").split(FLOW_TITLE_SEP)[0].trim() || "agentY loop break";
  const line = flowStateLine(state);
  return line ? base + FLOW_TITLE_SEP + line : base;
}

const COLOR = "#2f4858";
const BGCOLOR = "#243642";

app.registerExtension({
  name: "agentY.flow",
  nodeCreated(node) {
    if (!flowPurpose(node)) return;
    node.color = node.color || COLOR;
    node.bgcolor = node.bgcolor || BGCOLOR;
  },
});
