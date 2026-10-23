"""The env names an "Other service..." key is saved under, tested with node."""
import json
import pathlib
import shutil
import subprocess
import unittest

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node is not installed")
class ServiceEnvNames(unittest.TestCase):

    def _names(self, inputs):
        code = ("import { serviceEnvNames } from %s;"
                "const ins = %s; console.log(JSON.stringify(ins.map(serviceEnvNames)));"
                % (json.dumps((WEB / "agent_env_names.js").as_uri()), json.dumps(inputs)))
        res = subprocess.run([NODE, "--input-type=module", "-e", code], capture_output=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr.decode("utf-8", "replace"))
        return json.loads(res.stdout.decode())

    def test_derivation(self):
        out = self._names(["Mercury", " open-router.ai ", "Together  AI", "x1"])
        self.assertEqual(out[0], {"prefix": "MERCURY", "key": "MERCURY_API_KEY", "url": "MERCURY_BASE_URL"})
        self.assertEqual(out[1]["key"], "OPEN_ROUTER_AI_API_KEY")
        self.assertEqual(out[2]["prefix"], "TOGETHER_AI")
        self.assertEqual(out[3]["prefix"], "X1")

    def test_invalid_names(self):
        self.assertEqual(self._names(["", "   ", "9lives", "-- ", "ü"]), [None] * 5)


class DeadlineSection(unittest.TestCase):

    def test_its_fields_are_in_the_page(self):
        js = (WEB / "agent_settings.js").read_text(encoding="utf-8")
        for k in ("DEADLINE_PATH", "DEADLINE_REPOSITORY", "DEADLINE_WEBSERVICE_URL", "DEADLINE_COMFYUI_PATH",
                  "DEADLINE_COMFYUI_POOL", "DEADLINE_GROUP", "DEADLINE_OUTPUT_DIR"):
            self.assertIn('"%s"' % k, js)
        self.assertIn("docs/deadline.md", js)


if __name__ == "__main__":
    unittest.main()
