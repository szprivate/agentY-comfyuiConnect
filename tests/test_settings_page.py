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
                                  "Output checks", "Execution", "Slack", "Deadline", "Updates", "Security", "Memory", "Files & logs"])

    def test_prompts_and_annotation_are_not_sections(self):
        for gone in ('"Prompts"', '"Annotation"', '"Providers"'):
            self.assertNotIn("title: " + gone, SECTIONS)

    def test_the_auxiliary_models_are_a_group_under_models(self):
        models = SECTIONS.split('{ title: "Models"', 1)[1].split('{ title: "Connections"', 1)[0]
        self.assertIn('aux: { title: "Auxiliary models", objects: [["decision"], ["annotate"], ["likeness"]] }', models)
        for key in ("decision:", "annotate:", "likeness:"):
            self.assertIn(key, JS.split("const GROUP_LABELS = {", 1)[1].split("};", 1)[0])

    def test_the_local_providers_are_the_only_ones_with_settings(self):
        providers = SECTIONS.split('{ title: "Connections"', 1)[1].split("},", 1)[0]
        self.assertIn('objects: [["llm", "ollama"], ["llm", "strata"]]', providers)
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


class SlackSection(unittest.TestCase):
    """The Slack .env variables live in the Slack section, not under Authentication."""

    def test_its_section_takes_the_slack_variables(self):
        self.assertIn('{ title: "Slack", inline: ["slack"], slackEnv: true }', SECTIONS)
        self.assertIn('const SLACK_KEYS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_ALLOWED_USERS"];', JS)

    def test_all_three_are_shown_even_when_empty(self):
        self.assertIn('for (const key of SLACK_KEYS) slackRows.push(envField(key, envNow[key] || ""));', JS)
        self.assertIn("if (section.slackEnv && slackRows && slackRows.length) {", JS)

    def test_authentication_leaves_them_out(self):
        self.assertIn("if (DEADLINE_KEYS.includes(key) || SLACK_KEYS.includes(key)) continue;", JS)

    def test_the_tokens_are_masked_and_the_same_field_as_before(self):
        field = JS.split("const envField = (key, cur) => {", 1)[1].split("const row = el(", 1)[0]
        self.assertIn("type: isSecret(key) ? \"password\" : \"text\"", field)
        self.assertIn("const age = ages.get(key);", field)                 # the key-age badge
        self.assertIn("envRmButtons.push(rm);", JS)                        # the Remove button
        self.assertIn("for (const b of envRmButtons) b.style.display", JS)  # and the toggle reaches it

    def test_the_service_list_does_not_offer_slack(self):
        self.assertIn('sv.id !== "slack"', JS)

    def test_the_help_text_says_the_fields_are_right_here(self):
        note = JS.split('  slack: "A SECOND way in', 1)[1].split("};", 1)[0]
        self.assertNotIn("Authentication above", note)
        self.assertNotIn("Add API key", note)
        self.assertIn("in the fields right here", note)


class TheModelRouting(unittest.TestCase):
    """llm.routing: the auto-switch switch and the rules table, drawn under Models."""

    def test_models_draws_it_and_the_generic_form_does_not(self):
        models = SECTIONS.split('{ title: "Models"', 1)[1].split('{ title: "Connections"', 1)[0]
        self.assertIn("routing: true", models)
        self.assertIn('"llm.routing"', HIDDEN)

    def test_the_switch_is_off_by_default_and_saves_to_its_setting(self):
        self.assertIn("Auto-switch suggested models", JS)
        self.assertIn('path: ["llm", "routing", "auto_switch"]', JS)
        self.assertIn('path: ["llm", "routing", "rules"]', JS)

    def test_a_rule_is_when_role_model_why(self):
        body = JS.split("function routingRows(", 1)[1].split("\n}\n", 1)[0]
        for part in ("kindSel", "roleSel", "modelSel", "whyInp", "buildModelSelect(modelGroups"):
            self.assertIn(part, body)
        for kind in ('"skill"', '"tool_pack"', '"tool"'):
            self.assertIn(kind, JS.split("const ROUTING_KINDS", 1)[1].split("];", 1)[0])




class TheStrataRow(unittest.TestCase):

    def test_the_strata_group_gets_test_start_and_stop(self):
        self.assertIn('if (objPath.join(".") === "llm.strata") sub.body.append(...strataRows());', JS)
        rows = JS.split("function strataRows()", 1)[1].split("async function postJson", 1)[0]
        for route in ("/agentY/strata/test", "/agentY/strata/control"):
            self.assertIn(route, rows)
        for label in ('"Test"', '"Start"', '"Stop"'):
            self.assertIn(label, rows)

    def test_a_local_model_is_not_priced(self):
        self.assertIn("!/ollama|strata/i.test(vendor)", JS)


class TheModalOverComfyUIsSettingsDialog(unittest.TestCase):
    """"Open agentY Settings..." sits in ComfyUI's own Settings dialog, a modal Reka
    UI dialog that sets pointer-events:none on <body> and traps the focus. The modal
    opened over it, inherited none, and not one of its controls could be clicked."""

    def test_the_overlay_takes_pointer_events_itself(self):
        rule = JS.split(".ays-overlay{", 1)[1].split("}", 1)[0]
        self.assertIn("pointer-events:auto", rule)

    def test_comfyuis_dialog_is_closed_before_the_modal_opens(self):
        body = JS.split("async function openAgentYSettingsModal() {", 1)[1][:200]
        self.assertIn("await closeHostDialogs();", body)

    @unittest.skipUnless(__import__("shutil").which("node"), "node is not installed")
    def test_close_host_dialogs_sends_escape_until_the_dialog_is_gone(self):
        import shutil
        import subprocess
        fn = "async function closeHostDialogs" + JS.split("export async function closeHostDialogs", 1)[1].split("\n}\n", 1)[0] + "\n}\n"
        sel = JS.split("const OPEN_DIALOG = ", 1)[1].split(";\n", 1)[0]
        script = f"""
const OPEN_DIALOG = {sel};
class KeyboardEvent {{ constructor(type, init) {{ this.type = type; Object.assign(this, init); }} }}
{fn}
let open = true; const keys = [];
const body = {{ dispatchEvent(e) {{ keys.push(e.type + ':' + e.key); if (e.key === 'Escape') setTimeout(() => {{ open = false; }}, 50); }} }};
const doc = {{ activeElement: null, body, querySelector: (s) => (s === OPEN_DIALOG && open ? {{}} : null) }};
const closed = await closeHostDialogs(doc, 1000);
const none = await closeHostDialogs({{ querySelector: () => null }});
console.log(JSON.stringify({{ closed, keys, none }}));
"""
        out = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), '{"closed":true,"keys":["keydown:Escape"],"none":true}')


class TheQueueHook(unittest.TestCase):

    def test_the_page_asks_the_host_before_it_queues(self):
        src = (ROOT / "web" / "agent_gpu_share.js").read_text(encoding="utf-8")
        self.assertIn("/agentY/strata/yield", src)
        self.assertIn("app.queuePrompt = wrapped", src)
        self.assertIn("STOP_WAIT_MS", src)          # never blocks the queue for good


if __name__ == "__main__":
    unittest.main()
