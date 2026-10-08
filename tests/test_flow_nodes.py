"""The flow nodes of a hook pipeline: agentY loop start / agentY loop break.

They are wired into the same chains as the hooks, so the panel reports them
with the hooks; the host reads which hooks sit between them and runs those as a
loop. A large workflow built for a stage is folded into a subgraph when the run
ends, and the break node shows where its loop stands.
"""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHAT = (ROOT / "web" / "agent_chat.js").read_text(encoding="utf-8")
FLOW = (ROOT / "web" / "agent_flow.js").read_text(encoding="utf-8")
FLOW_PURE = (ROOT / "web" / "agent_exec.js").read_text(encoding="utf-8")
NODES = (ROOT / "__init__.py").read_text(encoding="utf-8")


class TheNodes(unittest.TestCase):

    def test_both_are_registered(self):
        listed = NODES.split("async def get_node_list", 1)[1].split("async def comfy_entrypoint", 1)[0]
        self.assertIn("AgentYLoopStart", listed)
        self.assertIn("AgentYLoopBreak", listed)

    def test_the_break_carries_the_condition_the_limit_and_what_goes_on(self):
        brk = NODES.split("class AgentYLoopBreak", 1)[1].split("\n# Number of (fixed)", 1)[0]
        for field in ('"condition"', '"max_rounds"', '"forward"'):
            self.assertIn(field, brk)
        self.assertIn('options=["best", "all that pass", "all"]', brk)

    def test_they_sit_on_the_execution_wire_and_carry_no_data(self):
        for cls, end in (("AgentYLoopStart", "class AgentYLoopBreak"),
                         ("AgentYLoopBreak", "# Number of (fixed)")):
            body = NODES.split(f"class {cls}(io.ComfyNode):", 1)[1].split(end, 1)[0]
            schema = body.split("def define_schema", 1)[1]
            self.assertIn("_exec_in()", schema)
            self.assertIn("outputs=[_exec_out()],", schema)
            self.assertNotIn("anchor", schema)


class TheContextNode(unittest.TestCase):
    """Sequence / asset and shot: where agentY saves, and under what name."""

    def setUp(self):
        self.node = NODES.split("class AgentYContext", 1)[1].split("class AgentYLoopStart", 1)[0]

    def test_it_is_registered_under_the_class_the_host_looks_for(self):
        listed = NODES.split("async def get_node_list", 1)[1].split("async def comfy_entrypoint", 1)[0]
        self.assertIn("AgentYContext", listed)
        self.assertIn('node_id="AgentYContext"', self.node)

    def test_it_holds_a_sequence_and_a_shot_as_plain_text(self):
        self.assertIn('io.String.Input("sequence"', self.node)
        self.assertIn('io.String.Input("shot"', self.node)


class ThePanel(unittest.TestCase):

    def test_flow_nodes_are_collected_with_the_hooks(self):
        nodes = CHAT.split("  _hookNodes() {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("graph._nodes.filter((n) => isExecNode(n))", nodes)
        self.assertIn("isHookNode(node) || isReviewNode(node) || !!flowPurpose(node)", FLOW_PURE)

    def test_a_flow_node_is_sent_even_with_nothing_typed_in_it(self):
        stage = CHAT.split("  _isStage(n) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertLess(stage.index("if (flowPurpose(n)) return true;"), stage.index("hookReaches("))

    def test_a_stage_after_a_loop_node_is_ordered_by_the_execution_wire(self):
        base = CHAT.split("  _stageBase(hn) {", 1)[1].split("\n  _anchorEntry", 1)[0]
        self.assertIn("const execPrev = this._execPrev(hn);", base)

    def test_the_break_sends_its_settings(self):
        collect = CHAT.split("  _collectCanvasHooks() {", 1)[1].split("\n  // ── review nodes", 1)[0]
        block = collect.split('flow === "loop_break" ? {', 1)[1].split("} : {}", 1)[0]
        for field in ("condition:", "max_rounds:", "forward:"):
            self.assertIn(field, block)

    def test_a_large_stage_is_folded_when_the_turn_ends_not_before(self):
        layout = CHAT.split("  _layoutBlock(block, made) {", 1)[1].split("\n  _foldPending", 1)[0]
        self.assertIn("this._pendingFolds", layout)
        self.assertNotIn("convertToSubgraph", layout, "values are still changed on these nodes by id")
        done = CHAT.split('      case "done":', 1)[1].split("break;", 1)[0]
        self.assertIn("this._foldPending();", done)

    def test_folding_is_skipped_where_comfyui_cannot_do_it(self):
        fold = CHAT.split("  _foldIntoSubgraph(graph, nodes, title, origin) {", 1)[1].split("\n  }", 1)[0]
        self.assertIn('typeof graph.convertToSubgraph !== "function"', fold)
        self.assertIn("return null;", fold)

    def test_the_break_node_shows_where_its_loop_stands(self):
        self.assertIn('else if (ev.op === "flow_state") this._flowState(ev);', CHAT)
        self.assertIn("node.agentYFlowState = {", CHAT)
        self.assertIn("node.title = flowTitle(node.title, node.agentYFlowState);", CHAT)
        self.assertNotIn("node.onDrawForeground", FLOW, "the Vue node renderer never calls it")
        for text in ("not there yet", "met in round", "best attempt"):
            self.assertIn(text, FLOW)

    def test_the_state_in_the_title_is_not_sent_as_the_nodes_name(self):
        base = CHAT.split("  _stageBase(hn) {", 1)[1].split("\n  _anchorEntry", 1)[0]
        self.assertIn('title: String(hn.title || "").split(FLOW_TITLE_SEP)[0].trim(),', base)


if __name__ == "__main__":
    unittest.main()
