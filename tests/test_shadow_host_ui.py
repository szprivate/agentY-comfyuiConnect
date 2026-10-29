"""The # tag menu and the conversation menu / Manage page inside the bEpic viewer.

The viewer shows the panel inside a shadow root. There a document-level listener
sees the event retargeted to the shadow host, `document.body` is hidden by the
viewer's full-screen mode, and the page's stylesheet does not apply. Pure helpers
run under node when it is installed; the wiring is read from the sources.

    python -m unittest tests.test_shadow_host_ui
"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
TAGS = (WEB / "agent_tags.js").read_text(encoding="utf-8")
CHAT = (WEB / "agent_chat.js").read_text(encoding="utf-8")
CONV = (WEB / "agent_conversations.js").read_text(encoding="utf-8")
HOST = (WEB / "agent_panel_host.js").read_text(encoding="utf-8")
ROOT = WEB / "agent_ui_root.js"


class Wiring(unittest.TestCase):
    def test_tag_menu_reads_the_real_target(self):
        body = TAGS[TAGS.index("function textareaFor"):TAGS.index("function onInput")]
        self.assertIn("eventTarget(e)", body)
        self.assertNotIn("e.target", TAGS)

    def test_tag_menu_is_mounted_beside_the_box(self):
        self.assertIn("uiRoot(ta)", TAGS)
        self.assertNotIn("document.body.appendChild(menu.el)", TAGS)

    def test_popout_documents_get_the_listeners(self):
        self.assertIn("export function watchDocument", TAGS)
        self.assertIn("watchDocument(elm.ownerDocument)", HOST)

    def test_conversation_menu_closes_on_the_composed_path(self):
        self.assertIn("eventInside(e, menu)", CHAT)
        self.assertNotIn("menu.contains(e.target)", CHAT)

    def test_manage_page_mounts_beside_the_panel(self):
        self.assertIn("uiRoot(ctx.anchor)", CONV)
        self.assertNotIn("document.body.append(overlay)", CONV)
        self.assertIn("anchor: this.wrap", CHAT)


@unittest.skipUnless(shutil.which("node"), "node not installed")
class Helpers(unittest.TestCase):
    def run_js(self, body):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "m.mjs").write_text(ROOT.read_text(encoding="utf-8"), encoding="utf-8")
            (Path(d) / "t.mjs").write_text('import * as u from "./m.mjs";\n' + body, encoding="utf-8")
            r = subprocess.run(["node", str(Path(d) / "t.mjs")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_target_and_inside_use_the_composed_path(self):
        self.run_js("""
import assert from "node:assert";
const ta = {}, host = {}, menu = {contains: () => false};
const e = { target: host, composedPath: () => [ta, {}, host] };
assert.strictEqual(u.eventTarget(e), ta);
assert.ok(u.eventInside(e, ta));
assert.ok(!u.eventInside(e, menu));
assert.strictEqual(u.eventTarget({ target: host }), host);
assert.ok(u.eventInside({ target: ta }, { contains: (n) => n === ta }));
""")

    def test_uiRoot_picks_the_shadow_root_else_the_body(self):
        self.run_js("""
import assert from "node:assert";
const body = {}, doc = { body };
const shadow = { host: {}, appendChild() {} };
assert.strictEqual(u.uiRoot({ ownerDocument: doc, getRootNode: () => shadow }), shadow);
assert.strictEqual(u.uiRoot({ ownerDocument: doc, getRootNode: () => doc }), body);
""")


if __name__ == "__main__":
    unittest.main()
