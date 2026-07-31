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

// ── Canvas selection bridge ───────────────────────────────────────────────────
// The selection and the live widget values exist only here, in the page. The
// server relays a request over the websocket and we answer it with a POST — see
// the "Canvas selection" section of __init__.py. This lives in agent_canvas.js
// rather than agent_chat.js on purpose: it must work even when the chat sidebar
// was never opened (the MCP caller has no sidebar at all).

function toast(msg, kind) {
  try {
    const t = app?.extensionManager?.toast;
    if (t && t.add) { t.add({ severity: kind || "info", summary: "agentY", detail: msg, life: 5000 }); return; }
  } catch (_) {}
  console.log("[agentY-comfyuiConnect] " + msg);
}

async function reply(req_id, payload) {
  try {
    await fetch(window.location.origin + "/agent/canvas_reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ req_id, ...payload }),
    });
  } catch (err) {
    console.error("[agentY-comfyuiConnect] canvas_reply failed:", err);
  }
}

// Ids are numbers on the root graph but can be strings inside a subgraph, so try
// the value as given before coercing, and fall back to a string compare.
function nodeById(id) {
  const graph = app.graph;
  if (!graph) return null;
  if (graph.getNodeById) {
    const hit = graph.getNodeById(id) || graph.getNodeById(Number(id));
    if (hit) return hit;
  }
  return (graph._nodes || []).find((x) => x && String(x.id) === String(id)) || null;
}

// Widget values worth reporting: scalars only. Object-valued widgets are
// internal state (canvases, image buffers) that would bloat the answer.
function widgetSnapshot(node) {
  const out = {};
  for (const w of node.widgets || [])
    if (w && w.name != null && w.value != null && typeof w.value !== "object") out[w.name] = w.value;
  return out;
}

// Every selected node, whatever its type — a Reroute or Note with no widgets
// still belongs in the answer, otherwise "what did I select" comes back short.
// Order is graph order, not click order (the sidebar tracks click order for its
// own attach-in-order behaviour; a reader doesn't need it).
function selectedNodes() {
  const canvas = app.canvas, graph = app.graph;
  if (!canvas || !graph) return [];
  // Three shapes across frontend versions, all giving the node objects straight
  // back — so no id round trip, and string ids inside subgraphs stay intact.
  const found = new Map(); // id -> node, de-duped
  const add = (n) => { if (n && n.id != null) found.set(String(n.id), n); };
  if (canvas.selected_nodes) for (const n of Object.values(canvas.selected_nodes)) add(n);
  if (canvas.selectedItems && canvas.selectedItems.forEach)
    // selectedItems also carries groups and reroutes; only nodes have `widgets`.
    canvas.selectedItems.forEach((it) => { if (it && it.widgets !== undefined) add(it); });
  if (found.size === 0 && graph._nodes) for (const n of graph._nodes) if (n && n.is_selected) add(n);
  const out = [];
  for (const n of found.values()) {
    out.push({
      id: String(n.id),
      type: String(n.type || n.comfyClass || ""),
      title: String(n.title || ""),
      // 2 = muted, 4 = bypassed — both mean "not part of the next run", which
      // changes what an edit to this node would actually do.
      mode: n.mode | 0,
      widgets: widgetSnapshot(n),
    });
  }
  return out;
}

function applyNodeParams(node_id, params) {
  const node = nodeById(node_id);
  if (!node) return { ok: false, applied: [], unknown: [], node: "",
                      error: `node #${node_id} is not on the canvas` };
  const applied = [], unknown = [];
  for (const [name, value] of Object.entries(params || {})) {
    const w = (node.widgets || []).find((x) => x && x.name === name);
    if (!w) { unknown.push(name); continue; }
    // Keep combo widgets valid: register a new option value if needed.
    if (w.options && Array.isArray(w.options.values) &&
        typeof value !== "object" && !w.options.values.includes(value)) {
      w.options.values.push(value);
    }
    w.value = value;
    try { if (w.callback) w.callback(value, app.canvas, node); } catch (_) {}
    applied.push(name);
  }
  app.graph.setDirtyCanvas(true, true);
  const title = node.title || node.type || ("#" + node_id);
  if (applied.length) toast(`Updated ${title} — set ${applied.join(", ")}.`, "success");
  else toast(`No matching widget on ${title} (tried ${unknown.join(", ")}).`, "warn");
  return { ok: applied.length > 0, applied, unknown, node: title, error: "" };
}

app.registerExtension({
  name: "agentY.canvas.autoload",
  async setup() {
    api.addEventListener("agent.request_selection", (event) => {
      const d = (event && event.detail) || {};
      let nodes = [], workflow = "";
      try { nodes = selectedNodes(); } catch (err) {
        console.error("[agentY-comfyuiConnect] reading the selection failed:", err);
      }
      try { workflow = String(app.workflowManager?.activeWorkflow?.path || ""); } catch (_) {}
      reply(d.req_id, { nodes, workflow });
    });

    api.addEventListener("agent.set_node_params", (event) => {
      const d = (event && event.detail) || {};
      let res;
      try {
        res = applyNodeParams(d.node_id, d.params);
      } catch (err) {
        res = { ok: false, applied: [], unknown: [], node: "", error: String(err) };
      }
      reply(d.req_id, res);
    });

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
