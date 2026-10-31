"""The Manage tags page, in every place the panel is shown.

The REAL web/agent_chat.js, agent_tag_manager.js, agent_tag_ops.js, agent_tags.js and
agent_viewer_bridge.js run in Chromium (Playwright) on the harness of
test_panel_hosts_browser.py: ComfyUI's scripts stubbed, the agentY host answered by the
test, the REAL bEpic viewer (sibling ComfyUI-ImageViewer checkout) for the viewer hosts.
In the sidebar, docked in the viewer, full screen and popped out:

  * the page opens from the panel's ⋯ menu in the panel's own window and root, and from
    the viewer's history filter ("Manage tags…") in the viewer's;
  * its list holds every tag - the canvas's `agentY add tag` nodes and the host's
    remembered ones - with where it lives and how many pictures;
  * a tag's pictures are a grid of /bepic/thumb tiles with file name and path;
  * rename and delete go to the host's /agentY/tags routes; a canvas tag is renamed in
    its node's tag field only after the in-page "Rename" confirmation;
  * names and file names are text: a file called <img onerror=...> injects nothing.

Run: python -m unittest tests.test_tag_manager_browser
"""
import json
import unittest

from tests import test_panel_hosts_browser as H

FIND, ORIGIN, PAGE, PNG, sync_playwright = H.FIND, H.ORIGIN, H.PAGE, H.PNG, H.sync_playwright
# Borrowed, not inherited (and not imported by name): either would run every test of
# the hosts file again.


XSS = '<img src=x onerror="window.__xss=1">'
MY_PAGE = PAGE.replace('await import("/extensions/agentY/agent_chat.js");',
                       'await import("/extensions/agentY/agent_chat.js");\n'
                       'await import("/extensions/agentY/agent_viewer_bridge.js");')

# One `agentY add tag` node (#12, "hero tag") on the open graph, wired to a loader of hero.png.
CANVAS = """() => {
  const g = window.app.graph;
  const loader = { id: 3, type: 'LoadImage', title: 'Load Image', widgets: [{ name: 'image', value: 'hero.png' }], inputs: [] };
  const tag = { id: 12, type: 'AgentYRefNote', title: 'hero tag', inputs: [{ name: 'input', link: 1 }],
                widgets: [{ name: 'tag', value: 'hero_face' }, { name: 'role', value: 'the face' }, { name: 'remember', value: false }] };
  g._nodes.push(loader, tag);
  g.links[1] = { id: 1, origin_id: 3, target_id: 12 };
  g.getNodeById = (id) => g._nodes.find((n) => String(n.id) === String(id)) || null;
}"""


@unittest.skipIf(sync_playwright is None, "needs playwright")
class TagManagerHosts(unittest.TestCase):
    setUpClass = classmethod(H.PanelHostsBrowser.setUpClass.__func__)
    tearDownClass = classmethod(H.PanelHostsBrowser.tearDownClass.__func__)
    tearDown = H.PanelHostsBrowser.tearDown
    _json = H.PanelHostsBrowser._json
    open_in = H.PanelHostsBrowser.open_in
    pick_thread = H.PanelHostsBrowser.pick_thread
    rects = H.PanelHostsBrowser.rects
    drawn = H.PanelHostsBrowser.drawn

    def setUp(self):
        H.PanelHostsBrowser.setUp(self)
        self.reset()

    def reset(self):
        self.memory = [
            {"tag": "set", "key": "set", "origin": "viewer", "role": "the stage", "path": "D:/out/set.png",
             "name": "set.png", "exists": True},
            {"tag": "xss_file", "key": "xss-file", "origin": "agent", "role": XSS, "path": "D:/out/%s.png" % XSS,
             "name": "%s.png" % XSS, "exists": True},
        ]
        self.calls = []
        self.thumbs = []

    def _serve(self, route):
        req = route.request
        url = req.url
        path = url[len(ORIGIN):].split("?")[0] if url.startswith(ORIGIN) else ""
        if path in ("/", "/index.html"):
            viewer = "true" if self.with_viewer else "false"
            return route.fulfill(status=200, content_type="text/html", body=MY_PAGE.replace("__VIEWER__", viewer))
        if path in ("/bepic/thumb", "/api/bepic/thumb"):
            self.thumbs.append(url)
            return route.fulfill(status=200, content_type="image/png", body=PNG)
        if path == "/agentY/tags" and req.method == "GET":
            return self._json(route, {"ok": True, "tags": self.memory})
        if path.startswith("/agentY/tags/"):
            body = json.loads(req.post_data or "{}")
            op = path.rsplit("/", 1)[1]
            self.calls.append((op, body))
            hit = next((t for t in self.memory if t["tag"] == (body.get("tag") or body.get("from"))), None)
            if hit is None:
                return self._json(route, {"ok": False, "error": "There is no remembered tag."}, 404)
            if op == "rename":
                hit.update(tag=body["to"], key=body["to"].lower())
                return self._json(route, {"ok": True, "tag": body["to"], "from": body["tag"], "path": hit["path"],
                                          "warning": "Hook prompts and messages that say #%s were not changed: "
                                                     "edit them to say #%s." % (body["tag"], body["to"])})
            if op in ("delete", "untag"):
                self.memory.remove(hit)
                return self._json(route, {"ok": True, "tag": hit["tag"], "path": hit["path"]})
            return self._json(route, {"ok": False, "error": "unexpected"}, 400)
        if path in ("/bepic/push", "/api/bepic/push"):
            self.calls.append(("push", json.loads(req.post_data or "{}")))
            return self._json(route, {"ok": True})
        if path == "/agent/pm_names":
            return self._json(route, {"ok": True, "entries": [
                {"name": t["key"], "tag": t["tag"], "type": "reference", "summary": t["role"], "path": t["path"],
                 "origin": t["origin"]} for t in self.memory]})
        return H.PanelHostsBrowser._serve(self, route)

    # -- helpers ----------------------------------------------------------------------
    def open_manager_from_menu(self, shown):
        shown.locator(".ay-wrap button[title^='Conversations']").first.click()
        shown.locator(".ay-cmenu .ay-cm-item", has_text="Manage tags").first.click()
        shown.locator(".ayt-card .ayt-row").first.wait_for(timeout=10000)

    def rows(self, shown):
        return shown.evaluate("""([FIND]) => eval(FIND)('.ayt-row').map(([tr]) =>
            [...tr.children].map((td) => td.textContent))""", [FIND])

    def same_root(self, a, b):
        """Whether the first `a` and the first shown `b` are in the same root (shadow root or document)."""
        return self.page.evaluate("""([FIND, a, b]) => { const [[x]] = eval(FIND)(a);
            const [[y]] = eval(FIND)(b).filter(([e]) => e.getClientRects().length);
            return x.getRootNode() === y.getRootNode(); }""", [FIND, a, b])

    def close_all(self, shown):
        self.page.close()
        if shown is not self.page:
            shown.close()

    # -- the tests -----------------------------------------------------------------------
    def test_list_grid_rename_and_delete_in_every_host(self):
        for where in ("sidebar", "viewer", "fullscreen", "popout"):
            with self.subTest(where=where):
                self.reset()
                shown = self.open_in(where)
                self.page.evaluate(CANVAS)
                self.open_manager_from_menu(shown)
                # in the panel's window and root
                [panel] = self.drawn(".ay-wrap")
                [card] = self.drawn(".ayt-card")
                self.assertEqual(card["popout"], panel["popout"], where)
                self.assertTrue(self.same_root(".ayt-card", ".ay-wrap"), where)
                # every tag: the canvas's and the host's
                rows = {r[0]: r[1:] for r in self.rows(shown)}
                self.assertEqual(sorted(rows), ["#hero_face", "#set", "#xss_file"])
                self.assertEqual(rows["#hero_face"], ["canvas node #12", "1"])
                self.assertEqual(rows["#set"], ["viewer", "1"])
                # the grid: a tile per picture, file name and path as text, a thumbnail URL
                shown.locator(".ayt-row", has_text="#set").first.click()
                shown.locator(".ayt-tile").first.wait_for(timeout=5000)
                tiles = shown.evaluate("""([FIND]) => eval(FIND)('.ayt-tile').map(([t]) => ({
                    fn: t.querySelector('.ayt-fn').textContent, path: t.querySelector('.ayt-path').textContent }))""", [FIND])
                self.assertEqual(tiles, [{"fn": "set.png", "path": "D:/out/set.png"}])
                if where != "popout":     # an about:blank popup's requests are not routed (see the hosts test)
                    shown.wait_for_function("([FIND]) => eval(FIND)('.ayt-tile img').some(([i]) => i.complete && i.naturalWidth > 0)",
                                            arg=[FIND], timeout=5000)
                    self.assertTrue(any("bepic/thumb?path=D%3A%2Fout%2Fset.png" in u for u in self.thumbs), self.thumbs)
                # rename a remembered tag: straight to the host, with the warning about hook prompts
                box = shown.locator(".ayt-viewhead input.ayt-input").first
                box.fill("stage")
                shown.locator(".ayt-viewhead button", has_text="Rename").first.click()
                shown.locator(".ayt-row", has_text="#stage").first.wait_for(timeout=5000)
                self.assertEqual(self.calls[-1], ("rename", {"tag": "set", "to": "stage"}))
                self.assertIn("were not changed", shown.locator(".ayt-msg").first.inner_text())
                # delete it: asked in the page first, then the host
                shown.locator(".ayt-viewhead button", has_text="Delete tag").first.click()
                self.assertEqual(self.calls[-1][0], "rename")            # nothing yet
                self.assertIn("Delete #stage?", shown.locator(".ayt-msg").first.inner_text())
                shown.locator(".ayt-foot button", has_text="Delete").first.click()
                shown.wait_for_function("([FIND]) => !eval(FIND)('.ayt-row').some(([r]) => r.textContent.includes('#stage'))",
                                        arg=[FIND], timeout=5000)
                self.assertEqual(self.calls[-1], ("delete", {"tag": "stage"}))
                # Escape closes it
                shown.keyboard.press("Escape")
                self.assertEqual(self.drawn(".ayt-card"), [])
                self.assertEqual(self.errors, [])
                self.close_all(shown)

    def test_a_canvas_tag_is_renamed_in_its_node_after_confirming(self):
        for where in ("sidebar", "popout"):
            with self.subTest(where=where):
                self.reset()
                shown = self.open_in(where)
                self.page.evaluate(CANVAS)
                self.open_manager_from_menu(shown)
                shown.locator(".ayt-row", has_text="#hero_face").first.click()
                note = shown.locator(".ayt-viewhead .ayt-note").first.inner_text()
                self.assertIn("canvas node #12 'hero tag'", note)
                shown.locator(".ayt-viewhead input.ayt-input").first.fill("lead face")
                shown.locator(".ayt-viewhead button", has_text="Rename").first.click()
                msg = shown.locator(".ayt-msg").first.inner_text()
                self.assertIn("canvas node #12 'hero tag'", msg)
                # not yet written
                self.assertEqual(self.page.evaluate("() => window.app.graph._nodes[1].widgets[0].value"), "hero_face")
                shown.locator(".ayt-foot button", has_text="Rename").first.click()
                shown.locator(".ayt-row", has_text="#lead_face").first.wait_for(timeout=5000)
                self.assertEqual(self.page.evaluate("() => window.app.graph._nodes[1].widgets[0].value"), "lead_face")
                self.assertFalse([c for c in self.calls if c[0] == "rename"], "a canvas-only tag is not the host's")
                self.close_all(shown)

    def test_from_the_viewers_history_filter(self):
        for where in ("viewer", "fullscreen", "popout"):
            with self.subTest(where=where):
                self.reset()
                shown = self.open_in(where)
                self.page.evaluate("""() => { const P = document.querySelector('bepic-viewer-panel');
                    if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
                    P._historyPanelSig = null; P.renderHistoryPanel(); P._syncHistoryTagFilter(); }""")
                self.page.wait_for_function("""([FIND]) => eval(FIND)('.history-tag-filter option')
                    .some(([o]) => o.value === '__manage_tags__')""", arg=[FIND], timeout=10000)
                self.page.evaluate("""([FIND]) => { const [[sel]] = eval(FIND)('.history-tag-filter');
                    sel.value = '__manage_tags__'; sel.dispatchEvent(new Event('change')); }""", [FIND])
                shown.locator(".ayt-card .ayt-row").first.wait_for(timeout=10000)
                [viewer] = self.drawn(".history-tag-filter")
                [card] = self.drawn(".ayt-card")
                self.assertEqual(card["popout"], viewer["popout"], where)
                self.assertTrue(self.same_root(".ayt-card", ".history-tag-filter"), where)
                self.close_all(shown)

    def test_remove_a_tag_from_the_viewers_menu(self):
        for where in ("viewer", "fullscreen", "popout"):
            with self.subTest(where=where):
                self.reset()
                shown = self.open_in(where)
                self.page.evaluate("""async () => { const P = document.querySelector('bepic-viewer-panel');
                    if (!P.isPanelDocked('history')) P.setPanelDocked('history', true);
                    const k = P.activeTab || 'main'; P.activeTab = k;
                    P.history[k] = [[{ path: 'D:/out/set.png', type: 'output' }], [{ path: 'D:/out/other.png', type: 'output' }]];
                    P._historyPanelSig = null; P.renderHistoryPanel(); await P.refreshAgentTags({ fresh: true }); }""")
                badges = """([FIND]) => eval(FIND)('.history-thumb').map(([t]) =>
                    [...t.querySelectorAll('.history-agent-tag > span:first-child')].map((s) => s.textContent))"""
                self.page.wait_for_function("([FIND]) => eval(FIND)('.history-agent-tag').length > 0", arg=[FIND], timeout=10000)
                self.assertEqual(self.page.evaluate(badges, [FIND]), [["#set"], []])
                shown.locator(".history-thumb").first.click(button="right")
                shown.locator(".thumb-ctx-item", has_text="Remove tag #set").first.click()
                self.page.wait_for_function("([FIND]) => eval(FIND)('.history-agent-tag').length === 0", arg=[FIND], timeout=10000)
                self.assertEqual(self.calls[-1], ("untag", {"tag": "set", "path": "D:/out/set.png"}))
                opts = self.page.evaluate("""([FIND]) => eval(FIND)('.history-tag-filter option').map(([o]) => o.textContent)""", [FIND])
                self.assertNotIn("#set", opts)
                self.assertIn("#xss_file", opts)
                self.assertEqual(self.errors, [])
                self.close_all(shown)

    def test_open_in_viewer(self):
        shown = self.open_in("viewer")
        self.open_manager_from_menu(shown)
        shown.locator(".ayt-row", has_text="#set").first.click()
        # a picture the viewer's history does not hold is pushed to it, and the page makes way
        shown.locator(".ayt-tile button", has_text="Open in viewer").first.click()
        shown.wait_for_function("([FIND]) => !eval(FIND)('.ayt-card').length", arg=[FIND], timeout=5000)
        self.assertEqual(self.calls[-1], ("push", {"paths": ["D:/out/set.png"], "tab_name": "agentY", "focus": True}))
        # one it holds is opened there, with no push
        self.page.evaluate("""() => { const P = document.querySelector('bepic-viewer-panel');
            const k = P.activeTab || 'main'; P.activeTab = k; P.history[k] = [[{ path: 'D:/out/set.png', type: 'output' }]]; }""")
        n = len(self.calls)
        self.open_manager_from_menu(shown)
        shown.locator(".ayt-row", has_text="#set").first.click()
        shown.locator(".ayt-tile button", has_text="Open in viewer").first.click()
        shown.wait_for_function("([FIND]) => !eval(FIND)('.ayt-card').length", arg=[FIND], timeout=5000)
        self.assertEqual(len(self.calls), n)
        self.assertTrue(self.page.evaluate("() => document.querySelector('bepic-viewer-panel').isViewingHistory"))

    def test_names_and_file_names_are_text(self):
        for where in ("sidebar", "viewer"):
            with self.subTest(where=where):
                self.reset()
                shown = self.open_in(where)
                self.open_manager_from_menu(shown)
                shown.locator(".ayt-row", has_text="#xss_file").first.click()
                shown.locator(".ayt-tile").first.wait_for(timeout=5000)
                self.assertEqual(shown.locator(".ayt-tile .ayt-fn").first.inner_text(), XSS + ".png")
                self.page.wait_for_timeout(300)
                injected = self.page.evaluate("""([FIND]) => eval(FIND)('.ayt-card img').filter(([i]) =>
                    i.getAttribute('src') === 'x' || i.hasAttribute('onerror')).length""", [FIND])
                self.assertEqual(injected, 0)
                self.assertIsNone(self.page.evaluate("window.__xss"))
                self.close_all(shown)


if __name__ == "__main__":
    unittest.main()
