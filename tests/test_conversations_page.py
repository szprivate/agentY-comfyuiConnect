"""The conversation menu and the Manage conversations page.

Read as source (there is no JS engine in a ComfyUI install), with the pure helpers
run under node where there is one - the same split test_settings_page.py uses.
"""
import pathlib
import shutil
import subprocess
import unittest

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
PAGE = (WEB / "agent_conversations.js").read_text(encoding="utf-8")
CHAT = (WEB / "agent_chat.js").read_text(encoding="utf-8")


class TheMenu(unittest.TestCase):

    def test_new_and_delete_buttons_left_the_bar(self):
        bar = CHAT.split('wrap.append(el("div", { className: "ay-bar" },', 1)[1].split("]));", 1)[0]
        self.assertIn("this.convMenuBtn", bar)
        self.assertNotIn("newBtn", bar)
        self.assertNotIn("delBtn", bar)
        self.assertNotIn('title: "New chat"', CHAT)

    def test_the_menu_holds_every_action(self):
        body = CHAT.split("_renderConvMenu(mode) {", 1)[1].split("\n  }\n", 1)[0]
        for label in ("New conversation", "Rename conversation", "Delete conversation",
                      "Search conversations", "Manage conversations"):
            self.assertIn(label, body)
        self.assertIn("openConversationManager(", body)

    def test_delete_is_confirmed_in_the_page_not_by_window_confirm(self):
        self.assertNotIn("confirm(", CHAT.replace("confirmText", ""))
        self.assertNotIn("window.confirm(", PAGE)
        self.assertIn("This cannot be undone", CHAT)

    def test_search_enter_opens_the_highlighted_result(self):
        body = CHAT.split("search.addEventListener(\"keydown\"", 1)[1][:900]
        self.assertIn('e.key === "Enter"', body)
        self.assertIn("this.openThread(id)", body)

    def test_deleting_the_open_conversation_switches_away(self):
        body = CHAT.split("async _afterDeleted(ids) {", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn("this.openThread(next.value)", body)
        self.assertIn("this.newThread()", body)

    def test_rename_goes_through_the_host(self):
        self.assertIn('"/rename"', PAGE)
        self.assertIn("renameConversation(this.threadId", CHAT)


class ThePage(unittest.TestCase):

    def test_the_overlay_takes_pointer_events_itself(self):
        rule = PAGE.split(".ayc-overlay{", 1)[1].split("}", 1)[0]
        self.assertIn("pointer-events:auto", rule)

    def test_comfyuis_dialog_is_closed_before_the_page_opens(self):
        body = PAGE.split("export async function openConversationManager", 1)[1][:200]
        self.assertIn("await closeHostDialogs();", body)

    def test_buttons_are_clickable(self):
        for cls in (".ayc-btn{", ".ayc-card{"):
            self.assertIn("pointer-events:auto", PAGE.split(cls, 1)[1].split("}", 1)[0])

    def test_columns_and_bulk_delete(self):
        for key in ("title", "created_at", "updated_at", "message_count", "size_chars", "preview"):
            self.assertIn(f'key: "{key}"', PAGE)
        self.assertIn("Select all", PAGE)
        self.assertIn("/agentY/threads/delete", PAGE)
        self.assertIn("confirmText(n)", PAGE)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_pure_helpers(self):
        a = PAGE.index("export const COLUMNS")
        b = PAGE.index("// ── host calls")
        code = PAGE[a:b].replace("export ", "")
        script = code + """
const rows = [
  {id:'a', title:'Beta', updated_at: 5, message_count: 2, preview:'make a beach'},
  {id:'b', title:'alpha', updated_at: 9, message_count: 10, preview:'relight'},
  {id:'c', title:'Gamma', updated_at: 1, message_count: 1, preview:'Beach again'},
];
console.log(JSON.stringify({
  byTitle: sortRows(rows,'title',1).map(r=>r.id),
  byMsgsDesc: sortRows(rows,'message_count',-1).map(r=>r.id),
  filt: filterRows(rows,'BEACH').map(r=>r.id),
  none: filterRows(rows,'').length,
  size: [fmtSize(5), fmtSize(2500), fmtSize(3e6)],
  c1: confirmText(1), c3: confirmText(3),
}));
"""
        out = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        import json
        d = json.loads(out.stdout)
        self.assertEqual(d["byTitle"], ["b", "a", "c"])
        self.assertEqual(d["byMsgsDesc"], ["b", "a", "c"])
        self.assertEqual(d["filt"], ["a", "c"])
        self.assertEqual(d["none"], 3)
        self.assertEqual(d["size"], ["5 ch", "2.5 k", "3.0 M"])
        self.assertTrue(d["c1"].startswith("Delete 1 conversation?"))
        self.assertTrue(d["c3"].startswith("Delete 3 conversations?"))


if __name__ == "__main__":
    unittest.main()
