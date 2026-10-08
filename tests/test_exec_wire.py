"""The execution wire: order is what is drawn, and nothing else.

Every hook, loop and review node has an `exec` input and output. The panel reads,
for each stage, the stage it runs after; a node that is not part of the run
(bypassed, muted, empty) is transparent on the wire. The reading is checked with
node where there is one; the wiring into the panel by reading the files.
"""
import json
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
NODE = shutil.which("node")
NODES = (ROOT / "__init__.py").read_text(encoding="utf-8")
CHAT = (WEB / "agent_chat.js").read_text(encoding="utf-8")

SCRIPT = """
import { execPredecessors, execSource, isExecNode, isExecSlot, EXEC_TYPE } from %s;
// A graph as litegraph holds it: nodes with inputs/outputs, links by id.
function graph(spec, wires) {
  const nodes = {}, links = {};
  for (const [id, type, mode] of spec) {
    nodes[id] = { id, type, mode: mode || 0,
                  inputs: [{ name: "exec", type: EXEC_TYPE, link: null }, { name: "anchors.anchor0", type: "*", link: null }],
                  outputs: [{ name: "out", type: "*", links: [] }, { name: "exec", type: EXEC_TYPE, links: [] }] };
  }
  let n = 0;
  for (const [from, to, data] of wires) {
    const id = ++n;
    links[id] = { origin_id: from, target_id: to };
    nodes[to].inputs[data ? 1 : 0].link = id;
    nodes[from].outputs[data ? 0 : 1].links.push(id);
  }
  return { links, getNodeById: (i) => nodes[i] || null, nodes };
}
const g = graph(
  [[10, "AgentYLoopStart"], [4, "AgentYHook"], [12, "AgentYReview"], [11, "AgentYLoopBreak"],
   [18, "AgentYHook"], [29, "AgentYHook"], [50, "AgentYHook", 4], [51, "AgentYHook"],
   [7, "KSampler"], [60, "AgentYHook"], [61, "AgentYHook"],
   [70, "AgentYJoin"], [71, "AgentYHook"]],
  [[10, 4], [4, 12], [12, 11], [11, 18], [11, 29],      // a loop, then a fork
   [18, 50], [50, 51],                                  // 50 is bypassed
   [7, 60],                                             // an exec input fed by a foreign node
   [18, 61, true]]);                                    // a DATA wire only
// A join has an exec input per branch: 51 (behind the bypassed 50) and 29.
g.nodes[70].inputs = [{ name: "execs.exec0", type: EXEC_TYPE, link: 901 },
                      { name: "execs.exec1", type: EXEC_TYPE, link: 902 },
                      { name: "execs.exec2", type: EXEC_TYPE, link: null }];
g.links[901] = { origin_id: 50, target_id: 70 };
g.links[902] = { origin_id: 29, target_id: 70 };
g.links[903] = { origin_id: 70, target_id: 71 };
g.nodes[71].inputs[0].link = 903;
const active = (n) => n.mode !== 4 && n.mode !== 2;
const prev = (id) => execPredecessors(g, g.nodes[id], active);
console.log(JSON.stringify({
  chain: [prev(4), prev(12), prev(11)],
  start: prev(10),
  fork: [prev(18), prev(29)],
  through_bypassed: prev(51),
  foreign: prev(60),
  data_only: prev(61),
  join: prev(70),
  after_join: prev(71),
  after_join_seen_through: execPredecessors(g, g.nodes[71], (n) => active(n) && n.type !== "AgentYJoin"),
  source: execSource(g, g.nodes[12]).id,
  kinds: [isExecNode(g.nodes[4]), isExecNode(g.nodes[12]), isExecNode(g.nodes[10]), isExecNode(g.nodes[7])],
  slots: [isExecSlot({ type: EXEC_TYPE }), isExecSlot({ name: "exec" }), isExecSlot({ name: "out", type: "*" })],
}));
"""


@unittest.skipUnless(NODE, "node is not installed")
class ReadingTheWire(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        mod = json.dumps((WEB / "agent_exec.js").as_uri())
        out = subprocess.run([NODE, "--input-type=module", "-e", SCRIPT % mod],
                             capture_output=True, text=True, encoding="utf-8", timeout=60)
        if out.returncode:
            raise AssertionError(out.stderr)
        cls.r = json.loads(out.stdout)

    def test_a_stage_runs_after_the_one_wired_into_its_exec(self):
        self.assertEqual(self.r["chain"], [["10"], ["4"], ["12"]])
        self.assertEqual(self.r["source"], 4)

    def test_the_first_stage_runs_after_nothing(self):
        self.assertEqual(self.r["start"], [])

    def test_a_wire_that_splits_starts_two_branches(self):
        self.assertEqual(self.r["fork"], [["11"], ["11"]])

    def test_a_bypassed_stage_is_transparent(self):
        self.assertEqual(self.r["through_bypassed"], ["18"])

    def test_a_wire_from_a_node_that_is_not_a_stage_says_nothing(self):
        self.assertEqual(self.r["foreign"], [])

    def test_a_data_wire_is_not_order(self):
        self.assertEqual(self.r["data_only"], [])

    def test_a_join_runs_after_every_wire_into_it(self):
        # one per branch - and the bypassed stage on one of them is seen through
        self.assertEqual(self.r["join"], ["18", "29"])
        self.assertEqual(self.r["after_join"], ["70"])

    def test_a_join_that_is_itself_out_of_the_run_passes_all_its_wires_on(self):
        self.assertEqual(self.r["after_join_seen_through"], ["18", "29"])

    def test_hooks_reviews_and_loop_nodes_carry_the_wire(self):
        self.assertEqual(self.r["kinds"], [True, True, True, False])
        self.assertEqual(self.r["slots"], [True, True, False])


class TheSocket(unittest.TestCase):

    def test_it_is_a_type_of_its_own(self):
        self.assertIn('EXEC_TYPE = "AGENTY_EXEC"', NODES)
        self.assertIn("_Exec = io.Custom(EXEC_TYPE)", NODES)
        self.assertIn('export const EXEC_TYPE = "AGENTY_EXEC";',
                      (WEB / "agent_exec.js").read_text(encoding="utf-8"))

    def test_every_stage_node_has_it_in_and_out(self):
        for cls, end in (("AgentYHook", "class AgentYContext"),
                         ("AgentYLoopStart", "class AgentYLoopBreak"),
                         ("AgentYLoopBreak", "# Number of (fixed)"),
                         ("AgentYReview", "class _AgentYExtension")):
            body = NODES.split(f"class {cls}(io.ComfyNode):", 1)[1].split(end, 1)[0]
            with self.subTest(node=cls):
                self.assertIn("_exec_in()", body)
                self.assertIn("_exec_out()", body)

    def test_a_hooks_value_stays_on_output_zero(self):
        hook = NODES.split("class AgentYHook(io.ComfyNode):", 1)[1].split("class AgentYContext", 1)[0]
        outs = hook.split("outputs=[", 1)[1]
        self.assertLess(outs.index('io.AnyType.Output(display_name="out")'), outs.index("_exec_out()"))

    def test_the_join_grows_an_exec_input_per_branch(self):
        join = NODES.split("class AgentYJoin(io.ComfyNode):", 1)[1].split("# Number of (fixed)", 1)[0]
        self.assertIn('input=_Exec.Input("exec"), prefix="exec"', join)
        self.assertIn('io.Autogrow.Input("execs", template=wires)', join)
        self.assertIn("outputs=[_exec_out()],", join)
        listed = NODES.split("async def get_node_list", 1)[1].split("async def comfy_entrypoint", 1)[0]
        self.assertIn("AgentYJoin", listed)
        self.assertIn('AgentYJoin: "join"', (WEB / "agent_exec.js").read_text(encoding="utf-8"))

    def test_the_loop_nodes_carry_only_the_wire(self):
        start = NODES.split("class AgentYLoopStart(io.ComfyNode):", 1)[1].split("class AgentYLoopBreak", 1)[0]
        self.assertIn("inputs=[_exec_in()],", start)
        self.assertIn("outputs=[_exec_out()],", start)
        self.assertNotIn("Autogrow", start)


class ThePanel(unittest.TestCase):

    def test_order_is_sent_separately_from_what_a_stage_reads(self):
        base = CHAT.split("  _stageBase(hn) {", 1)[1].split("\n  _anchorEntry", 1)[0]
        self.assertIn("exec_prev_ids: execPrev,", base)
        self.assertIn("via_hook_ids: execPrev,", base)
        self.assertIn("exec_wired:", base)
        self.assertIn("prev_hook_ids: hookLinks.map(", base)

    def test_the_exec_output_is_not_a_place_a_value_goes(self):
        targets = CHAT.split("  _targetsFor(hookNode) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn("isExecSlot(o)", targets)
        base = CHAT.split("  _stageBase(hn) {", 1)[1].split("\n  _anchorEntry", 1)[0]
        self.assertIn("filter((o) => o && !isExecSlot(o))", base)

    def test_the_wire_is_taken_out_of_the_captured_graph(self):
        cap = CHAT.split("  async _captureCanvasGraph() {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn('if (key === "exec" || key.startsWith("execs.")) delete node.inputs[key];', cap)
        classes = CHAT.split("const EXEC_CLASSES = [", 1)[1].split("];", 1)[0]
        for cls in ("AgentYHook", "AgentYReview", "AgentYLoopStart", "AgentYLoopBreak", "AgentYJoin"):
            self.assertIn(f'"{cls}"', classes)

    def test_a_node_that_is_not_a_stage_is_passed_through(self):
        prev = CHAT.split("  _execPrev(n) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn("execPredecessors(app.graph, n, (x) => this._isStage(x))", prev)

    def test_looking_for_the_nearest_stage_does_not_follow_the_wire(self):
        nb = CHAT.split("  _neighbours(node) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertEqual(nb.count("isExecSlot("), 2)


if __name__ == "__main__":
    unittest.main()
