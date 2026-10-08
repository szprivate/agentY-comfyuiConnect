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
        self.options = SETTINGS.split("export function mediaNodeOptions(choices, current, role, kind) {", 1)[1].split("\n}\n", 1)[0]

    def test_it_is_a_section_of_its_own_not_an_advanced_one(self):
        section = next(ln for ln in SETTINGS.splitlines() if 'title: "Load & save nodes"' in ln)
        self.assertIn('extra: "mediaNodes"', section)
        self.assertNotIn("advanced", section)

    def test_one_dropdown_for_each_kind_and_role(self):
        kinds = SETTINGS.split("const MEDIA_KINDS = ", 1)[1].split(";", 1)[0]
        for kind in ('["image", "Images"]', '["video", "Videos"]', '["audio", "Audio"]', '["model", "3D models"]'):
            self.assertIn(kind, kinds)
        self.assertIn('[["load", "load with"], ["save", "save with"]]', SETTINGS)
        self.assertIn('el("select", { className: "ays-input" })', self.rows)

    def test_a_choice_is_saved_under_media_nodes(self):
        self.assertIn('refs.push({ path: ["media_nodes", key], get: () => sel.value });', self.rows)

    def test_the_raw_object_is_not_drawn_a_second_time_below(self):
        self.assertIn('claimedObjects.add("media_nodes");', SETTINGS)

    def test_the_candidates_come_from_the_host(self):
        self.assertIn("MEDIA_NODES = (data.media_node_choices", SETTINGS)

    def test_automatic_is_always_offered_first(self):
        self.assertIn('const options = [{ value: "", label: auto }];', self.options)

    def test_automatic_says_what_it_means_where_there_is_no_built_in_loader(self):
        """Audio and 3D results are not placed on the canvas unless a loader is chosen."""
        self.assertIn('const MEDIA_NO_DEFAULT_LOADER = ["audio", "model"];', SETTINGS)
        self.assertIn('role === "load" && MEDIA_NO_DEFAULT_LOADER.includes(kind)', self.options)

    def test_a_choice_that_is_no_longer_offered_is_kept_not_cleared(self):
        """Opening the page while a pack is missing, then saving, must not reset it."""
        self.assertIn("if (current && !list.some((c) => String(c.id) === current))", self.options)
        self.assertIn("not available in this ComfyUI", self.options)


class VideoOrSequence(unittest.TestCase):
    """Under the video save node: a video file or an image sequence, and its format."""

    def setUp(self):
        self.rows = SETTINGS.split("function videoAsRows(container, chosen, refs, saveSel) {", 1)[1].split("\n}\n", 1)[0]
        self.formats = SETTINGS.split("export function sequenceFormatOptions(byNode, saveNode, current) {", 1)[1].split("\n}\n", 1)[0]

    def test_the_rows_sit_under_the_video_save_node(self):
        self.assertIn('if (key === "video_save") videoAsRows(container, chosen, refs, sel);', SETTINGS)

    def test_both_choices_are_saved(self):
        self.assertIn('refs.push({ path: ["media_nodes", "video_as"], get: () => mode.value });', self.rows)
        self.assertIn('refs.push({ path: ["media_nodes", "sequence_format"], get: () => fmt.value });', self.rows)
        self.assertIn('["video", "a video file (mp4)"], ["sequence", "an image sequence"]', self.rows)

    def test_the_formats_follow_the_chosen_save_node(self):
        self.assertIn('saveSel.addEventListener("change", fill);', self.rows)
        self.assertIn("Array.isArray(all[saveNode]) ? all[saveNode].slice() : []", self.formats)

    def test_the_current_format_is_never_dropped_from_the_list(self):
        self.assertIn("if (current && !list.includes(current)) list.push(current);", self.formats)
        self.assertIn('if (!list.length) list = ["png"];', self.formats)

    def test_it_says_which_node_acts_on_it(self):
        self.assertIn("Send to Image Viewer", SETTINGS.split("const VIDEO_AS_NOTE = ", 1)[1].split(";", 1)[0])


class DroppingAResult(unittest.TestCase):

    def test_a_chosen_loader_may_keep_its_file_under_another_widget_name(self):
        drop = CHAT.split("// The built-in loaders first; a loader chosen in Settings", 1)[1].split("if (w) {", 1)[0]
        self.assertIn('"image_path"', drop)
        self.assertIn('"model_file"', drop)
        self.assertIn('"audio"', drop)
        self.assertIn(".find(Boolean)", drop, "the first name that exists, in order of preference")


if __name__ == "__main__":
    unittest.main()
