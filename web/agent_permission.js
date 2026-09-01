import { app } from "../../scripts/app.js";
import { backendBase, backendReady } from "./agent_backend.js";

// The approval prompt for tools that act outside the agent's own process —
// running a program, evaluating Python, installing a node pack from a git URL.
// The host decides WHICH tools ask (src/utils/tool_permissions.py); this is where
// the asking is visible.
//
// Long-polled on its own connection rather than delivered through the chat
// stream, because while this question is outstanding the agent's thread is
// blocked inside the tool: nothing riding on the turn's own events could arrive.
// The host's module explains that at length, and canvas_probe hit it first.
//
// The command is shown verbatim, never summarised. A prompt that paraphrased
// would be asking you to trust the paraphrase, which is the one thing an
// approval step exists not to do.

// Seconds the HOST holds the connection open waiting for a question. A real long
// poll, not an interval: every request carries the session token, which makes it
// a non-simple request, so the browser sends a CORS preflight first and a poll on
// a timer costs TWO lines in the host's console each time round. At 25s this is
// roughly five requests a minute while idle instead of a hundred.
const WAIT_S = 25;
// Between long polls that returned nothing. Just enough to not be a tight loop if
// the host ever answers instantly.
const POLL_MS = 200;
// While a prompt is on screen there is nothing to ask for, so this is only how
// often the loop re-checks whether it has been answered.
const SHOWING_MS = 500;
// After a failed poll. The host being down is the ordinary case (nobody has
// started it yet), and a panel that retried every second would spend the session
// filling the network tab.
const BACKOFF_MS = 5000;

let showing = null;   // permission_id currently on screen

function injectStyles() {
  if (document.getElementById("agentY-permission-styles")) return;
  const css = `
  .ayp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10050;display:flex;
    align-items:center;justify-content:center;
    font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;}
  .ayp-card{background:#262624;color:#f2f0ea;border:1px solid rgba(240,235,225,.12);
    border-radius:14px;width:min(620px,92vw);box-shadow:0 20px 60px rgba(0,0,0,.6);}
  .ayp-head{display:flex;align-items:center;gap:10px;padding:14px 18px;
    border-bottom:1px solid rgba(240,235,225,.10);}
  .ayp-head h2{font-size:15px;margin:0;font-weight:650;flex:1;}
  .ayp-tool{font-size:11px;opacity:.7;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
  .ayp-body{padding:14px 18px;}
  .ayp-cmd{background:#1b1b1a;border:1px solid rgba(240,235,225,.10);border-radius:8px;
    padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
    white-space:pre-wrap;word-break:break-word;max-height:36vh;overflow:auto;}
  .ayp-note{font-size:12px;opacity:.75;margin-top:10px;line-height:1.5;}
  .ayp-foot{display:flex;gap:10px;justify-content:flex-end;padding:12px 18px;
    border-top:1px solid rgba(240,235,225,.10);flex-wrap:wrap;}
  .ayp-btn{background:#333230;color:#f2f0ea;border:1px solid rgba(240,235,225,.16);
    border-radius:8px;padding:7px 13px;font-size:13px;cursor:pointer;}
  .ayp-btn:hover{background:#3d3c39;}
  .ayp-btn.primary{background:#d97757;border-color:#d97757;color:#1b1b1a;font-weight:600;}
  .ayp-btn.danger{border-color:#d9575755;}
  .ayp-count{font-size:11px;opacity:.6;margin-right:auto;align-self:center;}`;
  const tag = document.createElement("style");
  tag.id = "agentY-permission-styles";
  tag.textContent = css;
  document.head.append(tag);
}

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  if (props.style) Object.assign(n.style, props.style);
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
}

const TITLES = {
  run_script: "Run this command?",
  iterate: "Run this Python?",
  install_custom_node: "Install this custom-node pack?",
};

const NOTES = {
  run_script:
    "Runs on your machine, as you. agentY restricts which programs and folders " +
    "are reachable, but python can do anything python can do — which is why " +
    "this asks.",
  iterate:
    "Evaluates the expression in this process, with no restrictions at all.",
  install_custom_node:
    "Clones a repository from the internet and installs its requirements into " +
    "ComfyUI's Python. That is running someone else's code.",
};

async function reply(id, allowed, remember) {
  try {
    await fetch(backendBase() + "/agentY/permission/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission_id: id, allowed, remember }),
    });
  } catch (_) {
    // The waiter times out on its own and denies, which is the same outcome.
  }
}

function show(req) {
  injectStyles();
  showing = req.permission_id;

  const overlay = el("div", { className: "ayp-overlay" });
  const close = (allowed, remember) => {
    overlay.remove();
    showing = null;
    document.removeEventListener("keydown", onKey);
    reply(req.permission_id, allowed, remember);
  };
  // Escape denies. The safe answer is the reflexive one, and every other way of
  // making this go away without choosing — clicking the backdrop, closing the
  // tab — also lands on deny, via the host's timeout.
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(false, false); }
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close(false, false);
  });

  const card = el("div", { className: "ayp-card" });
  card.append(el("div", { className: "ayp-head" }, [
    el("h2", { textContent: TITLES[req.tool] || "Allow this tool to run?" }),
    el("span", { className: "ayp-tool", textContent: req.tool }),
  ]));

  const body = el("div", { className: "ayp-body" });
  body.append(el("div", { className: "ayp-cmd", textContent: req.summary || "(no details)" }));
  if (NOTES[req.tool]) body.append(el("div", { className: "ayp-note", textContent: NOTES[req.tool] }));
  card.append(body);

  const deny = el("button", { className: "ayp-btn danger", textContent: "Don't run" });
  const once = el("button", { className: "ayp-btn", textContent: "Allow once" });
  const always = el("button", { className: "ayp-btn primary", textContent: "Allow for this session" });
  deny.addEventListener("click", () => close(false, false));
  once.addEventListener("click", () => close(true, false));
  always.addEventListener("click", () => close(true, true));

  card.append(el("div", { className: "ayp-foot" }, [
    el("span", { className: "ayp-count",
                 textContent: `“Allow for this session” stops asking about ${req.tool} until the host restarts.` }),
    deny, once, always,
  ]));

  overlay.append(card);
  document.body.append(overlay);
  // Deny is focused, so a stray Enter is the safe answer rather than the
  // convenient one.
  deny.focus();
}

async function poll() {
  if (showing) return SHOWING_MS;
  try {
    const r = await fetch(
      `${backendBase()}/agentY/permission?wait=${WAIT_S}`, { cache: "no-store" });
    if (!r.ok) return BACKOFF_MS;
    const data = await r.json();
    if (data && data.request) show(data.request);
    return POLL_MS;
  } catch (_) {
    return BACKOFF_MS;
  }
}

async function loop() {
  try { await backendReady; } catch (_) {}
  for (;;) {
    const wait = await poll();
    await new Promise((r) => setTimeout(r, wait));
  }
}

app.registerExtension({
  name: "agentY.toolPermission",
  setup() {
    loop();
  },
});
