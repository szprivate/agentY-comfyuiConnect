"""Every web/*.js file parses as an ES module.

One syntax error in a module takes the whole sidebar down: ComfyUI loads each
extension file as a module, and a module that does not parse is never run —
agent_hook.js once shipped a line break inside a string literal, and the agentY
panel button simply did not appear. `node --check <file>` did not notice
(it does not parse a .js file as a module outside a package that says so);
feeding the source in as `--input-type=module` does.

Skipped where there is no node — a ComfyUI install has none.
"""
import pathlib
import shutil
import subprocess
import unittest

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node is not installed")
class EveryModuleParses(unittest.TestCase):

    def _check(self, source: bytes):
        return subprocess.run([NODE, "--input-type=module", "--check"], input=source,
                              capture_output=True, timeout=60)

    def test_web_modules(self):
        files = sorted(WEB.glob("*.js"))
        self.assertTrue(files)
        for path in files:
            with self.subTest(path.name):
                res = self._check(path.read_bytes())
                self.assertEqual(res.returncode, 0, res.stderr.decode("utf-8", "replace"))

    def test_the_check_catches_a_broken_string(self):
        res = self._check(b'export const x = ["a"].join("\n");\n')
        self.assertNotEqual(res.returncode, 0)


if __name__ == "__main__":
    unittest.main()
