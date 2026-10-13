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
        self.assertEqual(titles, ["Models", "Connections", "LLM provider URLs", "Canvas", "Load & save nodes",
                                  "Output checks", "Slack", "Updates", "Security", "Memory", "LLM providers",
                                  "Files & logs"])

    def test_prompts_and_annotation_are_not_sections(self):
        for gone in ('"Prompts"', '"Annotation"', '"Providers"'):
            self.assertNotIn("title: " + gone, SECTIONS)

    def test_the_auxiliary_models_are_a_group_under_models(self):
        models = SECTIONS.split('{ title: "Models"', 1)[1].split('{ title: "Connections"', 1)[0]
        self.assertIn('aux: { title: "Auxiliary models", objects: [["decision"], ["annotate"], ["likeness"]] }', models)
        for key in ("decision:", "annotate:", "likeness:"):
            self.assertIn(key, JS.split("const GROUP_LABELS = {", 1)[1].split("};", 1)[0])

    def test_the_local_provider_is_the_only_one_with_settings(self):
        providers = SECTIONS.split('{ title: "LLM providers"', 1)[1].split("},", 1)[0]
        self.assertIn('objects: [["llm", "ollama"]]', providers)
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
        self.assertIn('"llm.ollama.num_ctx": "Max Token Window (Input + Output)"', JS)
        self.assertIn('"llm.ollama.max_tokens": "Max Output Tokens"', JS)

    def test_the_window_says_what_zero_came_to(self):
        self.assertIn('KEY_NOTES["llm.ollama.num_ctx"]', JS)
        self.assertIn("data.ollama_window", JS)

    def test_a_blank_path_says_where_it_goes(self):
        self.assertIn("SETTING_DEFAULTS = (data.setting_defaults", JS)
        self.assertIn('const fallback = SETTING_DEFAULTS[path.join(".")] || "";', JS)
        self.assertIn("input.placeholder = fallback", JS)

    def test_the_providers_endpoints_are_with_the_settings(self):
        self.assertIn("const isProviderUrl = (key) => /_BASE_URL$/.test(key);", JS)
        self.assertIn('{ title: "LLM provider URLs", envUrls: true }', SECTIONS)
        # still saved as .env variables, with the keys
        self.assertIn("envInputs[key] = { input: inp, original: cur };", JS)


if __name__ == "__main__":
    unittest.main()
