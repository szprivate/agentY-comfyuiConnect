"""The model bar's two pickers at narrow panel widths (issue #82).

In a small panel the model picker used to collapse to an empty sliver while the
"All tiers" select kept the width of its longest option. This lays out the REAL
rules from web/agent_chat.js and web/agent_combo.js in a browser at several
widths. It needs Python Playwright and Microsoft Edge; where they are missing the
test is skipped (run it with the agentY-mcp venv's python, which has Playwright).
"""
import pathlib
import re
import unittest

try:
    from playwright.sync_api import sync_playwright
except Exception:  # noqa: BLE001
    sync_playwright = None

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
SELECTORS = (".ay-modelbar", ".ay-mlabel", ".ay-mmodel", ".ay-bar")
WIDTHS = (280, 340, 420)


def _chat_css() -> str:
    lines = [ln.strip() for ln in (WEB / "agent_chat.js").read_text(encoding="utf-8").splitlines()]
    return "\n".join(ln for ln in lines if ln.startswith(SELECTORS))


def _combo_css() -> str:
    src = (WEB / "agent_combo.js").read_text(encoding="utf-8")
    return re.search(r"const css = `(.*?)`;", src, re.S).group(1)


PAGE = """<!doctype html><html><head><style>
:root{--ay-surface:#1e2128;--ay-bg:#15171c;--ay-text:#e6e8ec;--ay-border:#2c313b;--ay-muted:#9aa0aa;}
body{margin:0;font-family:sans-serif;} #panel{width:%dpx;box-sizing:border-box;}
%s
%s
</style></head><body><div id="panel">
<div class="ay-modelbar" id="bar">
  <span class="ay-mlabel">Model</span>
  <span class="ay-mmodel ay-combo" id="model"><input class="ay-combo-input" value="claude-sonnet-4-5 (Anthropic)"><span class="ay-combo-caret">&#9662;</span></span>
  <select class="ay-mtarget" id="target">
    <option>All tiers</option>
    <optgroup label="Single role (overrides its tier)">
      <option>Orchestrator  &middot;  premium reasoning tier with a long name</option></optgroup>
  </select>
</div>
<div class="ay-bar"><select id="thread"><option>A conversation with a rather long title that cannot fit</option></select>
<button>+</button><button>x</button><button>u</button><button>p</button></div>
</div></body></html>"""


@unittest.skipIf(sync_playwright is None, "Python Playwright is not installed")
class ModelBarLayout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._pw = sync_playwright().start()
        try:
            cls.browser = cls._pw.chromium.launch(channel="msedge")
        except Exception as exc:  # noqa: BLE001
            cls._pw.stop()
            raise unittest.SkipTest(f"Microsoft Edge is not available: {exc}")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls._pw.stop()

    def _measure(self, width):
        page = self.browser.new_page(viewport={"width": width + 40, "height": 400})
        page.set_content(PAGE % (width, _combo_css(), _chat_css()))
        out = page.evaluate("""() => {
            const r = (id) => document.getElementById(id).getBoundingClientRect();
            const panel = document.getElementById('panel').getBoundingClientRect();
            return {model: r('model').width, target: r('target').width, thread: r('thread').width,
                    barRight: r('bar').right, panelRight: panel.right,
                    modelRight: r('model').right, targetRight: r('target').right,
                    scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth};
        }""")
        page.close()
        return out

    def test_both_pickers_keep_a_usable_width(self):
        for w in WIDTHS:
            with self.subTest(width=w):
                m = self._measure(w)
                self.assertGreaterEqual(m["model"], 110, m)      # the model name is readable
                self.assertGreaterEqual(m["target"], 90, m)      # so is the target
                self.assertLessEqual(m["modelRight"], m["panelRight"] + 0.5, m)
                self.assertLessEqual(m["targetRight"], m["panelRight"] + 0.5, m)
                self.assertLessEqual(m["scrollW"], m["clientW"], m)  # nothing overflows sideways

    def test_thread_bar_select_shrinks(self):
        for w in WIDTHS:
            with self.subTest(width=w):
                self.assertGreaterEqual(self._measure(w)["thread"], 60)


if __name__ == "__main__":
    unittest.main()
