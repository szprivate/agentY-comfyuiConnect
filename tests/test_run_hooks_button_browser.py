"""Where the "agentY hooks" button sits in ComfyUI's action bar, in a real browser.

The REAL web/agent_run_hooks.js runs in Chromium (Playwright) against an action bar laid
out as ComfyUI frontend 1.57 lays it out (a floating panel whose first row holds the drag
handle and Run's split button; docked, the same panel without `floating-panel` inside the
top bar). Skipped without Playwright. Run: python -m unittest tests.test_run_hooks_button_browser
RUN_HOOKS_SHOTS=<dir> saves screenshots.

Pins (Sebastian 2026-11-15): floating, the button is UNDER Run, a row of its own; docked,
it is beside Run as before; docking / undocking moves it without making a second one.
"""
import os
import pathlib
import unittest

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
ORIGIN = "http://agenty.test"
SHOTS = os.environ.get("RUN_HOOKS_SHOTS", "")

APP_STUB = """
export const app = {
  graph: null,
  registerExtension(ext) { (window.__exts = window.__exts || []).push(ext); },
};
"""

PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#202020;font-family:sans-serif;color:#ddd;
  --p-primary-color:#2f7bf6;--p-primary-contrast-color:#fff}
#top{display:flex;align-items:center;height:48px;background:#2b2b2b;padding:0 12px;gap:8px}
#top .slot{display:flex;height:100%;align-items:center}
.actionbar{background:#353535;border:1px solid #4a4a4a;border-radius:8px;padding:6px}
.actionbar.floating-panel{position:fixed;left:300px;bottom:40px}
.row{display:flex;align-items:center;gap:4px}
.drag-handle{width:12px;height:20px;background:repeating-linear-gradient(#777 0 2px,transparent 2px 5px)}
.queue-button-group{display:flex;height:32px;border-radius:8px;overflow:hidden}
.queue-button-group button{border:0;background:#2f7bf6;color:#fff;padding:0 16px}
.queue-button-group button + button{padding:0 8px;border-left:1px solid #fff4}
</style></head><body>
<div id="top"><span>Workflow</span><div class="slot" id="dock"></div></div>
<div id="canvas" style="height:600px"></div>
<script type="module">
window.agentYRunHooks = () => "ok";
const bar = document.createElement("div");
bar.className = "actionbar pointer-events-auto fixed z-1300 floating-panel";
bar.innerHTML = '<div class="row"><span class="drag-handle"></span><div><div class="queue-button-group">'
  + '<button data-testid="queue-button">&#9654; Run</button><button>&#9662;</button></div></div>'
  + '<button class="x">&#10005;</button></div>';
document.body.append(bar);
window.__dock = (on) => {
  if (on) { bar.classList.remove("fixed", "floating-panel"); document.getElementById("dock").append(bar); }
  else { bar.classList.add("fixed", "floating-panel"); document.body.append(bar); }
};
await import("/extensions/agentY/agent_run_hooks.js");
for (const ext of window.__exts || []) if (ext.setup) await ext.setup();
window.__ready = true;
</script></body></html>"""


@unittest.skipIf(sync_playwright is None, "needs playwright")
class RunHooksButtonBrowser(unittest.TestCase):
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
        self.page = self.browser.new_page(viewport={"width": 900, "height": 700},
                                          device_scale_factor=2 if SHOTS else 1)
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.route("**/*", self._serve)
        self.page.goto(ORIGIN + "/")
        self.page.wait_for_function("window.__ready === true", timeout=10000)
        self.page.wait_for_function("!!document.getElementById('agentY-run-hooks-btn')", timeout=5000)

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
        return route.fulfill(status=404, body="")

    def boxes(self):
        return self.page.evaluate("""() => {
          const r = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
          return { run: r(document.querySelector('.queue-button-group')),
                   hooks: r(document.getElementById('agentY-run-hooks-group')),
                   bar: r(document.querySelector('.actionbar')),
                   count: document.querySelectorAll('#agentY-run-hooks-group').length,
                   mode: document.getElementById('agentY-run-hooks-group').dataset.mode }; }""")

    def shot(self, name):
        if SHOTS:
            pathlib.Path(SHOTS).mkdir(parents=True, exist_ok=True)
            self.page.screenshot(path=str(pathlib.Path(SHOTS) / name))

    def test_floating_it_sits_under_run(self):
        b = self.boxes()
        self.assertEqual(b["mode"], "under")
        self.assertGreaterEqual(b["hooks"][1], b["run"][3])          # below Run
        self.assertLessEqual(b["hooks"][3], b["bar"][3] + 0.5)        # inside the bar
        self.assertGreaterEqual(b["hooks"][0], b["bar"][0])
        # its words show even in a narrow window (the 900 px page here)
        self.assertTrue(self.page.is_visible("#agentY-run-hooks-btn .agy-label"))
        self.assertEqual(self.page.inner_text("#agentY-run-hooks-btn .agy-label"), "agentY hooks")
        self.shot("hooks-under-run.png")

    def test_docked_it_sits_beside_run_and_moves_back(self):
        self.page.evaluate("window.__dock(true)")
        self.page.wait_for_function(
            "document.getElementById('agentY-run-hooks-group').dataset.mode === 'beside'", timeout=3000)
        b = self.boxes()
        self.assertEqual(b["count"], 1)
        self.assertLessEqual(b["hooks"][2], b["run"][0] + 0.5)       # left of Run
        self.assertLess(abs((b["hooks"][1] + b["hooks"][3]) - (b["run"][1] + b["run"][3])), 4)  # same row
        self.shot("hooks-docked.png")
        self.page.evaluate("window.__dock(false)")
        self.page.wait_for_function(
            "document.getElementById('agentY-run-hooks-group').dataset.mode === 'under'", timeout=3000)
        self.assertEqual(self.boxes()["count"], 1)

    def test_the_menu_opens_above_when_there_is_no_room_below(self):
        self.page.click("#agentY-run-hooks-arrow")
        m = self.page.evaluate("""() => { const m = document.getElementById('agentY-run-hooks-menu');
          const b = m.getBoundingClientRect(); return [b.top, b.bottom, innerHeight]; }""")
        self.assertLessEqual(m[1], m[2])
        self.shot("hooks-menu.png")


if __name__ == "__main__":
    unittest.main()
