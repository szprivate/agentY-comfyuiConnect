"""The history-panel selection: what the page sends, and the route that reads it.

``web/agent_history_selection.js`` reads the bEpic viewer's history strip
(``window.bEpicViewerApi.historySelection``) and ComfyUI's assets sidebar (the
``assetSelection`` Pinia store). Its pure parts run under node when it is
installed; the wiring (each message carries it, the relay answers it) is pinned
by text.

    python -m unittest tests.test_history_selection
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SRC = (WEB / "agent_history_selection.js").read_text(encoding="utf-8")
NODE = shutil.which("node")


class Wiring(unittest.TestCase):

    def test_every_message_and_canvas_post_carries_it(self):
        chat = (WEB / "agent_chat.js").read_text(encoding="utf-8")
        self.assertEqual(chat.count("history_selection: this._historySelection(),"), 3)
        self.assertIn('from "./agent_history_selection.js"', chat)

    def test_the_page_answers_the_live_read(self):
        canvas = (WEB / "agent_canvas.js").read_text(encoding="utf-8")
        self.assertIn('api.addEventListener("agent.request_history_selection"', canvas)
        init = (ROOT / "__init__.py").read_text(encoding="utf-8")
        self.assertIn('@_routes.get("/agent/history_selection")', init)
        self.assertIn('"agent.request_history_selection"', init)

    def test_it_reads_the_viewer_and_the_assets_store_by_name(self):
        self.assertIn("api.historySelection", SRC)
        self.assertIn('stores.get("assetSelection")', SRC)


@unittest.skipUnless(NODE, "node is not installed")
class PureParts(unittest.TestCase):

    def _run(self, body: str):
        with tempfile.TemporaryDirectory() as d:
            mod = Path(d) / "m.mjs"
            mod.write_text(SRC, encoding="utf-8")
            test = Path(d) / "t.mjs"
            test.write_text(f'import * as M from "./m.mjs";\n{body}\n', encoding="utf-8")
            res = subprocess.run([NODE, str(test)], capture_output=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr.decode("utf-8", "replace"))
        return json.loads(res.stdout.decode("utf-8"))

    def test_viewer_answer_passes_through_and_an_empty_one_is_null(self):
        got = self._run(
            'const a = M.viewerSelection({ historySelection: () => ({ items: [{ path: "x.png" }], count: 1 }) });\n'
            'const b = M.viewerSelection({ historySelection: () => ({ items: [], count: 0 }) });\n'
            'const c = M.viewerSelection({ historySelection: () => { throw new Error("x"); } });\n'
            'const d = M.viewerSelection(null);\n'
            'console.log(JSON.stringify([a, b, c, d]));')
        self.assertEqual(got[0]["items"][0]["path"], "x.png")
        self.assertEqual(got[1:], [None, None, None])

    def test_assets_ids_from_the_store_array_or_set(self):
        got = self._run(
            'const st = (v) => ({ get: (n) => n === "assetSelection" ? v : undefined });\n'
            'const a = M.assetsSelection(st({ selectedIdsArray: ["j1", "", "j2"] }));\n'
            'const b = M.assetsSelection(st({ selectedAssetIds: new Set(["k"]) }));\n'
            'const c = M.assetsSelection(st({ selectedIdsArray: [] }));\n'
            'const d = M.assetsSelection({ get: () => undefined });\n'
            'console.log(JSON.stringify([a, b, c, d]));')
        self.assertEqual(got[0], {"source": "comfy_assets", "count": 2, "ids": ["j1", "j2"]})
        self.assertEqual(got[1]["ids"], ["k"])
        self.assertEqual(got[2:], [None, None])


if __name__ == "__main__":
    unittest.main()
