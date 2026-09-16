import { app } from "../../scripts/app.js";
import { backendBase } from "./agent_backend.js";
import { iconsReady, setButtonIcon, applyIcons } from "./agent_icons.js";

// agentY Application Settings — adds an entry to the ComfyUI Settings panel that
// opens a modal for editing the agent's auth keys (.env) and everything in
// config/settings.json. Reads/writes go through the agentY chat host
// (src/utils/agentY_server.py: GET/POST /agentY/settings). The settings.json
// save is comment-preserving (only changed leaves are rewritten).

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  if (props.style) Object.assign(n.style, props.style);
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
}

function isSecret(key) {
  return /KEY|TOKEN|SECRET|PASSWORD/i.test(key);
}

// Presentational grouping for the (otherwise flat) top-level settings.json leaves,
// so the modal reads as a few meaningful collapsible sections instead of one long
// list. Purely UI — keys stay flat in settings.json; anything not listed here falls
// into an "Other" group, and object-valued keys (llm, memory, …) become their own
// groups automatically.
// The panel, top to bottom. One entry per section, in the order shown.
//
// Sections are named for what someone is looking FOR, not for the shape of the
// settings file: the form is generated from TOML, so without this the headings
// are whatever a key happens to be called ("annotate", "refine", "qa") and the
// leftovers pile up under "Other". A heading nobody can decode is the same as no
// heading — they open all of them.
//
//   keys     flat top-level settings to show here
//   objects  nested groups, given as a settings path; each becomes a sub-group
//   inline   nested path whose leaves are shown directly, with no sub-heading
//   open     start expanded instead of collapsed
//   advanced hidden unless "Show advanced settings" is on
//
// Anything not claimed by a section still appears, under "Other" — a new setting
// must never become unreachable just because this list was not updated.
const SECTIONS = [
  // Models first and OPEN. It is the setting people come here to change, and it
  // used to be two collapsed levels down ("Models & providers" -> "Model tiers").
  { title: "Models", open: true, inline: ["llm", "tiers"],
    objects: [["llm", "pipeline"]] },
  { title: "Connections", keys: ["comfyui_url", "agent_server_url", "ollama_server_url"] },
  { title: "Canvas", keys: ["drop_outputs_into_canvas", "place_text_nodes_on_canvas",
                            "autoload_workflows_into_canvas",
                            "canvas_full_graph", "hook_tap_tensors", "hook_scoped_graph",
                            "comfyui_console_lines"] },
  { title: "Output checks", objects: [["qa"], ["refine"]] },
  { title: "Slack", inline: ["slack"] },
  { title: "Updates", keys: ["auto_update"] },
  // Not advanced. These decide who can reach the host, and someone who has just
  // read the startup warning should find them without checking a box first.
  { title: "Security", inline: ["security"] },
  { title: "Memory", inline: ["memory"], advanced: true },
  { title: "Providers", advanced: true,
    keys: [], objects: [["llm", "ollama"], ["llm", "anthropic"], ["llm", "dashscope"]],
    inlineExtra: ["llm"] },   // llm's own scalars (history_window, model hints)
  { title: "Files & logs", advanced: true,
    keys: ["comfyui_dir", "comfyui_models_dir", "comfyui_user_dir",
           "comfyui_custom_templates_dir", "output_dir", "output_workflows_dir",
           "conversation_db", "message_history_log", "tokens_usage_log"] },
  { title: "Prompts", inline: ["system_prompts"], advanced: true },
  { title: "Annotation", inline: ["annotate"], advanced: true },
];

// Per-key notes, for the few settings whose name does not carry the trade-off.
// The TOML comments never reach the browser, and this is the only place a switch
// can say what turning it on costs.
const KEY_NOTES = {
  canvas_full_graph:
    "Lets the agent see and edit EVERY node on the workflow you have open, not "
    + "just the ones you have selected — so \"set the sampler to 30 steps\" works "
    + "without you clicking the sampler first. Off (default) it sees only your "
    + "selection. The cost is tokens: the node list rides along on every canvas "
    + "turn whether or not the turn is about the graph (~250 for a 20-node "
    + "workflow, ~1.5k for 200). Worth it if you edit graphs by chatting; not if "
    + "you mostly generate.",
  drop_outputs_into_canvas:
    "Put every finished image or video on the canvas as a loader node pointing "
    + "at it, so a result is something you can wire straight into the next step "
    + "instead of a filename in the chat. Off keeps your graph clean when you are "
    + "generating in bulk — the files are written exactly the same either way, "
    + "and the chat names each one with its full path.",
  place_text_nodes_on_canvas:
    "When a text hook is answered, put the answer on the canvas as an \"agentY "
    + "text\" node you can read and wire. It is a visible copy and nothing more: "
    + "the hook stays wired exactly as you drew it and the answer is injected "
    + "into the graph at run time whether this is on or off, so a run behaves "
    + "identically either way. Turn it off on a canvas with many text hooks, "
    + "where a node per answer buries the chain that produced them — the answer "
    + "is still in the chat.",
  autoload_workflows_into_canvas:
    "Open the workflow the agent actually ran on the canvas, every run, so you "
    + "can see what it built rather than take its word for it. Off by default "
    + "because it replaces what you have open each time; the agent will still "
    + "show you a graph whenever you ask for one.",
  hook_tap_tensors:
    "Lets the agent LOOK at a hook anchored mid-graph. Wire an anchor to a "
    + "VAEDecode or an upscaler and its value is a tensor with no file anywhere, "
    + "so there is nothing to open — with this on, that wire is rendered to a "
    + "temp file before the turn starts. Only the anchor's ancestors run and an "
    + "already-executed graph comes from ComfyUI's cache, but on a cold graph you "
    + "do pay for one upstream render.",
  hook_scoped_graph:
    "Run only the part of your canvas the hooks actually reach — everything "
    + "downstream of a hook plus whatever those nodes need as input. Unrelated "
    + "branches are left out instead of being run on every hook. A muted or "
    + "bypassed hook drops its branch too. Off runs the whole canvas each time.",
  comfyui_console_lines:
    "Relay ComfyUI's own terminal output — model loads, warnings, whatever a node "
    + "prints — into the run stream while the queue is running. It is what tells "
    + "you a two-minute pause is a 25 GB checkpoint staging rather than a wedge. "
    + "Only finished lines: tqdm's redrawing progress bar is left out, since the "
    + "run already draws one.",
  api_key_max_age_days:
    "Warn at startup when a key in .env has been in place this long. A key does "
    + "not expire on its own, so a copy taken today still works next year — "
    + "rotating on a clock is the only defence that does not depend on noticing "
    + "a leak. Pasting a new value restarts the clock by itself; there is nothing "
    + "to acknowledge. 0 turns the warning off.",
  check_origin:
    "Refuse requests from pages other than the agentY panel. Leave this on. With "
    + "it off, any website you have open in any tab can drive the agent and read "
    + "your API keys — a local server is reachable from the whole web, it is just "
    + "not reachable BY the whole web without this.",
  require_token:
    "Require the session token the host mints at each start. The panel gets it "
    + "from ComfyUI automatically. This is the check that stops a script or "
    + "another machine, which has no browser to be honest about where it came "
    + "from. Turn it off only to get back into a panel that will not connect.",
  allowed_origins:
    "Extra origins that may call the host, e.g. [\"http://studio.local:8188\"]. "
    + "Only needed when the panel is served from an address the host cannot work "
    + "out for itself.",
  allowed_hosts:
    "Extra names this host may be addressed by. Anything that is not an IP "
    + "address or \"localhost\" is refused, because a name pointed at 127.0.0.1 is "
    + "how DNS rebinding reaches a local server. Add your machine's real name "
    + "here if you use it.",
};

function injectStyles() {
  if (document.getElementById("agentY-settings-styles")) return;
  const css = `
  /* The long-term memory viewer's dark palette and cards, as in the side panel
     (agent_chat.js): a surface, a hairline border, a 4px accent edge on each group. */
  .ays-overlay{position:fixed;inset:0;background:rgba(8,9,12,.6);z-index:10000;display:flex;
    align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;}
  .ays-card{background:#15171c;color:#e6e8ec;border:1px solid #2c313b;border-radius:9px;
    width:min(720px,92vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.6);overflow:hidden;}
  .ays-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #2c313b;background:#1e2128;}
  .ays-head h2{font-size:15px;margin:0;font-weight:650;flex:1;}
  .ays-body{padding:14px 18px;overflow:auto;}
  .ays-body::-webkit-scrollbar{width:8px;}
  .ays-body::-webkit-scrollbar-thumb{background:#262b34;border-radius:8px;}
  .ays-foot{display:flex;gap:10px;justify-content:flex-end;padding:12px 18px;border-top:1px solid #2c313b;background:#1e2128;}
  .ays-sec{margin-bottom:18px;}
  .ays-sec>h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#9aa0aa;margin:0 0 8px;}
  .ays-row{display:flex;align-items:center;gap:10px;padding:4px 0;}
  /* A setting and its explanation are one block: the note sits right under the
     control it explains, lined up with it, and the space goes BETWEEN settings. */
  .ays-field .ays-row{padding:3px 0;}
  .ays-field .ays-keynote{margin:0 0 0 calc(42% + 10px);}
  .ays-field.ays-hasnote{margin:12px 0;}
  .ays-label{flex:0 0 42%;font-size:12.5px;color:#c3c8d0;word-break:break-word;font-family:ui-monospace,monospace;}
  .ays-input{flex:1;min-width:0;background:#161a20;color:#e6e8ec;border:1px solid #2c313b;
    border-radius:7px;padding:6px 9px;font-size:12.5px;outline:none;}
  .ays-input:focus{border-color:#6f97ff;}
  input.ays-input[type=checkbox]{flex:0 0 auto;width:16px;height:16px;accent-color:#6f97ff;}
  .ays-group{background:#1e2128;border:1px solid #2c313b;border-left:4px solid #6f97ff;border-radius:9px;margin:8px 0;overflow:hidden;}
  /* One edge colour per subject (see GROUP_FAMILY), so sections that belong
     together look like it and the panel sorts itself at a glance. */
  .ays-group[data-family="models"]{border-left-color:#b48ce3;}
  .ays-group[data-family="connections"]{border-left-color:#4fc3c3;}
  .ays-group[data-family="canvas"]{border-left-color:#7bd88f;}
  .ays-group[data-family="checks"]{border-left-color:#e5c07b;}
  .ays-group[data-family="integrations"]{border-left-color:#6f97ff;}
  .ays-group[data-family="memory"]{border-left-color:#d68ab0;}
  .ays-group[data-family="safety"]{border-left-color:#e5736f;}
  .ays-group[data-family="other"]{border-left-color:#6b7280;}
  .ays-grouphead{background:#1e2128;padding:7px 12px;font-size:12px;font-weight:600;color:#e6e8ec;
    font-family:ui-monospace,monospace;cursor:pointer;}
  .ays-grouphead:hover{background:#262b34;}
  .ays-groupbody{padding:6px 12px;border-top:1px solid #2c313b;}
  .ays-btn{background:#1e2128;color:#e6e8ec;border:1px solid #2c313b;border-radius:7px;
    padding:8px 16px;cursor:pointer;font-size:12.5px;}
  .ays-btn:hover{border-color:#6f97ff;}
  .ays-btn.ay-icon-btn{display:inline-flex;align-items:center;gap:8px;}
  .ays-btn.ay-icon-btn svg{width:16px;height:16px;display:block;flex-shrink:0;}
  .ays-btn.primary{background:#6f97ff;color:#fff;border-color:#6f97ff;font-weight:650;}
  .ays-btn.primary:hover{background:#5c86f2;}
  .ays-note{font-size:11.5px;color:#9aa0aa;margin:2px 0 10px;}
  .ays-msg{font-size:12px;margin-right:auto;align-self:center;}
  .ays-card [hidden]{display:none !important;}
  .ays-err{color:#e5736f;}
  .ays-btn.ays-sm{padding:5px 10px;font-size:12px;}
  .ays-btn.ays-x{padding:5px 9px;color:#9aa0aa;}
  .ays-btn.ays-x:hover{color:#e5736f;border-color:#e5736f;}
  /* Model pricing: model | input | output | remove. */
  .ays-ptable{display:flex;flex-direction:column;gap:6px;margin:6px 0 10px;}
  .ays-prow{display:grid;grid-template-columns:minmax(0,1fr) 110px 110px 34px;gap:8px;align-items:center;}
  .ays-phead{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9aa0aa;}
  .ays-prow input[type=number]::placeholder{color:#5d6470;}
  /* MCP servers: one card per server, details folded until Edit. */
  .ays-mcplist{display:flex;flex-direction:column;gap:8px;margin:6px 0 10px;}
  .ays-mcp{background:#161a20;border:1px solid #2c313b;border-left:4px solid #6f97ff;border-radius:9px;overflow:hidden;}
  .ays-mcphead{display:flex;align-items:center;gap:8px;padding:7px 10px;flex-wrap:wrap;}
  .ays-mcpname{font-family:ui-monospace,monospace;font-size:12.5px;font-weight:600;}
  input.ays-input.ays-mcpname{flex:0 0 150px;}
  .ays-mcpsum{color:#9aa0aa;font-size:11.5px;}
  .ays-chip{margin-left:auto;background:#262b34;border-radius:999px;padding:1px 9px;font-size:11px;color:#c3c8d0;}
  .ays-mcpbody{padding:6px 12px 10px;border-top:1px solid #2c313b;}
  .ays-code{width:100%;min-height:90px;font-family:ui-monospace,monospace;white-space:pre;box-sizing:border-box;}
  .ays-adv{margin:6px 0;}
  .ays-adv>summary{cursor:pointer;font-size:11.5px;color:#9aa0aa;margin-bottom:4px;}
  .ays-mcpadd{background:#161a20;border:1px dashed #3a4150;border-radius:9px;padding:10px 12px;margin:8px 0;}
  .ays-input.ays-missing{border-color:#e5c07b;}
  .ays-warn{color:#e5c07b;}
  /* Installing a bundle (.mcpb). */
  .ays-bundlehead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;}
  .ays-bundlecmd{margin:2px 0 8px;padding:6px 8px;background:#15171c;border:1px solid #2c313b;border-radius:7px;
    font-family:ui-monospace,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all;color:#c3c8d0;}
  .ays-pathpick{flex:1;display:flex;gap:6px;min-width:0;align-items:flex-start;}
  .ays-pathpick .ays-input{flex:1;min-width:0;}
  .ays-fieldnote{margin:-2px 0 6px calc(42% + 10px);}
  .ays-btnrow{display:flex;gap:8px;flex-wrap:wrap;}
  `;
  document.head.append(el("style", { id: "agentY-settings-styles", textContent: css }));
}

function buildModelSelect(groups, current, inheritable) {
  const sel = el("select", { className: "ays-input" });
  let matched = false;
  if (inheritable) {
    const o = el("option", { value: "", textContent: INHERIT_LABEL });
    if (!current) { o.selected = true; matched = true; }
    sel.append(o);
  }
  for (const [group, models] of Object.entries(groups || {})) {
    if (!models || !models.length) continue;
    const og = el("optgroup", { label: group });
    for (const [spec, label] of models) {
      const o = el("option", { value: spec, textContent: label });
      if (spec === current) { o.selected = true; matched = true; }
      og.append(o);
    }
    sel.append(og);
  }
  // Keep the current value selectable even if no vendor advertises it.
  if (!matched && current) {
    const o = el("option", { value: current, textContent: current + "  (current)" });
    o.selected = true;
    sel.insertBefore(o, sel.firstChild);
  }
  return sel;
}

// Display names for settings keys that read badly as-is. The form is generated
// from the settings file, so without this the UI is stuck with whatever the TOML
// key is called — "pipeline" for what is really "which model does which job".
const GROUP_LABELS = {
  pipeline: "Per-role overrides",
  qa: "Checking finished outputs",
  refine: "Refine loops",
  embedder: "Embedder",
  ollama: "Ollama",
  anthropic: "Anthropic",
  dashscope: "DashScope (Qwen)",
  llm: "Memory writer",   // memory.llm — the only `llm` still shown as a group
  pricing: "Model pricing",
  mcp: "MCP servers",
};

// Which sections are advanced now lives on the section itself (see SECTIONS),
// so a heading and its visibility cannot drift apart.

// Per-role model rows: an empty value means INHERIT from the role's tier, so the
// dropdown needs a real option for it rather than looking unset.
const INHERIT_LABEL = "— inherit from tier —";

// Friendly names for the tier rows, served by /agentY/settings so the mapping
// lives in one place (src/agent.py) rather than being duplicated here.
let TIER_LABELS = {};

// One-line explanations for groups whose keys don't speak for themselves. The form
// is generated from the settings file, so there is nowhere else to say what a
// section is FOR — the TOML comments never reach the browser.
const GROUP_NOTES = {
  pricing: "What each model costs, in USD per million tokens, so Token usage matches "
    + "your bill. Pick the model from the list your providers report; a blank price "
    + "uses the built-in one shown greyed out. Saved to config/pricing.json.",
  mcp: "External MCP servers whose tools the orchestrator can call. Add one by "
    + "pasting its address, its start command or its JSON config, or install a bundle "
    + "(.mcpb) file; Test connects once and lists the tools. Keys go to .env, never into "
    + "config/mcp.json. Servers load into the orchestrator on the next agent start.",
  qa: "Checks finished images/videos against a QA briefing — an `agentY hook` with "
    + "purpose \"qa\", a named file in briefing_dir, or /qa in the chat. With no "
    + "briefing nothing here runs. max_retries 0 reports the verdict without "
    + "re-generating; the judging model is the \"QA judge\" tier under "
    + "Models.",
  refine: "A refine loop is the agent running the workflow you have OPEN, judging "
    + "each output against a condition you stated, changing one value and going "
    + "again — “change the prompt until she is standing where she is in the "
    + "reference”. Every run is a real generation, so max_runs is a spend "
    + "ceiling: the agent may ask for fewer runs, never more. It judges with the "
    + "“QA judge” tier under Models.",
  tiers: "Every role takes its model from one of these six. Set them and you are "
    + "done — per-role overrides below are for the exceptions.",
  pipeline: "Leave a role blank to inherit from its tier. Fill one in only when "
    + "that single job wants a different model from the rest of its tier.",
  memory: "Long-term memory. The store is always local FAISS. The two models here "
    + "are NOT interchangeable: the EMBEDDER turns text into vectors so memories "
    + "can be searched by meaning (an embedding model does only this — it cannot "
    + "write text, and a chat model cannot embed), while the LLM rewrites memories "
    + "in its own words and is only used for `infer` writes. Leave the llm model "
    + "blank and it follows the Fast utility tier, endpoint and key included.",
  embedder: "Blank api_key_env falls back to the provider's usual variable. "
    + "Changing the model or embedding_dims invalidates the FAISS index on disk.",
  slack: "A SECOND way in, alongside this panel — never instead of it. Every turn "
    + "is mirrored to your Slack DM as it runs, INCLUDING the ones you start here, "
    + "so you can queue a render at the desk and watch it finish from a phone; a DM "
    + "back drives the same conversation this panel is in. Needs a Slack app of your "
    + "own: put its bot token (xoxb-…), an app-level token with connections:write "
    + "(xapp-…) and your Slack member id in Authentication above, then turn `enabled` "
    + "on — it takes effect on the next agent start. The connection is outbound "
    + "(Socket Mode), so nothing here has to be reachable from the internet. "
    + "SLACK_ALLOWED_USERS is not optional: empty means every message is refused, "
    + "because anyone who can DM the bot could otherwise run generations and tools "
    + "on this machine. Full walkthrough in docs/slack.md.",
};

// What a section is ABOUT, which decides its edge colour. Sections that mean the
// same kind of thing share one — the models live with the per-role overrides, the
// providers and their prices; memory with its writer and embedder — so the panel
// reads as a handful of subjects rather than eleven identically blue boxes. Keyed
// by section title or, for a nested group, by its settings key.
const GROUP_FAMILY = {
  models: "models", "per-role overrides": "models", providers: "models", pipeline: "models",
  ollama: "models", anthropic: "models", dashscope: "models", pricing: "models",
  connections: "connections", "files & logs": "connections", prompts: "connections",
  system_prompts: "connections",
  canvas: "canvas", annotation: "canvas", annotate: "canvas",
  "output checks": "checks", qa: "checks", refine: "checks",
  slack: "integrations", mcp: "integrations",
  memory: "memory", embedder: "memory", llm: "memory",   // memory.llm = the memory writer
  security: "safety", updates: "safety",
};

// A collapsible group, COLLAPSED by default (item 2: settings start folded).
function makeCollapsibleGroup(key, suffix, open) {
  const title = (GROUP_LABELS[key] || key) + (suffix || "");
  const body = el("div", { className: "ays-groupbody",
                           style: { display: open ? "" : "none" } });
  const head = el("div", { className: "ays-grouphead",
                           textContent: (open ? "▾ " : "▸ ") + title });
  head.addEventListener("click", () => {
    const hidden = body.style.display === "none";
    body.style.display = hidden ? "" : "none";
    head.textContent = (hidden ? "▾ " : "▸ ") + title;
  });
  const note = GROUP_NOTES[key];
  if (note) body.append(el("div", { className: "ays-note", textContent: note }));
  const group = el("div", { className: "ays-group" }, [head, body]);
  group.dataset.family = GROUP_FAMILY[String(key).trim().toLowerCase()] || "other";
  return { group, body };
}

// Render one leaf setting (scalar / array / model-select) as a labelled row and
// register its ref for save-time collection.
function renderLeafRow(container, key, val, path, modelGroups, refs) {
  // A switch whose name does not carry its trade-off gets the trade-off written
  // out. Hovering is not discovery: nobody hovers a setting they have not already
  // decided to think about. The note goes UNDER its own row, inside one block with
  // it: above the row it read as a footnote to the setting before it.
  const field = el("div", { className: "ays-field" });
  const row = el("div", { className: "ays-row" });
  row.append(el("label", { className: "ays-label", textContent: key }));
  let input;
  // Both llm.tiers.* and llm.pipeline.* are model choices; only the per-role
  // overrides may be left blank to inherit.
  const isOverride = path[0] === "llm" && path[1] === "pipeline";
  const underPipeline = isOverride || (path[0] === "llm" && path[1] === "tiers");
  const label = row.firstChild;
  if (path[0] === "llm" && path[1] === "tiers" && TIER_LABELS[key]) {
    label.textContent = TIER_LABELS[key];
    label.title = key;
  }
  if (typeof val === "boolean") {
    input = el("input", { type: "checkbox", className: "ays-input" });
    input.checked = val;
    refs.push({ path, get: () => input.checked });
  } else if (typeof val === "number") {
    input = el("input", { type: "number", className: "ays-input", value: String(val) });
    refs.push({ path, get: () => { const n = Number(input.value); return Number.isNaN(n) ? val : n; } });
  } else if (Array.isArray(val)) {
    input = el("input", { type: "text", className: "ays-input", value: JSON.stringify(val) });
    refs.push({ path, get: () => { try { return JSON.parse(input.value); } catch (_) { return val; } } });
  } else if (underPipeline && modelGroups && Object.keys(modelGroups).length) {
    input = buildModelSelect(modelGroups, val == null ? "" : String(val), isOverride);
    refs.push({ path, get: () => input.value });
  } else {
    input = el("input", { type: "text", className: "ays-input", value: val == null ? "" : String(val) });
    refs.push({ path, get: () => input.value });
  }
  row.append(input);
  field.append(row);
  if (KEY_NOTES[key]) {
    field.classList.add("ays-hasnote");
    field.append(el("div", { className: "ays-note ays-keynote", textContent: KEY_NOTES[key] }));
  }
  container.append(field);
}

// Recursively render a settings object: nested objects become collapsed groups,
// leaves become rows. Used for group bodies (llm, memory, …) below the top level.
function buildSettingsForm(container, obj, modelGroups, pathPrefix, refs) {
  for (const [key, val] of Object.entries(obj)) {
    const path = pathPrefix.concat(key);
    if (val && typeof val === "object" && !Array.isArray(val)) {
      // "Per-role overrides (2 set)" — otherwise a collapsed group gives no hint
      // that something in it is quietly winning over the tier above.
      let suffix = "";
      if (key === "pipeline") {
        const n = Object.values(val).filter((v) => String(v || "").trim()).length;
        suffix = n ? `  (${n} set)` : "  (all inherit)";
      }
      const { group, body } = makeCollapsibleGroup(key, suffix);
      container.append(group);
      buildSettingsForm(body, val, modelGroups, path, refs);
    } else {
      renderLeafRow(container, key, val, path, modelGroups, refs);
    }
  }
}

// Top-level render: walk SECTIONS in order, then sweep up anything they did not
// claim so a new setting is never silently unreachable.
function pathValue(settings, path) {
  let node = settings;
  for (const step of path) {
    if (!node || typeof node !== "object") return null;
    node = node[step];
  }
  return node && typeof node === "object" && !Array.isArray(node) ? node : null;
}

function buildTopLevelSettings(container, settings, modelGroups, refs) {
  const claimedScalars = new Set();
  const claimedObjects = new Set();      // joined settings paths, e.g. "llm.tiers"

  for (const section of SECTIONS) {
    const { group, body } = makeCollapsibleGroup(section.title, "", !!section.open);
    let wrote = false;

    // Flat top-level keys.
    for (const k of (section.keys || [])) {
      if (!(k in settings) || settings[k] === null) continue;
      if (settings[k] && typeof settings[k] === "object" && !Array.isArray(settings[k])) continue;
      renderLeafRow(body, k, settings[k], [k], modelGroups, refs);
      claimedScalars.add(k);
      wrote = true;
    }

    // A nested group shown WITHOUT its own heading — the section heading is
    // already the name for it, and a lone sub-heading inside a section is a
    // click that reveals one more click.
    for (const inlinePath of [section.inline, ...(section.inlineExtra ? [section.inlineExtra] : [])]) {
      if (!inlinePath) continue;
      const obj = pathValue(settings, inlinePath);
      if (!obj) continue;
      const note = GROUP_NOTES[inlinePath[inlinePath.length - 1]];
      if (note) body.append(el("div", { className: "ays-note", textContent: note }));
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === "object" && !Array.isArray(v)) continue;  // handled below
        renderLeafRow(body, k, v, inlinePath.concat(k), modelGroups, refs);
        wrote = true;
      }
      // An inlined group's own sub-groups still need somewhere to go. Without
      // this, `memory.embedder` and `memory.llm` were rendered nowhere at all —
      // and the leftover sweep could not save them either, because it only
      // looks at the top level and `memory` counted as claimed.
      for (const [k, v] of Object.entries(obj)) {
        if (!(v && typeof v === "object" && !Array.isArray(v))) continue;
        const childPath = inlinePath.concat(k);
        if (claimedObjects.has(childPath.join("."))) continue;
        if ((section.objects || []).some((o) => o.join(".") === childPath.join("."))) continue;
        const sub = makeCollapsibleGroup(k, "", false);
        body.append(sub.group);
        buildSettingsForm(sub.body, v, modelGroups, childPath, refs);
        claimedObjects.add(childPath.join("."));
        wrote = true;
      }
      claimedObjects.add(inlinePath.join("."));
    }

    // Nested groups that keep their own collapsible heading.
    for (const objPath of (section.objects || [])) {
      const obj = pathValue(settings, objPath);
      if (!obj) continue;
      const key = objPath[objPath.length - 1];
      let suffix = "";
      if (key === "pipeline") {
        const n = Object.values(obj).filter((v) => String(v || "").trim()).length;
        suffix = n ? `  (${n} set)` : "  (all inherit)";
      }
      const sub = makeCollapsibleGroup(key, suffix, false);
      body.append(sub.group);
      buildSettingsForm(sub.body, obj, modelGroups, objPath, refs);
      claimedObjects.add(objPath.join("."));
      wrote = true;
    }

    if (!wrote) continue;                       // nothing to show; no empty heading
    if (section.advanced) group.dataset.advanced = "1";
    container.append(group);
  }

  // Whatever no section claimed. Advanced, because a setting nobody has sorted
  // yet is by definition not one of the first things to reach for — but present,
  // so it can still be found and changed.
  const leftoverScalars = Object.entries(settings).filter(
    ([k, v]) => !claimedScalars.has(k)
      && !(v && typeof v === "object" && !Array.isArray(v)));
  const leftoverObjects = Object.entries(settings).filter(
    ([k, v]) => v && typeof v === "object" && !Array.isArray(v)
      && !claimedObjects.has(k)
      && ![...claimedObjects].some((c) => c.startsWith(k + ".")));
  if (leftoverScalars.length || leftoverObjects.length) {
    const { group, body } = makeCollapsibleGroup("Other", "", false);
    group.dataset.advanced = "1";
    for (const [k, v] of leftoverScalars) renderLeafRow(body, k, v, [k], modelGroups, refs);
    for (const [k, v] of leftoverObjects) {
      const sub = makeCollapsibleGroup(k, "", false);
      body.append(sub.group);
      buildSettingsForm(sub.body, v, modelGroups, [k], refs);
    }
    container.append(group);
  }
}

// Reassemble the nested settings object from the collected leaf refs.
function collectSettings(refs) {
  const out = {};
  for (const { path, get } of refs) {
    let node = out;
    for (let i = 0; i < path.length - 1; i++) {
      node[path[i]] = node[path[i]] || {};
      node = node[path[i]];
    }
    node[path[path.length - 1]] = get();
  }
  return out;
}

// ── model pricing card ──────────────────────────────────────────────────────
// A table instead of a JSON box: model (from the providers' own model lists),
// input and output price per million tokens, add and remove. Saved as
// config/pricing.json in its existing shape; the "_comment" and "provider_defaults"
// it already has are carried over untouched.
const bareModelId = (spec) => String(spec || "").split(",").pop().trim();

function buildPricingCard(data) {
  const current = data.pricing && typeof data.pricing === "object" && !Array.isArray(data.pricing)
    ? data.pricing : {};
  const saved = current.models && typeof current.models === "object" ? current.models : {};
  const builtin = data.pricing_builtin || {};
  // The LLMs the agent runs on, as each cloud provider lists them. Ollama is left
  // out: a local model costs nothing per token.
  const groups = Object.fromEntries(Object.entries(data.model_groups || {})
    .filter(([vendor]) => !/ollama/i.test(vendor)));
  const { group, body } = makeCollapsibleGroup("pricing", "", false);
  const listed = new Set();
  for (const models of Object.values(groups)) {
    for (const item of Array.isArray(models) ? models : []) listed.add(bareModelId(item[0]));
  }

  const table = el("div", { className: "ays-ptable" }, [
    el("div", { className: "ays-prow ays-phead" }, [
      el("span", { textContent: "Model" }), el("span", { textContent: "Input $ / 1M" }),
      el("span", { textContent: "Output $ / 1M" }), el("span")]),
  ]);
  const rows = [];
  const addRow = (id, prices) => {
    const sel = el("select", { className: "ays-input" });
    sel.append(el("option", { value: "", textContent: "— choose a model —" }));
    for (const [vendor, models] of Object.entries(groups)) {
      if (!Array.isArray(models) || !models.length) continue;
      const og = el("optgroup", { label: vendor });
      for (const [spec, label] of models) {
        const mid = bareModelId(spec);
        og.append(el("option", { value: mid, textContent: label && label !== mid ? `${label} · ${mid}` : mid }));
      }
      sel.append(og);
    }
    // A price for a model no provider lists right now (an old snapshot, a key that
    // is not set here) stays in the table rather than silently disappearing.
    if (id && !listed.has(id)) {
      sel.append(el("optgroup", { label: "Not listed by a provider right now" },
        [el("option", { value: id, textContent: id })]));
    }
    sel.value = id || "";
    const num = (v) => el("input", { className: "ays-input", type: "number", min: "0", step: "any",
                                     value: v == null ? "" : String(v) });
    const inp = num(prices && prices.in);
    const outp = num(prices && prices.out);
    const hint = () => {
      const b = builtin[sel.value];
      inp.placeholder = b ? String(b.in) : "";
      outp.placeholder = b ? String(b.out) : "";
      inp.title = outp.title = b ? "Blank uses the built-in price shown" : "";
    };
    sel.addEventListener("change", hint);
    hint();
    const del = el("button", { className: "ays-btn ays-x", textContent: "✕", title: "Remove this price" });
    const row = el("div", { className: "ays-prow" }, [sel, inp, outp, del]);
    const entry = { sel, inp, outp };
    del.addEventListener("click", (e) => { e.preventDefault(); row.remove(); rows.splice(rows.indexOf(entry), 1); });
    rows.push(entry);
    table.append(row);
  };
  for (const [id, prices] of Object.entries(saved)) addRow(id, prices || {});
  const addBtn = el("button", { className: "ays-btn", textContent: "+ Add model price" });
  addBtn.addEventListener("click", (e) => { e.preventDefault(); addRow("", {}); });
  const err = el("div", { className: "ays-note ays-err" });
  body.append(table, addBtn, err);

  let baseline = JSON.stringify(saved);
  const collect = () => {
    const models = {};
    const seen = new Set();
    for (const { sel, inp, outp } of rows) {
      const id = sel.value.trim();
      if (!id) continue;
      if (seen.has(id.toLowerCase())) return { error: `${id} is in the table twice. Keep one row per model.` };
      seen.add(id.toLowerCase());
      const read = (input) => (input.value.trim() === "" ? null : Number(input.value));
      let pin = read(inp);
      let pout = read(outp);
      if (pin === null && pout === null) continue;   // nothing set: the built-in price applies
      const b = builtin[id] || {};
      if (pin === null) pin = b.in ?? null;
      if (pout === null) pout = b.out ?? null;
      if (pin === null || pout === null) {
        return { error: `Set both prices for ${id}; there is no built-in price to fall back on.` };
      }
      if (!Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0) {
        return { error: `Prices for ${id} must be numbers of 0 or more.` };
      }
      models[id] = { in: pin, out: pout };
    }
    return {
      payload: { ...current, models, provider_defaults: current.provider_defaults || {} },
      changed: JSON.stringify(models) !== baseline,
    };
  };
  const markSaved = () => {
    const c = collect();
    if (c.payload) baseline = JSON.stringify(c.payload.models);
  };
  return { group, err, collect, markSaved };
}

// ── MCP servers card ────────────────────────────────────────────────────────
// Adding a server means pasting what its page says (address, start command or
// JSON block); the host turns that into an entry and splits any key out for .env
// (POST /agentY/mcp/parse). Each server is then a small form: address or command,
// connection type, sign-in, and a password field for every ${VAR} it references.
// Test connects once from the form as it stands (POST /agentY/mcp/test).
const MCP_AUTH_LABELS = { none: "No sign-in", apikey: "API key", oauth: "Browser sign-in (OAuth)" };

function splitCommand(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || "")))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function joinCommand(command, args) {
  return [command, ...(args || [])].filter((a) => a != null && a !== "")
    .map((a) => (/\s/.test(String(a)) ? `"${a}"` : String(a))).join(" ");
}

function envRefs(obj) {
  const refs = [];
  for (const value of Object.values(obj || {})) {
    for (const m of String(value).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      if (!refs.includes(m[1])) refs.push(m[1]);
    }
  }
  return refs;
}

const formatSize = (bytes) => {
  const n = Number(bytes) || 0;
  return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};

const mcpKeyVar = (name) => `MCP_${String(name || "SERVER").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

async function postJson(path, payload) {
  const r = await fetch(backendBase() + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  try {
    return await r.json();
  } catch (_) {
    return { ok: false, error: `the agentY host answered ${r.status}; restart it to load this version` };
  }
}

function buildMcpCard(mcpData, envSet) {
  const servers = (mcpData.config && mcpData.config.servers) || {};
  const status = mcpData.status || {};
  const { group, body } = makeCollapsibleGroup("mcp", "", false);
  const list = el("div", { className: "ays-mcplist" });
  const err = el("div", { className: "ays-note ays-err" });
  const rows = [];

  const addRow = (name, sc, opts = {}) => {
    const original = { ...(sc || {}) };
    let isNew = !!opts.isNew;
    const pasted = opts.secrets || {};
    const headers = { ...(original.headers || {}) };
    const fixedKeyVar = envRefs(headers)[0] || "";
    let mode = String(original.auth || "none").toLowerCase() === "oauth" ? "oauth"
      : (fixedKeyVar ? "apikey" : "none");
    // The header the API-key choice writes is shown as that choice, not as JSON.
    if (fixedKeyVar && headers.Authorization === `Bearer \${${fixedKeyVar}}`) delete headers.Authorization;
    const extra = {};
    if (Object.keys(headers).length) extra.headers = headers;
    if (original.env && Object.keys(original.env).length) extra.env = original.env;

    const enabled = el("input", { type: "checkbox", checked: original.enabled !== false,
                                  title: "Load this server's tools" });
    const nameEl = isNew
      ? el("input", { className: "ays-input ays-mcpname", value: name, title: "Its tools appear as <name>_<tool>" })
      : el("span", { className: "ays-mcpname", textContent: name });
    const summary = el("span", { className: "ays-mcpsum" });
    const state = el("span", { className: "ays-chip" });
    const testBtn = el("button", { className: "ays-btn ays-sm", textContent: "Test" });
    const authBtn = el("button", { className: "ays-btn ays-sm", textContent: "Authorize…" });
    const editBtn = el("button", { className: "ays-btn ays-sm", textContent: isNew ? "Hide" : "Edit" });
    const delBtn = el("button", { className: "ays-btn ays-sm ays-x", textContent: "✕", title: "Remove this server" });
    const head = el("div", { className: "ays-mcphead" },
      [enabled, nameEl, summary, state, testBtn, authBtn, editBtn, delBtn]);

    const typeSel = el("select", { className: "ays-input" }, [
      el("option", { value: "http", textContent: "HTTP (streamable)" }),
      el("option", { value: "sse", textContent: "SSE" }),
      el("option", { value: "stdio", textContent: "Local command (stdio)" }),
    ]);
    const transport = String(original.transport || (original.command ? "stdio" : "http")).toLowerCase();
    typeSel.value = transport === "sse" || transport === "stdio" ? transport : "http";
    const addr = el("input", { className: "ays-input",
      value: typeSel.value === "stdio" ? joinCommand(original.command, original.args) : (original.url || "") });
    const addrLabel = el("label", { className: "ays-label" });
    const authSel = el("select", { className: "ays-input" });
    const adv = el("textarea", { className: "ays-input ays-code", spellcheck: false,
      value: Object.keys(extra).length ? JSON.stringify(extra, null, 2) : "",
      placeholder: '{"headers": {"X-Api-Key": "${MY_KEY}"}, "env": {"TOKEN": "${MY_TOKEN}"}}' });
    const secretWrap = el("div", {});
    const secretInputs = {};
    const result = el("div", { className: "ays-note", textContent: (opts.notes || []).join(" ") });
    const details = el("div", { className: "ays-mcpbody" }, [
      el("div", { className: "ays-row" }, [addrLabel, addr]),
      el("div", { className: "ays-row" }, [el("label", { className: "ays-label", textContent: "Connection" }), typeSel]),
      el("div", { className: "ays-row" }, [el("label", { className: "ays-label", textContent: "Sign-in" }), authSel]),
      secretWrap,
      el("details", { className: "ays-adv" }, [el("summary", { textContent: "Headers & environment (JSON, advanced)" }), adv]),
      result,
    ]);
    details.hidden = !isNew;
    const card = el("div", { className: "ays-mcp" }, [head, details]);

    const currentName = () => (isNew ? nameEl.value.trim() : name);
    const readExtra = () => { const t = adv.value.trim(); return t ? JSON.parse(t) : {}; };
    const safeExtra = () => { try { return readExtra(); } catch (_) { return {}; } };
    const apiVar = () => envRefs(safeExtra().headers)[0] || fixedKeyVar || mcpKeyVar(currentName());

    const renderAuthChoices = () => {
      const keep = authSel.value || mode;
      authSel.textContent = "";
      const choices = typeSel.value === "stdio" ? ["none"] : ["none", "apikey", "oauth"];
      for (const c of choices) authSel.append(el("option", { value: c, textContent: MCP_AUTH_LABELS[c] }));
      authSel.value = choices.includes(keep) ? keep : "none";
    };
    // One password field per variable the server needs: the API key, and every
    // ${VAR} in its headers or environment.
    const renderSecrets = () => {
      const ex = safeExtra();
      const vars = [];
      const push = (v) => { if (v && !vars.includes(v)) vars.push(v); };
      if (typeSel.value !== "stdio" && authSel.value === "apikey") push(apiVar());
      if (typeSel.value !== "stdio") envRefs(ex.headers).forEach(push);
      if (typeSel.value === "stdio") {
        envRefs(ex.env).forEach(push);
        envRefs({ command: addr.value }).forEach(push);   // a bundle can put a key in its arguments
      }
      secretWrap.textContent = "";
      for (const v of vars) {
        if (!secretInputs[v]) {
          secretInputs[v] = el("input", { className: "ays-input", type: "password", value: pasted[v] || "" });
          secretInputs[v].addEventListener("input", () => { paintSecret(v); paintHead(); });
        }
        paintSecret(v);
        secretWrap.append(el("div", { className: "ays-row" }, [
          el("label", { className: "ays-label", textContent: v === apiVar() && authSel.value === "apikey" ? `API key (${v})` : v }),
          secretInputs[v]]));
      }
    };
    const paintSecret = (v) => {
      const input = secretInputs[v];
      const stored = envSet.has(v);
      input.placeholder = stored ? "saved in .env — type to replace" : "needs a value";
      input.classList.toggle("ays-missing", !stored && !input.value);
    };

    const build = () => {
      const nm = currentName();
      if (!/^[a-z0-9_]+$/.test(nm)) return { error: "the name may use lowercase letters, digits and _" };
      let ex;
      try { ex = readExtra(); } catch (_) { return { error: "Headers & environment is not valid JSON" }; }
      const sc = { enabled: enabled.checked, transport: typeSel.value };
      if (typeSel.value === "stdio") {
        const parts = splitCommand(addr.value);
        if (!parts.length) return { error: "needs the command that starts it" };
        sc.command = parts[0];
        sc.args = parts.slice(1);
      } else {
        const url = addr.value.trim();
        if (!/^https?:\/\/\S+$/i.test(url)) return { error: "needs an http(s) address" };
        sc.url = url;
      }
      const hdrs = { ...((ex && ex.headers) || {}) };
      if (typeSel.value !== "stdio" && authSel.value === "apikey" && !envRefs(hdrs).length) {
        hdrs.Authorization = `Bearer \${${apiVar()}}`;
      }
      sc.auth = authSel.value === "oauth" ? "oauth" : (Object.keys(hdrs).length && typeSel.value !== "stdio" ? "header" : "none");
      if (typeSel.value !== "stdio" && Object.keys(hdrs).length) sc.headers = hdrs;
      if (typeSel.value === "stdio" && ex && ex.env && Object.keys(ex.env).length) sc.env = ex.env;
      // Keys the form does not show (redirect_port, …) stay as they were.
      for (const [k, v] of Object.entries(original)) {
        if (!["enabled", "transport", "url", "command", "args", "auth", "headers", "env"].includes(k)) sc[k] = v;
      }
      const secrets = {};
      for (const [v, input] of Object.entries(secretInputs)) {
        if (input.isConnected && input.value) secrets[v] = input.value;
      }
      return { name: nm, sc, secrets };
    };
    let savedJson = null;
    const paintHead = () => {
      const bundle = original.bundle;
      const kind = bundle ? `bundle ${bundle.name || ""} v${bundle.version || "?"}`
        : typeSel.value === "stdio" ? "local command" : typeSel.value.toUpperCase();
      summary.textContent = `${kind} · ${MCP_AUTH_LABELS[authSel.value] || authSel.value}`;
      const b = build();
      const dirty = b.error || savedJson !== JSON.stringify(b.sc) || Object.keys(b.secrets).length > 0;
      const s = status[name];
      state.textContent = isNew ? "not saved" : dirty ? "changed · not saved" : (s ? s.state : "saved");
      authBtn.hidden = authSel.value !== "oauth";
    };
    const refresh = () => {
      addrLabel.textContent = typeSel.value === "stdio" ? "Command" : "Address";
      addr.placeholder = typeSel.value === "stdio" ? "npx -y @scope/server-name" : "https://example.com/mcp";
      renderAuthChoices();
      renderSecrets();
      paintHead();
    };

    typeSel.addEventListener("change", refresh);
    authSel.addEventListener("change", () => { mode = authSel.value; renderSecrets(); paintHead(); });
    adv.addEventListener("input", () => { renderSecrets(); paintHead(); });
    for (const input of [addr, enabled]) input.addEventListener("input", paintHead);
    enabled.addEventListener("change", paintHead);
    if (isNew) nameEl.addEventListener("input", () => { renderSecrets(); paintHead(); });
    editBtn.addEventListener("click", (e) => {
      e.preventDefault();
      details.hidden = !details.hidden;
      editBtn.textContent = details.hidden ? "Edit" : "Hide";
    });
    delBtn.addEventListener("click", (e) => {
      e.preventDefault();
      card.remove();
      rows.splice(rows.indexOf(row), 1);
    });
    testBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      details.hidden = false;
      editBtn.textContent = "Hide";
      const b = build();
      if (b.error) { result.textContent = "❌ " + b.error; return; }
      testBtn.disabled = true;
      result.textContent = "Connecting…";
      try {
        const j = await postJson("/agentY/mcp/test", { name: b.name, server: b.sc, secrets: b.secrets });
        if (j.ok) {
          const names = (j.names || []).slice(0, 8).join(", ");
          const more = (j.names || []).length > 8 ? ", …" : "";
          result.textContent = `✅ Connected · ${j.tools} tool${j.tools === 1 ? "" : "s"}${names ? `: ${names}${more}` : ""}`;
        } else {
          let hint = "";
          if (j.needs_auth && authSel.value === "oauth") hint = " Save, then click Authorize… to sign in.";
          else if (j.needs_auth) hint = " The server wants credentials: choose Sign-in ▸ API key or Browser sign-in.";
          result.textContent = "❌ " + (j.error || "could not connect") + hint;
        }
      } catch (err2) {
        result.textContent = "❌ " + err2;
      } finally {
        testBtn.disabled = false;
      }
    });
    authBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      if (isNew || state.textContent.startsWith("changed")) {
        details.hidden = false;
        result.textContent = "Save first, then Authorize: sign-in uses the saved settings.";
        return;
      }
      authBtn.disabled = true;
      authBtn.textContent = "Opening browser…";
      try {
        const j = await postJson("/agentY/mcp/authorize", { name });
        state.textContent = j.ok ? "authorized" : "needs_auth";
        result.textContent = j.ok ? "✅ " + (j.message || "authorized") : "❌ " + (j.error || "failed");
        details.hidden = false;
      } catch (err2) {
        result.textContent = "❌ " + err2;
      } finally {
        authBtn.disabled = false;
        authBtn.textContent = "Authorize…";
      }
    });

    const row = {
      currentName, build,
      remove: () => { card.remove(); const i = rows.indexOf(row); if (i >= 0) rows.splice(i, 1); },
      markSaved: () => {
        const b = build();
        if (b.error) return;
        if (isNew) { isNew = false; nameEl.disabled = true; name = b.name; }
        for (const [v, input] of Object.entries(secretInputs)) {
          if (input.value) { envSet.add(v); input.value = ""; }
        }
        savedJson = JSON.stringify(build().sc);
        renderSecrets();
        paintHead();
        if (!status[name]) state.textContent = "saved · loads on next agent start";
      },
    };
    refresh();
    if (!isNew) savedJson = JSON.stringify(build().sc);
    paintHead();
    rows.push(row);
    list.append(card);
    return row;
  };

  for (const [name, sc] of Object.entries(servers)) addRow(name, sc);

  const pasteTa = el("textarea", { className: "ays-input ays-code", spellcheck: false,
    placeholder: "https://mcp.example.com/mcp\n\nnpx -y @modelcontextprotocol/server-filesystem C:/Users/me/Documents\n\n"
      + '{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],\n'
      + '  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" } } } }' });
  const addGo = el("button", { className: "ays-btn primary ays-sm", textContent: "Add" });
  const addCancel = el("button", { className: "ays-btn ays-sm", textContent: "Cancel" });
  const addMsg = el("div", { className: "ays-note" });
  const addBox = el("div", { className: "ays-mcpadd" }, [
    el("div", { className: "ays-note", textContent: "Paste what the server's page tells you to use: its address, "
      + "the command that starts it, or its JSON config. agentY fills in the rest, and any key or token "
      + "in it is moved to .env." }),
    pasteTa,
    el("div", { className: "ays-row" }, [addGo, addCancel]),
    addMsg,
  ]);
  addBox.hidden = true;
  const addBtn = el("button", { className: "ays-btn", textContent: "+ Add MCP server" });
  const closeAdd = () => { addBox.hidden = true; addBtn.hidden = false; addMsg.textContent = ""; };
  addBtn.addEventListener("click", (e) => { e.preventDefault(); addBox.hidden = false; addBtn.hidden = true; pasteTa.focus(); });
  addCancel.addEventListener("click", (e) => { e.preventDefault(); closeAdd(); });
  addGo.addEventListener("click", async (e) => {
    e.preventDefault();
    addGo.disabled = true;
    addMsg.textContent = "Reading…";
    try {
      const j = await postJson("/agentY/mcp/parse", { text: pasteTa.value, existing: rows.map((r) => r.currentName()) });
      if (!j.ok) { addMsg.textContent = "❌ " + (j.error || "could not read that"); return; }
      for (const [nm, sc] of Object.entries(j.servers || {})) {
        addRow(nm, sc, { isNew: true, secrets: j.secrets || {}, notes: j.notes || [] });
      }
      pasteTa.value = "";
      closeAdd();
    } catch (err2) {
      addMsg.textContent = "❌ " + err2;
    } finally {
      addGo.disabled = false;
    }
  });
  // ── install a bundle (.mcpb, formerly .dxt) ──
  // The file goes to the host as the request body (POST /agentY/mcp/bundle/inspect),
  // which says what the bundle is, what it will run and which settings it asks for.
  // Install unpacks it and hands back an entry, added here as an unsaved server.
  const bundleInput = el("input", { type: "file", accept: ".mcpb,.dxt", style: { display: "none" } });
  const bundleBtn = el("button", { className: "ays-btn", textContent: "Install bundle (.mcpb)…" });
  const bundleBox = el("div", { className: "ays-mcpadd" });
  bundleBox.hidden = true;
  const closeBundle = () => {
    bundleBox.hidden = true;
    bundleBox.textContent = "";
    bundleBtn.hidden = false;
    addBtn.hidden = false;
  };
  const bundleError = (message) => {
    bundleBox.textContent = "";
    const close = el("button", { className: "ays-btn ays-sm", textContent: "Close" });
    close.addEventListener("click", (e) => { e.preventDefault(); closeBundle(); });
    bundleBox.append(el("div", { className: "ays-note ays-err", textContent: "❌ " + message }), close);
  };
  const pickPath = async (type, multiple) => {
    // ComfyUI's own route opens the native dialog on this machine.
    const r = await fetch("/agent/pick_files", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "any", mode: type === "directory" ? "dir" : "files" }),
    });
    const j = await r.json();
    const paths = (j && j.ok && j.paths) || [];
    return multiple ? paths : paths.slice(0, 1);
  };
  const renderBundle = (j) => {
    const b = j.bundle || {};
    bundleBox.textContent = "";
    bundleBox.append(el("div", { className: "ays-bundlehead" }, [
      el("span", { className: "ays-mcpname", textContent: "📦 " + (b.display_name || b.name) }),
      el("span", { className: "ays-mcpsum", textContent: `v${b.version}${b.author ? " · " + b.author : ""}` }),
      el("span", { className: "ays-chip", textContent: b.signed ? "signed (not verified)" : "unsigned" }),
    ]));
    if (b.description) bundleBox.append(el("div", { className: "ays-note", textContent: b.description }));
    const facts = [`${b.server_type || "local"} server`, `${b.files} files`, formatSize(b.unpacked)];
    if (b.tools && b.tools.length) facts.push(`tools: ${b.tools.slice(0, 8).join(", ")}${b.tools.length > 8 ? ", …" : ""}`);
    bundleBox.append(
      el("div", { className: "ays-note", textContent: facts.join(" · ") }),
      el("div", { className: "ays-note", textContent: "Installing unpacks it and runs this on your machine:" }),
      el("pre", { className: "ays-bundlecmd", textContent: b.command || "" }));
    for (const p of j.problems || []) bundleBox.append(el("div", { className: "ays-note ays-err", textContent: "⛔ " + p }));
    for (const w of j.warnings || []) bundleBox.append(el("div", { className: "ays-note ays-warn", textContent: "⚠ " + w }));

    const nameInp = el("input", { className: "ays-input", value: j.name || "" });
    bundleBox.append(el("div", { className: "ays-row" },
      [el("label", { className: "ays-label", textContent: "Server name" }), nameInp]));
    if (j.replaces) {
      bundleBox.append(el("div", { className: "ays-note ays-fieldnote",
        textContent: `Replaces the installed "${j.replaces}" and its files.` }));
    }
    const getters = {};
    for (const f of j.user_config || []) {
      const label = el("label", { className: "ays-label", textContent: (f.title || f.key) + (f.required ? " *" : "") });
      let control;
      if (f.type === "boolean") {
        control = el("input", { type: "checkbox", checked: f.default === true || f.default === "true" });
        getters[f.key] = () => control.checked;
      } else if (f.type === "directory" || f.type === "file") {
        const initial = Array.isArray(f.default) ? f.default.join("\n") : (f.default == null ? "" : String(f.default));
        const text = f.multiple
          ? el("textarea", { className: "ays-input", rows: 3, value: initial, placeholder: "one path per line" })
          : el("input", { className: "ays-input", value: initial });
        const browse = el("button", { className: "ays-btn ays-sm", textContent: "Browse…" });
        browse.addEventListener("click", async (e) => {
          e.preventDefault();
          try {
            const picked = await pickPath(f.type, f.multiple);
            if (!picked.length) return;
            text.value = f.multiple ? [text.value.trim(), ...picked].filter(Boolean).join("\n") : picked[0];
          } catch (_) { /* no dialog here: the field still takes a typed path */ }
        });
        control = el("div", { className: "ays-pathpick" }, [text, browse]);
        getters[f.key] = () => (f.multiple
          ? text.value.split("\n").map((s) => s.trim()).filter(Boolean) : text.value.trim());
      } else {
        control = el("input", {
          className: "ays-input",
          type: f.type === "number" ? "number" : (f.sensitive ? "password" : "text"),
          value: f.default == null ? "" : String(f.default),
        });
        if (f.min != null) control.min = f.min;
        if (f.max != null) control.max = f.max;
        getters[f.key] = () => control.value;
      }
      bundleBox.append(el("div", { className: "ays-row" }, [label, control]));
      if (f.description) bundleBox.append(el("div", { className: "ays-note ays-fieldnote", textContent: f.description }));
    }

    const msg = el("div", { className: "ays-note" });
    const go = el("button", { className: "ays-btn primary ays-sm", textContent: "Install" });
    const cancel = el("button", { className: "ays-btn ays-sm", textContent: "Cancel" });
    go.disabled = (j.problems || []).length > 0;
    cancel.addEventListener("click", (e) => { e.preventDefault(); closeBundle(); });
    go.addEventListener("click", async (e) => {
      e.preventDefault();
      const nm = nameInp.value.trim();
      if (nm !== j.replaces && rows.some((r) => r.currentName() === nm)) {
        msg.textContent = `❌ a server is already called ${nm}`;
        return;
      }
      const values = {};
      for (const [key, get] of Object.entries(getters)) values[key] = get();
      go.disabled = true;
      msg.textContent = "Unpacking…";
      try {
        const res = await postJson("/agentY/mcp/bundle/install", { token: j.token, name: nm, values });
        if (!res.ok) { msg.textContent = "❌ " + (res.error || "install failed"); go.disabled = false; return; }
        if (j.replaces) {
          const old = rows.find((r) => r.currentName() === j.replaces);
          if (old) old.remove();
        }
        addRow(res.name, res.server, {
          isNew: true, secrets: res.secrets || {},
          notes: [`Unpacked to ${res.server.bundle.dir}. Test it, then Save.`, ...(res.warnings || [])],
        });
        closeBundle();
      } catch (err2) {
        msg.textContent = "❌ " + err2;
        go.disabled = false;
      }
    });
    bundleBox.append(el("div", { className: "ays-btnrow" }, [go, cancel]), msg);
  };
  bundleBtn.addEventListener("click", (e) => { e.preventDefault(); bundleInput.value = ""; bundleInput.click(); });
  bundleInput.addEventListener("change", async () => {
    const file = bundleInput.files && bundleInput.files[0];
    if (!file) return;
    bundleBox.hidden = false;
    bundleBtn.hidden = true;
    addBtn.hidden = true;
    bundleBox.textContent = "";
    bundleBox.append(el("div", { className: "ays-note", textContent: `Reading ${file.name}…` }));
    let j;
    try {
      const query = `?filename=${encodeURIComponent(file.name)}`
        + `&existing=${encodeURIComponent(rows.map((r) => r.currentName()).join(","))}`;
      const r = await fetch(backendBase() + "/agentY/mcp/bundle/inspect" + query, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
      });
      try {
        j = await r.json();
      } catch (_) {
        j = { ok: false, error: `the agentY host answered ${r.status}; restart it to load this version` };
      }
    } catch (err2) {
      j = { ok: false, error: String(err2) };
    }
    if (j.ok) renderBundle(j);
    else bundleError(j.error || "could not read that bundle");
  });

  body.append(list, el("div", { className: "ays-btnrow" }, [addBtn, bundleBtn]), bundleInput, addBox, bundleBox, err);

  let savedServers = null;
  const collect = () => {
    const out = {};
    const secrets = {};
    for (const row of rows) {
      const b = row.build();
      if (b.error) return { error: `${row.currentName() || "new server"}: ${b.error}` };
      if (out[b.name]) return { error: `two servers are called ${b.name}` };
      out[b.name] = b.sc;
      Object.assign(secrets, b.secrets);
    }
    return {
      config: { servers: out }, secrets,
      changed: JSON.stringify(out) !== savedServers || Object.keys(secrets).length > 0,
    };
  };
  savedServers = JSON.stringify((collect().config || {}).servers || {});
  const markSaved = () => {
    for (const row of rows) row.markSaved();
    const c = collect();
    if (!c.error) savedServers = JSON.stringify(c.config.servers);
  };
  return { group, err, collect, markSaved };
}

async function openAgentYSettingsModal() {
  injectStyles();
  let data;
  try {
    const r = await fetch(backendBase() + "/agentY/settings");
    if (!r.ok) throw new Error("HTTP " + r.status);
    data = await r.json();
  } catch (e) {
    alert("Could not load agentY settings — is the chat host running?\n\n" + e);
    return;
  }

  // MCP servers (config/mcp.json + per-server status). Best-effort — the section
  // is simply omitted if the host predates the /agentY/mcp route.
  let mcpData = null;
  try {
    const rm = await fetch(backendBase() + "/agentY/mcp");
    if (rm.ok) mcpData = await rm.json();
  } catch (_) { /* no MCP route on this host — skip the section */ }

  const overlay = el("div", { className: "ays-overlay" });
  const body = el("div", { className: "ays-body" });

  // ── viewers (moved here from the side-panel top bar) ──
  const toolsSec = el("div", { className: "ays-sec" });
  toolsSec.append(el("h3", { textContent: "Viewers" }));
  toolsSec.append(el("div", { className: "ays-note", textContent: "The message-history log (includes tool calls), the long-term memory editor (everything the agent remembers from previous runs), the project memory (what is true of THIS project — characters, style, named references; it switches with the project), and the token/cost breakdown." }));
  // Lucide icons from iconsUI.json; the emoji text shows until they load.
  const viewerBtn = (key, emoji, label, open) => {
    const btn = el("button", { className: "ays-btn" });
    setButtonIcon(btn, key, `${emoji}  ${label}`, label);
    btn.addEventListener("click", () => open && open());
    return btn;
  };
  const logViewBtn = viewerBtn("logViewer", "📜", "Message-history log…", () => window.agentYOpenLogViewer?.());
  const memViewBtn = viewerBtn("memoryViewer", "🧠", "Long-term memory…", () => window.agentYOpenMemoryViewer?.());
  const projMemBtn = viewerBtn("projectMemory", "📌", "Project memory…", () => window.agentYOpenProjectMemory?.());
  const usageViewBtn = viewerBtn("tokenUsage", "📊", "Token usage…", () => window.agentYOpenTokenUsage?.());
  toolsSec.append(el("div", { className: "ays-row" }, [logViewBtn, memViewBtn, projMemBtn, usageViewBtn]));
  body.append(toolsSec);
  iconsReady.then(() => applyIcons(toolsSec));

  // ── .env auth section ──
  const envInputs = {};
  const envSec = el("div", { className: "ays-sec" });
  envSec.append(el("h3", { textContent: "Authentication (.env)" }));
  envSec.append(el("div", { className: "ays-note", textContent:
    "API keys and host settings, stored in .env on the agent host. Keys already " +
    "set are shown masked — the host does not send them back. Type over one to " +
    "replace it; leave it alone and it stays as it is." }));

  // Rotation warning, at the top of the section it is about. The host prints the
  // same thing at startup, which is easy to scroll past in a terminal — this is
  // where someone is when they can actually act on it.
  const ages = new Map((data.key_ages || []).map((e) => [e.key, e]));
  const limit = Number(data.key_age_limit || 0);
  const overdue = (data.key_ages || []).filter((e) => e.stale);
  if (overdue.length) {
    envSec.append(el("div", { className: "ays-note", style: {
      color: "#ffb454", border: "1px solid #ffb45455", borderRadius: "4px",
      padding: "6px 8px", margin: "6px 0" },
      textContent:
        `${overdue.length} key(s) have been in place longer than ${limit} days. ` +
        "An API key never expires by itself, so rotating on a clock is the only " +
        "protection that does not depend on noticing a leak. Paste a new value " +
        "below and the clock restarts on its own." }));
  }

  // No "show values" toggle: the host sends a mask, never a secret, so revealing
  // the field would only show the mask back. A key is replaced by typing over it.
  for (const key of data.env_keys || Object.keys(data.env || {})) {
    const cur = (data.env || {})[key] || "";
    const inp = el("input", { className: "ays-input", type: isSecret(key) ? "password" : "text", value: cur });
    envInputs[key] = { input: inp, original: cur };
    const label = el("label", { className: "ays-label", textContent: key });
    const age = ages.get(key);
    if (age) {
      const days = Math.floor(age.age_days);
      // "at least" where the date was inferred from .env's mtime rather than
      // watched: the true age can only be older, never younger, and claiming a
      // precision we do not have is how a warning stops being believed.
      const about = age.estimated ? "≥" : "";
      label.append(el("span", {
        textContent: `  ${about}${days}d`,
        title: age.estimated
          ? `First seen ${age.first_seen} — estimated from .env's timestamp, so the key may be older.`
          : `First seen ${age.first_seen}.`,
        style: { opacity: "0.6", fontSize: "11px",
                 color: age.stale ? "#ffb454" : "inherit" },
      }));
    }
    envSec.append(el("div", { className: "ays-row" }, [label, inp]));
  }
  // Add NEW .env keys (e.g. an MCP server's API key). The host appends them and
  // applies them to the live process, so a header-auth MCP server can reference
  // ${THE_KEY} immediately on the next agent start.
  const addKeyRows = [];
  const addKeysWrap = el("div", {});
  const addAKeyRow = () => {
    const nameInp = el("input", { className: "ays-input", placeholder: "NEW_KEY_NAME", style: { flex: "0 0 42%" } });
    const valInp = el("input", { className: "ays-input", type: "password", placeholder: "value" });
    addKeyRows.push({ name: nameInp, val: valInp });
    addKeysWrap.append(el("div", { className: "ays-row" }, [nameInp, valInp]));
  };
  const addKeyBtn = el("button", { className: "ays-btn", textContent: "+ Add auth key" });
  addKeyBtn.addEventListener("click", (e) => { e.preventDefault(); addAKeyRow(); });
  envSec.append(addKeysWrap, addKeyBtn);
  body.append(envSec);

  // ── settings.json section ──
  const refs = [];
  const setSec = el("div", { className: "ays-sec" });
  setSec.append(el("h3", { textContent: "Application settings (config/settings.json)" }));
  setSec.append(el("div", { className: "ays-note", textContent: "Model per stage (llm ▸ pipeline), directories, and behaviour toggles. Comments are preserved on save; only changed values are written." }));
  const setForm = el("div");
  TIER_LABELS = data.tier_labels || {};
  buildTopLevelSettings(setForm, data.settings || {}, data.model_groups || {}, refs);

  // Advanced groups (prompt-file pointers, per-provider tuning, embedder internals)
  // stay hidden until asked for. They are real settings, not clutter — but showing
  // them by default buries the handful anyone actually changes.
  const advToggle = el("input", { type: "checkbox" });
  const advWrap = el("label", {
    className: "ays-note",
    style: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" },
  }, [advToggle, document.createTextNode("Show advanced settings (prompts, provider tuning, embedder)")]);
  const applyAdvanced = () => {
    for (const g of setForm.querySelectorAll('[data-advanced="1"]')) {
      g.style.display = advToggle.checked ? "" : "none";
    }
  };
  advToggle.addEventListener("change", applyAdvanced);
  setSec.append(advWrap);
  setSec.append(setForm);
  applyAdvanced();
  body.append(setSec);

  // ── model pricing and MCP servers: a card each, like every other group ──
  const intSec = el("div", { className: "ays-sec" });
  intSec.append(el("h3", { textContent: "Costs & MCP servers" }));
  const pricing = buildPricingCard(data);
  intSec.append(pricing.group);
  // Which .env variables already hold a value, so a server's key field can say
  // "saved" instead of asking for it again. The values themselves stay masked.
  const envSet = new Set(Object.entries(data.env || {}).filter(([, v]) => v).map(([k]) => k));
  const mcp = mcpData && mcpData.ok ? buildMcpCard(mcpData, envSet) : null;
  if (mcp) intSec.append(mcp.group);
  body.append(intSec);

  // ── footer ──
  const msg = el("div", { className: "ays-msg" });
  const saveBtn = el("button", { className: "ays-btn primary", textContent: "Save" });
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { document.removeEventListener("keydown", onKey); overlay.remove(); };
  // No Close button: click the backdrop or press Escape. Both existed already, but
  // only the backdrop was discoverable — hence Escape being wired up here too.
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    msg.textContent = "Saving…";
    const envChanges = {};
    for (const [key, { input, original }] of Object.entries(envInputs)) {
      if (input.value !== original) envChanges[key] = input.value;
    }
    for (const { name, val } of addKeyRows) {
      const k = (name.value || "").trim();
      if (k) envChanges[k] = val.value;
    }
    const priceOut = pricing.collect();
    pricing.err.textContent = priceOut.error ? "Not saved: " + priceOut.error : "";
    const mcpOut = mcp ? mcp.collect() : null;
    if (mcp) mcp.err.textContent = mcpOut.error ? "Not saved: " + mcpOut.error : "";
    // A server's keys are .env variables like any other, written before the
    // server that references them.
    if (mcpOut && !mcpOut.error) Object.assign(envChanges, mcpOut.secrets);
    const payload = { env: envChanges, settings: collectSettings(refs) };
    if (priceOut.payload && priceOut.changed) payload.pricing = priceOut.payload;
    try {
      const r = await fetch(backendBase() + "/agentY/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "save failed");
      if (j.pricing_updated) pricing.markSaved();
      let mcpSaved = false;
      if (mcpOut && !mcpOut.error && mcpOut.changed) {
        try {
          const jm = await postJson("/agentY/mcp", { config: mcpOut.config });
          mcpSaved = !!jm.ok;
          if (mcpSaved) mcp.markSaved();
          else mcp.err.textContent = "Not saved: " + (jm.error || "the host refused it");
        } catch (_) { /* leave mcpSaved false */ }
      }
      const parts = [];
      if (j.env_updated && j.env_updated.length) parts.push(`${j.env_updated.length} auth key(s)`);
      if (j.settings_updated && j.settings_updated.length) parts.push(`${j.settings_updated.length} setting(s)`);
      if (j.pricing_updated) parts.push("pricing");
      if (mcpSaved) parts.push("MCP servers");
      msg.textContent = parts.length ? "✅ Saved " + parts.join(", ") + ". Model & MCP changes apply on the next agent start." : "No changes to save.";
      // Refresh originals so a second save doesn't re-send unchanged keys.
      for (const [key, o] of Object.entries(envInputs)) o.original = o.input.value;
    } catch (e) {
      msg.textContent = "❌ " + e;
    } finally {
      saveBtn.disabled = false;
    }
  });

  const foot = el("div", { className: "ays-foot" }, [msg, saveBtn]);
  const card = el("div", { className: "ays-card" }, [
    el("div", { className: "ays-head" }, [el("h2", { textContent: "agentY — Application Settings" })]),
    body,
    foot,
  ]);
  overlay.append(card);
  document.body.append(overlay);
}

app.registerExtension({
  name: "agentY.settings",
  settings: [
    {
      id: "agentY.appSettings",
      name: "Application settings (auth keys + config)",
      category: ["agentY", "Application", "Settings"],
      tooltip: "Edit agentY auth keys (.env) and config/settings.json",
      defaultValue: "",
      // Custom render: a button that opens the agentY settings modal.
      type: (_name, _setter, _value) => {
        const btn = el("button", { className: "ays-btn", textContent: "Open agentY Settings…" });
        injectStyles();
        btn.addEventListener("click", (e) => { e.preventDefault(); openAgentYSettingsModal(); });
        return btn;
      },
    },
  ],
});
