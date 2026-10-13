// agent_condition.js
// The `agentY condition` node shows its verdict on itself: after a run, the
// report - MET / NOT MET and each statement with the model's probability - is
// written into a read-only box under the inputs, so the answer is visible
// without wiring `report` into a preview node.
import { app } from "../../scripts/app.js";

const NODE = "AgentYCondition";
const FIELD = "verdict";

function verdictBox(node) {
  let widget = (node.widgets || []).find((w) => w.name === FIELD);
  if (widget) return widget;
  const box = document.createElement("textarea");
  box.readOnly = true;
  box.spellcheck = false;
  box.style.cssText = "width:100%;height:100%;resize:none;box-sizing:border-box;border:1px solid #444;"
    + "border-radius:4px;background:#161616;color:#ddd;font:11px/1.4 monospace;padding:4px 6px;";
  widget = node.addDOMWidget(FIELD, "agenty_condition_verdict", box, {
    getValue: () => box.value,
    setValue: (v) => { box.value = v == null ? "" : String(v); },
    getMinHeight: () => 70,
  });
  widget.serialize = false;                  // a result, not a setting: never saved with the graph
  widget.box = box;
  return widget;
}

app.registerExtension({
  name: "agentY.condition",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      try {
        const text = message && message.text ? [].concat(message.text).join("\n") : "";
        const widget = verdictBox(this);
        widget.box.value = text;
        const met = /^MET/.test(text);
        widget.box.style.borderColor = text ? (met ? "#3c9a5f" : "#b0483f") : "#444";
        this.setDirtyCanvas(true, true);
      } catch (e) {
        console.warn("[agentY condition] could not show the verdict", e);
      }
      return r;
    };
  },
});
