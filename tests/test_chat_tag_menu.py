"""The sidebar composer shares the hook prompts' `#` tag menu.

There is no JS engine in a ComfyUI install, so this reads the sources: the menu
lives once in agent_tags.js, the composer registers its textarea with it, and the
menu's key handling (capture phase, stops the event) is what keeps Enter from
sending a message while the menu is open.
"""
import pathlib
import re
import unittest

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
TAGS = (WEB / "agent_tags.js").read_text(encoding="utf-8")
CHAT = (WEB / "agent_chat.js").read_text(encoding="utf-8")


class ChatTagMenu(unittest.TestCase):
    def test_composer_registers_with_the_shared_menu(self):
        self.assertIn("export function registerTagBox", TAGS)
        self.assertRegex(CHAT, r'import \{[^}]*registerTagBox[^}]*\} from "\./agent_tags\.js"')
        self.assertRegex(CHAT, r"registerTagBox\(this\.input,\s*\{[^}]*anchor: \"above\"")

    def test_registration_follows_the_input_and_precedes_nothing_else(self):
        # the textarea must exist before it is registered
        self.assertLess(CHAT.index('this.input = el("textarea"'),
                        CHAT.index("registerTagBox(this.input"))

    def test_menu_keys_are_taken_before_the_composer_sees_them(self):
        self.assertRegex(TAGS, r'addEventListener\("keydown", onKeyDown, true\)')
        body = TAGS[TAGS.index("function onKeyDown"):TAGS.index("function onPointerDown")]
        for key in ("ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"):
            self.assertIn(f'case "{key}"', body)
        self.assertIn("e.stopPropagation()", body)

    def test_composer_menu_is_anchored_above_and_survives_log_scroll(self):
        self.assertIn("function placeAbove", TAGS)
        self.assertRegex(TAGS, r'owner\.anchor === "above"\) return placeAbove')
        self.assertRegex(TAGS, r'\.anchor === "above"\) return false')

    def test_composer_inserts_names_not_paths(self):
        self.assertRegex(CHAT, r'registerTagBox\(this\.input,\s*\{\s*inserts: "name"')


if __name__ == "__main__":
    unittest.main()
