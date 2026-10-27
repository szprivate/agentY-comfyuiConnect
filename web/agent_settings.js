import { app } from "../../scripts/app.js";
import { backendBase } from "./agent_backend.js";
import { iconsReady, setButtonIcon, applyIcons } from "./agent_icons.js";
import { searchableSelect } from "./agent_combo.js";
import { serviceEnvNames } from "./agent_env_names.js";

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
//   aux      a sub-group of sub-groups: { title, objects } - "Auxiliary models"
//   envUrls  the providers' endpoint variables of .env, shown here as fields
//   deadline the DEADLINE_* variables of .env, shown here as fields
//   slackEnv the SLACK_* variables of .env, shown here as fields (always, even empty)
//
// Anything not claimed by a section still appears, under "Other" — a new setting
// must never become unreachable just because this list was not updated.
const SECTIONS = [
  // Models first and OPEN. It is the setting people come here to change, and it
  // used to be two collapsed levels down ("Models & providers" -> "Model tiers").
  { title: "Models", open: true, inline: ["llm", "tiers"],
    objects: [["llm", "pipeline"]], extra: "memoryEmbedder", routing: true,
    // The models the agent loads itself, beside the language models: each does
    // one job, and each is a choice of model like the ones above.
    aux: { title: "Auxiliary models", objects: [["decision"], ["annotate"], ["likeness"]] } },
  // Where everything is reached, and how the local models are run. The hosted
  // providers' endpoints are .env variables (a key and its endpoint belong to one
  // account), shown here because they are addresses - and only for a provider
  // whose key (or endpoint) is set.
  { title: "Connections", envUrls: true,
    keys: ["comfyui_url", "agent_server_url", "ollama_server_url"],
    objects: [["llm", "ollama"]],
    inlineExtra: ["llm"] },   // llm's own scalars (history_window)
  { title: "Canvas", keys: ["drop_outputs_into_canvas", "show_outputs_in_panel", "place_text_nodes_on_canvas",
                            "autoload_workflows_into_canvas", "work_in_open_graph",
                            "hooks_into_canvas", "hook_subgraph_min_nodes",
                            "canvas_full_graph", "hook_tap_tensors", "hook_scoped_graph",
                            "comfyui_console_lines"] },
  { title: "Load & save nodes", extra: "mediaNodes" },
  { title: "Output checks", objects: [["qa"], ["refine"]] },
  // Where open-weight models run: this GPU, or Comfy Cloud. Partner API nodes are not affected.
  { title: "Execution", inline: ["execution"] },
  // Its tokens and allow-list are .env variables, shown here as fields.
  { title: "Slack", inline: ["slack"], slackEnv: true },
  // The render farm's variables are .env values, not settings.json ones.
  { title: "Deadline", deadline: true },
  { title: "Updates", keys: ["auto_update", "update_channel"] },
  // Not advanced. These decide who can reach the host, and someone who has just
  // read the startup warning should find them without checking a box first.
  { title: "Security", inline: ["security"] },
  { title: "Memory", inline: ["memory"], advanced: true },
  { title: "Files & logs", advanced: true,
    keys: ["comfyui_dir", "comfyui_models_dir", "comfyui_user_dir",
           "comfyui_custom_templates_dir", "output_dir", "output_workflows_dir",
           "conversation_db", "message_history_log", "tokens_usage_log"] },
];

// Settings that are in the file and not on the page. Each is either set
// somewhere better (a model's reasoning on its row under Models, Ollama's
// address under Connections, the embedder as a choice under Models) or is not a
// thing to tune from a form at all (which prompt file a role reads, a hosted
// provider's fallback model). They are read and kept as they are: the page
// writes only what it shows.
const HIDDEN = new Set([
  "memory.embedder", "memory.llm",
  "llm.vision_models", "llm.text_only_models",
  "llm.ollama.host", "llm.ollama.think",
  "llm.anthropic", "llm.dashscope", "llm.openai", "llm.google",
  "llm.custom_providers",     // the registry: Connections shows and saves it
  "llm.routing",              // Models draws it: the auto-switch switch and the rules table
  "system_prompts",
]);
const isHidden = (path) => HIDDEN.has(path.join("."));

// A row's name where the key does not say what it is.
const LEAF_LABELS = {
  "llm.ollama.num_ctx": "Context Window Size",
  "llm.ollama.max_tokens": "Max Output Tokens",
};

// The providers' endpoints among the .env variables.
const isProviderUrl = (key) => /_BASE_URL$/.test(key);

// A service name as a provider id ("Mercury AI" -> "mercury_ai"), and the names a
// provider may not take (data.reserved_providers, the host's list).
const providerId = (name) => String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
let RESERVED_PROVIDERS = new Set();

// The Deadline render farm's .env variables: their own section, not Authentication.
const DEADLINE_KEYS = ["DEADLINE_PATH", "DEADLINE_REPOSITORY", "DEADLINE_WEBSERVICE_URL",
  "DEADLINE_COMFYUI_PATH", "DEADLINE_COMFYUI_POOL", "DEADLINE_GROUP", "DEADLINE_OUTPUT_DIR"];

// The Slack bridge's .env variables: their own section, not Authentication.
const SLACK_KEYS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_ALLOWED_USERS"];

// What a path setting comes to on this machine, in full (/agentY/settings ->
// setting_defaults): a blank one resolved to where things really go, a relative
// one to the folder it is read against. The field shows that; what is SAVED is
// still what the file had, unless the field is edited - or opening the page and
// pressing Save would write this machine's paths into every setting.
let SETTING_DEFAULTS = {};

// Number settings that are stored as "work it out" (-1) and were worked out to
// a number on this machine: { "llm.ollama.num_ctx": 98304 }. The field shows the
// number; -1 typed into it goes back to working it out.
let AUTO_VALUES = {};

// What can be picked for the models the agent loads itself (/agentY/settings ->
// aux_model_choices): { "decision.router_model": [{id, label}], ... }.
let AUX_CHOICES = {};

// The folders ComfyUI loads models from besides its own. Not a setting of
// agentY's - they are ComfyUI's extra model paths - so they are shown, not edited.
let EXTRA_MODEL_DIRS = [];

// Per-key notes, for the few settings whose name does not carry the trade-off.
// The TOML comments never reach the browser, and this is the only place a switch
// can say what turning it on costs.
// String settings that are a pick from a fixed list, drawn as a menu: path -> [[value, label], ...].
const ENUM_CHOICES = {
  "execution.mode": [
    ["local", "Local - this machine's GPU (default)"],
    ["hybrid", "Hybrid - local when the models fit, else Comfy Cloud"],
    ["cloud", "Cloud - open-weight models run on Comfy Cloud"],
  ],
};

const KEY_NOTES = {
  "execution.mode":
    "Where OPEN-WEIGHT models (SDXL, Flux, Wan ...) run. Partner API nodes (Seedance, GPT Image, "
    + "Kling ...) are not affected: their models run on the providers' servers, sent from your "
    + "ComfyUI in every mode, under the usual credit checks. Hybrid and Cloud need the Comfy API key (Authentication). Saying \"run this "
    + "in the cloud\" or \"keep it local\" in a message overrides it for that turn. See docs/execution_modes.md.",
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
  show_outputs_in_panel:
    "Show each finished image or video in the chat as well, with its number in "
    + "the conversation on it. That number is how the agent knows the file, so "
    + "\"upscale 3\" means the picture marked #3. Off, results still land on the "
    + "canvas and the chat names each file.",
  hooks_into_canvas:
    "When you run a hook pipeline, put every workflow it builds into the graph "
    + "you have open, in a group of its own, instead of opening a tab for each.",
  hook_subgraph_min_nodes:
    "A workflow built for a hook stage with at least this many nodes is folded "
    + "into one subgraph node, so the pipeline stays readable. 0 never folds.",
  work_in_open_graph:
    "How a conversation starts. Off: the agent builds each workflow separately, "
    + "and switches to working in your open graph once you ask it to put "
    + "something there. On: it works in the graph you have open from the first "
    + "message — new workflows are added to it, and changes are made on the "
    + "canvas. A conversation keeps its mode until you ask it to change.",
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
  .ays-hostline{font-size:11px;color:#9aa0aa;font-family:ui-monospace,monospace;text-align:right;
    max-width:60%;overflow-wrap:anywhere;}
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
  .ays-think{display:inline-flex;align-items:center;gap:3px;flex:none;cursor:pointer;font-size:13px;white-space:nowrap;}
  .ays-row .ays-think-sel{flex:none;width:auto;}
  .ays-field .ays-keynote{margin:0 0 0 calc(42% + 10px);}
  .ays-field.ays-hasnote{margin:12px 0;}
  .ays-label{flex:0 0 42%;font-size:12.5px;color:#c3c8d0;word-break:break-word;font-family:ui-monospace,monospace;}
  .ays-input{flex:1;min-width:0;background:#161a20;color:#e6e8ec;border:1px solid #2c313b;
    border-radius:7px;padding:6px 9px;font-size:12.5px;outline:none;}
  select.ays-input,.ays-input.ay-combo{min-width:96px;text-overflow:ellipsis;}
  /* A narrow window: the label goes above its control instead of taking 42% of the row. */
  @media (max-width:560px){
    .ays-row{flex-wrap:wrap;}
    .ays-label{flex:1 1 100%;}
    .ays-field .ays-keynote,.ays-fieldnote{margin-left:0;}
  }
  .ays-input:focus,.ays-input.ay-combo:focus-within{border-color:#6f97ff;}
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

// The OpenAI-compatible providers the user registered (data.custom_providers): a
// model id they did not list can still be typed in the model menus.
let CUSTOM_PROVIDERS = [];
function typedModelChoices(text) {
  const t = String(text || "").trim();
  const [head, ...rest] = t.split(",");
  const named = CUSTOM_PROVIDERS.find((p) => p.id === head.trim().toLowerCase());
  if (named && rest.length && rest.join(",").trim()) {
    return [{ value: `${named.id},${rest.join(",").trim()}`, label: `${named.label}: use "${rest.join(",").trim()}"` }];
  }
  return CUSTOM_PROVIDERS.map((p) => ({ value: `${p.id},${t}`, label: `${p.label}: use "${t}"` }));
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
  decision: "Decision models (routing, prompt check)",
  annotate: "Finding things in pictures (SAM3)",
  likeness: "Face matching (InsightFace)",
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

// Long-term memory's embedder (memory.embedder.preset), from /agentY/settings:
// [{id, label, available, why}]. Shown with the models rather than under the
// advanced Memory section: a machine without Ollama has to choose one, and an
// embedder is a model choice like the others — just not a chat model.
let EMBEDDERS = [];
const EMBEDDER_NOTE = "Turns memories into vectors so they can be found by meaning. "
  + "Not a chat model — each provider has its own embedding model, reached with the "
  + "same key. Switching re-embeds every stored memory with the new one (the old "
  + "index is kept as a backup), so nothing is lost.";

function memoryEmbedderRow(container, settings, refs) {
  const emb = ((settings || {}).memory || {}).embedder;
  if (!emb || !EMBEDDERS.length) return false;
  const current = String(emb.preset || "");
  const sel = el("select", { className: "ays-input" });
  const custom = el("option", { value: "", textContent:
    `As the settings file has it (${emb.provider || "?"} · ${emb.model || "?"})` });
  if (!current) custom.selected = true;
  sel.append(custom);
  for (const c of EMBEDDERS) {
    const o = el("option", { value: c.id,
      textContent: c.label + (c.available ? "" : `  — ${c.why}`) });
    o.disabled = !c.available && c.id !== current;
    if (c.id === current) o.selected = true;
    sel.append(o);
  }
  refs.push({ path: ["memory", "embedder", "preset"], get: () => sel.value });
  const field = el("div", { className: "ays-field ays-hasnote" });
  const row = el("div", { className: "ays-row" });
  row.append(el("label", { className: "ays-label", textContent: "Memory embedder",
                           title: "memory.embedder.preset" }), sel);
  field.append(row, el("div", { className: "ays-note ays-keynote", textContent: EMBEDDER_NOTE }));
  container.append(field);
  return true;
}

// ── model routing: auto-switch and the rules table (llm.routing) ──────────
// The agent can list and switch models (list_models / switch_model). A rule says
// WHEN to suggest a switch: "when this skill / tool pack / tool is used, model M is
// the better seat". The host checks the rules on tool calls it already makes -
// no extra model call - and adds one line to the result, once per conversation.
// With the switch on, a rule moves the conversation without asking.
const ROUTING_KINDS = [["skill", "skill"], ["tool_pack", "tool pack"], ["tool", "tool"]];
const ROUTING_AUTO_NOTE = "When a rule below fires, the agent suggests the model and asks you first. "
  + "On: it switches this conversation by itself and tells you (any other switch is still asked). "
  + "It never picks a model that is not available, and never moves a conversation holding images "
  + "to a model that cannot read them.";
const ROUTING_RULES_NOTE = "When the agent loads a skill or tool pack, or calls a tool, that matches "
  + "a rule, it is told which model is recommended for the job. A rule whose model is not available "
  + "right now stays silent.";

const ruleWhen = (rule) => {
  const when = (rule && rule.when) || {};
  for (const [k] of ROUTING_KINDS) if (when[k]) return [k, String(when[k])];
  return ["skill", ""];
};

function routingRows(container, settings, modelGroups, refs) {
  const routing = (((settings || {}).llm) || {}).routing;
  if (!routing || typeof routing !== "object") return false;

  // The switch.
  const autoField = el("div", { className: "ays-field ays-hasnote" });
  const autoRow = el("div", { className: "ays-row" });
  const autoBox = el("input", { type: "checkbox", className: "ays-input" });
  autoBox.checked = routing.auto_switch === true;
  autoRow.append(el("label", { className: "ays-label", textContent: "Auto-switch suggested models",
                               title: "llm.routing.auto_switch" }), autoBox);
  autoField.append(autoRow, el("div", { className: "ays-note ays-keynote", textContent: ROUTING_AUTO_NOTE }));
  refs.push({ path: ["llm", "routing", "auto_switch"], get: () => autoBox.checked });
  container.append(autoField);

  // The rules.
  const original = Array.isArray(routing.rules) ? routing.rules : [];
  const { group, body } = makeCollapsibleGroup("routing rules", `  (${original.length})`, false);
  body.append(el("div", { className: "ays-note", textContent: ROUTING_RULES_NOTE }));
  const roles = ["orchestrator", ...Object.keys(TIER_LABELS).filter((t) => t !== "orchestrator")];
  const rows = [];
  const list = el("div");
  const addRule = (rule) => {
    const [kind, name] = ruleWhen(rule);
    const suggest = Array.isArray(rule && rule.suggest) ? rule.suggest : (rule && rule.suggest ? [rule.suggest] : []);
    const kindSel = el("select", { className: "ays-input" },
      ROUTING_KINDS.map(([v, l]) => el("option", { value: v, textContent: l })));
    kindSel.value = kind;
    const nameInp = el("input", { type: "text", className: "ays-input", value: name,
                                  placeholder: "name, e.g. model-from-reference or dcc" });
    const roleSel = el("select", { className: "ays-input", title: "The tier or role the rule is about" },
      roles.map((r) => el("option", { value: r, textContent: r, title: TIER_LABELS[r] || r })));
    roleSel.value = (rule && rule.role) || "orchestrator";
    const modelSel = buildModelSelect(modelGroups, suggest[0] || "", true);
    modelSel.options[0].textContent = "— choose a model —";
    const modelBox = searchableSelect(modelSel, { placeholder: "Type a model name…",
      extraChoices: CUSTOM_PROVIDERS.length ? typedModelChoices : null });
    const whyInp = el("input", { type: "text", className: "ays-input", value: (rule && rule.why) || "",
                                 placeholder: "why this model suits the task" });
    const del = el("button", { className: "ays-btn ays-x", textContent: "✕", title: "Remove this rule" });
    const field = el("div", { className: "ays-field" }, [
      el("div", { className: "ays-row" }, [el("label", { className: "ays-label", textContent: "when" }), kindSel, nameInp]),
      el("div", { className: "ays-row" }, [el("label", { className: "ays-label", textContent: "suggest" }), roleSel, modelBox]),
      el("div", { className: "ays-row" }, [el("label", { className: "ays-label", textContent: "why" }), whyInp, del]),
    ]);
    const entry = { rule: rule || {}, kindSel, nameInp, roleSel, modelSel, whyInp, suggest, firstModel: suggest[0] || "" };
    del.addEventListener("click", (e) => { e.preventDefault(); field.remove(); rows.splice(rows.indexOf(entry), 1); });
    rows.push(entry);
    list.append(field);
  };
  original.forEach((r) => addRule(r));
  const addBtn = el("button", { className: "ays-btn", textContent: "+ Add rule" });
  addBtn.addEventListener("click", (e) => { e.preventDefault(); addRule(null); });
  body.append(list, addBtn);
  container.append(group);

  // A rule with no name or no model is dropped; an untouched model keeps a
  // preference list (suggest: [a, b]) exactly as the file has it.
  refs.push({ path: ["llm", "routing", "rules"], get: () => rows
    .filter((r) => r.nameInp.value.trim() && (r.modelSel.value || r.suggest.length))
    .map((r) => ({
      ...r.rule,
      when: { [r.kindSel.value]: r.nameInp.value.trim() },
      role: r.roleSel.value,
      suggest: r.modelSel.value === r.firstModel && r.suggest.length > 1 ? r.suggest : r.modelSel.value,
      why: r.whyInp.value.trim(),
    })) });
  return true;
}

// Which node loads and which node saves each kind of file (settings.media_nodes).
// The candidates are read from this ComfyUI's own node list by the host
// (/agentY/settings -> media_node_choices): {image: {load: [{id, label}], save: [...]}, …}.
let MEDIA_NODES = {};
const MEDIA_KINDS = [["image", "Images"], ["video", "Videos"], ["audio", "Audio"],
                     ["model", "3D models"]];
const MEDIA_ROLES = [["load", "load with"], ["save", "save with"]];
const MEDIA_AUTO = { load: "Automatic — the first loader this ComfyUI has",
                     save: "Automatic — the save node the workflow was built with" };
// Audio and 3D results have no built-in loader to fall back on: without a choice
// they are named in the chat and not placed on the canvas.
const MEDIA_AUTO_NO_LOADER = "Automatic — not placed on the canvas";
const MEDIA_NO_DEFAULT_LOADER = ["audio", "model"];
const MEDIA_NOTE = "Which node the agent uses to load a file onto the canvas, and which "
  + "node saves what a workflow produces. A chosen save node replaces the workflow's own "
  + "when it can take the same connection; otherwise the workflow keeps its own.";

// One <select> per kind and role. A value that is set but not offered (the pack
// was removed, or ComfyUI could not be asked) stays selectable, so opening the
// page and saving never silently clears a choice.
export function mediaNodeOptions(choices, current, role, kind) {
  const list = Array.isArray(choices) ? choices.slice() : [];
  const auto = role === "load" && MEDIA_NO_DEFAULT_LOADER.includes(kind)
    ? MEDIA_AUTO_NO_LOADER : (MEDIA_AUTO[role] || "Automatic");
  const options = [{ value: "", label: auto }];
  for (const c of list) options.push({ value: String(c.id), label: String(c.label || c.id) });
  if (current && !list.some((c) => String(c.id) === current)) {
    options.push({ value: current, label: `${current}  — not available in this ComfyUI` });
  }
  return options;
}

function mediaNodesRows(container, settings, refs) {
  const chosen = (settings || {}).media_nodes;
  if (!chosen || typeof chosen !== "object") return false;
  container.append(el("div", { className: "ays-note ays-keynote", textContent: MEDIA_NOTE }));
  for (const [kind, kindLabel] of MEDIA_KINDS) {
    for (const [role, roleLabel] of MEDIA_ROLES) {
      const key = `${kind}_${role}`;
      const current = String(chosen[key] || "");
      const sel = el("select", { className: "ays-input" });
      for (const o of mediaNodeOptions(((MEDIA_NODES || {})[kind] || {})[role], current, role, kind)) {
        const opt = el("option", { value: o.value, textContent: o.label });
        if (o.value === current) opt.selected = true;
        sel.append(opt);
      }
      refs.push({ path: ["media_nodes", key], get: () => sel.value });
      const row = el("div", { className: "ays-row" });
      row.append(el("label", { className: "ays-label", textContent: `${kindLabel} — ${roleLabel}`,
                               title: `media_nodes.${key}` }), sel);
      container.append(el("div", { className: "ays-field" }, [row]));
      if (key === "video_save") videoAsRows(container, chosen, refs, sel);
    }
  }
  viewerTabRow(container, chosen, refs);
  return true;
}

// The one viewer tab the agent's pictures go to (Send to Image Viewer as the save
// node). Each stage's pictures are grouped inside it under the hook's title.
const VIEWER_TAB_NOTE = "With Send to Image Viewer as the save node, everything the agent saves "
  + "goes into this one viewer tab, grouped by the stage (hook title) it came from. "
  + "Empty leaves each save node with its own tab.";

function viewerTabRow(container, chosen, refs) {
  const input = el("input", { type: "text", className: "ays-input", placeholder: "agentY",
                              value: String(chosen.viewer_tab == null ? "agentY" : chosen.viewer_tab) });
  refs.push({ path: ["media_nodes", "viewer_tab"], get: () => input.value.trim() });
  const row = el("div", { className: "ays-row" });
  row.append(el("label", { className: "ays-label", textContent: "Viewer tab for the agent's pictures",
                           title: "media_nodes.viewer_tab" }), input);
  container.append(el("div", { className: "ays-field" }, [row]));
  container.append(el("div", { className: "ays-note ays-keynote", textContent: VIEWER_TAB_NOTE }));
}

// A video file or an image sequence, and the sequence's format. Only a save node
// that can write both acts on it (Send to Image Viewer); the rows say so.
const VIDEO_AS_NOTE = "Used when the video save node can write both — Send to Image Viewer. "
  + "A sequence is one image per frame, named prefix.1001.<format>. The agent can still "
  + "be asked for the other in a single request.";

// The formats to offer: those of the chosen save node, or of every node that can
// write a sequence when none is chosen yet. The current value always stays.
export function sequenceFormatOptions(byNode, saveNode, current) {
  const all = byNode && typeof byNode === "object" ? byNode : {};
  let list = Array.isArray(all[saveNode]) ? all[saveNode].slice() : [];
  if (!list.length) list = [...new Set(Object.values(all).flat())];
  if (!list.length) list = ["png"];
  if (current && !list.includes(current)) list.push(current);
  return list;
}

function videoAsRows(container, chosen, refs, saveSel) {
  const mode = el("select", { className: "ays-input" });
  for (const [value, label] of [["video", "a video file (mp4)"], ["sequence", "an image sequence"]]) {
    const opt = el("option", { value, textContent: label });
    if (value === String(chosen.video_as || "video")) opt.selected = true;
    mode.append(opt);
  }
  const fmt = el("select", { className: "ays-input" });
  const fill = () => {
    const current = fmt.value || String(chosen.sequence_format || "png");
    fmt.replaceChildren();
    const byNode = ((MEDIA_NODES || {}).video || {}).sequence_formats;
    for (const f of sequenceFormatOptions(byNode, saveSel.value, current)) {
      const opt = el("option", { value: f, textContent: f });
      if (f === current) opt.selected = true;
      fmt.append(opt);
    }
  };
  fill();
  saveSel.addEventListener("change", fill);
  refs.push({ path: ["media_nodes", "video_as"], get: () => mode.value });
  refs.push({ path: ["media_nodes", "sequence_format"], get: () => fmt.value });
  for (const [label, key, sel] of [["Videos — save as", "video_as", mode],
                                   ["Videos — sequence format", "sequence_format", fmt]]) {
    const row = el("div", { className: "ays-row" });
    row.append(el("label", { className: "ays-label", textContent: label,
                             title: `media_nodes.${key}` }), sel);
    container.append(el("div", { className: "ays-field" }, [row]));
  }
  container.append(el("div", { className: "ays-note ays-keynote", textContent: VIDEO_AS_NOTE }));
}

// Reasoning per agent: llm.thinking (per tier, on/off) and llm.thinking_roles (per
// role, "" = as its tier). Not shown as groups of their own — each is a switch on
// the model row it belongs to, where the choice is actually made.
let THINKING = { tiers: {}, roles: {} };
const THINK_TITLE = "Reasoning: the model thinks before it answers. Better decisions, "
  + "slower and more tokens — worth it where few calls decide a lot (the lead), "
  + "rarely for agents that make many quick tool calls. The model must support it.";

function thinkingControl(path, key, refs) {
  if (path[0] !== "llm") return null;
  if (path[1] === "tiers" && key in THINKING.tiers) {
    const box = el("input", { type: "checkbox" });
    box.checked = THINKING.tiers[key] === true || String(THINKING.tiers[key]).toLowerCase() === "true";
    refs.push({ path: ["llm", "thinking", key], get: () => box.checked });
    return el("label", { className: "ays-think", title: THINK_TITLE }, [box, document.createTextNode("💭")]);
  }
  if (path[1] === "pipeline" && key in THINKING.roles) {
    const sel = el("select", { className: "ays-input ays-think-sel", title: THINK_TITLE });
    for (const [v, t] of [["", "💭 as tier"], ["on", "💭 on"], ["off", "💭 off"]]) {
      const o = el("option", { value: v, textContent: t });
      if (String(THINKING.roles[key] || "").toLowerCase() === v) o.selected = true;
      sel.append(o);
    }
    refs.push({ path: ["llm", "thinking_roles", key], get: () => sel.value });
    return sel;
  }
  return null;
}

// One-line explanations for groups whose keys don't speak for themselves. The form
// is generated from the settings file, so there is nowhere else to say what a
// section is FOR — the TOML comments never reach the browser.
const GROUP_NOTES = {
  execution: "Where open-weight models run: this machine's GPU, Comfy Cloud, or locally when "
    + "they fit and on the cloud when they do not. Partner API models (Seedance, GPT Image, "
    + "Kling ...) run on the providers' servers in every mode. The installer picked a starting point from your hardware.",
  pricing: "What each model costs, in USD per million tokens, so Token usage matches "
    + "your bill. Pick the model from the list your providers report; a blank price "
    + "uses the built-in one shown greyed out. Saved to config/pricing.json.",
  mcp: "External MCP servers whose tools the orchestrator can call. Add one by "
    + "pasting its address, its start command or its JSON config, or install a bundle "
    + "(.mcpb) file; Test connects once and lists the tools. Keys go to .env, never into "
    + "config/mcp.json. Servers load into the orchestrator on the next agent start.",
  qa: "Checks finished images/videos against a QA briefing — an `agentY review` node with "
    + "the agent as its reviewer, a named file in briefing_dir, or /qa in the chat. With no "
    + "briefing nothing here runs. max_retries 0 reports the verdict without "
    + "re-generating; the judging model is the \"QA judge\" tier under "
    + "Models.",
  refine: "A refine loop is the agent running the workflow you have OPEN, judging "
    + "each output against a condition you stated, changing one value and going "
    + "again — “change the prompt until she is standing where she is in the "
    + "reference”. Every run is a real generation, so max_runs is a spend "
    + "ceiling: the agent may ask for fewer runs, never more. It judges with the "
    + "“QA judge” tier under Models.",
  tiers: "Every role takes its model from one of these tiers. Set them and you are "
    + "done — per-role overrides below are for the exceptions. 💭 turns reasoning on "
    + "for a tier: better decisions, slower and more tokens. Worth it for the Lead; "
    + "rarely for agents that make many quick tool calls.",
  pipeline: "Leave a role blank to inherit from its tier. Fill one in only when "
    + "that single job wants a different model from the rest of its tier.",
  memory: "Long-term memory. The store is always local FAISS. Its embedder is "
    + "chosen under Models; what rewrites a memory in its own words is the Fast "
    + "utility tier.",
  "Auxiliary models": "Models the agent loads itself, beside the language models "
    + "above: each does one small job. The ones that run through Ollama are "
    + "downloaded the first time they are needed.",
  decision: "Small models that answer one question with a probability instead of "
    + "writing: whether a request is about the graph that is open (router), and "
    + "whether a finished picture shows what its prompt asked for (prompt check). "
    + "They run through Ollama on this machine; \"auto\" uses them when Ollama is "
    + "there, \"off\" never.",
  annotate: "SAM3 finds a named thing in a picture, for the agent's own looking. "
    + "Blank paths are searched for in ComfyUI's models folder.",
  likeness: "Compares a face in a result with a face in a reference, for QA "
    + "checks that ask for the same person. Runs on the CPU.",
  Connections: "Where everything is reached. The address of each hosted provider is "
    + "listed once its key is set under Authentication - change one only for another "
    + "region or a gateway of your own. Below: ComfyUI's and Ollama's addresses, and how "
    + "local models are run.",
  Deadline: "Optional: render on a Thinkbox Deadline 10 farm instead of the local ComfyUI. "
    + "Empty fields use the defaults; saved to .env (see docs/setup/deadline.md).",
  ollama: "How local models are run. The window is the model's whole memory of a "
    + "call - what goes in and what comes out; the output allowance is taken from "
    + "it. Which model, and whether it reasons, is set on its row under Models.",
  embedder: "Used when \"Memory embedder\" under Models is set by hand. Blank "
    + "api_key_env falls back to the provider's usual variable. A change re-embeds "
    + "every stored memory (the old index is kept as a backup).",
  slack: "A SECOND way in, alongside this panel — never instead of it. Every turn "
    + "is mirrored to your Slack DM as it runs, INCLUDING the ones you start here, "
    + "so you can queue a render at the desk and watch it finish from a phone; a DM "
    + "back drives the same conversation this panel is in. Needs a Slack app of your "
    + "own: put its bot token (xoxb-…), an app-level token with connections:write "
    + "(xapp-…) and your Slack member id in the fields right here (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, "
    + "SLACK_ALLOWED_USERS), then turn `enabled` "
    + "on — it takes effect on the next agent start. The connection is outbound "
    + "(Socket Mode), so nothing here has to be reachable from the internet. "
    + "SLACK_ALLOWED_USERS is not optional: empty means every message is refused, "
    + "because anyone who can DM the bot could otherwise run generations and tools "
    + "on this machine. Full walkthrough in docs/setup/slack.md.",
};

// What a section is ABOUT, which decides its edge colour. Sections that mean the
// same kind of thing share one — the models live with the per-role overrides, the
// providers and their prices; memory with its writer and embedder — so the panel
// reads as a handful of subjects rather than eleven identically blue boxes. Keyed
// by section title or, for a nested group, by its settings key.
const GROUP_FAMILY = {
  models: "models", "per-role overrides": "models", providers: "models", pipeline: "models",
  "auxiliary models": "models", decision: "models", likeness: "models",
  ollama: "models", anthropic: "models", dashscope: "models", pricing: "models",
  connections: "connections", "files & logs": "connections", prompts: "connections",
  system_prompts: "connections",
  canvas: "canvas", annotation: "canvas", annotate: "canvas",
  "output checks": "checks", qa: "checks", refine: "checks",
  slack: "integrations", mcp: "integrations", deadline: "integrations", execution: "integrations",
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
  if (path.join(".") === "memory.embedder.preset" && EMBEDDERS.length) return;
  if (isHidden(path)) return;
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
  if (LEAF_LABELS[path.join(".")]) {
    label.textContent = LEAF_LABELS[path.join(".")];
    label.title = path.join(".");
  }
  if (typeof val === "boolean") {
    input = el("input", { type: "checkbox", className: "ays-input" });
    input.checked = val;
    refs.push({ path, get: () => input.checked });
  } else if (typeof val === "number") {
    // A setting whose stored value means "work it out" shows what that came to
    // (AUTO_VALUES); untouched, the file keeps its "work it out".
    const worked = AUTO_VALUES[path.join(".")];
    const shown = worked !== undefined ? worked : val;
    input = el("input", { type: "number", className: "ays-input", value: String(shown) });
    refs.push({ path, get: () => {
      const n = Number(input.value);
      if (input.value === "" || Number.isNaN(n)) return val;
      return n === shown ? val : n;
    } });
  } else if (ENUM_CHOICES[path.join(".")]) {
    const sel = el("select", { className: "ays-input" });
    const choices = ENUM_CHOICES[path.join(".")];
    const current = val == null ? "" : String(val);
    if (!choices.some(([v]) => v === current)) sel.append(el("option", { value: current, textContent: current || "(not set)" }));
    for (const [v, label] of choices) sel.append(el("option", { value: v, textContent: label }));
    sel.value = current;
    refs.push({ path, get: () => sel.value });
    input = sel;
  } else if (Array.isArray(val)) {
    input = el("input", { type: "text", className: "ays-input", value: JSON.stringify(val) });
    refs.push({ path, get: () => { try { return JSON.parse(input.value); } catch (_) { return val; } } });
  } else if (underPipeline && modelGroups && Object.keys(modelGroups).length) {
    // The Lead tier may be left blank too: it then runs on the orchestrator's model.
    const leadTier = path[1] === "tiers" && key === "lead";
    const sel = buildModelSelect(modelGroups, val == null ? "" : String(val), isOverride || leadTier);
    if (leadTier && sel.options[0] && sel.options[0].value === "") {
      sel.options[0].textContent = "— same as Orchestrator —";
    }
    refs.push({ path, get: () => sel.value });
    input = searchableSelect(sel, { placeholder: "Type a model name…",
                                    extraChoices: CUSTOM_PROVIDERS.length ? typedModelChoices : null });
  } else if (Array.isArray(AUX_CHOICES[path.join(".")]) && AUX_CHOICES[path.join(".")].length) {
    // A model the agent loads itself: picked from a list, like the others.
    const current = val == null ? "" : String(val);
    const sel = el("select", { className: "ays-input" });
    const choices = AUX_CHOICES[path.join(".")];
    if (!choices.some((c) => c.id === current)) sel.append(el("option", { value: current, textContent: current || "(not set)" }));
    for (const c of choices) sel.append(el("option", { value: c.id, textContent: c.label || c.id }));
    sel.value = current;
    refs.push({ path, get: () => sel.value });
    input = searchableSelect(sel, { placeholder: "Type a model name…" });
  } else {
    const stored = val == null ? "" : String(val);
    // A path: shown in full, as it comes to on this machine.
    const full = SETTING_DEFAULTS[path.join(".")] || "";
    const isPath = !!full && /[\\/]/.test(full) && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(full);
    const shown = isPath ? full : stored;
    input = el("input", { type: "text", className: "ays-input", value: shown });
    if (full && !isPath) { input.placeholder = full; input.title = "Blank: " + full; }
    if (isPath && shown !== stored) {
      input.title = stored ? `In the settings file: ${stored}` : "Blank in the settings file: this is where it comes to on this machine.";
    }
    // Untouched, the file keeps what it had.
    refs.push({ path, get: () => (input.value === shown ? stored : input.value) });
  }
  row.append(input);
  const think = thinkingControl(path, key, refs);
  if (think) row.append(think);
  field.append(row);
  const note = KEY_NOTES[path.join(".")] || KEY_NOTES[key];
  if (note) {
    field.classList.add("ays-hasnote");
    field.append(el("div", { className: "ays-note ays-keynote", textContent: note }));
  }
  container.append(field);
}

// Recursively render a settings object: nested objects become collapsed groups,
// leaves become rows. Used for group bodies (llm, memory, …) below the top level.
function buildSettingsForm(container, obj, modelGroups, pathPrefix, refs) {
  for (const [key, val] of Object.entries(obj)) {
    const path = pathPrefix.concat(key);
    if (isHidden(path)) continue;
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

function buildTopLevelSettings(container, settings, modelGroups, refs, envUrlRows, deadlineRows, slackRows) {
  const claimedScalars = new Set();
  const claimedObjects = new Set();      // joined settings paths, e.g. "llm.tiers"
  // What the page does not show is not a leftover either.
  for (const path of HIDDEN) claimedObjects.add(path);
  // Drawn as switches on the model rows (thinkingControl), not as groups.
  const llm = (settings && settings.llm) || {};
  THINKING = { tiers: llm.thinking || {}, roles: llm.thinking_roles || {} };
  claimedObjects.add("llm.thinking");
  claimedObjects.add("llm.thinking_roles");

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
      // ComfyUI's other model folders, under its own: shown, not edited.
      if (k === "comfyui_models_dir" && EXTRA_MODEL_DIRS.length) {
        const field = el("div", { className: "ays-field ays-hasnote" });
        EXTRA_MODEL_DIRS.forEach((dir, i) => {
          const input = el("input", { type: "text", className: "ays-input", value: dir });
          input.readOnly = true;
          field.append(el("div", { className: "ays-row" }, [
            el("label", { className: "ays-label", textContent: i ? "" : "comfyui_extra_model_dirs" }), input]));
        });
        field.append(el("div", { className: "ays-note ays-keynote", textContent:
          "The folders ComfyUI loads models from besides its own, as it reports them. They are ComfyUI's "
          + "extra model paths, set where ComfyUI is started - the agent reads them, it does not set them." }));
        body.append(field);
      }
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
        if (isHidden(inlinePath.concat(k))) continue;
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

    if (section.extra === "memoryEmbedder" && memoryEmbedderRow(body, settings, refs)) wrote = true;
    if (section.routing && routingRows(body, settings, modelGroups, refs)) wrote = true;

    // A group of groups: the models the agent loads besides the language models.
    if (section.aux) {
      const outer = makeCollapsibleGroup(section.aux.title, "", false);
      let any = false;
      for (const objPath of section.aux.objects) {
        const obj = pathValue(settings, objPath);
        claimedObjects.add(objPath.join("."));
        if (!obj) continue;
        const sub = makeCollapsibleGroup(objPath[objPath.length - 1], "", false);
        outer.body.append(sub.group);
        buildSettingsForm(sub.body, obj, modelGroups, objPath, refs);
        any = true;
      }
      if (any) { body.append(outer.group); wrote = true; }
    }

    // The providers' endpoints: .env variables, so they are saved with the keys.
    // They lead their section: put in front of what the loops above wrote.
    if (section.envUrls && envUrlRows && envUrlRows.length) {
      // (the section's note is already at the top: makeCollapsibleGroup put it there)
      const lead = body.firstChild;
      const first = lead && lead.classList && lead.classList.contains("ays-note") ? lead.nextSibling : lead;
      for (const row of envUrlRows) body.insertBefore(row, first);
      wrote = true;
    }
    if (section.deadline && deadlineRows && deadlineRows.length) {
      for (const row of deadlineRows) body.append(row);
      wrote = true;
    }
    if (section.slackEnv && slackRows && slackRows.length) {
      for (const row of slackRows) body.append(row);
      wrote = true;
    }
    if (section.extra === "mediaNodes" && mediaNodesRows(body, settings, refs)) {
      claimedObjects.add("media_nodes");
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
    const row = el("div", { className: "ays-prow" },
      [searchableSelect(sel, { placeholder: "Type a model name…" }), inp, outp, del]);
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

// DashScope: the keys and endpoints of the three kinds of access (pay-as-you-go, Token Plan,
// Coding Plan) are isolated per plan and region. This adds a plan/region picker (fills the URL
// input) and a Detect button (POST /agentY/dashscope/detect: one free GET /models per documented
// endpoint) beside a URL input; `getKey()` returns the key typed, "" to use the saved one.
function dashscopeEndpointTools(urlInp, endpoints, getKey, payg) {
  const result = el("div", { className: "ays-note" });
  const sel = el("select", { className: "ays-input" });
  sel.append(el("option", { value: "", textContent: "Plan and region..." }));
  for (const e of endpoints || []) sel.append(el("option", { value: e.url, textContent: e.label }));
  sel.addEventListener("change", () => { if (sel.value) { urlInp.value = sel.value; urlInp.dispatchEvent(new Event("input")); } });
  const btn = el("button", { className: "ays-btn", textContent: "Detect",
    title: "Find the endpoint that accepts this key (one free GET /models per documented endpoint)" });
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    result.textContent = "Detecting...";
    try {
      const j = await postJson("/agentY/dashscope/detect", { key: getKey(), payg: !!payg });
      if (j.ok) {
        urlInp.value = j.url;
        urlInp.dispatchEvent(new Event("input"));
        result.textContent = `✅ ${j.label}: ${j.url}` + (j.warning ? "  ⚠ " + j.warning : "");
      } else {
        result.textContent = "❌ " + (j.error || "failed");
      }
    } catch (err) {
      result.textContent = "❌ " + err;
    } finally {
      btn.disabled = false;
    }
  });
  return [el("div", { className: "ays-row" }, [el("label", { className: "ays-label", textContent: "Endpoint" }), sel, btn]), result];
}

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

// A preset's setup runs on the host as a job (downloads, an app starting can take minutes): start it,
// poll for the steps done so far, resolve with the final answer. `onSteps(rows)` paints the progress.
const SETUP_ICON = { done: "✅", skipped: "➖", needs_user: "👉", failed: "❌", planned: "📝" };
function setupLines(steps) {
  return (steps || []).map((s) => `${SETUP_ICON[s.status] || "•"} ${s.id}: ${s.message || s.status}`);
}
async function runPresetJob(payload, onSteps) {
  const j = await postJson("/agentY/mcp/presets/install", payload);
  if (!j.ok || !j.job) return j;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    let s;
    try { s = await (await fetch(backendBase() + "/agentY/mcp/presets/jobs/" + j.job)).json(); }
    catch (_) { continue; }
    if (onSteps) onSteps(s.steps || []);
    if (!s.running) return { ...(s.result || { ok: false, error: "the job ended without a result" }), _steps: s.steps };
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
    // Shown for a server that came from a preset with a setup recipe (see showSetup below).
    const setupBtn = el("button", { className: "ays-btn ays-sm", textContent: "Run setup",
      title: "Check everything the preset needs (app add-on, preferences, connection) and fix what is missing." });
    setupBtn.hidden = true;
    const editBtn = el("button", { className: "ays-btn ays-sm", textContent: isNew ? "Hide" : "Edit" });
    const delBtn = el("button", { className: "ays-btn ays-sm ays-x", textContent: "✕", title: "Remove this server" });
    const head = el("div", { className: "ays-mcphead" },
      [enabled, nameEl, summary, state, testBtn, authBtn, setupBtn, editBtn, delBtn]);

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

    setupBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      if (isNew) { details.hidden = false; result.textContent = "Save first, then run the setup."; return; }
      setupBtn.disabled = true;
      details.hidden = false;
      result.style.whiteSpace = "pre-wrap";
      result.textContent = "Checking…";
      try {
        const j = await runPresetJob({ id: name, secrets: {}, recheck: true },
          (steps) => { result.textContent = "Running the setup…\n" + setupLines(steps).join("\n"); });
        if (!j.ok) { result.textContent = "❌ " + (j.error || "the host refused it"); return; }
        const rep = j.report || { steps: j._steps || [], needs_user: j.needs_user || [] };
        const lines = [j.status === "done" ? "✅ Everything is in place." : j.status === "failed" ? "⚠️ Some steps failed." : "👉 Done, with something left for you."];
        lines.push(...setupLines(rep.steps));
        if (j.turn_id) lines.push("🤖 agentY is looking into the failed steps in the chat (\"MCP preset\" conversation).");
        result.textContent = lines.join("\n");
      } catch (err2) {
        result.textContent = "❌ " + err2;
      } finally {
        setupBtn.disabled = false;
      }
    });

    const row = {
      currentName, build,
      showSetup: (p) => { setupBtn.hidden = !(p && p.has_setup); },
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

  // ── add from the shared preset catalog (config/mcp_presets.json) ──
  // The host lists the presets (GET /agentY/mcp/presets) and installs one
  // (POST /agentY/mcp/presets/install): its keys go to .env, the entry into
  // config/mcp.json, the server is tested once, and when something outside the
  // config is left to do (setup steps, a bundle, a failed test) agentY is started
  // on it in the chat. A host without the route simply has no dropdown.
  let presets = [];
  const presetSel = el("select", { className: "ays-input" });
  const presetRow = el("div", { className: "ays-row" }, [presetSel]);
  presetRow.hidden = true;
  const presetBox = el("div", { className: "ays-mcpadd" });
  presetBox.hidden = true;
  const fillPresets = () => {
    const have = new Set(rows.map((r) => r.currentName()));
    presetSel.textContent = "";
    presetSel.append(el("option", { value: "", textContent: "Add from presets…" }));
    for (const p of presets) {
      if (p.installed || have.has(p.id)) continue;
      const d = p.description || "";
      presetSel.append(el("option", { value: p.id,
        textContent: `${p.name} · ${p.category}${d ? " - " + (d.length > 70 ? d.slice(0, 67) + "…" : d) : ""}` }));
    }
    presetRow.hidden = presetSel.options.length < 2;
  };
  const closePreset = () => { presetBox.hidden = true; presetBox.textContent = ""; presetSel.value = ""; };
  const showPreset = (p) => {
    presetBox.textContent = "";
    presetBox.hidden = false;
    const fields = {};
    const msg = el("div", { className: "ays-note" });
    const parts = [
      el("div", { className: "ays-bundlehead" }, [
        el("span", { className: "ays-mcpname", textContent: p.name }),
        el("span", { className: "ays-mcpsum", textContent: p.category }),
      ]),
      el("div", { className: "ays-note", textContent: p.description || "" }),
    ];
    if (p.has_setup) {
      parts.push(el("div", { className: "ays-note ays-warn", textContent: "This one needs more than a config entry: "
        + "Install runs its setup for you (downloads, the add-on inside the app, its preferences, a connection test). "
        + "What only you can do (start the app, a licence, a key) is listed afterwards. Nothing is started or installed system-wide." }));
    } else if (p.needs_bundle || p.setup_steps) {
      parts.push(el("div", { className: "ays-note ays-warn", textContent: "This one needs more than a config entry"
        + (p.needs_bundle ? " (its .mcpb bundle is not installed)" : "")
        + ". After Install, agentY finishes the setup for you in the chat." }));
    }
    if (p.notes) parts.push(el("div", { className: "ays-note", textContent: p.notes }));
    for (const k of p.env_keys || []) {
      const stored = envSet.has(k.key);
      const input = el("input", { className: "ays-input", type: "password", autocomplete: "off",
        placeholder: stored ? "already in .env - leave blank to keep" : (k.optional ? "optional" : "required") });
      fields[k.key] = { input, meta: k, stored };
      const label = el("div", { className: "ays-row" }, [
        el("span", { className: "ays-mcpsum", textContent: k.label || k.key }),
        k.help_url ? el("a", { href: k.help_url, target: "_blank", rel: "noopener", textContent: "get a key" }) : null,
      ]);
      parts.push(label, input);
    }
    const go = el("button", { className: "ays-btn primary ays-sm", textContent: "Install" });
    const cancel = el("button", { className: "ays-btn ays-sm", textContent: "Cancel" });
    cancel.addEventListener("click", (e) => { e.preventDefault(); closePreset(); });
    go.addEventListener("click", async (e) => {
      e.preventDefault();
      const secrets = {};
      for (const [key, f] of Object.entries(fields)) {
        const v = f.input.value.trim();
        if (v) secrets[key] = v;
        else if (!f.meta.optional && !f.stored) { msg.textContent = `❌ ${f.meta.label || key} is needed`; return; }
      }
      go.disabled = true; cancel.disabled = true;
      msg.textContent = "Installing and testing…";
      try {
        msg.style.whiteSpace = "pre-wrap";
        const j = await runPresetJob({ id: p.id, secrets },
          (steps) => { msg.textContent = "Setting it up…\n" + setupLines(steps).join("\n"); });
        if (!j.ok) {
          msg.textContent = "❌ " + (j.error || "the host refused it")
            + ((j.needs_user || []).length ? "\n👉 " + j.needs_user.join("\n👉 ") : "");
          return;
        }
        for (const k of Object.keys(secrets)) envSet.add(k);
        const lines = [];
        if (j.report) {
          const done = j.status === "done";
          lines.push(done ? `✅ ${p.name} is set up and connected (${(j.test && j.test.tools) || 0} tools).`
            : j.status === "failed" ? `⚠️ ${p.name}: some steps failed.`
            : `✅ ${p.name} is added. Left for you:`);
          lines.push(...setupLines(j.report.steps));
          for (const t of j.needs_user || []) lines.push("👉 " + t);
        } else if (j.state === "needs_bundle") lines.push("⏳ Not added yet: the server's .mcpb bundle is not installed.");
        else if (j.test && j.test.ok) lines.push(`✅ ${p.name} added and connected (${j.test.tools} tools).`);
        else if (j.test && j.test.needs_auth) lines.push(`✅ ${p.name} added. It signs in through the browser: press Authorize… on its card.`);
        else lines.push(`⚠️ ${p.name} added, but the test failed: ${(j.test && j.test.error) || "unknown error"}`);
        if (j.turn_id) lines.push("🤖 agentY is finishing the setup in the chat (a new conversation, \"MCP preset: " + p.name + "\"). Watch it there.");
        else if (j.turn_error) lines.push("agentY could not be started on it: " + j.turn_error);
        msg.textContent = lines.join("\n");
        msg.style.whiteSpace = "pre-wrap";
        p.installed = true;
        if (j.state === "added") {
          // The card of the server as the host wrote it (placeholders filled in).
          try {
            const cfg = await (await fetch(backendBase() + "/agentY/mcp")).json();
            const sc = cfg && cfg.config && cfg.config.servers && cfg.config.servers[p.id];
            if (sc) {
              addRow(p.id, sc);
              rows[rows.length - 1].showSetup(p);
              // Written by the host already: it is not an unsaved change of this form.
              savedServers = JSON.stringify({ ...JSON.parse(savedServers || "{}"), [p.id]: rows[rows.length - 1].build().sc });
            }
          } catch (_) { /* the card appears after reopening Settings */ }
        }
        fillPresets();
        go.hidden = true; cancel.textContent = "Close"; cancel.disabled = false;
      } catch (err2) {
        msg.textContent = "❌ " + err2;
        go.disabled = false; cancel.disabled = false;
      }
    });
    parts.push(el("div", { className: "ays-row" }, [go, cancel]), msg);
    presetBox.append(...parts);
  };
  presetSel.addEventListener("change", () => {
    const p = presets.find((x) => x.id === presetSel.value);
    if (p) showPreset(p); else closePreset();
  });
  (async () => {
    try {
      const r = await fetch(backendBase() + "/agentY/mcp/presets");
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.ok) {
        presets = j.presets || []; fillPresets();
        for (const r of rows) r.showSetup(presets.find((x) => x.id === r.currentName()));
      }
    } catch (_) { /* a host from before presets: no dropdown */ }
  })();

  body.append(list, el("div", { className: "ays-btnrow" }, [addBtn, bundleBtn]), presetRow, presetBox, bundleInput, addBox, bundleBox, err);

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
  // Set when the host did not answer and the settings were read from its files
  // instead (ComfyUI's /agent/offline_settings runs the checkout's own reader).
  // A host that will not start because of a setting has to be fixable from here.
  let offline = null;
  try {
    const r = await fetch(backendBase() + "/agentY/settings");
    if (!r.ok) throw new Error("HTTP " + r.status);
    data = await r.json();
  } catch (e) {
    try {
      const ro = await fetch("/agent/offline_settings");
      const jo = await ro.json();
      if (!jo.ok || !jo.settings) throw new Error(jo.error || ("HTTP " + ro.status));
      data = jo.settings;
      offline = { root: jo.root || "", mcp: jo.mcp || null };
    } catch (e2) {
      alert("Could not load agentY settings.\n\nThe chat host does not answer (" + e + "),\n"
        + "and its settings could not be read from disk either:\n" + (e2.message || e2));
      return;
    }
  }

  // MCP servers (config/mcp.json + per-server status). Best-effort — the section
  // is simply omitted if the host predates the /agentY/mcp route.
  let mcpData = null;
  if (offline) {
    mcpData = offline.mcp;
  } else {
    try {
      const rm = await fetch(backendBase() + "/agentY/mcp");
      if (rm.ok) mcpData = await rm.json();
    } catch (_) { /* no MCP route on this host — skip the section */ }
  }

  const overlay = el("div", { className: "ays-overlay" });
  const body = el("div", { className: "ays-body" });
  if (offline) {
    body.append(el("div", { className: "ays-note ays-warn ays-offline", textContent:
      "agentY is not running. These are its settings as they are on disk; saving writes "
      + "the files, and they apply when agentY next starts. Viewers, and testing or adding "
      + "MCP servers, need it running." }));
  }

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
  const envRemove = new Set();          // keys to take out of .env on Save
  const envSec = el("div", { className: "ays-sec" });
  envSec.append(el("h3", { textContent: "Authentication (.env)" }));
  envSec.append(el("div", { className: "ays-note", textContent:
    "API keys, stored in .env on the agent host. Only keys that are set are " +
    "listed, masked — the host does not send them back. Type over one to " +
    "replace it; leave it alone and it stays as it is. Use + Add API key to set another." }));

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
  //
  // Only what is set is listed (add a key with "+ Add API key"). The endpoints are
  // addresses and go to Connections - there, for a provider whose key is set or
  // whose endpoint is in .env. The host seeds each endpoint with its default, so
  // "set" is read from env_file_keys, not from the value.
  const envNow = data.env || {};
  RESERVED_PROVIDERS = new Set(Array.isArray(data.reserved_providers) ? data.reserved_providers : []);
  const fileKeys = Array.isArray(data.env_file_keys) ? new Set(data.env_file_keys) : null;
  const envUrlRows = [];
  const deadlineRows = [];
  const slackRows = [];
  // Registered OpenAI-compatible providers: one row each under Connections, with
  // the URL (an .env variable), Test and Remove. Remove drops the registry entry
  // on Save; the keys stay in .env until removed above.
  CUSTOM_PROVIDERS = Array.isArray(data.custom_providers) ? data.custom_providers : [];
  const customUrlEnvs = new Set(CUSTOM_PROVIDERS.map((p) => p.url_env));
  const customRemove = new Set();
  for (const p of CUSTOM_PROVIDERS) {
    const cur = envNow[p.url_env] || "";
    const inp = el("input", { className: "ays-input", type: "text", value: cur,
                              placeholder: p.url_env });
    envInputs[p.url_env] = { input: inp, original: cur };
    const label = el("label", { className: "ays-label", textContent: p.label,
                                title: `${p.id} - OpenAI-compatible; key ${p.key_env}, URL ${p.url_env}` });
    const result = el("span", { className: "ays-note", style: { marginLeft: "6px" } });
    const test = el("button", { className: "ays-btn", textContent: "Test",
                                title: "GET /models with the saved key and URL" });
    test.addEventListener("click", async (e) => {
      e.preventDefault();
      test.disabled = true;
      result.textContent = "Testing…";
      try {
        const j = await postJson("/agentY/custom_provider/test", { id: p.id });
        result.textContent = j.ok ? `✅ ${j.count} model(s)` : "❌ " + (j.error || "failed");
      } catch (err) {
        result.textContent = "❌ " + err;
      } finally {
        test.disabled = false;
      }
    });
    const rm = el("button", { className: "ays-btn", textContent: "Remove",
                              title: "Take this provider out of the settings when you save (its keys stay in .env)" });
    const row = el("div", { className: "ays-row" }, [label, inp, test, rm]);
    rm.addEventListener("click", (e) => {
      e.preventDefault();
      const off = !customRemove.has(p.id);
      if (off) customRemove.add(p.id); else customRemove.delete(p.id);
      rm.textContent = off ? "Keep" : "Remove";
      row.style.opacity = off ? "0.45" : "";
      label.style.textDecoration = off ? "line-through" : "";
    });
    envUrlRows.push(el("div", { className: "ays-field" }, [row, result]));
  }
  // One .env field: its label (with the key's age once watched), its input, and a
  // Remove button that the "− Remove auth key" toggle shows. Authentication and the
  // Slack section take the same variables, so they share it.
  const envRmButtons = [];                // every Remove button here, toggled together
  const envField = (key, cur) => {
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
    const row = el("div", { className: "ays-row" }, [label, inp]);
    // "Remove auth key" puts a button on every key that is set; pressing it
    // marks the key, and Save takes its line out of .env.
    const rm = el("button", { className: "ays-btn ays-envrm", textContent: "Remove", title: `Take ${key} out of .env when you save` });
    rm.style.display = "none";
    rm.addEventListener("click", (e) => {
      e.preventDefault();
      const off = !envRemove.has(key);
      if (off) envRemove.add(key); else envRemove.delete(key);
      rm.textContent = off ? "Keep" : "Remove";
      inp.disabled = off;
      row.style.opacity = off ? "0.45" : "";
      label.style.textDecoration = off ? "line-through" : "";
    });
    row.append(rm);
    envRmButtons.push(rm);
    return row;
  };
  // The Slack bridge's variables: their own section, shown even when empty.
  for (const key of SLACK_KEYS) slackRows.push(envField(key, envNow[key] || ""));
  for (const key of DEADLINE_KEYS) {
    const cur = envNow[key] || "";
    const inp = el("input", { className: "ays-input", type: "text", value: cur });
    envInputs[key] = { input: inp, original: cur };
    deadlineRows.push(el("div", { className: "ays-field" }, [
      el("div", { className: "ays-row" }, [el("label", { className: "ays-label", textContent: key }), inp])]));
  }
  for (const key of data.env_keys || Object.keys(envNow)) {
    if (DEADLINE_KEYS.includes(key) || SLACK_KEYS.includes(key)) continue;
    if (customUrlEnvs.has(key)) continue;          // shown with its provider, below
    const cur = envNow[key] || "";
    if (isProviderUrl(key)) {
      const own = fileKeys ? fileKeys.has(key) : !!cur;
      if (!own && !envNow[key.replace(/_BASE_URL$/, "_API_KEY")]) continue;
      // An endpoint is an address, not a secret: it goes under "Connections".
      const inp = el("input", { className: "ays-input", type: "text", value: cur });
      envInputs[key] = { input: inp, original: cur };
      const urlField = el("div", { className: "ays-field" }, [el("div", { className: "ays-row" }, [
        el("label", { className: "ays-label", textContent: key }), inp])]);
      if (/^DASHSCOPE(_PAYG)?_BASE_URL$/.test(key)) {
        const ds = (Array.isArray(data.services) ? data.services : []).find((x) => x.id === "dashscope");
        const keyEnv = key === "DASHSCOPE_BASE_URL" ? "DASHSCOPE_API_KEY" : "DASHSCOPE_PAYG_API_KEY";
        urlField.append(...dashscopeEndpointTools(inp, ds ? ds.endpoints : [],
          () => { const k = envInputs[keyEnv]; return k && k.input.value !== k.original ? k.input.value : ""; }, key === "DASHSCOPE_PAYG_BASE_URL"));
      }
      envUrlRows.push(urlField);
      continue;
    }
    if (!cur) continue;                            // not set: nothing to show
    envSec.append(envField(key, cur));
  }
  // Add a key by naming the SERVICE: the host's catalogue knows each one's
  // variables and default endpoint; "Other service..." derives them from a name.
  // The host writes them to .env and applies them to the live process, so an MCP
  // server that references ${THE_KEY} has it on the next agent start.
  const services = Array.isArray(data.services) ? data.services : [];
  const addKeyRows = [];                 // each: { collect: () => {ENV: value} }
  const addKeysWrap = el("div", {});
  const OTHER = "__other__";
  const addAKeyRow = () => {
    // Slack has its own section (below), so it is not offered as a service here.
    const open = services.filter((sv) => sv.id !== "slack" && !envNow[sv.key_env]);
    const sel = el("select", { className: "ays-input" });
    sel.append(el("option", { value: "", textContent: "Choose a service…" }));
    for (const sv of open) sel.append(el("option", { value: sv.id, textContent: sv.label }));
    sel.append(el("option", { value: OTHER, textContent: "Other service…" }));
    const detail = el("div", {});
    const card = el("div", { className: "ays-field" }, [
      el("div", { className: "ays-row" }, [el("label", { className: "ays-label", textContent: "Service" }), sel]), detail]);
    const entry = { collect: () => ({}), provider: () => null };
    const field = (label, type, placeholder, value) => {
      const inp = el("input", { className: "ays-input", type, placeholder: placeholder || "", value: value || "" });
      detail.append(el("div", { className: "ays-row" }, [el("label", { className: "ays-label", textContent: label }), inp]));
      return inp;
    };
    sel.addEventListener("change", () => {
      detail.textContent = "";
      entry.collect = () => ({});
      entry.provider = () => null;
      const sv = services.find((x) => x.id === sel.value);
      if (sel.value === OTHER) {
        const nameInp = field("Service name", "text", "e.g. Mercury");
        const keyInp = field("API key", "password", "");
        const urlInp = field("Server URL", "text", "e.g. https://api.mercury.example/v1");
        const asLlm = el("input", { type: "checkbox" });
        const visionBox = el("input", { type: "checkbox" });
        const llmRow = el("div", { className: "ays-row" }, [
          el("label", { className: "ays-label", textContent: "LLM provider" }),
          el("label", {}, [asLlm, " OpenAI-compatible LLM provider"])]);
        const visRow = el("div", { className: "ays-row" }, [
          el("label", { className: "ays-label", textContent: "" }),
          el("label", {}, [visionBox, " can read images"])]);
        detail.append(llmRow, visRow);
        const names = el("div", { className: "ays-note" });
        detail.append(names);
        const derive = () => {
          const n = serviceEnvNames(nameInp.value);
          names.textContent = n
            ? `Saved as ${n.key}` + (urlInp.value.trim() ? ` and ${n.url}` : ` (and ${n.url} if you give a URL)`)
              + " - an MCP config refers to them as ${" + n.key + "}."
            : (nameInp.value.trim() ? "The name must start with a letter."
               : "Names the .env variables: <NAME>_API_KEY and <NAME>_BASE_URL.");
          const url = urlInp.value.trim();
          llmRow.style.opacity = visRow.style.opacity = "";
          visionBox.disabled = !asLlm.checked || !url;
          if (visionBox.disabled) visionBox.checked = false;
          if (asLlm.checked && n && !url) names.textContent += " A provider needs its server URL.";
          if (asLlm.checked && n && RESERVED_PROVIDERS.has(providerId(nameInp.value))) {
            names.textContent += ` "${providerId(nameInp.value)}" is a built-in provider name: use another service name.`;
          }
          return n;
        };
        for (const x of [nameInp, urlInp, asLlm]) { x.addEventListener("input", derive); x.addEventListener("change", derive); }
        derive();
        entry.provider = () => {
          const n = serviceEnvNames(nameInp.value);
          const url = urlInp.value.trim();
          if (!asLlm.checked || !n || !url || !keyInp.value) return null;
          const id = providerId(nameInp.value);
          if (RESERVED_PROVIDERS.has(id)) return { error: `"${id}" is a built-in provider name` };
          return { id, entry: { label: nameInp.value.trim(), key_env: n.key, url_env: n.url, vision: !!visionBox.checked } };
        };
        entry.collect = () => {
          const n = serviceEnvNames(nameInp.value);
          const out = {};
          if (!n || !keyInp.value) return out;
          out[n.key] = keyInp.value;
          if (urlInp.value.trim()) out[n.url] = urlInp.value.trim();
          return out;
        };
      } else if (sv) {
        const keyInp = field(sv.key_env, isSecret(sv.key_env) ? "password" : "text", "");
        const extra = (sv.fields || []).map((f) => [f, field(f.label || f.env, f.secret ? "password" : "text", "")]);
        const urlInp = sv.url_env ? field("Server URL", "text", "", sv.default_url || "") : null;
        const hint = [sv.hint, sv.help_url ? `Get a key: ${sv.help_url}` : ""].filter(Boolean).join(" ");
        if (hint) detail.append(el("div", { className: "ays-note", textContent: hint }));
        if (urlInp && (sv.endpoints || []).length) {
          detail.append(...dashscopeEndpointTools(urlInp, sv.endpoints, () => keyInp.value));
        }
        entry.collect = () => {
          const out = {};
          if (!keyInp.value) return out;
          out[sv.key_env] = keyInp.value;
          for (const [f, inp] of extra) if (inp.value) out[f.env] = inp.value;
          const u = urlInp ? urlInp.value.trim() : "";
          if (u && u !== (sv.default_url || "")) out[sv.url_env] = u;
          return out;
        };
      }
    });
    addKeyRows.push(entry);
    addKeysWrap.append(card);
  };
  const addKeyBtn = el("button", { className: "ays-btn", textContent: "+ Add API key" });
  addKeyBtn.addEventListener("click", (e) => { e.preventDefault(); addAKeyRow(); });
  const rmKeyBtn = el("button", { className: "ays-btn", textContent: "\u2212 Remove auth key",
    title: "Show a Remove button on every key that is set. A key you mark is taken out of .env when you save." });
  rmKeyBtn.style.marginLeft = "6px";
  rmKeyBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const show = !rmKeyBtn.classList.contains("primary");
    rmKeyBtn.classList.toggle("primary", show);
    for (const b of envRmButtons) b.style.display = show ? "" : "none";
  });
  envSec.append(addKeysWrap, addKeyBtn, rmKeyBtn);
  body.append(envSec);

  // ── settings.json section ──
  const refs = [];
  const setSec = el("div", { className: "ays-sec" });
  setSec.append(el("h3", { textContent: "Application settings (config/settings.json)" }));
  setSec.append(el("div", { className: "ays-note", textContent: "Models, connections and behaviour. Comments are preserved on save; only changed values are written." }));
  // The host could not read its committed defaults, so what follows is only this
  // machine's overrides. Said up front, or a section with one checkbox in it just
  // looks like the settings went missing.
  if (data.settings_problem) {
    setSec.append(el("div", { className: "ays-note ays-err",
      textContent: "⚠ Most settings are missing below, because the agentY host could not load its defaults. "
        + data.settings_problem }));
  }
  const setForm = el("div");
  TIER_LABELS = data.tier_labels || {};
  SETTING_DEFAULTS = (data.setting_defaults && typeof data.setting_defaults === "object") ? data.setting_defaults : {};
  AUX_CHOICES = (data.aux_model_choices && typeof data.aux_model_choices === "object") ? data.aux_model_choices : {};
  EXTRA_MODEL_DIRS = Array.isArray(data.comfyui_extra_model_dirs) ? data.comfyui_extra_model_dirs : [];
  // The window's note says what "0" came to on this machine.
  const win = data.ollama_window || {};
  AUTO_VALUES = {};
  if (win.auto && Number(win.window) > 0) AUTO_VALUES["llm.ollama.num_ctx"] = Number(win.window);
  KEY_NOTES["llm.ollama.num_ctx"] = "How many tokens a local model holds at once: what goes into a call and what "
    + "comes out of it. "
    + (win.auto && win.window
      ? "This number was worked out at startup" + (win.why ? ` (${win.why})` : "") + ": the largest window, up to the "
        + "model's own, with which the largest local model the agents use still fits the graphics card. Type a number "
        + "to fix it yourself; -1 goes back to working it out. "
      : "Set by hand. -1 has it worked out at startup: the largest window, up to the model's own, with which the "
        + "largest local model the agents use still fits the graphics card. ")
    + "It is not simply the model's own window: Ollama sets aside memory for the whole window when it loads the "
    + "model, used or not, and a model that no longer fits the card runs on the CPU.";
  if (win.output_auto && Number(win.output) > 0) AUTO_VALUES["llm.ollama.max_tokens"] = Number(win.output);
  KEY_NOTES["llm.ollama.max_tokens"] = "The most a local model may write in one answer. "
    + (win.output_auto && win.output
      ? "This number was worked out from the window: 16,384, or a quarter of a smaller window. Type a number to fix "
        + "it yourself; -1 goes back to working it out. "
      : "Set by hand; -1 has it worked out from the window. ")
    + "It is taken OUT of the window - what a call may send is the window less this - so a larger number does not "
    + "make answers longer, it leaves the model less room for what it is sent.";
  EMBEDDERS = Array.isArray(data.memory_embedders) ? data.memory_embedders : [];
  MEDIA_NODES = (data.media_node_choices && typeof data.media_node_choices === "object")
    ? data.media_node_choices : {};
  buildTopLevelSettings(setForm, data.settings || {}, data.model_groups || {}, refs, envUrlRows, deadlineRows, slackRows);

  // Advanced groups (prompt-file pointers, per-provider tuning, embedder internals)
  // stay hidden until asked for. They are real settings, not clutter — but showing
  // them by default buries the handful anyone actually changes.
  const advToggle = el("input", { type: "checkbox" });
  const advWrap = el("label", {
    className: "ays-note",
    style: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" },
  }, [advToggle, document.createTextNode("Show advanced settings (memory, files and logs)")]);
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

  // What only a running host can do is switched off rather than left to fail.
  if (offline) {
    const needsHost = new Set(["Test", "Authorize…", "+ Add MCP server", "Install bundle (.mcpb)…"]);
    const off = (b) => { b.disabled = true; b.title = "Needs agentY running."; };
    toolsSec.querySelectorAll("button").forEach(off);
    if (mcp) mcp.group.querySelectorAll("button").forEach((b) => { if (needsHost.has(b.textContent.trim())) off(b); });
  }

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
      if (envRemove.has(key)) continue;
      if (input.value !== original) envChanges[key] = input.value;
    }
    for (const entry of addKeyRows) Object.assign(envChanges, entry.collect());
    const cpAdd = {};
    for (const entry of addKeyRows) {
      const pr = entry.provider();
      if (pr && pr.error) { msg.textContent = "❌ " + pr.error; saveBtn.disabled = false; return; }
      if (pr) cpAdd[pr.id] = pr.entry;
    }
    const priceOut = pricing.collect();
    pricing.err.textContent = priceOut.error ? "Not saved: " + priceOut.error : "";
    const mcpOut = mcp ? mcp.collect() : null;
    if (mcp) mcp.err.textContent = mcpOut.error ? "Not saved: " + mcpOut.error : "";
    // A server's keys are .env variables like any other, written before the
    // server that references them.
    if (mcpOut && !mcpOut.error) Object.assign(envChanges, mcpOut.secrets);
    const payload = { env: envChanges, settings: collectSettings(refs) };
    if (envRemove.size) payload.env_remove = [...envRemove];
    if (Object.keys(cpAdd).length || customRemove.size) {
      payload.custom_providers = { add: cpAdd, remove: [...customRemove] };
    }
    if (priceOut.payload && priceOut.changed) payload.pricing = priceOut.payload;
    try {
      // Offline, the MCP config rides in the same save: one process writes all
      // the files, instead of a second round trip to a host that is not there.
      const mcpChanged = !!(mcpOut && !mcpOut.error && mcpOut.changed);
      if (offline && mcpChanged) payload.mcp_config = mcpOut.config;
      const r = await fetch(offline ? "/agent/offline_settings" : backendBase() + "/agentY/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "save failed");
      if (j.pricing_updated) pricing.markSaved();
      let mcpSaved = false;
      if (offline) {
        mcpSaved = !!j.mcp_saved;
        if (mcpSaved) mcp.markSaved();
      } else if (mcpChanged) {
        try {
          const jm = await postJson("/agentY/mcp", { config: mcpOut.config });
          mcpSaved = !!jm.ok;
          if (mcpSaved) mcp.markSaved();
          else mcp.err.textContent = "Not saved: " + (jm.error || "the host refused it");
        } catch (_) { /* leave mcpSaved false */ }
      }
      const parts = [];
      if (j.env_updated && j.env_updated.length) parts.push(`${j.env_updated.length} auth key(s)`);
      if (j.custom_providers_added && j.custom_providers_added.length) parts.push(`provider ${j.custom_providers_added.join(", ")}`);
      if (j.custom_providers_removed && j.custom_providers_removed.length) parts.push(`removed provider ${j.custom_providers_removed.join(", ")}`);
      if (j.custom_providers_rejected) {
        throw new Error(Object.entries(j.custom_providers_rejected).map(([k, v]) => `${k}: ${v}`).join("; "));
      }
      if (j.settings_updated && j.settings_updated.length) parts.push(`${j.settings_updated.length} setting(s)`);
      if (j.pricing_updated) parts.push("pricing");
      if (mcpSaved) parts.push("MCP servers");
      msg.textContent = !parts.length ? "No changes to save."
        : offline ? "✅ Saved " + parts.join(", ") + " to agentY's files. They apply when it starts."
        : "✅ Saved " + parts.join(", ") + ". Model & MCP changes apply on the next agent start.";
      // Refresh originals so a second save doesn't re-send unchanged keys.
      for (const [key, o] of Object.entries(envInputs)) o.original = o.input.value;
      addKeyRows.length = 0;
      addKeysWrap.textContent = "";        // the keys just added are in .env; reopen Settings to see them listed
    } catch (e) {
      msg.textContent = "❌ " + e;
    } finally {
      saveBtn.disabled = false;
    }
  });

  const foot = el("div", { className: "ays-foot" }, [msg, saveBtn]);
  // Which host these settings came from. A browser can keep talking to another
  // host than the one just updated (a pinned address outranks discovery while it
  // answers), and then the form is another host's without saying so.
  const host = data.host || {};
  const hostLine = el("div", {
    className: "ays-hostline",
    textContent: offline
      ? `not running · ${offline.root || host.root || ""}${host.commit ? " · " + host.commit : ""}`
      : host.root
      ? `${backendBase()} · ${host.root}${host.commit ? " · " + host.commit : ""}`
      : `${backendBase()} · this host is older than the panel: update and restart it`,
    title: "The agentY host these settings come from. If this is not the checkout you "
      + "updated, another host is answering (check localStorage.agentY_backend).",
  });
  if (!host.root) hostLine.classList.add("ays-err");
  const card = el("div", { className: "ays-card" }, [
    el("div", { className: "ays-head" }, [el("h2", { textContent: "agentY — Application Settings" }), hostLine]),
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
