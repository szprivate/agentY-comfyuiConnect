"""edit_graph grows an autogrow socket it is asked to wire.

A V3 autogrow slot (``model.reference_images.image_2``) exists on a node only
once its neighbour is wired, so a connect op naming one found no socket and was
reported "could not apply". The page now adds the socket under the address the
API prompt uses, typed by the op's ``slot_type``.

    python -m unittest tests.test_edit_graph_autogrow_slot
"""
import pathlib
import re
import unittest

CHAT = (pathlib.Path(__file__).resolve().parent.parent / "web" / "agent_chat.js").read_text(encoding="utf-8")


class ConnectGrowsTheSlot(unittest.TestCase):

    def _connect_branch(self):
        start = CHAT.index('} else if (op.op === "connect") {')
        return CHAT[start:CHAT.index('} else if (op.op === "disconnect")', start)]

    def test_a_missing_dotted_socket_is_added_under_its_address(self):
        branch = self._connect_branch()
        self.assertRegex(branch, r'includes\("\."\)')
        self.assertIn("to.addInput(String(op.input), op.slot_type || \"*\")", branch)

    def test_the_growth_happens_before_the_wire_is_drawn(self):
        branch = self._connect_branch()
        self.assertLess(branch.index("addInput"), branch.index("from.connect("))

    def test_a_plain_missing_input_is_still_a_miss(self):
        # Only a dotted name is grown; anything else stays "could not apply".
        self.assertTrue(re.search(r'slot < 0 && String\(op\.input \|\| ""\)\.includes\("\."\)',
                                  self._connect_branch()))


if __name__ == "__main__":
    unittest.main()
