import { app } from "../../scripts/app.js";

// "Run agentY hooks" — a button next to ComfyUI's Run button that runs the hook
// nodes on the current graph, so a hook run costs one click instead of switching
// to the sidebar and typing. It sends the same turn a typed "Run this workflow"
// would (window.agentYRunHooks in agent_chat.js does the work).
//
// ComfyUI 1.48 has no API for adding a button to the top bar: extensions get
// `commands`, `menuCommands`, `keybindings`, sidebar and bottom-panel tabs, and
// nothing else. So this registers a real command (palette- and keybinding-
// addressable, and listed under the Workflow menu) and additionally *injects* a
// button into the action bar for the one-click case. The command is the contract;
// the injected button is a convenience that degrades to nothing if the frontend
// moves its DOM around.

const COMMAND_ID = "agentY.runHooks";
const LABEL = "Run agentY hooks";
const TOOLTIP = "Run the agentY hook nodes on this graph (sends “Run this workflow” to the agentY panel)";
const BTN_ID = "agentY-run-hooks-btn";

function runHooks() {
  if (typeof window.agentYRunHooks !== "function") {
    toast("agentY panel is not loaded yet — open the agentY sidebar tab once.", "warn");
    return;
  }
  let msg = "";
  try { msg = window.agentYRunHooks("Run this workflow"); } catch (e) { msg = "Failed: " + e; }
  if (msg) toast(msg, /^(No active|agentY is waiting|Failed)/.test(msg) ? "warn" : "info");
}

// ComfyUI's toast if it's there, else the browser console — never throw from a
// notification, it is the least important thing happening.
function toast(text, severity) {
  try {
    const ext = app.extensionManager;
    if (ext && ext.toast && typeof ext.toast.add === "function") {
      ext.toast.add({ severity: severity === "warn" ? "warn" : "info",
                      summary: LABEL, detail: text, life: 4000 });
      return;
    }
  } catch (_) {}
  console.log("[agentY] " + text);
}

// ── the injected button ───────────────────────────────────────────────────────
// Styled off ComfyUI's own CSS variables so it tracks the active theme instead of
// hard-coding colours that look wrong in half of them.
function injectStyles() {
  if (document.getElementById("agentY-run-hooks-style")) return;
  const s = document.createElement("style");
  s.id = "agentY-run-hooks-style";
  s.textContent = `
    #${BTN_ID}{
      display:inline-flex;align-items:center;gap:6px;cursor:pointer;
      height:2rem;padding:0 .6rem;margin:0 .15rem;
      font-size:.8rem;font-weight:500;line-height:1;white-space:nowrap;
      color:var(--p-button-text-secondary-color,var(--fg-color,#ddd));
      background:transparent;border:1px solid transparent;border-radius:6px;
      transition:background .12s,border-color .12s;
    }
    #${BTN_ID}:hover{background:var(--p-button-text-secondary-hover-background,rgba(255,255,255,.08));}
    #${BTN_ID}:active{transform:translateY(1px);}
    #${BTN_ID} .agy-dot{
      width:.55rem;height:.55rem;border-radius:50%;flex:0 0 auto;
      background:var(--p-primary-color,#5b9bf5);
    }
    @media (max-width:1100px){ #${BTN_ID} .agy-label{display:none;} }
  `;
  document.head.appendChild(s);
}

function makeButton() {
  const b = document.createElement("button");
  b.id = BTN_ID;
  b.type = "button";
  b.title = TOOLTIP;
  b.setAttribute("aria-label", LABEL);
  const dot = document.createElement("span");
  dot.className = "agy-dot";
  const label = document.createElement("span");
  label.className = "agy-label";
  label.textContent = LABEL;
  b.append(dot, label);
  b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); runHooks(); });
  return b;
}

// Where to put it: inside the action bar (the floating panel that carries Run),
// immediately to the LEFT of the first button group. Deliberately anchored to a
// *group* rather than to a button: Run is a split button, so appending "next to
// the last button" can land inside its own group and render as part of it.
// Returns {row, before} for an insertBefore, or null when the bar isn't up yet.
function actionbarSlot() {
  const bar = document.querySelector(".actionbar") || document.querySelector('[class*="actionbar"]');
  if (!bar) return null;
  const first = bar.querySelector("button");
  if (!first) return null;
  // With a group, sit beside the whole group; without one, beside the button
  // itself — anchoring on its parent instead would drop us out of the row that
  // lays the buttons out and onto the bar's own frame.
  const group = first.closest(".comfyui-button-group");
  const before = group || first;
  const row = before.parentElement;
  if (!row || row === document.body) return null;
  return { row, before };
}

function place() {
  if (document.getElementById(BTN_ID)) return true;
  const slot = actionbarSlot();
  if (!slot) return false;
  injectStyles();
  slot.row.insertBefore(makeButton(), slot.before);
  return true;
}

// The action bar is Vue-rendered: it appears after us and is rebuilt when it is
// docked/undocked or the workflow changes, which drops our button. Watch for that
// and put it back. Cheap — the callback exits on the first line once the button is
// present, and the observer is the only way to notice a re-render.
function watch() {
  place();   // usually too early; the observer below covers the real arrival
  const obs = new MutationObserver(() => {
    if (!document.getElementById(BTN_ID)) place();
  });
  obs.observe(document.body, { childList: true, subtree: true });
  // Say so once if the bar never turns up, so a frontend that lays its top bar
  // out differently points at the command instead of failing silently.
  setTimeout(() => {
    if (!document.getElementById(BTN_ID)) {
      console.warn("[agentY] could not find ComfyUI's action bar — "
        + `use the command palette or the Workflow menu for "${LABEL}".`);
    }
  }, 15000);
}

app.registerExtension({
  name: "agentY.runHooks",
  commands: [{
    id: COMMAND_ID,
    label: LABEL,
    tooltip: TOOLTIP,
    icon: "pi pi-play-circle",
    function: runHooks,
  }],
  // Also reachable from the menubar, which needs no DOM injection to work.
  menuCommands: [{ path: ["Workflow"], commands: [COMMAND_ID] }],
  async setup() {
    watch();
  },
});
