"""The 🖼 switch on the model rows: which models agentY may hand an image.

The host never sends an image to a model it takes for text-only, and it decides
that from the model's name, overruled by llm.vision_models / llm.text_only_models.
The page draws that as a switch beside every model select, and saves the two lists.

The REAL web/agent_settings.js runs in Chromium (Playwright); /agentY/settings is
answered here, and the save is caught to read what would be written.
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

APP_STUB = """export const app = { registerExtension(e) { (window.__exts ||= []).push(e); },
  ui: { settings: { getSettingValue() {}, setSettingValue() {}, addSetting() {} } },
  extensionManager: { toast: { add() {} }, setting: { get() {}, set() {} } } };
window.app = app;"""

PAGE = """<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
try { localStorage.setItem("agentY_backend", location.origin); } catch (_) {}
await import("/extensions/agentY/agent_settings.js");
document.body.append(window.__exts.find((e) => e.name === "agentY.settings").settings[0].type());
window.__ready = true;
</script></body></html>"""


def payload(vision=None, text=None):
    llm = {
        "tiers": {"orchestrator": "claude,claude-sonnet-5-5", "vision": "ollama,qwen2.5vl:7b",
                  "qa_judge": "ollama,qwen2.5vl:7b", "coder": "ollama,qwen3-coder:30b"},
        "pipeline": {"orchestrator": "", "vision_agent": ""},
        "routing": {"auto_switch": False, "rules": [],
                    "escalation": {"enabled": False, "model": "claude,claude-opus-5-5",
                                   "after_errors": 4, "after_tool_calls": 60}},
    }
    if vision is not None:
        llm["vision_models"] = vision
    if text is not None:
        llm["text_only_models"] = text
    return {"settings": {"llm": llm},
            "tier_labels": {"orchestrator": "Orchestrator", "vision": "Vision", "qa_judge": "QA judge",
                            "coder": "Coder"},
            "model_groups": {"Anthropic": [["claude,claude-sonnet-5-5", "Sonnet"], ["claude,claude-opus-5-5", "Opus"]],
                             "Ollama": [["ollama,qwen2.5vl:7b", "qwen2.5vl:7b"],
                                        ["ollama,qwen3-coder:30b", "qwen3-coder:30b"]]}}


@unittest.skipIf(sync_playwright is None, "needs playwright")
class TheImagesSwitch(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        try:
            cls.browser = cls.pw.chromium.launch()
        except Exception:  # noqa: BLE001 - a cloud box keeps its Chromium here
            cls.browser = cls.pw.chromium.launch(executable_path="/opt/pw-browsers/chromium")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, data):
        self.saved = []
        ctx = self.browser.new_context()
        self.addCleanup(ctx.close)

        def serve(route):
            req = route.request
            path = req.url[len(ORIGIN):].split("?")[0]
            if path == "/":
                return route.fulfill(status=200, content_type="text/html", body=PAGE)
            if path == "/scripts/app.js":
                return route.fulfill(status=200, content_type="text/javascript", body=APP_STUB)
            if path.startswith("/extensions/agentY/"):
                f = WEB / path[len("/extensions/agentY/"):]
                if f.is_file():
                    return route.fulfill(status=200, content_type="text/javascript", body=f.read_bytes())
                return route.fulfill(status=404, body="")
            if path == "/agentY/settings":
                if req.method == "POST":
                    self.saved.append(json.loads(req.post_data))
                    return route.fulfill(status=200, content_type="application/json", body='{"ok": true}')
                return route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
            return route.fulfill(status=200, content_type="application/json", body="{}")

        ctx.route("**/*", serve)
        page = ctx.new_page()
        page.goto(ORIGIN + "/")
        page.wait_for_function("window.__ready")
        page.click("text=Open agentY Settings…")
        page.wait_for_selector(".ays-card")
        return page

    def switch(self, page, label):
        return page.locator(".ays-row", has=page.locator(".ays-label", has_text=label)).first.locator(".ays-images-sel")

    def shown(self, page, label):
        return self.switch(page, label).evaluate("(s) => s.options[s.selectedIndex].textContent")

    def lists(self, page):
        page.click("button.ays-btn.primary")
        page.wait_for_timeout(300)
        llm = self.saved[-1]["settings"]["llm"]
        return llm["vision_models"], llm["text_only_models"]

    def test_auto_shows_the_guess_from_the_name(self):
        page = self.open(payload([], []))
        self.assertEqual(self.shown(page, "Orchestrator"), "🖼 auto: yes")      # Claude reads images
        self.assertEqual(self.shown(page, "Vision"), "🖼 auto: yes")            # a -vl model
        self.assertEqual(self.shown(page, "Coder"), "🖼 auto: no")              # nothing says it can
        self.assertEqual(self.shown(page, "escalation model"), "🖼 auto: yes")

    def test_text_only_on_the_orchestrator_saves_its_model_and_keeps_the_rest(self):
        page = self.open(payload(["qwen3.8-max"], []))
        self.switch(page, "Orchestrator").select_option("text")
        self.assertEqual(self.lists(page), (["qwen3.8-max"], ["claude-sonnet-5-5"]))

    def test_rows_with_the_same_model_move_together(self):
        page = self.open(payload([], []))
        self.switch(page, "Vision").select_option("text")
        self.assertEqual(self.shown(page, "QA judge"), "🚫 text only")

    def test_reads_images_takes_out_a_text_only_entry_that_would_win(self):
        page = self.open(payload([], ["qwen3-coder"]))
        self.assertEqual(self.shown(page, "Coder"), "🚫 text only")
        self.switch(page, "Coder").select_option("vision")
        self.assertEqual(self.lists(page), (["qwen3-coder:30b"], []))

    def test_auto_takes_out_only_the_models_own_entry(self):
        page = self.open(payload(["deepseek-v4.1-flash"], ["claude-sonnet-5-5"]))
        self.assertEqual(self.shown(page, "Orchestrator"), "🚫 text only")
        self.switch(page, "Orchestrator").select_option("auto")
        self.assertEqual(self.lists(page), (["deepseek-v4.1-flash"], []))

    def test_a_blank_override_has_no_switch(self):
        page = self.open(payload([], []))
        page.click("text=Per-role overrides")
        self.assertFalse(self.switch(page, "vision_agent").is_visible())

    def test_an_older_host_without_the_lists_gets_no_switch_and_no_lists_written(self):
        page = self.open(payload())
        self.assertEqual(page.locator(".ays-images-sel").count(), 0)
        page.click("button.ays-btn.primary")
        page.wait_for_timeout(300)
        self.assertNotIn("vision_models", self.saved[-1]["settings"].get("llm", {}))


if __name__ == "__main__":
    unittest.main()
