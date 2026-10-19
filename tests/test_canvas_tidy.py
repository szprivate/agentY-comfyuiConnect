"""Tidying a graph that is already on the canvas: arrange, group, save.

The agent's arrange_canvas / group_canvas_nodes / auto_group_canvas lay nodes out
in flow order, one block per group, and save_canvas_workflow must never replace
a file it was not told to. The geometry and the save rules are plain functions
(agent_layout.js flowArrange, agent_save.js planSave) checked under node; the
panel wiring by reading.
"""
import json
import pathlib
import shutil
import subprocess
import unittest

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
NODE = shutil.which("node")

SCRIPT = """
import * as L from %s;
import * as S from %s;
const out = {};
const sz = (w, h) => [w, h];
// loader -> encode -> sampler -> decode -> save, plus a second loader feeding the sampler
const items = [
  { id: "1", size: sz(300, 120), group: null, x: 900, y: 900 },
  { id: "2", size: sz(300, 200), group: null, x: 10, y: 10 },
  { id: "3", size: sz(320, 260), group: null, x: 10, y: 10 },
  { id: "4", size: sz(300, 400), group: null, x: 10, y: 10 },
  { id: "5", size: sz(260, 100), group: null, x: 10, y: 10 },
  { id: "6", size: sz(400, 300), group: null, x: 10, y: 10 },
];
const edges = [["1", "3"], ["2", "3"], ["1", "4"], ["3", "4"], ["4", "5"], ["5", "6"]];
const flat = L.flowArrange(items, edges, [100, 100]);
out.depths = L.depthsOf(items.map((i) => i.id), edges);
out.flatPos = flat.positions;
const rectOf = (i, pos) => [pos[i.id][0], pos[i.id][1] - L.GAPS.title_bar, i.size[0], i.size[1] + L.GAPS.title_bar];
const rects = items.map((i) => rectOf(i, flat.positions));
out.flatOverlap = rects.some((r, a) => rects.some((q, b) => a < b && L.overlaps(r, q)));
out.flatStart = flat.bounds.slice(0, 2);

// two groups + loose nodes: each group is one block with its own box, no box overlaps another
const grouped = items.map((i) => ({ ...i, group: ["1", "2"].includes(i.id) ? "a" : ["3", "4"].includes(i.id) ? "b" : null }));
const g = L.flowArrange(grouped, edges, [0, 0]);
out.boxKeys = Object.keys(g.boxes).sort();
out.boxesOverlap = L.overlaps(g.boxes.a, g.boxes.b);
out.order = g.order;
const inBox = (id, key) => { const r = rectOf(items.find((i) => i.id === id), g.positions), b = g.boxes[key];
  return r[0] >= b[0] && r[1] >= b[1] && r[0] + r[2] <= b[0] + b[2] && r[1] + r[3] <= b[1] + b[3]; };
out.membersInside = ["1", "2"].every((id) => inBox(id, "a")) && ["3", "4"].every((id) => inBox(id, "b"));
out.looseOutsideBoxes = ["5", "6"].every((id) => { const r = rectOf(items.find((i) => i.id === id), g.positions);
  return !L.overlaps(r, g.boxes.a) && !L.overlaps(r, g.boxes.b); });

// a long chain wraps instead of running off to the right
const chain = Array.from({ length: 12 }, (_, n) => ({ id: "c" + n, size: [500, 200], group: "g" + n, x: n, y: 0 }));
const ce = chain.slice(1).map((c, n) => ["c" + n, c.id]);
const wrapped = L.flowArrange(chain, ce, [0, 0], undefined, 3000);
out.wrapWidth = wrapped.bounds[2];
out.wrapRows = new Set(Object.values(wrapped.positions).map((p) => p[1])).size;
// a cycle does not hang it
out.cycle = Object.keys(L.flowArrange(items.slice(0, 2), [["1", "2"], ["2", "1"]], [0, 0]).positions).length;
out.empty = L.flowArrange([], [], [0, 0]).bounds;

// saving
const base = { temporary: false, modified: true, path: "workflows/a.json", filename: "a", taken: false };
out.save = {
  unsavedNoName: S.planSave({ ...base, temporary: true }, "", false),
  unsavedNamed: S.planSave({ ...base, temporary: true }, " my/flow.json ", false),
  unsavedTaken: S.planSave({ ...base, temporary: true, taken: true }, "x", true),
  savedNoOverwrite: S.planSave(base, "", false),
  savedOverwrite: S.planSave(base, "", true),
  savedClean: S.planSave({ ...base, modified: false }, "", true),
  newNameTaken: S.planSave({ ...base, taken: true }, "b", true),
  newNameCopy: S.planSave(base, "b", false),
  cleaned: S.cleanName("..\\\\evil/<name>:x.JSON"),
};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "no node on PATH")
class Behaviour(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        script = SCRIPT % (json.dumps((WEB / "agent_layout.js").as_uri()),
                           json.dumps((WEB / "agent_save.js").as_uri()))
        out = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True,
                             encoding="utf-8", timeout=60)
        assert out.returncode == 0, out.stderr
        cls.got = json.loads(out.stdout)

    def test_data_flows_left_to_right_and_nothing_overlaps(self):
        d, p = self.got["depths"], self.got["flatPos"]
        self.assertEqual([d[k] for k in "123456"], [0, 0, 1, 2, 3, 4])
        xs = [p[k][0] for k in "1346"]
        self.assertEqual(xs, sorted(xs))
        self.assertLess(p["1"][0], p["3"][0])
        self.assertLess(p["5"][0], p["6"][0])
        self.assertFalse(self.got["flatOverlap"])

    def test_it_stays_where_the_graph_already_is(self):
        self.assertEqual(self.got["flatStart"], [100, 100])

    def test_a_group_is_one_block_with_its_own_box(self):
        self.assertEqual(self.got["boxKeys"], ["a", "b"])
        self.assertFalse(self.got["boxesOverlap"])
        self.assertTrue(self.got["membersInside"])
        self.assertTrue(self.got["looseOutsideBoxes"])

    def test_blocks_come_in_the_order_the_data_flows(self):
        self.assertEqual(self.got["order"][0], "a")

    def test_a_long_chain_wraps_and_a_cycle_does_not_hang(self):
        self.assertLessEqual(self.got["wrapWidth"], 3000 + 500)
        self.assertGreater(self.got["wrapRows"], 1)
        self.assertEqual(self.got["cycle"], 2)
        self.assertIsNone(self.got["empty"])

    def test_an_unsaved_workflow_needs_a_name_and_gets_saved_under_it(self):
        s = self.got["save"]
        self.assertEqual(s["unsavedNoName"]["status"], "needs_name")
        self.assertEqual(s["unsavedNamed"], {"action": "save_as", "name": "flow"})

    def test_nothing_is_overwritten_unless_told_to(self):
        s = self.got["save"]
        self.assertEqual(s["savedNoOverwrite"]["status"], "needs_overwrite")
        self.assertEqual(s["savedNoOverwrite"]["action"], "refuse")
        self.assertEqual(s["savedOverwrite"]["action"], "save")
        self.assertEqual(s["savedClean"]["status"], "already_saved")

    def test_another_workflows_file_is_never_replaced(self):
        s = self.got["save"]
        self.assertEqual(s["unsavedTaken"]["status"], "name_taken", "not even with overwrite")
        self.assertEqual(s["newNameTaken"]["status"], "name_taken")
        self.assertEqual(s["newNameCopy"], {"action": "save_as", "name": "b"})

    def test_a_name_is_only_a_file_name(self):
        self.assertEqual(self.got["save"]["cleaned"], "namex")


class Wiring(unittest.TestCase):
    """The panel handles what the host sends, and the probe answers a save."""

    def test_the_panel_handles_the_layout_patch(self):
        chat = (WEB / "agent_chat.js").read_text(encoding="utf-8")
        self.assertIn('ev.op === "layout"', chat)
        self.assertIn("_layoutCanvas(ev)", chat)
        body = chat[chat.index("  _layoutCanvas(ev) {"):chat.index("  // ── where the agent's additions go")]
        self.assertIn("graph.beforeChange()", body, "one undo step")
        self.assertIn("graph.afterChange()", body)
        self.assertIn("flowArrange(", body)

    def test_the_probe_answers_a_save(self):
        probe = (WEB / "agent_probe.js").read_text(encoding="utf-8")
        self.assertIn('case "save_workflow"', probe)
        self.assertIn("planSave(", probe)
        self.assertIn("await answer(probe)", probe, "a save is asynchronous")


if __name__ == "__main__":
    unittest.main()
