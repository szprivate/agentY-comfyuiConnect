"""What the bEpic viewer shows, and the marks on it: what the page sends, and the routes that read it.

``web/agent_viewer_state.js`` asks the viewer (``window.bEpicViewerApi.viewerState`` /
``.annotations``); each chat message carries ``viewer_state`` (null while the viewer is closed), and
``/agent/viewer_state`` / ``/agent/viewer_annotations`` relay a live read through the open page. The
routes run here for real: this module's route code on a private aiohttp app, ComfyUI's server stubbed,
the page played by a stub that answers the websocket event.

    python -m unittest tests.test_viewer_state
"""

import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:  # pragma: no cover
    web = None

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SRC = (WEB / "agent_viewer_state.js").read_text(encoding="utf-8")
NODE = shutil.which("node")

STATE = {"source": "viewer", "open": True, "visible": True, "display": "popout",
         "tab": {"key": "named:agentY", "label": "agentY"}, "item": {"index": 0, "path": "D:/out/a.png"},
         "annotations": {"count": 2}}
MARKS = {"kind": "image", "count": 2, "source": "D:/out/a.png", "annotations": [{"notes": ["logo"], "marks": []}]}


class Wiring(unittest.TestCase):

    def test_every_message_and_canvas_post_carries_it(self):
        chat = (WEB / "agent_chat.js").read_text(encoding="utf-8")
        self.assertEqual(chat.count("viewer_state: this._viewerState(),"), 3)
        self.assertEqual(chat.count("history_selection: this._historySelection(),"), 3)
        self.assertIn('from "./agent_viewer_state.js"', chat)

    def test_the_page_answers_the_live_reads(self):
        canvas = (WEB / "agent_canvas.js").read_text(encoding="utf-8")
        self.assertIn('api.addEventListener("agent.request_viewer_state"', canvas)
        self.assertIn('api.addEventListener("agent.request_viewer_annotations"', canvas)
        init = (ROOT / "__init__.py").read_text(encoding="utf-8")
        for route in ("/agent/viewer_state", "/agent/viewer_annotations"):
            self.assertIn(f'@_routes.get("{route}")\n    @_guarded', init)

    def test_it_reads_the_viewers_js_api_not_its_dom(self):
        self.assertIn("api.viewerState", SRC)
        self.assertIn("api.annotations", SRC)
        self.assertNotIn("shadowRoot", SRC)
        self.assertNotIn("querySelector", SRC)


@unittest.skipUnless(NODE, "node is not installed")
class PureParts(unittest.TestCase):

    def _run(self, body: str):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "m.mjs").write_text(SRC, encoding="utf-8")
            test = Path(d) / "t.mjs"
            test.write_text(f'import * as M from "./m.mjs";\n{body}\n', encoding="utf-8")
            res = subprocess.run([NODE, str(test)], capture_output=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr.decode("utf-8", "replace"))
        return json.loads(res.stdout.decode("utf-8"))

    def test_a_closed_viewer_or_none_sends_nothing(self):
        got = self._run(
            'const a = M.collectViewerState({ viewerState: () => ({ open: true, tab: { key: "t" } }) });\n'
            'const b = M.collectViewerState({ viewerState: () => ({ open: false, display: "closed" }) });\n'
            'const c = M.collectViewerState({ viewerState: () => { throw new Error("x"); } });\n'
            'const d = M.collectViewerState(null);\n'
            'const e = [M.viewerAnswers({ viewerState() {} }), M.viewerAnswers({ historySelection() {} })];\n'
            'console.log(JSON.stringify([a, b, c, d, e]));')
        self.assertEqual(got[0]["tab"]["key"], "t")
        self.assertEqual(got[1:4], [None, None, None])
        self.assertEqual(got[4], [True, False])

    def test_annotations_pass_the_frame_and_raw_on(self):
        got = self._run(
            'let seen = null;\n'
            'const api = { annotations: (o) => { seen = o; return { count: 1 }; } };\n'
            'const a = M.collectViewerAnnotations({ frame: 12, raw: true }, api);\n'
            'const s1 = seen;\n'
            'M.collectViewerAnnotations({ frame: -1 }, api);\n'
            'const b = M.collectViewerAnnotations({}, {});\n'
            'console.log(JSON.stringify([a, s1, seen, b]));')
        self.assertEqual(got, [{"count": 1}, {"frame": 12, "raw": True}, {}, None])


def _load_routes(answer):
    """The module's route code on a fresh RouteTableDef; `answer(event, payload)` plays the page."""
    src = (ROOT / "__init__.py").read_text(encoding="utf-8")
    head = src[:src.index("from comfy_api.latest import")]
    routes = web.RouteTableDef()
    ns = {"__file__": str(ROOT / "__init__.py"), "__name__": "agentyconnect_routes"}

    class Instance:
        def __init__(self):
            self.routes = routes
            self.sent = []

        def send_sync(self, event, payload, sid=None):
            self.sent.append((event, payload))
            reply = answer(event, payload)
            if reply is not None:
                fut = ns["_pending_replies"][payload["req_id"]]
                asyncio.get_running_loop().call_soon(fut.set_result, reply)

    inst = Instance()
    server = types.ModuleType("server")
    server.PromptServer = type("PromptServer", (), {"instance": inst})
    saved = sys.modules.get("server")
    sys.modules["server"] = server
    try:
        exec(compile(head, "agentyconnect_routes", "exec"), ns)
    finally:
        if saved is None:
            sys.modules.pop("server", None)
        else:
            sys.modules["server"] = saved
    return routes, inst


@unittest.skipIf(web is None, "needs aiohttp")
class Routes(unittest.TestCase):

    def _get(self, answer, path, headers=None):
        routes, inst = _load_routes(answer)

        async def go():
            app = web.Application()
            app.add_routes(routes)
            async with TestClient(TestServer(app)) as c:
                h = {"Host": "127.0.0.1:8188"}
                h.update(headers or {})
                r = await c.get(path, headers=h)
                return r.status, await r.json()
        status, body = asyncio.run(go())
        return status, body, inst.sent

    def test_the_state_is_relayed_as_the_page_sent_it(self):
        status, body, sent = self._get(lambda e, p: {"state": STATE, "installed": True}, "/agent/viewer_state")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True, "installed": True, "state": STATE})
        self.assertEqual(sent[0][0], "agent.request_viewer_state")

    def test_a_closed_viewer_is_ok_with_no_state(self):
        _, body, _ = self._get(lambda e, p: {"state": None, "installed": True}, "/agent/viewer_state")
        self.assertEqual((body["ok"], body["state"]), (True, None))

    def test_an_old_viewer_and_no_page_say_why(self):
        _, body, _ = self._get(lambda e, p: {"state": None, "installed": False}, "/agent/viewer_state")
        self.assertFalse(body["ok"])
        self.assertIn("too old", body["error"])
        _, body, _ = self._get(lambda e, p: None, "/agent/viewer_state?timeout=0.2")
        self.assertFalse(body["ok"])
        self.assertIn("no ComfyUI browser page answered", body["error"])

    def test_annotations_ask_for_the_frame_and_the_raw_marks(self):
        _, body, sent = self._get(lambda e, p: {"annotations": MARKS, "state": STATE, "installed": True},
                                  "/agent/viewer_annotations?frame=12&raw=1")
        self.assertEqual(sent[0][0], "agent.request_viewer_annotations")
        self.assertEqual((sent[0][1]["frame"], sent[0][1]["raw"]), (12, True))
        self.assertEqual((body["ok"], body["annotations"], body["state"]["display"]), (True, MARKS, "popout"))
        _, _, sent = self._get(lambda e, p: {"annotations": MARKS}, "/agent/viewer_annotations")
        self.assertEqual((sent[0][1]["frame"], sent[0][1]["raw"]), (None, False))

    def test_the_guard_refuses_a_foreign_page(self):
        for path in ("/agent/viewer_state", "/agent/viewer_annotations"):
            status, body, sent = self._get(lambda e, p: {"state": STATE}, path,
                                           headers={"Origin": "https://evil.example"})
            self.assertEqual(status, 403, path)
            self.assertEqual(sent, [])
            status, _, sent = self._get(lambda e, p: {"state": STATE}, path, headers={"Host": "evil.example:8188"})
            self.assertEqual((status, sent), (403, []))


if __name__ == "__main__":
    unittest.main()
