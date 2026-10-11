// The plan overview: the host's record of a pipeline run (its ledger, served at
// /agentY/threads/<id>/plan), as the panel shows it.
//
// Pure: what to print for a run, a group and a stage. The panel (agent_chat.js)
// fetches the plan and builds the elements; nothing here touches the page or the
// graph, so it can be read and tested on its own.

// One mark per state. A stage whose inputs changed since it was made is marked
// over whatever state it is in: that is the one the user has to look at.
export const STATE_MARK = { pending: "○", done: "●", waiting: "⏸", approved: "✓" };
export const STATE_WORD = {
  pending: "not done yet", done: "done", waiting: "waiting for you", approved: "approved",
};
const BRANCH_MARK = { running: "🟢", queued: "⏳", done: "✓", failed: "✗", stopped: "⏹", new: "·" };

export function stageMark(row) {
  if (!row) return STATE_MARK.pending;
  return row.changed ? "≠" : (STATE_MARK[row.state] || STATE_MARK.pending);
}

// "8 characters" — the id is what the agent and the canvas call the node by.
export function stageLabel(row) {
  const title = String((row && row.title) || "").trim();
  return String(row && row.id) + (title ? " " + title : "");
}

// The few words after the label: where it stands and what there is of it.
export function stageNote(row) {
  if (!row) return "";
  const bits = [STATE_WORD[row.state] || row.state || ""];
  if (row.changed) bits.push("inputs changed since");
  if (row.round > 1) bits.push("round " + row.round);
  if (row.files) bits.push(row.files + (row.files === 1 ? " file" : " files"));
  else if (row.text) bits.push("text");
  return bits.filter(Boolean).join(" · ");
}

export function stageTitle(row) {
  const bits = [row.purpose, stageNote(row)];
  if (row.review && (row.state === "waiting" || row.state === "approved")) {
    bits.push("review " + row.review);
  }
  if (row.by) bits.push("by branch " + row.by);
  return bits.filter(Boolean).join(" — ") + "\nClick to select the node on the canvas.";
}

export function groupLabel(group) {
  if (!group) return "";
  if (group.kind !== "branch") return group.name || "";
  return (BRANCH_MARK[group.status] || "·") + " " + (group.name || "Branch");
}

// Is there a run to show? A conversation with shots but no ledger still gets its
// chips (see planChips), so the bar can be up with no groups.
export function hasPlan(data) {
  return !!(data && Array.isArray(data.groups) && data.groups.length);
}

export function planLine(data) {
  return hasPlan(data) ? String(data.line || "") : "";
}

// The conversations to offer as chips: the lead, when a branch is on screen (the
// way back), and every branch when there is no plan to list them in.
export function planChips(data, currentId) {
  if (!data) return [];
  const shots = Array.isArray(data.shots) ? data.shots : [];
  if (!shots.length) return [];
  const chips = [];
  const onBranch = String(currentId || "") !== String(data.lead_id || "");
  if (onBranch || !hasPlan(data)) {
    chips.push({ id: data.lead_id, label: "◆ Lead", title: data.lead_title || "The lead conversation" });
  }
  if (!hasPlan(data)) {
    for (const sh of shots) {
      chips.push({ id: sh.thread_id, label: (BRANCH_MARK[sh.status] || "·") + " " + sh.shot,
                   title: sh.status + (sh.report ? " — " + String(sh.report).slice(0, 160) : "") });
    }
  }
  return chips;
}

export function anyBranchRunning(data) {
  return !!(data && (data.shots || []).some((s) => s.status === "running" || s.status === "queued"));
}
