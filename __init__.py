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
from aiohttp import web

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
except Exception as _e:  # noqa: BLE001
    # Never break ComfyUI startup if the server API shape changes.
    print(f"[agentY-comfyuiConnect] could not register /agent/load_workflow: {_e}")


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
                "the agent generates from the prompt. The 'anchor' input auto-grows, so one "
                "hook can gather several inputs. Toggle 'ignore' to disable it. Inert on a "
                "normal run; acted on by the agentY agent when it runs the graph."
            ),
            inputs=[
                io.String.Input(
                    "directive",
                    multiline=True,
                    default="",
                    placeholder=(
                        "directive: e.g. sweep the seed, 6 variations  •  "
                        "standin: e.g. upscale 2x and add film grain"
                    ),
                ),
                io.Combo.Input(
                    "purpose",
                    options=["directive", "workflow-standin"],
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
                bake_to_canvas=False, anchors=None) -> io.NodeOutput:  # noqa: ANN001, ARG003
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


class _AgentYExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [AgentYHook, AgentYPython]


async def comfy_entrypoint() -> ComfyExtension:
    return _AgentYExtension()


WEB_DIRECTORY = "./web"
