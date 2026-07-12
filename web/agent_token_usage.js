import { app } from "../../scripts/app.js";

// agentY Token Usage — an overview panel for inspecting token consumption parsed
// from the agent's token log (.logs/tokens_usage.log). Shows Input / Output
// tokens (plus cache + cost) with per-model breakdown, and lets you filter by
// model and time range. Data comes from the agentY chat host
// (src/utils/agentY_server.py: GET /agentY/token_usage?from=&to=), which sums the
// per-call *deltas* in the log within the requested window.
//
// Two entry points, both calling openTokenUsageModal():
//   • a 📊 button in the chat panel's top bar (web/agent_chat.js), and
//   • an entry in ComfyUI's Settings panel (registered below).

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

// ── number / date formatting ──────────────────────────────────────────────────
const _grp = new Intl.NumberFormat("en-US");
function full(n) { return _grp.format(Math.round(n || 0)); }
function compact(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}
function money(n) {
  n = n || 0;
  if (n === 0) return "$0.00";
  return "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));
}
function pct(x) { return (100 * (x || 0)).toFixed(1) + "%"; }
// Prompt-cache hit rate: cache reads over ALL input-side tokens (fresh input +
// cache reads + cache writes). Anthropic reports these three as disjoint parts
// of the input, so this is the share of input served cheaply from cache.
function hitRate(r) {
  const denom = (r.input || 0) + (r.cache_read || 0) + (r.cache_write || 0);
  return denom > 0 ? (r.cache_read || 0) / denom : 0;
}
function fmtTs(sec) {
  if (!sec) return "—";
  const d = new Date(sec * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const RANGES = [
  ["1h", "Last hour", 3600],
  ["24h", "Last 24 hours", 86400],
  ["7d", "Last 7 days", 604800],
  ["30d", "Last 30 days", 2592000],
  ["all", "All time", null],
  ["custom", "Custom range…", 0],
];

function injectStyles() {
  if (document.getElementById("agentY-tokusage-styles")) return;
  const css = `
  .atu-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;
    align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;}
  .atu-card{background:#262624;color:#f2f0ea;border:1px solid rgba(240,235,225,.12);border-radius:14px;
    width:min(860px,94vw);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.6);}
  .atu-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid rgba(240,235,225,.10);}
  .atu-head h2{font-size:15px;margin:0;font-weight:650;flex:1;}
  .atu-x{background:transparent;color:#a8a39a;border:none;font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:8px;}
  .atu-x:hover{background:#3b3936;color:#f2f0ea;}
  .atu-body{padding:14px 18px;overflow:auto;}
  .atu-filters{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end;margin-bottom:16px;}
  .atu-field{display:flex;flex-direction:column;gap:4px;}
  .atu-field>label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#a8a39a;}
  .atu-sel,.atu-dt{background:#302f2c;color:#f2f0ea;border:1px solid rgba(240,235,225,.14);border-radius:8px;
    padding:6px 9px;font-size:12.5px;outline:none;min-width:150px;}
  .atu-sel:focus,.atu-dt:focus{border-color:rgba(91,155,245,.6);}
  .atu-btn{background:#3b3936;color:#f2f0ea;border:1px solid rgba(240,235,225,.14);border-radius:9px;
    padding:7px 14px;cursor:pointer;font-size:12.5px;}
  .atu-btn:hover{background:#464440;}
  .atu-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px;}
  .atu-tile{background:#302f2c;border:1px solid rgba(240,235,225,.10);border-radius:12px;padding:12px 14px;}
  .atu-tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#a8a39a;margin-bottom:6px;}
  .atu-tile .v{font-size:22px;font-weight:680;line-height:1.1;}
  .atu-tile .s{font-size:11px;color:#a8a39a;margin-top:3px;}
  .atu-tile.in{border-color:rgba(139,204,171,.28);}
  .atu-tile.in .v{color:#8fd6ab;}
  .atu-tile.out{border-color:rgba(217,119,87,.28);}
  .atu-tile.out .v{color:#e9955f;}
  .atu-tile.cache{border-color:rgba(120,170,220,.28);}
  .atu-tile.cache .v{color:#8fb8e0;}
  .atu-table td.cache{color:#8fb8e0;}
  .atu-tablewrap{overflow-x:auto;border:1px solid rgba(240,235,225,.10);border-radius:12px;}
  table.atu-table{border-collapse:collapse;width:100%;font-size:12.5px;}
  .atu-table th,.atu-table td{padding:8px 12px;text-align:right;white-space:nowrap;}
  .atu-table th{background:#302f2c;color:#a8a39a;font-weight:600;font-size:11px;text-transform:uppercase;
    letter-spacing:.04em;position:sticky;top:0;}
  .atu-table th:first-child,.atu-table td:first-child{text-align:left;font-family:ui-monospace,monospace;}
  .atu-table tbody tr{border-top:1px solid rgba(240,235,225,.07);}
  .atu-table tbody tr:hover{background:rgba(240,235,225,.03);}
  .atu-table td.in{color:#8fd6ab;}
  .atu-table td.out{color:#e9955f;}
  .atu-table tfoot td{border-top:2px solid rgba(240,235,225,.16);font-weight:680;background:#2b2a28;}
  .atu-note{font-size:11.5px;color:#a8a39a;margin-top:12px;}
  .atu-empty{color:#a8a39a;text-align:center;padding:30px 0;font-size:13px;}
  .atu-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid rgba(240,235,225,.10);}
  .atu-msg{flex:1;font-size:12px;color:#a8a39a;}
  .atu-btn.danger{background:#8a4034;color:#ffe1d9;border-color:transparent;}
  .atu-btn.danger:hover{background:#9c4a3c;}
  .atu-btn.armed{background:#b5482f;color:#fff;border-color:transparent;font-weight:650;}
  `;
  document.head.append(el("style", { id: "agentY-tokusage-styles", textContent: css }));
}

// Convert the selected range preset (+ custom inputs) into {from, to} epoch secs.
function rangeParams(preset, fromInp, toInp) {
  const now = Date.now() / 1000;
  const spec = RANGES.find((r) => r[0] === preset);
  if (!spec) return {};
  if (preset === "all") return {};
  if (preset === "custom") {
    const f = fromInp && fromInp.value ? new Date(fromInp.value).getTime() / 1000 : null;
    const t = toInp && toInp.value ? new Date(toInp.value).getTime() / 1000 : null;
    return { from: f, to: t };
  }
  return { from: now - spec[2] };
}

async function openTokenUsageModal() {
  injectStyles();

  const overlay = el("div", { className: "atu-overlay" });
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  // ── filter controls ──
  const rangeSel = el("select", { className: "atu-sel" });
  for (const [val, label] of RANGES) rangeSel.append(el("option", { value: val, textContent: label }));
  rangeSel.value = "all";

  const fromInp = el("input", { type: "datetime-local", className: "atu-dt" });
  const toInp = el("input", { type: "datetime-local", className: "atu-dt" });
  const customField = el("div", { className: "atu-field", style: { display: "none" } }, [
    el("label", { textContent: "From / To" }),
    el("div", { style: { display: "flex", gap: "6px" } }, [fromInp, toInp]),
  ]);

  const modelSel = el("select", { className: "atu-sel" });
  modelSel.append(el("option", { value: "__all__", textContent: "All models" }));

  const refreshBtn = el("button", { className: "atu-btn", textContent: "↻ Refresh" });

  const filters = el("div", { className: "atu-filters" }, [
    el("div", { className: "atu-field" }, [el("label", { textContent: "Time range" }), rangeSel]),
    customField,
    el("div", { className: "atu-field" }, [el("label", { textContent: "Model" }), modelSel]),
    el("div", { className: "atu-field" }, [el("label", { textContent: " " }), refreshBtn]),
  ]);

  const tiles = el("div", { className: "atu-tiles" });
  const tableHost = el("div");
  const note = el("div", { className: "atu-note" });

  const body = el("div", { className: "atu-body" }, [filters, tiles, tableHost, note]);

  // ── footer: purge the token log (two-click confirm, auto-disarms) ──
  const clearMsg = el("div", { className: "atu-msg" });
  const clearBtn = el("button", { className: "atu-btn danger", textContent: "🗑 Clear log" });
  const foot = el("div", { className: "atu-foot" }, [clearMsg, clearBtn]);

  const card = el("div", { className: "atu-card" }, [
    el("div", { className: "atu-head" }, [
      el("h2", { textContent: "agentY — Token Usage" }),
      (() => { const b = el("button", { className: "atu-x", textContent: "✕", title: "Close" }); b.addEventListener("click", close); return b; })(),
    ]),
    body,
    foot,
  ]);
  overlay.append(card);
  document.body.append(overlay);

  let lastData = null; // most recent server response for the current time window

  function tile(cls, key, valNode, sub) {
    return el("div", { className: "atu-tile " + cls }, [
      el("div", { className: "k", textContent: key }),
      valNode,
      sub != null ? el("div", { className: "s", textContent: sub }) : null,
    ]);
  }

  function render() {
    if (!lastData) return;
    const sel = modelSel.value;
    let rows = lastData.rows || [];
    if (sel !== "__all__") rows = rows.filter((r) => r.model === sel);

    // sum the visible rows for the headline tiles
    const t = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, calls: 0 };
    for (const r of rows) for (const k of Object.keys(t)) t[k] += r[k] || 0;

    tiles.innerHTML = "";
    const rate = hitRate(t);
    const inV = el("div", { className: "v", textContent: compact(t.input), title: full(t.input) + " tokens" });
    const outV = el("div", { className: "v", textContent: compact(t.output), title: full(t.output) + " tokens" });
    tiles.append(
      tile("in", "Input tokens", inV, full(t.input)),
      tile("out", "Output tokens", outV, full(t.output)),
      tile("", "Total tokens", el("div", { className: "v", textContent: compact(t.input + t.output), title: full(t.input + t.output) }), full(t.input + t.output)),
      tile("cache", "Cache read (hits)", el("div", { className: "v", textContent: compact(t.cache_read), title: full(t.cache_read) + " tokens" }), `${compact(t.cache_write)} written`),
      tile("cache", "Cache hit rate", el("div", { className: "v", textContent: pct(rate) }), "of input from cache"),
      tile("", "Est. cost", el("div", { className: "v", textContent: money(t.cost) }), t.cost === 0 ? "model unpriced" : "USD"),
      tile("", "Calls", el("div", { className: "v", textContent: full(t.calls) }), `${compact(t.input + t.output + t.cache_read + t.cache_write)} tokens total`),
    );

    // per-model table
    tableHost.innerHTML = "";
    if (!rows.length) {
      tableHost.append(el("div", { className: "atu-empty", textContent: "No token usage recorded for this filter." }));
    } else {
      const thead = el("thead", {}, [el("tr", {}, [
        el("th", { textContent: "Model" }),
        el("th", { textContent: "Input" }),
        el("th", { textContent: "Output" }),
        el("th", { textContent: "Cache read" }),
        el("th", { textContent: "Cache write" }),
        el("th", { textContent: "Hit rate" }),
        el("th", { textContent: "Cost" }),
        el("th", { textContent: "Calls" }),
      ])]);
      const tbody = el("tbody");
      for (const r of rows) {
        tbody.append(el("tr", {}, [
          el("td", { textContent: r.model }),
          el("td", { className: "in", textContent: full(r.input), title: full(r.input) }),
          el("td", { className: "out", textContent: full(r.output) }),
          el("td", { className: "cache", textContent: full(r.cache_read) }),
          el("td", { textContent: full(r.cache_write) }),
          el("td", { textContent: pct(hitRate(r)) }),
          el("td", { textContent: money(r.cost) }),
          el("td", { textContent: full(r.calls) }),
        ]));
      }
      const tfoot = el("tfoot", {}, [el("tr", {}, [
        el("td", { textContent: "Total" }),
        el("td", { textContent: full(t.input) }),
        el("td", { textContent: full(t.output) }),
        el("td", { textContent: full(t.cache_read) }),
        el("td", { textContent: full(t.cache_write) }),
        el("td", { textContent: pct(hitRate(t)) }),
        el("td", { textContent: money(t.cost) }),
        el("td", { textContent: full(t.calls) }),
      ])]);
      tableHost.append(el("div", { className: "atu-tablewrap" }, [
        el("table", { className: "atu-table" }, [thead, tbody, tfoot]),
      ]));
    }

    const lr = lastData.log_range || {};
    note.textContent =
      `Log spans ${fmtTs(lr.min)} → ${fmtTs(lr.max)}. ` +
      `Summed from per-call deltas in .logs/tokens_usage.log. ` +
      `Hit rate = cache reads ÷ all input tokens (fresh + cache read + cache write). ` +
      `Lines logged before model tracking are grouped as "role:<agent>".`;
  }

  async function load() {
    const p = rangeParams(rangeSel.value, fromInp, toInp);
    const qs = new URLSearchParams();
    if (p.from != null) qs.set("from", String(p.from));
    if (p.to != null) qs.set("to", String(p.to));
    tiles.innerHTML = "";
    tableHost.innerHTML = "";
    note.textContent = "Loading…";
    let data;
    try {
      const r = await fetch(backendBase() + "/agentY/token_usage?" + qs.toString());
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json();
      if (!data.ok) throw new Error(data.error || "parse failed");
    } catch (e) {
      note.textContent = "";
      tableHost.append(el("div", { className: "atu-empty", textContent: "Could not load token usage — is the chat host running?  " + e }));
      return;
    }
    lastData = data;

    // Refresh the model dropdown from the full model list, keeping the selection.
    const prev = modelSel.value;
    modelSel.innerHTML = "";
    modelSel.append(el("option", { value: "__all__", textContent: "All models" }));
    for (const m of data.all_models || []) modelSel.append(el("option", { value: m, textContent: m }));
    modelSel.value = Array.from(modelSel.options).some((o) => o.value === prev) ? prev : "__all__";

    render();
  }

  rangeSel.addEventListener("change", () => {
    customField.style.display = rangeSel.value === "custom" ? "" : "none";
    if (rangeSel.value !== "custom") load();
  });
  fromInp.addEventListener("change", () => { if (rangeSel.value === "custom") load(); });
  toInp.addEventListener("change", () => { if (rangeSel.value === "custom") load(); });
  modelSel.addEventListener("change", render);
  refreshBtn.addEventListener("click", load);

  // Purge the token log. First click arms (and warns); a second click within 5s
  // confirms. This wipes the whole log, not just the current filter — say so.
  let armed = false, armTimer = null;
  const disarm = () => {
    armed = false;
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    clearBtn.classList.remove("armed");
    clearBtn.textContent = "🗑 Clear log";
    clearMsg.textContent = "";
  };
  clearBtn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      clearBtn.classList.add("armed");
      clearBtn.textContent = "Click again to confirm";
      clearMsg.textContent = "This permanently deletes ALL token usage history (every model, every date).";
      armTimer = setTimeout(disarm, 5000);
      return;
    }
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    armed = false;
    clearBtn.disabled = true;
    clearBtn.classList.remove("armed");
    clearBtn.textContent = "Clearing…";
    clearMsg.textContent = "";
    try {
      const r = await fetch(backendBase() + "/agentY/token_usage/clear", { method: "POST" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "clear failed");
      clearMsg.textContent = `✅ Cleared ${full(j.cleared_lines || 0)} log entries.`;
      await load();
    } catch (e) {
      clearMsg.textContent = "❌ " + e;
    } finally {
      clearBtn.disabled = false;
      clearBtn.textContent = "🗑 Clear log";
    }
  });

  load();
}

// Expose for the chat panel's 📊 button (web/agent_chat.js).
window.agentYOpenTokenUsage = openTokenUsageModal;

app.registerExtension({
  name: "agentY.tokenUsage",
  settings: [
    {
      id: "agentY.tokenUsage",
      name: "Token usage overview",
      category: ["agentY", "Application", "Token usage"],
      tooltip: "Inspect input/output token usage by model and time range",
      defaultValue: "",
      type: (_name, _setter, _value) => {
        injectStyles();
        const btn = el("button", { className: "atu-btn", textContent: "Open Token Usage…" });
        btn.addEventListener("click", (e) => { e.preventDefault(); openTokenUsageModal(); });
        return btn;
      },
    },
  ],
});
