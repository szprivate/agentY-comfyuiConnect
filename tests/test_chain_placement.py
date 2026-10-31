"""Where the new nodes of an edit_canvas_graph go: a block of their own, in free space.

They used to land one by one beside the node they were "near" - for a branch off an
image loader that is where the user's graph goes on, so chains ended up behind the
user's nodes. Now an edit's new nodes are one block (agent_layout.js chainItems +
layoutBlock), placed by chainOrigin: right beside its source when that is clear of
every node and group, else below everything or right of everything, whichever is
nearer. A media source the chain reads is copied when it is in use or boxed in
(isMediaSourceShape is the page's half of canvas_edit.is_media_source).

The geometry runs under node; the panel's use of it in a browser
(test_chain_placement_browser.py) and by reading here.
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
const G = L.GAPS;

// columns by depth from the block's roots, rows by their feeds
const items = [{ id: "a", size: [300, 100] }, { id: "b", size: [200, 100] },
               { id: "c", size: [200, 100] }, { id: "d", size: [250, 100] }];
out.cols = Object.fromEntries(L.chainItems(items, [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]])
  .map((i) => [i.id, [i.col, i.row]]));

// a bare loader with nothing beside it: right of it, first node level with it
const anchor = [100, 70, 300, 330];          // a loader, title bar included
const size = [700, 300];
const free = L.chainOrigin(size, anchor, [anchor, [100, 600, 400, 200]]);
out.free = free;
const laid = L.layoutBlock([{ id: "x", size: [200, 100], band: 0, col: 0, row: 0 }], free.origin);
out.firstNodeTop = laid.positions.x[1] - G.title_bar;
out.firstNodeLeft = laid.positions.x[0];

// the same loader with a node right beside it, or a group round it: not there
out.blocked = L.chainOrigin(size, anchor, [anchor, [480, 100, 300, 200]]).where;
out.boxed = L.chainOrigin(size, anchor, [anchor, [60, 0, 1200, 500]]).where;

// below or beside, whichever is nearer the source
const wide = [[0, 0, 5000, 400]];
out.wideGraph = L.chainOrigin(size, [100, 50, 300, 200], wide.concat([[100, 50, 300, 200]])).where;
const tall = [[0, 0, 900, 6000]];
out.tallGraph = L.chainOrigin(size, [100, 50, 300, 200], tall).where;
out.empty = L.chainOrigin(size, null, [], [40, 60]);
out.noAnchor = L.chainOrigin(size, null, [[0, 0, 500, 500]]);

// 20 random canvases: the block never lands on anything
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) %% 2147483648; return seed / 2147483648; };
const hits = [];
const wheres = {};
for (let k = 0; k < 20; k++) {
  const rects = [];
  const n = 3 + Math.floor(rnd() * 25);
  for (let i = 0; i < n; i++)
    rects.push([Math.floor(rnd() * 3000) - 500, Math.floor(rnd() * 2000) - 300,
                120 + Math.floor(rnd() * 400), 80 + Math.floor(rnd() * 400)]);
  if (rnd() < 0.5) rects.push([Math.floor(rnd() * 2000), Math.floor(rnd() * 1500), 800, 600]);  // a group
  const a = rects[Math.floor(rnd() * rects.length)];
  const s = [300 + Math.floor(rnd() * 1500), 200 + Math.floor(rnd() * 800)];
  const spot = L.chainOrigin(s, rnd() < 0.85 ? a : null, rects);
  wheres[spot.where] = (wheres[spot.where] || 0) + 1;
  const box = [spot.origin[0], spot.origin[1], s[0], s[1]];
  if (rects.some((r) => L.overlaps(box, r))) hits.push(k);
}
out.hits = hits;
out.wheres = wheres;

out.media = [
  L.isMediaSourceShape("LoadImage", ["IMAGE", "MASK"], false, ["cat.png"]),
  L.isMediaSourceShape("VHS_LoadVideoPath", ["IMAGE", "INT"], false, ["D:/a.mp4"]),
  L.isMediaSourceShape("AgentYImageCollector", ["IMAGE"], false, []),
  L.isMediaSourceShape("bEpicThing", ["IMAGE"], false, ["shot.exr"]),
  L.isMediaSourceShape("EmptyLatentImage", ["LATENT"], false, [512, 512, 1]),
  L.isMediaSourceShape("LoadImage", ["IMAGE"], true, ["cat.png"]),
  L.isMediaSourceShape("CheckpointLoaderSimple", ["MODEL", "CLIP", "VAE"], false, ["x.safetensors"]),
  L.isMediaSourceShape("AgentYHook", ["AGENTY_EXEC", "IMAGE"], false, ["a.png"]),
];
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

    def test_columns_follow_the_wires(self):
        cols = self.got["cols"]
        self.assertEqual(cols["a"][0], 0)
        self.assertEqual(cols["b"][0], 1)
        self.assertEqual(cols["c"], [1, 1], "a second branch is a second row")
        self.assertEqual(cols["d"][0], 2)

    def test_a_bare_loader_with_room_gets_the_chain_beside_it(self):
        self.assertEqual(self.got["free"]["where"], "right")
        self.assertEqual(self.got["firstNodeTop"], 70, "level with the loader")
        self.assertEqual(self.got["firstNodeLeft"], 100 + 300 + 60, "one column gap to its right")

    def test_no_room_beside_it_means_elsewhere(self):
        self.assertNotEqual(self.got["blocked"], "right")
        self.assertNotEqual(self.got["boxed"], "right", "a group round it counts as taken")

    def test_the_nearer_free_side_wins(self):
        self.assertEqual(self.got["wideGraph"], "below")
        self.assertEqual(self.got["tallGraph"], "beside")
        self.assertEqual(self.got["empty"], {"origin": [40, 60], "where": "empty"})
        self.assertIn(self.got["noAnchor"]["where"], ("below", "beside"))

    def test_twenty_random_canvases_nothing_is_landed_on(self):
        self.assertEqual(self.got["hits"], [])
        self.assertGreater(sum(self.got["wheres"].values()), 19)

    def test_what_counts_as_a_media_source(self):
        self.assertEqual(self.got["media"], [True, True, True, True, False, False, False, False])


class Wiring(unittest.TestCase):

    def setUp(self):
        self.chat = (WEB / "agent_chat.js").read_text(encoding="utf-8").replace("\r\n", "\n")
        self.edit = self.chat.split("  _editGraph(ev) {", 1)[1].split("\n  _", 1)[0]
        self.place = self.chat.split("  _placeChain(graph, ev, fresh, byId, made) {", 1)[1].split("\n  _copySource", 1)[0]

    def test_new_nodes_are_laid_out_together_not_one_by_one(self):
        self.assertIn("fresh.push(n);", self.edit)
        self.assertIn("this._placeChain(graph, ev, fresh, byId, made)", self.edit)
        self.assertNotIn("n.pos = this._dropPos(op.near != null ? node(op.near) : null, n);\n            fresh", self.edit)

    def test_a_replacement_keeps_its_place(self):
        self.assertIn("n.pos = [was.pos[0], was.pos[1]];", self.edit)

    def test_the_block_uses_the_shared_geometry_and_real_sizes(self):
        for call in ("standardSize(n)", "chainItems(", "layoutBlock(items, origin)", "chainOrigin(",
                     "this._contentRects(graph, mine)", "outputsReach("):
            self.assertIn(call, self.place)

    def test_a_copy_is_made_only_when_it_can_be_told_to_the_host(self):
        self.assertIn('spot.where !== "right" && ev.duplicate_sources !== false && ev.patch_id', self.place)
        self.assertIn("duplicated: (res && res.duplicated) || []", self.chat)

    def test_the_hosts_copy_is_a_clone_of_the_original(self):
        self.assertIn("orig.clone()", self.edit)
        self.assertIn("delete n.properties.agentY_output", self.edit)

    def test_drops_keep_off_groups_and_use_the_nodes_size(self):
        drop = self.chat.split("  _dropPos(near = null, exclude = null) {", 1)[1].split("\n  // Slide down", 1)[0]
        self.assertIn("this._groupsOf(g)", drop)
        self.assertIn("nodes.concat(boxes)", drop)
        self.assertIn("exclude.size[0]", drop)


if __name__ == "__main__":
    unittest.main()
