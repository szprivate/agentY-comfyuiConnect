"""agentY-comfyuiConnect — canvas ↔ agent bridge.

Three responsibilities:

1. **Push** — the agentY pipeline POSTs a graph-format workflow to
   ``/agent/load_workflow``; this broadcasts it over the websocket and
   ``web/agent_canvas.js`` loads it onto the canvas, so the user sees exactly
   what the agent just ran without clicking.

2. **Hook node** — the ``AgentYHook`` node lets the user annotate any node's
   output with a natural-language directive ("sweep the seed", "iterate this
   folder"). It is a pure identity passthrough, so on a normal Queue Prompt it is
   never executed (ComfyUI only runs nodes on the path to an output node, and an
   unreferenced hook is skipped by validation/execution). When the user asks the
   agentY agent to run the on-canvas graph, ``web/agent_chat.js`` ships the
   captured API prompt + the hook directives and the pipeline expands them.

3. **Canvas selection** — ``/agent/canvas_selection`` (read) and
   ``/agent/set_node_params`` (write) let a caller *outside* the browser reach
   the litegraph selection: the request is relayed to the open page over the
   websocket and answered from there. The sidebar chat already ships its
   selection with every message; this is how the agentY **MCP** server (running
   under Claude, with no page of its own) sees the same thing.

The hook is a **V3** node so its ``anchor`` input can *auto-grow*: connect one
node and a fresh empty ``anchor`` slot appears, letting a single hook gather
several inputs (e.g. combine three images in a standin, or apply one directive
across two anchor nodes).
"""
import asyncio as _asyncio
import json as _json
import os as _os
import re as _re
import subprocess as _subprocess
import sys as _sys
import uuid as _uuid
from pathlib import Path as _Path

from aiohttp import web

# Where this extension records the agentY host's location, so the sidebar's
# "Start server" button can relaunch ``run_agent.ps1`` when the host on :5000 is
# down (a browser can't spawn a process, but this ComfyUI-side route can). The
# file is written by the agentY host on startup (self-registration) and by
# ``install_agent.ps1``; it's gitignored (machine-specific path).
_EXT_DIR = _os.path.dirname(_os.path.abspath(__file__))
_HOST_CFG = _os.path.join(_EXT_DIR, ".agenty_host.json")

# Native OS file-picker helper for the agentY collector nodes. Run as a
# subprocess (under ComfyUI's own Python, which has tkinter) so the Tk dialog
# never touches the aiohttp event loop. See ``_agent_pick_files`` below.
_PICKER = _os.path.join(_EXT_DIR, "_filepicker.py")
_PICK_IMG_EXTS = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff"}
_PICK_VID_EXTS = {"mp4", "mov", "webm", "mkv", "avi", "m4v", "mpg", "mpeg"}


def _read_host_cfg():
    """Resolve (project_root, run_script) for the agentY host. ``AGENTY_ROOT`` env
    wins; otherwise the recorded ``.agenty_host.json``. Returns ("", script) when
    unknown."""
    script = "run_agent.ps1"
    root = (_os.environ.get("AGENTY_ROOT") or "").strip()
    if not root and _os.path.isfile(_HOST_CFG):
        try:
            with open(_HOST_CFG, "r", encoding="utf-8") as _fh:
                data = _json.load(_fh)
            root = str(data.get("project_root", "")).strip()
            script = str(data.get("run_script", script)).strip() or script
        except Exception:  # noqa: BLE001
            pass
    return root, script


try:
    from server import PromptServer
    _routes = PromptServer.instance.routes

    @_routes.post("/agent/load_workflow")
    async def _agent_load_workflow(request):  # noqa: ANN001
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
        graph = data.get("workflow", data) if isinstance(data, dict) else None
        if not isinstance(graph, dict) or "nodes" not in graph:
            return web.json_response({"ok": False, "error": "not a graph workflow"}, status=400)
        # Broadcast to every connected ComfyUI frontend (sid=None => all).
        PromptServer.instance.send_sync("agent.load_workflow", graph)
        return web.json_response({"ok": True, "nodes": len(graph.get("nodes", []))})

    @_routes.post("/agent/register_host")
    async def _agent_register_host(request):  # noqa: ANN001
        """The agentY host tells us where it lives (so we can relaunch it later)."""
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
        root = str((data or {}).get("project_root", "")).strip()
        script = str((data or {}).get("run_script", "run_agent.ps1")).strip() or "run_agent.ps1"
        if not root or not _os.path.isdir(root):
            return web.json_response({"ok": False, "error": "project_root is not a directory"}, status=400)
        try:
            with open(_HOST_CFG, "w", encoding="utf-8") as _fh:
                _json.dump({"project_root": root, "run_script": script}, _fh, indent=2)
        except Exception as _exc:  # noqa: BLE001
            return web.json_response({"ok": False, "error": str(_exc)}, status=500)
        return web.json_response({"ok": True})

    @_routes.post("/agent/start_host")
    async def _agent_start_host(request):  # noqa: ANN001
        """Launch run_agent.ps1 in a new console so the sidebar can start the host."""
        root, script = _read_host_cfg()
        if not root:
            return web.json_response(
                {"ok": False, "error": "agentY location unknown — run run_agent.ps1 once, "
                                       "or set the AGENTY_ROOT environment variable."}, status=409)
        script_path = _os.path.join(root, script)
        if not _os.path.isfile(script_path):
            return web.json_response({"ok": False, "error": f"{script} not found under {root}"}, status=404)
        if _sys.platform != "win32":
            return web.json_response(
                {"ok": False, "error": "auto-start is Windows-only; run the script manually."}, status=400)
        try:
            _CREATE_NEW_CONSOLE = 0x00000010
            _subprocess.Popen(
                ["powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", script_path],
                cwd=root, creationflags=_CREATE_NEW_CONSOLE, close_fds=True,
            )
        except Exception as _exc:  # noqa: BLE001
            return web.json_response({"ok": False, "error": str(_exc)}, status=500)
        return web.json_response({"ok": True, "root": root, "script": script})

    @_routes.post("/agent/pick_files")
    async def _agent_pick_files(request):  # noqa: ANN001
        """Open a native OS file/folder dialog on the ComfyUI host and return the
        chosen absolute paths — the backend picker for the agentY collector nodes.

        The browser can't read a file's real filesystem path, so the collector
        nodes call this instead: it launches ``_filepicker.py`` as a subprocess
        (a fresh Tk dialog per call, off the event loop) and returns true on-disk
        paths, no copying. ``kind`` filters image vs video; ``mode`` picks files
        or a whole folder (folder is expanded to its matching media here).
        """
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            data = {}
        kind = str((data or {}).get("kind", "image")).lower()
        if kind not in ("image", "video"):
            kind = "image"
        mode = str((data or {}).get("mode", "files")).lower()
        if mode not in ("files", "folder"):
            mode = "files"
        if not _os.path.isfile(_PICKER):
            return web.json_response({"ok": False, "error": "picker helper missing"}, status=500)
        try:
            proc = await _asyncio.create_subprocess_exec(
                _sys.executable, _PICKER, kind, mode,
                stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.PIPE,
                cwd=_EXT_DIR,
            )
            out, _err = await proc.communicate()
        except Exception as _exc:  # noqa: BLE001
            return web.json_response({"ok": False, "error": str(_exc)}, status=500)
        raw = (out or b"").decode("utf-8", "replace").strip()
        try:
            parsed = _json.loads(raw) if raw else []
        except Exception:  # noqa: BLE001
            return web.json_response(
                {"ok": False, "error": f"picker returned unparseable output: {raw[:200]!r}"},
                status=500)
        # The helper emits {"error": ...} when Tk is unavailable, else a JSON list.
        if isinstance(parsed, dict) and parsed.get("error"):
            return web.json_response({"ok": False, "error": str(parsed["error"])}, status=500)
        paths = parsed if isinstance(parsed, list) else []
        if mode == "folder" and paths:
            exts = _PICK_VID_EXTS if kind == "video" else _PICK_IMG_EXTS
            folder = paths[0]
            expanded: list = []
            try:
                for name in sorted(_os.listdir(folder)):
                    full = _os.path.join(folder, name)
                    if _os.path.isfile(full) and name.rsplit(".", 1)[-1].lower() in exts:
                        expanded.append(full)
            except Exception:  # noqa: BLE001
                expanded = []
            paths = expanded
        paths = [p for p in paths if isinstance(p, str) and _os.path.isfile(p)]
        return web.json_response({"ok": True, "paths": paths, "kind": kind})

    @_routes.post("/agent/reset_collector_cursor")
    async def _agent_reset_collector_cursor(request):  # noqa: ANN001
        """Reset a collector node's incremental-load cursor to the first file.

        Called by the collector frontend from a one-shot patch on the Queue button
        (``app.queuePrompt``), which fires exactly once per click — so a Queue with
        batch count > 1 resets the cursor once, then steps through the batch from
        the top. The cursor dict lives in this same module/process, so this mutates
        exactly what the node's ``execute`` reads."""
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            data = {}
        ids: list = []
        if isinstance(data, dict):
            if data.get("node_id") is not None:
                ids.append(data["node_id"])
            raw = data.get("node_ids")
            if isinstance(raw, list):
                ids.extend(raw)
        for nid in ids:
            _reset_incr_index(nid)  # defined later in this module; resolved at call time
        return web.json_response({"ok": True, "reset": [str(i) for i in ids]})

    # ── Canvas selection bridge ───────────────────────────────────────────────
    # Which nodes are selected — and what their widgets currently say — exists
    # only inside the browser (litegraph state, never serialized to the server).
    # The sidebar chat ships that snapshot along with each message, so the agentY
    # host sees it; anything *outside* the page — the agentY MCP server running
    # under Claude, a script — could not.
    #
    # These routes borrow the frontend as the source of truth: a request here
    # goes out over the ComfyUI websocket, ``web/agent_canvas.js`` answers it by
    # POSTing back to /agent/canvas_reply, and the pending request resolves with
    # that answer. Nothing is cached on purpose — a remembered selection is worse
    # than an honest "no browser answered", since the entire question is what is
    # selected *right now*. With several ComfyUI tabs open the first reply wins.
    _pending_replies: dict = {}   # req_id -> asyncio.Future awaiting the frontend
    _REPLY_TIMEOUT = 3.0          # seconds; a backgrounded tab still answers this fast

    async def _ask_frontend(event: str, payload: dict, timeout: float):
        """Broadcast ``event`` to every open ComfyUI page and wait for one reply.

        Returns the reply dict, or None if nobody answered in time (no page open,
        or an old extension build with no listener for this event)."""
        req_id = _uuid.uuid4().hex[:12]
        fut = _asyncio.get_running_loop().create_future()
        _pending_replies[req_id] = fut
        try:
            PromptServer.instance.send_sync(event, dict(payload, req_id=req_id))
            return await _asyncio.wait_for(fut, timeout)
        except _asyncio.TimeoutError:
            return None
        finally:
            _pending_replies.pop(req_id, None)

    def _clamp_timeout(request) -> float:  # noqa: ANN001
        try:
            return max(0.2, min(float(request.query.get("timeout", _REPLY_TIMEOUT)), 15.0))
        except (TypeError, ValueError):
            return _REPLY_TIMEOUT

    @_routes.post("/agent/canvas_reply")
    async def _agent_canvas_reply(request):  # noqa: ANN001
        """The frontend answering a pending /agent/canvas_* request."""
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
        fut = _pending_replies.get(str((data or {}).get("req_id", "")))
        if fut is None or fut.done():
            # Already answered by another tab, or the waiter timed out. Harmless.
            return web.json_response({"ok": True, "accepted": False})
        fut.set_result(data)
        return web.json_response({"ok": True, "accepted": True})

    @_routes.get("/agent/canvas_selection")
    async def _agent_canvas_selection(request):  # noqa: ANN001
        """Live read of the nodes selected on the canvas, with their widget values.

        Answers 200 with ``ok: false`` when no page replies — that is a state of
        the world (ComfyUI not open), not a server fault, and callers using a
        raise-on-status HTTP client need to read the reason."""
        reply = await _ask_frontend("agent.request_selection", {}, _clamp_timeout(request))
        if reply is None:
            return web.json_response({
                "ok": False, "nodes": [], "count": 0,
                "error": "no ComfyUI browser page answered — open ComfyUI in a browser "
                         "(a background tab is fine). If it is open, its agentY extension "
                         "is older than this route; reload the page.",
            })
        nodes = [n for n in (reply.get("nodes") or []) if isinstance(n, dict)]
        return web.json_response({"ok": True, "count": len(nodes), "nodes": nodes,
                                  "workflow": str(reply.get("workflow") or "")})

    @_routes.post("/agent/set_node_params")
    async def _agent_set_node_params(request):  # noqa: ANN001
        """Write widget values onto a node of the live graph (no reload, no re-queue).

        The counterpart to the read above: same websocket round trip, and the
        frontend reports back which widgets it actually found on the node."""
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
        node_id = str((data or {}).get("node_id", "")).strip()
        params = (data or {}).get("params")
        if not node_id:
            return web.json_response({"ok": False, "error": "node_id is required"}, status=400)
        if not isinstance(params, dict) or not params:
            return web.json_response(
                {"ok": False, "error": "params must be a non-empty {widget: value} mapping"},
                status=400)
        reply = await _ask_frontend("agent.set_node_params",
                                    {"node_id": node_id, "params": params},
                                    _clamp_timeout(request))
        if reply is None:
            return web.json_response({
                "ok": False, "applied": [],
                "error": "no ComfyUI browser page answered — nothing was changed.",
            })
        return web.json_response({
            "ok": bool(reply.get("ok", True)),
            "applied": [str(a) for a in (reply.get("applied") or [])],
            "unknown": [str(u) for u in (reply.get("unknown") or [])],
            "node": str(reply.get("node") or ""),
            "error": str(reply.get("error") or ""),
        })

    print("[agentY-comfyuiConnect] registered /agent routes "
          "(load_workflow, register_host, start_host, pick_files, reset_collector_cursor, "
          "canvas_selection, set_node_params)")
except Exception as _e:  # noqa: BLE001
    # Never break ComfyUI startup if the server API shape changes.
    print(f"[agentY-comfyuiConnect] could not register /agent routes: {_e}")


from comfy_api.latest import ComfyExtension, io

# Cap on how many anchor slots one hook can grow to. 20 is plenty for "combine
# these N inputs" while keeping the node from ballooning; ``min=0`` lets an
# unwired hook (a global directive or a text-to-media standin) stay valid.
_MAX_ANCHORS = 20


class AgentYHook(io.ComfyNode):
    """An agent instruction attached to the canvas. Three purposes:

    * ``inline_parameter`` (default) — annotate an upstream node's output. Wire an
      ``anchor`` input from any node's output and type a directive (e.g. "create
      prompt variations", "sweep the seed 6×", "iterate the files in this
      folder"). When the agentY agent runs the on-canvas graph, it applies the
      directive to the anchored node(s) and runs the expanded batch.
    * ``make_workflow`` — the hook stands in for a workflow or Python script
      the agent generates from the ``directive`` field (used here as a prompt).
      The agent generates it, runs it (using the wired ``anchor`` output(s) as
      input if any are connected, else treating the prompt as text-to-media), and
      stages the result onto the canvas as loader nodes.
    * ``text`` — the hook asks the agent for a **written text answer** (no media,
      no workflow): the ``directive`` is the request (e.g. "write a caption for
      this image", "summarise the wired prompt"). The agent writes the answer and
      drops an ``agentY text`` node on the canvas carrying it, wired where this
      hook's output went — so downstream nodes (or the next hook stage) consume
      the string on a normal run. Any wired ``anchor`` is context for the answer.
    * ``general_request`` — a **free-form** instruction: the agent treats the
      ``directive`` as an ordinary request (with any wired ``anchor`` as the provided
      input/context and this graph already captured) and decides the right action
      itself — answer, generate or edit media, run a workflow, compute a value. Use
      it when the task doesn't fit the more specific purposes; media results stage
      onto the canvas, a single produced value goes to the wired target, and a plain
      question is answered in chat.
    * ``iterate`` — turns this graph into an **interactive refinement loop**: the
      agent runs it ONE generation per turn and feeds each result back in as the
      next input, so you refine an image step by step in chat. Wire this hook's
      **output into the prompt node's text input** (where each prompt you type in
      chat is written) and wire the **LoadImage node's image output into an
      anchor** (the node whose image the agent replaces with the running result).
      Each turn you give the next prompt; the agent runs the graph, updates that
      LoadImage in place, and asks for the next step. You can jump back to an
      earlier generation ("go back to the original", "back to generation 3, then …")
      and keep going until you say stop. Requires a save node that writes to
      ComfyUI's history (e.g. a SaveImage, or the bEpic viewer with
      ``save_to_output`` ON) so the agent can fetch each result to feed forward.
    * ``qa`` — this hook is not work, it is your **quality briefing** for the graph.
      The ``directive`` is the checklist ("skin tones warm, not orange"; "hands have
      five fingers") and the wired ``anchors`` are **reference / mood images** the
      output should sit beside without looking out of place. After a run, a separate
      QA agent judges every produced image/video against it, criterion by criterion,
      and a failing output is re-generated against exactly what it missed (bounded
      by ``qa.max_retries`` in agentY settings). Wiring the references here is what
      makes them references rather than inputs to the workflow — the anchor is the
      statement. Cite a shared briefing from ``config/qa/`` with ``@name``.

    The ``anchor`` **input** auto-grows: each time you wire one, a new empty slot
    appears, so a single hook can gather several inputs (e.g. combine three images
    in a standin, or apply one directive across two anchor nodes). The single
    ``out`` **output** carries any type (image, video, string / int / float); a
    stage that yields several results forwards them all to the next hook via the
    agent, not via several slots.

    ``bake_to_canvas`` (make_workflow only) — when on, the agent doesn't just
    run the workflow it generates for this hook: it nests that workflow into a
    ComfyUI **subgraph**, exposes inputs/outputs matching this hook's slots, drops
    the subgraph onto the same canvas, and wires the subgraphs to mirror the hook
    chain — "baking" the multi-step task into a reusable native workflow that runs
    next time without the agent.

    ``freeze`` (inline_parameter / text hooks) — controls what the agent does with the
    value it produces for this hook. OFF (default) *keeps the hook live*: the hook
    stays wired exactly as drawn, the agent injects the produced value into the
    graph at run time, and the ``agentY text`` node it drops is left UNCONNECTED as
    a human-readable reference. ON *freezes* the value into the graph: the agent
    bakes the ``agentY text`` node into the wired target input and takes over the
    hook's downstream link, yielding a self-contained plain workflow you can re-run
    yourself without the agent (at the cost of bypassing the hook).

    To disable a hook without deleting it, **bypass it** (Ctrl+B) or mute it
    (Ctrl+M) like any other node — the agent skips hooks in those modes. There is
    no separate ``ignore`` toggle: one gesture, the standard ComfyUI one, and it
    reads off the canvas at a glance.

    On a normal ComfyUI Queue the node is always inert: it's an identity
    passthrough that nothing downstream needs, so it is never executed.
    Recommended usage: wire only the ``anchor`` inputs and leave the output
    unwired (the node is then pruned entirely on a normal run). Splicing it inline
    also works — the agent removes it from the graph before running, and the
    ``out`` output forwards the first connected anchor.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        anchors = io.Autogrow.TemplatePrefix(
            input=io.AnyType.Input("anchor"),
            prefix="anchor",
            min=0,
            max=_MAX_ANCHORS,
        )
        return io.Schema(
            node_id="AgentYHook",
            display_name="agentY hook",
            category="agentY",
            description=(
                "Attach an agent instruction to the canvas. As an 'inline_parameter' it annotates a "
                "node's output; as a 'make_workflow' it stands in for a workflow/script "
                "the agent generates from the prompt; as 'text' it asks for a written answer "
                "the agent drops on the canvas as a wireable 'agentY text' node. The 'anchor' "
                "input auto-grows, so one hook can gather several inputs. Bypass (Ctrl+B) or "
                "mute it to disable it. Inert on a normal run; acted on by the agentY agent "
                "when it runs the graph."
            ),
            inputs=[
                io.String.Input(
                    "directive",
                    multiline=True,
                    default="",
                    placeholder=(
                        "inline_parameter: e.g. sweep the seed, 6 variations  •  "
                        "make_workflow: e.g. upscale 2x and add film grain  •  "
                        "text: e.g. write a caption for this image"
                    ),
                ),
                io.Combo.Input(
                    "purpose",
                    options=["inline_parameter", "make_workflow", "text", "general_request",
                             "iterate", "qa"],
                    default="inline_parameter",
                ),
                io.Boolean.Input(
                    "bake_to_canvas",
                    default=False,
                    label_on="bake subgraph",
                    label_off="run only",
                    tooltip=(
                        "make_workflow only: also bake the generated workflow onto the "
                        "canvas as a nested subgraph wired to mirror the hook chain."
                    ),
                ),
                io.Boolean.Input(
                    "freeze",
                    default=False,
                    label_on="freeze into graph",
                    label_off="keep hook live",
                    tooltip=(
                        "text / inline_parameter hooks: OFF (default) keeps the hook wired as you "
                        "drew it and drops the 'agentY text' node UNCONNECTED as a reference "
                        "— the agent injects the produced value into the graph at run time. ON "
                        "bakes the 'agentY text' node into the wired target input, bypassing "
                        "the hook, so you get a self-contained plain workflow you can re-run "
                        "yourself without the agent."
                    ),
                ),
                io.Autogrow.Input("anchors", template=anchors),
            ],
            outputs=[
                # A single type-agnostic output. Wire it to the next hook's anchor
                # to chain stages; the link marks the dependency. A stage that
                # produces SEVERAL results doesn't need several slots — the agent
                # forwards every produced file/value to the next stage from the
                # run_workflow_now result, and a baked subgraph's output count comes
                # from the agent's exposed-outputs spec, not from this slot.
                io.AnyType.Output(display_name="out"),
            ],
        )

    @classmethod
    def execute(cls, directive="", purpose="inline_parameter",
                bake_to_canvas=False, freeze=False, anchors=None) -> io.NodeOutput:  # noqa: ANN001, ARG003
        # Pure identity passthrough — only ever runs if spliced inline, in which
        # case it must not alter the data flowing through it. With several anchors
        # wired, forward the first connected one (lowest slot index).
        anchors = anchors or {}
        first = next(iter(anchors.values()), None)
        return io.NodeOutput(first)


# Number of (fixed) output slots on the Python node. Executable nodes can't
# auto-grow outputs (the count is fixed at registration), so we declare a small
# set of any-type outs; a snippet typically fills just out0.
_N_PY_OUT = 4


class AgentYPython(io.ComfyNode):
    """Run an agent-authored Python snippet as a real ComfyUI node.

    This is the companion to ``bake_to_canvas``: at runtime the orchestrator
    computes derived values (e.g. a video's length) with a Python script; to make
    such a value a **native** output of a baked subgraph — so re-running the
    workflow reproduces it *without the agent* — the same snippet is placed in this
    node. The bake step wires the relevant inner outputs into this node's inputs
    and exposes its output as a subgraph output.

    Contract: the ``in`` input auto-grows (in0, in1, … — any type). The snippet
    runs with those bound as ``in0``, ``in1``, … and as a list ``inputs``; assign
    a list named ``outputs`` (``outputs[0]`` → this node's first output slot, etc.).

    SECURITY: this executes arbitrary Python embedded in the workflow whenever the
    graph runs. It is intended for your own, self-hosted, agent-built workflows —
    do NOT run baked workflows from untrusted sources. Set the env var
    ``AGENTY_PYTHON_NODE_DISABLED=1`` to make the node a no-op (returns Nones).
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        ins = io.Autogrow.TemplatePrefix(
            input=io.AnyType.Input("in"), prefix="in", min=0, max=_MAX_ANCHORS,
        )
        return io.Schema(
            node_id="AgentYPython",
            display_name="agentY python",
            category="agentY",
            description=(
                "Run an agent-authored Python snippet as a node (used when baking computed "
                "values into subgraphs). Inputs bind as in0, in1, …; set a list `outputs`. "
                "Executes arbitrary Python on run — self-hosted, agent-built workflows only."
            ),
            inputs=[
                io.String.Input(
                    "code",
                    multiline=True,
                    default="# inputs bound as in0, in1, …  |  set: outputs = [value, …]\noutputs = []",
                    placeholder="outputs = [ ... ]",
                ),
                io.Autogrow.Input("inputs", template=ins),
            ],
            outputs=[io.AnyType.Output(display_name=f"out{i}") for i in range(_N_PY_OUT)],
        )

    @classmethod
    def execute(cls, code="", inputs=None) -> io.NodeOutput:  # noqa: ANN001
        import os
        import builtins
        if os.environ.get("AGENTY_PYTHON_NODE_DISABLED") in ("1", "true", "True"):
            return io.NodeOutput(*([None] * _N_PY_OUT))
        vals = list((inputs or {}).values())
        ns: dict = {"__builtins__": builtins, "inputs": vals, "outputs": []}
        for i, v in enumerate(vals):
            ns[f"in{i}"] = v
        try:
            exec(code or "", ns)  # noqa: S102 — deliberate; see SECURITY note above
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"AgentYPython snippet error: {exc}") from exc
        outs = ns.get("outputs")
        outs = list(outs) if isinstance(outs, (list, tuple)) else [outs]
        outs = outs[:_N_PY_OUT] + [None] * (_N_PY_OUT - len(outs))
        return io.NodeOutput(*outs)


class AgentYText(io.ComfyNode):
    """A string the agent wrote, living on the canvas as a wireable node.

    Companion to ``AgentYHook``'s ``text`` purpose: when the agent answers a text
    hook, it places one of these carrying the answer and wires its ``STRING``
    output where the hook's output went, so downstream nodes (or the next hook
    stage) consume the string on a normal run — the value is baked into the graph
    and reproduced without the agent. Its ``text`` widget is a plain multiline
    string the user can also edit by hand.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYText",
            display_name="agentY text",
            category="agentY",
            description=(
                "A string the agent wrote (answering a 'text' hook), wireable into any "
                "STRING input. Editable by hand; emits its text on a normal run."
            ),
            inputs=[
                io.String.Input("text", multiline=True, default=""),
            ],
            outputs=[
                io.String.Output(display_name="text"),
            ],
        )

    @classmethod
    def execute(cls, text="") -> io.NodeOutput:  # noqa: ANN001
        return io.NodeOutput(text)


# ── file collector nodes ──────────────────────────────────────────────────────
# Two nodes that gather files from disk (via the native picker, /agent/pick_files)
# into a single node. The collected list is stored as the ``files`` widget — plain
# node data serialized into the workflow — so the agentY agent can read every path
# BEFORE any run (unlike a runtime IMAGE batch tensor, which only exists after
# execution). That's what makes a batch of inputs understandable to the agent with
# no pre-run. The nodes double as ordinary input nodes: the image collector emits a
# stacked IMAGE batch, the video collector a list of VIDEOs, plus a paths STRING.

_COLLECT_IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff")
_COLLECT_VID_EXTS = (".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg")


def _collector_paths(files: str, exts: tuple) -> list[str]:
    """Parse the ``files`` widget (one absolute path per line) into an ordered,
    de-duplicated list of existing files of the wanted kind."""
    out: list[str] = []
    seen: set = set()
    for line in (files or "").splitlines():
        p = line.strip().strip('"')
        if not p or p in seen:
            continue
        seen.add(p)
        if exts and not p.lower().endswith(exts):
            continue
        if _os.path.isfile(p):
            out.append(p)
    return out


# ── incremental-load cursor ───────────────────────────────────────────────────
# When a collector's ``load_incrementally`` toggle is ON it emits only ONE file
# per Queue Prompt, stepping through the list. The cursor is kept here, keyed by
# the node's canvas ``unique_id``, and advanced once per execution. It lives in
# memory only (an "internal counter"): it resets on a ComfyUI restart, and a
# normal (non-incremental) run of the same node clears it so the next incremental
# session starts from the first file again.
_COLLECTOR_INCR_INDEX: dict[str, int] = {}


def _incr_index(node_id, count: int) -> int:
    """Return the current 0-based cursor for *node_id* (wrapping at *count*), then
    advance it by one. ``count <= 0`` yields 0."""
    if count <= 0:
        return 0
    key = str(node_id)
    cur = _COLLECTOR_INCR_INDEX.get(key, 0) % count
    _COLLECTOR_INCR_INDEX[key] = cur + 1
    return cur


def _reset_incr_index(node_id) -> None:
    """Forget a node's cursor — called on a non-incremental run, and by the
    ``/agent/reset_collector_cursor`` route when the reset toggle is armed."""
    _COLLECTOR_INCR_INDEX.pop(str(node_id), None)


def _uid(cls) -> str | None:
    """The collector node's canvas unique_id (declared as a hidden input), or None."""
    h = getattr(cls, "hidden", None)
    return getattr(h, "unique_id", None) if h is not None else None


def _collector_progress(node_id, msg: str) -> None:
    """Best-effort node status text (e.g. "3/12 photo.png") for the incremental
    cursor. No-op if the PromptServer isn't importable."""
    if not node_id:
        return
    try:
        from server import PromptServer
        PromptServer.instance.send_progress_text(msg, node_id)
    except Exception:  # noqa: BLE001
        pass


def _load_incrementally_input(kind: str):
    """The shared ``load_incrementally`` toggle for the collector nodes."""
    return io.Boolean.Input(
        "load_incrementally",
        default=False,
        label_on="one per queue",
        label_off="all at once",
        tooltip=(
            f"OFF (default): emit every collected {kind} on each run. ON: emit just "
            f"one {kind} per Queue Prompt, advancing an internal cursor each queue so "
            "repeated queues (or a batch count) step through the list one at a time. "
            "The cursor wraps at the end; a normal (all-at-once) run resets it to the "
            "first file. Does not affect what the agentY agent sees — it always reads "
            "the full path list."
        ),
    )


def _apply_incremental(cls, paths: list, load_incrementally: bool) -> list:
    """In incremental mode, narrow *paths* to the single file at the node's current
    cursor (then advance it) and post a "N/total name" status. Otherwise clear the
    cursor and return *paths* unchanged."""
    node_id = _uid(cls)
    if load_incrementally and paths:
        idx = _incr_index(node_id, len(paths))
        chosen = paths[idx]
        _collector_progress(node_id, f"{idx + 1}/{len(paths)}\n{_os.path.basename(chosen)}")
        return [chosen]
    _reset_incr_index(node_id)
    return paths


class AgentYImageCollector(io.ComfyNode):
    """Gather image files from disk into one node — an agent-friendly input batch.

    Click **Add images…** (or **Add folder…**) to open a native OS file dialog and
    pick images from anywhere on disk; the absolute paths accumulate in the ``files``
    box (one per line — editable/pasteable by hand). Because that list is node data,
    the agentY agent sees every image the moment the collector is wired to an
    ``agentY hook`` — no Queue Prompt needed. Outputs a stacked ``IMAGE`` batch —
    every frame is uniformly scaled to cover a max(width) x max(height) canvas and
    centre-cropped (aspect ratio preserved, never distorted) — plus the
    newline-joined ``paths`` string.

    Toggle **load_incrementally** to emit just ONE image per Queue Prompt instead of
    the whole batch, stepping through the list on successive queues (see the toggle's
    tooltip).
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYImageCollector",
            display_name="agentY image collector",
            category="agentY",
            description=(
                "Collect image files from disk (native picker) into one node. The path "
                "list is node data, so the agentY agent can read every image with no "
                "pre-run when the node is wired to an agentY hook. Emits a stacked IMAGE "
                "batch + a paths string for normal runs (or one image per queue when "
                "load_incrementally is on)."
            ),
            inputs=[
                io.String.Input(
                    "files",
                    multiline=True,
                    default="",
                    placeholder="one absolute image path per line — use 'Add images...' to pick",
                ),
                _load_incrementally_input("image"),
            ],
            outputs=[
                io.Image.Output(display_name="images"),
                io.String.Output(display_name="paths"),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, files="", load_incrementally=False):  # noqa: ANN001, N805
        # Incremental mode must re-run on every queue so the cursor advances — NaN
        # is never equal to itself, so ComfyUI always re-executes. Otherwise fall
        # back to ordinary content caching (re-run only when the path list changes).
        return float("nan") if load_incrementally else files

    @classmethod
    def execute(cls, files="", load_incrementally=False) -> io.NodeOutput:  # noqa: ANN001
        import numpy as np
        import torch
        from PIL import Image as _PILImage, ImageOps as _ImageOps

        paths = _collector_paths(files, _COLLECT_IMG_EXTS)
        paths = _apply_incremental(cls, paths, load_incrementally)
        loaded: list = []
        for p in paths:
            try:
                im = _PILImage.open(p)
                loaded.append(_ImageOps.exif_transpose(im).convert("RGB"))
            except Exception as exc:  # noqa: BLE001
                print(f"[agentY image collector] skipping {p}: {exc}")
        if loaded:
            # A ComfyUI IMAGE batch needs a uniform H x W. Use a canvas of
            # max(width) x max(height) across the set, then fit each frame into it
            # by scaling UNIFORMLY to cover and centre-cropping the overflow —
            # aspect ratio is always preserved (never stretched); cropping absorbs
            # the mismatch. ImageOps.fit does exactly this cover+crop.
            canvas_w = max(im.width for im in loaded)
            canvas_h = max(im.height for im in loaded)
            arrs = [
                np.asarray(
                    _ImageOps.fit(im, (canvas_w, canvas_h),
                                  method=_PILImage.LANCZOS, centering=(0.5, 0.5)),
                    dtype=np.float32,
                ) / 255.0
                for im in loaded
            ]
            batch = torch.from_numpy(np.stack(arrs, axis=0))
        else:
            # No valid images — a 1x64x64 black frame keeps a normal run from crashing.
            batch = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        return io.NodeOutput(batch, "\n".join(paths))


class AgentYVideoCollector(io.ComfyNode):
    """Gather video files from disk into one node — an agent-friendly input set.

    Like the image collector, but for video: **Add videos…** / **Add folder…** open
    a native OS dialog filtered to video files, and the absolute paths accumulate in
    the ``files`` box. The agentY agent reads the paths with no pre-run when the node
    is wired to an ``agentY hook``. Outputs a **list** of ``VIDEO`` objects (one per
    file, for normal runs) plus the newline-joined ``paths`` string.

    Toggle **load_incrementally** to emit just ONE video per Queue Prompt instead of
    the whole list, stepping through the files on successive queues (see the toggle's
    tooltip).
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYVideoCollector",
            display_name="agentY video collector",
            category="agentY",
            description=(
                "Collect video files from disk (native picker) into one node. The path "
                "list is node data, so the agentY agent can read every video with no "
                "pre-run when the node is wired to an agentY hook. Emits a list of VIDEO "
                "objects + a paths string for normal runs (or one video per queue when "
                "load_incrementally is on)."
            ),
            inputs=[
                io.String.Input(
                    "files",
                    multiline=True,
                    default="",
                    placeholder="one absolute video path per line — use 'Add videos...' to pick",
                ),
                _load_incrementally_input("video"),
            ],
            outputs=[
                io.Video.Output(display_name="videos", is_output_list=True),
                io.String.Output(display_name="paths"),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, files="", load_incrementally=False):  # noqa: ANN001, N805
        # See AgentYImageCollector.fingerprint_inputs — NaN forces a re-run each
        # queue in incremental mode; otherwise cache on the path-list contents.
        return float("nan") if load_incrementally else files

    @classmethod
    def execute(cls, files="", load_incrementally=False) -> io.NodeOutput:  # noqa: ANN001
        paths = _collector_paths(files, _COLLECT_VID_EXTS)
        paths = _apply_incremental(cls, paths, load_incrementally)
        videos: list = []
        try:
            from comfy_api.latest import VideoFromFile
            for p in paths:
                try:
                    videos.append(VideoFromFile(p))
                except Exception as exc:  # noqa: BLE001
                    print(f"[agentY video collector] could not load {p}: {exc}")
        except Exception as exc:  # noqa: BLE001
            print(f"[agentY video collector] VIDEO type unavailable ({exc}); paths only")
        return io.NodeOutput(videos, "\n".join(paths))


# ── per-project memory ────────────────────────────────────────────────────────
# The store is a folder inside ComfyUI's user directory: one fact per file, the
# type is the folder, the name is the filename. The agentY host reaches the same
# folder by asking the running server where its user directory is, so a project
# switch (which moves --user-directory, along with input/output) moves the memory
# with it. These two nodes are the graph's way in — a graph can read a locked
# character prompt, or record one, with no agent in the loop at all.
_PM_PARTS = ("agentY", "project")
_PM_TYPES = ["technical", "character", "style", "reference", "note"]


def _pm_dir(create: bool = False):
    """The project store under ComfyUI's user directory, or None if unavailable."""
    try:
        import folder_paths
        d = _Path(folder_paths.get_user_directory()).joinpath(*_PM_PARTS)
    except Exception:  # noqa: BLE001
        return None
    if create:
        try:
            d.mkdir(parents=True, exist_ok=True)
        except Exception:  # noqa: BLE001
            return None
    return d


def _pm_slug(name: str) -> str:
    """Same normalisation the host uses, so both sides agree on what a name is."""
    return _re.sub(r"[^a-z0-9]+", "-", str(name or "").strip().lower()).strip("-")


def _pm_find(key: str):
    """Path of the entry named *key*, whatever type it was filed under."""
    d = _pm_dir()
    if d is None or not d.is_dir() or not key:
        return None
    for f in sorted(d.glob("*/*.md")):
        if f.stem == key:
            return f
    return None


class AgentYProjectMemoryGet(io.ComfyNode):
    """Read a fact from this project's memory into the graph, as a string.

    The project's memory holds what the production has established — a character's
    prompt, the grade, a delivery spec — beside the project rather than in a chat
    log, so it survives across conversations and switches when the project does.
    This node wires one entry into any STRING input (a prompt, a note field) so the
    graph runs with the project's own words and no agent involvement.

    ``key`` is the entry name as the agent stored it ("hero", "grade"); spacing and
    capitalisation don't matter. A missing entry yields ``fallback`` rather than an
    error, so a graph shared between projects still runs where the fact is absent.

    Editing the file on disk changes the value on the next run: the node fingerprints
    the file's modification time, so ComfyUI re-reads it instead of serving the value
    it happened to cache the first time.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYProjectMemoryGet",
            display_name="agentY project memory (get)",
            category="agentY",
            description=(
                "Read one entry from this project's memory as a STRING (character "
                "prompt, style guide, delivery spec). Switches with the project."
            ),
            inputs=[
                io.String.Input("key", default="", placeholder="hero"),
                io.String.Input("fallback", multiline=True, default="",
                                tooltip="Used when this project has no such entry."),
            ],
            outputs=[io.String.Output(display_name="text")],
        )

    @classmethod
    def fingerprint_inputs(cls, key="", fallback=""):  # noqa: ANN001, ARG003
        # Without this the first value read would be cached for the life of the
        # process and hand-edits to the file would never reach the graph.
        f = _pm_find(_pm_slug(key))
        try:
            return f"{f}:{f.stat().st_mtime_ns}" if f else f"missing:{key}:{fallback}"
        except Exception:  # noqa: BLE001
            return f"unreadable:{key}"

    @classmethod
    def execute(cls, key="", fallback="") -> io.NodeOutput:  # noqa: ANN001
        f = _pm_find(_pm_slug(key))
        if f is None:
            return io.NodeOutput(fallback)
        try:
            return io.NodeOutput(f.read_text(encoding="utf-8", errors="replace").strip())
        except Exception:  # noqa: BLE001
            return io.NodeOutput(fallback)


class AgentYProjectMemorySet(io.ComfyNode):
    """Record a fact into this project's memory from the graph.

    For the thing worth keeping once a graph has produced it: the prompt that
    finally worked, the path of the frame chosen as the locked reference. Writing
    the same ``key`` again REPLACES the entry, so a graph that runs a hundred times
    leaves one fact, not a hundred — but note that it writes on EVERY run, so wire
    it where that is what you want.

    ``lock`` protects an entry that has been settled: with it on, an existing entry
    of the same name is left alone and this run passes the stored value through
    unchanged, so re-running the graph can't quietly overwrite the reference the
    rest of the project is matching.

    The ``value`` is passed straight through, so this can sit inline on a wire.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYProjectMemorySet",
            display_name="agentY project memory (set)",
            category="agentY",
            description=(
                "Record one entry into this project's memory (replacing any entry of "
                "the same name) and pass the value through. Switches with the project."
            ),
            inputs=[
                io.String.Input("key", default="", placeholder="hero"),
                io.String.Input("value", multiline=True, default=""),
                io.Combo.Input("type", options=_PM_TYPES, default="note"),
                io.Boolean.Input(
                    "lock", default=False, label_on="keep existing", label_off="overwrite",
                    tooltip=("ON: if this project already has an entry by this name, keep "
                             "it and pass the STORED value through instead of writing."),
                ),
            ],
            outputs=[io.String.Output(display_name="text")],
        )

    @classmethod
    def execute(cls, key="", value="", type="note", lock=False) -> io.NodeOutput:  # noqa: ANN001, A002
        slug, body = _pm_slug(key), str(value or "").strip()
        existing = _pm_find(slug)
        if lock and existing is not None:
            try:
                return io.NodeOutput(existing.read_text(encoding="utf-8", errors="replace").strip())
            except Exception:  # noqa: BLE001
                return io.NodeOutput(body)
        if not slug or not body:
            return io.NodeOutput(body)
        d = _pm_dir(create=True)
        if d is None:
            print("[agentY project memory] no ComfyUI user directory — nothing stored")
            return io.NodeOutput(body)
        folder = _pm_slug(type) or "note"
        target = d / folder / f"{slug}.md"
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body + "\n", encoding="utf-8")
            # Re-filing under a different type must not leave the old copy behind
            # to answer with the old fact.
            if existing is not None and existing != target:
                existing.unlink(missing_ok=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[agentY project memory] could not write {target}: {exc}")
        return io.NodeOutput(body)


class AgentYRefNote(io.ComfyNode):
    """Say what a reference is FOR, on the wire that carries it.

    Drop it between a loader and whatever consumes it — LoadImage → ref note →
    hook anchor — and write what the agent should take from this input: "the face,
    not the styling"; "the light, not the architecture". The agent reads the note
    with the input, so a reference image stops being just "an image" and becomes an
    image with a job.

    Two things follow from the note living on the wire rather than in a separate
    node: the binding can't drift (there is nothing to keep in sync — the link IS
    the statement), and the agent still sees the real node behind it, so an anchor
    on a ref note reads as the LoadImage it wraps, plus the role.

    The output type follows the input, so it can be inserted into an existing wire
    of any type without changing what downstream nodes receive. On a normal run it
    is an identity passthrough.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        template = io.MatchType.Template("ref")
        return io.Schema(
            node_id="AgentYRefNote",
            display_name="agentY ref note",
            category="agentY",
            description=(
                "Annotate a reference input with what it is FOR ('the face, not the "
                "styling'). Sits on the wire; identity passthrough on a normal run."
            ),
            inputs=[
                io.MatchType.Input("input", template=template),
                io.String.Input(
                    "role", multiline=True, default="",
                    placeholder="what to take from this reference — e.g. the face, not the styling",
                ),
            ],
            outputs=[io.MatchType.Output(template=template, display_name="output")],
        )

    @classmethod
    def execute(cls, input=None, role="") -> io.NodeOutput:  # noqa: ANN001, A002, ARG003
        return io.NodeOutput(input)


class _AgentYExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [AgentYHook, AgentYPython, AgentYText,
                AgentYImageCollector, AgentYVideoCollector,
                AgentYProjectMemoryGet, AgentYProjectMemorySet, AgentYRefNote]


async def comfy_entrypoint() -> ComfyExtension:
    return _AgentYExtension()


WEB_DIRECTORY = "./web"
