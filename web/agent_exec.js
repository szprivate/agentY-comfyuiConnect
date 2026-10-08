// The execution wire, read off a graph. No imports: everything here is a plain
// function of the nodes it is handed, so it runs under node in the tests.
//
// Order in a hook pipeline is the EXECUTION WIRE, as in Unreal's node editor:
// every hook, loop and review node has an `exec` input and an `exec` output of a
// socket type of its own, and the stages run in the order that wire is drawn. A
// wire that splits starts branches that run side by side. It carries no data -
// inputs and outputs are only inputs and outputs.

export const EXEC_TYPE = "AGENTY_EXEC";

// The loop nodes, by what they are to the host.
export const FLOW_PURPOSE = { AgentYLoopStart: "loop_start", AgentYLoopBreak: "loop_break" };

export function flowPurpose(node) {
  return (node && (FLOW_PURPOSE[node.type] || FLOW_PURPOSE[node.comfyClass])) || "";
}

const classOf = (node) => String((node && (node.type || node.comfyClass)) || "");

export function isHookNode(node) { return classOf(node) === "AgentYHook"; }
export function isReviewNode(node) { return classOf(node) === "AgentYReview"; }

/** A node the execution wire runs through: a hook, a review, a loop node. */
export function isExecNode(node) {
  return isHookNode(node) || isReviewNode(node) || !!flowPurpose(node);
}

/** Is this socket (an input or an output) the execution wire? */
export function isExecSlot(slot) {
  return !!slot && (String(slot.type || "") === EXEC_TYPE || String(slot.name || "") === "exec");
}

/** The node wired into `node`'s exec input, or null. */
export function execSource(graph, node) {
  const inp = (node.inputs || []).find((i) => isExecSlot(i) && i.link != null);
  const link = inp && graph && graph.links ? graph.links[inp.link] : null;
  return (link && graph.getNodeById ? graph.getNodeById(link.origin_id) : null) || null;
}

/**
 * The stages `node` runs after: the ids of the nearest nodes up the execution
 * wire that `counts` accepts.
 *
 * A node that does not count is transparent - the wire passes through it. That
 * is what makes bypassing (Ctrl+B) a stage, or leaving one empty, do the
 * obvious thing: the stages either side of it are simply next to each other.
 *
 * Pure but for the graph it is handed, so it can be tested without a canvas.
 */
export function execPredecessors(graph, node, counts) {
  const seen = new Set();
  let cur = execSource(graph, node);
  while (cur && !seen.has(cur.id)) {
    if (!isExecNode(cur)) return [];        // an exec wire from a foreign node says nothing
    if (counts(cur)) return [String(cur.id)];
    seen.add(cur.id);
    cur = execSource(graph, cur);
  }
  return [];
}
