import { app } from "../../scripts/app.js";

// agentY Application Settings — adds an entry to the ComfyUI Settings panel that
// opens a modal for editing the agent's auth keys (.env) and everything in
// config/settings.json. Reads/writes go through the agentY chat host
// (src/utils/agentY_server.py: GET/POST /agentY/settings). The settings.json
// save is comment-preserving (only changed leaves are rewritten).

const DEFAULT_PORT = 5000;
function backendBase() {
  return (
    localStorage.getItem("agentY_backend") ||
    `http://${location.hostname || "127.0.0.1"}:${DEFAULT_PORT}`
  );
}

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
const SETTINGS_GROUPS = [
  ["Connections", ["comfyui_url", "agent_server_url"]],
  ["ComfyUI paths", ["comfyui_models_dir", "comfyui_user_dir", "comfyui_custom_templates_dir"]],
  ["agentY output & logs", ["output_dir", "output_workflows_dir", "conversation_db", "message_history_log", "tokens_usage_log"]],
  ["Behaviour", ["autoload_workflows_into_canvas"]],
];

function injectStyles() {
  if (document.getElementById("agentY-settings-styles")) return;
  const css = `
  .ays-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;
    align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;}
  .ays-card{background:#262624;color:#f2f0ea;border:1px solid rgba(240,235,225,.12);border-radius:14px;
    width:min(720px,92vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.6);}
  .ays-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid rgba(240,235,225,.10);}
  .ays-head h2{font-size:15px;margin:0;font-weight:650;flex:1;}
  .ays-body{padding:14px 18px;overflow:auto;}
  .ays-foot{display:flex;gap:10px;justify-content:flex-end;padding:12px 18px;border-top:1px solid rgba(240,235,225,.10);}
  .ays-sec{margin-bottom:18px;}
  .ays-sec>h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#a8a39a;margin:0 0 8px;}
  .ays-row{display:flex;align-items:center;gap:10px;padding:4px 0;}
  .ays-label{flex:0 0 42%;font-size:12.5px;color:#d7d2c8;word-break:break-word;font-family:ui-monospace,monospace;}
  .ays-input{flex:1;min-width:0;background:#302f2c;color:#f2f0ea;border:1px solid rgba(240,235,225,.14);
    border-radius:8px;padding:6px 9px;font-size:12.5px;outline:none;}
  .ays-input:focus{border-color:rgba(91,155,245,.6);}
  input.ays-input[type=checkbox]{flex:0 0 auto;width:16px;height:16px;accent-color:#5b9bf5;}
  .ays-group{border:1px solid rgba(240,235,225,.10);border-radius:10px;margin:8px 0;overflow:hidden;}
  .ays-grouphead{background:#302f2c;padding:7px 12px;font-size:12px;font-weight:600;color:#e9c9b6;
    font-family:ui-monospace,monospace;cursor:pointer;}
  .ays-groupbody{padding:6px 12px;}
  .ays-btn{background:#3b3936;color:#f2f0ea;border:1px solid rgba(240,235,225,.14);border-radius:9px;
    padding:8px 16px;cursor:pointer;font-size:12.5px;}
  .ays-btn:hover{background:#464440;}
  .ays-btn.primary{background:#5b9bf5;color:#0a1a30;border-color:transparent;font-weight:650;}
  .ays-btn.primary:hover{background:#4785e6;}
  .ays-note{font-size:11.5px;color:#a8a39a;margin:2px 0 10px;}
  .ays-msg{font-size:12px;margin-right:auto;align-self:center;}
  .ays-toggle{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#a8a39a;margin-bottom:8px;cursor:pointer;}
  `;
  document.head.append(el("style", { id: "agentY-settings-styles", textContent: css }));
}

function buildModelSelect(groups, current) {
  const sel = el("select", { className: "ays-input" });
  let matched = false;
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
  if (!matched) {
    const o = el("option", { value: current, textContent: current + "  (current)" });
    o.selected = true;
    sel.insertBefore(o, sel.firstChild);
  }
  return sel;
}

// A collapsible group, COLLAPSED by default (item 2: settings start folded).
function makeCollapsibleGroup(title) {
  const body = el("div", { className: "ays-groupbody", style: { display: "none" } });
  const head = el("div", { className: "ays-grouphead", textContent: "▸ " + title });
  head.addEventListener("click", () => {
    const hidden = body.style.display === "none";
    body.style.display = hidden ? "" : "none";
    head.textContent = (hidden ? "▾ " : "▸ ") + title;
  });
  return { group: el("div", { className: "ays-group" }, [head, body]), body };
}

// Render one leaf setting (scalar / array / model-select) as a labelled row and
// register its ref for save-time collection.
function renderLeafRow(container, key, val, path, modelGroups, refs) {
  const row = el("div", { className: "ays-row" });
  row.append(el("label", { className: "ays-label", textContent: key }));
  let input;
  const underPipeline = path[0] === "llm" && path[1] === "pipeline";
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
    input = buildModelSelect(modelGroups, val == null ? "" : String(val));
    refs.push({ path, get: () => input.value });
  } else {
    input = el("input", { type: "text", className: "ays-input", value: val == null ? "" : String(val) });
    refs.push({ path, get: () => input.value });
  }
  row.append(input);
  container.append(row);
}

// Recursively render a settings object: nested objects become collapsed groups,
// leaves become rows. Used for group bodies (llm, memory, …) below the top level.
function buildSettingsForm(container, obj, modelGroups, pathPrefix, refs) {
  for (const [key, val] of Object.entries(obj)) {
    const path = pathPrefix.concat(key);
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const { group, body } = makeCollapsibleGroup(key);
      container.append(group);
      buildSettingsForm(body, val, modelGroups, path, refs);
    } else {
      renderLeafRow(container, key, val, path, modelGroups, refs);
    }
  }
}

// Top-level render: bucket the flat scalar leaves into the meaningful SETTINGS_GROUPS
// (plus an "Other" catch-all), and give each object-valued key its own group. Every
// group is collapsed by default.
function buildTopLevelSettings(container, settings, modelGroups, refs) {
  const scalars = {};
  const objects = {};
  for (const [k, v] of Object.entries(settings)) {
    if (v && typeof v === "object" && !Array.isArray(v)) objects[k] = v;
    else scalars[k] = v;
  }
  const used = new Set();
  for (const [title, keys] of SETTINGS_GROUPS) {
    const present = keys.filter((k) => k in scalars);
    if (!present.length) continue;
    const { group, body } = makeCollapsibleGroup(title);
    container.append(group);
    for (const k of present) { renderLeafRow(body, k, scalars[k], [k], modelGroups, refs); used.add(k); }
  }
  const leftover = Object.keys(scalars).filter((k) => !used.has(k));
  if (leftover.length) {
    const { group, body } = makeCollapsibleGroup("Other");
    container.append(group);
    for (const k of leftover) renderLeafRow(body, k, scalars[k], [k], modelGroups, refs);
  }
  for (const [k, v] of Object.entries(objects)) {
    const { group, body } = makeCollapsibleGroup(k);
    container.append(group);
    buildSettingsForm(body, v, modelGroups, [k], refs);
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
  toolsSec.append(el("div", { className: "ays-note", textContent: "The message-history log and long-term memory editors — moved here from the chat panel's top bar." }));
  const logViewBtn = el("button", { className: "ays-btn", textContent: "📜  Message-history log…" });
  logViewBtn.addEventListener("click", () => window.agentYOpenLogViewer && window.agentYOpenLogViewer());
  const memViewBtn = el("button", { className: "ays-btn", textContent: "🧠  Long-term memory…" });
  memViewBtn.addEventListener("click", () => window.agentYOpenMemoryViewer && window.agentYOpenMemoryViewer());
  toolsSec.append(el("div", { className: "ays-row" }, [logViewBtn, memViewBtn]));
  body.append(toolsSec);

  // ── .env auth section ──
  const envInputs = {};
  const secretEls = [];
  const envSec = el("div", { className: "ays-sec" });
  envSec.append(el("h3", { textContent: "Authentication (.env)" }));
  envSec.append(el("div", { className: "ays-note", textContent: "API keys and host settings. Stored in .env on the agent host." }));
  const showToggle = el("input", { type: "checkbox" });
  const toggleLabel = el("label", { className: "ays-toggle" }, [showToggle, el("span", { textContent: "Show secret values" })]);
  showToggle.addEventListener("change", () => {
    for (const inp of secretEls) inp.type = showToggle.checked ? "text" : "password";
  });
  envSec.append(toggleLabel);
  for (const key of data.env_keys || Object.keys(data.env || {})) {
    const cur = (data.env || {})[key] || "";
    const secret = isSecret(key);
    const inp = el("input", { className: "ays-input", type: secret ? "password" : "text", value: cur });
    if (secret) secretEls.push(inp);
    envInputs[key] = { input: inp, original: cur };
    envSec.append(el("div", { className: "ays-row" }, [el("label", { className: "ays-label", textContent: key }), inp]));
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
  buildTopLevelSettings(setForm, data.settings || {}, data.model_groups || {}, refs);
  setSec.append(setForm);
  body.append(setSec);

  // ── model pricing section (config/pricing.json) ──
  const priceSec = el("div", { className: "ays-sec" });
  priceSec.append(el("h3", { textContent: "Model pricing (config/pricing.json)" }));
  priceSec.append(el("div", { className: "ays-note", textContent:
    "Per-model USD prices per MILLION tokens. Overrides the built-in tables so the token-usage cost column matches your endpoint (e.g. your MaaS deployment) and covers models the tables don't ship (deepseek, kimi). Entries with in/out ≤ 0 are ignored. Shape: {\"models\":{\"<model>\":{\"in\":0.4,\"out\":1.2}},\"provider_defaults\":{\"dashscope\":{\"in\":…,\"out\":…}}}." }));
  const priceTa = el("textarea", {
    className: "ays-input",
    spellcheck: false,
    value: JSON.stringify(data.pricing || { models: {}, provider_defaults: {} }, null, 2),
    style: { width: "100%", minHeight: "200px", fontFamily: "ui-monospace,monospace", whiteSpace: "pre" },
  });
  const priceErr = el("div", { className: "ays-note", style: { color: "#e07a5f" } });
  priceSec.append(priceTa, priceErr);
  body.append(priceSec);

  // ── MCP servers section (config/mcp.json) ──
  let mcpTa = null;
  let mcpErr = null;
  if (mcpData && mcpData.ok) {
    const mcpSec = el("div", { className: "ays-sec" });
    mcpSec.append(el("h3", { textContent: "MCP servers (config/mcp.json)" }));
    mcpSec.append(el("div", { className: "ays-note", textContent:
      "External MCP servers whose tools the orchestrator can call. Each server has a transport (http/sse/stdio), a url (or command/args), and an auth mode: \"none\", \"header\" (reference ${ENV_VAR} in headers and store the secret in .env above), or \"oauth\" (browser sign-in — click Authorize below). Saved changes load into the orchestrator on the next agent start." }));
    // Per-server status + Authorize (oauth only).
    const status = mcpData.status || {};
    const statusWrap = el("div", {});
    for (const [name, s] of Object.entries(status)) {
      const line = el("div", { className: "ays-row" });
      line.append(el("label", { className: "ays-label", textContent: name }));
      const state = el("span", { className: "ays-note", style: { margin: "0", flex: "1" }, textContent: `${s.transport}/${s.auth} — ${s.state}` });
      line.append(state);
      if (String(s.auth).toLowerCase() === "oauth") {
        const authBtn = el("button", { className: "ays-btn", textContent: "Authorize…" });
        authBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          authBtn.disabled = true; authBtn.textContent = "Opening browser…";
          try {
            const ra = await fetch(backendBase() + "/agentY/mcp/authorize", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name }),
            });
            const ja = await ra.json();
            state.textContent = ja.ok ? "✅ " + (ja.message || "authorized") : "❌ " + (ja.error || "failed");
          } catch (err) {
            state.textContent = "❌ " + err;
          } finally {
            authBtn.disabled = false; authBtn.textContent = "Authorize…";
          }
        });
        line.append(authBtn);
      }
      statusWrap.append(line);
    }
    mcpSec.append(statusWrap);
    mcpTa = el("textarea", {
      className: "ays-input", spellcheck: false,
      value: JSON.stringify(mcpData.config || { servers: {} }, null, 2),
      style: { width: "100%", minHeight: "160px", fontFamily: "ui-monospace,monospace", whiteSpace: "pre" },
    });
    mcpErr = el("div", { className: "ays-note", style: { color: "#e07a5f" } });
    mcpSec.append(mcpTa, mcpErr);
    body.append(mcpSec);
  }

  // ── footer ──
  const msg = el("div", { className: "ays-msg" });
  const cancelBtn = el("button", { className: "ays-btn", textContent: "Close" });
  const saveBtn = el("button", { className: "ays-btn primary", textContent: "Save" });
  const close = () => overlay.remove();
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

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
    let pricingPayload;
    try {
      pricingPayload = JSON.parse(priceTa.value);
      priceErr.textContent = "";
    } catch (e) {
      priceErr.textContent = "Pricing JSON is invalid — not saved: " + e;
    }
    let mcpPayload;
    if (mcpTa) {
      try { mcpPayload = JSON.parse(mcpTa.value); if (mcpErr) mcpErr.textContent = ""; }
      catch (e) { if (mcpErr) mcpErr.textContent = "MCP JSON is invalid — not saved: " + e; }
    }
    const payload = { env: envChanges, settings: collectSettings(refs) };
    if (pricingPayload !== undefined) payload.pricing = pricingPayload;
    try {
      const r = await fetch(backendBase() + "/agentY/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "save failed");
      let mcpSaved = false;
      if (mcpPayload !== undefined) {
        try {
          const rm = await fetch(backendBase() + "/agentY/mcp", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: mcpPayload }),
          });
          mcpSaved = (await rm.json()).ok;
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

  const foot = el("div", { className: "ays-foot" }, [msg, cancelBtn, saveBtn]);
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
