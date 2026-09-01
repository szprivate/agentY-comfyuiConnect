"""The panel's icon map, and the two ways it can quietly stop working.

`setButtonIcon(btn, key, fallback)` falls back to an emoji when *key* is not in
iconsUI.json — deliberately, so a failed fetch never leaves a blank panel. The
cost of that kindness is that a missing mapping looks exactly like a working
button: the auto-graph toggle asked for the "autograph" icon, iconsUI.json had no
such entry, and it showed 🖼 on every platform for as long as nobody compared the
two files.

So both halves of the link are checked here: every key the code asks for exists,
and every icon a button names is really in the set.
"""

import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
ICONS = WEB / "iconsUI.json"

# setButtonIcon(someButton, "key", "fallback") — the key is what has to resolve.
_ASKED_FOR = re.compile(r'setButtonIcon\(\s*[^,]+,\s*"([A-Za-z0-9_-]+)"')


def config():
    return json.loads(ICONS.read_text(encoding="utf-8"))


def keys_used_in_js():
    used = {}
    for path in sorted(WEB.glob("*.js")):
        for key in _ASKED_FOR.findall(path.read_text(encoding="utf-8")):
            used.setdefault(key, path.name)
    return used


class TheIconMapIsWhole(unittest.TestCase):
    def test_it_is_valid_json(self):
        self.assertIsInstance(config(), dict)

    def test_every_key_the_panel_asks_for_is_mapped(self):
        """The bug that started this: a key with no mapping is a silent emoji."""
        cfg = config()
        for key, where in keys_used_in_js().items():
            with self.subTest(key=key, file=where):
                self.assertIn(key, cfg["buttons"],
                              f'{where} asks for "{key}"; iconsUI.json has no such button')

    def test_every_button_names_an_icon_that_exists(self):
        cfg = config()
        for button, icon in cfg["buttons"].items():
            with self.subTest(button=button):
                self.assertIn(icon, cfg["icons"])

    def test_no_icon_carries_its_own_svg_wrapper(self):
        """iconSvg() supplies the <svg> element — viewBox, stroke, currentColor.

        An entry that pasted the whole glyph instead of its inner markup would
        nest an <svg> inside an <svg>: it renders, at the wrong size, ignoring the
        button's colour, and looks like a styling problem rather than a data one.
        """
        for name, inner in config()["icons"].items():
            with self.subTest(icon=name):
                self.assertNotIn("<svg", inner)
                self.assertNotIn("currentColor", inner)

    def test_the_icons_are_drawn_in_the_viewbox_they_are_declared_for(self):
        self.assertEqual(config()["viewBox"], "0 0 24 24")


class TheAutoGraphToggle(unittest.TestCase):
    """It uses lucide `replace-all`, which is what was asked for."""

    def test_the_button_is_mapped_to_replace_all(self):
        self.assertEqual(config()["buttons"]["autograph"], "replace-all")

    def test_the_glyph_is_the_whole_glyph(self):
        """Nine elements: eight paths and the rect. A truncated paste renders —
        as most of an icon — so the count is the thing worth pinning."""
        inner = config()["icons"]["replace-all"]
        self.assertEqual(inner.count("<path"), 8)
        self.assertEqual(inner.count("<rect"), 1)

    def test_a_couple_of_its_actual_paths(self):
        inner = config()["icons"]["replace-all"]
        self.assertIn('d="m3 7 3 3 3-3"', inner)
        self.assertIn('<rect x="3" y="14" width="7" height="7" rx="1"/>', inner)

    def test_the_panel_still_asks_for_it(self):
        """Both ends of the link. Mapping an icon nothing requests is as useless
        as requesting one nothing maps."""
        self.assertIn("autograph", keys_used_in_js())


if __name__ == "__main__":
    unittest.main()
