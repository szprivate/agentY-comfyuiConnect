import { app } from "../../scripts/app.js";
import { backendBase } from "./agent_backend.js";

// agentY Long-Term Memory Viewer launcher. The viewer itself is a
// self-contained page served by the agentY chat host
// (src/utils/agentY_server.py: GET /agentY/memory_viewer), which reads and
// mutates long-term memory same-origin via GET /agentY/memory and the
// POST /agentY/memory/{update,delete,clear} endpoints. This module only opens
// it in a new tab so it can be reached from ComfyUI.
//
// Two entry points, both calling openMemoryViewer():
//   • a 🧠 button in the chat panel's top bar (web/agent_chat.js), and
//   • an entry in ComfyUI's Settings panel (registered below).

async function openMemoryViewer() {
  const base = backendBase();
  // Health-probe first so a down host doesn't open a cryptic browser error page.
  // The probe is a local, near-instant call, so the healthy path still opens
  // within the click gesture.
  let up = false;
  try { up = (await fetch(base + "/agentY/health", { cache: "no-store" })).ok; } catch (_) {}
  if (up) {
    window.open(base + "/agentY/memory_viewer", "_blank", "noopener");
    return;
  }
  const w = window.open("", "_blank");
  if (w) {
    w.document.write(
      '<meta charset="utf-8"><title>agentY memory viewer</title>' +
      '<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#262624;' +
      'color:#f2f0ea;padding:44px;max-width:640px;margin:auto;line-height:1.6">' +
      "<h2 style=\"color:#d97757\">agentY host isn't reachable</h2>" +
      "<p>The long-term memory viewer is served by the agentY chat host at <code>" + base +
      "</code>, which doesn't appear to be running right now.</p>" +
      "<p>Start it with <code>run_agent.ps1</code> on Windows or <code>./run_agent.sh</code> " +
      "on macOS (or <code>python -m src.agenty_ui_server</code>), " +
      "then reopen this viewer from the 🧠 button.</p></body>");
    w.document.close();
  }
}

// Expose for the chat panel's 🧠 button (web/agent_chat.js).
window.agentYOpenMemoryViewer = openMemoryViewer;

// No ComfyUI-Settings row here: the button lives in the agentY Settings modal
// (web/agent_settings.js ▸ Viewers), and duplicating it under agentY ▸ Application
// meant two places to find the same thing. The extension is still registered so the
// module loads and the window.agentYOpen* global above is available to callers.
app.registerExtension({ name: "agentY.memoryViewer" });
