"""A question the agent asked must not outlive the turn that asked it.

The failure this pins, in the words it was reported in: "the CLI says the
orchestrator finished but the panel became unresponsive". Every earlier fix went
to the host, and the host was innocent — its trace reads `post:emit_done`,
`sse yielding done`, `runner exited`, in order, every time.

What actually happened is in this file's subject. While ``activeAsk`` is set,
``send()`` routes the message to POST /agentY/reply instead of starting a turn.
The host pops its reply registry when the turn ends, so that route then answers
404 — and the panel neither cleared ``activeAsk`` on ``done`` nor looked at the
reply's status. So every message after such a turn was echoed into the log,
refused by the host, and dropped without a word. It could not recover on its own
either: the send button reads Send (not Stop) while an ask is pending, putting
``_stop()`` — the one path that did clear it — out of reach, and
``_maybeDispatchQueued`` bails on ``activeAsk``, so the queue never drained. Only
reloading the browser tab brought the panel back.

Checked by reading the source rather than by running it: there is no node in a
ComfyUI install (see test_panel_js.py), and these are three specific lines whose
absence is the bug. Structural, so each assertion names the line it wants and the
block it must be in — not "the file mentions activeAsk somewhere".
"""
import pathlib
import re
import unittest

CHAT = (pathlib.Path(__file__).resolve().parent.parent / "web" / "agent_chat.js")


def block(src: str, start: str, end: str) -> str:
    """The source between *start* and the first *end* after it."""
    i = src.index(start)
    j = src.index(end, i + len(start))
    return src[i:j]


class TheQuestionEndsWithItsTurn(unittest.TestCase):
    def setUp(self):
        self.src = CHAT.read_text(encoding="utf-8")

    def test_done_clears_the_pending_ask(self):
        """The event that ends the turn is the event that must retire its question.

        The host pops the reply registry in the same breath as this event, so an
        ask still standing after it can only ever be answered into a 404.
        """
        done = block(self.src, 'case "done":', "this._maybeDispatchQueued();")
        self.assertIn("this.activeAsk = null;", done)

    def test_done_clears_it_before_it_re_reads_the_busy_state(self):
        """_setBusy renders the button from activeAsk, and _maybeDispatchQueued
        refuses to dispatch while one is set — both must see the cleared value."""
        done = block(self.src, 'case "done":', "this._maybeDispatchQueued();")
        self.assertLess(done.index("this.activeAsk = null;"), done.index("this._setBusy(false)"))

    def test_a_refused_reply_is_sent_as_an_ordinary_message(self):
        """404 = nobody is waiting. Returning there is what made the message
        vanish; the second defence is that it goes out as a normal turn instead."""
        reply = block(self.src, "// Answering an interactive ask", "// A turn is already running")
        self.assertIn("/agentY/reply", reply)
        # The verdict has to come from what the host said, not from a constant —
        # the whole defect was believing the reply had landed without looking.
        self.assertIn("r.status === 404", reply)
        self.assertIn("if (!stale) return;", reply)
        self.assertIn("return this.send();", reply)
        # And the re-send must not echo the message a second time — it is already
        # in the log from the line above.
        self.assertIn("this._skipEcho = true;", reply)

    def test_a_stale_ask_is_reconciled_against_the_host(self):
        """For the case this cannot prevent: a `done` that never arrives. The runs
        endpoint is the only other thing that knows the turn is over."""
        sync = block(self.src, "async _syncRunState()", "const watched =")
        self.assertIn("this.activeAsk", sync)
        self.assertIn("x.request_id === this.activeAsk", sync)

    def test_the_heartbeat_keeps_ticking_while_an_ask_is_pending(self):
        """…because nothing else does. The notify poll stops when nothing is in
        flight and the stream is over, so without this the stale state is
        permanent — which is exactly how it presented."""
        beat = block(self.src, "_startHeartbeat()", "}, 5000);")
        self.assertIn("this._adoptedRun || this.activeAsk", beat)

    def test_stop_still_clears_it(self):
        """The manual escape hatch stays, and stays unconditional."""
        stop = block(self.src, "async _stop()", "_setBusy(b)")
        self.assertIn("this.activeAsk = null;", stop)


class NoOtherPathLeavesItSet(unittest.TestCase):
    """Every assignment of activeAsk, accounted for.

    A whitelist rather than a count: the point is that a new one cannot be added
    without someone deciding, here, what retires it.
    """

    def test_the_places_that_set_it_are_the_ones_we_know_about(self):
        src = CHAT.read_text(encoding="utf-8")
        setters = re.findall(r"this\.activeAsk = ([^;]+);", src)
        self.assertEqual(
            sorted(set(setters)),
            sorted({
                "null",                                             # done / stop / sync / reply sent
                "ev.request_id",                                    # the ask arrives (twice)
                "mine.awaiting_reply ? mine.request_id : null",     # adopting a running turn
            }))
