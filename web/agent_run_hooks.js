import { app } from "../../scripts/app.js";

// "Run agentY hooks" — a button next to ComfyUI's Run button that runs the hook
// nodes on the current graph, so a hook run costs one click instead of switching
// to the sidebar and typing. It sends the same turn a typed "Run this workflow"
// would (window.agentYRunHooks in agent_chat.js does the work).
//
// It is a split button, shaped like ComfyUI's own Run: the wide half runs, the
// arrow opens a menu with the two ways to run. "Dry run" walks the whole hook
// chain and builds every graph but submits none of them — each generation comes
// back as a stand-in path, so the hooks downstream of it still run and the LOGIC
// of a chain can be checked without paying for its output.
//
// ComfyUI 1.48 has no API for adding a button to the top bar: extensions get
// `commands`, `menuCommands`, `keybindings`, sidebar and bottom-panel tabs, and
// nothing else. So this registers a real command (palette- and keybinding-
// addressable, and listed under the Workflow menu) and additionally *injects* a
// button into the action bar for the one-click case. The command is the contract;
// the injected button is a convenience that degrades to nothing if the frontend
// moves its DOM around.

const COMMAND_ID = "agentY.runHooks";
const DRY_COMMAND_ID = "agentY.runHooksDry";
const LABEL = "Run agentY hooks";
const DRY_LABEL = "Dry run agentY hooks";
// Shorter on the button itself: it sits directly beside Run, wearing the same
// play icon, so repeating "Run" reads as clutter. The command, the menu entry and
// the tooltip all keep the full name.
const BTN_LABEL = "agentY hooks";
const TOOLTIP = "Run the agentY hook nodes on this graph (sends “Run this workflow” to the agentY panel)";
const DRY_TOOLTIP = "Walk the hook chain and build every graph, but generate nothing — "
  + "checks the logic and the wiring without paying for the output";
const BTN_ID = "agentY-run-hooks-btn";
const ARROW_ID = "agentY-run-hooks-arrow";
const GROUP_ID = "agentY-run-hooks-group";
const MENU_ID = "agentY-run-hooks-menu";

function runHooks(opts = {}) {
  if (typeof window.agentYRunHooks !== "function") {
    toast("agentY panel is not loaded yet — open the agentY sidebar tab once.", "warn");
    return;
  }
  const dry = !!opts.dryRun;
  let msg = "";
  try {
    msg = window.agentYRunHooks(dry ? "Dry run this workflow" : "Run this workflow",
                                { dryRun: dry });
  } catch (e) { msg = "Failed: " + e; }
  if (msg) toast(msg, /^(No active|agentY is waiting|Failed)/.test(msg) ? "warn" : "info");
}

function dryRunHooks() { runHooks({ dryRun: true }); }

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
    /* The two halves are one control: the group carries the outer radius and the
       margin, each half only rounds the side it owns. Same shape ComfyUI's own
       Run split button has, built from tokens so it follows the theme. */
    #${GROUP_ID}{display:inline-flex;align-items:stretch;margin:0 .25rem;}
    #${BTN_ID},#${ARROW_ID}{
      display:inline-flex;align-items:center;justify-content:center;gap:.4rem;
      box-sizing:border-box;cursor:pointer;
      height:2rem;
      font-family:inherit;font-size:.875rem;font-weight:500;line-height:1;
      white-space:nowrap;
      color:var(--p-primary-contrast-color,#fff);
      background:var(--p-primary-color,#2f7bf6);
      border:1px solid var(--p-primary-color,#2f7bf6);
      transition:filter .12s ease,box-shadow .12s ease;
    }
    #${BTN_ID}{
      padding:0 .75rem;
      border-radius:var(--p-border-radius-md,6px) 0 0 var(--p-border-radius-md,6px);
      border-right:none;
    }
    #${ARROW_ID}{
      padding:0 .4rem;
      border-radius:0 var(--p-border-radius-md,6px) var(--p-border-radius-md,6px) 0;
      /* A hairline seam, from the contrast colour so it reads on any primary. */
      box-shadow:inset 1px 0 0 color-mix(in srgb,var(--p-primary-contrast-color,#fff) 30%,transparent);
    }
    /* brightness rather than a second colour token: works whether the active
       theme's primary is light or dark, which a fixed hover colour does not. */
    #${BTN_ID}:hover,#${ARROW_ID}:hover{filter:brightness(1.1);}
    #${BTN_ID}:active,#${ARROW_ID}:active{filter:brightness(.95);transform:translateY(1px);}
    #${ARROW_ID}[aria-expanded="true"]{filter:brightness(.9);}
    #${BTN_ID}:focus-visible,#${ARROW_ID}:focus-visible{
      outline:none;
      box-shadow:0 0 0 2px var(--p-content-background,#1e1e1e),
                 0 0 0 4px var(--p-primary-color,#2f7bf6);
    }
    #${BTN_ID} .pi,#${ARROW_ID} .pi{font-size:.875rem;line-height:1;}
    #${ARROW_ID} .pi{font-size:.7rem;}

    /* The menu is fixed and lives on <body>: the action bar is re-rendered on
       dock/undock and clips its own overflow, either of which would eat it. */
    #${MENU_ID}{
      position:fixed;z-index:2000;min-width:12rem;padding:.25rem;
      display:none;flex-direction:column;
      font-family:inherit;font-size:.8125rem;
      color:var(--p-content-color,#e6e6e6);
      background:var(--p-content-background,#1e1e1e);
      border:1px solid var(--p-content-border-color,#3a3a3a);
      border-radius:var(--p-border-radius-md,6px);
      box-shadow:0 8px 24px rgba(0,0,0,.45);
    }
    #${MENU_ID}.open{display:flex;}
    #${MENU_ID} button{
      display:flex;align-items:flex-start;gap:.5rem;text-align:left;
      padding:.45rem .55rem;cursor:pointer;
      font:inherit;color:inherit;background:none;border:none;
      border-radius:var(--p-border-radius-sm,4px);
    }
    #${MENU_ID} button:hover,#${MENU_ID} button:focus-visible{
      outline:none;background:var(--p-content-hover-background,rgba(255,255,255,.08));
    }
    #${MENU_ID} .pi{margin-top:.15rem;color:var(--p-primary-color,#2f7bf6);}
    #${MENU_ID} .agy-mi-title{font-weight:600;}
    #${MENU_ID} .agy-mi-desc{
      display:block;margin-top:.15rem;font-size:.75rem;font-weight:400;opacity:.75;
      white-space:normal;
    }
    /* Narrow bars: keep the icons, drop the words — the tooltip still explains it. */
    @media (max-width:1200px){
      #${BTN_ID}{padding:0 .5rem;}
      #${BTN_ID} .agy-label{display:none;}
    }
  `;
  document.head.appendChild(s);
}

// ── the drop-down ─────────────────────────────────────────────────────────────
// Two ways to run the same hooks, so it belongs on the button rather than in a
// settings page: the choice is made per run, not once.
const MENU_ITEMS = [
  { icon: "pi pi-play", title: "Full run",
    desc: "Generate for real",
    run: () => runHooks() },
  { icon: "pi pi-eye", title: "Dry run",
    desc: "Build everything, generate nothing",
    // The long version, on hover — a menu is glanced at, not read.
    hint: "Walks the whole hook chain and builds every graph, but submits none of "
        + "them. Generations come back as stand-in file paths, so the hooks after "
        + "them still run: it checks the logic, not the pixels.",
    run: () => dryRunHooks() },
];

let _menu = null;

function menu() {
  if (_menu && document.body.contains(_menu)) return _menu;
  const m = document.createElement("div");
  m.id = MENU_ID;
  m.setAttribute("role", "menu");
  for (const item of MENU_ITEMS) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    if (item.hint) b.title = item.hint;
    const icon = document.createElement("i");
    icon.className = item.icon;
    const text = document.createElement("span");
    const title = document.createElement("span");
    title.className = "agy-mi-title";
    title.textContent = item.title;
    const desc = document.createElement("span");
    desc.className = "agy-mi-desc";
    desc.textContent = item.desc;
    text.append(title, desc);
    b.append(icon, text);
    b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      closeMenu();
      item.run();
    });
    m.append(b);
  }
  document.body.append(m);
  _menu = m;
  return m;
}

function menuOpen() {
  return !!(_menu && _menu.classList.contains("open"));
}

function closeMenu() {
  if (_menu) _menu.classList.remove("open");
  const arrow = document.getElementById(ARROW_ID);
  if (arrow) arrow.setAttribute("aria-expanded", "false");
}

function openMenu(anchor) {
  const m = menu();
  m.classList.add("open");
  const arrow = document.getElementById(ARROW_ID);
  if (arrow) arrow.setAttribute("aria-expanded", "true");
  // Under the group, right-aligned to it, then nudged back inside the viewport —
  // the action bar can be dragged to either edge of the screen.
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth || 240;
  let left = r.right - w;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  m.style.left = `${left}px`;
  m.style.top = `${r.bottom + 4}px`;
  const first = m.querySelector("button");
  if (first) first.focus();
}

// One set of global listeners for the life of the page: click anywhere else, or
// Escape, closes it. Registered in the capture phase so a click that a Vue
// handler stops still dismisses the menu.
function watchDismiss() {
  document.addEventListener("pointerdown", (e) => {
    if (!menuOpen()) return;
    if (_menu.contains(e.target)) return;
    const arrow = document.getElementById(ARROW_ID);
    if (arrow && arrow.contains(e.target)) return;  // its own toggle handles it
    closeMenu();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuOpen()) {
      closeMenu();
      const arrow = document.getElementById(ARROW_ID);
      if (arrow) arrow.focus();
    }
  }, true);
  // A scrolled or resized page leaves the menu behind — it is fixed, its anchor
  // is not. Cheapest correct answer is to close it.
  window.addEventListener("resize", closeMenu);
  window.addEventListener("scroll", closeMenu, true);
}

function makeButton() {
  const group = document.createElement("div");
  group.id = GROUP_ID;

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
  b.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    closeMenu();
    runHooks();
  });

  // The arrow half: full run stays one click, everything else is behind it.
  const arrow = document.createElement("button");
  arrow.id = ARROW_ID;
  arrow.type = "button";
  arrow.title = "Run options — full run or dry run";
  arrow.setAttribute("aria-label", "agentY hook run options");
  arrow.setAttribute("aria-haspopup", "menu");
  arrow.setAttribute("aria-expanded", "false");
  const caret = document.createElement("i");
  caret.className = "pi pi-chevron-down";
  arrow.append(caret);
  arrow.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (menuOpen()) closeMenu();
    else openMenu(group);
  });

  group.append(b, arrow);
  return group;
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
    if (document.getElementById(BTN_ID)) return;
    closeMenu();   // the arrow it was hanging off has just been re-rendered away
    place();
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
  commands: [
    {
      id: COMMAND_ID,
      label: LABEL,
      tooltip: TOOLTIP,
      icon: "pi pi-play-circle",
      // A command is invoked with its own arguments; `runHooks` reads opts.dryRun
      // off the first one, so it must not receive whatever the palette passes.
      function: () => runHooks(),
    },
    {
      id: DRY_COMMAND_ID,
      label: DRY_LABEL,
      tooltip: DRY_TOOLTIP,
      icon: "pi pi-eye",
      function: () => dryRunHooks(),
    },
  ],
  // Also reachable from the menubar, which needs no DOM injection to work.
  menuCommands: [{ path: ["Workflow"], commands: [COMMAND_ID, DRY_COMMAND_ID] }],
  async setup() {
    watch();
    watchDismiss();
  },
});
