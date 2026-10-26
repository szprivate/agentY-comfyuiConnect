"""The Windows accept-loop outage: a ProactorEventLoop server that stops listening.

Real reproduction, no ComfyUI: a tiny aiohttp server runs in a subprocess on the
default Proactor loop, many sockets connect and abort with RST (SO_LINGER 0) while
the accept is in flight, and then we ask whether the port still answers. Stock
asyncio logs "Accept failed on a socket" (WinError 64) and closes the listener;
with ``_proactor_accept.install()`` the server keeps serving.

Windows only, and slow-ish (a few seconds per run).
"""
import os
import socket
import struct
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path

EXT = Path(__file__).resolve().parent.parent

_SERVER = textwrap.dedent('''
    import asyncio, sys
    sys.path.insert(0, {ext!r})
    if {patch!r}:
        import _proactor_accept
        assert _proactor_accept.install(), "patch did not install"
    from aiohttp import web

    async def hello(request):
        return web.Response(text="ok")

    async def main():
        app = web.Application()
        app.router.add_get("/", hello)
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", {port}).start()
        print("ready", flush=True)
        await asyncio.Event().wait()

    asyncio.run(main())
''')


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _serves(port, tries=3):
    for _ in range(tries):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2) as c:
                c.sendall(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
                if b"200 OK" in c.recv(4096):
                    return True
        except OSError:
            pass
        time.sleep(0.2)
    return False


def _hammer(port, seconds, threads=16):
    stop = time.time() + seconds

    def work():
        linger = struct.pack("ii", 1, 0)  # close() sends RST
        while time.time() < stop:
            try:
                s = socket.socket()
                s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, linger)
                s.settimeout(0.5)
                try:
                    s.connect(("127.0.0.1", port))
                except OSError:
                    pass
                s.close()
            except OSError:
                pass

    ts = [threading.Thread(target=work) for _ in range(threads)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()


def _python_with_aiohttp():
    candidates = [sys.executable, r"D:\ai\comfyui\.venv\Scripts\python.exe"]
    for exe in candidates:
        if exe and os.path.exists(exe):
            if subprocess.run([exe, "-c", "import aiohttp"], capture_output=True).returncode == 0:
                return exe
    return None


def run_scenario(patch, seconds=6):
    """Returns (still_serving, stderr_text)."""
    exe = _python_with_aiohttp()
    if exe is None:
        raise unittest.SkipTest("no python with aiohttp")
    port = _free_port()
    code = _SERVER.format(ext=str(EXT), patch=patch, port=port)
    # stderr goes to a file: the failed accepts log a traceback each, and an
    # unread pipe fills up and blocks the server, which looks like a dead listener.
    errf = tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace")
    p = subprocess.Popen([exe, "-c", code], stdout=subprocess.PIPE, stderr=errf, text=True)
    try:
        assert p.stdout.readline().strip() == "ready", "server did not start"
        assert _serves(port), "server not serving before the storm"
        _hammer(port, seconds)
        time.sleep(0.5)
        alive = _serves(port)
    finally:
        p.kill()
        p.wait()
        errf.seek(0)
        err = errf.read()
        errf.close()
        p.stdout.close()
    return alive, err


@unittest.skipUnless(sys.platform == "win32", "ProactorEventLoop accept loop is Windows-only")
class TransientAcceptTests(unittest.TestCase):
    def test_patched_server_keeps_listening(self):
        alive, err = run_scenario(patch=True)
        self.assertTrue(alive, err[-2000:])
        self.assertNotIn("Accept failed on a socket", err)

    def test_stock_server_dies(self):
        """Documents the bug. If CPython ever fixes it, this one starts failing and
        the patch (and this test) can go."""
        alive, err = run_scenario(patch=False, seconds=10)
        if alive:
            self.skipTest("could not provoke the accept failure on this machine/Python")
        self.assertIn("Accept failed on a socket", err)


class IsTransientTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(EXT))
        import _proactor_accept
        self.m = _proactor_accept

    def test_classification(self):
        m = self.m
        self.assertTrue(m.is_transient(OSError(22, "gone", None, 64)))
        self.assertTrue(m.is_transient(OSError(22, "sem", None, 121)))
        self.assertTrue(m.is_transient(ConnectionResetError()))
        self.assertTrue(m.is_transient(ConnectionAbortedError()))
        self.assertFalse(m.is_transient(OSError(22, "bad", None, 10038)))
        self.assertFalse(m.is_transient(OSError("plain")))
        self.assertFalse(m.is_transient(ValueError()))

    def test_install_is_noop_off_windows(self):
        real = sys.platform
        sys.platform = "linux"
        try:
            self.assertFalse(self.m.install())
        finally:
            sys.platform = real


if __name__ == "__main__":
    unittest.main()
