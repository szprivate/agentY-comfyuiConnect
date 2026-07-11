import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// agentY-comfyuiConnect: when the agentY pipeline runs a workflow it POSTs the graph to
// /agent/load_workflow, which the server broadcasts as an "agent.load_workflow"
// websocket event. Load that graph onto the canvas so the user sees exactly what
// just ran, without clicking through the Workflows sidebar.
//
// Two modes, chosen by graph.extra.agentY_add:
//  • replace (default) — swap the canvas for the graph the agent just ran;
//  • additive (bake)   — MERGE the incoming subgraph chain into the current
//    canvas, so baking a hook chain adds the baked subgraphs WITHOUT deleting the
//    user's hook nodes (or anything else already there).

// Highest numeric id across a list of nodes / links (array or object form).
function maxId(items, pick) {
  let m = 0;
  for (const it of items || []) {
    const v = pick(it) | 0;
    if (v > m) m = v;
  }
  return m;
}

// Merge an incoming (baked) graph into the live canvas, offsetting node + link
// ids so they can't collide with what's already there, and nudging the new nodes
// below existing content. Subgraph definition ids are uuids (collision-free) and
// their inner nodes/links live in their own scope, so only parent-level ids shift.
function mergeIntoCurrent(incoming) {
  const cur = app.graph.serialize();
  const curNodes = cur.nodes || [];
  const curLinks = cur.links || [];

  const nodeOffset = Math.max(cur.last_node_id | 0, maxId(curNodes, (n) => n.id));
  const linkOffset = Math.max(
    cur.last_link_id | 0,
    maxId(curLinks, (l) => (Array.isArray(l) ? l[0] : l && l.id))
  );

  let maxY = 0;
  for (const n of curNodes) {
    const y = (n.pos && n.pos[1]) || 0;
    const h = (n.size && n.size[1]) || 0;
    if (y + h > maxY) maxY = y + h;
  }
  const dy = maxY + 120; // drop the baked chain below the existing graph

  const inNodes = (incoming.nodes || []).map((n) => {
    const c = JSON.parse(JSON.stringify(n));
    c.id = (n.id | 0) + nodeOffset;
    if (Array.isArray(c.pos)) c.pos = [c.pos[0], (c.pos[1] || 0) + dy];
    for (const inp of c.inputs || []) if (inp && inp.link != null) inp.link += linkOffset;
    for (const out of c.outputs || [])
      if (out && Array.isArray(out.links)) out.links = out.links.map((id) => id + linkOffset);
    return c;
  });
  const inLinks = (incoming.links || []).map((l) => {
    if (Array.isArray(l)) {
      const c = l.slice();
      c[0] += linkOffset; // link id
      c[1] += nodeOffset; // origin node id
      c[3] += nodeOffset; // target node id
      return c;
    }
    return {
      ...l,
      id: (l.id | 0) + linkOffset,
      origin_id: (l.origin_id | 0) + nodeOffset,
      target_id: (l.target_id | 0) + nodeOffset,
    };
  });

  const curDefs = (cur.definitions && cur.definitions.subgraphs) || [];
  const inDefs = (incoming.definitions && incoming.definitions.subgraphs) || [];

  return {
    ...cur,
    last_node_id: nodeOffset + maxId(incoming.nodes, (n) => n.id),
    last_link_id: linkOffset + (incoming.last_link_id | 0),
    nodes: curNodes.concat(inNodes),
    links: curLinks.concat(inLinks),
    definitions: { subgraphs: curDefs.concat(inDefs) },
    extra: cur.extra || {},
  };
}

app.registerExtension({
  name: "agentY.canvas.autoload",
  async setup() {
    api.addEventListener("agent.load_workflow", async (event) => {
      const graph = event && event.detail;
      if (!graph || !Array.isArray(graph.nodes)) return;
      const additive = !!(graph.extra && graph.extra.agentY_add);
      try {
        if (additive && app.graph && typeof app.graph.serialize === "function") {
          // Bake: keep the current canvas (incl. hook nodes), add the subgraphs.
          const merged = mergeIntoCurrent(graph);
          await app.loadGraphData(merged, true, true, "agent bake");
        } else {
          // clean=true, restore_view=true — replace the current graph with the run.
          await app.loadGraphData(graph, true, true, "agent workflow");
        }
      } catch (err) {
        try {
          await app.loadGraphData(graph); // older signatures / fallback
        } catch (err2) {
          console.error("[agentY-comfyuiConnect] loadGraphData failed:", err2);
        }
      }
    });
    console.log("[agentY-comfyuiConnect] ready — workflows the agent runs will open here");
  },
});
