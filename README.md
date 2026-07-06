# agentY-comfyuiConnect

The **agentY UI for ComfyUI** — a custom node (frontend hooks + a server route,
**no graph nodes of its own**) that connects ComfyUI to the [agentY](https://github.com/szprivate/agentY)
agent. It has two parts:

1. **Chat sidebar** (`web/agent_chat.js`) — an **agentY** tab in ComfyUI's left
   sidebar. Chat with the agent, browse past conversations, run slash commands,
   and attach images. The agent's *text* streams into the panel; every generated
   **image/video is dropped onto the graph as a `LoadImage` / video-loader node**
   instead of being shown inline — ready to wire into your next workflow. It talks
   to the agentY chat host over HTTP + SSE (default `http://127.0.0.1:5000`).

2. **Auto-open canvas** (`web/agent_canvas.js`) — opens the workflow the agent
   just ran directly on the canvas, so you see exactly what it built.

> This node is only the **UI**. The agent itself runs as a separate process from
> the [agentY](https://github.com/szprivate/agentY) repo (`run_agent.ps1`, the
> headless chat host on `:5000`). Install this node **and** run that host.

---

## Install

Clone into ComfyUI's `custom_nodes/` and restart ComfyUI once:

```bash
cd <ComfyUI>/custom_nodes
git clone https://github.com/szprivate/agentY-comfyuiConnect.git
```

After the restart:
- the console prints `[agentY-comfyuiConnect] ready …`, and
- an **agentY** tab appears in ComfyUI's left sidebar.

Then start the agentY chat host (from the agentY repo): `./run_agent.ps1`.

## Configuration

- **Backend URL** — defaults to `http://<comfyui-host>:5000`. If the agentY host
  runs elsewhere, set it in the browser console:
  `localStorage.agentY_backend = "http://host:port"`.
- **Auto-open canvas** — on by default. Disable by setting
  `AGENTY_CANVAS_AUTOLOAD=0` for the agentY process.

## How the auto-open route works

- `__init__.py` registers `POST /agent/load_workflow`, which broadcasts the posted
  graph over the websocket as an `agent.load_workflow` event.
- `web/agent_canvas.js` listens for that event and calls `app.loadGraphData(graph)`.
- agentY's `open_workflow_in_canvas` tool converts the executed workflow to graph
  format and POSTs it to that route on every run.

## Requirements

- **ComfyUI** with the modern frontend (`app.extensionManager.registerSidebarTab`).
- The **agentY** backend running (`run_agent.ps1`).
- For **video** outputs, a video-loader node in your ComfyUI (e.g.
  [VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite)'s
  `VHS_LoadVideo`). Images use core `LoadImage` and always work.

## License

MIT
