"""agentY-comfyuiConnect — canvas ↔ agent bridge.

Two responsibilities:

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

The hook is a **V3** node so its ``anchor`` input can *auto-grow*: connect one
node and a fresh empty ``anchor`` slot appears, letting a single hook gather
several inputs (e.g. combine three images in a standin, or apply one directive
across two anchor nodes).
"""
import json as _json
import os as _os
import subprocess as _subprocess
import sys as _sys

from aiohttp import web

# Where this extension records the agentY host's location, so the sidebar's
# "Start server" button can relaunch ``run_agent.ps1`` when the host on :5000 is
# down (a browser can't spawn a process, but this ComfyUI-side route can). The
# file is written by the agentY host on startup (self-registration) and by
# ``install_agent.ps1``; it's gitignored (machine-specific path).
_EXT_DIR = _os.path.dirname(_os.path.abspath(__file__))
_HOST_CFG = _os.path.join(_EXT_DIR, ".agenty_host.json")


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

    print("[agentY-comfyuiConnect] registered /agent routes "
          "(load_workflow, register_host, start_host)")
except Exception as _e:  # noqa: BLE001
    # Never break ComfyUI startup if the server API shape changes.
    print(f"[agentY-comfyuiConnect] could not register /agent routes: {_e}")


from comfy_api.latest import ComfyExtension, io

# Cap on how many anchor slots one hook can grow to. 20 is plenty for "combine
# these N inputs" while keeping the node from ballooning; ``min=0`` lets an
# unwired hook (a global directive or a text-to-media standin) stay valid.
_MAX_ANCHORS = 20


class AgentYHook(io.ComfyNode):
    """An agent instruction attached to the canvas. Two purposes:

    * ``directive`` (default) — annotate an upstream node's output. Wire an
      ``anchor`` input from any node's output and type a directive (e.g. "create
      prompt variations", "sweep the seed 6×", "iterate the files in this
      folder"). When the agentY agent runs the on-canvas graph, it applies the
      directive to the anchored node(s) and runs the expanded batch.
    * ``workflow-standin`` — the hook stands in for a workflow or Python script
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

    The ``anchor`` **input** auto-grows: each time you wire one, a new empty slot
    appears, so a single hook can gather several inputs (e.g. combine three images
    in a standin, or apply one directive across two anchor nodes). The single
    ``out`` **output** carries any type (image, video, string / int / float); a
    stage that yields several results forwards them all to the next hook via the
    agent, not via several slots.

    ``bake_to_canvas`` (workflow-standin only) — when on, the agent doesn't just
    run the workflow it generates for this hook: it nests that workflow into a
    ComfyUI **subgraph**, exposes inputs/outputs matching this hook's slots, drops
    the subgraph onto the same canvas, and wires the subgraphs to mirror the hook
    chain — "baking" the multi-step task into a reusable native workflow that runs
    next time without the agent.

    ``freeze`` (directive / text hooks) — controls what the agent does with the
    value it produces for this hook. OFF (default) *keeps the hook live*: the hook
    stays wired exactly as drawn, the agent injects the produced value into the
    graph at run time, and the ``agentY text`` node it drops is left UNCONNECTED as
    a human-readable reference. ON *freezes* the value into the graph: the agent
    bakes the ``agentY text`` node into the wired target input and takes over the
    hook's downstream link, yielding a self-contained plain workflow you can re-run
    yourself without the agent (at the cost of bypassing the hook).

    Toggle ``ignore`` to disable a hook without deleting it — the agent skips it.

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
                "Attach an agent instruction to the canvas. As a 'directive' it annotates a "
                "node's output; as a 'workflow-standin' it stands in for a workflow/script "
                "the agent generates from the prompt; as 'text' it asks for a written answer "
                "the agent drops on the canvas as a wireable 'agentY text' node. The 'anchor' "
                "input auto-grows, so one hook can gather several inputs. Toggle 'ignore' to "
                "disable it. Inert on a normal run; acted on by the agentY agent when it runs "
                "the graph."
            ),
            inputs=[
                io.String.Input(
                    "directive",
                    multiline=True,
                    default="",
                    placeholder=(
                        "directive: e.g. sweep the seed, 6 variations  •  "
                        "standin: e.g. upscale 2x and add film grain  •  "
                        "text: e.g. write a caption for this image"
                    ),
                ),
                io.Combo.Input(
                    "purpose",
                    options=["directive", "workflow-standin", "text"],
                    default="directive",
                ),
                io.Combo.Input(
                    "mode",
                    options=["auto", "prompt-variations", "seed-sweep", "file-iterate", "freeform"],
                    default="auto",
                ),
                io.Boolean.Input(
                    "ignore",
                    default=False,
                    label_on="ignored",
                    label_off="active",
                ),
                io.Boolean.Input(
                    "bake_to_canvas",
                    default=False,
                    label_on="bake subgraph",
                    label_off="run only",
                    tooltip=(
                        "workflow-standin only: also bake the generated workflow onto the "
                        "canvas as a nested subgraph wired to mirror the hook chain."
                    ),
                ),
                io.Boolean.Input(
                    "freeze",
                    default=False,
                    label_on="freeze into graph",
                    label_off="keep hook live",
                    tooltip=(
                        "text / directive hooks: OFF (default) keeps the hook wired as you "
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
    def execute(cls, directive="", purpose="directive", mode="auto", ignore=False,
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


class _AgentYExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [AgentYHook, AgentYPython, AgentYText]


async def comfy_entrypoint() -> ComfyExtension:
    return _AgentYExtension()


WEB_DIRECTORY = "./web"
