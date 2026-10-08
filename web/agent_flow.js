import { app } from "../../scripts/app.js";

// The flow of a hook pipeline: which stage runs after which.
//
// Order is the EXECUTION WIRE, as in Unreal's node editor: every hook, loop and
// review node has an `exec` input and an `exec` output of a socket type of its
// own, and the stages run in the order that wire is drawn. A wire that splits
// starts branches that run side by side. It carries no data - inputs and
// outputs are only inputs and outputs - and the host reads nothing else for
// order (src/utils/hook_flow.py).
//
// Reading the wire off the graph is agent_exec.js (pure, and tested under node).
// Here: the wire's colour and the look of the loop nodes.

import { EXEC_TYPE, flowPurpose } from "./agent_exec.js";

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
// White, like Unreal's: the one wire on the canvas that is not data.
const EXEC_COLOR = "#f2f2f2";

app.registerExtension({
  name: "agentY.flow",
  setup() {
    try {
      const LGC = window.LGraphCanvas;
      if (LGC && LGC.link_type_colors) LGC.link_type_colors[EXEC_TYPE] = EXEC_COLOR;
      const canvas = app.canvas;
      if (canvas && canvas.default_connection_color_byType) {
        canvas.default_connection_color_byType[EXEC_TYPE] = EXEC_COLOR;
      }
    } catch (_) { /* a colour is not worth failing a page load over */ }
  },
  nodeCreated(node) {
    if (!flowPurpose(node)) return;
    node.color = node.color || COLOR;
    node.bgcolor = node.bgcolor || BGCOLOR;
  },
});
