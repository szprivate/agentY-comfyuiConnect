"""The /agent/* routes refuse requests that are not from this machine's own page.

ComfyUI's origin check only covers a loopback Host, so a site that re-points its
own name at 127.0.0.1 (DNS rebinding) reaches these routes with a matching
Origin. host_info hands out the agentY session token and offline_settings writes
.env and mcp.json; register_host decides what start_host runs.
"""
import unittest
from unittest import mock

try:
    from tests.test_platform import _load_head
except ImportError:  # run from inside tests/
    from test_platform import _load_head


class Req:
    def __init__(self, remote="127.0.0.1", **headers):
        self.headers = headers
        self.remote = remote


class RouteGuard(unittest.TestCase):

    def setUp(self):
        self.ns = _load_head()

    def test_addresses_and_localhost_are_this_machine(self):
        own = self.ns["_own_host"]
        for host in ("127.0.0.1:8188", "localhost:8188", "[::1]:8188", "192.168.1.20:8188",
                     "::1", ""):
            self.assertTrue(own(host), host)

    def test_a_foreign_name_is_refused(self):
        self.assertFalse(self.ns["_own_host"]("evil.example:8188"))
        why = self.ns["_foreign_request"](Req(Host="evil.example:8188",
                                              Origin="http://evil.example:8188"))
        self.assertIn("rebinding", why)

    def test_this_machines_own_name_and_configured_names_pass(self):
        import socket
        self.assertTrue(self.ns["_own_host"](socket.gethostname() + ":8188"))
        with mock.patch.dict("os.environ", {"AGENTY_ALLOWED_HOSTS": "studio.lan, comfy.example"}):
            self.assertTrue(self.ns["_own_host"]("comfy.example:8188"))

    def test_a_cross_origin_page_is_refused(self):
        fr = self.ns["_foreign_request"]
        self.assertEqual(fr(Req(Host="127.0.0.1:8188", Origin="http://127.0.0.1:8188")), "")
        self.assertEqual(fr(Req(Host="127.0.0.1:8188")), "")
        self.assertTrue(fr(Req(Host="127.0.0.1:8188", Origin="https://evil.example")))

    def test_only_a_local_program_may_register_the_host(self):
        local = self.ns["_from_local_process"]
        self.assertTrue(local(Req(Host="127.0.0.1:8188")))
        self.assertTrue(local(Req(remote="::1", Host="localhost:8188")))
        # a browser page always sends Origin on a POST
        self.assertFalse(local(Req(Host="127.0.0.1:8188", Origin="http://127.0.0.1:8188")))
        # another machine
        self.assertFalse(local(Req(remote="192.168.1.9", Host="192.168.1.20:8188")))

    def test_every_agent_route_is_guarded(self):
        from pathlib import Path
        src = (Path(__file__).resolve().parents[1] / "__init__.py").read_text(encoding="utf-8")
        import re
        routes = re.findall(r'@_routes\.(?:get|post)\("(/agent/[a-z_]+)"\)\n    (\S+)', src)
        self.assertTrue(routes)
        for path, nxt in routes:
            self.assertEqual(nxt, "@_guarded", path)

    def test_register_host_accepts_only_our_launchers(self):
        self.assertEqual(set(self.ns["_LAUNCHERS"]), {"run_agent.ps1", "run_agent.sh"})


if __name__ == "__main__":
    unittest.main()
