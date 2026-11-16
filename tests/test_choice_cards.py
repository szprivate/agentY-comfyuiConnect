"""A choices block in the agent's answer is drawn as cards; a click answers.

agent_choices.js is the arithmetic (run under node when it is installed); the
wiring into agent_chat.js is checked in its source, like test_ask_lifecycle.
agentY's src/utils/choices.py reads the same block (Slack's numbered list, a
bare number spelled out) and must agree with ``answerFor``.

    python -m unittest tests.test_choice_cards
"""
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

WEB = pathlib.Path(__file__).resolve().parents[1] / "web"
NODE = shutil.which("node")

ANSWER = ("Both kinds exist.\n\n```choices\nWhich workflow should I use?\n"
          "1. Local - ltx | runs <here>\n2. API - ltx api | credits\n```\nthanks")


def run_node(script: str) -> dict:
    with tempfile.TemporaryDirectory() as d:
        src = (WEB / "agent_choices.js").read_text(encoding="utf-8")
        (pathlib.Path(d) / "agent_choices.mjs").write_text(src, encoding="utf-8")
        f = pathlib.Path(d) / "t.mjs"
        f.write_text(script, encoding="utf-8")
        out = subprocess.run([NODE, str(f)], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipUnless(NODE, "node is not installed")
class TheBlock(unittest.TestCase):
    def test_parsed_split_and_drawn(self):
        r = run_node(f"""
import * as C from "./agent_choices.mjs";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}}[c]));
const text = {json.dumps(ANSWER)};
const parts = C.splitChoices(text);
const c = C.findChoices(text);
console.log(JSON.stringify({{
  kinds: parts.map((p) => p.choice ? "choice" : "text"),
  question: c.question, labels: c.options.map((o) => o.label), details: c.options.map((o) => o.detail),
  answer: C.answerFor(c.options[1]),
  html: C.choicesHtml(c, esc),
  one: C.findChoices("```choices\\nq\\n1. only\\n```"),
  open: C.splitChoices("```choices\\nq\\n1. a\\n2. b").map((p) => p.choice ? "choice" : "text"),
}}));
""")
        self.assertEqual(r["kinds"], ["text", "choice", "text"])
        self.assertEqual(r["question"], "Which workflow should I use?")
        self.assertEqual(r["labels"], ["Local - ltx", "API - ltx api"])
        self.assertEqual(r["details"], ["runs <here>", "credits"])
        # The words agentY's choices.resolve_reply spells "2" out to.
        self.assertEqual(r["answer"], "2. API - ltx api (credits)")
        self.assertIn('data-answer="2. API - ltx api (credits)"', r["html"])
        self.assertIn("runs &lt;here&gt;", r["html"])
        self.assertNotIn("<here>", r["html"])
        self.assertIsNone(r["one"])
        self.assertEqual(r["open"], ["text"])   # still streaming: plain text


class TheWiring(unittest.TestCase):
    SRC = (WEB / "agent_chat.js").read_text(encoding="utf-8")

    def test_messages_draw_cards(self):
        self.assertIn('from "./agent_choices.js"', self.SRC)
        self.assertIn("choicesHtml(p.choice, escapeHtml)", self.SRC)
        self.assertIn("${CHOICES_CSS}", self.SRC)

    def test_one_listener_on_the_log_answers(self):
        # Delegated, so cards in a log rebuilt from its saved HTML still answer.
        self.assertIn('closest?.(".ay-choice[data-answer]")', self.SRC)
        body = self.SRC.split("_pickChoice(card) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn("this.send()", body)
        self.assertIn("if (this.streaming) return", body)

    def test_the_next_message_closes_the_question(self):
        body = self.SRC.split("  _userMsg(text) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn('.ay-choices:not(.answered)', body)
        # The user's own text is never drawn as cards.
        self.assertIn("mdPlain(text)", body)


if __name__ == "__main__":
    unittest.main()
