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
// Shorter on the button itself: it sits directly beside Run, wearing the same
// play icon, so repeating "Run" reads as clutter. The command, the menu entry and
// the tooltip all keep the full name.
const BTN_LABEL = "agentY hooks";
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
// Shaped to sit next to ComfyUI's Run button as a sibling: same height, radius,
// padding, weight and icon treatment, and the same `pi pi-play` glyph Run uses.
// Every colour comes from PrimeVue's theme tokens (--p-primary-color and
// friends), so it follows whatever theme is active rather than hard-coding values
// that look wrong in half of them; the literals are only fallbacks for a theme
// that does not define the token.
function injectStyles() {
  if (document.getElementById("agentY-run-hooks-style")) return;
  const s = document.createElement("style");
  s.id = "agentY-run-hooks-style";
  s.textContent = `
    #${BTN_ID}{
      display:inline-flex;align-items:center;justify-content:center;gap:.4rem;
      box-sizing:border-box;cursor:pointer;
      height:2rem;padding:0 .75rem;margin:0 .25rem;
      font-family:inherit;font-size:.875rem;font-weight:500;line-height:1;
      white-space:nowrap;
      color:var(--p-primary-contrast-color,#fff);
      background:var(--p-primary-color,#2f7bf6);
      border:1px solid var(--p-primary-color,#2f7bf6);
      border-radius:var(--p-border-radius-md,6px);
      transition:filter .12s ease,box-shadow .12s ease;
    }
    /* brightness rather than a second colour token: works whether the active
       theme's primary is light or dark, which a fixed hover colour does not. */
    #${BTN_ID}:hover{filter:brightness(1.1);}
    #${BTN_ID}:active{filter:brightness(.95);transform:translateY(1px);}
    #${BTN_ID}:focus-visible{
      outline:none;
      box-shadow:0 0 0 2px var(--p-content-background,#1e1e1e),
                 0 0 0 4px var(--p-primary-color,#2f7bf6);
    }
    #${BTN_ID} .pi{font-size:.875rem;line-height:1;}
    /* Narrow bars: keep the icon, drop the words — the tooltip still explains it. */
    @media (max-width:1200px){
      #${BTN_ID}{padding:0 .5rem;}
      #${BTN_ID} .agy-label{display:none;}
    }
  `;
  document.head.appendChild(s);
}

function makeButton() {
  const b = document.createElement("button");
  b.id = BTN_ID;
  b.type = "button";
  b.title = TOOLTIP;
  b.setAttribute("aria-label", LABEL);
  const icon = document.createElement("i");
  icon.className = "pi pi-play";       // the glyph ComfyUI's own Run button uses
  const label = document.createElement("span");
  label.className = "agy-label";
  label.textContent = BTN_LABEL;
  b.append(icon, label);
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
