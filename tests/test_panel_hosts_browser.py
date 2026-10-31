"""The model menu, a result picture's full-size view and "Delete conversation", in every place the panel is shown.

The REAL web/agent_chat.js (and everything it imports) runs in Chromium (Playwright) with
ComfyUI's scripts/app.js and api.js stubbed and the agentY host answered by the test. The
panel is shown in each of its four places:

  * sidebar     - ComfyUI's sidebar tab (the page itself);
  * viewer      - the REAL bEpic viewer (a sibling ComfyUI-ImageViewer checkout), docked
                  in its shadow root;
  * fullscreen  - the viewer's full-screen page (?bepic_viewer_only), which hides every
                  other child of <body>;
  * popout      - the viewer moved into a window of its own.

The regressions it pins:
  * the model menu was appended to the ComfyUI page's <body>: popped out it opened in
    the main window at the popout's coordinates (far from its box), full-screen it was
    hidden with the rest of <body>;
  * a result picture opened with the page's window.open: from the popout that is a tab
    of the ComfyUI window behind it, so nothing happened where the user looked. It is
    shown over the panel now, in all four places, with no window opened;
  * the conversation menu stayed open after a click elsewhere in the popout (its
    outside-click listener was on the ComfyUI page's document only);
  * "Delete conversation", from the menu and from the Manage page: the request, what
    the host answers and the conversation leaving the list, a running one refused.

Needs Playwright with an installed Edge or Chrome (or Playwright's Chromium); the viewer
hosts also need the ComfyUI-ImageViewer checkout beside this one (or BEPIC_VIEWER_DIR).
Run: python -m unittest tests.test_panel_hosts_browser
"""
import json
import os
import pathlib
import unittest

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

HERE = pathlib.Path(__file__).resolve().parent
WEB = HERE.parent / "web"
VIEWER = pathlib.Path(os.environ.get("BEPIC_VIEWER_DIR") or HERE.parent.parent / "ComfyUI-ImageViewer") / "js"
ORIGIN = "http://agenty.test"
TYPES = {".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".html": "text/html",
         ".svg": "image/svg+xml", ".png": "image/png"}

APP_STUB = """
const exts = [];
window.__exts = exts;
const tabs = {};
const sidebar = {
  activeSidebarTabId: null,
  registerSidebarTab(t) { tabs[t.id] = t; },
  toggleSidebarTab(id) {
    this.activeSidebarTabId = id;
    const el = document.getElementById("sidebar");
    if (tabs[id] && el) tabs[id].render(el);
  },
};
export const app = {
  registerExtension(e) { exts.push(e); window.__ext = e; },
  graph: { _nodes: [], nodes: [], links: {}, getNodeById() { return null; }, add() {}, remove() {},
           setDirtyCanvas() {}, onNodeAdded: null },
  canvas: { selected_nodes: {}, graph: null, setDirty() {}, ds: { scale: 1, offset: [0, 0] } },
  queuePrompt() {}, graphToPrompt: async () => ({ output: {}, workflow: {} }),
  ui: { settings: { getSettingValue: () => undefined, setSettingValue() {}, addSetting() {} } },
  extensionManager: Object.assign(sidebar, { sidebarTab: sidebar, toast: { add() {} },
    setting: { get: () => undefined, set() {} } }),
};
window.app = app;
"""

API_STUB = """
const listeners = {};
export const api = {
  api_base: "", clientId: "harness",
  apiURL: (p) => p, fileURL: (p) => p,
  addEventListener(n, f) { (listeners[n] ||= []).push(f); },
  removeEventListener() {},
  dispatch(n, detail) { (listeners[n] || []).forEach((f) => f({ detail })); },
  async fetchApi(path, opts) { return fetch(path, opts); },
  getUserData: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }),
  storeUserData: async () => ({ ok: true }),
  socket: null, queuePrompt() {},
};
"""

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#222}
#sidebar{position:fixed;left:0;top:0;width:340px;height:100%;}</style></head>
<body><div id="sidebar"></div>
<script type="module">
try { localStorage.setItem("agentY_backend", location.origin); localStorage.setItem("agentY_active_thread", "t1"); } catch (_) {}
const VIEWER = __VIEWER__;
const { app } = await import("/scripts/app.js");
await import("/extensions/agentY/agent_chat.js");
if (VIEWER) await import("/extensions/viewer/bEpicViewer.js");
for (const e of window.__exts) { try { if (e.setup) await e.setup(); } catch (err) { console.warn("setup", e.name, err); } }
window.__ready = true;
</script></body></html>"""

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")

PANEL_HTML = ('<div class="ay-msg ay-assistant">Here it is.</div>'
              '<div class="ay-msg ay-out" data-index="1" data-file="agentY/a.png">'
              '<img class="ay-out-media" src="%s/view?type=input&amp;filename=a.png&amp;subfolder=agentY" '
              'style="width:120px;height:80px" alt="a.png" title="Open full size">'
              '<div class="ay-out-label">#1 · a.png</div></div>' % ORIGIN)

# Every element matching `sel` in the page, its shadow roots and the popout window.
FIND = """(sel) => {
  const out = [];
  const walk = (root, where) => {
    for (const e of root.querySelectorAll(sel)) out.push([e, where]);
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot, where + '>shadow');
  };
  walk(document, 'page');
  const v = document.querySelector('bepic-viewer-panel');
  const w = v && v.popoutWindow;
  if (w && !w.closed) walk(w.document, 'popout');
  return out;
}"""

RECT = """([FIND, sel]) => eval(FIND)(sel).map(([e, where]) => {
  const r = e.getBoundingClientRect(), win = e.ownerDocument.defaultView;
  const shown = e.getClientRects().length > 0 && win.getComputedStyle(e).visibility !== 'hidden';
  const popout = e.ownerDocument !== document;
  return { where, popout, shown, x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
           vw: win.innerWidth, vh: win.innerHeight };
})"""


@unittest.skipIf(sync_playwright is None, "needs playwright")
class PanelHostsBrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = None
        for channel in ("msedge", "chrome", None):
            try:
                kw = {"headless": True}
                cls.browser = cls.pw.chromium.launch(channel=channel, **kw) if channel else cls.pw.chromium.launch(**kw)
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

    # -- the stand-ins -----------------------------------------------------------
    def setUp(self):
        self.threads = [{"id": "t1", "title": "Bears"}, {"id": "t2", "title": "Dragons"}]
        self.running = set()
        self.deletes = []
        self.ctx = self.browser.new_context(viewport={"width": 1400, "height": 900})
        self.errors = []
        self.ctx.route("**/*", self._serve)

    def tearDown(self):
        self.ctx.close()

    def _json(self, route, obj, status=200):
        return route.fulfill(status=status, content_type="application/json", body=json.dumps(obj))

    def _serve(self, route):
        req = route.request
        url = req.url
        if not url.startswith(ORIGIN):
            return route.fulfill(status=404, body="")
        path = url[len(ORIGIN):].split("?")[0]
        if path in ("/", "/index.html"):
            viewer = "true" if self.with_viewer else "false"
            return route.fulfill(status=200, content_type="text/html", body=PAGE.replace("__VIEWER__", viewer))
        if path == "/scripts/app.js":
            return route.fulfill(status=200, content_type="text/javascript", body=APP_STUB)
        if path == "/scripts/api.js":
            return route.fulfill(status=200, content_type="text/javascript", body=API_STUB)
        for prefix, base in (("/extensions/agentY/", WEB), ("/extensions/viewer/", VIEWER)):
            if path.startswith(prefix):
                f = base / path[len(prefix):]
                if f.is_file():
                    return route.fulfill(status=200, content_type=TYPES.get(f.suffix, "application/octet-stream"),
                                         body=f.read_bytes())
                return route.fulfill(status=404, body="")
        if path == "/view":
            return route.fulfill(status=200, content_type="image/png", body=PNG)
        if path == "/agent/host_info":
            return self._json(route, {"ok": True, "agent_server_port": 5000, "session_token": "tok"})
        if path == "/agentY/health":
            return self._json(route, {"status": "ok", "pipeline": True, "boot_id": "b",
                                      "running_threads": sorted(self.running)})
        if path == "/agentY/threads" and req.method == "GET":
            return self._json(route, [dict(t, running=t["id"] in self.running) for t in self.threads])
        if path == "/agentY/threads/delete":
            ids = (json.loads(req.post_data or "{}") or {}).get("ids") or []
            self.deletes.append(ids)
            skipped = [i for i in ids if i in self.running]
            gone = [i for i in ids if i not in self.running]
            self.threads = [t for t in self.threads if t["id"] not in gone]
            return self._json(route, {"deleted": len(gone), "deleted_ids": gone, "skipped": skipped})
        if path.startswith("/agentY/threads/") and req.method == "GET" and path.count("/") == 3:
            tid = path.rsplit("/", 1)[1]
            t = next((t for t in self.threads if t["id"] == tid), None)
            if t is None:
                return self._json(route, {"error": "not found"}, 404)
            return self._json(route, dict(t, messages=[], panel_html=PANEL_HTML, server_time=1,
                                          messages_after_panel=[]))
        if path.startswith("/agentY/") or path.startswith("/agent/") or path.startswith("/bepic/") \
                or path.startswith("/api/"):
            # Streams and everything else: an empty answer. Nothing else is under test.
            if path == "/agentY/canvas_probe":
                return route.fulfill(status=503, body="")     # the probe loop backs off
            if "stream" in path or path.endswith("/status") or path.endswith("/notifications"):
                return route.fulfill(status=204, body="")
            return self._json(route, {})
        return route.fulfill(status=404, body="")

    # -- the four places ------------------------------------------------------------
    def open_in(self, where):
        """Load the page and show the panel in `where`; returns the Page the panel is drawn in."""
        self.with_viewer = where != "sidebar"
        if self.with_viewer and not (VIEWER / "bEpicViewer.js").is_file():
            self.skipTest("the ComfyUI-ImageViewer checkout is not beside this one")
        page = self.ctx.new_page()
        page.on("pageerror", lambda e: self.errors.append(str(e)))
        page.goto(ORIGIN + ("/?bepic_viewer_only=1" if where == "fullscreen" else "/"))
        page.wait_for_function("window.__ready === true", timeout=20000)
        if where == "sidebar":
            page.evaluate("() => window.app.extensionManager.toggleSidebarTab('agentY-chat')")
        else:
            page.wait_for_function("() => window.bEpicViewerApi && window.bEpicViewerApi.openAgentPanel", timeout=20000)
            page.evaluate("() => window.bEpicViewerApi.openAgentPanel()")
        page.wait_for_function("([FIND]) => eval(FIND)('.ay-wrap').some(([e]) => e.getClientRects().length)",
                               arg=[FIND], timeout=20000)
        if where == "fullscreen":
            self.assertTrue(page.evaluate("() => document.body.classList.contains('bepic-viewer-only')"))
        shown = page
        if where == "popout":
            with self.ctx.expect_page() as pop:
                page.evaluate("() => document.querySelector('bepic-viewer-panel').toggleUndock()")
            shown = pop.value
            shown.wait_for_load_state()
            page.wait_for_function("() => document.querySelector('bepic-viewer-panel').container.ownerDocument !== document",
                                   timeout=10000)
        # the host is up and the first conversation is open
        page.wait_for_function("() => window.agentYCurrentThread && (window.agentYCurrentThread() || {}).id",
                               timeout=20000)
        if page.evaluate("() => window.agentYCurrentThread().id") != "t1":
            self.pick_thread(page, "t1")
        self.page = page
        return shown

    def pick_thread(self, page, tid):
        page.evaluate("""([FIND, tid]) => { const [[sel]] = eval(FIND)('.ay-wrap select[title=Conversation]');
          sel.value = tid; sel.dispatchEvent(new Event('change', { bubbles: true })); }""", [FIND, tid])
        page.wait_for_function("(tid) => (window.agentYCurrentThread() || {}).id === tid", arg=tid, timeout=10000)

    def rects(self, sel):
        return self.page.evaluate(RECT, [FIND, sel])

    def drawn(self, sel):
        return [r for r in self.rects(sel) if r["shown"] and r["w"] > 0 and r["h"] > 0]

    # -- 1. the model menu ---------------------------------------------------------------
    def test_model_menu_opens_at_its_box(self):
        for where in ("sidebar", "viewer", "fullscreen", "popout"):
            with self.subTest(where=where):
                shown = self.open_in(where)
                shown.locator(".ay-modelbar .ay-mmodel .ay-combo-input").click()
                self.page.wait_for_timeout(200)
                # where the box is now: focusing it may scroll the panel
                [box] = self.drawn(".ay-modelbar .ay-combo.ay-mmodel")
                lists = self.drawn(".ay-combo-list")
                self.assertEqual(len(lists), 1, f"one menu on screen in {where}: {self.rects('.ay-combo-list')}")
                [lst] = lists
                # in the same window as its box, and in that window's viewport
                self.assertEqual(lst["popout"], box["popout"])
                self.assertGreaterEqual(lst["x"], 0)
                self.assertGreaterEqual(lst["y"], 0)
                self.assertLessEqual(lst["right"], lst["vw"] + 0.5)
                self.assertLessEqual(lst["bottom"], lst["vh"] + 0.5)
                # right at the box: just above or just below it, starting at its left edge
                gap = min(abs(lst["bottom"] - box["y"]), abs(lst["y"] - box["bottom"]))
                self.assertLessEqual(gap, 6, (where, box, lst))
                self.assertLessEqual(abs(lst["x"] - box["x"]), 6, (where, box, lst))
                # and it is the thing under the pointer there (not hidden behind anything)
                hit = shown.evaluate("""([FIND]) => { const [[l]] = eval(FIND)('.ay-combo-list').filter(([e]) => e.getClientRects().length);
                    const r = l.getBoundingClientRect(); const root = l.getRootNode();
                    const at = root.elementFromPoint(r.x + r.width / 2, r.y + 10); return !!at && l.contains(at); }""", [FIND])
                self.assertTrue(hit, where)
                shown.keyboard.press("Escape")
                self.assertEqual(self.drawn(".ay-combo-list"), [])
                self.assertEqual(self.errors, [])
                self.page.close()
                if shown is not self.page:
                    shown.close()

    def test_model_menu_stays_in_a_transformed_dock(self):
        # position:fixed under a transformed ancestor is relative to that ancestor, not the viewport.
        shown = self.open_in("viewer")
        # the viewer itself moved by a transform: the list lives in its shadow root now
        self.page.evaluate("() => { document.querySelector('bepic-viewer-panel').style.transform = 'translate(30px, 40px)'; }")
        shown.locator(".ay-modelbar .ay-mmodel .ay-combo-input").click()
        self.page.wait_for_timeout(200)
        [box] = self.drawn(".ay-modelbar .ay-combo.ay-mmodel")
        [lst] = self.drawn(".ay-combo-list")
        gap = min(abs(lst["bottom"] - box["y"]), abs(lst["y"] - box["bottom"]))
        self.assertLessEqual(gap, 6, (box, lst))
        self.assertLessEqual(abs(lst["x"] - box["x"]), 6, (box, lst))

    # -- 2. a result picture full size ------------------------------------------------------
    def test_result_picture_shows_full_size(self):
        for where in ("sidebar", "viewer", "fullscreen", "popout"):
            with self.subTest(where=where):
                shown = self.open_in(where)
                shown.locator(".ay-log img.ay-out-media").first.wait_for(timeout=10000)
                pages = len(self.ctx.pages)
                shown.locator(".ay-log img.ay-out-media").first.click()
                self.page.wait_for_timeout(300)
                boxes = self.drawn(".ay-lightbox")
                self.assertEqual(len(boxes), 1, f"full-size view in {where}")
                [panel] = self.drawn(".ay-wrap")
                [lb] = boxes
                # over the panel, in the panel's window
                self.assertEqual(lb["popout"], panel["popout"])
                for k in ("x", "y", "w", "h"):
                    self.assertAlmostEqual(lb[k], panel[k], delta=1)
                if where != "popout":
                    # (an about:blank popup's requests are not served by Playwright's routes:
                    # its pictures never load in this harness, the log's own included)
                    shown.locator(".ay-lightbox img").first.wait_for(state="visible", timeout=5000)
                    [big] = self.drawn(".ay-lightbox img")
                    self.assertGreater(big["w"], 0)
                src = shown.locator(".ay-lightbox img").first.get_attribute("src")
                self.assertIn("/view?type=input&filename=a.png&subfolder=agentY", src)
                self.assertEqual(len(self.ctx.pages), pages, "no window opened")
                # Esc puts it away; so does a click on it
                shown.keyboard.press("Escape")
                self.assertEqual(self.drawn(".ay-lightbox"), [])
                shown.locator(".ay-log img.ay-out-media").first.click()
                self.assertEqual(len(self.drawn(".ay-lightbox")), 1)
                shown.locator(".ay-lightbox").first.click(position={"x": 5, "y": 5})
                self.assertEqual(self.drawn(".ay-lightbox"), [])
                self.assertEqual(self.errors, [])
                self.page.close()
                if shown is not self.page:
                    shown.close()

    # -- 3. delete conversation --------------------------------------------------------------
    def _delete_from_menu(self, shown):
        shown.locator(".ay-wrap button[title^='Conversations']").first.click()
        shown.locator(".ay-cmenu .ay-cm-item.danger").first.click()
        shown.locator(".ay-cmenu .ay-cm-row button", has_text="Delete").first.click()

    def test_delete_conversation_from_the_menu(self):
        for where in ("sidebar", "viewer", "fullscreen", "popout"):
            with self.subTest(where=where):
                self.threads = [{"id": "t1", "title": "Bears"}, {"id": "t2", "title": "Dragons"}]
                self.deletes = []
                shown = self.open_in(where)
                self._delete_from_menu(shown)
                self.page.wait_for_function("() => (window.agentYCurrentThread() || {}).id === 't2'", timeout=10000)
                self.assertEqual(self.deletes, [["t1"]])
                opts = self.page.evaluate("""([FIND]) => [...eval(FIND)('.ay-wrap select[title=Conversation]')[0][0].options]
                                              .map((o) => o.value)""", [FIND])
                self.assertEqual(opts, ["t2"])
                self.assertEqual(self.drawn(".ay-cmenu"), [])
                self.assertEqual(self.errors, [])
                self.page.close()
                if shown is not self.page:
                    shown.close()

    def test_conversation_menu_closes_on_a_click_elsewhere(self):
        for where in ("sidebar", "viewer", "fullscreen", "popout"):
            with self.subTest(where=where):
                shown = self.open_in(where)
                shown.locator(".ay-wrap button[title^='Conversations']").first.click()
                self.assertEqual(len(self.drawn(".ay-cmenu")), 1)
                [m] = self.drawn(".ay-cmenu")
                shown.mouse.click(m["x"] + 4, m["bottom"] + 6 if m["bottom"] + 6 < m["vh"] else 4)
                self.assertEqual(self.drawn(".ay-cmenu"), [], where)
                self.page.close()
                if shown is not self.page:
                    shown.close()

    def test_delete_from_the_manage_page(self):
        for where in ("sidebar", "viewer", "fullscreen", "popout"):
            with self.subTest(where=where):
                self.threads = [{"id": "t1", "title": "Bears"}, {"id": "t2", "title": "Dragons"}]
                self.deletes = []
                shown = self.open_in(where)
                shown.locator(".ay-wrap button[title^='Conversations']").first.click()
                shown.locator(".ay-cmenu .ay-cm-item", has_text="Manage conversations").first.click()
                shown.locator(".ayc-row", has_text="Bears").locator("input[type=checkbox]").first.click()
                shown.locator(".ayc-foot button", has_text="Delete selected (1)").first.click()
                shown.locator(".ayc-foot button", has_text="Yes, delete").first.click()
                self.page.wait_for_function("() => (window.agentYCurrentThread() || {}).id === 't2'", timeout=10000)
                self.assertEqual(self.deletes, [["t1"]])
                self.assertEqual(self.errors, [])
                self.page.close()
                if shown is not self.page:
                    shown.close()

    def test_a_running_conversation_is_kept_and_it_says_so(self):
        self.running = {"t1"}
        shown = self.open_in("viewer")
        self._delete_from_menu(shown)
        self.page.wait_for_timeout(500)
        self.assertEqual(self.deletes, [["t1"]])
        self.assertEqual(self.page.evaluate("() => window.agentYCurrentThread().id"), "t1")
        said = shown.evaluate("([FIND]) => eval(FIND)('.ay-log .ay-system').map(([e]) => e.textContent).join('|')", [FIND])
        self.assertIn("turn is running", said)


if __name__ == "__main__":
    unittest.main()
