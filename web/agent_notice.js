// A visible banner for the things the panel must not fail silently about.
//
// Written for one specific failure and generalised no further than that. When the
// host refuses a request, every symptom the panel shows is a lie: /agentY/health
// is deliberately reachable without a token, so the panel reports the host as UP
// while every button does nothing. The refusal itself — which says exactly what
// happened and exactly what to do — went to the browser console, which is the one
// place someone using a ComfyUI sidebar is not looking.
//
// So the host's own words are put on the screen. Not a paraphrase: the server
// knows why it refused and this does not, and a banner that guessed would be
// wrong on the day it mattered.

const ID = "agentY-notice-host";
// One banner per distinct message. The panel polls, so a refusal that repeats
// would otherwise stack a new banner every second until the sidebar was a wall of
// identical warnings.
const shown = new Set();

function injectStyles() {
  if (document.getElementById("agentY-notice-styles")) return;
  const css = `
  #${ID}{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:10100;
    display:flex;flex-direction:column;gap:8px;max-width:min(560px,92vw);
    font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;pointer-events:none;}
  .ayn{pointer-events:auto;background:#2b2320;color:#f2f0ea;border:1px solid #d9775788;
    border-left:4px solid #d97757;border-radius:10px;padding:12px 14px;
    box-shadow:0 12px 40px rgba(0,0,0,.55);}
  .ayn-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px;}
  .ayn-head strong{font-size:13px;font-weight:650;color:#f0b49a;flex:1;}
  .ayn-x{background:none;border:none;color:#f2f0ea;opacity:.5;cursor:pointer;
    font-size:15px;line-height:1;padding:0 2px;}
  .ayn-x:hover{opacity:1;}
  .ayn-msg{font-size:12.5px;line-height:1.55;white-space:pre-wrap;}
  .ayn-foot{display:flex;gap:8px;margin-top:10px;}
  .ayn-btn{background:#d97757;color:#1b1b1a;border:none;border-radius:7px;
    padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer;}
  .ayn-btn.ghost{background:#3a3734;color:#f2f0ea;font-weight:500;}`;
  const tag = document.createElement("style");
  tag.id = "agentY-notice-styles";
  tag.textContent = css;
  document.head.append(tag);
}

function host() {
  let node = document.getElementById(ID);
  if (!node) {
    node = document.createElement("div");
    node.id = ID;
    // A refusal can happen on the panel's very first request, which is early
    // enough that document.body may not exist yet. Throwing here would swallow
    // the warning the same way the console did.
    (document.body || document.documentElement).append(node);
  }
  return node;
}

/**
 * Put a warning on screen. Repeats of the same message are ignored.
 *
 * @param {string} title    short heading, e.g. "agentY refused a request"
 * @param {string} message  the host's own explanation, shown verbatim
 * @param {{label:string,onClick:function}[]} [actions]
 */
export function showNotice(title, message, actions = []) {
  const key = `${title}\n${message}`;
  if (shown.has(key)) return;
  shown.add(key);
  injectStyles();

  const card = document.createElement("div");
  card.className = "ayn";

  const head = document.createElement("div");
  head.className = "ayn-head";
  const heading = document.createElement("strong");
  heading.textContent = `⚠️  ${title}`;
  const dismiss = document.createElement("button");
  dismiss.className = "ayn-x";
  dismiss.textContent = "✕";
  dismiss.title = "Dismiss";
  dismiss.addEventListener("click", () => {
    card.remove();
    // Dismissing forgets it, so the same fault can raise the banner again. A
    // warning you closed once should not be permanently silenced by that — you
    // dismissed a message, not the problem.
    shown.delete(key);
  });
  head.append(heading, dismiss);

  const body = document.createElement("div");
  body.className = "ayn-msg";
  body.textContent = message;

  card.append(head, body);

  if (actions.length) {
    const foot = document.createElement("div");
    foot.className = "ayn-foot";
    for (const [i, action] of actions.entries()) {
      const btn = document.createElement("button");
      btn.className = i === 0 ? "ayn-btn" : "ayn-btn ghost";
      btn.textContent = action.label;
      btn.addEventListener("click", action.onClick);
      foot.append(btn);
    }
    card.append(foot);
  }

  host().append(card);
}

/** Forget what has been shown, so the next occurrence raises a banner again. */
export function clearNotices() {
  shown.clear();
  const node = document.getElementById(ID);
  if (node) node.replaceChildren();
}
