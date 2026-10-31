"""Composer word jumps, the `#` menu's key handling, and the result-picture click, in a real browser.

The REAL web/agent_tags.js and web/agent_composer_keys.js run in Chromium (Playwright),
with ComfyUI's scripts/app.js stubbed. Each case runs twice: the box in the page (the
sidebar) and the box inside a shadow root (the bEpic viewer's docked panel).

Needs Playwright with an installed Edge or Chrome (or Playwright's Chromium); skipped
without them. Run: python -m unittest tests.test_composer_keys_browser

The regressions it pins:
  * Alt+Left/Right in the composer did nothing (the browser has no Alt word jump on
    Windows; it reads Alt+Left as Back) - the composer does the jump itself now.
  * a picture in a log rebuilt from saved HTML (a reload, a re-opened conversation)
    had lost its per-picture click listener; the log's one listener shows it now
    (over the panel: tests/test_panel_hosts_browser.py has it in every host).
"""
import json
import pathlib
import unittest

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
ORIGIN = "http://agenty.test"

APP_STUB = """
export const app = {
  graph: null,
  registerExtension(ext) { (window.__exts = window.__exts || []).push(ext); },
};
"""

# The wiring agent_chat.js does, against the real modules: the composer's keydown
# runs altWordJump first (_onKeydown), the log has one click listener that shows
# fullSizeSrc over the panel (_makeCtx). The log is filled from HTML, like a restored panel.
PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="side"></div><div id="host"></div>
<script type="module">
import { registerTagBox } from "/extensions/agentY/agent_tags.js";
import { altWordJump, fullSizeSrc, showFullSize } from "/extensions/agentY/agent_composer_keys.js";
import { eventTarget } from "/extensions/agentY/agent_ui_root.js";
for (const ext of window.__exts || []) if (ext.setup) ext.setup();
window.__opened = [];
window.open = (url) => { window.__opened.push(url); return null; };
window.__seen = [];
window.addEventListener("keydown", (e) => window.__seen.push(
  { key: e.key, alt: e.altKey, ctrl: e.ctrlKey, prevented: e.defaultPrevented }));
function build(root) {
  const wrap = document.createElement("div");
  wrap.className = "ay-wrap";
  wrap.style.position = "relative";
  wrap.innerHTML = '<div class="ay-log" style="height:200px"></div>'
    + '<div class="inwrap"><textarea class="ay-input" style="width:300px;height:60px"></textarea></div>';
  root.appendChild(wrap);
  const ta = wrap.querySelector("textarea"), log = wrap.querySelector(".ay-log");
  ta.addEventListener("keydown", (e) => { altWordJump(e, ta); });
  registerTagBox(ta, { inserts: "name", anchor: "above", within: wrap.querySelector(".inwrap") });
  log.addEventListener("click", (e) => {
    const t = eventTarget(e);
    const src = fullSizeSrc(t);
    if (src) showFullSize(t, src);
  });
  log.innerHTML = '<div class="ay-msg ay-out"><img class="ay-out-media" '
    + 'src="/view?type=input&filename=a.png" style="width:120px;height:80px;display:block">'
    + '<div class="ay-out-label">#1 a.png</div></div>';
  return wrap;
}
build(document.getElementById("side"));
build(document.getElementById("host").attachShadow({ mode: "open" }));
window.__ready = true;
</script></body></html>"""

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


@unittest.skipIf(sync_playwright is None, "needs playwright")
class ComposerKeysBrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = None
        for channel in ("msedge", "chrome", None):
            try:
                cls.browser = (cls.pw.chromium.launch(channel=channel, headless=True) if channel
                               else cls.pw.chromium.launch(headless=True))
                break
            except Exception:
                continue
        if cls.browser is None:
            cls.pw.stop()
            raise unittest.SkipTest("no browser for playwright")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 900, "height": 700})
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.route("**/*", self._serve)
        self.page.goto(ORIGIN + "/")
        self.page.wait_for_function("window.__ready === true", timeout=10000)

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])

    def _serve(self, route):
        path = route.request.url[len(ORIGIN):].split("?")[0]
        if path == "/":
            return route.fulfill(status=200, content_type="text/html", body=PAGE)
        if path == "/scripts/app.js":
            return route.fulfill(status=200, content_type="text/javascript", body=APP_STUB)
        if path.startswith("/extensions/agentY/"):
            f = WEB / path.rsplit("/", 1)[1]
            return route.fulfill(status=200, content_type="text/javascript",
                                 body=f.read_text(encoding="utf-8"))
        if path == "/agent/pm_names":
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"entries": [{"name": "hero_face", "path": "D:/a.png", "summary": "face"},
                             {"name": "hero_set", "path": "D:/b.png", "summary": "set"}]}))
        if path == "/view":
            return route.fulfill(status=200, content_type="image/png", body=PNG)
        return route.fulfill(status=404, body="")

    # -- helpers ---------------------------------------------------------------
    def box(self, where):
        return self.page.locator(("#side" if where == "side" else "#host") + " textarea.ay-input")

    def put(self, where, text, at):
        box = self.box(where)
        box.click()
        box.evaluate("(t, a) => { t.value = a[0]; t.focus(); t.setSelectionRange(a[1], a[1]); }",
                     [text, at])
        return box

    def caret(self, where):
        return self.box(where).evaluate("(t) => [t.selectionStart, t.selectionEnd]")

    def menu_open(self):
        return self.page.evaluate("""() => { const all = [];
          const walk = (r) => { for (const m of r.querySelectorAll('.ay-tagmenu')) all.push(m); };
          walk(document); walk(document.getElementById('host').shadowRoot);
          return all.some((m) => m.style.display !== 'none' && m.getClientRects().length > 0); }""")

    # -- word jumps --------------------------------------------------------------
    def test_alt_arrows_jump_words(self):
        for where in ("side", "shadow"):
            with self.subTest(where=where):
                self.put(where, "hello big world", 10)
                self.page.keyboard.press("Alt+ArrowLeft")
                self.assertEqual(self.caret(where), [6, 6])
                self.page.keyboard.press("Alt+ArrowLeft")
                self.assertEqual(self.caret(where), [0, 0])
                self.page.keyboard.press("Alt+ArrowRight")
                self.assertEqual(self.caret(where), [6, 6])
                self.page.keyboard.press("Alt+ArrowRight")
                self.assertEqual(self.caret(where), [10, 10])
                # taken by the box: nothing behind it (ComfyUI's keybindings on window)
                # sees the arrow, and it is prevented, so it is not the browser's Back
                seen = self.page.evaluate("() => window.__seen.filter((k) => k.alt && k.key.startsWith('Arrow'))")
                self.assertEqual(seen, [])

    def test_shift_alt_arrows_extend_the_selection(self):
        for where in ("side", "shadow"):
            with self.subTest(where=where):
                self.put(where, "hello big world", 10)
                self.page.keyboard.press("Shift+Alt+ArrowLeft")
                self.assertEqual(self.caret(where), [6, 10])
                self.page.keyboard.press("Shift+Alt+ArrowLeft")
                self.assertEqual(self.caret(where), [0, 10])

    def test_ctrl_arrows_are_left_to_the_browser(self):
        for where in ("side", "shadow"):
            with self.subTest(where=where):
                self.put(where, "hello big world", 10)
                self.page.keyboard.press("Control+ArrowLeft")
                self.assertEqual(self.caret(where), [6, 6])
                self.page.keyboard.press("Control+ArrowRight")
                self.assertNotEqual(self.caret(where), [6, 6])

    # -- the # menu ----------------------------------------------------------------
    def test_closed_menu_takes_no_keys(self):
        for where in ("side", "shadow"):
            with self.subTest(where=where):
                self.put(where, "line one\nline two", 12)
                self.page.evaluate("() => { window.__seen = []; }")
                for key in ("ArrowDown", "ArrowUp", "Tab", "Escape"):
                    self.page.keyboard.press(key)
                seen = self.page.evaluate("() => window.__seen")
                self.assertEqual([k["prevented"] for k in seen if k["key"] != "Tab"], [False] * 3)

    def test_open_menu_leaves_modified_arrows_to_the_box(self):
        for where in ("side", "shadow"):
            with self.subTest(where=where):
                box = self.put(where, "make it ", 8)
                box.press_sequentially("#hero")
                self.page.wait_for_function("() => true")
                self.page.wait_for_timeout(200)
                self.assertTrue(self.menu_open(), "typing #hero opens the menu")
                end = len("make it #hero")
                # the menu's own key: ArrowDown moves its highlight, not the caret
                self.page.keyboard.press("ArrowDown")
                self.assertEqual(self.caret(where), [end, end])
                # a word jump is the box's even with the menu open
                self.page.keyboard.press("Alt+ArrowLeft")
                self.assertEqual(self.caret(where), [9, 9])
                self.page.keyboard.press("Escape")
                box.evaluate("(t, e) => t.setSelectionRange(e, e)", end)
                self.page.keyboard.press("Control+ArrowLeft")
                self.assertLess(self.caret(where)[0], end)

    # -- result pictures -------------------------------------------------------------
    def test_restored_picture_opens_full_size(self):
        for where, sel in (("side", "#side img.ay-out-media"), ("shadow", "#host img.ay-out-media")):
            with self.subTest(where=where):
                root = "document" if where == "side" else "document.getElementById('host').shadowRoot"
                shown = f"() => [...{root}.querySelectorAll('.ay-wrap > .ay-lightbox img')].map((i) => i.getAttribute('src'))"
                self.page.evaluate("() => { window.__opened = []; }")
                self.page.locator(sel).click()
                self.assertEqual(self.page.evaluate(shown), [ORIGIN + "/view?type=input&filename=a.png"])
                self.assertEqual(self.page.evaluate("() => window.__opened"), [])   # shown over the panel, no window
                self.page.keyboard.press("Escape")
                self.assertEqual(self.page.evaluate(shown), [])
                # a click beside it shows nothing
                self.page.locator(sel.replace("img.ay-out-media", ".ay-out-label")).click()
                self.assertEqual(self.page.evaluate(shown), [])


if __name__ == "__main__":
    unittest.main()
