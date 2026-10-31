"""The Manage tags page and the tag operations behind it, read as source and run under node.

The browser tests (test_tag_manager_browser.py) drive the page in all four hosts; this
pins the rules that must hold whatever the page looks like, and runs the pure helpers
of web/agent_tag_ops.js (the rows, sorting, filtering, the name check) under node.

    python -m unittest tests.test_tag_manager_page
"""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"
PAGE = (WEB / "agent_tag_manager.js").read_text(encoding="utf-8")
OPS = (WEB / "agent_tag_ops.js").read_text(encoding="utf-8")
TAGS = (WEB / "agent_tags.js").read_text(encoding="utf-8")
CHAT = (WEB / "agent_chat.js").read_text(encoding="utf-8")


class Rules(unittest.TestCase):

    def test_nothing_is_parsed_as_html(self):
        for name, src in (("agent_tag_manager.js", PAGE), ("agent_tag_ops.js", OPS)):
            self.assertNotIn("innerHTML", src, name)
            self.assertNotIn("insertAdjacentHTML", src, name)
            self.assertNotIn("outerHTML", src, name)

    def test_confirmations_are_in_the_page(self):
        self.assertNotIn("confirm(", PAGE.replace("ask(", ""))
        self.assertIn("ask(", PAGE)

    def test_it_mounts_beside_what_asked_in_that_window(self):
        self.assertIn("uiRoot(ctx.anchor)", PAGE)
        self.assertIn("ensureStyleIn(parent, STYLE_ID, STYLES)", PAGE)
        self.assertIn("doc.createElement", PAGE)
        self.assertIn('doc.addEventListener("keydown", onKey, true)', PAGE)
        self.assertNotIn("document.addEventListener", PAGE)
        self.assertNotIn("document.body", PAGE)

    def test_it_is_in_the_panel_menu(self):
        body = CHAT.split("_renderConvMenu(mode) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn("Manage tags", body)
        self.assertIn("openTagManager({ anchor: this.wrap })", body)

    def test_the_host_routes_are_the_hosts(self):
        for route in ("/agentY/tags", "/agentY/tags/rename", "/agentY/tags/delete",
                      "/agentY/tags/untag", "/agentY/tags/merge"):
            self.assertIn(f'"{route}"', OPS)

    def test_thumbnails_are_capped_and_lazy(self):
        self.assertIn("GRID_CAP", PAGE)
        self.assertIn("IntersectionObserver", PAGE)
        self.assertIn("/bepic/thumb?", PAGE)

    def test_the_hash_menu_compares_tags_by_their_identity(self):
        body = TAGS.split("export async function agentTagList")[1].split("function primeRemembered")[0]
        self.assertIn("tagKey(", body)
        self.assertIn("e.tag || e.name", TAGS)


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class Helpers(unittest.TestCase):

    def run_ops(self, body):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, True)
        (d / "package.json").write_text('{"type":"module"}')
        (d / "app.js").write_text("export const app = { graph: null, registerExtension() {} };")
        (d / "backend.js").write_text('export const backendBase = () => "http://host";')
        (d / "ui_root.js").write_text("export const eventTarget = () => null, eventInside = () => false,"
                                      " uiRoot = () => null, ensureStyleIn = () => {};")
        tags = (TAGS.replace('"../../scripts/app.js"', '"./app.js"')
                    .replace('"./agent_ui_root.js"', '"./ui_root.js"'))
        (d / "agent_tags.js").write_text(tags, encoding="utf-8")
        (d / "ops.js").write_text(OPS.replace('"./agent_backend.js"', '"./backend.js"'), encoding="utf-8")
        (d / "run.js").write_text("globalThis.window = globalThis;\n"
                                  "const o = await import('./ops.js');\n" + body, encoding="utf-8")
        out = subprocess.run(["node", "run.js"], cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout.strip().splitlines()[-1])

    def test_rows_join_the_canvas_and_the_store_by_identity(self):
        r = self.run_ops(
            "const rows = o.buildTagRows("
            "  [{ tag: 'hero_face', origin: 'canvas', path: 'D:/in/hero.png', exists: true },"
            "   { tag: 'set', origin: 'viewer', path: 'D:/out/set.png', exists: false }],"
            "  [{ tag: 'Hero-Face', role: 'r', nodes: [{ id: '12', title: 't', path: 'hero.png' }], paths: ['hero.png'] }]);\n"
            "console.log(JSON.stringify(rows.map((x) => ({ tag: x.tag, key: x.key, src: o.sourceText(x),"
            "  images: x.images.map((i) => [i.path, i.from, i.exists]) }))));")
        self.assertEqual(r, [
            {"tag": "Hero-Face", "key": "hero-face", "src": "canvas node #12 · remembered",
             "images": [["D:/in/hero.png", ["canvas", "memory"], True]]},
            {"tag": "set", "key": "set", "src": "viewer", "images": [["D:/out/set.png", ["memory"], False]]},
        ])

    def test_sort_filter_and_names(self):
        r = self.run_ops(
            "const rows = [{ tag: 'b', images: [1, 2], sources: [] }, { tag: 'A', images: [1], sources: [] },"
            "              { tag: 'c', images: [], sources: [], role: 'the hero' }];\n"
            "console.log(JSON.stringify({"
            "  byName: o.sortTagRows(rows, 'tag', 1).map((x) => x.tag),"
            "  byCount: o.sortTagRows(rows, 'images', -1).map((x) => x.tag),"
            "  found: o.filterTagRows(rows, '#HERO').map((x) => x.tag),"
            "  names: ['hero face', '', '123', 'x'.repeat(65), '<b>x</b>'].map((n) => o.checkTagName(n)) }));")
        self.assertEqual(r["byName"], ["A", "b", "c"])
        self.assertEqual(r["byCount"], ["b", "A", "c"])
        self.assertEqual(r["found"], ["c"])
        self.assertEqual(r["names"][0], {"name": "hero_face", "error": ""})
        for bad in r["names"][1:4]:
            self.assertTrue(bad["error"], bad)
        self.assertEqual(r["names"][4]["name"], "b_x_b")


if __name__ == "__main__":
    unittest.main()


class StoreNames(unittest.TestCase):
    """/agent/pm_names says the name a remembered tag is written with, not its file's."""

    def setUp(self):
        import re
        src = (Path(__file__).resolve().parents[1] / "__init__.py").read_text(encoding="utf-8")
        start = src.index("def _pm_slug(")
        end = src.index("def _pm_find(")
        self.ns = {"_re": re}
        exec(src[start:end], self.ns)  # noqa: S102 - our own source

    def test_the_written_name_and_who_made_it(self):
        name, origin = self.ns["_pm_tag_name"], self.ns["_pm_tag_origin"]
        viewer = "Anna.\npath: D:/a.png\nTagged `#Hero_Face` for agentY from the bEpic viewer's history."
        self.assertEqual((name("hero-face", viewer), origin(viewer)), ("Hero_Face", "viewer"))
        canvas = "x\nRemembered from the `agentY add tag` node tagged `#alley_light` on a canvas."
        self.assertEqual((name("alley-light", canvas), origin(canvas)), ("alley_light", "canvas"))
        # an entry naming some other tag keeps its file's name
        self.assertEqual((name("set", "see `#hero`"), origin("see `#hero`")), ("set", "agent"))
        src = (Path(__file__).resolve().parents[1] / "__init__.py").read_text(encoding="utf-8")
        self.assertIn('"tag": _pm_tag_name(f.stem, body)', src)
