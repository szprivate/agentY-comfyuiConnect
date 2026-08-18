import { app } from "../../scripts/app.js";

// agentY Project Memory editor launcher. The page itself is served by the agentY
// chat host (src/utils/agentY_server.py: GET /agentY/project_memory_viewer) so it
// reads and mutates the store same-origin via GET /agentY/project_memory and
// POST /agentY/project_memory/delete. This module only opens it in a new tab.
//
// Two memories, two viewers, and the difference is worth keeping straight:
//   • 🧠 long-term memory — what the agent has learned about how you work, across
//     every project (agent_memory_viewer.js).
//   • 📌 project memory — what is true of THIS project: the hero's description,
//     the grade, the delivery spec, a named reference tagged on a canvas. It
//     lives in ComfyUI's own user directory, so it switches with the project.
//
// Inspect and delete only. Writing is the agent's job (project_memory_write, or
// the `remember` switch on an `agentY add tag` node) — a second way to author the
// same file by hand would be a second source of truth. Deleting is deliberately
// NOT the agent's job: turning a tag's switch off never forgets anything, so this
// is where a fact stops being true of the project.

const DEFAULT_PORT = 5000;
function backendBase() {
  return (
    localStorage.getItem("agentY_backend") ||
    `http://${location.hostname || "127.0.0.1"}:${DEFAULT_PORT}`
  );
}

async function openProjectMemoryViewer() {
  const base = backendBase();
  // Health-probe first so a down host doesn't open a cryptic browser error page.
  // The probe is local and near-instant, so the healthy path still opens inside
  // the click gesture (a popup blocker only forgives windows opened from one).
  let up = false;
  try { up = (await fetch(base + "/agentY/health", { cache: "no-store" })).ok; } catch (_) {}
  if (up) {
    window.open(base + "/agentY/project_memory_viewer", "_blank", "noopener");
    return;
  }
  const w = window.open("", "_blank");
  if (w) {
    w.document.write(
      '<meta charset="utf-8"><title>agentY project memory</title>' +
      '<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#262624;' +
      'color:#f2f0ea;padding:44px;max-width:640px;margin:auto;line-height:1.6">' +
      "<h2 style=\"color:#d97757\">agentY host isn't reachable</h2>" +
      "<p>The project-memory editor is served by the agentY chat host at <code>" + base +
      "</code>, which doesn't appear to be running right now.</p>" +
      "<p>Start it with <code>run_agent.ps1</code>, then reopen this from the agentY " +
      "settings (Viewers) or the <code>/project_memory</code> command.</p></body>");
    w.document.close();
  }
}

// Exposed for the settings modal and the slash command in web/agent_chat.js.
window.agentYOpenProjectMemory = openProjectMemoryViewer;

app.registerExtension({ name: "agentY.projectMemoryViewer" });
