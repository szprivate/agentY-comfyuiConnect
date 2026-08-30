"""The extension's platform-dependent bits: which launcher, and which file dialog.

``__init__.py`` cannot be imported outside ComfyUI (it needs ``comfy_api``), so the
self-contained head of the file — everything above the route registration — is
exec'd on its own. That region is exactly what these tests cover, and the boundary
is a stable one: the ComfyUI imports begin there and nothing above them needs a
running server.
"""
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXT = HERE.parent
_BOUNDARY = "\ntry:\n    from server import PromptServer"


def _load_head(platform=None, host_cfg=None):
    """The module head, executed as if imported on *platform*.

    ``sys.platform`` is patched for the duration rather than swapped afterwards:
    ``_DEFAULT_RUN_SCRIPT`` is decided at import time, so a substitution made after
    exec would arrive too late and the argument would quietly do nothing.
    """
    src = (EXT / "__init__.py").read_text(encoding="utf-8")
    head = src[:src.index(_BOUNDARY)]
    ns = {"__file__": str(EXT / "__init__.py"), "__name__": "agentyconnect_head"}
    real = sys.platform
    if platform is not None:
        sys.platform = platform
    try:
        exec(compile(head, "agentyconnect_head", "exec"), ns)
    finally:
        sys.platform = real
    if host_cfg is not None:
        ns["_HOST_CFG"] = str(host_cfg)
    return ns


def _default_script(platform):
    """What the module head decides the launcher is called, on *platform*."""
    return _load_head(platform=platform)["_DEFAULT_RUN_SCRIPT"]


class AppleScriptEscaping(unittest.TestCase):
    """A path is data; it must not be able to end the AppleScript string early."""

    def setUp(self):
        self.esc = _load_head()["_applescript_str"]

    def test_plain_text_is_unchanged(self):
        self.assertEqual(self.esc("cd /Users/seb/agentY && bash run_agent.sh"),
                         "cd /Users/seb/agentY && bash run_agent.sh")

    def test_double_quote_is_escaped(self):
        self.assertEqual(self.esc('say "hi"'), 'say \\"hi\\"')

    def test_backslash_is_escaped(self):
        self.assertEqual(self.esc("a\\b"), "a\\\\b")

    def test_backslash_before_quote_survives_both_passes(self):
        # The order matters: escaping the quote first would then double the
        # backslash this step just introduced, and the literal would end early.
        self.assertEqual(self.esc('a\\"b'), 'a\\\\\\"b')

    def test_result_has_no_unescaped_quote(self):
        for raw in ('/Users/o"neill/x', 'a\\"b', '"', '\\', '""'):
            with self.subTest(raw=raw):
                out = self.esc(raw)
                # Walk it the way AppleScript would: a quote must always be
                # preceded by an odd number of backslashes.
                i, n = 0, 0
                while i < len(out):
                    if out[i] == "\\":
                        i += 2
                        continue
                    self.assertNotEqual(out[i], '"', f"bare quote in {out!r}")
                    i += 1
                    n += 1
                self.assertGreaterEqual(n, 0)


class LauncherResolution(unittest.TestCase):
    """Which script the sidebar's Start-server button runs."""

    def setUp(self):
        # AGENTY_ROOT outranks the recorded file by design, and a developer machine
        # commonly has it set — which silently redirected every case below at the
        # real checkout and made two of them fail for the wrong reason.
        self._agenty_root = os.environ.pop("AGENTY_ROOT", None)

    def tearDown(self):
        if self._agenty_root is not None:
            os.environ["AGENTY_ROOT"] = self._agenty_root

    def test_default_is_named_by_platform(self):
        self.assertEqual(_default_script("win32"), "run_agent.ps1")
        self.assertEqual(_default_script("darwin"), "run_agent.sh")
        self.assertEqual(_default_script("linux"), "run_agent.sh")

    def test_module_default_matches_this_platform(self):
        ns = _load_head()
        self.assertEqual(ns["_DEFAULT_RUN_SCRIPT"], _default_script(sys.platform))

    def test_recorded_script_is_used_when_it_exists(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "agentY"
            root.mkdir()
            (root / "run_agent.ps1").write_text("x", encoding="utf-8")
            cfg = Path(td) / ".agenty_host.json"
            cfg.write_text(json.dumps({"project_root": str(root),
                                       "run_script": "run_agent.ps1"}), encoding="utf-8")
            ns = _load_head(host_cfg=cfg)
            got_root, got_script = ns["_read_host_cfg"]()
            self.assertEqual(got_root, str(root))
            self.assertEqual(got_script, "run_agent.ps1")

    def test_stale_cross_platform_name_falls_back_to_the_one_present(self):
        """A checkout moved between a Mac and a PC records the other launcher.

        Reporting "run_agent.ps1 not found" would be true and useless: the folder
        has a launcher, just the other one.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "agentY"
            root.mkdir()
            (root / "run_agent.sh").write_text("x", encoding="utf-8")
            cfg = Path(td) / ".agenty_host.json"
            cfg.write_text(json.dumps({"project_root": str(root),
                                       "run_script": "run_agent.ps1"}), encoding="utf-8")
            ns = _load_head(host_cfg=cfg)
            ns["_DEFAULT_RUN_SCRIPT"] = "run_agent.sh"
            _root, script = ns["_read_host_cfg"]()
            self.assertEqual(script, "run_agent.sh")

    def test_a_custom_launcher_that_exists_is_not_overridden(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "agentY"
            root.mkdir()
            (root / "my_launcher.sh").write_text("x", encoding="utf-8")
            (root / "run_agent.sh").write_text("x", encoding="utf-8")
            cfg = Path(td) / ".agenty_host.json"
            cfg.write_text(json.dumps({"project_root": str(root),
                                       "run_script": "my_launcher.sh"}), encoding="utf-8")
            ns = _load_head(host_cfg=cfg)
            ns["_DEFAULT_RUN_SCRIPT"] = "run_agent.sh"
            _root, script = ns["_read_host_cfg"]()
            self.assertEqual(script, "my_launcher.sh")

    def test_env_var_wins_over_the_recorded_file(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / ".agenty_host.json"
            cfg.write_text(json.dumps({"project_root": "/recorded"}), encoding="utf-8")
            ns = _load_head(host_cfg=cfg)
            os.environ["AGENTY_ROOT"] = td
            root, _script = ns["_read_host_cfg"]()
            self.assertEqual(root, td)

    def test_missing_config_yields_no_root(self):
        ns = _load_head(host_cfg=Path(tempfile.gettempdir()) / "definitely-not-here.json")
        root, script = ns["_read_host_cfg"]()
        self.assertEqual(root, "")
        self.assertEqual(script, ns["_DEFAULT_RUN_SCRIPT"])


def _load_picker(*, have_tk):
    """_filepicker.py's definitions, with tkinter present or absent."""
    import builtins
    src = (EXT / "_filepicker.py").read_text(encoding="utf-8").rstrip()
    assert src.endswith("_main()")
    src = src[:-len("_main()")]            # drop only the trailing invocation
    real = builtins.__import__

    def maybe_block(name, *a, **k):
        if not have_tk and name.startswith("tkinter"):
            raise ImportError("no tkinter in this Python")
        return real(name, *a, **k)

    builtins.__import__ = maybe_block
    try:
        ns = {"__name__": "picker"}
        exec(compile(src, "picker", "exec"), ns)
        return ns
    finally:
        builtins.__import__ = real


class MacFileDialog(unittest.TestCase):
    """The AppleScript fallback for a ComfyUI Python without Tk.

    Homebrew's python omits tkinter unless python-tk is installed alongside it, so
    on a common Mac setup the collector nodes had no dialog at all — and the error
    named a package the user never chose to leave out.
    """

    def _picker_with(self, returncode, stdout, stderr):
        ns = _load_picker(have_tk=False)
        seen = []

        class R:
            pass
        R.returncode, R.stdout, R.stderr = returncode, stdout, stderr
        ns["subprocess"] = types.SimpleNamespace(
            run=lambda cmd, **kw: (seen.append(cmd), R())[1])
        return ns, seen

    def test_missing_tkinter_is_recorded_as_a_string(self):
        # `except X as e` unbinds e at the end of the block; keeping the exception
        # object would be a NameError on exactly the machine that lacks Tk.
        ns = _load_picker(have_tk=False)
        self.assertFalse(ns["_HAVE_TK"])
        self.assertIsInstance(ns["_TK_ERR"], str)
        self.assertIn("tkinter", ns["_TK_ERR"])

    def test_tk_is_preferred_when_present(self):
        ns = _load_picker(have_tk=True)
        self.assertTrue(ns["_HAVE_TK"])

    def test_selected_paths_are_returned(self):
        ns, _ = self._picker_with(0, "/Users/seb/a.png\n/Users/seb/b mov.mp4\n", "")
        self.assertEqual(ns["_osascript_pick"]("media", "files"),
                         ["/Users/seb/a.png", "/Users/seb/b mov.mp4"])

    def test_cancel_is_an_empty_selection_not_an_error(self):
        ns, _ = self._picker_with(1, "", "execution error: User canceled. (-128)")
        self.assertEqual(ns["_osascript_pick"]("media", "files"), [])

    def test_a_real_failure_is_raised(self):
        # -1743 is "not authorised to send Apple events" — a permissions dialog the
        # user must answer, and nothing like a cancel.
        ns, _ = self._picker_with(1, "", "execution error: not authorised (-1743)")
        with self.assertRaises(RuntimeError):
            ns["_osascript_pick"]("media", "files")

    def test_file_dialog_names_every_extension(self):
        ns, seen = self._picker_with(0, "", "")
        ns["_osascript_pick"]("media", "files")
        script = seen[0][2]
        for ext in ("png", "jpg", "webp", "mp4", "mov", "mkv"):
            self.assertIn(f'"{ext}"', script)
        self.assertIn("multiple selections allowed", script)

    def test_kind_narrows_the_filter(self):
        ns, seen = self._picker_with(0, "", "")
        ns["_osascript_pick"]("image", "files")
        self.assertIn('"png"', seen[0][2])
        self.assertNotIn('"mp4"', seen[0][2])
        ns["_osascript_pick"]("video", "files")
        self.assertIn('"mp4"', seen[1][2])
        self.assertNotIn('"png"', seen[1][2])

    def test_folder_mode_asks_for_a_folder(self):
        ns, seen = self._picker_with(0, "/Users/seb/shots\n", "")
        self.assertEqual(ns["_osascript_pick"]("media", "folder"), ["/Users/seb/shots"])
        self.assertIn("choose folder", seen[0][2])

    def test_it_shells_out_to_osascript(self):
        ns, seen = self._picker_with(0, "", "")
        ns["_osascript_pick"]("media", "files")
        self.assertEqual(seen[0][0], "osascript")
        self.assertEqual(seen[0][1], "-e")


class PickerSyntax(unittest.TestCase):
    def test_both_modules_compile(self):
        for name in ("__init__.py", "_filepicker.py"):
            with self.subTest(module=name):
                src = (EXT / name).read_text(encoding="utf-8")
                compile(src, name, "exec")


if __name__ == "__main__":
    unittest.main()
