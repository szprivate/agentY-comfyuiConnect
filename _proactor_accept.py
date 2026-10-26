"""Keep ComfyUI's listening socket alive on Windows.

On Windows asyncio's default ``ProactorEventLoop`` serves a listening socket with
``BaseProactorEventLoop._start_serving``. Its accept loop treats *any* ``OSError``
from a completed accept as fatal: it logs "Accept failed on a socket", closes the
listening socket and never re-arms it. A client that connects and is reset before
the accept completes (browser tabs closed mid-load, Playwright, test suites that
abort connections) makes Windows report WinError 64 (ERROR_NETNAME_DELETED) for
that one accept. The result is a ComfyUI whose process is alive but whose port
8188 no longer listens (CPython bpo-39010 / gh-93821 family).

``install()`` replaces that one method with a copy that logs a transient accept
error once and keeps accepting; the original behaviour stays for everything else.
It is a no-op off Windows, on a Python whose method differs from the one this was
written against, and when applied twice.

This file is self-contained on purpose (no agentY imports): it is loaded from
ComfyUI's own venv, and a copy of it is what the tests exercise.
"""
from __future__ import annotations

import inspect
import logging
import sys

log = logging.getLogger("agentY.proactor_accept")

# WinError codes an accept can finish with when the peer went away first:
# 64 NETNAME_DELETED, 121 SEM_TIMEOUT, 1236 CONNECTION_ABORTED,
# 10053 WSAECONNABORTED, 10054 WSAECONNRESET.
TRANSIENT_WINERRORS = frozenset({64, 121, 1236, 10053, 10054})

# Each failed accept consumes one dead connection from the backlog, so a storm of
# resets drains by itself and re-arming at once is right. If this many accepts in a
# row fail with no success in between, something is persistently wrong rather than a
# client going away: keep serving, but pause between attempts instead of spinning.
_SPIN_LIMIT = 1000
_SLOW_DELAY = 0.05

_EXPECTED_PARAMS = ["self", "protocol_factory", "sock", "sslcontext", "server",
                    "backlog", "ssl_handshake_timeout", "ssl_shutdown_timeout"]
_MARKER = "_agenty_transient_accept_patch"


def is_transient(exc: BaseException) -> bool:
    """True for an accept error that only means "that one client went away"."""
    if isinstance(exc, (ConnectionResetError, ConnectionAbortedError)):
        return True
    return isinstance(exc, OSError) and getattr(exc, "winerror", None) in TRANSIENT_WINERRORS


def _make_start_serving(original):
    def _start_serving(self, protocol_factory, sock,
                       sslcontext=None, server=None, backlog=100,
                       ssl_handshake_timeout=None,
                       ssl_shutdown_timeout=None):
        from asyncio import exceptions, trsock

        state = {"failures": 0, "logged": False}

        def loop(f=None):
            try:
                if f is not None:
                    conn, addr = f.result()
                    state["failures"] = 0
                    protocol = protocol_factory()
                    if sslcontext is not None:
                        self._make_ssl_transport(
                            conn, protocol, sslcontext, server_side=True,
                            extra={'peername': addr}, server=server,
                            ssl_handshake_timeout=ssl_handshake_timeout,
                            ssl_shutdown_timeout=ssl_shutdown_timeout)
                    else:
                        self._make_socket_transport(
                            conn, protocol,
                            extra={'peername': addr}, server=server)
                if self.is_closed():
                    return
                f = self._proactor.accept(sock)
            except OSError as exc:
                if sock.fileno() != -1:
                    if is_transient(exc):
                        state["failures"] += 1
                        if not state["logged"]:
                            state["logged"] = True
                            log.warning("accept on %s failed with a transient error (%r); "
                                        "still listening", _addr(sock), exc)
                        if not self.is_closed():
                            if state["failures"] < _SPIN_LIMIT:
                                self.call_soon(loop)
                            else:
                                self.call_later(_SLOW_DELAY, loop)
                        return
                    self.call_exception_handler({
                        'message': 'Accept failed on a socket',
                        'exception': exc,
                        'socket': trsock.TransportSocket(sock),
                    })
                    sock.close()
                elif self._debug:
                    logging.getLogger("asyncio").debug(
                        "Accept failed on socket %r", sock, exc_info=True)
            except exceptions.CancelledError:
                sock.close()
            else:
                self._accept_futures[sock.fileno()] = f
                f.add_done_callback(loop)

        self.call_soon(loop)

    setattr(_start_serving, _MARKER, original)
    return _start_serving


def _addr(sock):
    try:
        return sock.getsockname()
    except OSError:
        return "<socket>"


def install() -> bool:
    """Patch the proactor accept loop. Returns True when the patch is in place."""
    if sys.platform != "win32" or not (3, 10) <= sys.version_info[:2] <= (3, 13):
        return False
    try:
        from asyncio import proactor_events
        cls = proactor_events.BaseProactorEventLoop
        original = cls._start_serving
        if hasattr(original, _MARKER):
            return True
        if list(inspect.signature(original).parameters) != _EXPECTED_PARAMS:
            return False
        src = inspect.getsource(original)
        if "Accept failed on a socket" not in src or "_accept_futures" not in src:
            return False
        cls._start_serving = _make_start_serving(original)
        return True
    except Exception:  # never let a mitigation stop ComfyUI from starting
        log.exception("could not install the proactor accept patch")
        return False


def uninstall() -> None:
    """Restore the stock method (tests)."""
    try:
        from asyncio import proactor_events
        cls = proactor_events.BaseProactorEventLoop
        original = getattr(cls._start_serving, _MARKER, None)
        if original is not None:
            cls._start_serving = original
    except Exception:
        pass
