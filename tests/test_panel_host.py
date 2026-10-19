"""Where the agentY panel is shown, and what can be dropped on it.

The panel is ONE DOM, moved between the ComfyUI sidebar and a dock panel of the
bEpic viewer (ComfyUI-ImageViewer). The two meet in window.agentYPanelHost and
window.bEpicViewerApi, and a viewer drag carries "application/x-bepic-history", so
the names are pinned here. Run under node when it is installed.

    python -m unittest tests.test_panel_host
"""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"
HOST = (WEB / "agent_panel_host.js").read_text(encoding="utf-8")
CHAT = (WEB / "agent_chat.js").read_text(encoding="utf-8")


class Contract(unittest.TestCase):

    def test_the_viewer_finds_the_host_under_its_name(self):
        for member in ("mountInto(elm, opts)", "toSidebar(opts)", "where()"):
            self.assertIn(member, CHAT)
        self.assertIn("window.agentYPanelHost = {", CHAT)

    def test_the_host_exists_before_the_sidebar_was_ever_opened(self):
        # It builds the panel on first use rather than waiting for the sidebar tab.
        self.assertIn("if (!_AGENTY_CHAT) _AGENTY_CHAT = new AgentChat();\n    _AGENTY_CHAT.mountInto", CHAT.replace("\r\n", "\n"))

    def test_a_viewer_drag_is_read_by_the_type_the_viewer_sets(self):
        self.assertIn('"application/x-bepic-history"', HOST)

    def test_the_viewer_calls_are_the_ones_it_offers(self):
        for name in ("openAgentPanel", "closeAgentPanel", "extractFrame"):
            self.assertIn(name, HOST)

    def test_a_dropped_picture_is_an_attachment_like_the_paperclips(self):
        # Same shape ({path, name}) and the same upload route as _onFiles used.
        self.assertIn("/agentY/upload", HOST)
        self.assertIn("chat.attachments.push", HOST)
        self.assertIn("await this.attachFiles(files)", CHAT)

    def test_a_sidebar_opened_while_the_panel_is_away_does_not_steal_it(self):
        self.assertIn('this._where === "viewer" && elm !== this._viewerEl', CHAT)


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class Behaviour(unittest.TestCase):
    """The real module with a minimal DOM: a viewer drop becomes attachments."""

    def test_viewer_items_become_attachments(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, True)
        (d / "package.json").write_text('{"type":"module"}')
        (d / "scripts").mkdir()
        (d / "scripts" / "app.js").write_text("export const app = {};")
        (d / "scripts" / "api.js").write_text("export const api = { apiURL: (p) => p };")
        (d / "web").mkdir()
        src = HOST.replace('"../../scripts/', '"../scripts/')
        (d / "web" / "agent_panel_host.js").write_text(src, encoding="utf-8")
        (d / "web" / "agent_backend.js").write_text('export const backendBase = () => "http://h";')
        (d / "run.mjs").write_text(r'''
const uploads = [];
globalThis.File = class { constructor(parts, name, o) { this.name = name; } };
globalThis.FormData = class { append(k, f) { this.f = f; } };
globalThis.fetch = async (url, o) => {
  if (url.endsWith("/agentY/upload")) { uploads.push(o.body.f.name); return { ok: true, json: async () => ({ path: "/up/" + o.body.f.name, name: "x_" + o.body.f.name }) }; }
  return { ok: true, blob: async () => ({ type: "image/png" }) };
};
const mk = () => { const n = { children: [], style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {},
  append(...c) { this.children.push(...c); }, addEventListener() {}, querySelector() { return null; }, setAttribute() {} }; return n; };
globalThis.document = { createElement: mk, getElementById: () => null, head: mk() };
const { installPanelHost } = await import("./web/agent_panel_host.js");
const sys = [];
const chat = { wrap: Object.assign(mk(), { contains: () => false, querySelector: () => mk() }), attachments: [],
  _sys: (t) => sys.push(t), _renderAttachments() {}, mount() {} };
installPanelHost(chat);
await chat.attachViewerItems([
  { path: "D:/a/pic.png", kind: "image" },                              // on disk: attached in place
  { path: "pic2.png", filename: "drop_pic2.png", url: "/media/p2.png", dropped: true, kind: "image" },  // browser only: uploaded
  { isSequence: true, seqDir: "D:/seq", seqCount: 12, path: "D:/seq/f1.png" },
  { path: "D:/a/pic.png", kind: "image" },                              // twice: once
]);
console.log(JSON.stringify({ attachments: chat.attachments, uploads, sys }));
''')
        out = subprocess.run(["node", "run.mjs"], cwd=d, capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        import json
        got = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(got["attachments"], [
            {"path": "D:/a/pic.png", "name": "pic.png"},
            {"path": "/up/drop_pic2.png", "name": "x_drop_pic2.png"},
            {"path": "D:/seq", "name": "seq (12 frames)"},
        ])
        self.assertEqual(got["uploads"], ["drop_pic2.png"])
        self.assertEqual(got["sys"], [])


if __name__ == "__main__":
    unittest.main()
