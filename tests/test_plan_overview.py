"""The plan overview: the host's record of a pipeline run, in the panel.

It took the place of two things: the auto-graph button (a setting, which lives in
Settings) and the strip of shot chips. What it prints is worked out in
web/agent_plan.js, checked with node where there is one; how it sits in the panel
by reading agent_chat.js.
"""
import json
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
NODE = shutil.which("node")
CHAT = (WEB / "agent_chat.js").read_text(encoding="utf-8")

SCRIPT = """
import { anyBranchRunning, groupLabel, hasPlan, planChips, planLine, stageLabel, stageMark,
         stageNote, stageTitle } from %s;
const row = (o) => Object.assign({ id: "8", title: "characters", purpose: "set / sweep parameter",
  state: "pending", round: 0, changed: false, files: 0, text: false, review: "", by: "" }, o);
const shots = [{ shot: "characters", thread_id: "b1", status: "running", report: "" },
               { shot: "places", thread_id: "b2", status: "done", report: "DONE two files" }];
const plan = { lead_id: "lead", lead_title: "Short film", shots,
  line: "1/4 approved · 1 waiting for you · 1 branch running",
  groups: [{ kind: "trunk", name: "Before the branches", stages: [row({ id: "4", state: "approved", text: true })] },
           { kind: "branch", name: "characters", thread_id: "b1", status: "running", stages: [row({ state: "waiting", files: 2 })] }] };
const bare = { lead_id: "lead", lead_title: "Short film", shots, line: "", groups: [] };
console.log(JSON.stringify({
  marks: [stageMark(row({})), stageMark(row({ state: "done" })), stageMark(row({ state: "waiting" })),
          stageMark(row({ state: "approved" })), stageMark(row({ state: "approved", changed: true }))],
  label: [stageLabel(row({})), stageLabel(row({ title: "" }))],
  notes: [stageNote(row({})), stageNote(row({ state: "waiting", round: 3, files: 2 })),
          stageNote(row({ state: "approved", files: 1 })), stageNote(row({ state: "done", text: true })),
          stageNote(row({ state: "approved", changed: true, files: 2 }))],
  title: stageTitle(row({ state: "waiting", files: 2, review: "135", by: "characters" })),
  groups: [groupLabel(plan.groups[0]), groupLabel(plan.groups[1])],
  has: [hasPlan(plan), hasPlan(bare), hasPlan(null)],
  line: [planLine(plan), planLine(bare)],
  chips_on_lead: planChips(plan, "lead").map((c) => c.label),
  chips_on_branch: planChips(plan, "b1").map((c) => [c.id, c.label]),
  chips_no_plan: planChips(bare, "lead").map((c) => c.label),
  chips_no_shots: planChips({ lead_id: "x", shots: [], groups: plan.groups }, "x"),
  running: [anyBranchRunning(plan), anyBranchRunning({ shots: [shots[1]] })],
}));
"""


@unittest.skipUnless(NODE, "node is not installed")
class WhatItPrints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = json.dumps((WEB / "agent_plan.js").as_uri())
        out = subprocess.run([NODE, "--input-type=module", "-e", SCRIPT % src],
                             capture_output=True, text=True, encoding="utf-8", timeout=60)
        if out.returncode != 0:
            raise AssertionError(out.stderr)
        cls.got = json.loads(out.stdout)

    def test_one_mark_per_state_and_changed_over_all_of_them(self):
        self.assertEqual(self.got["marks"], ["○", "●", "⏸", "✓", "≠"])

    def test_a_stage_is_called_by_its_node_id(self):
        self.assertEqual(self.got["label"], ["8 characters", "8"])

    def test_the_note_says_where_it_stands_and_what_there_is(self):
        self.assertEqual(self.got["notes"], [
            "not done yet", "waiting for you · round 3 · 2 files", "approved · 1 file",
            "done · text", "approved · inputs changed since · 2 files"])

    def test_the_tooltip_adds_the_review_and_the_branch(self):
        self.assertEqual(self.got["title"],
                         "set / sweep parameter — waiting for you · 2 files — review 135 — "
                         "by branch characters\nClick to select the node on the canvas.")

    def test_a_branch_heading_carries_its_state(self):
        self.assertEqual(self.got["groups"], ["Before the branches", "🟢 characters"])

    def test_there_is_a_plan_only_when_the_host_has_stages(self):
        self.assertEqual(self.got["has"], [True, False, False])
        self.assertEqual(self.got["line"], ["1/4 approved · 1 waiting for you · 1 branch running", ""])

    def test_on_the_lead_the_branches_are_in_the_list_not_in_chips(self):
        self.assertEqual(self.got["chips_on_lead"], [])

    def test_on_a_branch_there_is_a_way_back_to_the_lead(self):
        self.assertEqual(self.got["chips_on_branch"], [["lead", "◆ Lead"]])

    def test_shots_without_a_pipeline_keep_their_chips(self):
        self.assertEqual(self.got["chips_no_plan"], ["◆ Lead", "🟢 characters", "✓ places"])

    def test_a_run_with_no_branches_has_no_chips(self):
        self.assertEqual(self.got["chips_no_shots"], [])

    def test_stop_is_offered_while_a_branch_works(self):
        self.assertEqual(self.got["running"], [True, False])


class InThePanel(unittest.TestCase):
    def test_the_plan_button_took_the_auto_graph_buttons_place(self):
        self.assertIn('setButtonIcon(this.planBtn, "plan", "☰");', CHAT)
        self.assertIn("[this.threadSel, newBtn, delBtn, this.undoBtn, this.planBtn, this.loopBtn]", CHAT)
        for gone in ("autographBtn", "_toggleAutograph", "_loadAutograph"):
            self.assertNotIn(gone, CHAT)

    def test_that_switch_is_still_in_settings(self):
        settings = (WEB / "agent_settings.js").read_text(encoding="utf-8")
        self.assertIn("autoload_workflows_into_canvas", settings)

    def test_it_reads_the_hosts_record(self):
        body = CHAT.split("  async _refreshShotBar() {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn('"/agentY/threads/" + encodeURIComponent(id) + "/plan"', body)
        self.assertNotIn('+ "/shots",', body)

    def test_the_line_is_there_whenever_there_is_a_run_and_the_list_only_when_opened(self):
        body = CHAT.split("  async _refreshShotBar() {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn("this.planLineEl.hidden = !line;", body)
        render = CHAT.split("  _renderPlanBody(data) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn("const open = !!this._planOpen && hasPlan(data);", render)
        self.assertIn("this.planBodyEl.hidden = !open;", render)

    def test_a_stage_selects_its_node_and_a_branch_opens_its_conversation(self):
        render = CHAT.split("  _renderPlanBody(data) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn('row.addEventListener("click", () => this._selectCanvasNode(s.id));', render)
        self.assertIn('if (tid) head.addEventListener("click", () => this.openThread(tid));', render)

    def test_nothing_is_approved_from_it(self):
        for part in ("  _renderPlanBody(data) {", "  _selectCanvasNode(id) {", "  _togglePlan() {"):
            body = CHAT.split(part, 1)[1].split("\n  }\n", 1)[0]
            self.assertNotIn("fetch(", body, part)

    def test_it_is_kept_current_while_a_run_is_on_screen(self):
        self.assertIn("if (this._shotLead() || hasPlan(this._plan)) this._refreshShotBar();", CHAT)
        done = CHAT.split('      case "done":', 1)[1].split("break;", 1)[0]
        self.assertIn("this._refreshShotBar();", done)


if __name__ == "__main__":
    unittest.main()
