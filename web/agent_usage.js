// The panel's live usage line: what the turn has spent so far, in one row of text.
//
// The host sends a "usage" event whenever a turn's totals move (after each tool
// call, before each model call, and at the end):
//   { input, output, cache_read, cache_write, cache_hit, cost, calls }
// `cost` is null when no price is known for the model, and is then left out
// rather than shown as $0.00, which would read as "free".
//
// Kept in a module of its own, with no DOM and no ComfyUI imports, so it can be
// checked by itself.

/** 950 -> "950", 12400 -> "12.4k", 1250000 -> "1.25M" */
export function compactCount(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return String(Math.round(v));
  // 999,950 and up would round to "1000k"
  if (v < 999950) return trimZero((v / 1e3).toFixed(v < 1e4 ? 2 : 1)) + "k";
  return trimZero((v / 1e6).toFixed(2)) + "M";
}

function trimZero(s) {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** 0.0312 -> "$0.03", 0.004 -> "<$0.01", 12.5 -> "$12.50" */
export function formatCost(cost) {
  const v = Number(cost);
  if (!Number.isFinite(v) || v < 0) return "";
  if (v > 0 && v < 0.005) return "<$0.01";
  return "$" + v.toFixed(2);
}

/** "🪙 12.4k in · 1.2k out · 68% cached · $0.03 · 9 calls" */
export function formatUsage(u) {
  if (!u) return "";
  const parts = [compactCount(u.input) + " in", compactCount(u.output) + " out"];
  const hit = Number(u.cache_hit) || 0;
  if (hit > 0) parts.push(Math.round(hit * 100) + "% cached");
  if (u.cost !== null && u.cost !== undefined) {
    const c = formatCost(u.cost);
    if (c) parts.push(c);
  }
  const calls = Number(u.calls) || 0;
  if (calls > 0) parts.push(calls + (calls === 1 ? " call" : " calls"));
  return "🪙 " + parts.join(" · ");
}
