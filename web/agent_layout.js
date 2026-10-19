// Where things the agent adds to a graph the user already has open go.
//
// A workflow inserted into an open graph used to land node by node, each
// "beside the one that feeds it" - which is anywhere, and often on top of
// something. And every result was dropped as a loader node wherever there was
// room. Here both get a place of their own:
//
//   * an inserted workflow is laid out in the columns and rows the agent's own
//     workflows are laid out in (agenty_core's graph_groups), below everything
//     that is on the canvas, inside a group named agent_1, agent_2, ...
//   * results go into one group, "agent outputs", in a grid that grows.
//
// Geometry only: plain numbers in, plain numbers out, no LiteGraph and no DOM,
// so it can be checked by itself. Rectangles are [x, y, w, h]. A node's rectangle
// here INCLUDES its title bar, which LiteGraph draws above node.pos.

export const GAPS = { column: 60, node: 30, band: 60, pad: 24, group_title: 32, title_bar: 30 };
export const BLOCK_MARGIN = 100;          // between what is there and what is added
export const OUTPUTS_TITLE = "agent outputs";
export const OUTPUT_CELL = [340, 400];    // a loader with its preview, and room to grow
export const OUTPUT_COLUMNS = 4;
export const GROUP_COLOR = "#3f789e";
export const OUTPUTS_COLOR = "#3f9e6b";

/** The rectangle around every rectangle given, or null when there are none. */
export function boundsOf(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects || []) {
    if (!r || r.length < 4 || !r.every(Number.isFinite)) continue;
    x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]);
    x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3]);
  }
  return Number.isFinite(x0) ? [x0, y0, x1 - x0, y1 - y0] : null;
}

export function overlaps(a, b, gap = 0) {
  return a[0] < b[0] + b[2] + gap && a[0] + a[2] + gap > b[0]
      && a[1] < b[1] + b[3] + gap && a[1] + a[3] + gap > b[1];
}

/** "agent_3" when agent_1 and agent_2 are taken. Gaps are not reused: a name
 *  the user saw on a group that is gone should not come back on another one. */
export function nextAgentName(titles, prefix = "agent") {
  let top = 0;
  const re = new RegExp("^" + prefix + "_(\\d+)$");
  for (const t of titles || []) {
    const m = re.exec(String(t || "").trim());
    if (m) top = Math.max(top, Number(m[1]));
  }
  return prefix + "_" + (top + 1);
}

/** Is this a group the agent made - "agent_3", or the outputs group? Only those
 *  are ever removed or resized by the panel; a group the user drew is theirs. */
export function isAgentGroupTitle(title) {
  const t = String(title || "").trim();
  return t === OUTPUTS_TITLE || /^agent_\d+$/.test(t);
}

/** Top-left corner for a new block: below everything, at the content's left
 *  edge. `fallback` when the graph is empty. */
export function blockOrigin(existing, fallback = [80, 80]) {
  const b = boundsOf(existing);
  if (!b) return [fallback[0], fallback[1]];
  return [b[0], b[1] + b[3] + BLOCK_MARGIN];
}

/** Lay items out in columns and rows.
 *  items: [{id, size:[w,h], band, col, row}]  ->  {positions:{id:[x,y]}, bounds}
 *  `origin` is where the block's GROUP box starts; node positions are node.pos
 *  (below the title bar), inside the group's padding and title. */
export function layoutBlock(items, origin, gaps = GAPS) {
  const g = { ...GAPS, ...(gaps || {}) };
  const list = (items || []).filter((i) => i && Array.isArray(i.size));
  const positions = {};
  if (!list.length) return { positions, bounds: null };
  const columns = [...new Set(list.map((i) => i.col))].sort((a, b) => a - b);
  const width = {};
  for (const i of list) width[i.col] = Math.max(width[i.col] || 0, i.size[0]);
  const xOf = {};
  let x = origin[0] + g.pad;
  for (const c of columns) { xOf[c] = x; x += width[c] + g.column; }

  let top = origin[1] + g.group_title + g.pad;
  const rects = [];
  for (const band of [...new Set(list.map((i) => i.band))].sort((a, b) => a - b)) {
    let bottom = top;
    for (const c of columns) {
      let y = top + g.title_bar;
      const cell = list.filter((i) => i.band === band && i.col === c).sort((a, b) => a.row - b.row);
      for (const i of cell) {
        positions[i.id] = [xOf[c], y];
        rects.push([xOf[c], y - g.title_bar, i.size[0], i.size[1] + g.title_bar]);
        bottom = Math.max(bottom, y + i.size[1]);
        y += i.size[1] + g.title_bar + g.node;
      }
    }
    top = bottom + g.band;
  }
  return { positions, bounds: groupBox(rects, g) };
}

/** The group rectangle that holds these node rectangles (title bars included). */
export function groupBox(rects, gaps = GAPS) {
  const g = { ...GAPS, ...(gaps || {}) };
  const b = boundsOf(rects);
  if (!b) return null;
  return [b[0] - g.pad, b[1] - g.pad - g.group_title, b[2] + 2 * g.pad, b[3] + 2 * g.pad + g.group_title];
}

/** The area in which a result still belongs to the outputs group: the group as
 *  it is drawn, widened to the full grid and deepened by one more row. A result
 *  is placed into its cell BEFORE the group is resized around it, so "inside the
 *  box as drawn" would miss exactly the one that makes the box grow. */
export function outputsReach(groupRect, cell = OUTPUT_CELL, columns = OUTPUT_COLUMNS, gaps = GAPS) {
  const g = { ...GAPS, ...(gaps || {}) };
  const gridW = 2 * g.pad + columns * cell[0] + (columns - 1) * g.column;
  const rowH = cell[1] + g.title_bar + g.node;
  return [groupRect[0], groupRect[1], Math.max(groupRect[2], gridW), groupRect[3] + rowH];
}

/** Where a new "agent outputs" group starts: right of everything, level with
 *  its top. */
export function outputsOrigin(existing, fallback = [80, 80]) {
  const b = boundsOf(existing);
  if (!b) return [fallback[0], fallback[1]];
  return [b[0] + b[2] + BLOCK_MARGIN, b[1]];
}

/** node.pos for the next result: the first grid cell, row by row, that no
 *  output already in the group sits in.
 *  groupPos: the group's top-left; taken: rectangles of the outputs there. */
export function outputSlot(groupPos, taken, cell = OUTPUT_CELL, columns = OUTPUT_COLUMNS, gaps = GAPS) {
  const g = { ...GAPS, ...(gaps || {}) };
  const x0 = groupPos[0] + g.pad;
  const y0 = groupPos[1] + g.group_title + g.pad + g.title_bar;
  for (let n = 0; n < 400; n++) {
    const col = n % columns, row = Math.floor(n / columns);
    const pos = [x0 + col * (cell[0] + g.column), y0 + row * (cell[1] + g.node + g.title_bar)];
    const spot = [pos[0], pos[1] - g.title_bar, cell[0], cell[1] + g.title_bar];
    if (!(taken || []).some((t) => overlaps(spot, t))) return pos;
  }
  return [x0, y0];
}

// ── Tidying a graph that is already there (arrange_canvas, group_canvas_nodes) ──
//
// The same columns-and-rows block as an inserted workflow (layoutBlock), applied
// to the nodes of an existing graph: columns by distance from the inputs, rows
// ordered by where a node's feeds sit, one block per group so a group stays one
// rectangle, blocks side by side in the order their data flows. This does not
// replace arrangeAgentGraph (agent_canvas.js) / graph_groups.arrange, which
// place a freshly built workflow from the server's slots; it reuses the same
// gaps and the same layoutBlock, and does not change either.

export const MAX_ROW_WIDTH = 6000;     // a row of blocks wraps below this width
export const BLOCK_GAP = 80;

/** Longest-path depth of every id (roots 0), cycle-safe. edges: [[from, to]]. */
export function depthsOf(ids, edges) {
  const known = new Set(ids.map(String));
  const depth = {};
  for (const id of known) depth[id] = 0;
  const live = (edges || []).map(([a, b]) => [String(a), String(b)])
    .filter(([a, b]) => known.has(a) && known.has(b) && a !== b);
  for (let pass = 0; pass <= known.size; pass++) {
    let moved = false;
    for (const [a, b] of live) {
      if (depth[a] + 1 > depth[b] && depth[a] + 1 <= known.size) { depth[b] = depth[a] + 1; moved = true; }
    }
    if (!moved) break;
  }
  return depth;
}

/** items: [{id, size:[w,h], group:key|null, x, y}] (x, y = where the node is now,
 *  only to break ties); edges: [[from, to]]; origin: top-left of the result.
 *  -> {positions:{id:[x,y]}, boxes:{groupKey:[x,y,w,h]}, bounds, order:[groupKey|null]} */
export function flowArrange(items, edges, origin, gaps = GAPS, maxWidth = MAX_ROW_WIDTH) {
  const list = (items || []).filter((i) => i && Array.isArray(i.size));
  const out = { positions: {}, boxes: {}, bounds: null, order: [] };
  if (!list.length) return out;
  const depth = depthsOf(list.map((i) => i.id), edges);
  const preds = {};
  for (const [a, b] of edges || []) (preds[String(b)] = preds[String(b)] || []).push(String(a));

  const blocks = new Map();
  for (const i of list) {
    const k = i.group == null ? null : String(i.group);
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k).push(i);
  }
  const laid = [];
  for (const [key, members] of blocks) {
    const depths = [...new Set(members.map((m) => depth[String(m.id)]))].sort((a, b) => a - b);
    const col = new Map(depths.map((d, n) => [d, n]));
    const row = {};
    const items2 = [];
    for (const d of depths) {
      const inCol = members.filter((m) => depth[String(m.id)] === d);
      const bary = (m) => {
        const rs = (preds[String(m.id)] || []).filter((p) => p in row).map((p) => row[p]);
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : Infinity;
      };
      inCol.sort((a, b) => (bary(a) - bary(b)) || ((a.y || 0) - (b.y || 0)) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
      inCol.forEach((m, r) => { row[String(m.id)] = r; items2.push({ id: m.id, size: m.size, band: 0, col: col.get(d), row: r }); });
    }
    const block = layoutBlock(items2, [0, 0], gaps);
    laid.push({ key, block,
      minDepth: depths[0],
      minX: Math.min(...members.map((m) => m.x || 0)) });
  }
  laid.sort((a, b) => (a.minDepth - b.minDepth) || (a.minX - b.minX));
  // A block goes after every block it receives links from; ties keep the order
  // above, and a cycle between blocks is broken at the earliest one.
  const blockOf = {};
  for (const l of laid) for (const m of blocks.get(l.key)) blockOf[String(m.id)] = l.key;
  const feeds = new Map(laid.map((l) => [l.key, new Set()]));
  for (const [a, b] of edges || []) {
    const ka = blockOf[String(a)], kb = blockOf[String(b)];
    if (ka !== undefined && kb !== undefined && ka !== kb) feeds.get(kb).add(ka);
  }
  const rest = laid.slice(), placed = new Set(), sorted = [];
  while (rest.length) {
    let at = rest.findIndex((l) => [...feeds.get(l.key)].every((k) => placed.has(k)));
    if (at < 0) at = 0;
    const [next] = rest.splice(at, 1);
    placed.add(next.key);
    sorted.push(next);
  }
  laid.splice(0, laid.length, ...sorted);

  let cx = origin[0], cy = origin[1], rowH = 0;
  const all = [];
  for (const { key, block } of laid) {
    const [, , bw, bh] = block.bounds;
    if (cx > origin[0] && cx + bw > origin[0] + maxWidth) { cx = origin[0]; cy += rowH + BLOCK_GAP; rowH = 0; }
    for (const [id, p] of Object.entries(block.positions)) out.positions[id] = [p[0] + cx, p[1] + cy];
    const box = [block.bounds[0] + cx, block.bounds[1] + cy, bw, bh];
    if (key != null) out.boxes[key] = box;
    out.order.push(key);
    all.push(box);
    cx += bw + BLOCK_GAP;
    rowH = Math.max(rowH, bh);
  }
  out.bounds = boundsOf(all);
  return out;
}
