"""The panel wires the composer's word jumps and the result-picture click the way the
browser test (test_composer_keys_browser.py) drives them.

Read off the sources: the browser test loads the real modules but mirrors
agent_chat.js's wiring, so this pins that wiring.
"""
import pathlib
import re
import unittest

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
CHAT = (WEB / "agent_chat.js").read_text(encoding="utf-8")
TAGS = (WEB / "agent_tags.js").read_text(encoding="utf-8")
KEYS = (WEB / "agent_composer_keys.js").read_text(encoding="utf-8")


class ComposerWiring(unittest.TestCase):
    def test_keys_module_has_no_comfyui_imports(self):
        self.assertNotIn("import ", KEYS)

    def test_word_jump_runs_first_in_the_composer(self):
        self.assertRegex(CHAT, r'import \{[^}]*altWordJump[^}]*\} from "\./agent_composer_keys\.js"')
        body = CHAT[CHAT.index("  _onKeydown(e) {"):]
        first = body.split("\n")[1:5]
        self.assertTrue(any("altWordJump(e, this.input)" in l for l in first), first)

    def test_command_list_ignores_modified_keys(self):
        body = CHAT[CHAT.index("  _onKeydown(e) {"):]
        self.assertIn("if (popOpen && !(e.altKey || e.ctrlKey || e.metaKey))", body)

    def test_tag_menu_ignores_modified_keys(self):
        body = TAGS[TAGS.index("function onKeyDown"):TAGS.index("function onPointerDown")]
        guard = body.index("if (e.altKey || e.ctrlKey || e.metaKey) return;")
        self.assertLess(body.index("isOpen()"), guard)
        self.assertLess(guard, body.index("switch (e.key)"))

    def test_picture_click_is_on_the_log_not_the_picture(self):
        # a log rebuilt from saved panel_html carries no per-picture listeners
        self.assertRegex(CHAT, r'ctx\.logEl\.addEventListener\("click"')
        self.assertIn("fullSizeSrc(t)", CHAT)
        # shown over the panel: the page's window.open did nothing from the popout
        self.assertIn("showFullSize(t, src)", CHAT)
        self.assertNotIn('window.open(src, "_blank"', CHAT)
        show = CHAT[CHAT.index("  _showOutput(ev) {"):CHAT.index("  injectNode(ev) {")]
        self.assertNotIn('addEventListener("click"', show)
        self.assertIn("img.ay-out-media", KEYS)


if __name__ == "__main__":
    unittest.main()
