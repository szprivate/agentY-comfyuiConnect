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
ARGS = ["--autoplay-policy=no-user-gesture-required"]


def _part(start, end):
    """The source from `start` up to the first line that closes it (a top-level `}` or a method's `  }`)."""
    body = CHAT.split(start, 1)[1]
    return start + body.split("\n" + ("}" if not start.startswith("  ") else "  }") + "\n", 1)[0] + end


SOURCE = "\n".join([
    _part("function el(tag", "\n}\n"),
    _part("function comfyBase()", "\n}\n"),
    "const AUDIO_NAME = " + CHAT.split("const AUDIO_NAME = ", 1)[1].split("\n", 1)[0],
    _part("export function isAudioOutput(ev)", "\n}\n").replace("export function", "function"),
    "let _soundPlaying = null;",
    "const SND_ICON = " + CHAT.split("const SND_ICON = ", 1)[1].split("\n};\n", 1)[0] + "\n};",
    _part("function soundTime(t)", "\n}\n"),
    _part("function soundPlayer(src)", "\n}\n"),
    "const showOutput = function " + _part("  _showOutput(ev) {", "\n  }\n").strip()[len("_showOutput"):] + ";",
    "window.__show = (ev) => showOutput.call(window.__chat, ev);",
])

# The player's own rules from the panel's stylesheet, so it has the size it has in the panel.
STYLE = "\n".join(line for line in CHAT.split("\n")
                  if line.lstrip().startswith((".ay-snd", ".ay-out-audio")))
PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>#log{width:340px}%s</style></head>
<body><div id="log"></div>
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
                cls.browser = cls.pw.chromium.launch(channel=channel, headless=True, args=ARGS) if channel \
                    else cls.pw.chromium.launch(headless=True, args=ARGS)
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
            return route.fulfill(status=200, content_type="text/html", body=PAGE % (STYLE, SOURCE))
        if path == "/view":
            self.views.append(url)
            if ".wav" in url:
                # Byte ranges, as ComfyUI's /view (aiohttp FileResponse) answers them: without them
                # the browser cannot move the playhead.
                rng = (route.request.headers.get("range") or "").replace("bytes=", "")
                size = len(self.wav)
                if rng:
                    a, _, b = rng.partition("-")
                    a, b = int(a or 0), int(b) if b else size - 1
                    return route.fulfill(status=206, content_type="audio/wav", body=self.wav[a:b + 1],
                                         headers={"accept-ranges": "bytes",
                                                  "content-range": f"bytes {a}-{b}/{size}"})
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
          const m = c.querySelector('audio') || c.firstElementChild;
          return { tag: m.tagName.toLowerCase(), src: m.getAttribute('src'), controls: !!m.controls,
                   player: !!c.querySelector('.ay-snd .ay-snd-play'),
                   cls: c.className, label: c.querySelector('.ay-out-label').textContent, file: c.dataset.file }; })""")

    def test_a_sound_with_no_loader_chosen_plays_in_the_chat(self):
        self.show({"kind": "file", "path": "D:/out/agent/voice.wav", "filename": "agentY/voice.wav",
                   "name": "voice.wav", "index": None, "show": True})
        cards = self.cards()
        self.assertEqual(len(cards), 1)
        c = cards[0]
        # Our own small player around an <audio> with no browser controls.
        self.assertEqual((c["tag"], c["controls"], c["player"]), ("audio", False, True))
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


    # -- the player: play/pause, stop, playhead --------------------------------

    def _one(self, name="voice.wav"):
        self.show({"kind": "file", "path": "D:/out/" + name, "filename": "agentY/" + name, "name": name,
                   "show": True})
        self.page.wait_for_function("() => [...document.querySelectorAll('#log audio')].every((a) => a.duration > 0)",
                                    timeout=10000)

    def state(self, i=0):
        return self.page.evaluate("""(i) => { const box = document.querySelectorAll('#log .ay-snd')[i];
          const a = box.querySelector('audio');
          return { paused: a.paused, t: a.currentTime, d: a.duration, title: box.querySelector('.ay-snd-play').title,
                   playing: box.classList.contains('playing'), time: box.querySelector('.ay-snd-time').textContent,
                   fill: parseFloat(box.querySelector('.ay-snd-fill').style.width) || 0 }; }""", i)

    def test_play_pause_and_stop(self):
        self._one()
        self.assertEqual(self.state()["time"], "0:00 / 0:01")
        self.page.click("#log .ay-snd-play")
        self.page.wait_for_function("() => document.querySelector('#log audio').currentTime > 0.2", timeout=5000)
        st = self.state()
        self.assertFalse(st["paused"])
        self.assertEqual((st["title"], st["playing"]), ("Pause", True))
        self.assertGreater(st["fill"], 0)
        self.page.click("#log .ay-snd-play")
        st = self.state()
        self.assertTrue(st["paused"])
        self.assertEqual(st["title"], "Play")
        self.assertGreater(st["t"], 0.2, "pause keeps the place")
        self.page.click("#log .ay-snd-stop")
        st = self.state()
        self.assertTrue(st["paused"])
        self.assertEqual((st["t"], st["fill"]), (0, 0), "stop goes back to the start")
        self.assertEqual(self.errors, [])

    def test_click_on_the_bar_moves_the_playhead(self):
        self._one()
        box = self.page.locator("#log .ay-snd-bar").bounding_box()
        self.page.mouse.click(box["x"] + box["width"] * 0.75, box["y"] + box["height"] / 2)
        st = self.state()
        self.assertAlmostEqual(st["t"] / st["d"], 0.75, delta=0.05)
        self.assertAlmostEqual(st["fill"], 75, delta=5)
        self.assertTrue(st["paused"], "seeking does not start it")
        # Dragging follows the pointer.
        self.page.mouse.move(box["x"] + box["width"] * 0.6, box["y"] + 5)
        self.page.mouse.down()
        self.page.mouse.move(box["x"] + box["width"] * 0.25, box["y"] + 5, steps=4)
        self.page.mouse.up()
        st = self.state()
        self.assertAlmostEqual(st["t"] / st["d"], 0.25, delta=0.05)
        self.assertEqual(self.errors, [])

    def test_one_sound_at_a_time(self):
        self._one("a.wav")
        self._one("b.wav")
        plays = self.page.locator("#log .ay-snd-play")
        plays.nth(0).click()
        self.page.wait_for_function("() => !document.querySelectorAll('#log audio')[0].paused", timeout=5000)
        plays.nth(1).click()
        self.page.wait_for_function("() => !document.querySelectorAll('#log audio')[1].paused", timeout=5000)
        self.assertTrue(self.state(0)["paused"], "starting the second pauses the first")
        self.assertFalse(self.state(1)["paused"])


if __name__ == "__main__":
    unittest.main()
