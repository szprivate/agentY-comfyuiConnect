"""The `agentY edit` node: a stage that cuts finished shots into one film."""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODES = (ROOT / "__init__.py").read_text(encoding="utf-8")
CHAT = (ROOT / "web" / "agent_chat.js").read_text(encoding="utf-8")
EXEC = (ROOT / "web" / "agent_exec.js").read_text(encoding="utf-8")


class TheNode(unittest.TestCase):
    def setUp(self):
        self.body = NODES.split("class AgentYEdit(io.ComfyNode):", 1)[1].split("\nclass ", 1)[0]

    def test_it_is_registered(self):
        self.assertIn('node_id="AgentYEdit"', self.body)
        self.assertIn("AgentYEdit, AgentYContext]", NODES)

    def test_it_sits_on_the_execution_wire(self):
        self.assertIn("_exec_in(),", self.body)
        self.assertIn('outputs=[io.AnyType.Output(display_name="out"), _exec_out()]', self.body)

    def test_the_shots_are_anchors_like_any_stages_inputs(self):
        self.assertIn('input=io.AnyType.Input("anchor"), prefix="anchor"', self.body)
        self.assertIn('io.Autogrow.Input("anchors", template=clips)', self.body)

    def test_a_rhythm_reference_and_a_sound_bed_are_optional(self):
        for name in ("reference", "audio"):
            self.assertIn(f'"{name}", optional=True', self.body)

    def test_what_the_film_is_is_set_on_the_node(self):
        for widget in ('"brief"', '"size"', '"fps"', '"length"', '"format"'):
            self.assertIn(widget, self.body)
        self.assertIn('EDIT_FORMATS = ["mp4", "mov"]', NODES)

    def test_it_does_nothing_on_a_normal_queue(self):
        self.assertIn("return io.NodeOutput(None, None)", self.body)


class InThePanel(unittest.TestCase):
    def test_the_wire_runs_through_it(self):
        self.assertIn('export function isEditNode(node) { return classOf(node) === "AgentYEdit"; }', EXEC)
        self.assertIn("isReviewNode(node) || isEditNode(node) || !!flowPurpose(node)", EXEC)
        self.assertIn('"AgentYJoin", "AgentYEdit"];', CHAT)

    def test_it_is_a_stage_once_something_is_wired_into_it(self):
        stage = CHAT.split("  _isStage(n) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn("if (isEditNode(n)) return this._anchorsFor(n).length > 0;", stage)

    def test_it_is_sent_as_an_edit_with_its_settings(self):
        entry = CHAT.split("  _editEntry(n, base, w) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn('purpose: "edit",', entry)
        self.assertIn("directive: String(w.brief || \"\").trim(),", entry)
        for field in ("width:", "fps:", "length:", "format:"):
            self.assertIn(field, entry)
        self.assertIn('reference: this._anchorsFor(n, "reference")', entry)
        self.assertIn('audio: this._anchorsFor(n, "audio")', entry)

    def test_the_collection_routes_it_there(self):
        collect = CHAT.split("  _collectCanvasHooks() {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn("} else if (isEditNode(hn)) {\n        hooks.push(this._editEntry(hn, base, w));", collect)


if __name__ == "__main__":
    unittest.main()
