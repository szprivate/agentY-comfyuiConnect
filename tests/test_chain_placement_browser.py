"""The real _editGraph placing an edit's new nodes, in Chromium, on a stand-in LiteGraph.

The REAL web/agent_chat.js runs with ComfyUI's app.js / api.js stubbed (the stubs of
test_panel_hosts_browser) and a small LiteGraph stand-in: nodes with sizes, inputs,
outputs and widgets, links, groups, clone(). Pinned:

  * a branch off a loader the graph already uses: the host's copy is cloned from the
    original (same file), copy and chain go into free space as one block, the
    original keeps its place and its wires;
  * a loader standing alone with room beside it: wired as it is, the chain to its right,
    level with it;
  * the same loader boxed in (a node beside it, or inside a group): copied into free
    space, the copy wired, the original left bare - and the answer to the host says so;
  * copies switched off: no copy, the chain still in free space;
  * twenty random canvases: no new node lands on a node or group that was there, and
    nothing that was there moves.

Needs Playwright with an installed Edge or Chrome (or Playwright's Chromium).
Run: python -m unittest tests.test_chain_placement_browser
"""
import json
import random
import unittest

from tests.test_panel_hosts_browser import API_STUB, APP_STUB, ORIGIN, TYPES, WEB, sync_playwright

PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
await import("/scripts/app.js");
await import("/extensions/agentY/agent_chat.js");
window.__ready = true;
</script></body></html>"""

# Node types of the stand-in: size, inputs, outputs, widgets.
SPECS = {
    "LoadImage": {"w": 320, "h": 360, "inputs": [], "outputs": [["IMAGE", "IMAGE"], ["MASK", "MASK"]],
                  "widgets": [["image", "cat.png"]]},
    "ImageScaleBy": {"w": 300, "h": 90, "inputs": [["image", "IMAGE"]], "outputs": [["IMAGE", "IMAGE"]],
                     "widgets": [["scale_by", 1.0]]},
    "ImageInvert": {"w": 220, "h": 50, "inputs": [["image", "IMAGE"]], "outputs": [["IMAGE", "IMAGE"]],
                    "widgets": []},
    "PreviewImage": {"w": 260, "h": 280, "inputs": [["images", "IMAGE"]], "outputs": [], "widgets": []},
    "KSampler": {"w": 320, "h": 470, "inputs": [["latent_image", "LATENT"]], "outputs": [["LATENT", "LATENT"]],
                 "widgets": [["seed", 1], ["steps", 20]]},
}

LITEGRAPH = r"""
(specs) => {
  window.__SPECS = specs;
  class Node {
    constructor(type) {
      const s = specs[type];
      this.type = type; this.id = undefined; this.pos = [0, 0]; this.size = [s.w, s.h];
      this.properties = {}; this.graph = null; this.title = type;
      this.inputs = s.inputs.map(([name, t]) => ({ name, type: t, link: null }));
      this.outputs = s.outputs.map(([name, t]) => ({ name, type: t, links: [] }));
      this.widgets = s.widgets.map(([name, value]) => ({ name, value, options: {} }));
    }
    computeSize() { return [specs[this.type].w, specs[this.type].h]; }
    setSize(s) { this.size = [s[0], s[1]]; }
    clone() {
      const n = new Node(this.type);
      this.widgets.forEach((w, i) => { n.widgets[i].value = w.value; });
      n.properties = JSON.parse(JSON.stringify(this.properties));
      return n;
    }
    connect(out, target, slot) {
      const g = this.graph, inp = target.inputs[slot];
      if (!inp || !this.outputs[out]) return null;
      if (inp.link != null) target.disconnectInput(slot);
      const id = ++g.last_link_id;
      const l = { id, origin_id: this.id, origin_slot: out, target_id: target.id, target_slot: slot,
                  type: this.outputs[out].type };
      g.links[id] = l; inp.link = id; this.outputs[out].links.push(id);
      return l;
    }
    disconnectInput(slot) {
      const g = this.graph, inp = this.inputs[slot];
      if (!inp || inp.link == null) return;
      const l = g.links[inp.link];
      if (l) {
        const o = g.getNodeById(l.origin_id);
        if (o) { const ls = o.outputs[l.origin_slot].links; ls.splice(ls.indexOf(l.id), 1); }
        delete g.links[l.id];
      }
      inp.link = null;
    }
  }
  class Group {
    constructor(title) { this.title = title || "Group"; this._bounding = [0, 0, 100, 100]; this.color = ""; }
    serialize() { return { title: this.title, bounding: this._bounding.slice(), color: this.color }; }
    configure(d) { if (d.title != null) this.title = d.title; if (d.bounding) this._bounding = d.bounding.slice();
                   if (d.color) this.color = d.color; }
  }
  const graph = {
    _nodes: [], _groups: [], links: {}, last_node_id: 0, last_link_id: 0,
    add(x) {
      if (x instanceof Group) { this._groups.push(x); return; }
      if (x.id == null || x.id === -1 || this.getNodeById(x.id)) x.id = ++this.last_node_id;
      else this.last_node_id = Math.max(this.last_node_id, x.id);
      x.graph = this; this._nodes.push(x);
    },
    remove(x) {
      if (x instanceof Group) { this._groups.splice(this._groups.indexOf(x), 1); return; }
      x.inputs.forEach((_, i) => x.disconnectInput(i));
      for (const o of x.outputs) for (const id of [...o.links]) {
        const l = this.links[id]; const t = l && this.getNodeById(l.target_id);
        if (t) t.disconnectInput(l.target_slot);
      }
      this._nodes.splice(this._nodes.indexOf(x), 1);
    },
    getNodeById(id) { return this._nodes.find((n) => String(n.id) === String(id)) || null; },
    setDirtyCanvas() {}, beforeChange() {}, afterChange() {},
  };
  window.LiteGraph = {
    registered_node_types: Object.fromEntries(Object.keys(specs).map((k) => [k, true])),
    createNode(t) { return specs[t] ? new Node(t) : null; },
    LGraphGroup: Group,
  };
  window.__graph = graph;
}
"""

# scene: {nodes: [[id, type, x, y, {widget: value}]], links: [[from, out, to, slot]], groups: [[title, x, y, w, h]]}
RUN = r"""
([scene, ev]) => {
  const g = window.__graph;
  for (const [id, type, x, y, values] of scene.nodes) {
    const n = window.LiteGraph.createNode(type);
    n.id = id; n.pos = [x, y];
    for (const [k, v] of Object.entries(values || {})) n.widgets.find((w) => w.name === k).value = v;
    g.add(n);
  }
  for (const [a, out, b, slot] of scene.links) g.getNodeById(a).connect(out, g.getNodeById(b), slot);
  for (const [title, x, y, w, h] of scene.groups || []) {
    const gr = new window.LiteGraph.LGraphGroup(title); gr.configure({ bounding: [x, y, w, h] }); g.add(gr);
  }
  const chat = new window.__AgentChat();
  chat._turnGraph = g;
  const res = chat._editGraph(ev);
  const src = (n, slot) => { const l = n.inputs[slot].link != null ? g.links[n.inputs[slot].link] : null;
                             return l ? [String(l.origin_id), l.origin_slot] : null; };
  return {
    res,
    nodes: g._nodes.map((n) => ({ id: String(n.id), type: n.type, pos: n.pos.slice(), size: n.size.slice(),
      inputs: n.inputs.map((_, i) => src(n, i)),
      out_links: n.outputs.reduce((a, o) => a + o.links.length, 0),
      widgets: Object.fromEntries(n.widgets.map((w) => [w.name, w.value])) })),
    groups: g._groups.map((gr) => ({ title: gr.title, rect: gr._bounding.slice() })),
  };
}
"""

TITLE = 30


def rect(n):
    return [n["pos"][0], n["pos"][1] - TITLE, n["size"][0], n["size"][1] + TITLE]


def overlaps(a, b):
    return a[0] < b[0] + b[2] and a[0] + a[2] > b[0] and a[1] < b[1] + b[3] and a[1] + a[3] > b[1]


def branch_ops(src, first_id, copy=False, patch=True, dup_on=True):
    """The edit the host sends for: invert the loader `src` and preview it."""
    ops, n = [], first_id
    feed = src
    if copy:
        ops.append({"op": "add", "node_id": str(n), "class_type": "LoadImage", "params": {"image": "cat.png"},
                    "defaults": {}, "near": None, "duplicate_of": str(src)})
        feed, n = n, n + 1
    inv, pv = n, n + 1
    ops += [{"op": "add", "node_id": str(inv), "class_type": "ImageInvert", "params": {}, "defaults": {},
             "near": str(feed)},
            {"op": "add", "node_id": str(pv), "class_type": "PreviewImage", "params": {}, "defaults": {},
             "near": str(inv)},
            {"op": "connect", "from": str(feed), "output": 0, "to": str(inv), "input": "image",
             "slot_type": "IMAGE"},
            {"op": "connect", "from": str(inv), "output": 0, "to": str(pv), "input": "images",
             "slot_type": "IMAGE"}]
    ev = {"op": "edit_graph", "ops": ops, "reason": "invert", "duplicate_sources": dup_on}
    if patch:
        ev["patch_id"] = "p1"
    return ev, str(inv), str(pv)


@unittest.skipIf(sync_playwright is None, "needs playwright")
class ChainPlacementBrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = None
        for channel in ("msedge", "chrome", None):
            try:
                kw = {"headless": True}
                cls.browser = cls.pw.chromium.launch(channel=channel, **kw) if channel else cls.pw.chromium.launch(**kw)
                break
            except Exception:
                continue
        if cls.browser is None:
            cls.pw.stop()
            raise unittest.SkipTest("no browser for playwright")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.ctx = self.browser.new_context()
        self.ctx.route("**/*", self._serve)
        self.errors = []

    def tearDown(self):
        self.ctx.close()

    def _serve(self, route):
        url = route.request.url
        if not url.startswith(ORIGIN):
            return route.fulfill(status=404, body="")
        path = url[len(ORIGIN):].split("?")[0]
        if path in ("/", "/index.html"):
            return route.fulfill(status=200, content_type="text/html", body=PAGE)
        if path == "/scripts/app.js":
            return route.fulfill(status=200, content_type="text/javascript", body=APP_STUB)
        if path == "/scripts/api.js":
            return route.fulfill(status=200, content_type="text/javascript", body=API_STUB)
        if path.startswith("/extensions/agentY/"):
            f = WEB / path[len("/extensions/agentY/"):]
            if not f.is_file():
                return route.fulfill(status=404, body="")
            body = f.read_bytes()
            if f.name == "agent_chat.js":       # the harness's handle on the panel class
                body += b"\nwindow.__AgentChat = AgentChat;\n"
            return route.fulfill(status=200, content_type=TYPES.get(f.suffix, "application/octet-stream"), body=body)
        if path == "/agentY/canvas_probe":
            return route.fulfill(status=503, body="")
        if "stream" in path or path.endswith("/status") or path.endswith("/notifications"):
            return route.fulfill(status=204, body="")
        return route.fulfill(status=200, content_type="application/json", body="{}")

    def run_edit(self, scene, ev):
        page = self.ctx.new_page()
        page.on("pageerror", lambda e: self.errors.append(str(e)))
        page.goto(ORIGIN + "/")
        page.wait_for_function("window.__ready === true", timeout=20000)
        page.evaluate(LITEGRAPH, SPECS)
        got = page.evaluate(RUN, [scene, ev])
        page.close()
        got["by_id"] = {n["id"]: n for n in got["nodes"]}
        return got

    def assert_tidy(self, scene, got, new_ids):
        """Nothing that was there moved; no new node lands on it, or on another new one."""
        before = {str(n[0]): (n[2], n[3]) for n in scene["nodes"]}
        old = [got["by_id"][i] for i in before]
        for n in old:
            self.assertEqual(tuple(n["pos"]), before[n["id"]], f"#{n['id']} was moved")
        walls = [rect(n) for n in old] + [g[1:] for g in scene.get("groups") or []]
        fresh = [got["by_id"][i] for i in new_ids]
        for n in fresh:
            for w in walls:
                self.assertFalse(overlaps(rect(n), w), f"new #{n['id']} {n['type']} lands on {w}")
        for a in fresh:
            for b in fresh:
                if a["id"] < b["id"]:
                    self.assertFalse(overlaps(rect(a), rect(b)), f"#{a['id']} and #{b['id']} overlap")

    # -- the cases ---------------------------------------------------------------------
    def used_scene(self):
        return {"nodes": [[5, "LoadImage", 100, 100, {"image": "cat.png"}], [6, "ImageScaleBy", 520, 100, {}],
                          [7, "PreviewImage", 900, 100, {}]],
                "links": [[5, 0, 6, 0], [6, 0, 7, 0]]}

    def test_a_used_loader_is_copied_and_the_chain_goes_into_free_space(self):
        scene = self.used_scene()
        ev, inv, pv = branch_ops(5, 8, copy=True)
        got = self.run_edit(scene, ev)
        self.assertEqual(self.errors, [])
        n = got["by_id"]
        self.assertEqual(n["8"]["type"], "LoadImage")
        self.assertEqual(n["8"]["widgets"]["image"], "cat.png", "the same picture")
        self.assertEqual(n[inv]["inputs"][0], ["8", 0], "the chain reads the copy")
        self.assertEqual(n["6"]["inputs"][0], ["5", 0], "the original keeps its wire")
        self.assertEqual(n["5"]["out_links"], 1)
        self.assertTrue(got["res"]["ok"])
        self.assertEqual(got["res"]["duplicated"], [], "the host made this copy: nothing to tell it")
        self.assert_tidy(scene, got, ["8", inv, pv])
        self.assertLess(n["8"]["pos"][0], n[inv]["pos"][0], "the copy is the block's first column")
        self.assertLess(n[inv]["pos"][0], n[pv]["pos"][0])
        self.assertEqual([g["title"] for g in got["groups"]], ["agent_1"])
        box = got["groups"][0]["rect"]
        for i in ("8", inv, pv):
            r = rect(n[i])
            self.assertTrue(box[0] <= r[0] and box[1] <= r[1] and r[0] + r[2] <= box[0] + box[2]
                            and r[1] + r[3] <= box[1] + box[3], f"#{i} is inside its group")

    def bare_scene(self, boxed=None):
        scene = {"nodes": [[5, "LoadImage", 100, 100, {"image": "cat.png"}], [6, "ImageScaleBy", 520, 100, {}],
                           [7, "PreviewImage", 900, 100, {}], [8, "LoadImage", 100, 900, {"image": "dog.png"}]],
                 "links": [[5, 0, 6, 0], [6, 0, 7, 0]]}
        if boxed == "node":
            scene["nodes"].append([9, "KSampler", 520, 880, {}])
        elif boxed == "group":
            scene["groups"] = [["my loaders", 60, 820, 450, 500]]
        return scene

    def test_a_bare_loader_with_room_is_wired_in_place(self):
        scene = self.bare_scene()
        ev, inv, pv = branch_ops(8, 9)
        got = self.run_edit(scene, ev)
        self.assertEqual(self.errors, [])
        n = got["by_id"]
        self.assertEqual(n[inv]["inputs"][0], ["8", 0])
        self.assertEqual(len(got["nodes"]), 6, "no copy")
        self.assertEqual(got["res"]["duplicated"], [])
        self.assertEqual(n[inv]["pos"][1], 900, "level with the loader")
        self.assertGreater(n[inv]["pos"][0], 100 + n["8"]["size"][0], "right of it")
        self.assert_tidy(scene, got, [inv, pv])

    def test_a_boxed_in_bare_loader_is_copied(self):
        for boxed in ("node", "group"):
            with self.subTest(boxed=boxed):
                scene = self.bare_scene(boxed)
                first = 10 if boxed == "node" else 9
                ev, inv, pv = branch_ops(8, first)
                got = self.run_edit(scene, ev)
                self.assertEqual(self.errors, [])
                dup = got["res"]["duplicated"]
                self.assertEqual(len(dup), 1)
                self.assertEqual(dup[0]["of"], "8")
                cid = dup[0]["id"]
                n = got["by_id"]
                self.assertEqual(dup[0]["wires"], [[inv, "image", 0]])
                self.assertEqual(n[cid]["widgets"]["image"], "dog.png")
                self.assertEqual(n[inv]["inputs"][0], [cid, 0])
                self.assertEqual(n["8"]["out_links"], 0, "the original is left as it was: bare")
                self.assert_tidy(scene, got, [cid, inv, pv])

    def test_switched_off_there_is_no_copy_but_still_free_space(self):
        scene = self.bare_scene("node")
        ev, inv, pv = branch_ops(8, 10, dup_on=False)
        got = self.run_edit(scene, ev)
        self.assertEqual(got["res"]["duplicated"], [])
        self.assertEqual(got["by_id"][inv]["inputs"][0], ["8", 0])
        self.assert_tidy(scene, got, [inv, pv])

    def test_without_an_acknowledgement_there_is_no_copy(self):
        """A copy the host never hears of would put its id out of step with the canvas."""
        scene = self.bare_scene("node")
        ev, inv, pv = branch_ops(8, 10, patch=False)
        got = self.run_edit(scene, ev)
        self.assertEqual(got["res"]["duplicated"], [])
        self.assert_tidy(scene, got, [inv, pv])

    def test_twenty_random_canvases(self):
        rnd = random.Random(20261031)
        types = ["ImageScaleBy", "PreviewImage", "KSampler", "LoadImage"]
        for k in range(20):
            with self.subTest(canvas=k):
                nodes = [[1, "LoadImage", rnd.randint(-400, 2400), rnd.randint(-300, 1600), {"image": "cat.png"}]]
                for i in range(2, 2 + rnd.randint(2, 14)):
                    nodes.append([i, rnd.choice(types), rnd.randint(-400, 2400), rnd.randint(-300, 1600), {}])
                links = []
                used = rnd.random() < 0.5
                takers = [n for n in nodes[1:] if n[1] in ("ImageScaleBy", "PreviewImage")]
                if used and takers:
                    links.append([1, 0, takers[0][0], 0])
                groups = []
                if rnd.random() < 0.6:
                    groups.append(["theirs", rnd.randint(-200, 2000), rnd.randint(-200, 1400),
                                   rnd.randint(300, 900), rnd.randint(300, 900)])
                scene = {"nodes": nodes, "links": links, "groups": groups}
                first = len(nodes) + 1
                ev, inv, pv = branch_ops(1, first, copy=bool(links))
                got = self.run_edit(scene, ev)
                self.assertEqual(self.errors, [])
                new = [str(first)] if links else []
                new += [d["id"] for d in got["res"]["duplicated"]]
                self.assert_tidy(scene, got, new + [inv, pv])


if __name__ == "__main__":
    unittest.main()
