"""The live usage line under the composer.

The host sends a "usage" event while a turn runs; the panel keeps it on the
conversation it belongs to and shows it for the one on screen. The wording is
checked with node where there is one; the wiring is checked by reading the file.
"""
import json
import pathlib
import shutil
import subprocess
import unittest

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
NODE = shutil.which("node")

SCRIPT = """
import { formatUsage, compactCount, formatCost } from %s;
const cases = %s;
console.log(JSON.stringify({
  lines: cases.map(formatUsage),
  counts: [0, 999, 1000, 1500, 9990, 10000, 123456, 999999, 1000000, 2500000].map(compactCount),
  costs: [0, 0.004, 0.0312, 12.5, -1, NaN].map(formatCost),
}));
"""


class Wiring(unittest.TestCase):

    def setUp(self):
        self.chat = (WEB / "agent_chat.js").read_text(encoding="utf-8")

    def test_the_panel_handles_the_event_and_keeps_it_per_conversation(self):
        self.assertIn('import { formatUsage } from "./agent_usage.js";', self.chat)
        self.assertIn('case "usage":', self.chat)
        self.assertIn("this._ctx().usage = ev;", self.chat)

    def test_a_new_turn_starts_from_nothing(self):
        request = self.chat.split('case "request":', 1)[1][:200]
        self.assertIn("this._ctx().usage = null;", request)

    def test_switching_conversations_shows_that_conversations_line(self):
        show = self.chat.split("  _show(ctx) {", 1)[1][:500]
        self.assertIn("this._renderUsage();", show)

    def test_the_line_is_in_the_composer_and_hidden_until_there_is_something(self):
        self.assertIn('className: "ay-usage", hidden: true', self.chat)
        self.assertIn("inrow, this.usageEl, this.fileInput", self.chat)
        self.assertIn(".ay-usage{", self.chat)


@unittest.skipUnless(NODE, "no node on PATH")
class Wording(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cases = [
            {"input": 12400, "output": 1180, "cache_hit": 0.68, "cost": 0.0312, "calls": 9},
            {"input": 950, "output": 12, "cache_hit": 0, "cost": None, "calls": 1},
            {"input": 1250000, "output": 45000, "cache_hit": 0.5, "cost": 0.004, "calls": 40},
            None,
        ]
        script = SCRIPT % (json.dumps((WEB / "agent_usage.js").as_uri()), json.dumps(cases))
        out = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True,
                             encoding="utf-8", timeout=60)
        assert out.returncode == 0, out.stderr
        cls.got = json.loads(out.stdout)

    def test_a_full_line(self):
        self.assertEqual(self.got["lines"][0], "\U0001fa99 12.4k in · 1.18k out · 68% cached · $0.03 · 9 calls")

    def test_no_price_and_no_cache_are_left_out_not_shown_as_zero(self):
        self.assertEqual(self.got["lines"][1], "\U0001fa99 950 in · 12 out · 1 call")

    def test_a_tiny_cost_is_not_rounded_to_free(self):
        self.assertIn("<$0.01", self.got["lines"][2])

    def test_nothing_to_show_is_an_empty_line(self):
        self.assertEqual(self.got["lines"][3], "")

    def test_counts_are_compact_and_never_read_1000k(self):
        self.assertEqual(self.got["counts"],
                         ["0", "999", "1k", "1.5k", "9.99k", "10k", "123.5k", "1M", "1M", "2.5M"])

    def test_costs(self):
        self.assertEqual(self.got["costs"], ["$0.00", "<$0.01", "$0.03", "$12.50", "", ""])


if __name__ == "__main__":
    unittest.main()
