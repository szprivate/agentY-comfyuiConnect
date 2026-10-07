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
