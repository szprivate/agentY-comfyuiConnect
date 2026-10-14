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
import { formatUsage, compactCount, formatClock } from %s;
const cases = %s;
console.log(JSON.stringify({
  lines: cases.map((u) => formatUsage(u)),
  timed: [formatUsage(cases[0], 187.6), formatUsage(null, 4), formatUsage(null, null)],
  counts: [0, 999, 1000, 1500, 9990, 10000, 123456, 999999, 1000000, 2500000].map(compactCount),
  clocks: [0, 7, 59.9, 60, 187, 3599, 3725, -3, NaN].map(formatClock),
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
        request = self.chat.split('case "request":', 1)[1][:400]
        self.assertIn("ctx.usage = null;", request)
        self.assertIn("ctx.turnStart = ", request)
        self.assertIn("ctx.turnEnd = null;", request)

    def test_the_clock_runs_from_the_turns_start_and_stops_at_done(self):
        request = self.chat.split('case "request":', 1)[1][:400]
        self.assertIn("Number(ev.started) * 1000", request, "a turn followed after a reload says when it began")
        done = self.chat.split('case "done":', 1)[1][:1500]
        self.assertIn("turnEnd = this._ctx().turnEnd || Date.now()", done)
        render = self.chat.split("  _renderUsage() {", 1)[1][:1200]
        self.assertIn("setInterval(() => this._renderUsage(), 1000)", render)
        self.assertIn("clearInterval(this._clockTimer)", render)
        server = (WEB.parent.parent / "agentY" / "src" / "utils" / "agentY_server.py")
        if server.is_file():
            text = server.read_text(encoding="utf-8")
            self.assertIn('"type": "request", "request_id": rid, "started": time.time()', text)
            self.assertIn('"started": t.started if t is not None else None', text)

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

    def test_a_full_line_has_no_cost(self):
        self.assertEqual(self.got["lines"][0], "\U0001fa99 12.4k in · 1.18k out · 68% cached · 9 calls")
        self.assertNotIn("$", "".join(self.got["lines"]))

    def test_no_cache_is_left_out_not_shown_as_zero(self):
        self.assertEqual(self.got["lines"][1], "\U0001fa99 950 in · 12 out · 1 call")

    def test_the_clock_closes_the_line_and_can_stand_alone(self):
        self.assertEqual(self.got["timed"][0],
                         "\U0001fa99 12.4k in · 1.18k out · 68% cached · 9 calls · ⏱ 3:07")
        self.assertEqual(self.got["timed"][1], "⏱ 0:04")
        self.assertEqual(self.got["timed"][2], "")

    def test_the_clock_reads_minutes_and_seconds(self):
        self.assertEqual(self.got["clocks"],
                         ["0:00", "0:07", "0:59", "1:00", "3:07", "59:59", "1:02:05", "0:00", "0:00"])

    def test_nothing_to_show_is_an_empty_line(self):
        self.assertEqual(self.got["lines"][3], "")

    def test_counts_are_compact_and_never_read_1000k(self):
        self.assertEqual(self.got["counts"],
                         ["0", "999", "1k", "1.5k", "9.99k", "10k", "123.5k", "1M", "1M", "2.5M"])


class ResultsInTheChat(unittest.TestCase):
    """A finished image or video is shown in the chat with its number."""

    def setUp(self):
        self.chat = (WEB / "agent_chat.js").read_text(encoding="utf-8").replace("\r\n", "\n")
        self.show = self.chat.split("  _showOutput(ev) {", 1)[1].split("\n  injectNode(ev) {", 1)[0]

    def test_it_is_shown_before_anything_decides_about_the_canvas(self):
        inject = self.chat.split("\n  injectNode(ev) {", 1)[1][:200]
        self.assertIn("this._showOutput(ev);", inject)
        self.assertLess(inject.index("this._showOutput(ev);"), inject.index("//"))

    def test_only_an_explicit_false_switches_it_off(self):
        self.assertIn("if (!ev || ev.show === false) return;", self.show)

    def test_it_carries_the_conversations_number(self):
        self.assertIn('ev.index ? "#" + ev.index : ""', self.show)

    def test_the_picture_comes_from_comfyui_and_a_repeat_is_not_shown_twice(self):
        self.assertIn('"/view?type=input&filename=" + encodeURIComponent(ev.filename.slice(cut + 1))', self.show)
        self.assertIn('"&subfolder=" + encodeURIComponent(ev.filename.slice(0, cut))', self.show,
                      "agentY stages into input/agentY; /view keeps only the last part of filename")
        self.assertIn("have.dataset.file === ev.filename", self.show)

    def test_the_setting_is_in_the_dialog_with_its_explanation(self):
        settings = (WEB / "agent_settings.js").read_text(encoding="utf-8")
        self.assertIn('"show_outputs_in_panel"', settings)
        self.assertIn("show_outputs_in_panel:", settings)


if __name__ == "__main__":
    unittest.main()
