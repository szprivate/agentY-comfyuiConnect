"""A stream we own stops counting as proof of life once it goes quiet.

The report, three times over three fixes: "the CLI says the orchestrator finished
but the panel became unresponsive". Each fix went to a different way the `done`
event could be lost — an event json could not encode, a generator torn down with
`done` still behind it in the queue, a runner that vanished — and each was right
about its own case. What survived all three is the assumption underneath them:
that a fetch the panel opened is, by itself, evidence that a turn is still
running. It is not. A reader parked on a connection that will never deliver
another byte and never signal EOF looks exactly like a long render, forever, and
while it looks that way the heartbeat returns at its first line, `send()` only
queues, and nothing in the panel can ever notice.

So the panel now times the silence instead of trusting the socket. The host sends
a keep-alive comment every 15s for the whole of a turn, however long and however
quiet, which makes silence measurable and unambiguous: past STREAM_SILENCE_MS
this is not a slow turn, and the host is asked directly whether the run still
exists. That answer needs no cooperation from the stream that broke, which is why
it closes the class rather than one more instance of it.

Read rather than run, for the reason test_panel_js.py gives: a ComfyUI install
has no JavaScript engine to run it with.
"""
import pathlib
import re
import unittest

CHAT = pathlib.Path(__file__).resolve().parent.parent / "web" / "agent_chat.js"


def block(src: str, start: str, end: str) -> str:
    i = src.index(start)
    j = src.index(end, i + len(start))
    return src[i:j]


class SilenceIsMeasured(unittest.TestCase):
    def setUp(self):
        self.src = CHAT.read_text(encoding="utf-8")

    def test_the_threshold_clears_the_keep_alive_cadence(self):
        """15s between keep-alives (agentY_server._stream_turn's `poll`), so the
        threshold has to leave room for a missed tick or a throttled tab without
        becoming so long the panel is unusable while it waits."""
        ms = int(re.search(r"const STREAM_SILENCE_MS = (\d+);", self.src).group(1))
        self.assertGreaterEqual(ms, 60000)
        self.assertLessEqual(ms, 180000)

    def test_every_byte_resets_the_clock(self):
        """Including keep-alive comments: this measures liveness, not activity.
        Reading only data frames would make a long quiet render look dead."""
        loop = block(self.src, "const reader = resp.body.getReader();", "} catch (e) {")
        self.assertIn("this._lastStreamAt = Date.now();", loop)
        # Before the EOF check, or a stream that ends is never timestamped.
        self.assertLess(loop.index("this._lastStreamAt = Date.now();"),
                        loop.index("if (done) break;"))

    def test_the_clock_starts_when_the_stream_does(self):
        """Otherwise the first tick after a page load sees `undefined` and calls
        a stream that has barely opened quiet."""
        start = block(self.src, "const token = ++this._streamToken;", "this._setBusy(true);")
        self.assertIn("this._lastStreamAt = Date.now();", start)

    def test_a_quiet_stream_no_longer_short_circuits_the_heartbeat(self):
        """The one line that made every lost `done` permanent."""
        beat = block(self.src, "_startHeartbeat()", "}, 5000);")
        self.assertIn("if (this.streaming && !this._adoptedRun && !this._streamGoneQuiet()) return;",
                      beat)
        # …and having stopped short-circuiting, the tick must actually go and ask.
        self.assertIn("this._adoptedRun || this.activeAsk || this._streamGoneQuiet()", beat)

    def test_quiet_means_quiet_and_ours(self):
        """An adopted run has its own path, and a panel with no stream at all is
        not quiet — it is idle. Both must answer false, or every idle tick would
        run the recovery below."""
        fn = block(self.src, "_streamGoneQuiet() {", "\n  }")
        self.assertIn("if (!this.streaming || this._adoptedRun) return false;", fn)
        self.assertIn("STREAM_SILENCE_MS", fn)


class TheRecoveryAsksTheHost(unittest.TestCase):
    def setUp(self):
        self.sync = block(CHAT.read_text(encoding="utf-8"),
                          "async _syncRunState()", "const watched =")

    def test_it_fires_only_on_silence_and_only_on_a_run_the_host_has_lost(self):
        """Two conditions, both required. Silence alone would abort a healthy
        stream whose request id we happen not to recognise; a missing run alone
        would fire on every tick of a turn that is streaming perfectly well."""
        self.assertIn("this._streamGoneQuiet() && this.curRequestId", self.sync)
        self.assertIn("!runs.some((x) => x.request_id === this.curRequestId)", self.sync)

    def test_it_aborts_the_stuck_fetch(self):
        """Without the abort the reader stays parked, and whenever it did finally
        resolve its `finally` would undo the recovery — the token still matches."""
        self.assertIn("this.abortController.abort()", self.sync)

    def test_it_hands_the_panel_back(self):
        """The point of the whole exercise: sending has to work again."""
        for line in ("this.streaming = false;", "this._setBusy(false);",
                     "this._maybeDispatchQueued();"):
            self.assertIn(line, self.sync)

    def test_it_rebuilds_the_conversation_rather_than_keeping_a_half_written_one(self):
        """The stream stopped mid-answer, so the DOM is mid-answer. The host has
        the finished text; the panel snapshot does not."""
        self.assertIn("this._forgetStalePanel(stranded)", self.sync)
        self.assertIn("this._renderThread(stranded, true)", self.sync)

    def test_it_keys_on_the_request_not_the_conversation(self):
        """A turn left running in another conversation must survive this."""
        self.assertIn("const stranded = this.streamThreadId;", self.sync)
        self.assertIn("stranded === this.threadId", self.sync)
