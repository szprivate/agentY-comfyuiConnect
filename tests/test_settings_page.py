"""The settings page shows what there is to choose, and nothing that is set elsewhere.

Read from the page's source: which sections it has, what it keeps off the page,
and how the rows whose key does not say what it is are named.
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
JS = (ROOT / "web" / "agent_settings.js").read_text(encoding="utf-8")
SECTIONS = JS.split("const SECTIONS = [", 1)[1].split("\n];", 1)[0]
HIDDEN = JS.split("const HIDDEN = new Set([", 1)[1].split("]);", 1)[0]


class TheSections(unittest.TestCase):

    def test_their_names_in_order(self):
        titles = re.findall(r'^  \{ title: "([^"]+)"', SECTIONS, flags=re.M)
        self.assertEqual(titles, ["Models", "Connections", "Canvas", "Load & save nodes",
                                  "Output checks", "Slack", "Deadline", "Updates", "Security", "Memory", "Files & logs"])

    def test_prompts_and_annotation_are_not_sections(self):
        for gone in ('"Prompts"', '"Annotation"', '"Providers"'):
            self.assertNotIn("title: " + gone, SECTIONS)

    def test_the_auxiliary_models_are_a_group_under_models(self):
        models = SECTIONS.split('{ title: "Models"', 1)[1].split('{ title: "Connections"', 1)[0]
        self.assertIn('aux: { title: "Auxiliary models", objects: [["decision"], ["annotate"], ["likeness"]] }', models)
        for key in ("decision:", "annotate:", "likeness:"):
            self.assertIn(key, JS.split("const GROUP_LABELS = {", 1)[1].split("};", 1)[0])

    def test_the_local_provider_is_the_only_one_with_settings(self):
        providers = SECTIONS.split('{ title: "Connections"', 1)[1].split("},", 1)[0]
        self.assertIn('objects: [["llm", "ollama"]]', providers)
        self.assertIn("envUrls: true", providers)             # the endpoints are in the same section
        self.assertNotIn("advanced", providers)               # and it is shown without asking
        self.assertNotIn("anthropic", providers)
        self.assertNotIn("dashscope", providers)


class WhatIsKeptOffThePage(unittest.TestCase):

    def test_what_is_set_elsewhere_or_not_from_a_form(self):
        for path in ("memory.embedder", "memory.llm", "llm.vision_models", "llm.text_only_models",
                     "llm.ollama.host", "llm.ollama.think", "llm.anthropic", "llm.dashscope", "system_prompts"):
            self.assertIn(f'"{path}"', HIDDEN, path)

    def test_hidden_is_honoured_wherever_rows_are_made(self):
        self.assertIn("if (isHidden(path)) return;", JS)                       # a row
        self.assertIn("if (isHidden(path)) continue;", JS)                     # a nested group
        self.assertIn("if (isHidden(inlinePath.concat(k))) continue;", JS)     # an inlined group's rows
        self.assertIn("for (const path of HIDDEN) claimedObjects.add(path);", JS)   # and never under "Other"

    def test_the_page_writes_only_what_it_shows(self):
        """A hidden setting keeps its value: refs are made by rows, and a save is the refs."""
        self.assertIn("settings: collectSettings(refs)", JS)


class HowRowsAreNamed(unittest.TestCase):

    def test_the_window_and_the_output_allowance(self):
        self.assertIn('"llm.ollama.num_ctx": "Context Window Size"', JS)
        self.assertIn('"llm.ollama.max_tokens": "Max Output Tokens"', JS)

    def test_the_window_shows_the_number_it_was_worked_out_to(self):
        self.assertIn('KEY_NOTES["llm.ollama.num_ctx"]', JS)
        self.assertIn("data.ollama_window", JS)
        self.assertIn('if (win.auto && Number(win.window) > 0) AUTO_VALUES["llm.ollama.num_ctx"] = Number(win.window);', JS)
        # the field shows that number; untouched, the file keeps its -1
        self.assertIn("const shown = worked !== undefined ? worked : val;", JS)
        self.assertIn("return n === shown ? val : n;", JS)

    def test_the_output_allowance_shows_what_it_was_worked_out_to_as_well(self):
        self.assertIn('if (win.output_auto && Number(win.output) > 0) AUTO_VALUES["llm.ollama.max_tokens"] = Number(win.output);', JS)

    def test_a_blank_path_says_where_it_goes(self):
        self.assertIn("SETTING_DEFAULTS = (data.setting_defaults", JS)
        self.assertIn('const full = SETTING_DEFAULTS[path.join(".")] || "";', JS)
        # shown in full; saved as the file had it unless the field was edited
        self.assertIn("refs.push({ path, get: () => (input.value === shown ? stored : input.value) });", JS)

    def test_comfyuis_other_model_folders_are_shown_and_not_edited(self):
        self.assertIn('"comfyui_extra_model_dirs"', JS)
        self.assertIn("input.readOnly = true;", JS)

    def test_an_auxiliary_model_is_picked_from_a_searchable_list(self):
        self.assertIn('Array.isArray(AUX_CHOICES[path.join(".")])', JS)
        block = JS.split('Array.isArray(AUX_CHOICES[path.join(".")])', 1)[1].split("} else {", 1)[0]
        self.assertIn("searchableSelect(sel", block)
        self.assertIn("if (!choices.some((c) => c.id === current))", block)      # what is set stays pickable

    def test_a_key_can_be_taken_out_of_env(self):
        self.assertIn("Remove auth key", JS)
        self.assertIn("if (envRemove.size) payload.env_remove = [...envRemove];", JS)
        self.assertIn("if (envRemove.has(key)) continue;", JS)                 # a removed key is not also written

    def test_the_providers_endpoints_are_with_the_settings(self):
        self.assertIn("const isProviderUrl = (key) => /_BASE_URL$/.test(key);", JS)
        # still saved as .env variables, with the keys
        self.assertIn("envInputs[key] = { input: inp, original: cur };", JS)


if __name__ == "__main__":
    unittest.main()
