"""A review hook after a written stage: a stop with nothing to place on the canvas."""
import unittest
from pathlib import Path

CHAT = (Path(__file__).resolve().parent.parent / "web" / "agent_chat.js").read_text(encoding="utf-8")


class ReviewText(unittest.TestCase):
    def setUp(self):
        self.body = CHAT.split("  _reviewText(ev) {", 1)[1].split("\n  }\n", 1)[0]

    def test_the_op_has_its_own_handler(self):
        self.assertIn('else if (ev.op === "review_text") this._reviewText(ev);', CHAT)

    def test_it_does_not_claim_something_was_dropped_on_the_canvas(self):
        self.assertIn('ev.op !== "review_released" && ev.op !== "review_text"', CHAT)

    def test_it_raises_the_same_stop_the_collector_does(self):
        self.assertIn("window.agentYReviewHalted = true;", self.body)
        self.assertIn('new CustomEvent("agentY:review", { detail: { halted: true } })', self.body)

    def test_it_places_no_node(self):
        self.assertNotIn("createNode", self.body)
        self.assertNotIn("graph.add", self.body)

    def test_a_released_text_review_does_not_speak_of_a_collector(self):
        self.assertIn('ev.text ? "▶️ Continuing with the text as it stands."', CHAT)


if __name__ == "__main__":
    unittest.main()
