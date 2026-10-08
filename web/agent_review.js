import { app } from "../../scripts/app.js";

// agentY review node frontend.
//
// One node, two reviewers. With a person reviewing, the run stops here and the
// only setting that means anything is the question (`notes`). With the QA agent
// reviewing, every measured check applies. So the checks are shown only for the
// agent - a row of dropdowns under a human review would read as things that
// are being enforced, and none of them would be.

// The settings only the agent reviewer reads (REVIEW_AGENT_SETTINGS in __init__.py).
export const AGENT_SETTINGS = ["aspect_ratio", "resolution", "sharpness", "grain", "no_clipping",
                               "no_black_frames", "no_stalled_motion", "likeness", "retries"];

export function isAgentReviewer(value) {
  return String(value || "").trim().toLowerCase() === "agent";
}

/** Which of `names` are hidden for this reviewer. Pure. */
export function hiddenSettings(reviewer, names = AGENT_SETTINGS) {
  return isAgentReviewer(reviewer) ? [] : names.slice();
}

function getWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name) || null;
}

// The two node renderers each ask in their own place whether a widget is hidden:
// the classic canvas reads `widget.hidden`, Nodes 2.0 reads `options.hidden` -
// from the widget store's state, which is what it watches. Hidden is
// presentation only: the value still round-trips and still reaches the host.
function flagHidden(widget, hidden) {
  widget.hidden = hidden;
  const watched = widget._state && widget._state.options;
  if (watched) watched.hidden = hidden;
  if (widget.options && widget.options !== watched) widget.options.hidden = hidden;
}

function applyReviewer(node, resize) {
  const reviewer = (getWidget(node, "reviewer") || {}).value;
  const hide = new Set(hiddenSettings(reviewer));
  for (const name of AGENT_SETTINGS) {
    const w = getWidget(node, name);
    if (w) flagHidden(w, hide.has(name));
  }
  if (node.computeSize && node.size) {
    const floor = node.computeSize();
    // Shrink to fit when the checks go, grow when they come; never narrower.
    node.setSize([Math.max(node.size[0], floor[0]),
                  resize ? floor[1] : Math.max(node.size[1], floor[1])]);
  }
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "agentY.reviewNode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "AgentYReview") return;

    const configure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (info) {
      const r = configure ? configure.call(this, info) : undefined;
      applyReviewer(this, false);
      return r;
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      this.color = "#4a3a5c";
      this.bgcolor = "#30263a";
      if (!this.title || this.title === "AgentYReview") this.title = "agentY review";
      const reviewer = getWidget(this, "reviewer");
      if (reviewer) {
        const orig = reviewer.callback;
        const node = this;
        reviewer.callback = function (...args) {
          const rr = orig ? orig.apply(this, args) : undefined;
          applyReviewer(node, true);
          return rr;
        };
      }
      applyReviewer(this, true);
      return r;
    };
  },
});
