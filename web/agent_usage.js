// The panel's live usage line: what the turn has spent so far and how long it
// has been running, in one row of text.
//
// The host sends a "usage" event whenever a turn's totals move (after each tool
// call, before each model call, and at the end):
//   { input, output, cache_read, cache_write, cache_hit, cost, calls }
// `cost` is not shown: it is a guess from a price table, and read as a bill.
// The clock is the panel's own, from the turn's start (the "request" event).
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

/** 7 -> "0:07", 187 -> "3:07", 3725 -> "1:02:05" */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const two = (n) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return (h ? h + ":" + two(m) : String(m)) + ":" + two(s % 60);
}

/** "🪙 12.4k in · 1.2k out · 68% cached · 9 calls · ⏱ 3:07". *seconds* is how
 *  long the turn has run (null: no clock); either part may stand alone. */
export function formatUsage(u, seconds = null) {
  const out = [];
  if (u) {
    const parts = [compactCount(u.input) + " in", compactCount(u.output) + " out"];
    const hit = Number(u.cache_hit) || 0;
    if (hit > 0) parts.push(Math.round(hit * 100) + "% cached");
    const calls = Number(u.calls) || 0;
    if (calls > 0) parts.push(calls + (calls === 1 ? " call" : " calls"));
    out.push("🪙 " + parts.join(" · "));
  }
  if (seconds !== null && seconds !== undefined) out.push("⏱ " + formatClock(seconds));
  return out.join(" · ");
}
