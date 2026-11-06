"""A sound the agent made plays in the chat, in a real browser.

The REAL _showOutput, isAudioOutput and el() from web/agent_chat.js run in Chromium (Playwright) against a
stand-in log; /view answers with a real WAV. A sound comes as kind "audio" when a loader was chosen for it
(Settings > Load & save nodes) and as a plain "file" otherwise: both get a player that loads the file. A file
that is not a sound gets no card, and pictures and clips keep theirs.

Needs Playwright with an installed Edge or Chrome (or Playwright's Chromium); skipped without them.
Run: python -m unittest tests.test_sound_results_browser
"""
import io
import json
import math
import pathlib
import struct
import unittest
import wave

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

CHAT = (pathlib.Path(__file__).resolve().parent.parent / "web" / "agent_chat.js").read_text(encoding="utf-8")
ORIGIN = "http://agenty.test"


def _part(start, end):
    """The source from `start` up to the first line that closes it (a top-level `}` or a method's `  }`)."""
    body = CHAT.split(start, 1)[1]
    return start + body.split("\n" + ("}" if not start.startswith("  ") else "  }") + "\n", 1)[0] + end


SOURCE = "\n".join([
    _part("function el(tag", "\n}\n"),
    _part("function comfyBase()", "\n}\n"),
    "const AUDIO_NAME = " + CHAT.split("const AUDIO_NAME = ", 1)[1].split("\n", 1)[0],
    _part("export function isAudioOutput(ev)", "\n}\n").replace("export function", "function"),
    "const showOutput = function " + _part("  _showOutput(ev) {", "\n  }\n").strip()[len("_showOutput"):] + ";",
    "window.__show = (ev) => showOutput.call(window.__chat, ev);",
])

PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body><div id="log"></div>
<script>
window.__chat = { logEl: document.getElementById("log"), _scroll() {} };
%s
window.__ready = true;
</script></body></html>"""


def _wav(seconds=1.5, rate=8000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 330 * i / rate)))
                               for i in range(int(seconds * rate))))
    return buf.getvalue()


@unittest.skipIf(sync_playwright is None, "needs playwright")
class SoundResults(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = None
        for channel in ("msedge", "chrome", None):
            try:
                cls.browser = cls.pw.chromium.launch(channel=channel, headless=True) if channel \
                    else cls.pw.chromium.launch(headless=True)
                break
            except Exception:
                continue
        if cls.browser is None:
            cls.pw.stop()
            raise unittest.SkipTest("no browser for playwright")
        cls.wav = _wav()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def _serve(self, route):
        url = route.request.url
        path = url[len(ORIGIN):].split("?")[0]
        if path == "/":
            return route.fulfill(status=200, content_type="text/html", body=PAGE % SOURCE)
        if path == "/view":
            self.views.append(url)
            if ".wav" in url:
                return route.fulfill(status=200, content_type="audio/wav", body=self.wav,
                                     headers={"accept-ranges": "bytes"})
            return route.fulfill(status=404, body="")
        return route.fulfill(status=404, body="")

    def setUp(self):
        self.views = []
        self.errors = []
        self.page = self.browser.new_page()
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.route("**/*", self._serve)
        self.page.goto(ORIGIN + "/")
        self.page.wait_for_function("window.__ready === true")

    def tearDown(self):
        self.page.close()

    def show(self, ev):
        self.page.evaluate("(ev) => window.__show(ev)", ev)

    def cards(self):
        return self.page.evaluate("""() => [...document.querySelectorAll('#log .ay-out')].map((c) => {
          const m = c.firstElementChild;
          return { tag: m.tagName.toLowerCase(), src: m.getAttribute('src'), controls: !!m.controls,
                   cls: c.className, label: c.querySelector('.ay-out-label').textContent, file: c.dataset.file }; })""")

    def test_a_sound_with_no_loader_chosen_plays_in_the_chat(self):
        self.show({"kind": "file", "path": "D:/out/agent/voice.wav", "filename": "agentY/voice.wav",
                   "name": "voice.wav", "index": None, "show": True})
        cards = self.cards()
        self.assertEqual(len(cards), 1)
        c = cards[0]
        self.assertEqual((c["tag"], c["controls"]), ("audio", True))
        self.assertIn("ay-out-sound", c["cls"])
        self.assertEqual(c["src"], ORIGIN + "/view?type=input&filename=voice.wav&subfolder=agentY")
        self.assertEqual(c["label"], "voice.wav")
        # The player really loads it.
        self.page.wait_for_function("() => document.querySelector('#log audio').duration > 0", timeout=10000)
        self.assertAlmostEqual(self.page.evaluate("() => document.querySelector('#log audio').duration"), 1.5, delta=0.05)
        # Shown once: the same result read again from the turn's start adds nothing.
        self.show({"kind": "file", "path": "D:/out/agent/voice.wav", "filename": "agentY/voice.wav",
                   "name": "voice.wav", "show": True})
        self.assertEqual(len(self.cards()), 1)
        self.assertEqual(self.errors, [])

    def test_a_sound_with_a_loader_chosen_too(self):
        self.show({"kind": "audio", "path": "D:/out/song.mp3", "filename": "agentY/song.mp3", "name": "song.mp3",
                   "index": 4, "show": True})
        self.assertEqual([(c["tag"], c["label"]) for c in self.cards()], [("audio", "#4 · song.mp3")])

    def test_other_files_get_no_card_and_pictures_keep_theirs(self):
        self.show({"kind": "file", "path": "D:/out/notes.txt", "filename": "agentY/notes.txt", "name": "notes.txt",
                   "show": True})
        self.show({"kind": "file", "path": "D:/out/voice.wav", "filename": None, "name": "voice.wav", "show": True})
        self.show({"kind": "file", "path": "D:/out/hidden.wav", "filename": "agentY/hidden.wav", "show": False})
        self.assertEqual(self.cards(), [], "not a sound, not staged, or switched off: no card")
        self.show({"kind": "image", "path": "D:/out/a.png", "filename": "agentY/a.png", "name": "a.png", "index": 1})
        self.show({"kind": "video", "path": "D:/out/b.mp4", "filename": "agentY/b.mp4", "name": "b.mp4", "index": 2})
        self.assertEqual([c["tag"] for c in self.cards()], ["img", "video"])


if __name__ == "__main__":
    unittest.main()
