"""Where the agent's additions to an open graph go.

An inserted workflow used to land node by node, "beside the one that feeds it",
which was anywhere and often on top of something; results were dropped wherever
there was room. Now an inserted workflow is laid out in columns and rows below
what is on the canvas, in a group named agent_1, agent_2, ...; and results go
into one group, "agent outputs", that grows as they arrive.

The geometry is checked with node where there is one; the wiring by reading.
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
const out = {};

// a three-node workflow: loader | sampler | save, plus a second row in column 0
const items = [
  { id: "a", size: [300, 100], band: 0, col: 0, row: 0 },
  { id: "b", size: [320, 260], band: 0, col: 0, row: 1 },
  { id: "c", size: [400, 500], band: 0, col: 1, row: 0 },
  { id: "d", size: [280, 300], band: 0, col: 2, row: 0 },
];
const existing = [[100, 50, 900, 600], [1200, 80, 300, 300]];
const origin = L.blockOrigin(existing);
const laid = L.layoutBlock(items, origin);
const rects = items.map((i) => [laid.positions[i.id][0], laid.positions[i.id][1] - L.GAPS.title_bar,
                                i.size[0], i.size[1] + L.GAPS.title_bar]);
out.origin = origin;
out.positions = laid.positions;
out.bounds = laid.bounds;
out.selfOverlap = rects.some((r, i) => rects.some((q, j) => i < j && L.overlaps(r, q)));
out.hitsExisting = existing.some((e) => L.overlaps(laid.bounds, e));
out.allInside = rects.every((r) => r[0] >= laid.bounds[0] && r[1] >= laid.bounds[1]
  && r[0] + r[2] <= laid.bounds[0] + laid.bounds[2] && r[1] + r[3] <= laid.bounds[1] + laid.bounds[3]);
out.titleRoom = Math.min(...rects.map((r) => r[1])) - laid.bounds[1];

// a second block goes below the first
const origin2 = L.blockOrigin(existing.concat([laid.bounds]));
out.secondBelowFirst = origin2[1] >= laid.bounds[1] + laid.bounds[3];

out.emptyGraph = L.blockOrigin([], [40, 60]);
out.names = [L.nextAgentName([]), L.nextAgentName(["agent_1", "Flux", "agent_2"]),
             L.nextAgentName(["agent_7", "agent_2"]), L.nextAgentName(["agent_x", "agents_3", " agent_4 "])];

// results: a grid, row by row, never on top of one another
const gpos = L.outputsOrigin(existing);
out.outputsRightOfEverything = gpos[0] >= 1500 && gpos[1] === 50;
const taken = [];
const spots = [];
for (let n = 0; n < 6; n++) {
  const p = L.outputSlot(gpos, taken);
  spots.push(p);
  taken.push([p[0], p[1] - L.GAPS.title_bar, 320, 314 + L.GAPS.title_bar]);
}
out.spots = spots;
out.outputsOverlap = taken.some((r, i) => taken.some((q, j) => i < j && L.overlaps(r, q)));
out.wrapsAfter = L.OUTPUT_COLUMNS;
// a slot freed in the middle is used again
const freed = taken.filter((_, i) => i !== 1);
out.reusesGap = L.outputSlot(gpos, freed);
const box = L.groupBox(taken);
out.boxHoldsAll = taken.every((r) => r[0] >= box[0] && r[1] >= box[1]
  && r[0] + r[2] <= box[0] + box[2] && r[1] + r[3] <= box[1] + box[3]);
out.nothing = [L.boundsOf([]), L.groupBox([]), L.layoutBlock([], [0, 0]).bounds];
// the group as first drawn holds one cell; the second result sits beside it
const drawn = [gpos[0], gpos[1], L.OUTPUT_CELL[0] + 2 * L.GAPS.pad, 300];
const reach = L.outputsReach(drawn);
out.reachHoldsWholeFirstRow = taken.slice(0, L.OUTPUT_COLUMNS).every((r) => L.overlaps(r, reach));
out.reachHoldsNextRow = L.overlaps(taken[L.OUTPUT_COLUMNS], L.outputsReach(L.groupBox(taken.slice(0, L.OUTPUT_COLUMNS))));
out.secondIsOutsideTheDrawnBox = !L.overlaps(taken[1], drawn);
out.farAwayIsNotReached = !L.overlaps([gpos[0] + 5000, gpos[1], 300, 300], reach);
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "no node on PATH")
class Geometry(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        script = SCRIPT % json.dumps((WEB / "agent_layout.js").as_uri())
        out = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True,
                             encoding="utf-8", timeout=60)
        assert out.returncode == 0, out.stderr
        cls.got = json.loads(out.stdout)

    def test_an_inserted_workflow_goes_below_what_is_there(self):
        self.assertEqual(self.got["origin"][0], 100, "at the content's left edge")
        self.assertGreaterEqual(self.got["origin"][1], 650 + 1, "below the lowest thing on the canvas")
        self.assertFalse(self.got["hitsExisting"])

    def test_its_nodes_do_not_overlap_each_other(self):
        self.assertFalse(self.got["selfOverlap"])
        p = self.got["positions"]
        self.assertEqual(p["a"][0], p["b"][0], "one column")
        self.assertGreater(p["b"][1], p["a"][1] + 100, "the second row clears the first")
        self.assertGreater(p["c"][0], p["a"][0] + 320, "the next column clears the widest node of this one")
        self.assertGreater(p["d"][0], p["c"][0] + 400)

    def test_the_group_holds_every_node_with_room_for_its_title(self):
        self.assertTrue(self.got["allInside"])
        self.assertGreaterEqual(self.got["titleRoom"], 32)

    def test_a_second_workflow_goes_below_the_first(self):
        self.assertTrue(self.got["secondBelowFirst"])

    def test_an_empty_graph_uses_the_fallback(self):
        self.assertEqual(self.got["emptyGraph"], [40, 60])

    def test_groups_are_numbered_and_a_number_is_not_reused(self):
        self.assertEqual(self.got["names"], ["agent_1", "agent_3", "agent_8", "agent_5"])

    def test_results_fill_a_grid_without_overlapping(self):
        self.assertTrue(self.got["outputsRightOfEverything"])
        self.assertFalse(self.got["outputsOverlap"])
        spots = self.got["spots"]
        n = self.got["wrapsAfter"]
        self.assertEqual(len({s[1] for s in spots[:n]}), 1, "the first row")
        self.assertGreater(spots[n][1], spots[0][1], "then the next row")
        self.assertEqual(spots[n][0], spots[0][0])

    def test_a_freed_slot_is_used_again_and_the_group_holds_everything(self):
        self.assertEqual(self.got["reusesGap"], self.got["spots"][1])
        self.assertTrue(self.got["boxHoldsAll"])

    def test_a_result_placed_beside_the_box_still_belongs_to_the_group(self):
        """The group is resized AFTER a result is placed. Counting only what the
        box as drawn already holds left the second result outside it for good."""
        self.assertTrue(self.got["secondIsOutsideTheDrawnBox"])
        self.assertTrue(self.got["reachHoldsWholeFirstRow"])
        self.assertTrue(self.got["reachHoldsNextRow"])
        self.assertTrue(self.got["farAwayIsNotReached"])

    def test_nothing_in_is_nothing_out(self):
        self.assertEqual(self.got["nothing"], [None, None, None])


class Wiring(unittest.TestCase):

    def setUp(self):
        self.chat = (WEB / "agent_chat.js").read_text(encoding="utf-8").replace("\r\n", "\n")

    def test_an_edit_that_carries_a_block_is_laid_out_and_grouped(self):
        edit = self.chat.split("  _editGraph(ev) {", 1)[1].split("\n  _", 1)[0]
        self.assertIn("if (ev.block && ev.block.slots)", edit)
        self.assertIn("this._layoutBlock(ev.block, made)", edit)
        block = self.chat.split("  _layoutBlock(block, made) {", 1)[1].split("\n  _outputsGroup", 1)[0]
        for call in ("standardSize(node)", "blockOrigin(", "layoutBlock(", "nextAgentName(", "this._addGroup("):
            self.assertIn(call, block)

    def test_an_edit_without_a_block_is_left_as_it_was(self):
        """edit_canvas_graph adding one node must not get a group around it."""
        edit = self.chat.split("  _editGraph(ev) {", 1)[1].split("\n  _", 1)[0]
        self.assertIn("let blockName = null;", edit)

    def test_results_go_to_the_outputs_group_and_fall_back_if_that_fails(self):
        inject = self.chat.split("\n  injectNode(ev) {", 1)[1].split("\n  _attachRefNote", 1)[0]
        self.assertIn("grouped = this._placeOutput(node)", inject)
        self.assertIn("if (!grouped) node.pos = this._dropPos(null, node);", inject)

    def test_the_group_is_sized_by_whole_cells_not_by_what_a_loader_reports(self):
        """A loader's preview is drawn below node.size; the box must hold it."""
        fit = self.chat.split("  _fitOutputsGroup(graph) {", 1)[1].split("\n  // Bypass", 1)[0]
        self.assertIn("Math.max(r[2], OUTPUT_CELL[0])", fit)
        self.assertIn("Math.max(r[3], OUTPUT_CELL[1] + GAPS.title_bar)", fit)

    def test_the_outputs_group_is_found_by_its_title_and_refitted_as_previews_load(self):
        place = self.chat.split("  _placeOutput(node) {", 1)[1].split("\n  _fitOutputsGroup", 1)[0]
        self.assertIn("this._outputsGroup(graph)", place)
        self.assertIn("node.properties.agentY_output = true", place)
        self.assertIn("setTimeout(() => this._fitOutputsGroup(graph), wait)", place)
        self.assertIn('OUTPUTS_TITLE = "agent outputs"',
                      (WEB / "agent_layout.js").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
