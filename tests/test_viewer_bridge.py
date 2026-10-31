"""The one object the bEpic viewer looks for, and what it does with it.

The viewer (ComfyUI-ImageViewer) offers "Tag for agentY" and "Approve for agentY"
only when ``window.agentYViewerBridge`` exists, so the contract is pinned here:
its name, its three members, and that an approval goes through the same two
things "Continue with these" uses - the review collector's ``files`` box and the
panel's ``continue``. Run under node when it is installed.

    python -m unittest tests.test_viewer_bridge
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"
SRC = (WEB / "agent_viewer_bridge.js").read_text(encoding="utf-8")


class Contract(unittest.TestCase):

    def test_the_viewer_finds_it_under_its_name(self):
        self.assertIn("window.agentYViewerBridge = { version: 1, state, tag, approve }", SRC)

    def test_an_approval_is_an_edited_collector_and_a_continue(self):
        self.assertIn('"AgentYImageCollector"', SRC)
        self.assertIn("agentY_review_key", SRC)
        self.assertIn('x.name === "files"', SRC)
        self.assertIn('window.agentYRunHooks("continue", {})', SRC)

    def test_the_review_collector_the_panel_makes_is_the_one_it_looks_for(self):
        chat = (WEB / "agent_chat.js").read_text(encoding="utf-8")
        self.assertIn('const TYPE = "AgentYImageCollector"', chat)
        self.assertIn("node.properties.agentY_review_key = key", chat)

    def test_a_tag_goes_to_the_host_route_the_host_serves(self):
        self.assertIn("/agentY/viewer/tag", SRC)


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class Behaviour(unittest.TestCase):
    """The real module, with ComfyUI's app and the host stubbed."""

    def run_bridge(self, body):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, True)
        (d / "package.json").write_text('{"type":"module"}')
        (d / "app.js").write_text("export const app = globalThis.__app;")
        (d / "backend.js").write_text('export const backendBase = () => "http://host";')
        (d / "tags.js").write_text("export const agentTagList = async (o) => globalThis.__tags(o);\n"
                                   "export const announceTagsChanged = (d) => globalThis.__announced.push(d);")
        (d / "ops.js").write_text("export const untagPicture = async (t, p) => globalThis.__ops('untag', t, p);\n"
                                  "export const clearCanvasTagAt = (t, p) => globalThis.__ops('clear', t, p);")
        (d / "bridge.js").write_text(SRC.replace('"../../scripts/app.js"', '"./app.js"')
                                        .replace('"./agent_backend.js"', '"./backend.js"')
                                        .replace('"./agent_tags.js"', '"./tags.js"')
                                        .replace('"./agent_tag_ops.js"', '"./ops.js"'))
        (d / "run.js").write_text(
            "const calls = [];\n"
            "globalThis.window = globalThis;\n"
            "globalThis.__announced = [];\n"
            "globalThis.__ops = (...a) => { calls.push(a); return { ok: true, op: a[0] }; };\n"
            "const files = { name: 'files', value: '' };\n"
            "const node = { type: 'AgentYImageCollector', properties: { agentY_review_key: 'k' },\n"
            "  widgets: [files], setDirtyCanvas() {} };\n"
            "globalThis.__app = { graph: { _nodes: [node] }, canvas: null };\n"
            "globalThis.fetch = async (url, init) => { calls.push([url, init]);\n"
            "  return { ok: true, status: 200, json: async () => ({ ok: true, tag: 'anna' }) }; };\n"
            "await import('./bridge.js');\n"
            "const b = window.agentYViewerBridge;\n" + body)
        out = subprocess.run(["node", "run.js"], cwd=d, capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout.strip().splitlines()[-1])

    def test_approving_fills_the_collector_then_continues(self):
        r = self.run_bridge(
            "window.agentYReviewHalted = true;\n"
            "window.agentYRunHooks = (t) => { calls.push(['say', t, files.value]); return 'Running'; };\n"
            "const res = await b.approve({ files: ['/o/a.png', '/o/b.png'] });\n"
            "console.log(JSON.stringify({ res, files: files.value, calls: calls.map(c => c[0]) }));")
        self.assertTrue(r["res"]["ok"], r)
        self.assertEqual(r["files"], "/o/a.png\n/o/b.png")
        self.assertEqual(r["calls"], ["say"])

    def test_nothing_is_changed_when_no_review_is_waiting(self):
        r = self.run_bridge(
            "window.agentYReviewHalted = false;\n"
            "window.agentYRunHooks = () => 'Running';\n"
            "const res = await b.approve({ files: ['/o/a.png'] });\n"
            "console.log(JSON.stringify({ res, files: files.value, state: b.state() }));")
        self.assertFalse(r["res"]["ok"])
        self.assertEqual(r["files"], "")
        self.assertEqual(r["state"], {"halted": False})

    def test_a_refused_continue_is_reported_not_swallowed(self):
        r = self.run_bridge(
            "window.agentYReviewHalted = true;\n"
            "window.agentYRunHooks = () => 'agentY is waiting for an answer in the panel';\n"
            "const res = await b.approve({ files: ['/o/a.png'] });\n"
            "console.log(JSON.stringify({ res }));")
        self.assertFalse(r["res"]["ok"])

    def test_a_tag_is_posted_to_the_host(self):
        r = self.run_bridge(
            "const res = await b.tag({ tag: 'anna', path: '/o/a.png', role: 'lead' });\n"
            "console.log(JSON.stringify({ res, url: calls[0][0], body: JSON.parse(calls[0][1].body) }));")
        self.assertTrue(r["res"]["ok"])
        self.assertEqual(r["url"], "http://host/agentY/viewer/tag")
        self.assertEqual(r["body"], {"tag": "anna", "path": "/o/a.png", "role": "lead"})

    def test_a_tag_is_announced_so_the_viewer_and_the_menu_follow(self):
        r = self.run_bridge(
            "await b.tag({ tag: 'anna', path: '/o/a.png' });\n"
            "console.log(JSON.stringify({ announced: globalThis.__announced }));")
        self.assertEqual(r["announced"], [{"tagged": [{"tag": "anna", "path": "/o/a.png"}]}])

    def test_untag_clear_and_manage_go_where_they_should(self):
        r = self.run_bridge(
            "const u = await b.untag({ tag: 'anna', path: '/o/a.png' });\n"
            "const c = b.clearCanvasTag({ tag: 'anna', path: '/o/a.png' });\n"
            "const before = b.manageTags({});\n"
            "window.agentYOpenTagManager = (o) => calls.push(['manage', o.tag]);\n"
            "const after = b.manageTags({ tag: 'anna' });\n"
            "console.log(JSON.stringify({ u, c, before, after, calls }));")
        self.assertEqual((r["u"]["op"], r["c"]["op"]), ("untag", "clear"))
        self.assertEqual(r["calls"], [["untag", "anna", "/o/a.png"], ["clear", "anna", "/o/a.png"], ["manage", "anna"]])
        self.assertEqual((r["before"], r["after"]), (False, True))

    def test_feedback_goes_to_the_panel_as_a_message_with_the_pictures(self):
        r = self.run_bridge(
            "window.agentYReviewHalted = true;\n"
            "window.agentYSendFeedback = (a) => { calls.push(['fb', a]); return 'Sent to agentY.'; };\n"
            "const res = await b.feedback({ text: 'at 00:03 the face drifts', files: ['/o/f.png'] });\n"
            "const none = await b.feedback({ text: '', files: [] });\n"
            "console.log(JSON.stringify({ res, none, call: calls[0][1] }));")
        self.assertTrue(r["res"]["ok"], r)
        self.assertTrue(r["res"]["halted"])
        self.assertEqual(r["call"], {"text": "at 00:03 the face drifts", "files": ["/o/f.png"]})
        self.assertFalse(r["none"]["ok"])

    def test_tags_are_the_hash_menus_list_for_the_viewer_filter(self):
        r = self.run_bridge(
            "globalThis.__tags = async (o) => [{ tag: 'hero_face', path: '/o/h.png', source: 'canvas', opts: o }]; "
            "const list = await b.tags({ fresh: true }); "
            "const none = await b.tags(); "
            "console.log(JSON.stringify({ list, none }));")
        self.assertEqual(r["list"][0]["tag"], "hero_face")
        self.assertEqual(r["list"][0]["opts"], {"fresh": True})
        self.assertEqual(r["none"][0]["opts"], {})

    def test_the_list_is_the_tag_menus_own(self):
        tags = (WEB / "agent_tags.js").read_text(encoding="utf-8")
        body = tags.split("export async function agentTagList")[1].split("function primeRemembered")[0]
        self.assertIn("sceneTags()", body)
        self.assertIn("remembered()", body)

    def test_feedback_never_presses_continue(self):
        self.assertIn("window.agentYViewerBridge.feedback = feedback", SRC)
        body = SRC.split("async function feedback")[1]
        self.assertNotIn("agentYRunHooks", body)


if __name__ == "__main__":
    unittest.main()
