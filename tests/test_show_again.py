"""A picture the agent asks to be shown again (show_in_panel) is a card, and only a card."""
import unittest
from pathlib import Path

CHAT = (Path(__file__).resolve().parent.parent / "web" / "agent_chat.js").read_text(encoding="utf-8")


class ShownAgain(unittest.TestCase):
    def setUp(self):
        self.show = CHAT.split("  _showOutput(ev) {", 1)[1].split("\n  }\n", 1)[0]
        self.inject = CHAT.split("  injectNode(ev) {", 1)[1].split("\n  }\n", 1)[0]

    def test_it_appears_although_the_same_file_is_already_in_the_log(self):
        # The first showing is matched by file; a showing-again by its own id.
        self.assertIn("ev.again ? have.dataset.again === String(ev.again)", self.show)
        self.assertIn(": (!have.dataset.again && have.dataset.file === ev.filename)", self.show)

    def test_a_turn_read_again_from_its_start_does_not_show_it_twice(self):
        self.assertIn("if (ev.again) card.dataset.again = String(ev.again);", self.show)

    def test_it_keeps_its_number(self):
        self.assertIn('ev.index ? "#" + ev.index : ""', self.show)

    def test_no_node_is_placed_and_no_file_is_announced(self):
        after_card, rest = self.inject.split("if (ev && ev.again) return;", 1)
        self.assertIn("this._showOutput(ev);", after_card)
        self.assertNotIn("createNode", after_card)
        self.assertNotIn("_runOutput", after_card)
        self.assertIn("createNode", rest)


if __name__ == "__main__":
    unittest.main()
