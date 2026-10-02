"""Settings can be read and saved while the agentY host is not running.

The page asks ComfyUI, and ComfyUI runs the checkout's own
``python -m src.utils.settings_offline``. These drive that hand-off against a
stand-in checkout: a folder with a ``src/utils/settings_offline.py`` that echoes
what it was given.
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_platform import _load_head

_HELPER = '''
import json, sys
print("a library says hello")
if sys.argv[1] == "get":
    print(json.dumps({"ok": True, "offline": True, "settings": {"env": {"KEY": "masked"}}}))
elif sys.argv[1] == "save":
    body = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    print(json.dumps({"ok": True, "got": body}))
else:
    print(json.dumps({"ok": False, "error": "boom"})); sys.exit(1)
'''


class OfflineSettings(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "agentY"
        (self.root / "src" / "utils").mkdir(parents=True)
        (self.root / "src" / "__init__.py").write_text("", encoding="utf-8")
        (self.root / "src" / "utils" / "__init__.py").write_text("", encoding="utf-8")
        (self.root / "src" / "utils" / "settings_offline.py").write_text(_HELPER, encoding="utf-8")
        cfg = Path(self.tmp.name) / "host.json"
        cfg.write_text(json.dumps({"project_root": str(self.root)}), encoding="utf-8")
        self.ns = _load_head(host_cfg=cfg)
        self.ns["_host_python"] = lambda root: sys.executable
        # AGENTY_ROOT outranks the recorded checkout, and on a developer's machine
        # it names the real one.
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("AGENTY_ROOT", None)

    def _run(self, action, payload=None):
        return asyncio.run(self.ns["_run_offline_settings"](action, payload))

    def test_get_returns_the_helpers_last_line_and_names_the_checkout(self):
        out, status = self._run("get")
        self.assertEqual(status, 200)
        self.assertEqual(out["settings"]["env"], {"KEY": "masked"})
        self.assertEqual(out["root"], str(self.root))

    def test_save_hands_the_body_over_on_stdin(self):
        out, status = self._run("save", {"env": {"A": "ä"}, "mcp_config": {"servers": {}}})
        self.assertEqual(status, 200)
        self.assertEqual(out["got"], {"env": {"A": "ä"}, "mcp_config": {"servers": {}}})

    def test_a_failing_helper_is_an_error_with_its_message(self):
        out, status = self._run("nonsense")
        self.assertEqual((status, out["error"]), (500, "boom"))

    def test_a_checkout_without_the_helper_says_to_update(self):
        (self.root / "src" / "utils" / "settings_offline.py").unlink()
        out, status = self._run("get")
        self.assertEqual(status, 409)
        self.assertIn("older than this panel", out["error"])

    def test_no_environment_says_how_to_make_one(self):
        self.ns["_host_python"] = _load_head()["_host_python"]
        out, status = self._run("get")
        self.assertEqual(status, 409)
        self.assertIn(".venv", out["error"])


class Helpers(unittest.TestCase):

    def test_the_checkouts_own_python_is_found(self):
        ns = _load_head()
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(ns["_host_python"](d), "")
            p = Path(d) / ".venv" / "bin"
            p.mkdir(parents=True)
            (p / "python").write_text("", encoding="utf-8")
            self.assertEqual(ns["_host_python"](d), str(p / "python"))
        self.assertEqual(ns["_host_python"](""), "")

    def test_unparseable_output_is_an_error_not_a_crash(self):
        ns = _load_head()
        self.assertFalse(ns["_offline_result"](b"")["ok"])
        self.assertFalse(ns["_offline_result"](b"Traceback...\nnot json")["ok"])
        self.assertFalse(ns["_offline_result"](b"[1, 2]")["ok"])

    def test_a_save_is_only_taken_from_this_page(self):
        ns = _load_head()

        class Req:
            def __init__(self, **h):
                self.headers = h
        self.assertTrue(ns["_same_origin"](Req(Host="127.0.0.1:8188")))
        self.assertTrue(ns["_same_origin"](Req(Host="127.0.0.1:8188", Origin="http://127.0.0.1:8188")))
        self.assertFalse(ns["_same_origin"](Req(Host="127.0.0.1:8188", Origin="https://evil.example")))


if __name__ == "__main__":
    unittest.main()
