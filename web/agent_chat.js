import { app } from "../../scripts/app.js";
import { iconsReady, setButtonIcon, applyIcons } from "./agent_icons.js";
import { hookReaches, wireIntoAnchor } from "./agent_hook.js";
import { normaliseTag } from "./agent_tags.js";

// agentY chat — a ComfyUI sidebar tab that talks to the agentY headless chat host
// (src/utils/agentY_server.py on :5000) over HTTP/SSE. It replaces the Chainlit
// GUI: the agent's *text* streams into this panel, while every generated image /
// video is dropped onto the ComfyUI graph as an image / video loader node
// (see onOutput → injectNode). Conversations, slash commands, and thread history
// mirror what the old Chainlit UI offered.

const DEFAULT_PORT = 5000;
// Where /help opens: the GitHub-rendered usage guide (images render inline).
const DOCS_URL = "https://github.com/szprivate/agentY/blob/main/docs/using-agentY.md";
// Remember which conversation was open so switching away from the sidebar tab
// and back (ComfyUI unmounts/remounts the panel) reopens it instead of a blank
// new chat.
const ACTIVE_THREAD_KEY = "agentY_active_thread";

function backendBase() {
  return (
    localStorage.getItem("agentY_backend") ||
    `http://${location.hostname || "127.0.0.1"}:${DEFAULT_PORT}`
  );
}
// The ComfyUI server that serves this sidebar (NOT the agentY host on :5000).
// The "Start server" button hits the agentY-comfyuiConnect extension's route on
// THIS origin, because the agentY host it would launch is the one that's down.
function comfyBase() {
  return location.origin;
}

// Highest status-line seq the panel has already shown. Persisted so a page
// reload doesn't re-dump the whole server-side ring buffer.
const STATUS_SEQ_KEY = "agentY_status_seq";
const NOTIFY_SEQ_KEY = "agentY_notify_seq";
// Breathing room between a node the agent drops on the canvas and its neighbours
// — used both as the gap to the block it lands beside and as the margin that
// counts as "already occupied" when looking for a free slot.
const DROP_GAP = 56;
// Assumed footprint of a node that has just been created: LiteGraph only computes
// the real size once it is drawn, and the slot has to be chosen before that.
const DROP_SIZE = [280, 140];
// How far a column of drops may grow downwards before the next one starts a new
// column beside it. A run with a dozen outputs has to stay a block sitting next
// to the workflow, not a stripe running off one edge of it.
const DROP_COL_H = 1200;

// Nodes this panel put on the canvas (generated media, written text). They are
// flagged so the NEXT drop is measured against the user's workflow rather than
// against the pile we are already building beside it — otherwise every drop
// starts further out than the last and a long run walks off the graph. The title
// test catches nodes dropped before the flag existed.
function isAgentDrop(n) {
  if (n && n.properties && n.properties.agentY_drop) return true;
  const t = String((n && n.title) || "");
  return t.startsWith("agentY · ") || t === "agentY text";
}

// Does this look like an [x, y] pair we can measure?
// It has to be asked this way round: a live node's `pos` is a Float64Array view
// (LiteGraph keeps position and size in one `Rectangle`) and its `size` is a
// Proxy over another, so `Array.isArray` is false for every node on the canvas.
// They index like arrays, which is all the placement maths ever does with them.
function isXY(v) {
  return !!v && Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

// Mark a node as ours, so later placements can tell it from the user's graph.
function markAgentDrop(node) {
  try {
    node.properties = node.properties || {};
    node.properties.agentY_drop = true;
  } catch (_) {}
}
// Shown on the offline overlay when the agentY host isn't reachable.
const OFFLINE_MSG =
  "The agentY chat host isn't running. Start it to use the panel — a PowerShell " +
  "window will open and run `run_agent.ps1`.";

// ── tiny helpers ──────────────────────────────────────────────────────────────
function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  if (props.style) Object.assign(n.style, props.style);
  for (const c of [].concat(children)) n.append(c);
  return n;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// Minimal markdown: **bold**, `code`, newlines. Enough for the agent's messages.
function mdToHtml(s) {
  let h = escapeHtml(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // [label](https://…) → clickable link that opens in a new tab.
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener" class="ay-link">$1</a>');
  h = h.replace(/\n/g, "<br>");
  return h;
}

const SLASH_FALLBACK = [
  { name: "/help", description: "Open the agentY usage guide in a new browser tab" },
  { name: "/restart", description: "Restart the agent pipeline" },
  { name: "/stop", description: "Stop and shut down the agent" },
  { name: "/unload", description: "Unload Ollama models from VRAM" },
  { name: "/clear_vram", description: "Clear ComfyUI GPU VRAM" },
  { name: "/images", description: "List images generated in this thread" },
  { name: "/qa", description: "Show / set / clear the QA briefing outputs are checked against" },
  { name: "/project_memory", description: "Inspect and forget what is remembered for THIS project" },
  { name: "/clearhistory", description: "Delete all conversation history" },
  { name: "/switch_model", description: "Switch an agent's LLM" },
  { name: "/add_workflow", description: "Add a workflow (JSON path, or 'canvas <name>' for the open graph)" },
  { name: "/resend", description: "Resend the first user message" },
  { name: "/remove_workflow", description: "Remove a workflow by name" },
];

// Model presets for the quick-switch dropdown (grouped by provider). Each entry
// is [ "<provider>,<model>", "Display name" ] — the provider,model string is
// exactly what /switch_model expects. Edit this list to add your own models.
// These mirror the host's _ANTHROPIC_MODELS / _DASHSCOPE_MODELS so the dropdown
// is still usable when the host is briefly unreachable (e.g. mid-restart) and the
// live /agentY/models list can't be fetched. Ollama models can't be known offline
// — they appear once the host answers again (see _loadModels' retry/reconnect).
const MODEL_PRESETS = {
  Anthropic: [
    ["claude,claude-haiku-4-5", "Claude Haiku 4.5"],
    ["claude,claude-sonnet-4-5", "Claude Sonnet 4.5"],
  ],
  "Alibaba (DashScope)": [
    ["dashscope,qwen3.6-flash", "Qwen3.6 Flash"],
    ["dashscope,qwen-plus", "Qwen Plus"],
    ["dashscope,qwen3.7-plus", "Qwen3.7 Plus"],
    ["dashscope,qwen-max", "Qwen Max"],
  ],
};

// Which agent(s) the model switch targets.
// Fallback scope list, used only until /agentY/switch_targets answers (or when the
// host is offline). The real list is the agent's own tier map, fetched at startup,
// so this picker and the Settings UI can never drift apart.
const MODEL_TARGETS = [
  ["all", "All tiers"],
];

class AgentChat {
  constructor() {
    // The panel DOM (this.wrap) is built once and kept alive for the life of the
    // page. ComfyUI unmounts/remounts a sidebar tab every time you switch away and
    // back; a single persistent instance (see the singleton in registerExtension)
    // re-parents this same DOM into each fresh mount point via mount(), so an
    // in-flight turn keeps streaming into the same log instead of being orphaned
    // in a discarded instance (which is what "swallowed" messages).
    this.threadId = null;
    this.streaming = false;
    this.activeAsk = null; // request_id awaiting a reply
    this.streamThreadId = null; // conversation the in-flight stream belongs to
    this.curRequestId = null; // request_id of the in-flight turn (for Stop)
    this.abortController = null; // aborts the SSE fetch on Stop
    // A turn we know is running but are NOT streaming — adopted from /agentY/runs
    // after a reload or a conversation switch. There is no fetch behind it, so no
    // `done` event and no reader EOF will ever clear `streaming`; only a re-check
    // against the host can. Kept distinct from a stream we own for that reason.
    this._adoptedRun = false;
    // Identifies the stream that currently owns the shared streaming state, so a
    // stream that finishes after being replaced can't clear its successor's state.
    this._streamToken = 0;
    this._stopping = false; // set while a user-initiated stop is in progress
    this.attachments = []; // [{path,name}]
    this.commands = SLASH_FALLBACK;
    this.curAssistant = null; // DOM node currently streaming assistant text
    this.curStep = null; // {details, body}
    this._selOrder = []; // node ids in the order they were selected on the canvas
    this._consumed = {}; // nodeId -> value already sent as an input (skip re-sending unchanged)
    this.domCache = new Map(); // threadId -> {html, scroll}: live-rendered panel (thinking/step blocks) kept across conversation switches
    this._hostUp = true;
    this._lastHealth = null; // last /agentY/health body, refreshed by _hostReachable()
    this._bootId = null;     // boot_id of the host process we're talking to (restart detection)
    this._queue = []; // messages typed while a turn is running → auto-sent when it finishes
    // Set for one send when the message is already in the log: it went out
    // mid-run ("↳") and came back undelivered, so re-echoing it would double it.
    this._skipEcho = false;
    // Track the last CLI-status line shown so the on-connect / on-done buffer
    // fetch never re-renders a line already delivered live during a turn.
    this._lastStatusSeq = Number(localStorage.getItem(STATUS_SEQ_KEY) || 0) || 0;
    // Background notifications (e.g. Magnific auto-drop): highest seq already
    // handled, so the idle poll never re-drops one delivered live during a turn.
    this._lastNotifySeq = Number(localStorage.getItem(NOTIFY_SEQ_KEY) || 0) || 0;
    this._notifyTimer = null;
    this._booted = false;   // true once _bootstrap has made the first health check
    this._probing = false;  // an off-timer health probe is in flight
    this._injectStyles();
    this._build();
    this._hookVisibility();
    this._bootstrap();
  }

  // Attach the persistent panel DOM to the current mount point. Called on every
  // sidebar (re)mount. Re-parenting moves the live DOM (append relocates a node),
  // so a running turn's streaming text and rendered blocks survive a tab switch.
  mount(elm) {
    if (!elm) return;
    this.mountEl = elm;
    elm.innerHTML = "";
    elm.appendChild(this.wrap);
    this._onShown();  // the panel is back on screen: is the host still there?
    // Cheap, non-destructive refresh: repopulate the thread dropdown (in case a
    // conversation was created/deleted elsewhere) and the model list (so a vendor
    // that was down at connect — e.g. Ollama still starting — appears once it's up)
    // without touching the open log. Switching tabs away and back thus self-heals.
    if (this._hostUp) {
      this._loadThreads(); this._loadModels(); this._loadSwitchTargets();
      this._syncRunState();  // a turn may have finished (or started) while hidden
    } else this._positionOffline();  // re-parenting moves the panel; keep the overlay on it
  }

  // Load everything the panel needs. If the host isn't up yet (e.g. it was just
  // restarted), fall into the reconnect watcher so the panel self-heals instead of
  // silently showing a stale/empty list until a manual hard-reload.
  async _bootstrap() {
    if (await this._hostReachable()) { await this._afterConnect(true); }
    else this._startReconnect(true);
    this._booted = true;  // from here on, _probeNow may check on its own
  }

  // One listener for "the user is looking at this again". A backgrounded browser
  // tab has its timers throttled to roughly a tick a minute, so whatever the panel
  // shows on return can be that stale — including "ready" for a host that is long
  // gone. The sidebar's own show/hide arrives through mount() instead: ComfyUI
  // unmounts a custom sidebar tab when you switch away from it and calls render()
  // again when you come back.
  _hookVisibility() {
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this._onShown();
    });
  }

  // The panel just became visible. Both of these are timer-driven otherwise, and
  // neither cadence is a good fit for this moment: the user is here to type, and
  // the state in front of them is whatever was true when they left.
  _onShown() {
    this._probeNow();            // don't make them wait a tick to learn the host is gone
    this._drainNotifications();  // and drop anything that finished while we weren't looking
  }

  // Check the host now instead of on the next tick. Nothing else can notice a host
  // that crashed or was stopped while the panel sat idle, and the watchers that do
  // (heartbeat at 5 s, reconnect at 2.5 s) are deliberately unhurried — it costs
  // nothing to ask once more at the one moment someone is waiting for the answer.
  async _probeNow() {
    if (!this._booted) return;                        // _bootstrap owns the first check
    if (this._probing) return;                        // a re-mount can fire this twice over
    if (this.streaming && !this._adoptedRun) return;  // a stream we own is proof of life
    this._probing = true;
    try {
      if (this._reconnectTimer) { await this._reconnectTick(); return; }  // down: back yet?
      if (await this._hostReachable()) {
        if (this._hostRestarted()) await this._afterConnect(false);
        return;
      }
      if (await this._hostReachable()) return;  // one retry: don't flap on a blip
      this._startReconnect(false);
    } finally { this._probing = false; }
  }

  async _hostReachable() {
    try {
      const r = await fetch(backendBase() + "/agentY/health", { cache: "no-store" });
      if (!r.ok) return false;
      try { this._lastHealth = await r.json(); } catch (_) { this._lastHealth = null; }
      return true;
    } catch (_) { return false; }
  }

  // True when the host answering us now is a DIFFERENT process from the one we
  // were talking to before — /agentY/health carries a per-process boot_id. Without
  // this, a restart that completes between two heartbeats (a background tab
  // throttles timers to roughly one tick a minute) would pass unnoticed and the
  // panel would never say the agent is back. A pure comparison: it does not
  // consume the id, so both the heartbeat and _afterConnect can ask.
  _hostRestarted() {
    const id = this._lastHealth && this._lastHealth.boot_id;
    return !!(id && this._bootId && id !== this._bootId);
  }

  async _afterConnect(firstBoot) {
    const wasDown = this._hostUp === false;
    const restarted = this._hostRestarted();
    this._bootId = (this._lastHealth && this._lastHealth.boot_id) || this._bootId || null;
    this._setHostUp(true);
    await this._loadCommands();
    await this._loadModels();
    await this._loadSwitchTargets();
    if (firstBoot && !this.threadId) await this._restoreSession();
    else await this._loadThreads();
    // A page reload drops the SSE connection without stopping the run behind it,
    // so reconcile with the host before showing the panel as idle.
    await this._syncRunState();
    this._drainStatus(); // show any CLI notices (memory init, …) emitted before/while we connected
    this._startNotifyPoll();    // drain background auto-drops queued before we connected, and
                                // poll for more only while the host has a generation in flight
    this._startHeartbeat();       // notice a host that crashes or is stopped while we sit idle
    this._registerHostLocation(); // record where agentY lives so "Start server" works when it's down
    this._loadAutograph();        // reflect the host's current auto-graph setting on the toggle

    // Say so in the panel. Coming back from an offline overlay is obvious enough
    // visually, but a restart the panel rode out silently is not — and either way
    // the useful signal is "you can type again". Transient: never persisted into
    // the thread's saved panel HTML (see _logHtml), so restarts don't accumulate.
    if (wasDown || restarted) {
      this._sys(firstBoot ? "🟢 agentY host connected — ready."
                          : "🟢 agentY host is back — ready.", { transient: true });
    }
  }

  // ── auto-graph toggle (autoload_workflows_into_canvas) ───────────────────────
  _setAutographUI(on, envLocked) {
    this._autograph = !!on;
    this._autographEnvLocked = !!envLocked;
    if (!this.autographBtn) return;
    this.autographBtn.classList.toggle("ay-on", this._autograph);
    this.autographBtn.title =
      "Auto-graph workflows onto canvas: " + (this._autograph ? "ON" : "OFF") +
      (envLocked ? " — locked by the AGENTY_CANVAS_AUTOLOAD env var" : " — click to toggle");
  }

  async _loadAutograph() {
    try {
      const r = await fetch(backendBase() + "/agentY/autograph", { cache: "no-store" });
      const j = await r.json();
      if (j && j.ok) this._setAutographUI(!!j.enabled, !!j.env_locked);
    } catch (_) { /* host down / route absent — leave the button in its default state */ }
  }

  async _toggleAutograph() {
    if (this._autographEnvLocked) return; // env var wins; the setting can't take effect
    const next = !this._autograph;
    this._setAutographUI(next, false); // optimistic
    try {
      const r = await fetch(backendBase() + "/agentY/autograph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const j = await r.json();
      if (!j || !j.ok) throw new Error((j && j.error) || "toggle failed");
      this._setAutographUI(!!j.enabled, false);
    } catch (_) {
      this._setAutographUI(!next, false); // revert on failure
    }
  }

  // Tell the ComfyUI extension (same origin) where the agentY host lives, using
  // the running host's own project_root. The browser is the one component that
  // can reach BOTH the host (:5000) and ComfyUI, so this is the reliable way to
  // keep the extension's .agenty_host.json current — no env var / manual config.
  // Best-effort: silently no-ops if the extension route isn't present yet (e.g.
  // ComfyUI needs a restart to load it).
  async _registerHostLocation() {
    try {
      const r = await fetch(backendBase() + "/agentY/health", { cache: "no-store" });
      if (!r.ok) return;
      const h = await r.json();
      if (!h || !h.project_root) return;
      await fetch(comfyBase() + "/agent/register_host", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_root: h.project_root, run_script: "run_agent.ps1" }),
      });
    } catch (_) {}
  }

  // Poll the host until it answers again, then reload the bits that go stale on a
  // restart (commands, model list, thread list). Only runs while the host is down,
  // so there's no steady-state polling. Triggered on startup-if-down and whenever a
  // stream fetch fails with a connection error.
  // A host that crashes, or that the user stops with /stop, goes away silently:
  // nothing else polls while the panel is idle (the notification poll deliberately
  // stops when no generation is in flight), so the overlay never appeared and the
  // panel just looked frozen. This is the one poll that runs whenever we believe
  // the host is up — cheap, and it is the only thing that can notice.
  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(async () => {
      if (!this._hostUp) return;
      // A stream we OWN is its own proof of life. An adopted run is not: nothing
      // is listening for its end, and skipping the tick for it is what used to
      // make that state permanent — the notify poll stops itself once nothing is
      // pending, so the panel fell completely silent and sat on "a turn is still
      // running here" until the host was restarted. Re-check those against the
      // host instead; _syncRunState clears the state once the run is gone.
      if (this.streaming && !this._adoptedRun) return;
      if (await this._hostReachable()) {
        // Up — but is it the same process? A restart short enough to fall between
        // two ticks leaves us holding a stale command/model/thread list, so treat
        // a changed boot_id exactly like a reconnect.
        if (this._hostRestarted()) await this._afterConnect(false);
        else if (this._adoptedRun) await this._syncRunState();
        // A turn with no browser behind it (one asked for from Slack) cannot
        // capture the graph itself, so the host asks us to. This tick is the
        // only regular contact the panel has with it.
        if (this._lastHealth && this._lastHealth.want_canvas) await this._postCanvas();
        return;
      }
      if (await this._hostReachable()) return;      // one retry: don't flap on a blip
      this._startReconnect(false);
    }, 5000);
  }

  // Post what is on the canvas right now, with no message attached.
  //
  // Same payload a message carries, because it is the same question — "what is
  // the agent looking at?" — asked by a turn that has no browser of its own. A
  // Slack turn used to arrive with no graph at all, and every canvas tool
  // answered "no on-canvas graph is loaded this turn", which reads as the agent
  // refusing to look at a workflow that is open in front of you.
  async _postCanvas() {
    if (this._postingCanvas) return;
    this._postingCanvas = true;
    try {
      const body = {
        canvas_prompt: await this._captureCanvasGraph(),
        canvas_hooks: this._collectCanvasHooks(),
        canvas_selection: this._collectCanvasSelection(),
      };
      await fetch(backendBase() + "/agentY/canvas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (_) {
      // The host asked and we could not answer. It falls back to running
      // without a canvas and saying so, which is the honest outcome.
    } finally {
      this._postingCanvas = false;
    }
  }

  _startReconnect(firstBoot) {
    if (this._reconnectTimer) return;
    // Held on the instance so an off-timer attempt (_probeNow, when the panel
    // comes back on screen) reconnects on exactly the terms the watcher would —
    // a first boot still restores the last conversation instead of just listing.
    this._reconnectFirst = !!firstBoot;
    this._setHostUp(false);
    this._reconnectTimer = setInterval(() => this._reconnectTick(), 2500);
  }

  async _reconnectTick() {
    if (!this._reconnectTimer) return;
    if (!(await this._hostReachable())) return;
    clearInterval(this._reconnectTimer);
    this._reconnectTimer = null;
    this._afterConnect(this._reconnectFirst);
  }

  // Reopen the conversation that was active last (survives the panel being
  // unmounted/remounted when the user switches sidebar tabs); fall back to a
  // fresh chat when there's nothing to restore or the thread is gone.
  async _restoreSession() {
    await this._loadThreads();
    let saved = null;
    try { saved = localStorage.getItem(ACTIVE_THREAD_KEY); } catch (_) {}
    const exists = saved && Array.from(this.threadSel.options).some((o) => o.value === saved);
    if (exists) {
      await this.openThread(saved);
      this.threadSel.value = saved;
    } else {
      this.newThread();
    }
  }

  _saveActive(id) { try { if (id) localStorage.setItem(ACTIVE_THREAD_KEY, id); } catch (_) {} }
  _clearActive() { try { localStorage.removeItem(ACTIVE_THREAD_KEY); } catch (_) {} }

  // ── styling ────────────────────────────────────────────────────────────────
  _injectStyles() {
    if (document.getElementById("agentY-chat-styles")) return;
    const css = `
    .ay-wrap{
      --ay-bg:#262624; --ay-surface:#302f2c; --ay-surface2:#3b3936;
      --ay-border:rgba(240,235,225,.10); --ay-text:#f2f0ea; --ay-muted:#a8a39a;
      --ay-accent:#5b9bf5; --ay-accent2:#4785e6; --ay-accent-soft:rgba(91,155,245,.15);
      position:relative;display:flex;flex-direction:column;height:100%;
      font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
      font-size:13.5px;line-height:1.5;color:var(--ay-text);background:var(--ay-bg);
    }
    .ay-bar{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--ay-border);flex-shrink:0;}
    .ay-bar select{flex:1;background:var(--ay-surface);color:var(--ay-text);border:1px solid var(--ay-border);border-radius:10px;padding:7px 10px;font-size:12.5px;cursor:pointer;}
    .ay-btn{background:var(--ay-surface2);color:var(--ay-text);border:1px solid var(--ay-border);border-radius:10px;padding:7px 11px;cursor:pointer;font-size:12.5px;transition:background .12s,border-color .12s,transform .06s;}
    /* Toggle button in its ON state (e.g. auto-graph enabled). */
    .ay-btn.ay-on{background:var(--ay-accent);color:#0a1a30;border-color:transparent;}
    .ay-btn.ay-on:hover{background:var(--ay-accent2);}
    .ay-btn:hover{background:#464440;}
    .ay-btn:active{transform:translateY(1px);}
    .ay-btn.ay-send{background:var(--ay-accent);color:#0a1a30;border-color:transparent;border-radius:999px;padding:9px 18px;font-weight:600;}
    .ay-icon-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;}
    .ay-icon-btn svg{width:17px;height:17px;display:block;flex-shrink:0;}
    .ay-btn-label{font-size:12.5px;line-height:1;}
    .ay-btn.ay-send:hover{background:var(--ay-accent2);}
    .ay-btn.ay-stop{background:#8a4034;color:#ffe1d9;border-color:transparent;border-radius:999px;}
    .ay-btn.ay-stop:hover{background:#9c4a3c;}
    .ay-log{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}
    /* Log children are flex items in a column; without this they shrink to fit the
       panel (collapsing tool/step boxes to a sliver) instead of overflowing into
       the scroll area. Pin their height so the log scrolls as it grows. */
    .ay-log>*{flex-shrink:0;}
    .ay-msg{padding:10px 13px;border-radius:16px;max-width:92%;word-wrap:break-word;line-height:1.5;}
    .ay-user{background:var(--ay-accent-soft);border:1px solid rgba(91,155,245,.28);align-self:flex-end;border-bottom-right-radius:5px;}
    .ay-assistant{background:var(--ay-surface);align-self:flex-start;border-bottom-left-radius:5px;}
    .ay-system{background:transparent;color:var(--ay-muted);font-size:12px;align-self:center;text-align:center;max-width:100%;padding:2px 8px;}
    .ay-ask{background:rgba(91,155,245,.10);color:#f0d9c2;border:1px solid rgba(91,155,245,.35);align-self:stretch;max-width:100%;}
    .ay-code{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,monospace;background:rgba(0,0,0,.25);padding:2px 5px;border-radius:6px;font-size:12px;}
    .ay-link{color:var(--ay-accent);text-decoration:underline;}
    .ay-link:hover{color:var(--ay-accent2);}
    /* "Working" marker: an animated "..." shown from the moment a turn starts
       (user hits Enter) until it finishes, pinned to the bottom of the log. The
       dots are cycled in JS (setInterval), not CSS — @keyframes weren't rendering
       inside this ComfyUI sidebar panel. */
    .ay-working{align-self:flex-start;padding:2px 13px 8px;}
    .ay-working .ay-dots{font-family:ui-monospace,SFMono-Regular,monospace;font-size:22px;line-height:1;font-weight:700;letter-spacing:3px;color:var(--ay-muted);display:inline-block;min-width:34px;}
    .ay-step{border:1px solid var(--ay-border);border-radius:12px;background:var(--ay-surface);overflow:hidden;align-self:stretch;}
    .ay-step>summary{cursor:pointer;padding:8px 12px;color:var(--ay-muted);font-weight:600;font-size:12px;list-style:none;}
    .ay-step>summary::-webkit-details-marker{display:none;}
    .ay-step>summary::before{content:"▸ ";opacity:.7;}
    .ay-step[open]>summary::before{content:"▾ ";}
    .ay-step .ay-step-body{padding:8px 12px;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;color:var(--ay-muted);max-height:240px;overflow:auto;word-break:break-word;border-top:1px solid var(--ay-border);}
    .ay-step.ay-tool{border-color:rgba(127,212,160,.22);}
    .ay-step.ay-tool>summary{color:#8fd6ab;}
    .ay-step.ay-console{border-color:rgba(150,175,220,.22);}
    .ay-step.ay-console>summary{color:#9db8de;}
    .ay-status{font-size:11px;color:var(--ay-muted);padding:2px 12px;font-family:ui-monospace,monospace;align-self:center;}
    .ay-inwrap{border-top:1px solid var(--ay-border);padding:10px 12px;display:flex;flex-direction:column;gap:8px;flex-shrink:0;position:relative;background:var(--ay-bg);}
    .ay-attach{display:flex;flex-wrap:wrap;gap:5px;}
    .ay-chip{background:var(--ay-surface2);border:1px solid var(--ay-border);border-radius:999px;padding:3px 9px;font-size:11px;color:var(--ay-text);}
    /* Live read-out of the canvas selection. Capped in height so selecting half a
       graph scrolls here instead of squeezing the message field off screen. */
    .ay-selbar{display:none;flex-wrap:wrap;gap:5px;align-items:center;max-height:66px;overflow-y:auto;}
    .ay-selbar .ay-selcount{font-size:11px;color:var(--ay-muted);font-weight:600;}
    .ay-selbar .ay-selchip{background:transparent;border-color:rgba(150,175,220,.35);color:#9db8de;}
    .ay-selbar .ay-selmore{font-size:11px;color:var(--ay-muted);}
    .ay-inrow{display:flex;gap:8px;align-items:flex-end;--ay-composer-h:40px;}
    /* The message field and the buttons beside it share ONE height so nothing sits
       higher than its neighbours. The field's vertical padding is chosen so a single
       line of text fits inside that height (13.5px x 1.5 line + 2px border + 2x8px
       padding = 38.25px, under the 40px floor), and when it grows past one line the
       buttons stay pinned to the bottom via align-items:flex-end. */
    .ay-inrow .ay-btn{height:var(--ay-composer-h);box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;}
    .ay-input{flex:1;resize:none;min-height:var(--ay-composer-h);max-height:150px;box-sizing:border-box;background:var(--ay-surface);color:var(--ay-text);border:1px solid var(--ay-border);border-radius:14px;padding:8px 13px;font-family:inherit;font-size:13.5px;line-height:1.5;outline:none;transition:border-color .12s;}
    .ay-input:focus{border-color:rgba(91,155,245,.55);}
    .ay-input::placeholder{color:var(--ay-muted);}
    .ay-modelbar{display:flex;align-items:center;gap:7px;padding:8px 12px 10px;border-top:1px solid var(--ay-border);flex-shrink:0;background:var(--ay-bg);}
    .ay-mlabel{color:var(--ay-muted);font-size:11.5px;flex-shrink:0;}
    .ay-modelbar select{background:var(--ay-surface);color:var(--ay-text);border:1px solid var(--ay-border);border-radius:9px;padding:6px 9px;font-size:12px;cursor:pointer;transition:border-color .12s;}
    .ay-modelbar select:hover{border-color:rgba(91,155,245,.45);}
    .ay-modelbar select:disabled{opacity:.45;cursor:not-allowed;}
    .ay-mmodel{flex:1;min-width:0;}
    .ay-pop{position:absolute;bottom:100%;left:12px;right:12px;margin-bottom:6px;background:var(--ay-surface);border:1px solid var(--ay-border);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:50;max-height:280px;overflow:auto;display:none;}
    .ay-pop-item{padding:8px 12px;cursor:pointer;display:flex;gap:10px;align-items:baseline;}
    .ay-pop-item:hover,.ay-pop-item.sel{background:var(--ay-surface2);}
    .ay-pop-item.sel{box-shadow:inset 3px 0 0 var(--ay-accent);}
    .ay-pop-name{font-family:ui-monospace,monospace;color:var(--ay-accent);min-width:130px;font-size:12.5px;}
    .ay-pop-desc{color:var(--ay-muted);font-size:12px;}
    .ay-log::-webkit-scrollbar,.ay-step-body::-webkit-scrollbar,.ay-pop::-webkit-scrollbar{width:8px;height:8px;}
    .ay-log::-webkit-scrollbar-thumb,.ay-step-body::-webkit-scrollbar-thumb,.ay-pop::-webkit-scrollbar-thumb{background:var(--ay-surface2);border-radius:8px;}
    /* Queued messages (typed while a turn is running; auto-sent on completion). */
    .ay-queue{display:flex;flex-direction:column;gap:5px;}
    .ay-qchip{display:flex;gap:8px;align-items:center;background:var(--ay-accent-soft);border:1px solid rgba(91,155,245,.30);border-radius:10px;padding:5px 10px;font-size:12px;color:var(--ay-text);}
    .ay-qchip .ay-qtext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ay-qchip .ay-qx{cursor:pointer;color:var(--ay-muted);flex-shrink:0;}
    .ay-qchip .ay-qx:hover{color:var(--ay-text);}
    .ay-qchip .ay-qnow{cursor:pointer;color:var(--ay-accent);flex-shrink:0;font-weight:700;line-height:1;}
    .ay-qchip .ay-qnow:hover{color:var(--ay-text);}
    /* Offline overlay — dims + blocks the whole panel while the host is down,
       leaving only the "Start server" button actionable. */
    /* position:fixed, with its box set from the panel's on-screen rectangle by
       _positionOffline(). Absolute + inset:0 centred the card in the PANEL, which is
       as tall as its content — so the button drifted somewhere down the conversation
       instead of sitting in the middle of the screen. */
    .ay-offline-panel{position:fixed;z-index:200;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:28px;text-align:center;background:rgba(38,38,36,.86);backdrop-filter:blur(2px);}
    .ay-offline-card{max-width:340px;display:flex;flex-direction:column;align-items:center;gap:14px;background:var(--ay-surface);border:1px solid var(--ay-border);border-radius:16px;padding:26px 22px;box-shadow:0 16px 48px rgba(0,0,0,.5);}
    .ay-offline-card .ay-offline-icon{font-size:30px;line-height:1;}
    .ay-offline-card .ay-offline-title{font-weight:600;font-size:15px;color:var(--ay-text);}
    .ay-offline-card .ay-offline-msg{font-size:12.5px;color:var(--ay-muted);line-height:1.55;}
    .ay-offline-card .ay-start{background:var(--ay-accent);color:#0a1a30;border:none;border-radius:999px;padding:10px 22px;font-weight:600;font-size:13px;cursor:pointer;transition:background .12s;}
    .ay-offline-card .ay-start:hover{background:var(--ay-accent2);}
    .ay-offline-card .ay-start:disabled{opacity:.55;cursor:default;}
    /* Toast host lives on <body> (outside .ay-wrap) so notifications pop even when
       the agentY tab isn't the active sidebar — hence self-contained colors. */
    .ay-toast-host{position:fixed;top:16px;right:16px;z-index:100000;display:flex;flex-direction:column;gap:10px;max-width:340px;pointer-events:none;}
    .ay-toast{pointer-events:auto;background:#302f2c;color:#f2f0ea;border:1px solid rgba(240,235,225,.14);border-left:3px solid #5b9bf5;border-radius:12px;padding:12px 14px;box-shadow:0 12px 40px rgba(0,0,0,.5);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:1.45;cursor:default;opacity:0;transform:translateX(12px);transition:opacity .18s ease,transform .18s ease;}
    .ay-toast.ay-in{opacity:1;transform:translateX(0);}
    .ay-toast.ay-success{border-left-color:#57b96b;}
    .ay-toast.ay-error{border-left-color:#d1685a;}
    .ay-toast .ay-toast-title{font-weight:600;margin-bottom:2px;display:flex;align-items:center;gap:7px;}
    .ay-toast .ay-toast-body{color:#cfcabf;}
    .ay-toast .ay-toast-link{display:inline-block;margin-top:6px;color:#5b9bf5;text-decoration:underline;font-size:12px;cursor:pointer;}
    .ay-toast .ay-toast-x{position:absolute;top:8px;right:10px;color:#a8a39a;cursor:pointer;font-size:13px;line-height:1;}
    `;
    document.head.append(el("style", { id: "agentY-chat-styles", textContent: css }));
  }

  // ── DOM ────────────────────────────────────────────────────────────────────
  _build() {
    const wrap = el("div", { className: "ay-wrap" });

    // top bar: thread selector + new + delete. Button glyphs are Lucide SVGs
    // assigned in iconsUI.json; the emoji passed to setButtonIcon is the fallback
    // shown until the icons load (or if that fetch fails).
    this.threadSel = el("select", { title: "Conversation" });
    this.threadSel.addEventListener("change", () => this.openThread(this.threadSel.value));
    const newBtn = el("button", { className: "ay-btn", title: "New chat" });
    setButtonIcon(newBtn, "newChat", "＋");
    newBtn.addEventListener("click", () => this.newThread());
    const delBtn = el("button", { className: "ay-btn", title: "Delete this conversation" });
    setButtonIcon(delBtn, "deleteChat", "🗑");
    delBtn.addEventListener("click", () => this.deleteThread());
    const usageBtn = el("button", { className: "ay-btn", title: "Token usage overview" });
    setButtonIcon(usageBtn, "tokenUsage", "📊");
    usageBtn.addEventListener("click", () => window.agentYOpenTokenUsage && window.agentYOpenTokenUsage());
    // Auto-graph toggle: flips `autoload_workflows_into_canvas` on the host. The
    // message-history and long-term-memory viewers moved OUT of this bar into the
    // agentY Settings modal (agent_settings.js) to declutter — they're opened from
    // there via the same window.agentYOpen* globals.
    this.autographBtn = el("button", { className: "ay-btn", title: "Auto-graph workflows onto canvas" });
    setButtonIcon(this.autographBtn, "autograph", "🖼");
    this.autographBtn.addEventListener("click", () => this._toggleAutograph());
    wrap.append(el("div", { className: "ay-bar" }, [this.threadSel, newBtn, delBtn, usageBtn, this.autographBtn]));

    // message log
    this.logEl = el("div", { className: "ay-log" });
    wrap.append(this.logEl);

    // input area
    this.attachEl = el("div", { className: "ay-attach" });
    this.selBarEl = el("div", { className: "ay-selbar" });
    this.queueEl = el("div", { className: "ay-queue" });
    this.pop = el("div", { className: "ay-pop" });
    this.input = el("textarea", { className: "ay-input", placeholder: "Message agentY…  (type / for commands)" });
    this.input.addEventListener("input", () => this._onInput());
    this.input.addEventListener("keydown", (e) => this._onKeydown(e));

    const attachBtn = el("button", { className: "ay-btn", title: "Attach image" });
    setButtonIcon(attachBtn, "attach", "📎");
    this.fileInput = el("input", { type: "file", accept: "image/*", multiple: true, style: { display: "none" } });
    this.fileInput.addEventListener("change", () => this._onFiles());
    attachBtn.addEventListener("click", () => this.fileInput.click());

    this.sendBtn = el("button", { className: "ay-btn ay-send", title: "Send" });
    setButtonIcon(this.sendBtn, "send", "Send");
    this.sendBtn.addEventListener("click", () => this._onSendBtn());

    const inrow = el("div", { className: "ay-inrow" }, [attachBtn, this.input, this.sendBtn]);
    const inwrap = el("div", { className: "ay-inwrap" },
      [this.pop, this.queueEl, this.selBarEl, this.attachEl, inrow, this.fileInput]);
    wrap.append(inwrap);
    this._startSelectionIndicator();

    // model quick-switch bar (bottom)
    wrap.append(this._buildModelBar());

    // Offline overlay (shown when the agentY host is unreachable): dims the whole
    // panel and offers a single "Start server" button. Built once, hidden by
    // default; _setHostUp() toggles it.
    wrap.append(this._buildOfflinePanel());

    // Once iconsUI.json loads, swap every button's fallback glyph for its Lucide
    // SVG (no-op if already applied synchronously above / if the fetch failed).
    iconsReady.then(() => applyIcons(wrap));

    // Keep the built DOM detached; mount() re-parents it into the live sidebar.
    this.wrap = wrap;

    // The offline overlay is position:fixed, so it has to be re-measured whenever
    // the panel's on-screen rectangle can move: window resize, page scroll, or the
    // sidebar being dragged wider. Capture-phase scroll catches inner scrollers too.
    const reposition = () => this._positionOffline();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    if (window.ResizeObserver) {
      this._wrapRO = new ResizeObserver(reposition);
      this._wrapRO.observe(wrap);
    }
  }

  // ── model quick-switch bar ───────────────────────────────────────────────────
  _buildModelBar() {
    this.targetSel = el("select", { className: "ay-mtarget", title: "Which agent(s) to switch" });
    for (const [val, label] of MODEL_TARGETS) {
      this.targetSel.append(el("option", { value: val, textContent: label }));
    }
    this.modelSel = el("select", { className: "ay-mmodel", title: "Switch model" });
    // Seed with the static presets; _loadModels() replaces this at startup with
    // the vendors/models actually available (Ollama installed list, and
    // Anthropic/DashScope only when their API key is set).
    this._populateModelSelect(MODEL_PRESETS);
    this.modelSel.addEventListener("change", () => this._applyModel());
    return el("div", { className: "ay-modelbar" }, [
      el("span", { className: "ay-mlabel", textContent: "Model" }),
      this.modelSel,
      this.targetSel,
    ]);
  }

  // ── offline overlay + host-up state ──────────────────────────────────────────
  _buildOfflinePanel() {
    this._offlineMsg = el("div", { className: "ay-offline-msg", innerHTML: mdToHtml(OFFLINE_MSG) });
    this._startBtn = el("button", { className: "ay-start", textContent: "▶  Start server" });
    this._startBtn.addEventListener("click", () => this._startHost());
    const card = el("div", { className: "ay-offline-card" }, [
      el("div", { className: "ay-offline-icon", textContent: "🔌" }),
      el("div", { className: "ay-offline-title", textContent: "agentY host offline" }),
      this._offlineMsg,
      this._startBtn,
    ]);
    this.offlineEl = el("div", { className: "ay-offline-panel" }, [card]);
    return this.offlineEl;
  }

  // Reflect host reachability in the UI: while down, the overlay dims + blocks
  // every control except its "Start server" button; coming back up hides it.
  // Size/position the fixed overlay onto whatever part of the panel is on screen,
  // so its card is centred in the VIEWPORT rather than in the conversation.
  _positionOffline() {
    if (!this.offlineEl || !this.wrap || this.offlineEl.style.display === "none") return;
    const r = this.wrap.getBoundingClientRect();
    const top = Math.max(0, r.top);
    const bottom = Math.min(window.innerHeight, r.bottom);
    Object.assign(this.offlineEl.style, {
      left: `${r.left}px`, width: `${r.width}px`,
      top: `${top}px`, height: `${Math.max(0, bottom - top)}px`,
    });
  }

  _setHostUp(up) {
    this._hostUp = up;
    if (!this.offlineEl) return;
    this.offlineEl.style.display = up ? "none" : "flex";
    if (!up) {
      this._positionOffline();
      // Reset the card to its default actionable state each time we go offline.
      if (this._startBtn) { this._startBtn.disabled = false; this._startBtn.textContent = "▶  Start server"; }
      if (this._offlineMsg) this._offlineMsg.innerHTML = mdToHtml(OFFLINE_MSG);
    }
  }

  // Ask the ComfyUI extension (same origin) to launch run_agent.ps1 in a new
  // console. The reconnect watcher (already polling while we're offline) hides the
  // overlay and reloads the panel once the host answers on :5000.
  async _startHost() {
    this._startBtn.disabled = true;
    this._startBtn.textContent = "Starting…";
    this._offlineMsg.innerHTML = mdToHtml("Launching the agentY host — a PowerShell window will open…");
    try {
      const r = await fetch(comfyBase() + "/agent/start_host", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        this._offlineMsg.innerHTML = mdToHtml(
          "Couldn't start it automatically: " + (j.error || ("HTTP " + r.status)) +
          "\n\nRun `run_agent.ps1` in the agentY folder manually."
        );
        this._startBtn.disabled = false;
        this._startBtn.textContent = "▶  Start server";
        return;
      }
      this._offlineMsg.innerHTML = mdToHtml("Host starting… waiting for it to come online.");
      // The reconnect watcher is already running (we're offline); it'll flip us
      // back online when :5000 answers. Kick it in case it somehow isn't.
      this._startReconnect(!this.threadId);
    } catch (e) {
      this._offlineMsg.innerHTML = mdToHtml(
        "Couldn't reach ComfyUI to start the host: " + e +
        "\n\nMake sure the agentY-comfyuiConnect extension is installed, then restart ComfyUI."
      );
      this._startBtn.disabled = false;
      this._startBtn.textContent = "▶  Start server";
    }
  }

  // ── CLI status notices (memory init, model pulls, …) ─────────────────────────
  _saveStatusSeq() { try { localStorage.setItem(STATUS_SEQ_KEY, String(this._lastStatusSeq)); } catch (_) {} }
  _noteStatusSeq(seq) {
    if (typeof seq === "number" && seq > this._lastStatusSeq) { this._lastStatusSeq = seq; this._saveStatusSeq(); }
  }

  // Pull any status lines the panel hasn't shown yet (startup notices that predate
  // the connection, or lines emitted between turns). In-turn lines already arrived
  // live as `status_line` SSE events and advanced _lastStatusSeq, so `since` skips
  // them. If the host's counter is below ours it restarted → re-drain from 0.
  async _drainStatus() {
    if (!this._hostUp) return;
    try {
      let since = this._lastStatusSeq || 0;
      let r = await fetch(backendBase() + "/agentY/status?since=" + since, { cache: "no-store" });
      if (!r.ok) return;
      let snap = await r.json();
      if (typeof snap.seq === "number" && snap.seq < since) {
        this._lastStatusSeq = 0;
        r = await fetch(backendBase() + "/agentY/status?since=0", { cache: "no-store" });
        if (!r.ok) return;
        snap = await r.json();
      }
      for (const m of (snap.messages || [])) {
        this._sys(m.text);
        this._noteStatusSeq(m.seq);
      }
    } catch (_) {}
  }

  // ── background notifications (Magnific auto-drop, …) ──────────────────────────
  // Structured events that land BETWEEN turns (an async generation finishing
  // minutes after its turn ended). There's no live SSE stream while idle, so poll
  // on a timer; events that arrive live during a turn come through `_onEvent`'s
  // `notify` case and advance the same seq, so `since` dedupes the two paths.
  _saveNotifySeq() { try { localStorage.setItem(NOTIFY_SEQ_KEY, String(this._lastNotifySeq)); } catch (_) {} }
  _noteNotifySeq(seq) {
    if (typeof seq === "number" && seq > this._lastNotifySeq) { this._lastNotifySeq = seq; this._saveNotifySeq(); }
  }

  // Start (or re-arm) the idle poll. Called on connect and after every turn —
  // a turn may have queued a background generation whose completion lands minutes
  // later. The poll then stops itself once the host reports nothing pending (see
  // _drainNotifications), so an idle tab isn't hitting the endpoint forever.
  _startNotifyPoll() {
    // Drain once now. _drainNotifications arms the 8 s interval iff the host still
    // has a generation in flight, and stops it once nothing is pending — so the
    // idle tab isn't polling forever, yet a completion still lands promptly.
    this._drainNotifications();
    // Nothing is drained while this ComfyUI tab is hidden: a backgrounded tab
    // shouldn't hammer /agentY/notifications, and skipping keeps the drop landing
    // in the tab the user is actually looking at (see _drainNotifications). The
    // catch-up when they return is _onShown's job.
  }

  _armNotifyPoll() {
    if (this._notifyTimer) return;
    // 8 s is a good cadence while something is in flight: fast enough that a
    // finished render appears promptly, cheap enough to leave running.
    this._notifyTimer = setInterval(() => { this._drainNotifications(); }, 8000);
  }

  _stopNotifyPoll() {
    if (this._notifyTimer) { clearInterval(this._notifyTimer); this._notifyTimer = null; }
  }

  async _drainNotifications() {
    if (!this._hostUp) return;
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      let since = this._lastNotifySeq || 0;
      let r = await fetch(backendBase() + "/agentY/notifications?since=" + since, { cache: "no-store" });
      if (!r.ok) return;
      let snap = await r.json();
      if (typeof snap.seq === "number" && snap.seq < since) {
        // Host restarted (its counter reset below ours) → re-drain from 0.
        this._lastNotifySeq = 0;
        r = await fetch(backendBase() + "/agentY/notifications?since=0", { cache: "no-store" });
        if (!r.ok) return;
        snap = await r.json();
      }
      for (const evt of (snap.events || [])) this._handleNotify(evt);
      // Keep polling only while the host still has a generation in flight; once
      // it drains to zero, stop until the next turn re-arms us. `pending` is
      // undefined on older hosts → treat as "keep polling" (prior behavior).
      if (snap.pending === 0) this._stopNotifyPoll();
      else this._armNotifyPoll();
    } catch (_) {}
  }

  // Apply one notification (from the idle poll or a live `notify` SSE event).
  // Idempotent per seq: a lower/equal seq was already handled, so skip it.
  _handleNotify(evt) {
    if (!evt || typeof evt.seq !== "number" || evt.seq <= this._lastNotifySeq) return;
    this._noteNotifySeq(evt.seq);
    try {
      if (evt.output && evt.output.path) {
        this.injectNode(evt.output);           // drop the finished asset onto the canvas
      }
    } catch (e) { console.error("[agentY] notify injectNode failed", e); }
    const t = evt.toast || {};
    if (t.title || t.body) this._toast(t);
  }

  // A self-contained pop-up: an in-UI toast on <body> (always) plus an OS-level
  // browser Notification when the user has granted permission (valuable when the
  // ComfyUI tab is in the background). Permission is requested on a user gesture
  // in `send()`; we never force a prompt here.
  _toast(t) {
    const level = t.level || "info";
    try {
      let host = document.getElementById("agentY-toast-host");
      if (!host) {
        host = el("div", { id: "agentY-toast-host", className: "ay-toast-host" });
        document.body.appendChild(host);
      }
      const card = el("div", { className: "ay-toast ay-" + level });
      const icon = level === "success" ? "✨" : level === "error" ? "⚠️" : "🔔";
      card.appendChild(el("div", { className: "ay-toast-x", textContent: "✕" }));
      card.appendChild(el("div", { className: "ay-toast-title", textContent: icon + "  " + (t.title || "agentY") }));
      if (t.body) card.appendChild(el("div", { className: "ay-toast-body", textContent: t.body }));
      if (t.url) {
        const link = el("span", { className: "ay-toast-link", textContent: "Open in Magnific ↗" });
        link.addEventListener("click", () => { try { window.open(t.url, "_blank", "noopener"); } catch (_) {} });
        card.appendChild(link);
      }
      host.appendChild(card);
      requestAnimationFrame(() => card.classList.add("ay-in"));
      const dismiss = () => {
        card.classList.remove("ay-in");
        setTimeout(() => { if (card.parentNode) card.parentNode.removeChild(card); }, 220);
      };
      card.querySelector(".ay-toast-x").addEventListener("click", dismiss);
      // Errors linger; successes auto-dismiss after 12 s.
      if (level !== "error") setTimeout(dismiss, 12000);
    } catch (e) { console.error("[agentY] toast failed", e); }

    // OS-level notification (best-effort; needs prior granted permission).
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(t.title || "agentY", { body: t.body || "", tag: "agentY-magnific" });
      }
    } catch (_) {}
  }

  // Ask once for browser-notification permission, from a user gesture (send()).
  _ensureNotifyPermission() {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
    } catch (_) {}
  }

  // ── queued messages (typed while a turn is running) ──────────────────────────
  _queueMessage(text, opts = {}) {
    this._queue.push({
      text: text || "",
      attachments: this.attachments.slice(),
      // Already shown in the log (it was sent mid-run and handed back) — don't
      // echo it a second time when the queue dispatches it.
      echoed: !!opts.echoed,
      // A dry run queued behind a running turn is still a dry run when its turn
      // comes; the flag has to survive the wait or it silently generates.
      dryRun: !!opts.dryRun,
    });
    this.input.value = "";
    this._autosize();
    this._hidePop();
    this.attachments = [];
    this._renderAttachments();
    this._renderQueue();
  }
  _renderQueue() {
    this.queueEl.innerHTML = "";
    this._queue.forEach((q, i) => {
      const label = (q.text || "(image only)") + (q.attachments.length ? `  📎${q.attachments.length}` : "");
      const chip = el("div", { className: "ay-qchip", title: "Queued — sends when the current turn finishes" }, [
        el("span", { className: "ay-qtext", textContent: "⏳ " + label }),
      ]);
      // "Send now": hand it to the turn that is already running instead of
      // waiting for it to end. Text only — an interjection reaches the agent as
      // part of a tool result, which carries no images.
      if (this.streaming && this.curRequestId && q.text && !q.attachments.length) {
        const now = el("span", {
          className: "ay-qnow", textContent: "↳",
          title: "Send now — the agent picks this up at its next step\n(Shift+click: cancel what it's doing and read this first)",
        });
        now.addEventListener("click", (e) => this._interject(i, e.shiftKey));
        chip.append(now);
      }
      chip.append(el("span", { className: "ay-qx", textContent: "✕", title: "Remove from queue" }));
      chip.querySelector(".ay-qx").addEventListener("click", () => { this._queue.splice(i, 1); this._renderQueue(); });
      this.queueEl.append(chip);
    });
  }

  // Deliver queued message #i into the RUNNING turn. The agent reads it at its
  // next tool boundary (urgent cancels the pending call so it reads it instead).
  // A 409 means the turn finished in the meantime — leave it queued, where it
  // will be sent as a normal message, which is what would have happened anyway.
  async _interject(i, urgent = false) {
    const item = this._queue[i];
    if (!item || !item.text) return;
    let res = null;
    try {
      res = await fetch(backendBase() + "/agentY/interject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: this.curRequestId, text: item.text, urgent: !!urgent }),
      });
    } catch (e) {
      this._sys("❌ Could not send that mid-run: " + e);
      return;
    }
    if (!res.ok) {
      this._sys(res.status === 409
        ? "_The turn just finished — that message stays queued and sends next._"
        : "❌ Mid-run send failed (" + res.status + ").");
      this._renderQueue();
      return;
    }
    this._queue.splice(i, 1);
    this._renderQueue();
    this._userMsg(item.text + (urgent ? "  \n_(sent mid-run — urgent)_" : "  \n_(sent mid-run)_"));
  }

  // Dispatch the next queued message once the pipeline is free (called on `done`).
  _maybeDispatchQueued() {
    if (this.streaming || this.activeAsk || !this._hostUp || !this._queue.length) return;
    const item = this._queue.shift();
    this._renderQueue();
    this.input.value = item.text || "";
    this.attachments = item.attachments || [];
    this._renderAttachments();
    this._skipEcho = !!item.echoed;
    this._dryRunOnce = !!item.dryRun;
    this.send(); // re-captures canvas state at dispatch time; clears input/attachments
  }

  // Rebuild the model dropdown from a { "<vendor>": [[spec,label],…] } map,
  // preserving the current selection where possible.
  _populateModelSelect(groups) {
    const sel = this.modelSel;
    const cur = sel.value;
    sel.innerHTML = "";
    sel.append(el("option", { value: "", textContent: "🔀 Switch model…" }));
    for (const [group, models] of Object.entries(groups || {})) {
      if (!models || !models.length) continue;
      const og = el("optgroup", { label: group });
      for (const [spec, label] of models) og.append(el("option", { value: spec, textContent: label }));
      sel.append(og);
    }
    if (cur) sel.value = cur;
  }

  // Fetch what a model switch may target: the six tiers (the normal choice) plus
  // the individual roles, which write a per-role override. Both lists come from the
  // agent's tier map, so this menu mirrors Settings ▸ Models & providers exactly.
  async _loadSwitchTargets() {
    let data = null;
    try {
      const r = await fetch(backendBase() + "/agentY/switch_targets", { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch (_) { /* host down — keep the fallback list */ }
    if (!data || !(data.tiers || []).length) return;
    const sel = this.targetSel;
    const cur = sel.value;
    sel.innerHTML = "";
    sel.append(el("option", { value: "all", textContent: "All tiers" }));
    const tg = el("optgroup", { label: "Tier" });
    for (const t of data.tiers) {
      tg.append(el("option", { value: t.value, textContent: t.label }));
    }
    sel.append(tg);
    if ((data.roles || []).length) {
      const rg = el("optgroup", { label: "Single role (overrides its tier)" });
      for (const r of data.roles) {
        rg.append(el("option", { value: r.value, textContent: `${r.label}  ·  ${r.tier}` }));
      }
      sel.append(rg);
    }
    if (cur && sel.querySelector(`option[value="${cur}"]`)) sel.value = cur;
  }

  // Fetch the live vendor/model list from the host; fall back to static presets.
  async _loadModels() {
    try {
      const r = await fetch(backendBase() + "/agentY/models", { cache: "no-store" });
      if (r.ok) {
        const groups = await r.json();
        if (groups && Object.keys(groups).length) { this._populateModelSelect(groups); return; }
      }
    } catch (_) { this._startReconnect(false); }
    // Host unreachable or returned nothing — show the offline presets for now; the
    // reconnect watcher swaps in the live list (incl. Ollama) once the host answers.
    this._populateModelSelect(MODEL_PRESETS);
  }

  async _applyModel() {
    const spec = this.modelSel.value;
    if (!spec) return;
    if (this.streaming) { this.modelSel.value = ""; return; } // don't switch mid-turn
    const target = this.targetSel.value || "all";
    this.modelSel.value = ""; // reset to placeholder
    try {
      const r = await fetch(backendBase() + "/agentY/switch_model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, spec }),
      });
      const j = await r.json();
      (j.messages && j.messages.length ? j.messages : [(j.ok ? "✅ Model switched." : "❌ Switch failed.")])
        .forEach((m) => this._sys(m));
    } catch (e) {
      this._sys("❌ Switch failed: " + e);
    }
    this._savePanel();
  }

  // ── backend calls ───────────────────────────────────────────────────────────
  async _loadCommands() {
    try {
      const r = await fetch(backendBase() + "/agentY/commands", { cache: "no-store" });
      if (r.ok) this.commands = await r.json();
    } catch (_) {}
  }

  async _loadThreads() {
    try {
      const r = await fetch(backendBase() + "/agentY/threads", { cache: "no-store" });
      const list = r.ok ? await r.json() : [];
      this.threadSel.innerHTML = "";
      for (const t of list) {
        this.threadSel.append(el("option", { value: t.id, textContent: t.title || "New chat" }));
      }
      this._syncThreadSel();
    } catch (_) {}
  }

  // Reflect the current threadId in the dropdown. With no active thread — a fresh
  // "New chat" that hasn't been persisted yet — show a "--" placeholder instead of
  // leaving the previously-selected conversation's name displayed.
  _syncThreadSel() {
    if (!this.threadSel) return;
    const ph = this.threadSel.querySelector('option[value=""]');
    if (this.threadId) {
      if (ph) ph.remove();
      this.threadSel.value = this.threadId;
    } else {
      if (!ph) this.threadSel.prepend(el("option", { value: "", textContent: "--" }));
      this.threadSel.value = "";
    }
  }

  // Snapshot the current thread's live-rendered panel (thinking/step blocks and
  // all) so returning to it later this session restores exactly what was shown.
  _saveCurrentDom() {
    if (this.threadId) {
      this.domCache.set(this.threadId, { html: this._logHtml(), scroll: this.logEl.scrollTop });
    }
  }

  // Persist the rendered panel (collapsible think/step blocks and all) to the
  // backend so it survives page reloads / new sessions, not just in-session
  // switches. Fire-and-forget.
  _savePanel() {
    if (!this.threadId) return;
    fetch(backendBase() + "/agentY/threads/" + this.threadId + "/panel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: this._logHtml() }),
    }).catch(() => {});
  }

  newThread() {
    this._saveCurrentDom();
    this.threadId = null;
    this._clearActive(); // no persisted thread until the first message assigns one
    this._syncThreadSel(); // dropdown shows "--" until the first message assigns a thread
    this.logEl.innerHTML = "";
    this._sys("New conversation. Ask me to generate or edit an image/video — results drop onto the graph as nodes.");
  }

  async deleteThread() {
    if (!this.threadId) return this.newThread();
    const tid = this.threadId;
    try {
      await fetch(backendBase() + "/agentY/threads/" + tid, { method: "DELETE" });
    } catch (_) {}
    this.domCache.delete(tid);
    this.threadId = null; // so newThread() doesn't re-cache the just-deleted thread
    this.newThread();
    this._loadThreads();
  }

  async openThread(id) {
    if (!id || id === this.threadId) return;
    await this._renderThread(id);
    // Whatever was just drawn is a snapshot; only the host knows whether this
    // conversation still has a turn in flight.
    await this._syncRunState();
  }

  // `fresh` rebuilds from the persisted record, ignoring (and dropping) the
  // session DOM cache. Needed after an adopted turn ends: the cached DOM is the
  // mid-turn snapshot, and _saveCurrentDom below would otherwise re-cache it and
  // hand it straight back as if it were the finished conversation.
  async _renderThread(id, fresh = false) {
    this._saveCurrentDom();
    if (fresh) this.domCache.delete(id);
    // The DOM is about to be replaced, which orphans every node the live stream
    // is writing into. Drop those references so that if we come back mid-turn the
    // next event builds fresh ones in the current panel instead of appending to
    // detached nodes nobody will ever see.
    this.curAssistant = null;
    this.curStep = null;
    this._thinkStep = null;
    this._toolBlocks = {};
    this._consoleEl = null;
    this.threadId = id;
    this._saveActive(id);
    this._syncThreadSel(); // drop the "--" placeholder and select the opened thread
    // Restore the live-rendered panel if we've shown this thread already this
    // session (keeps the thinking/step blocks); otherwise rebuild from the
    // persisted messages, which store only the final user/assistant text.
    const cached = this.domCache.get(id);
    if (cached) {
      this.logEl.innerHTML = cached.html;
      this.logEl.scrollTop = cached.scroll;
      return;
    }
    this.logEl.innerHTML = "";
    try {
      const r = await fetch(backendBase() + "/agentY/threads/" + id, { cache: "no-store" });
      if (!r.ok) return;
      const t = await r.json();
      // Prefer the persisted rendered panel — collapsible think/step blocks
      // intact, survives page reloads — and only fall back to the text-only
      // message log for threads that were never rendered (e.g. pre-dating this).
      if (t.panel_html) {
        this.logEl.innerHTML = t.panel_html;
        this.logEl.scrollTop = this.logEl.scrollHeight;
        return;
      }
      for (const m of t.messages || []) {
        if (m.role === "user") this._userMsg(m.content);
        else if (m.role === "assistant") this._assistantMsg(m.content);
        else this._sys(m.content);
      }
    } catch (_) {}
  }

  // ── rendering ────────────────────────────────────────────────────────────────
  _scroll() {
    // Keep the "working" caret as the last item while a turn runs — every render
    // path funnels through here, so appending content never buries the marker.
    if (this._workingEl && this._workingEl.parentNode === this.logEl &&
        this.logEl.lastElementChild !== this._workingEl) {
      // Keep the "..." last only when new content landed after it (the JS timer
      // owns the dot text, so moving the node here doesn't disturb the animation).
      this.logEl.appendChild(this._workingEl);
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // Show/hide the animated "agent is working" dots. Driven by _setBusy so it
  // appears the instant the pipeline starts and clears on done / stop / error.
  // The "..." is animated in JS (a setInterval cycling . / .. / ...) rather than
  // CSS, because @keyframes didn't render inside this ComfyUI sidebar panel.
  _setWorking(on) {
    if (on) {
      if (!this._workingEl) {
        this._dotsEl = el("span", { className: "ay-dots", textContent: "." });
        this._workingEl = el("div", { className: "ay-working", title: "agentY is working…" },
          [this._dotsEl]);
      }
      this.logEl.appendChild(this._workingEl); // (re)pin to the end of the log
      if (!this._workingTimer) {
        let n = 1;
        this._dotsEl.textContent = ".";
        this._workingTimer = setInterval(() => {
          n = (n % 3) + 1; // 1 → 2 → 3 → 1 …
          this._dotsEl.textContent = ".".repeat(n);
        }, 350);
      }
      this._scroll();
    } else {
      if (this._workingTimer) { clearInterval(this._workingTimer); this._workingTimer = null; }
      if (this._workingEl && this._workingEl.parentNode) {
        this._workingEl.parentNode.removeChild(this._workingEl);
      }
    }
  }

  // Panel snapshot with the transient bits removed: the working caret (else it is
  // restored as a stray blinking cursor with no turn running) and host-state
  // notices like "host is back" (else every restart leaves a line in the saved
  // conversation forever). Taken off a clone so the live panel is never touched.
  _logHtml() {
    const clone = this.logEl.cloneNode(true);
    clone.querySelectorAll(".ay-working, .ay-transient").forEach((n) => n.remove());
    return clone.innerHTML;
  }
  _sys(text, opts) {
    const cls = "ay-msg ay-system" + (opts && opts.transient ? " ay-transient" : "");
    this.logEl.append(el("div", { className: cls, innerHTML: mdToHtml(text) }));
    this._scroll();
  }
  _userMsg(text) {
    this.logEl.append(el("div", { className: "ay-msg ay-user", innerHTML: mdToHtml(text) }));
    this._scroll();
  }
  _assistantMsg(text) {
    this.logEl.append(el("div", { className: "ay-msg ay-assistant", innerHTML: mdToHtml(text) }));
    this._scroll();
  }
  _ensureAssistant() {
    if (!this.curAssistant) {
      this.curAssistant = el("div", { className: "ay-msg ay-assistant" });
      this.curAssistant._raw = "";
      this.logEl.append(this.curAssistant);
    }
    return this.curAssistant;
  }
  _appendAssistant(text) {
    const m = this._ensureAssistant();
    m._raw += text;
    m.innerHTML = mdToHtml(m._raw);
    this._scroll();
  }
  _stepStart(name) {
    const details = el("details", { className: "ay-step", open: false });
    const body = el("div", { className: "ay-step-body" });
    details.append(el("summary", { textContent: name }), body);
    this.logEl.append(details);
    this.curStep = { details, body, name };
    this._scroll();
  }
  _stepText(text) {
    if (!this.curStep) this._stepStart("working");
    this.curStep.body.textContent += text;
    this._scroll();
  }
  _stepEnd() { this.curStep = null; }
  // Render an agent tool call / result as a collapsible block, inline in the
  // chat log (so it persists via _savePanel like every other block).
  _toolBlock(ev) {
    this.curAssistant = null; // close the current text bubble; keep ordering
    this._toolBlocks = this._toolBlocks || {};
    const id = ev.id || "";
    if (ev.phase === "call") {
      const details = el("details", { className: "ay-step ay-tool", open: false });
      const body = el("div", { className: "ay-step-body" });
      body.textContent = ev.input ? "input: " + ev.input : "(no input)";
      details.append(el("summary", { textContent: "🔧 " + (ev.name || "tool") }), body);
      this.logEl.append(details);
      if (id) this._toolBlocks[id] = { details, body };
    } else {
      const blk = id && this._toolBlocks[id];
      if (blk) {
        blk.body.textContent += "\n\n→ " + (ev.result || "(done)");
      } else {
        const details = el("details", { className: "ay-step ay-tool", open: false });
        details.append(
          el("summary", { textContent: "🔧 " + (ev.name || "tool") }),
          el("div", { className: "ay-step-body", textContent: "→ " + (ev.result || "(done)") }),
        );
        this.logEl.append(details);
      }
    }
    this._scroll();
  }
  // ComfyUI's own terminal, relayed while the queue runs. A log you scroll back
  // through, not a status line that replaces itself — so it goes in one
  // collapsible block per turn, closed by default, because a model load can run
  // to dozens of lines and must not bury the conversation to be available.
  _consoleLine(text) {
    if (!this._consoleEl || !this._consoleEl.details.isConnected) {
      this.curAssistant = null;   // close the text bubble first; keeps ordering
      const details = el("details", { className: "ay-step ay-console", open: false });
      const summary = el("summary", { textContent: "🖥 ComfyUI console" });
      const body = el("div", { className: "ay-step-body" });
      details.append(summary, body);
      this.logEl.append(details);
      this._consoleEl = { details, summary, body, n: 0 };
    }
    const blk = this._consoleEl;
    blk.body.textContent += (blk.n ? "\n" : "") + text;
    blk.n += 1;
    blk.summary.textContent = `🖥 ComfyUI console · ${blk.n} line${blk.n === 1 ? "" : "s"}`;
    if (blk.details.open) blk.body.scrollTop = blk.body.scrollHeight;
    this._scroll();
  }
  _status(text) {
    if (!this._statusEl || !this._statusEl.isConnected) {
      this._statusEl = el("div", { className: "ay-status" });
      this.logEl.append(this._statusEl);
    }
    this._statusEl.textContent = text;
    this._scroll();
  }
  _clearStatus() { this._statusEl = null; }

  // The visible graph rect ([x, y, w, h] in graph coordinates), or null when the
  // canvas hasn't laid out yet.
  _visibleArea() {
    try {
      const c = app.canvas;
      const va = (c && (c.visible_area || (c.ds && c.ds.visible_area))) || null;
      if (va && va.length >= 4 && va[2] > 40 && va[3] > 40) return [va[0], va[1], va[2], va[3]];
    } catch (_) {}
    return null;
  }

  // Fallback for a graph with nothing to measure: just inside the top-left of
  // what the user is looking at. A fixed graph coordinate would be "somewhere
  // else" for anyone who has panned away from the origin.
  _viewCorner() {
    const v = this._visibleArea();
    return v ? [v[0] + 80, v[1] + 80] : [80, 80];
  }

  // Where to drop a node the agent just made — a generated media loader, an
  // agentY text node, anything. One rule for all of them: put it next to the
  // nodes that are already on the graph, never out in empty space the user has to
  // go hunting for. When part of the graph is on screen we measure only what is
  // visible, so the drop lands beside the bit of the workflow being looked at
  // rather than at the far edge of a large graph.
  //   near    — a node the new one belongs beside (the hook whose answer it is),
  //             measured instead of the visible block when it's still on canvas.
  //   exclude — the node being placed. It is added to the graph before it is
  //             positioned, and counting it (sitting at LiteGraph's default spot,
  //             near the origin) would drag every drop back to the origin with it.
  // The graph this turn's output belongs to: the one it was started from.
  //
  // Falls back to whatever is active when there is no pinned graph (a node placed
  // outside a turn) or when the pinned one has gone (its tab was closed). Never
  // throws and never refuses to place — a node that lands in a slightly wrong
  // place is recoverable; one that vanishes because the placement bailed is not.
  _targetGraph() {
    const g = this._turnGraph;
    if (g && typeof g.add === "function" && Array.isArray(g._nodes)) return g;
    return app.graph;
  }

  // Say it once per turn, and only when it is actually true: nodes went somewhere
  // the user is not currently looking, which is otherwise indistinguishable from
  // nothing having happened.
  _noteOffscreenDrop() {
    const g = this._targetGraph();
    if (!g || g === app.graph || this._saidOffscreen) return;
    this._saidOffscreen = true;
    // Deliberately not "placed": this also covers edits and deletions, and a
    // delete you cannot see is the one most worth being told about.
    this._sys("📍 Applied to the workflow this run started from — switch back to "
      + "that tab to see it. (The agent opened another workflow on the canvas "
      + "meanwhile; this run's changes still belong to yours.)");
  }

  _dropPos(near = null, exclude = null) {
    const placed = (n) => n && n !== exclude && isXY(n.pos) && isXY(n.size);
    let nodes = [];
    // Measured on the graph the node is going to LAND on, not the active one —
    // otherwise a drop is laid out to miss the nodes of a workflow it will never
    // be part of, and lands on top of the ones it will.
    try {
      const g = this._targetGraph();
      nodes = ((g && g._nodes) || []).filter(placed);
    } catch (_) {}
    if (!nodes.length) return this._viewCorner();   // nothing to measure: land in view

    // Measure against the user's own nodes: our earlier drops are what this one is
    // supposed to line up with, not what it should stand clear of. (They are still
    // in `nodes`, so the slot search below keeps off them.)
    const theirs = nodes.filter((n) => !isAgentDrop(n));
    const pool = theirs.length ? theirs : nodes;

    let ref = null;
    if (placed(near)) ref = [near];
    if (!ref) {
      const v = this._visibleArea();
      if (v) {
        const seen = pool.filter(
          (n) => n.pos[0] < v[0] + v[2] && n.pos[0] + n.size[0] > v[0] &&
                 n.pos[1] < v[1] + v[3] && n.pos[1] + n.size[1] > v[1]);
        if (seen.length) ref = seen;
      }
    }
    if (!ref) ref = pool;   // looking at empty space — go where the graph is

    // Just past the right edge of that block, lined up with its top. Drops are
    // allowed to run down as far as the block is tall before starting a new
    // column, so the pile beside a workflow ends up about the shape of it.
    let maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of ref) {
      maxX = Math.max(maxX, n.pos[0] + n.size[0]);
      minY = Math.min(minY, n.pos[1]);
      maxY = Math.max(maxY, n.pos[1] + n.size[1]);
    }
    return this._freeSpot([maxX + DROP_GAP, minY], nodes, DROP_SIZE,
                          Math.max(maxY - minY, DROP_COL_H));
  }

  // Slide down from `pos` until the slot is clear of everything already on the
  // graph — landing on top of a node is as bad as landing a screen away. Once the
  // column has run `colH` deep, step across into a new one instead of carrying on
  // down, so a run with many outputs fills a block beside the workflow rather than
  // a stripe running off one edge of it. The step across clears the widest node met
  // on the way down, because a media loader grows well past DROP_SIZE once its
  // preview loads. Bounded: a slot a few nodes over beats a frozen panel.
  _freeSpot(pos, nodes, size = DROP_SIZE, colH = DROP_COL_H) {
    let [x, y] = pos;
    const top = y;
    let right = x + size[0];   // widest thing met in the column being filled
    for (let i = 0; i < 60; i++) {
      const hit = nodes.find(
        (n) => x < n.pos[0] + n.size[0] + DROP_GAP && x + size[0] + DROP_GAP > n.pos[0] &&
               y < n.pos[1] + n.size[1] + DROP_GAP && y + size[1] + DROP_GAP > n.pos[1]);
      if (!hit) break;
      right = Math.max(right, hit.pos[0] + hit.size[0]);
      y = hit.pos[1] + hit.size[1] + DROP_GAP;
      if (y > top + colH) { y = top; x = right + DROP_GAP; right = x + size[0]; }
    }
    return [x, y];
  }

  // ── graph node injection (the whole point) ───────────────────────────────────
  injectNode(ev) {
    const LG = window.LiteGraph;
    // First one this ComfyUI actually has. The server sends the list (see
    // _NODE_CANDIDATES in agentY_server.py) and puts the Video Helper Suite
    // "(Path)" loaders in front, because those read the file where it already is
    // instead of naming a copy in the input directory.
    const cands = ev.node_candidates
      || (ev.kind === "video" ? ["VHS_LoadVideoPath", "VHS_LoadVideo", "LoadVideo"]
                              : ["VHS_LoadImagePath", "LoadImage"]);
    const type = cands.find((t) => LG && LG.registered_node_types && LG.registered_node_types[t]);
    if (!type) {
      this._sys(`⚠️ ${ev.kind} saved at \`${ev.path}\` — no loader node available in this ComfyUI. Load it manually.`);
      return;
    }
    let node;
    try {
      node = LG.createNode(type);
      this._targetGraph().add(node);
      this._noteOffscreenDrop();
    } catch (e) {
      this._sys(`⚠️ Could not add ${type} node: ${e}`);
      return;
    }
    // Drop it beside the user's nodes rather than at the far graph origin, and
    // clear of them — a run's worth of drops stacks into a block next to the
    // workflow instead of each one starting where the last ended.
    markAgentDrop(node);
    node.pos = this._dropPos(null, node);
    const wnames = ev.kind === "image" ? ["image"] : ["video", "file", "path"];
    const w = (node.widgets || []).find((x) => wnames.includes(x.name));
    if (w) {
      // Two shapes of loader, two different things to write into them. A combo
      // widget is a list of what sits in ComfyUI's input directory, so it takes
      // the staged filename; a free-text widget — VHS's "(Path)" loaders — takes
      // the absolute path and reads the original where it was written. Handing
      // either one the other's value leaves a node pointing at nothing, and the
      // node looks perfectly normal until it runs.
      const isCombo = !!(w.options && Array.isArray(w.options.values));
      const val = (isCombo ? ev.filename : ev.path) || ev.filename || ev.path;
      if (isCombo && ev.filename && !w.options.values.includes(ev.filename)) {
        w.options.values.push(ev.filename);
      }
      w.value = val;
      try { if (w.callback) w.callback(val); } catch (_) {}
    }
    // What the file is FOR beats what it is called: the next run reads the title.
    const role = String(ev.role || "").trim();
    node.title = "agentY · " + (role || ev.name || type);
    if (role && ev.role_declared) this._attachRefNote(node, role);
    this._targetGraph().setDirtyCanvas(true, true);
    this._sys(`🧩 Added **${type}** node → \`${ev.name}\`` + (role ? ` — _${role}_` : ""));
  }

  // The user named this output themselves, in the hook's own prompt. Put their
  // words on the canvas as an `agentY add tag` hanging off the new node, so
  // whatever they wire it into next is told what to take from it. Only ever on a
  // stated role — adding a node per output to someone's graph uninvited is not a
  // courtesy, it's clutter. The tag field is left EMPTY: a name is what the `#`
  // menu offers everywhere, and one invented from a sentence is a name nobody
  // chose and nobody would type.
  _attachRefNote(src, role) {
    const LG = window.LiteGraph;
    if (!LG || !LG.registered_node_types || !LG.registered_node_types["AgentYRefNote"]) return;
    try {
      const note = LG.createNode("AgentYRefNote");
      this._targetGraph().add(note);
      this._noteOffscreenDrop();
      markAgentDrop(note);
      const w = (note.widgets || []).find((x) => x && x.name === "role");
      if (w) {
        w.value = role;
        try { if (w.callback) w.callback(role); } catch (_) {}
      }
      note.title = "agentY tag · " + role.slice(0, 40);
      note.pos = [src.pos[0] + (src.size ? src.size[0] : 210) + DROP_GAP, src.pos[1]];
      src.connect(0, note, 0);
    } catch (e) {
      // A decoration must never cost the user the node it was decorating.
    }
  }

  // ── SSE event dispatch ───────────────────────────────────────────────────────
  // A stream belongs to the conversation it was started in, but the panel only
  // ever has one DOM. Switching conversations mid-turn used to swap that DOM out
  // from under the live node references, so the rest of the answer was appended
  // to detached nodes and vanished — the turn finished fine server-side while the
  // panel kept showing the snapshot taken at the moment of the switch, with no
  // Stop button (streaming had cleared). While detached we therefore render
  // nothing and let the backend's own message log be the record.
  _isRendering() {
    return !this.streamThreadId || this.streamThreadId === this.threadId;
  }

  // Events that must be handled no matter which conversation is on screen: run
  // bookkeeping, and anything whose effect lands on the ComfyUI canvas rather
  // than in this panel — a generated node still belongs on the graph even if the
  // user has looked away. Everything else only paints the chat log, so it is
  // dropped while its conversation is off-screen.
  static ALWAYS_HANDLE = ["thread", "request", "done", "output", "canvas_patch", "notify"];

  _onEvent(ev) {
    const rendering = this._isRendering();
    if (!rendering && !AgentChat.ALWAYS_HANDLE.includes(ev.type)) {
      if (ev.type === "ask") this.activeAsk = ev.request_id;  // still needs answering
      return;
    }
    switch (ev.type) {
      case "thread":
        if (ev.id && ev.id !== this.threadId) { this.threadId = ev.id; this._loadThreads(); }
        if (ev.id) this._saveActive(ev.id);
        if (ev.id && !this.streamThreadId) this.streamThreadId = ev.id;  // server-assigned
        break;
      case "request":
        this.curRequestId = ev.request_id;
        break;
      case "text":
        this._appendAssistant(ev.data);
        break;
      case "think":
        // fold reasoning into a collapsible thinking step, inline in the chat
        this.curAssistant = null;
        if (!this._thinkStep || !this._thinkStep.details.isConnected) {
          this._stepStart("💭 thinking");
          this._thinkStep = this.curStep;
          this.curStep = null;
        }
        this._thinkStep.body.textContent += ev.data;
        this._scroll();
        break;
      case "tool":
        // render the agent's tool call / result as an inline collapsible block
        this._toolBlock(ev);
        break;
      case "step_start":
        this.curAssistant = null;
        this._stepStart(ev.name || "step");
        break;
      case "step_text":
        this._stepText(ev.data);
        break;
      case "step_end":
        this._thinkStep = null;
        this._stepEnd();
        break;
      case "progress":
      case "qa":
        this._status(ev.data);
        break;
      case "console":
        this._consoleLine(ev.data);
        break;
      case "exec":
        if (ev.state === "start") this._status("⚙️ ComfyUI running…");
        else this._clearStatus();
        break;
      case "plan":
        this._sys("🗂️ **Plan:**\n" + (ev.steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n"));
        break;
      case "plan_step":
        break; // (kept lightweight)
      case "output":
        this.curAssistant = null;
        this.injectNode(ev);
        break;
      case "interject_undelivered":
        // Sent mid-run, but the agent had already made its last tool call. It is
        // back in the queue and goes out with the next turn; it's already in the
        // log, so the dispatch won't echo it again.
        for (const t of ev.texts || []) {
          this._queue.push({ text: t, attachments: [], echoed: true });
        }
        this._renderQueue();
        this._sys("_The agent had already finished its last step, so that message "
          + "goes out with the next turn._");
        break;
      case "canvas_patch":
        this.curAssistant = null;
        // Only the ops that actually put something on a graph say where it went;
        // a review being released places nothing and must not claim otherwise.
        if (ev.op !== "review_released") this._noteOffscreenDrop();
        if (ev.op === "place_text") this._placeCanvasText(ev);
        else if (ev.op === "review_collector") this._reviewCollector(ev);
        else if (ev.op === "review_released") this._reviewReleased(ev);
        else if (ev.op === "delete_nodes") this._deleteNodes(ev);
        else this._applyCanvasPatch(ev);
        break;
      case "system":
        this.curAssistant = null;
        this._sys(ev.data);
        break;
      case "status_line":
        // A CLI-side notice (memory init, model pull, …) surfaced live during a
        // turn. Render it and advance the seq so the on-done drain won't repeat it.
        this.curAssistant = null;
        this._sys(ev.data);
        this._noteStatusSeq(ev.seq);
        break;
      case "notify":
        // A structured background notification (e.g. a Magnific creation that
        // finished mid-turn). Drop it onto the canvas + pop a toast; advancing the
        // seq means the idle poll won't re-handle it.
        this._handleNotify(ev);
        break;
      case "ask":
        this.curAssistant = null;
        this.activeAsk = ev.request_id;
        this._setBusy(true); // awaiting a reply → button reverts to Send
        this.logEl.append(el("div", { className: "ay-msg ay-ask", innerHTML: mdToHtml("⏸️ " + ev.prompt) }));
        this._scroll();
        this.input.focus();
        break;
      case "error":
        this.curAssistant = null;
        this._sys("❌ " + ev.message);
        break;
      case "done":
        // Unpin: outside a turn, "the graph in front of you" is the right answer
        // again, and holding a reference to a closed workflow keeps it alive.
        this._turnGraph = null;
        this._clearStatus();
        this.curStep = null;
        this.curAssistant = null;
        this._thinkStep = null;
        this._toolBlocks = {};
        this._consoleEl = null;
        this.streaming = false;
        this._adoptedRun = false;
        this._setBusy(false);
        if (rendering) {
          this._savePanel();  // persist the rendered panel so blocks survive reloads
        } else {
          // The turn finished while its conversation was off-screen, so the only
          // rendered panel we have for it is the mid-turn snapshot. Drop that
          // (here and on the backend) so reopening rebuilds from the persisted
          // messages — the complete answer, minus the collapsible blocks — rather
          // than restoring a frozen "thinking…" that looks like a hang.
          this._forgetStalePanel(this.streamThreadId);
        }
        this.streamThreadId = null;
        this._loadThreads();
        this._drainStatus();       // catch any between-/in-turn CLI notices not delivered live
        this._startNotifyPoll();   // (re-)arm the auto-drop poll: this turn may have queued
                                   // an async generation whose completion lands minutes later
        this._maybeDispatchQueued(); // send the next message queued while this turn ran
        break;
    }
    // Persist the in-progress panel periodically (throttled) so a reload or a host
    // restart mid-turn restores what was shown, rather than the pre-turn snapshot.
    if (ev.type !== "done") this._savePanelThrottled();
  }

  _savePanelThrottled() {
    // Only ever persist the panel of the conversation actually on screen — while
    // a stream runs off-screen this would otherwise keep writing the *displayed*
    // thread's DOM, and never the running one's.
    if (this._saveTimer || !this.threadId || !this._isRendering()) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._savePanel(); }, 1500);
  }

  // Ask the host which conversations have a turn in flight. Used when opening a
  // conversation (and on connect) so a panel that lost its stream — page reload,
  // or a turn left running in another conversation — can say so and offer Stop,
  // instead of showing a spinner that will never clear or hiding a live run.
  async _syncRunState() {
    if (!this._hostUp) return;
    let runs = [];
    try {
      const r = await fetch(backendBase() + "/agentY/runs", { cache: "no-store" });
      if (!r.ok) return;                       // older host: leave state alone
      runs = (await r.json()).runs || [];
    } catch (_) { return; }
    // An adopted run belongs to the conversation it was adopted for, which is not
    // necessarily the one on screen now — reconcile it against that one, so
    // switching conversations can't strand it as un-clearable.
    const watched = (this._adoptedRun && this.streamThreadId) || this.threadId;
    const mine = runs.find((x) => x.thread_id === watched);
    if (mine && !this.streaming) {
      // Running, but not by us — we cannot re-attach to an SSE stream we never
      // opened, so present it honestly and keep Stop reachable. Flagged as
      // adopted: the heartbeat is now the only thing that can notice it ending.
      this.curRequestId = mine.request_id;
      this.streamThreadId = this.threadId;
      this.streaming = true;
      this._adoptedRun = true;
      this.activeAsk = mine.awaiting_reply ? mine.request_id : null;
      this._setBusy(true);
      this._sys(mine.awaiting_reply
        ? "⏳ This conversation has a turn waiting on your reply."
        : "⏳ A turn is still running here. Its live output is not being streamed "
          + "to this panel — it will appear when the turn finishes, or press Stop.");
    } else if (!mine && this.streaming &&
               (this._adoptedRun || this.streamThreadId === this.threadId)) {
      // We think a turn is running but the host disagrees: it ended and we missed
      // the "done". Clear the frozen busy state.
      const wasAdopted = this._adoptedRun;
      const finished = this.streamThreadId;
      this.streaming = false;
      this._adoptedRun = false;
      this.streamThreadId = null;
      this.activeAsk = null;
      this._setBusy(false);
      this._clearStatus();
      // Nothing streamed an adopted turn, so its answer never reached the log.
      // The last panel snapshot for it is mid-turn (a frozen "thinking…"), so
      // drop that first and rebuild from the persisted messages — the complete
      // answer, minus the collapsible blocks. This is what the adopt branch
      // above promises with "it will appear when the turn finishes".
      if (wasAdopted && finished && finished === this.threadId) {
        await this._forgetStalePanel(finished);
        await this._renderThread(finished, true);
      }
      if (wasAdopted) {
        this._loadThreads();         // the turn may have retitled the conversation
        this._maybeDispatchQueued(); // anything typed while it ran, as on a normal "done"
      }
    }
  }

  // Discard a rendered panel that no longer reflects the conversation, in the
  // session cache and on the backend, so the next open falls back to the message
  // log instead of a stale snapshot.
  // Returns the backend write so a caller that re-renders straight afterwards can
  // await it — otherwise the re-read races the clear and restores what it dropped.
  _forgetStalePanel(threadId) {
    if (!threadId) return Promise.resolve();
    this.domCache.delete(threadId);
    return fetch(backendBase() + "/agentY/threads/" + threadId + "/panel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: "" }),
    }).catch(() => {});
  }

  async _stream(body) {
    // This invocation's claim on the shared streaming state. A "done" event can
    // dispatch a queued message (_maybeDispatchQueued), which starts the NEXT
    // stream from inside this one's read loop; when this one then reaches EOF its
    // `finally` would clear state — and null the abortController — now belonging
    // to the turn that replaced it, leaving a live turn that looks idle and can't
    // be stopped. Only the stream still holding the token may clear it.
    const token = ++this._streamToken;
    this.streaming = true;
    this._adoptedRun = false;  // this one we own: the reader's EOF will end it
    this._stopping = false;
    this._thinkStep = null;
    this._toolBlocks = {};
    this._consoleEl = null;
    // The conversation this stream belongs to. On the very first turn the id is
    // assigned by the server and arrives in the "thread" event.
    this.streamThreadId = body.thread_id || this.threadId || null;
    this.abortController = new AbortController();
    this._setBusy(true);
    try {
      const resp = await fetch(backendBase() + "/agentY/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });
      if (!resp.ok || !resp.body) throw new Error("HTTP " + resp.status);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (line) {
            try { this._onEvent(JSON.parse(line.slice(line.indexOf(":") + 1).trim())); }
            catch (e) { console.error("[agentY] bad SSE frame", e); }
          }
        }
      }
    } catch (e) {
      // A user-initiated Stop aborts the fetch → don't show it as an error.
      if (!this._stopping && e.name !== "AbortError") {
        this._sys("❌ Connection error: " + e + `\n\nIs the agentY chat host running? (\`run_agent.ps1\`, ${backendBase()})`);
        this._startReconnect(false); // auto-recover the panel when the host is back
      }
    } finally {
      if (this._streamToken === token) {
        this.streaming = false;
        this.abortController = null;
        this._setBusy(false);
      }
    }
  }

  // Button doubles as Send / Stop depending on state.
  _onSendBtn() {
    if (this.streaming && !this.activeAsk) this._stop();
    else this.send();
  }

  async _stop() {
    // Deliberately no `if (!this.streaming) return`. Stop is also the escape
    // hatch for a panel that only *looks* busy — a turn whose stream we lost —
    // and bailing out early there left no way to get the input back.
    this._stopping = true;
    this._status("⏹ Stopping…");
    // Ask the backend to cancel the run (halts the agent loop + interrupts
    // ComfyUI). Target the stream's own conversation, which is not necessarily
    // the one on screen.
    try {
      await fetch(backendBase() + "/agentY/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: this.curRequestId,
          thread_id: this.streamThreadId || this.threadId,
        }),
      });
    } catch (_) {}
    // Stop consuming the SSE stream client-side.
    try { if (this.abortController) this.abortController.abort(); } catch (_) {}
    this._clearStatus();
    this._sys("⏹ Stopped.");
    this.curAssistant = null;
    this.curStep = null;
    this.streaming = false;
    this._adoptedRun = false;
    this.streamThreadId = null;
    this.activeAsk = null;   // a pending question dies with the run
    this._setBusy(false);
    this._savePanel();
  }

  _setBusy(b) {
    // While a turn is running (and not waiting on a reply) the button becomes a
    // Stop button; otherwise it's the Send/reply button. Always clickable.
    const stopMode = b && !this.activeAsk;
    this._setWorking(stopMode); // blinking caret while the agent is actively working
    this.sendBtn.disabled = false;
    setButtonIcon(this.sendBtn, stopMode ? "stop" : "send", stopMode ? "⏹ Stop" : "Send");
    this.sendBtn.classList.toggle("ay-stop", stopMode);
    // Cue the user that typing now queues (rather than doing nothing) — the input
    // stays live so a message can be lined up mid-turn and auto-sent on completion.
    if (this.input) {
      this.input.placeholder = stopMode
        ? "Type to queue — sends when this turn finishes…"
        : "Message agentY…  (type / for commands)";
    }
    // Don't allow a model switch mid-turn.
    if (this.modelSel) this.modelSel.disabled = b;
    if (this.targetSel) this.targetSel.disabled = b;
  }

  // ── sending ──────────────────────────────────────────────────────────────────
  async send() {
    const text = this.input.value.trim();
    // One-shot: set by the "Dry run" entry on the hooks button, consumed here so
    // the next message is an ordinary run again. Read before every early return —
    // a /help or an ask-reply must not leave it armed for something unrelated.
    const dryRun = !!this._dryRunOnce;
    this._dryRunOnce = false;

    // First send is a user gesture — a good moment to ask (once) for browser-
    // notification permission so background auto-drops (e.g. Magnific finishing
    // minutes later) can raise an OS pop-up even when this tab isn't focused.
    this._ensureNotifyPermission();

    // /help (or /docs) — open the usage guide in a new browser tab. Handled
    // entirely client-side; calling window.open here (inside the send() gesture
    // stack) sidesteps the popup blocker, and the command never reaches the agent.
    if (/^\/(help|docs)\s*$/i.test(text)) {
      this._openDocs();
      this.input.value = "";
      this._autosize();
      this._hidePop();
      return;
    }

    // /project_memory — open the editor for what is true of THIS project. Also
    // client-side and for the same reason: window.open only survives the popup
    // blocker inside the gesture that asked for it, and there is nothing here for
    // the agent to do. The user message is echoed so the transcript still shows
    // what was asked for.
    if (/^\/project[_ ]?memory\s*$/i.test(text)) {
      this._userMsg(text.trim());
      if (window.agentYOpenProjectMemory) window.agentYOpenProjectMemory();
      this._sys("📌 Opened the project-memory editor in a new tab.");
      this.input.value = "";
      this._autosize();
      this._hidePop();
      return;
    }

    // Pin this turn to the graph it was started FROM, before anything can move
    // it. The agent opens its own workflows on the canvas (autograph, a filed dry
    // run, a bake), and ComfyUI makes each opened workflow the ACTIVE one — so
    // `app.graph` half way through a turn is no longer the graph the user was
    // working on. Every node the turn produces belongs to the graph that asked
    // for it, not to whatever happens to be in front at the moment it lands.
    this._turnGraph = app.graph || null;
    this._saidOffscreen = false;
    const canvasInputs = this._collectCanvasInputs();
    const canvasHooks = this._collectCanvasHooks();
    const canvasSelection = this._collectCanvasSelection();
    if (!text && this.attachments.length === 0 && canvasInputs.length === 0 &&
        canvasHooks.length === 0) return;

    // Answering an interactive ask → side-channel reply; the SSE stream continues.
    if (this.activeAsk) {
      const rid = this.activeAsk;
      this.activeAsk = null;
      this._setBusy(this.streaming); // reply sent → back to Stop while it continues
      this._userMsg(text || "(continue)");
      this.input.value = "";
      this._autosize();
      try {
        await fetch(backendBase() + "/agentY/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ request_id: rid, text }),
        });
      } catch (e) { this._sys("❌ Reply failed: " + e); }
      return;
    }

    // A turn is already running (and we're not answering an ask): queue this
    // message instead of dropping it — it auto-sends when the turn finishes.
    if (this.streaming) {
      if (text || this.attachments.length) this._queueMessage(text, { dryRun });
      return;
    }
    const imgs = this.attachments.map((a) => a.path);
    const noteParts = [];
    if (this.attachments.length) noteParts.push(`${this.attachments.length} image(s) attached`);
    if (canvasInputs.length) {
      const ni = canvasInputs.filter((c) => c.kind === "image").length;
      const nv = canvasInputs.length - ni;
      const bits = [];
      if (ni) bits.push(`${ni} image`);
      if (nv) bits.push(`${nv} video`);
      noteParts.push(`${bits.join(" + ")} from canvas`);
    }
    if (canvasHooks.length) noteParts.push(`${canvasHooks.length} canvas hook(s)`);
    if (dryRun) noteParts.push("dry run — builds everything, generates nothing");
    const selNote = this._describeSelection(canvasSelection);
    // Already in the log if this came back from a mid-run send that arrived too
    // late; echoing it again would show the same message twice.
    if (this._skipEcho) this._skipEcho = false;
    else this._userMsg(text
      + (noteParts.length ? `  \n_(${noteParts.join(", ")})_` : "")
      + (selNote ? `  \n${selNote}` : ""));
    this.input.value = "";
    this._autosize();
    this.attachments = [];
    this._renderAttachments();
    this._hidePop();
    // Mark these canvas files as consumed so an unchanged, still-selected node
    // isn't re-sent on the next message.
    for (const ci of canvasInputs) if (ci._nodeId != null) this._consumed[ci._nodeId] = ci.value;
    // Always capture the on-canvas graph as an API prompt so the agent can act
    // on it — hooks drive the "run my canvas graph" path, and "add the workflow
    // open in the canvas" (chat or /add_workflow canvas <name>) needs it too.
    // graphToPrompt() is what ComfyUI runs on every Queue, so the cost is negligible.
    const canvasPrompt = await this._captureCanvasGraph();
    await this._stream({
      thread_id: this.threadId,
      message: text,
      image_paths: imgs,
      canvas_inputs: canvasInputs.map((c) => ({ value: c.value, kind: c.kind })),
      canvas_hooks: canvasHooks,
      canvas_selection: canvasSelection,
      canvas_prompt: canvasPrompt,
      dry_run: dryRun,
    });
  }

  // Open the usage guide in a new browser tab (backs the /help command).
  _openDocs() {
    this._userMsg("/help");
    let win = null;
    try { win = window.open(DOCS_URL, "_blank", "noopener"); } catch (_) {}
    if (win) {
      this._sys(`📖 Opened the [agentY usage guide](${DOCS_URL}) in a new tab.`);
    } else {
      // Popup blocked / unavailable — surface a clickable link instead.
      this._sys(`📖 agentY usage guide: [${DOCS_URL}](${DOCS_URL})`);
    }
  }

  // ── attachments ──────────────────────────────────────────────────────────────
  async _onFiles() {
    for (const f of this.fileInput.files) {
      const fd = new FormData();
      fd.append("file", f);
      try {
        const r = await fetch(backendBase() + "/agentY/upload", { method: "POST", body: fd });
        if (r.ok) { const j = await r.json(); this.attachments.push({ path: j.path, name: j.name }); }
      } catch (e) { this._sys("❌ Upload failed: " + e); }
    }
    this.fileInput.value = "";
    this._renderAttachments();
  }
  _renderAttachments() {
    this.attachEl.innerHTML = "";
    this.attachments.forEach((a, i) => {
      const chip = el("span", { className: "ay-chip", textContent: "📎 " + a.name + "  ✕" });
      chip.style.cursor = "pointer";
      chip.title = "remove";
      chip.addEventListener("click", () => { this.attachments.splice(i, 1); this._renderAttachments(); });
      this.attachEl.append(chip);
    });
  }

  // ── canvas selection → inputs ─────────────────────────────────────────────────
  // Selecting Load Image / Load Video node(s) on the ComfyUI graph feeds their
  // file(s) to the agent as inputs — same as attaching them — in selection order.
  _ensureSelectionTracking() {
    const canvas = app.canvas;
    if (!canvas || canvas.__agentYSelHook) return;
    canvas.__agentYSelHook = true;
    const prev = canvas.onSelectionChange;
    canvas.onSelectionChange = (sel) => {
      try { if (prev) prev.call(canvas, sel); } catch (_) {}
      try {
        const ids = sel ? Object.keys(sel).map(Number) : [];
        const idset = new Set(ids);
        const prevSet = new Set(this._selOrder);
        // Drop deselected, then append newly-selected in the order they appear.
        // For click-by-click selection each change adds exactly one node, so the
        // resulting order is the true selection order.
        this._selOrder = this._selOrder.filter((id) => idset.has(id));
        for (const id of ids) {
          if (!this._selOrder.includes(id)) this._selOrder.push(id);
          if (!prevSet.has(id)) delete this._consumed[id]; // re-selecting re-arms a node
        }
      } catch (_) {}
    };
  }

  _orderedSelectedNodes() {
    this._ensureSelectionTracking();
    const canvas = app.canvas, graph = app.graph;
    if (!canvas || !graph) return [];
    const selIds = new Set();
    if (canvas.selected_nodes) for (const k of Object.keys(canvas.selected_nodes)) selIds.add(Number(k));
    if (canvas.selectedItems && canvas.selectedItems.forEach)
      canvas.selectedItems.forEach((it) => { if (it && it.id != null && it.widgets !== undefined) selIds.add(Number(it.id)); });
    if (selIds.size === 0 && graph._nodes) for (const n of graph._nodes) if (n && n.is_selected) selIds.add(Number(n.id));
    const ordered = [], seen = new Set();
    const getNode = (id) => (graph.getNodeById ? graph.getNodeById(id) : (graph._nodes || []).find((n) => Number(n.id) === id));
    for (const id of (this._selOrder || [])) if (selIds.has(id) && !seen.has(id)) { seen.add(id); const n = getNode(id); if (n) ordered.push(n); }
    for (const id of selIds) if (!seen.has(id)) { seen.add(id); const n = getNode(id); if (n) ordered.push(n); }
    return ordered;
  }

  _loaderInfo(node) {
    const t = String((node && (node.type || node.comfyClass)) || "");
    if (!/load/i.test(t)) return null;
    const widgets = node.widgets || [];
    const get = (names) => {
      for (const nm of names) {
        const w = widgets.find((x) => x && x.name === nm && x.value != null && String(x.value).trim() !== "");
        if (w) return String(w.value);
      }
      return null;
    };
    if (/video/i.test(t)) {
      const v = get(["video", "file", "path", "filename"]);
      if (v) return { value: v, kind: "video", name: node.title || t };
    }
    const iv = get(["image", "file", "filename"]);
    if (iv) return { value: iv, kind: "image", name: node.title || t };
    const vv = get(["video", "path"]);
    if (vv) return { value: vv, kind: "video", name: node.title || t };
    return null;
  }

  _collectCanvasInputs() {
    const out = [];
    for (const n of this._orderedSelectedNodes()) {
      const info = this._loaderInfo(n);
      if (!info) continue;
      // Skip a still-selected node whose file was already sent unchanged, so a
      // follow-up message doesn't silently re-attach it (attach-once semantics).
      if (this._consumed[n.id] === info.value) continue;
      info._nodeId = n.id;
      out.push(info);
    }
    return out;
  }

  // What to call a node in a summary: the title the user sees on the canvas,
  // falling back to its type. Works on both a live litegraph node and the
  // snapshot objects _collectCanvasSelection produces.
  _nodeLabel(n, cap) {
    const type = String((n && (n.type || n.comfyClass)) || "");
    let name = String((n && n.title) || "").trim() || type || "node";
    if (name.length > cap) name = name.slice(0, cap - 1) + "…";
    return { name, type };
  }

  // Summarise everything selected on the canvas, for the note under the message
  // just sent. The counts next to it describe something much narrower — the
  // loader nodes whose file is being attached as an input — so every other
  // selected node (the prompt you are about to ask about, the sampler you just
  // tweaked) was invisible here, and a selection of five could read "1 image".
  _describeSelection(sel) {
    if (!sel || !sel.length) return "";
    const MAX = 10;
    const labels = sel.slice(0, MAX).map((n) => {
      // Backticks are a code chip; everything else in the label stays literal,
      // since mdToHtml only parses code, bold and links.
      const { name } = this._nodeLabel(n, 34);
      return "`#" + n.id + " " + name.replace(/`/g, "") + "`";
    });
    const rest = sel.length - labels.length;
    if (rest > 0) labels.push(`+${rest} more`);
    return `🔲 ${sel.length} node${sel.length === 1 ? "" : "s"} selected: ${labels.join(", ")}`;
  }

  // A live read-out of the canvas selection above the composer: what the agent
  // will be told about when you press send, visible before you send anything.
  //
  // Polled rather than driven off onSelectionChange alone. That callback is the
  // right signal when it fires, but it does not fire on every path a selection
  // can change — clearing it by clicking empty canvas, undo, a node deleted out
  // from under it — and a selection bar showing nodes you no longer have
  // selected is worse than no bar at all. Two reads a second of already-in-memory
  // canvas state is not a cost worth optimising against that.
  _startSelectionIndicator() {
    try { this._ensureSelectionTracking(); } catch (_) {}
    const tick = () => {
      if (!this.selBarEl || !this.selBarEl.isConnected) return;
      let nodes = [];
      try { nodes = this._orderedSelectedNodes(); } catch (_) { nodes = []; }
      const sig = this._selectionSignature(nodes);
      if (sig === this._selSig) return;
      this._selSig = sig;
      this._renderSelectionBar(nodes);
    };
    try { tick(); } catch (_) {}
    // The canvas may not exist yet when the panel is built; polling means that
    // resolves itself on the next tick instead of needing a ready signal.
    this._selTimer = setInterval(tick, 500);
  }

  // Redraw only when the selection actually changed. Title and type both count:
  // renaming a selected node should refresh the bar, not just selecting another.
  _selectionSignature(nodes) {
    return (nodes || []).map((n) => `${n.id}:${n.title || n.type || ""}`).join("|");
  }

  _renderSelectionBar(nodes) {
    const bar = this.selBarEl;
    if (!bar) return;
    bar.innerHTML = "";
    if (!nodes.length) { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    const MAX = 12;
    bar.append(el("span", { className: "ay-selcount", textContent: `🔲 ${nodes.length} selected` }));
    for (const n of nodes.slice(0, MAX)) {
      const { name, type } = this._nodeLabel(n, 26);
      const chip = el("span", { className: "ay-chip ay-selchip", textContent: `#${n.id} ${name}` });
      chip.title = `#${n.id} · ${type || "?"}`;   // full type on hover
      bar.append(chip);
    }
    if (nodes.length > MAX)
      bar.append(el("span", { className: "ay-selmore", textContent: `+${nodes.length - MAX} more` }));
  }

  // Snapshot every selected node (ANY type) with its widget parameter values, so
  // the agent can read and — via set_canvas_node_params → the canvas_patch SSE
  // event — write back arbitrary parameters (e.g. read/alter a prompt node).
  _collectCanvasSelection() {
    const out = [];
    for (const n of this._orderedSelectedNodes()) {
      // Include EVERY selected node — even ones with no readable/editable widgets
      // (a Reroute, Note, …) — so the agent's summary covers all of them.
      out.push({
        id: String(n.id),
        type: String((n && (n.type || n.comfyClass)) || ""),
        title: String((n && n.title) || ""),
        widgets: this._widgetSnapshot(n),
      });
    }
    return out;
  }

  // Apply an agent-initiated node edit to the live graph (no refresh, no re-queue).
  _applyCanvasPatch(ev) {
    const graph = this._targetGraph();
    const nid = Number(ev.node_id);
    const node = graph && (graph.getNodeById
      ? graph.getNodeById(nid)
      : (graph._nodes || []).find((n) => Number(n.id) === nid));
    if (!node) {
      this._sys(`⚠️ Could not apply edit — node #${ev.node_id} is no longer on the canvas.`);
      return;
    }
    const params = ev.params || {};
    const applied = [];
    for (const [name, value] of Object.entries(params)) {
      const w = (node.widgets || []).find((x) => x && x.name === name);
      if (!w) continue; // unknown widget on this node — skip
      // Keep combo widgets valid: register a new option value if needed.
      if (w.options && Array.isArray(w.options.values) &&
          typeof value !== "object" && !w.options.values.includes(value)) {
        w.options.values.push(value);
      }
      w.value = value;
      try { if (w.callback) w.callback(value, app.canvas, node); } catch (_) {}
      applied.push(name);
    }
    this._targetGraph().setDirtyCanvas(true, true);
    const title = (node.title || node.type || ("#" + ev.node_id));
    if (applied.length) {
      this._sys(`✏️ Updated **${title}** — set ${applied.map((a) => "`" + a + "`").join(", ")}.`);
    } else {
      this._sys(`⚠️ No matching widget on **${title}** to update.`);
    }
  }

  // A `review` hook stopped the chain. Put what the stage produced into an
  // "agentY image collector" beside that hook and wire it into the hook's anchor,
  // so the node the user edits IS the input the next stage will read.
  //
  // Re-used, not re-created, when a halt happens again at the same hook: the node
  // is found by the `agentY_review_key` property rather than by position or title,
  // so the user is free to move it, rename it, or wire it somewhere else as well.
  // Creating a second one each time would leave the canvas with a pile of stale
  // ballots and no way to tell which one is being read.
  _reviewCollector(ev) {
    const LG = window.LiteGraph;
    const graph = this._targetGraph();
    const files = (ev.files || []).map(String).filter(Boolean);
    if (!graph || !LG) return;
    const key = String(ev.collector_key || "");
    const TYPE = "AgentYImageCollector";
    if (!LG.registered_node_types || !LG.registered_node_types[TYPE]) {
      this._sys("⚠️ The **agentY image collector** node isn't registered, so there is "
        + "nowhere to put the outputs for review. Update the agentY extension.");
      return;
    }
    const hookId = String(ev.hook_node_id || "");
    const hook = (graph._nodes || []).find((n) => n && String(n.id) === hookId) || null;

    let node = (graph._nodes || []).find(
      (n) => n && n.properties && n.properties.agentY_review_key === key);
    const fresh = !node;
    if (!node) {
      node = LG.createNode(TYPE);
      if (!node) return;
      node.properties = node.properties || {};
      node.properties.agentY_review_key = key;
      graph.add(node);
      markAgentDrop(node);
      node.pos = this._dropPos(hook, node);
      node.title = "review — pick what continues";
    }
    const w = (node.widgets || []).find((x) => x && x.name === "files");
    if (w) {
      w.value = files.join("\n");
      try { if (w.callback) w.callback(w.value, app.canvas, node); } catch (_) {}
    }
    // Wire it into the review hook's anchor, so the choice is visibly the thing
    // that feeds the rest of the chain. Only on creation: if the user has since
    // rewired it deliberately, that is their graph and not ours to correct.
    const wired = fresh && hook ? wireIntoAnchor(node, hook) : false;
    graph.setDirtyCanvas(true, true);
    window.agentYReviewHalted = true;
    try {
      window.dispatchEvent(new CustomEvent("agentY:review", { detail: { halted: true } }));
    } catch (_) {}
    this._sys(
      `⏸️ **Stopped for review** — ${files.length} output(s) are in the `
      + `**${node.title}** collector`
      + (wired
        ? `, wired into hook #${hookId}`
        : ` (it could **not** be wired into hook #${hookId} — connect its output to a `
          + "free `anchor` on that hook yourself, or the next stage will not read it)")
      + ". Remove the rows you don't want, add your own files or reorder them, then "
      + "say **continue** — or **stop** to end the run here."
    );
  }

  // Remove nodes the agent was asked to delete.
  //
  // Wrapped in beforeChange/afterChange, which is what ComfyUI's changeTracker
  // listens to for Ctrl+Z. The extension has never called these for any of its
  // canvas edits, so none of them were undoable; it matters most here, because
  // this is the only one that destroys something. (The others are worth wrapping
  // too — a separate job, and not one to do in the same change as deletion.)
  _deleteNodes(ev) {
    const graph = this._targetGraph();
    if (!graph) return;
    const ids = (ev.node_ids || []).map(String);
    const gone = [];
    const changed = typeof graph.beforeChange === "function"
      && typeof graph.afterChange === "function";
    if (changed) { try { graph.beforeChange(); } catch (_) {} }
    try {
      for (const id of ids) {
        const node = graph.getNodeById
          ? graph.getNodeById(Number(id))
          : (graph._nodes || []).find((n) => n && String(n.id) === id);
        if (!node) continue;
        gone.push(`#${id} ${node.title || node.type || ""}`.trim());
        // remove() takes the node's links with it; litegraph owns that bookkeeping
        // and doing it by hand is how you end up with links pointing at nothing.
        try { graph.remove(node); } catch (_) {}
      }
    } finally {
      if (changed) { try { graph.afterChange(); } catch (_) {} }
    }
    graph.setDirtyCanvas(true, true);   // the dispatch already said where this landed
    if (!gone.length) {
      this._sys("⚠️ Nothing to delete — those nodes are no longer on the graph.");
      return;
    }
    const why = ev.reason ? ` — ${ev.reason}` : "";
    this._sys(`🗑️ Removed ${gone.length} node${gone.length === 1 ? "" : "s"}: `
      + `${gone.join(", ")}${why}. **Ctrl+Z** puts them back.`);
  }

  // The halt is over — the user continued or stopped. The collector node stays
  // exactly where it is: it is the record of what that stage ran with, and
  // deleting it would take the evidence away the moment it became history.
  _reviewReleased(ev) {
    window.agentYReviewHalted = false;
    try {
      window.dispatchEvent(new CustomEvent("agentY:review", { detail: { halted: false } }));
    } catch (_) {}
    this._sys(String(ev.answer) === "stop"
      ? "🛑 Run stopped at the review — nothing further was queued."
      : "▶️ Continuing with what the collector holds.");
  }

  // Place the agent's written answer to a TEXT hook onto the canvas as an
  // "agentY text" node (a wireable STRING value), then wire its output wherever
  // the hook's own output went — so downstream nodes / the next hook stage
  // consume the string on a normal run. The hook node itself is left in place.
  _placeCanvasText(ev) {
    const LG = window.LiteGraph;
    const graph = this._targetGraph();
    const text = String(ev.text || "");
    if (!LG || !LG.registered_node_types || !LG.registered_node_types["AgentYText"]) {
      this._sys("⚠️ Wrote the answer, but this ComfyUI has no **agentY text** node registered — "
        + "`git pull` the agentY-comfyuiConnect extension and reload to place it on the canvas.");
      return;
    }
    let node;
    try {
      node = LG.createNode("AgentYText");
      graph.add(node);
    } catch (e) {
      this._sys(`⚠️ Could not add agentY text node: ${e}`);
      return;
    }
    const w = (node.widgets || []).find((x) => x && x.name === "text");
    if (w) {
      w.value = text;
      try { if (w.callback) w.callback(text, app.canvas, node); } catch (_) {}
    }
    // Beside the hook it answers when that's still on the canvas, otherwise
    // beside the rest of the graph — the same rule generated media follows, so a
    // text node never lands off in empty space away from the workflow.
    const hid = Number(ev.hook_node_id);
    const hook = (graph.getNodeById && graph.getNodeById(hid))
      || (graph._nodes || []).find((n) => n && String(n.id) === String(ev.hook_node_id));
    markAgentDrop(node);
    node.pos = this._dropPos(hook || null, node);
    node.title = "agentY text";
    // The hook is ALWAYS left wired exactly as the user drew it, and this node is
    // placed UNCONNECTED as a readable reference — the server injects the value
    // into the base graph at run time, so nothing on the canvas is rewired.
    //
    // `freeze` used to take over the hook's downstream consumers here, rewiring
    // every input the hook fed to point at this node instead. That destroyed the
    // thing the user drew: the hook chain is the graph's readable statement of
    // what happens, and a switch about keeping a RESULT has no business rewriting
    // it. Keeping the result is what that switch does now (see hook_cache), and
    // the server sends keep_live true for every text placement.
    graph.setDirtyCanvas(true, true);
    this._sys(
      "🧩 Placed an **agentY text** node with the answer on the canvas as a reference "
      + "(hook left live — the value is injected into the graph at run time)."
    );
  }

  // ── canvas hooks (AgentYHook nodes) ──────────────────────────────────────────
  _hookNodes() {
    const graph = app.graph;
    if (!graph || !graph._nodes) return [];
    return graph._nodes.filter(
      (n) => n && (n.type === "AgentYHook" || n.comfyClass === "AgentYHook")
    );
  }

  // Follow every "anchor" input link back to the node(s) feeding this hook. The
  // anchor input auto-grows (anchor, anchor0, anchor1, …), so a hook may gather
  // several inputs; returns, in slot order, the origin node plus the source
  // output slot, its declared TYPE, and the target input name so the exact wiring
  // (which output feeds which input) survives into the baked subgraph chain.
  // The type is what tells the agent side whether the wire carries a renderable
  // tensor (IMAGE/MASK/LATENT/VIDEO) it must materialise to a file before the
  // agent can see it — a mid-graph node names no file anywhere in its widgets.
  // An `agentY add tag` node is an annotation ON a wire, not a node anyone means
  // to anchor: it names the reference it carries and says what it is FOR. Resolve
  // past it to the node the user thinks they wired, keeping the tag and the text.
  // Doing it here rather than per-consumer is what keeps the QA references, the
  // iterate feedback node and the hook block all seeing the LoadImage instead of
  // the annotation.
  _throughRefNotes(node, slot) {
    const graph = app.graph;
    const isNote = (n) =>
      !!n && (n.type === "AgentYRefNote" || n.comfyClass === "AgentYRefNote");
    let role = "";
    let tag = "";
    for (let hop = 0; hop < 4 && isNote(node); hop++) {
      const w = this._widgetSnapshot(node);
      role = role || String(w.role || "").trim();
      // The tag is what a directive says (`#hero_face`), so the anchor has to
      // carry it too — otherwise the agent reads the word and has nothing on the
      // graph to attach it to.
      tag = tag || normaliseTag(w.tag);
      const inp = (node.inputs || []).find((i) => i && i.name === "input");
      const link = inp && inp.link != null && graph.links ? graph.links[inp.link] : null;
      const src = link && graph.getNodeById ? graph.getNodeById(link.origin_id) : null;
      if (!src) break;          // an unwired note: report the note, with its text
      node = src;
      slot = link.origin_slot | 0;
    }
    return { node, slot, role, tag };
  }

  _anchorsFor(hookNode) {
    const graph = app.graph;
    if (!graph) return [];
    const out = [];
    for (const inp of hookNode.inputs || []) {
      if (!inp || inp.link == null) continue;
      // V3 Autogrow names the slots "anchors.anchor0", "anchors.anchor1", …; older
      // builds used a bare "anchor"/"anchor0". Match the trailing anchorN either
      // way (the "anchors." group prefix must not defeat detection) — otherwise the
      // whole anchor link, and every hook→hook chain link, is silently dropped.
      if (!/(?:^|\.)anchor\d*$/.test(String(inp.name || ""))) continue;
      const link = graph.links ? graph.links[inp.link] : null;
      if (!link) continue;
      const origin = graph.getNodeById ? graph.getNodeById(link.origin_id) : null;
      if (!origin) continue;
      const { node, slot, role, tag } = this._throughRefNotes(origin, link.origin_slot | 0);
      // Prefer the link's own resolved type: a reroute (or any wildcard slot)
      // declares "*" on the node but the link carries the concrete type.
      //
      // EXCEPT when we hopped through an `agentY add tag`. Then this link starts
      // at the NOTE, and its type is the note's wildcard (COMFY_MATCHTYPE_V3) —
      // reporting that would say the anchor is an image whose type isn't IMAGE.
      // Downstream, splicing looks for the anchor matching a target's type, finds
      // none, and falls back to the first anchor wired to the hook — which is how
      // a prompt string ended up in a Seedream image input. A note is an
      // annotation on the wire; the type belongs to what it wraps.
      const ownType = String(((node.outputs || [])[slot] || {}).type || "");
      const outType = node === origin
        ? String(link.type || ownType || "")
        : String(ownType || link.type || "");
      out.push({ node, fromSlot: slot, outType, toName: String(inp.name), role, tag });
    }
    return out;
  }

  // Follow every link OUT of this hook's output(s) to the node input it feeds —
  // the producer's DESTINATION. A hook is an upstream producer: it consumes its
  // anchor inputs as context and produces value(s) for its `out`, which the user
  // wires into a real input (e.g. a KSampler's `seed`, a prompt node's `text`).
  // Recording the exact target (node id + input name + declared type) lets the
  // agent produce the right kind of value and fill/sweep the RIGHT input without
  // guessing "the connected node" from prose.
  _targetsFor(hookNode) {
    const graph = app.graph;
    if (!graph) return [];
    const out = [];
    const outputs = hookNode.outputs || [];
    for (let slot = 0; slot < outputs.length; slot++) {
      const o = outputs[slot];
      if (!o || !Array.isArray(o.links)) continue;
      for (const lid of o.links) {
        const link = graph.links ? graph.links[lid] : null;
        if (!link) continue;
        const node = graph.getNodeById ? graph.getNodeById(link.target_id) : null;
        if (!node) continue;
        const tin = (node.inputs || [])[link.target_slot | 0] || {};
        out.push({
          node_id: String(node.id),
          type: String(node.type || node.comfyClass || ""),
          title: String(node.title || ""),
          to_input: String(tin.name || ""),
          to_input_type: String(tin.type || ""),
          from_output_slot: slot,
        });
      }
    }
    return out;
  }

  // Scalar widget values of a node (numbers/strings), for the [CANVAS HOOKS] block.
  _widgetSnapshot(node) {
    const out = {};
    for (const w of node.widgets || []) {
      if (w && w.name != null && w.value != null && typeof w.value !== "object")
        out[w.name] = w.value;
    }
    return out;
  }

  _collectCanvasHooks() {
    const hooks = [];
    for (const hn of this._hookNodes()) {
      // Disabling a hook is the standard ComfyUI gesture: bypass (Ctrl+B, mode 4)
      // or mute (Ctrl+M, mode 2). Both mean "this node is not part of the run",
      // which is exactly what the agent should honour — so a disabled hook is
      // simply not collected. (This replaced a bespoke `ignore` widget, which
      // duplicated the concept and was invisible unless you read the node.)
      if (hn.mode === 4 || hn.mode === 2) continue;
      const w = this._widgetSnapshot(hn);
      const directive = String(w.directive || "").trim();
      const purpose = String(w.purpose || "inline_parameter");
      // An empty hook is a no-op — every purpose but one IS its directive. A
      // review hook is the exception: it says everything it has to say by being
      // a review hook wired where it is, so its prompt box is hidden on the node
      // and there is nothing to type. See hookReaches in agent_hook.js.
      if (!hookReaches(purpose, directive)) continue;
      const links = this._anchorsFor(hn);
      const isHook = (n) =>
        !!n && (n.type === "AgentYHook" || n.comfyClass === "AgentYHook");
      // A hook wired FROM another hook is a downstream stage in a chain: its
      // input is the predecessor's output (resolved at run time), so record it in
      // prev_hook_id(s)/prev_links. A hook wired from a real node anchors an
      // inline_parameter/make_workflow. With auto-grow a hook can carry several of each; the
      // singular fields keep the first of each (unchanged behavior for the common
      // single-input case) and the plural, slot-aware fields carry every wired
      // input so the bake step can reproduce the exact wiring.
      const realLinks = links.filter((l) => !isHook(l.node));
      const hookLinks = links.filter((l) => isHook(l.node));
      const first = realLinks[0] ? realLinks[0].node : null;
      const outs = hn.outputs || [];
      // One switch on the node ("should what this hook produced outlive the
      // run?"), one field on the wire. What ON *means* is resolved by purpose on
      // the agent side — a subgraph for make_workflow, a memorized result for
      // everything else — so neither side re-derives it from the other's name.
      // Older saves (two fields, or three) are migrated in agent_hook.js.
      hooks.push({
        hook_node_id: String(hn.id),
        // What the node is CALLED on the canvas. Node ids are not visible without
        // going looking for them, so an agent that says "hook 30" is naming
        // something the user cannot see; the title is what they can point at.
        // Sent raw, including the default "agentY hook" — deciding whether a title
        // is distinguishing is the server's job, not something to guess here.
        title: String(hn.title || ""),
        directive,
        purpose,
        // Keep what this hook produced and put it back next time, for as long as
        // nothing feeding it changes. Off is also the forget gesture: the server
        // drops what it KEPT under this hook's current key (the journal
        // underneath survives, which is what lets this be flipped in hindsight).
        remember: w.remember === true || w.remember === "true",
        output_count: outs.length,
        outputs_wired: outs.filter((o) => o && o.links && o.links.length).length,
        // Where this hook's output is wired — the producer's destination input(s).
        targets: this._targetsFor(hn),
        prev_hook_id: hookLinks.length ? String(hookLinks[0].node.id) : null,
        anchor_node_id: first ? String(first.id) : null,
        anchor_type: first ? String(first.type || first.comfyClass || "") : null,
        anchor_title: first ? String(first.title || "") : null,
        anchor_widgets: first ? this._widgetSnapshot(first) : {},
        prev_hook_ids: hookLinks.map((l) => String(l.node.id)),
        prev_links: hookLinks.map((l) => ({
          from_hook_id: String(l.node.id),
          from_output_slot: l.fromSlot,
          to_input: l.toName,
        })),
        anchors: realLinks.map((l) => ({
          node_id: String(l.node.id),
          type: String(l.node.type || l.node.comfyClass || ""),
          title: String(l.node.title || ""),
          widgets: this._widgetSnapshot(l.node),
          from_output_slot: l.fromSlot,
          from_output_type: l.outType,
          to_input: l.toName,
          // What an `agentY add tag` on this wire says the reference is FOR.
          role: String(l.role || ""),
          // And what it is CALLED — the name a directive uses as `#tag`.
          tag: String(l.tag || ""),
        })),
      });
    }
    return hooks;
  }

  // Capture the current graph as an API-format prompt (node-id keyed). Async in
  // recent ComfyUI (returns a promise); awaiting a plain object is also fine.
  async _captureCanvasGraph() {
    try {
      const p = await app.graphToPrompt();
      return p && p.output ? p.output : null;
    } catch (e) {
      return null;
    }
  }

  // ── slash-command popup ──────────────────────────────────────────────────────
  _onInput() {
    this._autosize();
    const v = this.input.value;
    if (v === "/") this._showPop("");
    else if (v.startsWith("/") && !v.includes(" ")) this._showPop(v.slice(1));
    else this._hidePop();
  }
  _autosize() {
    const ta = this.input;
    ta.style.height = "auto";
    // scrollHeight is content + padding but EXCLUDES the border, while the field is
    // box-sizing:border-box — so assigning it straight leaves the box a border short
    // of what the text needs, and the browser grows it back, landing a couple of
    // pixels taller than the buttons next to it. Add the border back explicitly.
    const border = ta.offsetHeight - ta.clientHeight;
    ta.style.height = Math.min(ta.scrollHeight + border, 150) + "px";
  }
  _showPop(q) {
    this._filtered = this.commands.filter((c) => c.name.slice(1).startsWith(q));
    if (!this._filtered.length) return this._hidePop();
    this._popSel = 0;
    this._renderPop();
    this.pop.style.display = "block";
  }
  _renderPop() {
    this.pop.innerHTML = "";
    this._filtered.forEach((c, i) => {
      const item = el("div", { className: "ay-pop-item" + (i === this._popSel ? " sel" : "") }, [
        el("span", { className: "ay-pop-name", textContent: c.name }),
        el("span", { className: "ay-pop-desc", textContent: c.description }),
      ]);
      item.addEventListener("mousedown", (e) => { e.preventDefault(); this._pickCmd(c); });
      this.pop.append(item);
    });
  }
  _hidePop() { this.pop.style.display = "none"; }
  _pickCmd(c) {
    const needsArg = ["/switch_model", "/add_workflow", "/remove_workflow"].includes(c.name);
    this.input.value = c.name + (needsArg ? " " : "");
    this._hidePop();
    this.input.focus();
    if (!needsArg) { /* leave for the user to press Enter */ }
  }
  _onKeydown(e) {
    const popOpen = this.pop.style.display === "block";
    if (popOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); this._popSel = (this._popSel + 1) % this._filtered.length; this._renderPop(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); this._popSel = (this._popSel - 1 + this._filtered.length) % this._filtered.length; this._renderPop(); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); this._pickCmd(this._filtered[this._popSel]); return; }
      if (e.key === "Escape") { this._hidePop(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
  }
}

// ── register the sidebar tab ────────────────────────────────────────────────────
// One persistent AgentChat for the whole page. ComfyUI destroys and recreates the
// sidebar panel element on every tab switch; constructing a fresh AgentChat each
// time (the old behavior) orphaned any in-flight turn — its SSE stream kept writing
// to a discarded DOM, so messages "disappeared" when you looked away. Instead we
// keep a single instance and just re-parent its DOM into each new mount point.
let _AGENTY_CHAT = null;

// Expose the conversation currently selected in the history dropdown so other
// panels (e.g. the Token Usage overview's "Current run" scope) can scope to it.
// Returns {id, title} or null when no thread is open (a fresh, unsaved chat).
window.agentYCurrentThread = () => {
  const c = _AGENTY_CHAT;
  if (!c || !c.threadId) return null;
  let title = "";
  try {
    const opt = c.threadSel && c.threadSel.querySelector(`option[value="${c.threadId}"]`);
    title = opt ? opt.textContent : "";
  } catch (_) {}
  return { id: c.threadId, title };
};

// Run the hooks on the current canvas without typing anything: used by the
// "Run agentY hooks" button in ComfyUI's top bar (see agent_run_hooks.js).
// Goes through the normal send() path on purpose — that is what captures the
// graph, the hooks, the selection and any staged canvas inputs, so the button
// and a typed "run this" reach the agent as exactly the same turn.
// `opts.dryRun` runs the same turn with the submission removed: every hook is
// answered and every graph is built, but nothing is handed to ComfyUI and each
// variant comes back as a stand-in path (see src/utils/dry_run.py agent-side).
// Returns a short status string; the caller surfaces it as a toast.
window.agentYRunHooks = (text, opts = {}) => {
  if (!_AGENTY_CHAT) _AGENTY_CHAT = new AgentChat();  // builds its DOM unmounted
  const chat = _AGENTY_CHAT;
  // Nothing to run: a hookless graph would still cost a full (paid) turn to be
  // told there is nothing to do, so say it here instead of sending.
  let hooks = [];
  try { hooks = chat._collectCanvasHooks(); } catch (_) {}
  if (!hooks.length) {
    return "No active agentY hooks on this graph — add an agentY hook node "
         + "(and give it a directive) to run one.";
  }
  // A turn waiting on an answer would take this text AS the answer, which is not
  // what a "run the hooks" button means. Send the user to the panel instead.
  if (chat.activeAsk) {
    return "agentY is waiting for an answer in the panel — reply there first.";
  }
  // Show the panel, so the run is visible rather than happening off-screen.
  try {
    const em = app.extensionManager;
    const store = (em && em.sidebarTab) || em;
    if (store && typeof store.toggleSidebarTab === "function") {
      if (store.activeSidebarTabId !== "agentY-chat") store.toggleSidebarTab("agentY-chat");
    }
  } catch (_) {}
  // Sampled BEFORE send(), which decides then and there whether to queue.
  const wasBusy = chat.streaming;
  const dry = !!opts.dryRun;
  chat._dryRunOnce = dry;   // one-shot; send() consumes it
  chat.input.value = String(text || (dry ? "Dry run this workflow" : "Run this workflow"));
  chat.send();
  if (wasBusy) {
    return `Queued — ${hooks.length} hook(s) ${dry ? "will be dry-run" : "will run"} `
         + "when the current turn finishes.";
  }
  return dry
    ? `Dry run — walking ${hooks.length} hook(s), building the graphs, generating nothing…`
    : `Running ${hooks.length} agentY hook(s)…`;
};

app.registerExtension({
  name: "agentY.chat.sidebar",
  async setup() {
    const register = () => {
      if (!app.extensionManager || !app.extensionManager.registerSidebarTab) return false;
      app.extensionManager.registerSidebarTab({
        id: "agentY-chat",
        icon: "pi pi-comments",
        title: "agentY",
        tooltip: "Chat with agentY — generate/edit media as graph nodes",
        type: "custom",
        render: (elm) => {
          if (!_AGENTY_CHAT) _AGENTY_CHAT = new AgentChat();
          _AGENTY_CHAT.mount(elm);
        },
      });
      console.log("[agentY] chat sidebar tab registered");
      return true;
    };
    if (!register()) {
      console.warn("[agentY] extensionManager.registerSidebarTab unavailable — update ComfyUI frontend to use the chat sidebar.");
    }
  },
});
