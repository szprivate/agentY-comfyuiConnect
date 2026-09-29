import { app } from "../../scripts/app.js";
import { backendBase } from "./agent_backend.js";

// agentY rating page launcher (/rate in the chat panel). The page is served by
// the agentY host (src/utils/agentY_server.py: GET /agentY/rate): it shows a few
// sibling renders from one output folder and the user clicks the best. Each pick
// goes to the preference log the fitness weights are fitted from.

async function openRating() {
  const base = backendBase();
  let up = false;
  try { up = (await fetch(base + "/agentY/health", { cache: "no-store" })).ok; } catch (_) {}
  if (up) {
    window.open(base + "/agentY/rate", "_blank", "noopener");
    return;
  }
  const w = window.open("", "_blank");
  if (w) {
    w.document.write(
      '<meta charset="utf-8"><title>agentY rating</title>' +
      '<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#15171c;' +
      'color:#e6e8ec;padding:44px;max-width:640px;margin:auto;line-height:1.6">' +
      "<h2 style=\"color:#6f97ff\">agentY host isn't reachable</h2>" +
      "<p>The rating page is served by the agentY chat host at <code>" + base +
      "</code>, which doesn't appear to be running right now. Start it, then type " +
      "<code>/rate</code> again.</p></body>");
    w.document.close();
  }
}

window.agentYOpenRating = openRating;

app.registerExtension({ name: "agentY.rating" });
