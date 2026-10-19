"""The approval card keeps the panel "listening", goes away when the host gives up,
and a turn is only ever read by one stream.

Both run under node when it is installed (a ComfyUI install has no JavaScript
engine, so the tests skip there).

    python -m unittest tests.test_approval_and_single_reader
"""
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

WEB = pathlib.Path(__file__).resolve().parents[1] / "web"
NODE = shutil.which("node")


def run_node(script: str) -> dict:
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d) / "t.js"
        f.write_text(script, encoding="utf-8")
        out = subprocess.run([NODE, str(f)], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipUnless(NODE, "node is not installed")
class ApprovalCard(unittest.TestCase):
    def _script(self, responses):
        src = (WEB / "agent_permission.js").read_text(encoding="utf-8")
        src = src.replace('import { app } from "../../scripts/app.js";', "")
        src = src.replace('import { backendBase, backendReady } from "./agent_backend.js";', "")
        return f"""
const app = {{ registerExtension(e) {{ globalThis.ext = e; }} }};
const backendBase = () => "http://h"; const backendReady = Promise.resolve();
const mk = () => ({{ style: {{}}, children: [], append(...c) {{ this.children.push(...c); }},
  addEventListener() {{}}, focus() {{}}, remove() {{ this.removed = true; }} }});
globalThis.document = {{ getElementById: () => ({{}}), createElement: mk, head: mk(), body: mk(),
  addEventListener() {{}}, removeEventListener() {{}} }};
const calls = []; const responses = {json.dumps(responses)};
globalThis.fetch = async (url) => {{ calls.push(url);
  const r = responses.shift() || {{ request: null, pending: [] }};
  return {{ ok: true, json: async () => r }}; }};
{src.replace("for (;;) {", "for (let i = 0; i < 4; i++) {").replace("setTimeout(r, wait)", "setTimeout(r, 1)")}
ext.setup(); ext.setup();
setTimeout(() => console.log(JSON.stringify({{ calls, showing: typeof showing === "undefined" ? null : showing && showing.id }})), 200);
"""

    def test_polling_continues_while_a_card_is_up_and_it_comes_down_when_host_gives_up(self):
        req = {"permission_id": "p1", "tool": "add_mcp_server", "summary": "x", "allow_session": False}
        out = run_node(self._script([
            {"request": req, "pending": ["p1"]},   # card drawn
            {"request": req, "pending": ["p1"]},   # re-served, still waiting: no second card
            {"request": None, "pending": []},      # host timed out: card removed
        ]))
        # the loop ran once (setup called twice) and polled during the card
        self.assertGreaterEqual(len(out["calls"]), 3)
        self.assertIn("wait=5", out["calls"][1])
        self.assertIsNone(out["showing"])


@unittest.skipUnless(NODE, "node is not installed")
class SingleReader(unittest.TestCase):
    def test_a_second_reader_on_the_same_turn_applies_nothing(self):
        src = (WEB / "agent_chat.js").read_text(encoding="utf-8")
        i = src.index("  async _readSse(resp, ctx, run) {")
        j = src.index("  // Follow a turn this panel did not start", i)
        body = src[i:j]
        script = f"""
const STREAM_SILENCE_MS = 1;
class T {{ constructor() {{ this._openRuns = new Map(); this._endedRuns = new Map(); this.got = []; }}
  _onEvent(ev) {{ this.got.push(ev.type + ":" + (ev.data || "")); }}
  {body}
}}
const frames = (evs) => evs.map((e) => "data: " + JSON.stringify(e) + "\\n\\n");
const resp = (evs, hold) => {{ let i = 0; const fr = frames(evs); let rel; const gate = new Promise((r) => rel = r);
  return {{ release: rel, resp: {{ body: {{ getReader() {{ return {{
    async read() {{ if (i < fr.length) return {{ done: false, value: new TextEncoder().encode(fr[i++]) }};
      if (hold) await gate; return {{ done: true }}; }},
    async cancel() {{ this.cancelled = true; i = 1e9; if (rel) rel(); }} }}; }} }} }} }}; }};
(async () => {{
  const t = new T(); const ctx = {{}}; const run = (f) => f();
  const a = resp([{{type:"request",request_id:"r1"}},{{type:"text",data:"A"}},{{type:"done"}}], true);
  const pa = t._readSse(a.resp, ctx, run);
  await new Promise((r) => setTimeout(r, 20));
  const b = resp([{{type:"request",request_id:"r1"}},{{type:"text",data:"A"}},{{type:"text",data:"B"}}], false);
  await t._readSse(b.resp, ctx, run);                // duplicate while the first is open
  a.release(); await pa;
  const c = resp([{{type:"request",request_id:"r1"}},{{type:"text",data:"C"}}], false);
  await t._readSse(c.resp, ctx, run);                // replay right after it ended
  const d = resp([{{type:"request",request_id:"r2"}},{{type:"done"}}], false);
  await t._readSse(d.resp, ctx, run);
  const e = resp([{{type:"request",request_id:"r2"}},{{type:"text",data:"E"}}], false);
  await t._readSse(e.resp, ctx, run);                // replay after done
  console.log(JSON.stringify({{ got: t.got, open: t._openRuns.size }}));
}})();
"""
        out = run_node(script)
        self.assertEqual(out["got"], ["request:", "text:A", "done:", "request:", "done:"])
        self.assertEqual(out["open"], 0)


if __name__ == "__main__":
    unittest.main()
