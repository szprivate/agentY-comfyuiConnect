import { app } from "../../scripts/app.js";

// agentY Message-History Log Viewer launcher. The viewer itself is a
// self-contained page served by the agentY chat host
// (src/utils/agentY_server.py: GET /agentY/log_viewer), which reads
// .logs/message_history.log same-origin via GET /agentY/message_history. This
// module only opens it in a new tab so it can be reached from ComfyUI.
//
// Two entry points, both calling openLogViewer():
//   • a 📜 button in the chat panel's top bar (web/agent_chat.js), and
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

function openLogViewer() {
  window.open(backendBase() + "/agentY/log_viewer", "_blank", "noopener");
}

// Expose for the chat panel's 📜 button (web/agent_chat.js).
window.agentYOpenLogViewer = openLogViewer;

app.registerExtension({
  name: "agentY.logViewer",
  settings: [
    {
      id: "agentY.logViewer",
      name: "Message-history log viewer",
      category: ["agentY", "Application", "Log viewer"],
      tooltip: "Open the message-history log viewer (served by the agentY chat host)",
      defaultValue: "",
      type: (_name, _setter, _value) => {
        const btn = el("button", { textContent: "Open Log Viewer…" });
        btn.style.cssText =
          "background:#3b3936;color:#f2f0ea;border:1px solid rgba(240,235,225,.14);" +
          "border-radius:9px;padding:7px 14px;cursor:pointer;font-size:12.5px;";
        btn.addEventListener("click", (e) => { e.preventDefault(); openLogViewer(); });
        return btn;
      },
    },
  ],
});
