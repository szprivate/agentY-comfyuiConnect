"""A tool call another agent answers says so on its card.

"[orchestrator] analyze_image" read as the orchestrator looking at the image
itself. It is the vision agent that looks, on the vision tier's model; the host
sends that as `via` and the card shows it as a second chip after the tool name.
"""
import pathlib
import unittest

CHAT = (pathlib.Path(__file__).resolve().parent.parent / "web" / "agent_chat.js").read_text(encoding="utf-8")


class TheCardNamesWhoAnswered(unittest.TestCase):

    def setUp(self):
        self.card = CHAT.split("  _toolCard(ev) {", 1)[1].split("\n  // ── the run", 1)[0]
        self.label = CHAT.split("function viaLabel(via) {", 1)[1].split("\n}", 1)[0]

    def test_the_chip_comes_from_the_events_via(self):
        self.assertIn("const via = viaLabel(ev.via);", self.card)
        self.assertIn('className: "ay-agent ay-via"', self.card)

    def test_it_sits_between_the_tool_name_and_the_state(self):
        name, chip, state = (self.card.index('className: "ay-tname"'), self.card.index("ay-via"),
                             self.card.index("summary.append(state)"))
        self.assertLess(name, chip)
        self.assertLess(chip, state)

    def test_it_takes_the_colour_of_the_agent_that_answered(self):
        self.assertIn('chip.style.setProperty("--ay-agent", agentColor(via.agent))', self.card)

    def test_a_call_nobody_else_answers_has_no_chip(self):
        """An older host sends no `via`; neither does any ordinary tool."""
        self.assertIn("if (via) {", self.card)
        self.assertIn("if (!agent) return null;", self.label)

    def test_the_model_is_named_when_it_is_known(self):
        self.assertIn("model ? `${agent} · ${model}` : agent", self.label)


if __name__ == "__main__":
    unittest.main()
