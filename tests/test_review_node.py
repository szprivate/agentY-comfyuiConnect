"""The agentY review node: one node, a human or the QA agent as the reviewer.

It replaces two things - the `human_review` purpose on the hook and the separate
`agentY qa` node. Every QA control is kept; they are shown only while the agent
is the reviewer, because under a human review none of them is enforced.
"""
import json
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
NODE = shutil.which("node")
NODES = (ROOT / "__init__.py").read_text(encoding="utf-8")
CHAT = (WEB / "agent_chat.js").read_text(encoding="utf-8")
REVIEW = (WEB / "agent_review.js").read_text(encoding="utf-8")
HOOK = (WEB / "agent_hook.js").read_text(encoding="utf-8")

QA_SETTINGS = ["aspect_ratio", "resolution", "sharpness", "grain", "no_clipping",
               "no_black_frames", "no_stalled_motion", "likeness", "retries"]


class TheNode(unittest.TestCase):

    def setUp(self):
        self.node = NODES.split("class AgentYReview(io.ComfyNode):", 1)[1].split(
            "class _AgentYExtension", 1)[0]

    def test_it_is_registered_and_the_qa_node_is_gone(self):
        listed = NODES.split("async def get_node_list", 1)[1].split("async def comfy_entrypoint", 1)[0]
        self.assertIn("AgentYReview", listed)
        self.assertNotIn("AgentYQa", NODES)

    def test_the_reviewer_is_a_person_by_default(self):
        self.assertIn('"reviewer", options=["human", "agent"], default="human"', self.node)

    def test_every_qa_control_survived_the_merge(self):
        for name in QA_SETTINGS + ["notes"]:
            with self.subTest(setting=name):
                self.assertIn(f'"{name}"', self.node.split("def define_schema", 1)[1])
        self.assertIn('io.Autogrow.Input("references", template=refs)', self.node)

    def test_what_is_reviewed_is_wired_in_like_a_hooks_anchor(self):
        # The host forwards, splices and wires collectors by this name.
        self.assertIn('io.AnyType.Input("anchor"), prefix="anchor"', self.node)
        self.assertIn('io.Autogrow.Input("anchors", template=judged)', self.node)

    def test_the_list_of_agent_only_settings_is_the_same_on_both_sides(self):
        py = NODES.split("REVIEW_AGENT_SETTINGS = [", 1)[1].split("]", 1)[0]
        js = REVIEW.split("export const AGENT_SETTINGS = [", 1)[1].split("]", 1)[0]
        names = lambda text: [s.strip().strip('"') for s in text.replace("\n", " ").split(",") if s.strip()]  # noqa: E731
        self.assertEqual(names(py), QA_SETTINGS)
        self.assertEqual(names(js), QA_SETTINGS)


class TheHook(unittest.TestCase):
    """What is left on the hook once reviewing has its own node."""

    def setUp(self):
        self.node = NODES.split("class AgentYHook(io.ComfyNode):", 1)[1].split("class AgentYContext", 1)[0]

    def test_three_purposes_named_with_spaces(self):
        self.assertIn('PARAMETER_PURPOSE = "set / sweep parameter"', NODES)
        self.assertIn('WORKFLOW_PURPOSE = "make workflow"', NODES)
        self.assertIn('TEXT_PURPOSE = "text only"', NODES)
        self.assertIn("options=[PARAMETER_PURPOSE, WORKFLOW_PURPOSE, TEXT_PURPOSE],", self.node)
        self.assertIn("default=PARAMETER_PURPOSE,", self.node)

    def test_the_retired_purposes_are_not_offered(self):
        schema = self.node.split("def define_schema", 1)[1]
        for old in ("general_request", "human_review", "inline_parameter"):
            self.assertNotIn(old, schema)

    def test_the_panel_names_them_the_same_and_translates_for_the_host(self):
        self.assertIn('export const PARAMETER_PURPOSE = "set / sweep parameter";', HOOK)
        self.assertIn('export const WORKFLOW_PURPOSE = "make workflow";', HOOK)
        self.assertIn('export const TEXT_PURPOSE = "text only";', HOOK)
        self.assertIn('[PARAMETER_PURPOSE]: "set_parameter", [WORKFLOW_PURPOSE]: "make_workflow"', HOOK)
        self.assertIn('[TEXT_PURPOSE]: "text_only" };', HOOK)

    def test_an_older_graphs_purpose_is_carried_over(self):
        renamed = HOOK.split("const RENAMED = {", 1)[1].split("};", 1)[0]
        for old in ("inline_parameter:", "set_parameter:", "make_workflow:", "text:", "text_only:",
                    "general_request:"):
            self.assertIn(old, renamed)


class WhatIsShown(unittest.TestCase):

    def test_the_checks_are_hidden_for_a_person_and_shown_for_the_agent(self):
        hidden = REVIEW.split("export function hiddenSettings(", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("return isAgentReviewer(reviewer) ? [] : names.slice();", hidden)

    def test_the_question_box_is_never_hidden(self):
        js = REVIEW.split("export const AGENT_SETTINGS = [", 1)[1].split("]", 1)[0]
        self.assertNotIn("notes", js)
        self.assertNotIn("reviewer", js)

    def test_hiding_reaches_both_node_renderers(self):
        flag = REVIEW.split("function flagHidden(widget, hidden) {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("widget.hidden = hidden;", flag)                      # classic canvas
        self.assertIn("widget._state && widget._state.options", flag)       # Nodes 2.0
        self.assertNotIn(".type =", flag, "a placeholder type outlives the hiding in Nodes 2.0")

    def test_it_follows_the_dropdown_and_a_loaded_graph(self):
        self.assertIn("applyReviewer(node, true);", REVIEW)
        self.assertIn("applyReviewer(this, false);", REVIEW.split("nodeType.prototype.configure", 1)[1])


class WhatThePanelSends(unittest.TestCase):

    def setUp(self):
        self.entry = CHAT.split("  _reviewEntry(n, base) {", 1)[1].split("\n  }\n", 1)[0]

    def test_a_human_review_is_the_stop_and_notes_are_its_question(self):
        human = self.entry.split("if (!s.agent) {", 1)[1].split("}", 1)[0]
        self.assertIn('directive: s.notes, purpose: "human_review", reviewer: "human"', human)

    def test_an_agent_review_is_the_qa_briefing_with_everything_on_it(self):
        for field in ('purpose: "qa",', 'reviewer: "agent",', "technical: s.technical,",
                      "retries: s.retries,", "applies_to: applies,", "judged,",
                      'this._anchorsFor(n, "reference")'):
            self.assertIn(field, self.entry)

    def test_on_the_wire_it_judges_the_stage_before_it(self):
        self.assertIn("for (const stage of this._execStages(n)) {", self.entry)
        stages = CHAT.split("  _execStages(n) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn("isHookNode(x) && this._isStage(x)", stages)

    def test_a_human_review_always_counts_an_empty_agent_review_does_not(self):
        stage = CHAT.split("  _isStage(n) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn("return !s.agent || !!s.notes || s.asked;", stage)

    def test_the_settings_are_read_whether_or_not_they_are_shown(self):
        settings = CHAT.split("  _reviewSettings(n) {", 1)[1].split("\n  }\n", 1)[0]
        for name in QA_SETTINGS:
            self.assertIn(name, settings)


SCRIPT = """
import { hiddenSettings, isAgentReviewer, AGENT_SETTINGS } from %s;
console.log(JSON.stringify({
  human: hiddenSettings("human"), agent: hiddenSettings("agent"), odd: hiddenSettings(" Agent "),
  unset: hiddenSettings(undefined).length, all: AGENT_SETTINGS.length,
  who: [isAgentReviewer("agent"), isAgentReviewer("human"), isAgentReviewer("")],
}));
"""


@unittest.skipUnless(NODE, "node is not installed")
class HiddenSettingsUnderNode(unittest.TestCase):

    def test_the_rule(self):
        # agent_review.js imports ComfyUI's app, which node cannot load; the rule
        # itself is three pure functions, so they are run on their own.
        pure = REVIEW.split("export const AGENT_SETTINGS", 1)[1].split("function getWidget", 1)[0]
        src = pathlib.Path(__file__).with_name("_review_pure.mjs")
        src.write_text("export const AGENT_SETTINGS" + pure, encoding="utf-8")
        try:
            out = subprocess.run([NODE, "--input-type=module", "-e", SCRIPT % json.dumps(src.as_uri())],
                                 capture_output=True, text=True, encoding="utf-8", timeout=60)
            self.assertEqual(out.returncode, 0, out.stderr)
            r = json.loads(out.stdout)
        finally:
            src.unlink(missing_ok=True)
        self.assertEqual(r["human"], QA_SETTINGS)
        self.assertEqual(r["agent"], [])
        self.assertEqual(r["odd"], [])
        self.assertEqual(r["unset"], r["all"])
        self.assertEqual(r["who"], [True, False, False])


if __name__ == "__main__":
    unittest.main()
