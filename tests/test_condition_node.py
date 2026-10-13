"""The agentY condition node: a yes/no about a picture, judged by a decision model.

The work (_condition.py) is tested without ComfyUI and without Ollama: the HTTP
calls are stood in for.
"""
import json
import shutil
import subprocess
import importlib.util
import pathlib
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODES = (ROOT / "__init__.py").read_text(encoding="utf-8")
spec = importlib.util.spec_from_file_location("agenty_condition_under_test", ROOT / "_condition.py")
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)


class TheCondition(unittest.TestCase):

    def test_one_statement_per_line_and_not_for_what_must_be_false(self):
        got = C.parse("the woman looks frustrated\n  not: the woman looks angry\n\n- she sits at a table\n# a note")
        self.assertEqual(got, [("the woman looks frustrated", True), ("the woman looks angry", False),
                               ("she sits at a table", True)])

    def test_nothing_written_is_no_condition(self):
        self.assertEqual(C.parse("  \n# only a note"), [])

    def test_too_many_statements_are_refused(self):
        with self.assertRaises(C.ConditionError):
            C.parse("\n".join(f"statement {i}" for i in range(C.MAX_STATEMENTS + 1)))


class TheVerdict(unittest.TestCase):

    S = [("frustrated", True), ("angry", False)]

    def test_frustrated_but_not_angry(self):
        v = C.judge([0.70, 0.03], self.S, 0.5)
        self.assertTrue(v["met"])
        self.assertEqual(v["score"], 0.70)                  # the weakest: frustrated at 0.70

    def test_angry_as_well_fails_on_the_not_line(self):
        v = C.judge([0.77, 0.92], self.S, 0.5)
        self.assertFalse(v["met"])
        self.assertAlmostEqual(v["score"], 0.08)
        self.assertEqual([r["ok"] for r in v["rows"]], [True, False])

    def test_the_threshold_decides(self):
        self.assertFalse(C.judge([0.47, 0.02], self.S, 0.5)["met"])
        self.assertTrue(C.judge([0.47, 0.02], self.S, 0.4)["met"])

    def test_a_batch_is_judged_as_asked(self):
        a, b = C.judge([0.9, 0.1], self.S, 0.5), C.judge([0.2, 0.1], self.S, 0.5)
        self.assertEqual(C.combine([a, b], C.BATCH_MODES[0]), (False, 0.2))
        self.assertEqual(C.combine([a, b], C.BATCH_MODES[1]), (True, 0.9))
        self.assertEqual(C.combine([b, a], C.BATCH_MODES[2]), (False, 0.2))
        self.assertEqual(C.combine([], C.BATCH_MODES[0]), (False, 0.0))

    def test_the_report_names_each_statement_with_its_probability(self):
        v = C.judge([0.77, 0.92], self.S, 0.5)
        text = C.report([v], False, "clef", 0.5)
        self.assertIn("NOT MET (clef, threshold 0.5)", text)
        self.assertIn("ok 0.77  frustrated", text)
        self.assertIn("NO 0.92  not: angry", text)


class TheModel(unittest.TestCase):

    def _tags(self, *names):
        return {"models": [{"name": n} for n in names]}

    def test_a_model_that_is_there_is_not_downloaded(self):
        with mock.patch.object(C, "_call", return_value=self._tags("clef-flash:latest", "qwen3.8:27b")), \
                mock.patch.object(C, "pull") as pull:
            self.assertFalse(C.ensure("clef-flash", "http://h"))
        pull.assert_not_called()

    def test_one_that_is_missing_is_downloaded_on_first_use(self):
        seen = []
        with mock.patch.object(C, "installed", return_value=False), \
                mock.patch.object(C, "pull", side_effect=lambda m, b, p: seen.append(m)):
            self.assertTrue(C.ensure("clef", "http://h"))
        self.assertEqual(seen, ["clef"])

    def test_clef_is_not_mistaken_for_clef_flash(self):
        with mock.patch.object(C, "_call", return_value=self._tags("clef-flash:latest")):
            self.assertFalse(C.installed("clef", "http://h"))
            self.assertTrue(C.installed("clef-flash", "http://h"))

    def test_only_the_two_models_are_offered(self):
        with self.assertRaises(C.ConditionError):
            C.ensure("qwen3.8:27b", "http://h")

    def test_no_ollama_is_said_plainly(self):
        with mock.patch.object(C, "_call", side_effect=OSError("refused")):
            with self.assertRaises(C.ConditionError) as ctx:
                C.installed("clef", "http://127.0.0.1:11434")
        self.assertIn("install and start Ollama", str(ctx.exception))


class TheQuestion(unittest.TestCase):

    def test_each_statement_is_asked_as_a_yes_or_no_about_the_picture(self):
        sent = {}

        def call(url, body=None, timeout=0):
            sent.update(url=url, body=body)
            return {"answers": {"s0": {"type": "noul", "noul": 0.7}, "s1": {"type": "noul", "noul": 0.03}}}
        with mock.patch.object(C, "_call", side_effect=call):
            got = C.ask("clef", "QUJD", [("frustrated", True), ("angry", False)], "http://h")
        self.assertEqual(got, [0.7, 0.03])
        self.assertEqual(sent["url"], "http://h/v1/systemone")
        self.assertEqual(sent["body"]["images"], ["QUJD"])
        self.assertEqual(sent["body"]["questions"]["s1"]["type"], "noul")
        self.assertIn("angry", sent["body"]["questions"]["s1"]["instructions"])

    def test_an_answer_that_is_missing_is_an_error_not_a_guess(self):
        with mock.patch.object(C, "_call", return_value={"answers": {"s0": {"noul": 0.7}}}):
            with self.assertRaises(C.ConditionError):
                C.ask("clef", "QUJD", [("a", True), ("b", True)], "http://h")

    def test_a_picture_is_sent_as_a_small_jpeg(self):
        import base64
        import io
        from PIL import Image
        got = C.encode(Image.new("RGB", (4000, 2000), (200, 30, 30)))
        with Image.open(io.BytesIO(base64.b64decode(got))) as im:
            self.assertEqual(im.format, "JPEG")
            self.assertEqual(im.size, (1024, 512))


class TheNode(unittest.TestCase):

    BODY = NODES.split("class AgentYCondition(io.ComfyNode):", 1)[1].split("class _AgentYExtension", 1)[0]

    def test_it_is_registered(self):
        listed = NODES.split("async def get_node_list", 1)[1].split("async def comfy_entrypoint", 1)[0]
        self.assertIn("AgentYCondition", listed)

    def test_the_model_is_a_choice_between_the_two(self):
        self.assertIn('CONDITION_MODELS = ["clef-flash", "clef"]', NODES)
        self.assertIn('"model", options=CONDITION_MODELS, default="clef-flash"', self.BODY)
        self.assertEqual(tuple(C.MODELS), ("clef-flash", "clef"))

    def test_it_takes_pictures_and_answers_with_a_yes_or_no(self):
        for part in ('io.Image.Input("images"', '"condition", multiline=True', '"threshold"',
                     'io.Boolean.Output(display_name="met")', 'io.Float.Output(display_name="probability")',
                     'io.String.Output(display_name="report")', 'io.Image.Output(display_name="images")'):
            self.assertIn(part, self.BODY)

    def test_it_carries_the_execution_wire_and_its_data_outputs_keep_their_places(self):
        self.assertIn('_Exec.Input(\n                    "exec", optional=True,', self.BODY)
        self.assertIn('io.Image.Input("images", optional=True', self.BODY)      # a loop's judge is handed files
        outs = self.BODY.split("outputs=[", 1)[1].split("],", 1)[0]
        order = [outs.index(n) for n in ('"met"', '"probability"', '"report"', '"images"', "_exec_out()")]
        self.assertEqual(order, sorted(order))
        self.assertIn("text, images, None, ui=", self.BODY)

    def test_the_panel_reports_it_only_when_it_is_on_the_wire(self):
        web = ROOT / "web"
        ex = (web / "agent_exec.js").read_text(encoding="utf-8")
        chat = (web / "agent_chat.js").read_text(encoding="utf-8")
        self.assertIn('AgentYCondition: "condition"', ex)
        self.assertIn('if (flowPurpose(n) === "condition") return onExecWire(n);', chat)
        self.assertIn('"AgentYLoopBreak", "AgentYCondition",', chat)             # its exec input leaves the graph
        for field in ("condition: String(w.condition", "model: String(w.model", "threshold: Number(w.threshold",
                      "batch: String(w.batch"):
            self.assertIn(field, chat)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_on_the_wire_means_an_exec_socket_that_is_connected(self):
        script = """
import { onExecWire, flowPurpose, isExecNode, EXEC_TYPE } from %s;
const node = (inLink, outLinks) => ({ type: "AgentYCondition",
  inputs: [{ name: "exec", type: EXEC_TYPE, link: inLink }, { name: "images", type: "IMAGE", link: 5 }],
  outputs: [{ name: "met", type: "BOOLEAN", links: [9] }, { name: "exec", type: EXEC_TYPE, links: outLinks }] });
console.log(JSON.stringify([onExecWire(node(null, [])), onExecWire(node(3, [])), onExecWire(node(null, [4])),
                            onExecWire(node(null, null)), flowPurpose(node(null, [])), isExecNode(node(null, []))]));
""" % json.dumps((ROOT / "web" / "agent_exec.js").as_uri())
        out = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                             capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), [False, True, True, False, "condition", True])

    def test_the_model_is_fetched_when_the_node_first_runs_not_at_install(self):
        self.assertIn("C.ensure(model, progress=progress)", self.BODY)
        for name in ("requirements.txt", "pyproject.toml"):
            path = ROOT / name
            if path.exists():
                self.assertNotIn("clef", path.read_text(encoding="utf-8").lower())

    def test_the_batch_choices_are_the_ones_the_work_knows(self):
        self.assertIn(f"CONDITION_BATCH = {list(C.BATCH_MODES)!r}".replace("'", '"'), NODES)


if __name__ == "__main__":
    unittest.main()
