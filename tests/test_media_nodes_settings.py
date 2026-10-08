"""Settings > Load & save nodes: a dropdown per kind of file and per role.

The candidates come from the host (media_node_choices), read from this
ComfyUI's own node list. The page only shows them and saves the choice under
settings.media_nodes.
"""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SETTINGS = (ROOT / "web" / "agent_settings.js").read_text(encoding="utf-8")
CHAT = (ROOT / "web" / "agent_chat.js").read_text(encoding="utf-8")


class TheSection(unittest.TestCase):

    def setUp(self):
        self.rows = SETTINGS.split("function mediaNodesRows(container, settings, refs) {", 1)[1].split("\n}\n", 1)[0]
        self.options = SETTINGS.split("export function mediaNodeOptions(choices, current, role) {", 1)[1].split("\n}\n", 1)[0]

    def test_it_is_a_section_of_its_own_not_an_advanced_one(self):
        section = next(ln for ln in SETTINGS.splitlines() if 'title: "Load & save nodes"' in ln)
        self.assertIn('extra: "mediaNodes"', section)
        self.assertNotIn("advanced", section)

    def test_one_dropdown_for_each_kind_and_role(self):
        self.assertIn('[["image", "Images"], ["video", "Videos"], ["audio", "Audio"]]', SETTINGS)
        self.assertIn('[["load", "load with"], ["save", "save with"]]', SETTINGS)
        self.assertIn('el("select", { className: "ays-input" })', self.rows)

    def test_a_choice_is_saved_under_media_nodes(self):
        self.assertIn('refs.push({ path: ["media_nodes", key], get: () => sel.value });', self.rows)

    def test_the_raw_object_is_not_drawn_a_second_time_below(self):
        self.assertIn('claimedObjects.add("media_nodes");', SETTINGS)

    def test_the_candidates_come_from_the_host(self):
        self.assertIn("MEDIA_NODES = (data.media_node_choices", SETTINGS)

    def test_automatic_is_always_offered_first(self):
        self.assertIn('[{ value: "", label: MEDIA_AUTO[role] || "Automatic" }]', self.options)

    def test_a_choice_that_is_no_longer_offered_is_kept_not_cleared(self):
        """Opening the page while a pack is missing, then saving, must not reset it."""
        self.assertIn("if (current && !list.some((c) => String(c.id) === current))", self.options)
        self.assertIn("not available in this ComfyUI", self.options)


class DroppingAResult(unittest.TestCase):

    def test_a_chosen_loader_may_keep_its_file_under_another_widget_name(self):
        drop = CHAT.split("// The built-in loaders first; a loader chosen in Settings", 1)[1].split("if (w) {", 1)[0]
        self.assertIn('"image_path"', drop)
        self.assertIn(".find(Boolean)", drop, "the first name that exists, in order of preference")


if __name__ == "__main__":
    unittest.main()
