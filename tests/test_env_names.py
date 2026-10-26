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
        self.assertIn("docs/setup/deadline.md", js)


class CustomProviderUi(unittest.TestCase):
    """Read from the source: the page has no engine to run in here."""

    def setUp(self):
        self.js = (WEB / "agent_settings.js").read_text(encoding="utf-8")

    def test_the_registry_is_kept_off_the_generic_form_and_saved_explicitly(self):
        self.assertIn('"llm.custom_providers"', self.js.split("const HIDDEN = new Set([", 1)[1].split("]);", 1)[0])
        self.assertIn("payload.custom_providers = { add: cpAdd, remove: [...customRemove] };", self.js)

    def test_connections_rows_have_test_and_remove(self):
        self.assertIn("/agentY/custom_provider/test", self.js)
        self.assertIn("OpenAI-compatible LLM provider", self.js)
        self.assertIn("can read images", self.js)

    def test_typed_model_ids_are_offered(self):
        self.assertIn("extraChoices: CUSTOM_PROVIDERS.length ? typedModelChoices : null", self.js)
        combo = (WEB / "agent_combo.js").read_text(encoding="utf-8")
        self.assertIn("extraChoices", combo)


if __name__ == "__main__":
    unittest.main()
