"""agentY-comfyuiConnect — canvas ↔ agent bridge.

Three responsibilities:

1. **Push** — the agentY pipeline POSTs a graph-format workflow to
   ``/agent/load_workflow``; this broadcasts it over the websocket and
   ``web/agent_canvas.js`` loads it onto the canvas, so the user sees exactly
   what the agent just ran without clicking.

2. **Hook node** — the ``AgentYHook`` node lets the user annotate any node's
   output with a natural-language directive ("sweep the seed", "iterate this
   folder"). It is a pure identity passthrough, so on a normal Queue Prompt it is
   never executed (ComfyUI only runs nodes on the path to an output node, and an
   unreferenced hook is skipped by validation/execution). When the user asks the
   agentY agent to run the on-canvas graph, ``web/agent_chat.js`` ships the
   captured API prompt + the hook directives and the pipeline expands them.

3. **Canvas selection** — ``/agent/canvas_selection`` (read) and
   ``/agent/set_node_params`` (write) let a caller *outside* the browser reach
   the litegraph selection: the request is relayed to the open page over the
   websocket and answered from there. The sidebar chat already ships its
   selection with every message; this is how the agentY **MCP** server (running
   under Claude, with no page of its own) sees the same thing.

The hook is a **V3** node so its ``anchor`` input can *auto-grow*: connect one
node and a fresh empty ``anchor`` slot appears, letting a single hook gather
several inputs (e.g. combine three images in a standin, or apply one directive
across two anchor nodes).
"""
import asyncio as _asyncio
import json as _json
import os as _os
import re as _re
import subprocess as _subprocess
import sys as _sys
import uuid as _uuid
from pathlib import Path as _Path

from aiohttp import web

# Where this extension records the agentY host's location, so the sidebar's
# "Start server" button can relaunch ``run_agent.ps1`` when the host on :5000 is
# down (a browser can't spawn a process, but this ComfyUI-side route can). The
# file is written by the agentY host on startup (self-registration) and by
# ``install_agent.ps1``; it's gitignored (machine-specific path).
_EXT_DIR = _os.path.dirname(_os.path.abspath(__file__))
_HOST_CFG = _os.path.join(_EXT_DIR, ".agenty_host.json")

# Native OS file-picker helper for the agentY collector nodes. Run as a
# subprocess (under ComfyUI's own Python, which has tkinter) so the Tk dialog
# never touches the aiohttp event loop. See ``_agent_pick_files`` below.
_PICKER = _os.path.join(_EXT_DIR, "_filepicker.py")
_PICK_IMG_EXTS = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff"}
_PICK_VID_EXTS = {"mp4", "mov", "webm", "mkv", "avi", "m4v", "mpg", "mpeg"}

# The kinds /agent/pick_files accepts, and what each one expands a picked FOLDER
# to. "media" is what the merged collector asks for; the two single-kind values
# stay for the deprecated video collector and any old caller. Kept as one table
# because the accept-list and the expansion used to carry separate ideas of what
# a valid kind was: "media" was missing from the first, so it fell to the default
# and the dialog offered images only, while the second handled it perfectly well.
_PICK_KINDS = {
    "image": _PICK_IMG_EXTS,
    "video": _PICK_VID_EXTS,
    "media": _PICK_IMG_EXTS | _PICK_VID_EXTS,
}
# An unrecognised kind falls to the SUPERSET, never to one kind — a fallback that
# hides files the caller asked for is how the above stayed invisible.
_PICK_DEFAULT_KIND = "media"


def _read_host_cfg():
    """Resolve (project_root, run_script) for the agentY host. ``AGENTY_ROOT`` env
    wins; otherwise the recorded ``.agenty_host.json``. Returns ("", script) when
    unknown."""
    script = "run_agent.ps1"
    root = (_os.environ.get("AGENTY_ROOT") or "").strip()
    if not root and _os.path.isfile(_HOST_CFG):
        try:
            with open(_HOST_CFG, "r", encoding="utf-8") as _fh:
                data = _json.load(_fh)
            root = str(data.get("project_root", "")).strip()
            script = str(data.get("run_script", script)).strip() or script
        except Exception:  # noqa: BLE001
            pass
    return root, script


try:
    from server import PromptServer
    _routes = PromptServer.instance.routes

    @_routes.post("/agent/load_workflow")
    async def _agent_load_workflow(request):  # noqa: ANN001
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
        graph = data.get("workflow", data) if isinstance(data, dict) else None
        if not isinstance(graph, dict) or "nodes" not in graph:
            return web.json_response({"ok": False, "error": "not a graph workflow"}, status=400)
        # Broadcast to every connected ComfyUI frontend (sid=None => all).
        PromptServer.instance.send_sync("agent.load_workflow", graph)
        return web.json_response({"ok": True, "nodes": len(graph.get("nodes", []))})

    @_routes.post("/agent/register_host")
    async def _agent_register_host(request):  # noqa: ANN001
        """The agentY host tells us where it lives (so we can relaunch it later)."""
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
        root = str((data or {}).get("project_root", "")).strip()
        script = str((data or {}).get("run_script", "run_agent.ps1")).strip() or "run_agent.ps1"
        if not root or not _os.path.isdir(root):
            return web.json_response({"ok": False, "error": "project_root is not a directory"}, status=400)
        try:
            with open(_HOST_CFG, "w", encoding="utf-8") as _fh:
                _json.dump({"project_root": root, "run_script": script}, _fh, indent=2)
        except Exception as _exc:  # noqa: BLE001
            return web.json_response({"ok": False, "error": str(_exc)}, status=500)
        return web.json_response({"ok": True})

    @_routes.post("/agent/start_host")
    async def _agent_start_host(request):  # noqa: ANN001
        """Launch run_agent.ps1 in a new console so the sidebar can start the host."""
        root, script = _read_host_cfg()
        if not root:
            return web.json_response(
                {"ok": False, "error": "agentY location unknown — run run_agent.ps1 once, "
                                       "or set the AGENTY_ROOT environment variable."}, status=409)
        script_path = _os.path.join(root, script)
        if not _os.path.isfile(script_path):
            return web.json_response({"ok": False, "error": f"{script} not found under {root}"}, status=404)
        if _sys.platform != "win32":
            return web.json_response(
                {"ok": False, "error": "auto-start is Windows-only; run the script manually."}, status=400)
        try:
            _CREATE_NEW_CONSOLE = 0x00000010
            _subprocess.Popen(
                ["powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", script_path],
                cwd=root, creationflags=_CREATE_NEW_CONSOLE, close_fds=True,
            )
        except Exception as _exc:  # noqa: BLE001
            return web.json_response({"ok": False, "error": str(_exc)}, status=500)
        return web.json_response({"ok": True, "root": root, "script": script})

    @_routes.post("/agent/pick_files")
    async def _agent_pick_files(request):  # noqa: ANN001
        """Open a native OS file/folder dialog on the ComfyUI host and return the
        chosen absolute paths — the backend picker for the agentY collector nodes.

        The browser can't read a file's real filesystem path, so the collector
        nodes call this instead: it launches ``_filepicker.py`` as a subprocess
        (a fresh Tk dialog per call, off the event loop) and returns true on-disk
        paths, no copying. ``kind`` is one of ``_PICK_KINDS`` — ``media`` (the
        merged collector: both filters in one dialog), or ``image``/``video`` for
        the older single-kind callers. ``mode`` picks files or a whole folder
        (a folder is expanded to the media matching ``kind`` here).
        """
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            data = {}
        kind = str((data or {}).get("kind", _PICK_DEFAULT_KIND)).lower()
        if kind not in _PICK_KINDS:
            kind = _PICK_DEFAULT_KIND
        mode = str((data or {}).get("mode", "files")).lower()
        if mode not in ("files", "folder"):
            mode = "files"
        if not _os.path.isfile(_PICKER):
            return web.json_response({"ok": False, "error": "picker helper missing"}, status=500)
        try:
            proc = await _asyncio.create_subprocess_exec(
                _sys.executable, _PICKER, kind, mode,
                stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.PIPE,
                cwd=_EXT_DIR,
            )
            out, _err = await proc.communicate()
        except Exception as _exc:  # noqa: BLE001
            return web.json_response({"ok": False, "error": str(_exc)}, status=500)
        raw = (out or b"").decode("utf-8", "replace").strip()
        try:
            parsed = _json.loads(raw) if raw else []
        except Exception:  # noqa: BLE001
            return web.json_response(
                {"ok": False, "error": f"picker returned unparseable output: {raw[:200]!r}"},
                status=500)
        # The helper emits {"error": ...} when Tk is unavailable, else a JSON list.
        if isinstance(parsed, dict) and parsed.get("error"):
            return web.json_response({"ok": False, "error": str(parsed["error"])}, status=500)
        paths = parsed if isinstance(parsed, list) else []
        if mode == "folder" and paths:
            exts = _PICK_KINDS[kind]
            folder = paths[0]
            expanded: list = []
            try:
                for name in sorted(_os.listdir(folder)):
                    full = _os.path.join(folder, name)
                    if _os.path.isfile(full) and name.rsplit(".", 1)[-1].lower() in exts:
                        expanded.append(full)
            except Exception:  # noqa: BLE001
                expanded = []
            paths = expanded
        paths = [p for p in paths if isinstance(p, str) and _os.path.isfile(p)]
        return web.json_response({"ok": True, "paths": paths, "kind": kind})

    @_routes.get("/agent/pm_item")
    async def _agent_pm_item(request):  # noqa: ANN001
        """What one project-memory entry holds: its text, and the file it names.

        Backs the ``agentY load item`` node's preview and the ``#`` menu in the
        collector. Both need to know a name's file BEFORE anything runs, which is
        the whole point of a store that lives on disk.
        """
        name = _pm_slug(request.query.get("name", ""))
        f = _pm_find(name)
        if f is None:
            return web.json_response({"ok": True, "name": name, "found": False,
                                      "text": "", "path": "", "kind": ""})
        try:
            body = f.read_text(encoding="utf-8").strip()
        except Exception as exc:  # noqa: BLE001
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        path = _pm_entry_path(body)
        ext = _os.path.splitext(path)[1].lower()
        kind = ("image" if ext in _COLLECT_IMG_EXTS
                else "video" if ext in _COLLECT_VID_EXTS else "")
        return web.json_response({"ok": True, "name": name, "found": True,
                                  "text": body, "path": path, "kind": kind,
                                  "type": f.parent.name})

    def _pm_names_blocking() -> list:
        """Walk the store: one directory listing, one read and up to two stats
        per entry."""
        d = _pm_dir()
        out = []
        if d is not None and d.is_dir():
            for f in sorted(d.glob("*/*.md")):
                if f.stem == "PROJECT":
                    continue
                try:
                    body = f.read_text(encoding="utf-8").strip()
                except Exception:  # noqa: BLE001
                    continue
                path = _pm_entry_path(body)
                first = next((ln.strip() for ln in body.splitlines() if ln.strip()), "")
                out.append({"name": f.stem, "type": f.parent.name,
                            "summary": first, "path": path})
        return out

    @_routes.get("/agent/pm_names")
    async def _agent_pm_names(request):  # noqa: ANN001
        """Every entry in the store, with the file each one names.

        One call, so the collector's ``#`` menu can offer remembered references
        without a request per name. Only entries that HAVE a file are useful there,
        but all are returned — the caller decides what it is listing.

        Off the event loop, because this is a keystroke-triggered walk of a
        directory that follows the project — and a project on a network share
        answers a stat in milliseconds, not microseconds. Done inline it is not
        this request that pays: aiohttp is single-threaded, so every OTHER
        request ComfyUI is serving waits behind it, which is the whole UI.
        """
        entries = await _asyncio.get_running_loop().run_in_executor(
            None, _pm_names_blocking)
        return web.json_response({"ok": True, "entries": entries})

    @_routes.get("/agent/pm_file")
    async def _agent_pm_file(request):  # noqa: ANN001
        """Serve the media a named entry points at, for the in-node preview.

        Keyed by NAME, never by path: the only files this can serve are the ones
        the project store already points at, so there is no path parameter for a
        caller to aim somewhere else.
        """
        name = _pm_slug(request.query.get("name", ""))
        f = _pm_find(name)
        if f is None:
            return web.json_response({"ok": False, "error": "no such entry"}, status=404)
        try:
            path = _pm_entry_path(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            path = ""
        if not path or not _os.path.isfile(path):
            return web.json_response({"ok": False, "error": "entry names no file"},
                                     status=404)
        return web.FileResponse(path)

    @_routes.post("/agent/reset_collector_cursor")
    async def _agent_reset_collector_cursor(request):  # noqa: ANN001
        """Reset a collector node's incremental-load cursor to the first file.

        Called by the collector frontend from a one-shot patch on the Queue button
        (``app.queuePrompt``), which fires exactly once per click — so a Queue with
        batch count > 1 resets the cursor once, then steps through the batch from
        the top. The cursor dict lives in this same module/process, so this mutates
        exactly what the node's ``execute`` reads."""
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            data = {}
        ids: list = []
        if isinstance(data, dict):
            if data.get("node_id") is not None:
                ids.append(data["node_id"])
            raw = data.get("node_ids")
            if isinstance(raw, list):
                ids.extend(raw)
        for nid in ids:
            _reset_incr_index(nid)  # defined later in this module; resolved at call time
        return web.json_response({"ok": True, "reset": [str(i) for i in ids]})

    # ── Canvas selection bridge ───────────────────────────────────────────────
    # Which nodes are selected — and what their widgets currently say — exists
    # only inside the browser (litegraph state, never serialized to the server).
    # The sidebar chat ships that snapshot along with each message, so the agentY
    # host sees it; anything *outside* the page — the agentY MCP server running
    # under Claude, a script — could not.
    #
    # These routes borrow the frontend as the source of truth: a request here
    # goes out over the ComfyUI websocket, ``web/agent_canvas.js`` answers it by
    # POSTing back to /agent/canvas_reply, and the pending request resolves with
    # that answer. Nothing is cached on purpose — a remembered selection is worse
    # than an honest "no browser answered", since the entire question is what is
    # selected *right now*. With several ComfyUI tabs open the first reply wins.
    _pending_replies: dict = {}   # req_id -> asyncio.Future awaiting the frontend
    _REPLY_TIMEOUT = 3.0          # seconds; a backgrounded tab still answers this fast

    async def _ask_frontend(event: str, payload: dict, timeout: float):
        """Broadcast ``event`` to every open ComfyUI page and wait for one reply.

        Returns the reply dict, or None if nobody answered in time (no page open,
        or an old extension build with no listener for this event)."""
        req_id = _uuid.uuid4().hex[:12]
        fut = _asyncio.get_running_loop().create_future()
        _pending_replies[req_id] = fut
        try:
            PromptServer.instance.send_sync(event, dict(payload, req_id=req_id))
            return await _asyncio.wait_for(fut, timeout)
        except _asyncio.TimeoutError:
            return None
        finally:
            _pending_replies.pop(req_id, None)

    def _clamp_timeout(request) -> float:  # noqa: ANN001
        try:
            return max(0.2, min(float(request.query.get("timeout", _REPLY_TIMEOUT)), 15.0))
        except (TypeError, ValueError):
            return _REPLY_TIMEOUT

    @_routes.post("/agent/canvas_reply")
    async def _agent_canvas_reply(request):  # noqa: ANN001
        """The frontend answering a pending /agent/canvas_* request."""
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
        fut = _pending_replies.get(str((data or {}).get("req_id", "")))
        if fut is None or fut.done():
            # Already answered by another tab, or the waiter timed out. Harmless.
            return web.json_response({"ok": True, "accepted": False})
        fut.set_result(data)
        return web.json_response({"ok": True, "accepted": True})

    @_routes.get("/agent/canvas_selection")
    async def _agent_canvas_selection(request):  # noqa: ANN001
        """Live read of the nodes selected on the canvas, with their widget values.

        Answers 200 with ``ok: false`` when no page replies — that is a state of
        the world (ComfyUI not open), not a server fault, and callers using a
        raise-on-status HTTP client need to read the reason."""
        reply = await _ask_frontend("agent.request_selection", {}, _clamp_timeout(request))
        if reply is None:
            return web.json_response({
                "ok": False, "nodes": [], "count": 0,
                "error": "no ComfyUI browser page answered — open ComfyUI in a browser "
                         "(a background tab is fine). If it is open, its agentY extension "
                         "is older than this route; reload the page.",
            })
        nodes = [n for n in (reply.get("nodes") or []) if isinstance(n, dict)]
        return web.json_response({"ok": True, "count": len(nodes), "nodes": nodes,
                                  "workflow": str(reply.get("workflow") or "")})

    @_routes.post("/agent/set_node_params")
    async def _agent_set_node_params(request):  # noqa: ANN001
        """Write widget values onto a node of the live graph (no reload, no re-queue).

        The counterpart to the read above: same websocket round trip, and the
        frontend reports back which widgets it actually found on the node."""
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
        node_id = str((data or {}).get("node_id", "")).strip()
        params = (data or {}).get("params")
        if not node_id:
            return web.json_response({"ok": False, "error": "node_id is required"}, status=400)
        if not isinstance(params, dict) or not params:
            return web.json_response(
                {"ok": False, "error": "params must be a non-empty {widget: value} mapping"},
                status=400)
        reply = await _ask_frontend("agent.set_node_params",
                                    {"node_id": node_id, "params": params},
                                    _clamp_timeout(request))
        if reply is None:
            return web.json_response({
                "ok": False, "applied": [],
                "error": "no ComfyUI browser page answered — nothing was changed.",
            })
        return web.json_response({
            "ok": bool(reply.get("ok", True)),
            "applied": [str(a) for a in (reply.get("applied") or [])],
            "unknown": [str(u) for u in (reply.get("unknown") or [])],
            "node": str(reply.get("node") or ""),
            "error": str(reply.get("error") or ""),
        })

    print("[agentY-comfyuiConnect] registered /agent routes "
          "(load_workflow, register_host, start_host, pick_files, reset_collector_cursor, "
          "canvas_selection, set_node_params)")
except Exception as _e:  # noqa: BLE001
    # Never break ComfyUI startup if the server API shape changes.
    print(f"[agentY-comfyuiConnect] could not register /agent routes: {_e}")


from comfy_api.latest import ComfyExtension, io

# Cap on how many anchor slots one hook can grow to. 20 is plenty for "combine
# these N inputs" while keeping the node from ballooning; ``min=0`` lets an
# unwired hook (a global directive or a text-to-media standin) stay valid.
_MAX_ANCHORS = 20


def _agent_placed() -> dict:
    """Schema kwargs for a node only the AGENT ever places.

    ``is_dev_only`` sets litegraph's ``skip_list``, which drops the node from the
    add-node menu and the double-click search while leaving it registered and
    fully runnable — so ``LiteGraph.createNode`` (how the panel drops an agentY
    text node) and a workflow that already contains one both keep working. Turn
    ComfyUI's **Enable dev mode options** setting on to get them back in search.

    Feature-detected: the field landed in early 2026, and passing an unknown
    kwarg to the Schema dataclass would take down the whole node pack — every
    agentY node, hook included — for a cosmetic tidy-up.
    """
    try:
        from dataclasses import fields as _fields
        if any(f.name == "is_dev_only" for f in _fields(io.Schema)):
            return {"is_dev_only": True}
    except Exception:  # noqa: BLE001
        pass
    return {}


class AgentYHook(io.ComfyNode):
    """An agent instruction attached to the canvas. Three purposes:

    * ``inline_parameter`` (default) — annotate an upstream node's output. Wire an
      ``anchor`` input from any node's output and type a directive (e.g. "create
      prompt variations", "sweep the seed 6×", "iterate the files in this
      folder"). When the agentY agent runs the on-canvas graph, it applies the
      directive to the anchored node(s) and runs the expanded batch.
    * ``make_workflow`` — the hook stands in for a workflow or Python script
      the agent generates from the ``directive`` field (used here as a prompt).
      The agent generates it, runs it (using the wired ``anchor`` output(s) as
      input if any are connected, else treating the prompt as text-to-media), and
      stages the result onto the canvas as loader nodes.
    * ``text`` — the hook asks the agent for a **written text answer** (no media,
      no workflow): the ``directive`` is the request (e.g. "write a caption for
      this image", "summarise the wired prompt"). The agent writes the answer and
      drops an ``agentY text`` node on the canvas carrying it, wired where this
      hook's output went — so downstream nodes (or the next hook stage) consume
      the string on a normal run. Any wired ``anchor`` is context for the answer.
    * ``general_request`` — a **free-form** instruction: the agent treats the
      ``directive`` as an ordinary request (with any wired ``anchor`` as the provided
      input/context and this graph already captured) and decides the right action
      itself — answer, generate or edit media, run a workflow, compute a value. Use
      it when the task doesn't fit the more specific purposes; media results stage
      onto the canvas, a single produced value goes to the wired target, and a plain
      question is answered in chat.
    * ``iterate`` — turns this graph into an **interactive refinement loop**: the
      agent runs it ONE generation per turn and feeds each result back in as the
      next input, so you refine an image step by step in chat. Wire this hook's
      **output into the prompt node's text input** (where each prompt you type in
      chat is written) and wire the **LoadImage node's image output into an
      anchor** (the node whose image the agent replaces with the running result).
      Each turn you give the next prompt; the agent runs the graph, updates that
      LoadImage in place, and asks for the next step. You can jump back to an
      earlier generation ("go back to the original", "back to generation 3, then …")
      and keep going until you say stop. Requires a save node that writes to
      ComfyUI's history (e.g. a SaveImage, or the bEpic viewer with
      ``save_to_output`` ON) so the agent can fetch each result to feed forward.
    * ``qa`` — this hook is not work, it is your **quality briefing** for the graph.
      The ``directive`` is the checklist ("skin tones warm, not orange"; "hands have
      five fingers") and the wired ``anchors`` are **reference / mood images** the
      output should sit beside without looking out of place. After a run, a separate
      QA agent judges every produced image/video against it, criterion by criterion,
      and a failing output is re-generated against exactly what it missed (bounded
      by ``qa.max_retries`` in agentY settings). Wiring the references here is what
      makes them references rather than inputs to the workflow — the anchor is the
      statement. Cite a shared briefing from ``config/qa/`` with ``@name``.
    * ``review`` — a deliberate **STOP** in the chain, so you can choose what goes
      on to the next stage. Place it between the stage that produces candidates
      (reference frames, start images) and the expensive stage that consumes them
      (a video). The stage before it runs; what it produced is gathered into an
      ``agentY image collector`` placed beside this hook and wired into its anchor;
      the run stops there and asks you.

      That collector is the ballot. **Edit it** — delete the rows you don't want,
      add files of your own, reorder them — then say ``continue`` in the panel (or
      press the action-bar button, which reads *Continue with these* while a run is
      halted) and the rest of the chain runs with exactly what is in it. ``stop``
      ends the run instead; nothing produced is deleted either way.

      Same shape as ``qa`` — produces nothing, never executed, sits in the same
      place in a chain. The difference is who judges: ``qa`` asks a model and
      carries on by itself, ``review`` stops and asks you.

      This is the one purpose with **no prompt**: a stop has nothing to instruct,
      so the ``directive`` box is hidden and an empty review hook is complete. If
      you want a particular question put to you, **title the node** ("pick two
      for the video") — the title travels with the hook and is what the agent
      asks. Untitled, it asks which outputs should go on.

    The ``anchor`` **input** auto-grows: each time you wire one, a new empty slot
    appears, so a single hook can gather several inputs (e.g. combine three images
    in a standin, or apply one directive across two anchor nodes). The single
    ``out`` **output** carries any type (image, video, string / int / float); a
    stage that yields several results forwards them all to the next hook via the
    agent, not via several slots.

    ``remember`` — one question: *should what this hook produced outlive the run?*
    OFF (default) means the agent does the work again next time. ON keeps it.

    What "keeping it" means follows the ``purpose``, because the purposes produce
    different things and there is only one sensible way to keep each. It is not a
    second decision you make, which is why the switch is *labelled* differently:

    * **make_workflow** — labelled **bake**. What this produced is a workflow, so
      keeping it means nesting it into a ComfyUI **subgraph** whose inputs/outputs
      match this hook's slots, dropped onto the same canvas beside the hook and
      wired to mirror the hook chain. The files that run produced are recorded
      too, so re-opening the graph re-uses them instead of re-rendering.
    * **everything else** — labelled **memorize**. What this produced is a result
      — a written value, a prompt, a script, images, videos — so keeping it means
      writing it to ``agent/memory/`` beside the outputs and putting it straight
      back next time, until something feeding this hook changes.

    The hook itself is never rewired either way. ``freeze`` used to bake a text
    hook's value into its target input and take over the hook's downstream link;
    it doesn't any more. The hook chain is the graph's readable statement of what
    happens, and a switch about keeping a *result* has no business rewriting it.

    You can flip it **in hindsight**. What a hook produced is journalled whether
    or not the switch was on, so turning it on after a run you liked keeps that
    run's result — you rarely know something was worth keeping until you have
    looked at it. Turning it off is still the forget gesture: off, send anything,
    on again.

    This was three switches (``bake_to_canvas``, ``freeze``, ``memorize``), then
    two. They were always one question asked several ways. Saved graphs migrate on
    load (see ``web/agent_hook.js``); a hook with whichever of them its purpose
    read comes back with ``remember`` on.

    It is hidden on ``qa``, ``review`` and ``iterate``, which produce nothing to
    keep.

    To disable a hook without deleting it, **bypass it** (Ctrl+B) or mute it
    (Ctrl+M) like any other node — the agent skips hooks in those modes. There is
    no separate ``ignore`` toggle: one gesture, the standard ComfyUI one, and it
    reads off the canvas at a glance.

    On a normal ComfyUI Queue the node is always inert: it's an identity
    passthrough that nothing downstream needs, so it is never executed.
    Recommended usage: wire only the ``anchor`` inputs and leave the output
    unwired (the node is then pruned entirely on a normal run). Splicing it inline
    also works — the agent removes it from the graph before running, and the
    ``out`` output forwards the first connected anchor.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        anchors = io.Autogrow.TemplatePrefix(
            input=io.AnyType.Input("anchor"),
            prefix="anchor",
            min=0,
            max=_MAX_ANCHORS,
        )
        return io.Schema(
            node_id="AgentYHook",
            display_name="agentY hook",
            category="agentY",
            description=(
                "Attach an agent instruction to the canvas. As an 'inline_parameter' it annotates a "
                "node's output; as a 'make_workflow' it stands in for a workflow/script "
                "the agent generates from the prompt; as 'text' it asks for a written answer "
                "the agent drops on the canvas as a wireable 'agentY text' node. The 'anchor' "
                "input auto-grows, so one hook can gather several inputs. Bypass (Ctrl+B) or "
                "mute it to disable it. Inert on a normal run; acted on by the agentY agent "
                "when it runs the graph."
            ),
            inputs=[
                io.String.Input(
                    "directive",
                    multiline=True,
                    default="",
                    placeholder=(
                        "inline_parameter: e.g. sweep the seed, 6 variations  •  "
                        "make_workflow: e.g. upscale 2x and add film grain  •  "
                        "text: e.g. write a caption for this image"
                    ),
                ),
                io.Combo.Input(
                    "purpose",
                    options=["inline_parameter", "make_workflow", "text", "general_request",
                             "iterate", "qa", "review"],
                    default="inline_parameter",
                ),
                io.Boolean.Input(
                    "remember",
                    default=False,
                    label_on="memorize result",
                    label_off="run every time",
                    tooltip=(
                        "Should what this hook produced outlive the run? OFF (default) has "
                        "the agent work it out again next time. ON keeps it — everything it "
                        "produced: written values and prompts, scripts, images and videos "
                        "(by path). It goes into 'agent/memory/' next to the outputs, and "
                        "comes straight back on later runs instead of being paid for twice. "
                        "It is released the moment anything feeding this hook changes (a "
                        "different image, a rewire, an upstream edit, an edited prompt), and "
                        "switching this OFF releases it too — which is how you force a fresh "
                        "result. You can also turn it on AFTER a run you liked: what the "
                        "hook produced is written down either way, so the switch works in "
                        "hindsight. On a make_workflow hook this reads 'bake into subgraph' "
                        "instead: what that hook produced is a workflow, so keeping it means "
                        "nesting it into a subgraph beside the hook (its outputs are kept "
                        "too). Hidden on qa, review and iterate, which produce nothing "
                        "to keep."
                    ),
                ),
                io.Autogrow.Input("anchors", template=anchors),
            ],
            outputs=[
                # A single type-agnostic output. Wire it to the next hook's anchor
                # to chain stages; the link marks the dependency. A stage that
                # produces SEVERAL results doesn't need several slots — the agent
                # forwards every produced file/value to the next stage from the
                # run_workflow_now result, and a baked subgraph's output count comes
                # from the agent's exposed-outputs spec, not from this slot.
                io.AnyType.Output(display_name="out"),
            ],
        )

    @classmethod
    def execute(cls, directive="", purpose="inline_parameter",
                remember=False, anchors=None, **_legacy) -> io.NodeOutput:  # noqa: ANN001, ARG003
        # ``**_legacy`` swallows `bake` / `memorize` / `freeze` from a graph saved
        # before the merge: the widgets migrate on load, but a prompt submitted
        # from an un-migrated source must not fail validation over a dead switch.
        #
        # Pure identity passthrough — only ever runs if spliced inline, in which
        # case it must not alter the data flowing through it. With several anchors
        # wired, forward the first connected one (lowest slot index).
        anchors = anchors or {}
        first = next(iter(anchors.values()), None)
        return io.NodeOutput(first)


# Number of (fixed) output slots on the Python node. Executable nodes can't
# auto-grow outputs (the count is fixed at registration), so we declare a small
# set of any-type outs; a snippet typically fills just out0.
_N_PY_OUT = 4


class AgentYPython(io.ComfyNode):
    """Run an agent-authored Python snippet as a real ComfyUI node.

    This is the companion to a hook's ``bake`` switch: at runtime the orchestrator
    computes derived values (e.g. a video's length) with a Python script; to make
    such a value a **native** output of a baked subgraph — so re-running the
    workflow reproduces it *without the agent* — the same snippet is placed in this
    node. The bake step wires the relevant inner outputs into this node's inputs
    and exposes its output as a subgraph output.

    Contract: the ``in`` input auto-grows (in0, in1, … — any type). The snippet
    runs with those bound as ``in0``, ``in1``, … and as a list ``inputs``; assign
    a list named ``outputs`` (``outputs[0]`` → this node's first output slot, etc.).

    A snippet reads a slot by its own NAME: wire in0 and in2 and you get ``in0``
    and ``in2``, not ``in0`` and ``in1``. (``inputs`` is the positional list of
    whatever is actually wired, so ``inputs[1]`` there is in2's value.)

    Note for anything WRITING one of these into a graph: the slot is addressed as
    ``inputs.in0``, not ``in0`` — the autogrow container is called ``inputs`` and
    its template prefix is ``in``, exactly as the hook's anchors are
    ``anchors.anchor0``. A bare ``in0`` does not match the schema; it is accepted
    at run time so old graphs still work, but it is not the name to write.

    SECURITY: this executes arbitrary Python embedded in the workflow whenever the
    graph runs. It is intended for your own, self-hosted, agent-built workflows —
    do NOT run baked workflows from untrusted sources. Set the env var
    ``AGENTY_PYTHON_NODE_DISABLED=1`` to make the node a no-op (returns Nones).
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        ins = io.Autogrow.TemplatePrefix(
            input=io.AnyType.Input("in"), prefix="in", min=0, max=_MAX_ANCHORS,
        )
        return io.Schema(
            node_id="AgentYPython",
            display_name="agentY python",
            category="agentY",
            **_agent_placed(),   # the bake step places these; you don't add them by hand
            description=(
                "Run an agent-authored Python snippet as a node (used when baking computed "
                "values into subgraphs). Inputs bind as in0, in1, …; set a list `outputs`. "
                "Executes arbitrary Python on run — self-hosted, agent-built workflows only."
            ),
            inputs=[
                io.String.Input(
                    "code",
                    multiline=True,
                    default="# inputs bound as in0, in1, …  |  set: outputs = [value, …]\noutputs = []",
                    placeholder="outputs = [ ... ]",
                ),
                io.Autogrow.Input("inputs", template=ins),
            ],
            outputs=[io.AnyType.Output(display_name=f"out{i}") for i in range(_N_PY_OUT)],
        )

    @classmethod
    def execute(cls, code="", inputs=None, **extra) -> io.NodeOutput:  # noqa: ANN001
        import os
        import re
        import builtins
        if os.environ.get("AGENTY_PYTHON_NODE_DISABLED") in ("1", "true", "True"):
            return io.NodeOutput(*([None] * _N_PY_OUT))
        # An autogrow container arrives as one dict — {"in0": …} under `inputs`,
        # addressed in the prompt as `inputs.in0`. A graph that names the slot
        # bare (`in0`) instead does not match the schema, so ComfyUI hands it
        # through as a loose keyword and the call used to die with "unexpected
        # keyword argument 'in0'". Both are accepted: the graph that produced one
        # of those is already saved on someone's canvas, and refusing to run it
        # teaches them nothing they can act on.
        bound: dict = dict(inputs or {})
        for key, value in (extra or {}).items():
            if re.fullmatch(r"in\d+", str(key)):
                bound.setdefault(str(key), value)

        # Bind by SLOT NAME, not by position. Wiring in0 and in2 used to bind in2's
        # value to `in1` — the values were collapsed in order, so a gap silently
        # renumbered everything after it and the snippet read the wrong input.
        # `inputs` stays the positional list of what is actually wired.
        def _idx(name: str) -> int:
            return int(str(name)[2:] or 0)

        ordered = sorted(bound.items(), key=lambda kv: _idx(kv[0]))
        ns: dict = {"__builtins__": builtins,
                    "inputs": [v for _k, v in ordered], "outputs": []}
        for name, value in ordered:
            ns[str(name)] = value
        try:
            exec(code or "", ns)  # noqa: S102 — deliberate; see SECURITY note above
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"AgentYPython snippet error: {exc}") from exc
        outs = ns.get("outputs")
        outs = list(outs) if isinstance(outs, (list, tuple)) else [outs]
        outs = outs[:_N_PY_OUT] + [None] * (_N_PY_OUT - len(outs))
        return io.NodeOutput(*outs)


class AgentYText(io.ComfyNode):
    """A string the agent wrote, living on the canvas as a wireable node.

    Companion to ``AgentYHook``'s ``text`` purpose: when the agent answers a text
    hook, it places one of these carrying the answer and wires its ``STRING``
    output where the hook's output went, so downstream nodes (or the next hook
    stage) consume the string on a normal run — the value is baked into the graph
    and reproduced without the agent. Its ``text`` widget is a plain multiline
    string the user can also edit by hand.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYText",
            display_name="agentY text",
            category="agentY",
            **_agent_placed(),   # place_canvas_text drops these; you don't add them by hand
            description=(
                "A string the agent wrote (answering a 'text' hook), wireable into any "
                "STRING input. Editable by hand; emits its text on a normal run."
            ),
            inputs=[
                io.String.Input("text", multiline=True, default=""),
            ],
            outputs=[
                io.String.Output(display_name="text"),
            ],
        )

    @classmethod
    def execute(cls, text="") -> io.NodeOutput:  # noqa: ANN001
        return io.NodeOutput(text)


# ── file collector nodes ──────────────────────────────────────────────────────
# Two nodes that gather files from disk (via the native picker, /agent/pick_files)
# into a single node. The collected list is stored as the ``files`` widget — plain
# node data serialized into the workflow — so the agentY agent can read every path
# BEFORE any run (unlike a runtime IMAGE batch tensor, which only exists after
# execution). That's what makes a batch of inputs understandable to the agent with
# no pre-run. The nodes double as ordinary input nodes: the image collector emits a
# stacked IMAGE batch, the video collector a list of VIDEOs, plus a paths STRING.

_COLLECT_IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff")
_COLLECT_VID_EXTS = (".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg")
# One node collects both kinds now, so one list decides what a picked or
# pasted path is allowed to be.
_COLLECT_MEDIA_EXTS = _COLLECT_IMG_EXTS + _COLLECT_VID_EXTS


def _collector_paths(files: str, exts: tuple) -> list[str]:
    """Parse the ``files`` widget (one absolute path per line) into an ordered,
    de-duplicated list of existing files of the wanted kind."""
    out: list[str] = []
    seen: set = set()
    for line in (files or "").splitlines():
        p = line.strip().strip('"')
        if not p or p in seen:
            continue
        seen.add(p)
        if exts and not p.lower().endswith(exts):
            continue
        if _os.path.isfile(p):
            out.append(p)
    return out


# ── incremental-load cursor ───────────────────────────────────────────────────
# When a collector's ``load_incrementally`` toggle is ON it emits only ONE file
# per Queue Prompt, stepping through the list. The cursor is kept here, keyed by
# the node's canvas ``unique_id``, and advanced once per execution. It lives in
# memory only (an "internal counter"): it resets on a ComfyUI restart, and a
# normal (non-incremental) run of the same node clears it so the next incremental
# session starts from the first file again.
_COLLECTOR_INCR_INDEX: dict[str, int] = {}


def _incr_index(node_id, count: int) -> int:
    """Return the current 0-based cursor for *node_id* (wrapping at *count*), then
    advance it by one. ``count <= 0`` yields 0."""
    if count <= 0:
        return 0
    key = str(node_id)
    cur = _COLLECTOR_INCR_INDEX.get(key, 0) % count
    _COLLECTOR_INCR_INDEX[key] = cur + 1
    return cur


def _reset_incr_index(node_id) -> None:
    """Forget a node's cursor — called on a non-incremental run, and by the
    ``/agent/reset_collector_cursor`` route when the reset toggle is armed."""
    _COLLECTOR_INCR_INDEX.pop(str(node_id), None)


def _uid(cls) -> str | None:
    """The collector node's canvas unique_id (declared as a hidden input), or None."""
    h = getattr(cls, "hidden", None)
    return getattr(h, "unique_id", None) if h is not None else None


def _collector_progress(node_id, msg: str) -> None:
    """Best-effort node status text (e.g. "3/12 photo.png") for the incremental
    cursor. No-op if the PromptServer isn't importable."""
    if not node_id:
        return
    try:
        from server import PromptServer
        PromptServer.instance.send_progress_text(msg, node_id)
    except Exception:  # noqa: BLE001
        pass


def _load_incrementally_input(kind: str):
    """The shared ``load_incrementally`` toggle for the collector nodes."""
    return io.Boolean.Input(
        "load_incrementally",
        default=False,
        label_on="one per queue",
        label_off="all at once",
        tooltip=(
            f"OFF (default): emit every collected {kind} on each run. ON: emit just "
            f"one {kind} per Queue Prompt, advancing an internal cursor each queue so "
            "repeated queues (or a batch count) step through the list one at a time. "
            "The cursor wraps at the end; a normal (all-at-once) run resets it to the "
            "first file. Does not affect what the agentY agent sees — it always reads "
            "the full path list."
        ),
    )


def _apply_incremental(cls, paths: list, load_incrementally: bool) -> list:
    """In incremental mode, narrow *paths* to the single file at the node's current
    cursor (then advance it) and post a "N/total name" status. Otherwise clear the
    cursor and return *paths* unchanged."""
    node_id = _uid(cls)
    if load_incrementally and paths:
        idx = _incr_index(node_id, len(paths))
        chosen = paths[idx]
        _collector_progress(node_id, f"{idx + 1}/{len(paths)}\n{_os.path.basename(chosen)}")
        return [chosen]
    _reset_incr_index(node_id)
    return paths


class AgentYImageCollector(io.ComfyNode):
    """Gather media files from disk into one node — an agent-friendly input set.

    Click **Add files…** (or **Add folder…**) to open a native OS dialog and pick
    images and/or videos from anywhere on disk; the absolute paths accumulate in
    the ``files`` box (one per line — editable and pasteable by hand). Because that
    list is node data, the agentY agent sees every file the moment the collector is
    wired to an ``agentY hook`` — no Queue Prompt needed. Typing ``#`` in the box
    offers the tags on this canvas and the references remembered for the project,
    and drops the file's path in.

    **Both kinds, one node.** Images come out of ``images`` as a stacked ``IMAGE``
    batch (every frame uniformly scaled to cover a max(width) x max(height) canvas
    and centre-cropped — aspect ratio preserved, never distorted); videos come out
    of ``videos`` as a list of ``VIDEO`` objects; ``paths`` carries the whole list
    as text. Wire whichever you need — a set of images leaves ``videos`` empty, and
    the other way round.

    That is also why this was ever two nodes: the two output TYPES are genuinely
    different (a stacked tensor vs a list of video objects) and ComfyUI fixes a
    node's output types at registration, so no single output could have been both.
    Carrying both outputs costs one slot and settles it.

    Toggle **load_incrementally** to emit just ONE file per Queue Prompt instead of
    the whole batch, stepping through the list on successive queues (see the
    toggle's tooltip).
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYImageCollector",
            display_name="agentY collector",
            category="agentY",
            search_aliases=["agentY image collector", "agentY video collector",
                            "agentY media collector"],
            description=(
                "Collect image and/or video files from disk (native picker) into one "
                "node. The path list is node data, so the agentY agent can read every "
                "file with no pre-run when the node is wired to an agentY hook. Emits a "
                "stacked IMAGE batch, a list of VIDEO objects, and a paths string (or "
                "one file per queue when load_incrementally is on)."
            ),
            inputs=[
                io.String.Input(
                    "files",
                    multiline=True,
                    default="",
                    placeholder="one absolute path per line — 'Add files...' to pick, or # for a tag",
                ),
                _load_incrementally_input("file"),
            ],
            outputs=[
                io.Image.Output(display_name="images"),
                io.Video.Output(display_name="videos", is_output_list=True),
                io.String.Output(display_name="paths"),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, files="", load_incrementally=False):  # noqa: ANN001, N805
        # Incremental mode must re-run on every queue so the cursor advances — NaN
        # is never equal to itself, so ComfyUI always re-executes. Otherwise fall
        # back to ordinary content caching (re-run only when the path list changes).
        return float("nan") if load_incrementally else files

    @classmethod
    def execute(cls, files="", load_incrementally=False) -> io.NodeOutput:  # noqa: ANN001
        paths = _collector_paths(files, _COLLECT_MEDIA_EXTS)
        paths = _apply_incremental(cls, paths, load_incrementally)
        images = [p for p in paths if p.lower().endswith(_COLLECT_IMG_EXTS)]
        videos = [p for p in paths if p.lower().endswith(_COLLECT_VID_EXTS)]
        return io.NodeOutput(_stack_images(images), _load_videos(videos),
                             "\n".join(paths))


def _stack_images(paths: list):
    """Load *paths* into one ComfyUI IMAGE batch.

    A batch needs a uniform H x W, so the canvas is max(width) x max(height) across
    the set and each frame is scaled UNIFORMLY to cover it and centre-cropped —
    aspect ratio is always preserved (never stretched) and the cropping absorbs the
    mismatch. ``ImageOps.fit`` does exactly this cover+crop.
    """
    import numpy as np
    import torch
    from PIL import Image as _PILImage, ImageOps as _ImageOps

    loaded: list = []
    for p in paths:
        try:
            im = _PILImage.open(p)
            loaded.append(_ImageOps.exif_transpose(im).convert("RGB"))
        except Exception as exc:  # noqa: BLE001
            print(f"[agentY collector] skipping {p}: {exc}")
    if not loaded:
        # No images — a 1x64x64 black frame keeps a normal run from crashing, and
        # is what a video-only collector hands to an IMAGE slot nobody wired.
        return torch.zeros((1, 64, 64, 3), dtype=torch.float32)
    canvas_w = max(im.width for im in loaded)
    canvas_h = max(im.height for im in loaded)
    arrs = [
        np.asarray(
            _ImageOps.fit(im, (canvas_w, canvas_h),
                          method=_PILImage.LANCZOS, centering=(0.5, 0.5)),
            dtype=np.float32,
        ) / 255.0
        for im in loaded
    ]
    return torch.from_numpy(np.stack(arrs, axis=0))


def _load_videos(paths: list) -> list:
    """Load *paths* into a list of ComfyUI VIDEO objects (empty when there are none)."""
    videos: list = []
    if not paths:
        return videos
    try:
        from comfy_api.latest import VideoFromFile
    except Exception as exc:  # noqa: BLE001
        print(f"[agentY collector] VIDEO type unavailable ({exc}); paths only")
        return videos
    for p in paths:
        try:
            videos.append(VideoFromFile(p))
        except Exception as exc:  # noqa: BLE001
            print(f"[agentY collector] could not load {p}: {exc}")
    return videos


class AgentYVideoCollector(io.ComfyNode):
    """The old video-only collector. Superseded by ``agentY collector``.

    Kept registered, and ONLY for that reason: this class id is written into every
    workflow that ever used one, and dropping it would open those graphs with a
    missing node. It behaves exactly as it always did. New graphs get the merged
    collector, which takes video as well.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYVideoCollector",
            display_name="agentY video collector (old)",
            category="agentY",
            is_deprecated=True,
            description=(
                "Superseded by 'agentY collector', which collects video as well. Kept "
                "so saved workflows still open; use the merged node for new graphs."
            ),
            inputs=[
                io.String.Input(
                    "files",
                    multiline=True,
                    default="",
                    placeholder="one absolute video path per line — use 'Add videos...' to pick",
                ),
                _load_incrementally_input("video"),
            ],
            outputs=[
                io.Video.Output(display_name="videos", is_output_list=True),
                io.String.Output(display_name="paths"),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, files="", load_incrementally=False):  # noqa: ANN001, N805
        return float("nan") if load_incrementally else files

    @classmethod
    def execute(cls, files="", load_incrementally=False) -> io.NodeOutput:  # noqa: ANN001
        paths = _collector_paths(files, _COLLECT_VID_EXTS)
        paths = _apply_incremental(cls, paths, load_incrementally)
        return io.NodeOutput(_load_videos(paths), "\n".join(paths))


# ── per-project memory ────────────────────────────────────────────────────────
# The store is a folder inside ComfyUI's user directory: one fact per file, the
# type is the folder, the name is the filename. The agentY host reaches the same
# folder by asking the running server where its user directory is, so a project
# switch (which moves --user-directory, along with input/output) moves the memory
# with it. These two nodes are the graph's way in — a graph can read a locked
# character prompt, or record one, with no agent in the loop at all.
_PM_PARTS = ("agentY", "project")
_PM_TYPES = ["technical", "character", "style", "reference", "note"]


def _pm_dir(create: bool = False):
    """The project store under ComfyUI's user directory, or None if unavailable."""
    try:
        import folder_paths
        d = _Path(folder_paths.get_user_directory()).joinpath(*_PM_PARTS)
    except Exception:  # noqa: BLE001
        return None
    if create:
        try:
            d.mkdir(parents=True, exist_ok=True)
        except Exception:  # noqa: BLE001
            return None
    return d


def _pm_slug(name: str) -> str:
    """Same normalisation the host uses, so both sides agree on what a name is."""
    return _re.sub(r"[^a-z0-9]+", "-", str(name or "").strip().lower()).strip("-")


def _pm_find(key: str):
    """Path of the entry named *key*, whatever type it was filed under."""
    d = _pm_dir()
    if d is None or not d.is_dir() or not key:
        return None
    for f in sorted(d.glob("*/*.md")):
        if f.stem == key:
            return f
    return None


# ---------------------------------------------------------------------------
# Remembering tags on a run
# ---------------------------------------------------------------------------
# An `agentY add tag` node with `remember` on writes its reference into this
# project's memory. The agentY host already does that on every turn it sees a
# canvas (src/utils/tag_memory.py), which covers asking for it in chat with
# nothing running. It cannot cover a plain Queue Prompt: the host is not in that
# loop at all. So the same write happens here too, and the three ways of asking
# — say it in chat, ComfyUI's Queue button, the panel's run button — all land in
# the same file.
#
# Hooked on the QUEUE rather than in the node's execute() for two reasons:
# execute() is cached, so an unchanged graph run twice runs the node once; and a
# tag node that is not on the path to an output never executes at all. The queue
# sees every submission, and the whole graph.
#
# The entry format is the host's, and the two have to agree — this side WRITES
# what /agent/pm_item and the host's remembered_reference() READ. Keep it in step
# with src/utils/tag_memory.py in the agentY repo, which names this file back.
_TAG_NOTE_CLASS = "AgentYRefNote"
_TAG_NOTE_TYPE = "reference"
_TAG_PATH_PREFIX = "path: "
_TAG_ORIGIN = "Remembered from the `agentY add tag` node tagged `#{tag}` on a canvas."
# Values a Boolean widget can arrive as when it means "off" — the prompt carries
# whatever JSON the frontend serialized, not a Python bool.
_TAG_OFF = ("", "0", "false", "none", "no", "off")
_TAG_STRIP = _re.compile(r"[^A-Za-z0-9_\-]+")
# Bounded, nearest-first, so a tag sitting behind a resize or a switch still
# resolves without reaching across the graph and adopting an unrelated image.
_TAG_SEARCH_HOPS = 6


def _tag_normalise(raw) -> str:
    """``"#hero face"`` → ``"hero_face"`` — the host's rule, and agent_tags.js's."""
    return _TAG_STRIP.sub("_", str(raw or "").strip().lstrip("#")).strip("_")


def _tag_file_of(node: dict) -> str:
    """The media file a node names in a scalar widget, or "".

    Scalars only — a link is a wire, not a file — and media suffixes only, so a
    seed, a sampler name or a prompt is never mistaken for a reference.
    """
    for value in (node.get("inputs") or {}).values():
        if not isinstance(value, str):
            continue
        parts = value.replace("\\", "/").rsplit("/", 1)[-1].rsplit(".", 1)
        if len(parts) == 2 and ("." + parts[1].lower()) in _COLLECT_MEDIA_EXTS:
            return value
    return ""


def _tag_file_upstream(prompt: dict, start_id: str) -> str:
    """The nearest file up the wire from *start_id*, or ""."""
    seen, frontier, hops = {str(start_id)}, [str(start_id)], 0
    while frontier and hops <= _TAG_SEARCH_HOPS:
        nxt = []
        for nid in frontier:
            node = prompt.get(nid)
            if not isinstance(node, dict):
                continue
            hit = _tag_file_of(node)
            if hit:
                return hit
            for value in (node.get("inputs") or {}).values():
                if isinstance(value, list) and value and str(value[0]) not in seen:
                    seen.add(str(value[0]))
                    nxt.append(str(value[0]))
        frontier, hops = nxt, hops + 1
    return ""


def _tag_stored_path(path: str) -> str:
    """The path as stored: FULL wherever one can be worked out.

    A bare filename is resolved against the input dir, because that is where
    ComfyUI means it. Anything unresolvable is kept exactly as given rather than
    guessed at.
    """
    raw = str(path or "").strip().strip('"')
    if not raw:
        return ""
    p = _Path(raw)
    if p.is_absolute():
        return str(p).replace("\\", "/")
    try:
        import folder_paths
        cand = _Path(folder_paths.get_input_directory()) / raw
        if cand.is_file():
            return str(cand).replace("\\", "/")
    except Exception:  # noqa: BLE001
        pass
    return raw.replace("\\", "/")


def _pm_write(name: str, body: str, type: str = _TAG_NOTE_TYPE) -> bool:
    """Store one entry, replacing any of the same name — the host's write_entry.

    PROJECT.md is deliberately NOT regenerated here. It is a browsable rendering
    of these files that nothing reads back, and the host rewrites it on its next
    turn; duplicating how it is rendered would be one more thing free to drift.
    """
    key, text = _pm_slug(name), str(body or "").strip()
    if not key or not text:
        return False
    d = _pm_dir(create=True)
    if d is None:
        return False
    existing = _pm_find(key)
    target = d / (_pm_slug(type) or _TAG_NOTE_TYPE) / f"{key}.md"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text + "\n", encoding="utf-8")
        # A name re-filed under a different type moves, rather than leaving a
        # second copy behind to contradict this one later.
        if existing is not None and existing != target:
            existing.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        return False
    return True


def _remember_tags(prompt) -> list:
    """Write every `remember`-switched tag on this graph into project memory."""
    if not isinstance(prompt, dict) or not prompt:
        return []
    written = []
    for nid, node in prompt.items():
        if not isinstance(node, dict) or node.get("class_type") != _TAG_NOTE_CLASS:
            continue
        inputs = node.get("inputs") or {}
        if str(inputs.get("remember", "")).strip().lower() in _TAG_OFF:
            continue
        tag = _tag_normalise(inputs.get("tag"))
        if not tag:
            continue
        file_path = _tag_file_upstream(prompt, str(nid))
        if not file_path:
            continue
        role = str(inputs.get("role") or "").strip()
        base = _os.path.basename(file_path.replace("\\", "/"))
        body = "\n".join([
            role or f"Reference image `{base}`.",
            _TAG_PATH_PREFIX + _tag_stored_path(file_path),
            _TAG_ORIGIN.format(tag=tag),
        ])
        if _pm_write(tag, body):
            written.append(tag)
    return written


def _install_queue_tag_hook() -> None:
    """Remember tags off every queued prompt, whoever queued it.

    ComfyUI's Queue button, the agentY panel's run button and the agent's own
    submissions all end at ``PromptQueue.put``, so one wrapper covers every way a
    run can start. Wrapped rather than replaced, and every failure swallowed: a
    convenience must never be able to stop a render being queued.
    """
    try:
        from server import PromptServer
        queue = PromptServer.instance.prompt_queue
    except Exception:  # noqa: BLE001
        return
    if getattr(queue.put, "_agenty_tags", False):
        return                      # already wrapped; custom nodes can reload
    original = queue.put

    def put(item, *args, **kwargs):
        try:
            # (number, prompt_id, prompt, extra_data, outputs, [sensitive]) —
            # the width has changed across ComfyUI versions, the prompt's
            # position has not.
            prompt = item[2] if isinstance(item, (list, tuple)) and len(item) > 2 else None
            done = _remember_tags(prompt) if isinstance(prompt, dict) else []
            if done:
                print("[agentY] remembered tag(s) -> project memory: "
                      + ", ".join("#" + t for t in done))
        except Exception:  # noqa: BLE001
            pass
        return original(item, *args, **kwargs)

    put._agenty_tags = True
    queue.put = put


_install_queue_tag_hook()


class AgentYProjectMemoryGet(io.ComfyNode):
    """Read a fact from this project's memory into the graph, as a string.

    The project's memory holds what the production has established — a character's
    prompt, the grade, a delivery spec — beside the project rather than in a chat
    log, so it survives across conversations and switches when the project does.
    This node wires one entry into any STRING input (a prompt, a note field) so the
    graph runs with the project's own words and no agent involvement.

    ``key`` is the entry name as the agent stored it ("hero", "grade"); spacing and
    capitalisation don't matter. A missing entry yields ``fallback`` rather than an
    error, so a graph shared between projects still runs where the fact is absent.

    Editing the file on disk changes the value on the next run: the node fingerprints
    the file's modification time, so ComfyUI re-reads it instead of serving the value
    it happened to cache the first time.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYProjectMemoryGet",
            display_name="agentY project memory (get)",
            category="agentY",
            description=(
                "Read one entry from this project's memory as a STRING (character "
                "prompt, style guide, delivery spec). Switches with the project."
            ),
            inputs=[
                io.String.Input("key", default="", placeholder="hero"),
                io.String.Input("fallback", multiline=True, default="",
                                tooltip="Used when this project has no such entry."),
            ],
            outputs=[io.String.Output(display_name="text")],
        )

    @classmethod
    def fingerprint_inputs(cls, key="", fallback=""):  # noqa: ANN001, ARG003
        # Without this the first value read would be cached for the life of the
        # process and hand-edits to the file would never reach the graph.
        f = _pm_find(_pm_slug(key))
        try:
            return f"{f}:{f.stat().st_mtime_ns}" if f else f"missing:{key}:{fallback}"
        except Exception:  # noqa: BLE001
            return f"unreadable:{key}"

    @classmethod
    def execute(cls, key="", fallback="") -> io.NodeOutput:  # noqa: ANN001
        f = _pm_find(_pm_slug(key))
        if f is None:
            return io.NodeOutput(fallback)
        try:
            return io.NodeOutput(f.read_text(encoding="utf-8", errors="replace").strip())
        except Exception:  # noqa: BLE001
            return io.NodeOutput(fallback)


class AgentYProjectMemorySet(io.ComfyNode):
    """Record a fact into this project's memory from the graph.

    For the thing worth keeping once a graph has produced it: the prompt that
    finally worked, the path of the frame chosen as the locked reference. Writing
    the same ``key`` again REPLACES the entry, so a graph that runs a hundred times
    leaves one fact, not a hundred — but note that it writes on EVERY run, so wire
    it where that is what you want.

    ``lock`` protects an entry that has been settled: with it on, an existing entry
    of the same name is left alone and this run passes the stored value through
    unchanged, so re-running the graph can't quietly overwrite the reference the
    rest of the project is matching.

    The ``value`` is passed straight through, so this can sit inline on a wire.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYProjectMemorySet",
            display_name="agentY project memory (set)",
            category="agentY",
            description=(
                "Record one entry into this project's memory (replacing any entry of "
                "the same name) and pass the value through. Switches with the project."
            ),
            inputs=[
                io.String.Input("key", default="", placeholder="hero"),
                io.String.Input("value", multiline=True, default=""),
                io.Combo.Input("type", options=_PM_TYPES, default="note"),
                io.Boolean.Input(
                    "lock", default=False, label_on="keep existing", label_off="overwrite",
                    tooltip=("ON: if this project already has an entry by this name, keep "
                             "it and pass the STORED value through instead of writing."),
                ),
            ],
            outputs=[io.String.Output(display_name="text")],
        )

    @classmethod
    def execute(cls, key="", value="", type="note", lock=False) -> io.NodeOutput:  # noqa: ANN001, A002
        slug, body = _pm_slug(key), str(value or "").strip()
        existing = _pm_find(slug)
        if lock and existing is not None:
            try:
                return io.NodeOutput(existing.read_text(encoding="utf-8", errors="replace").strip())
            except Exception:  # noqa: BLE001
                return io.NodeOutput(body)
        if not slug or not body:
            return io.NodeOutput(body)
        d = _pm_dir(create=True)
        if d is None:
            print("[agentY project memory] no ComfyUI user directory — nothing stored")
            return io.NodeOutput(body)
        folder = _pm_slug(type) or "note"
        target = d / folder / f"{slug}.md"
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body + "\n", encoding="utf-8")
            # Re-filing under a different type must not leave the old copy behind
            # to answer with the old fact.
            if existing is not None and existing != target:
                existing.unlink(missing_ok=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[agentY project memory] could not write {target}: {exc}")
        return io.NodeOutput(body)


# Where a remembered reference keeps its file. `tag_memory.entry_body` on the host
# writes this line, and both sides have to agree on it or a remembered image is a
# fact with no picture.
_PM_PATH_PREFIX = "path: "


def _pm_names() -> list:
    """Every entry name in the project store, for the node's dropdown.

    Read at /object_info time, which is how ComfyUI populates every other
    disk-backed combo (checkpoints, LoRAs): the list refreshes when the user hits
    refresh, and a project switch — which moves the user directory — brings a
    different list with it. Empty stores still offer one row, because a combo with
    no options cannot be drawn at all.
    """
    d = _pm_dir()
    names = []
    if d is not None and d.is_dir():
        try:
            names = sorted({f.stem for f in d.glob("*/*.md") if f.stem != "PROJECT"})
        except Exception:  # noqa: BLE001
            names = []
    return names or ["(no project memory yet)"]


def _pm_entry_path(body: str) -> str:
    """The file a remembered reference points at, resolved, or ''.

    An input-relative path is what gets stored (it survives the project moving
    between machines), so it is resolved against ComfyUI's input dir first, then
    tried as given.
    """
    for line in str(body or "").splitlines():
        if not line.startswith(_PM_PATH_PREFIX):
            continue
        raw = line[len(_PM_PATH_PREFIX):].strip().strip('"')
        if not raw:
            return ""
        try:
            import folder_paths
            cand = _Path(folder_paths.get_input_directory()) / raw
            if cand.is_file():
                return str(cand)
        except Exception:  # noqa: BLE001
            pass
        p = _Path(raw)
        return str(p) if p.is_file() else ""
    return ""


class AgentYLoadItem(io.ComfyNode):
    """Load one item out of this project's memory — text, image or video.

    The project's memory holds what the production has established: a character's
    prompt, the grade, a delivery spec, and — since the ``agentY add tag`` node
    grew a `remember` switch — named reference images and clips. This node brings
    one of them into the graph, chosen from a dropdown of what is actually stored,
    with no agent in the loop.

    **The ``item`` output is auto-typed.** An entry that points at an image loads
    as an ``IMAGE``, one that points at a video as a ``VIDEO``, and anything else
    hands over its text — so the same node feeds a sampler, a video node or a
    prompt box depending only on what the entry is. ``text`` is always the entry's
    words, and ``path`` the resolved file (empty for a text-only fact), so a graph
    that wants both does not need two nodes.

    A picked entry that names an image or video is **previewed on the node**,
    without running anything: the file is on disk already, so there is nothing to
    execute to find out what it looks like.

    A name that has since been forgotten yields empty outputs rather than an
    error, so a graph shared between projects still runs where the fact is absent.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYLoadItem",
            display_name="agentY load item",
            category="agentY",
            search_aliases=["agentY project memory item", "agentY load reference"],
            description=(
                "Load one entry from this project's memory: an image, a video or a "
                "text fact. The 'item' output takes the type of whatever the entry is, "
                "so it wires straight into a sampler, a video node or a prompt box."
            ),
            inputs=[
                io.Combo.Input(
                    "name",
                    options=_pm_names(),
                    tooltip=(
                        "Which stored entry to load. The list is what the project's "
                        "memory holds right now — press ComfyUI's refresh after the "
                        "agent writes a new one, or after switching project."
                    ),
                ),
            ],
            outputs=[
                io.AnyType.Output(display_name="item"),
                io.String.Output(display_name="text"),
                io.String.Output(display_name="path"),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, name=""):  # noqa: ANN001, N805
        # The entry is a file on disk that the agent (or another graph) can rewrite
        # between runs, so caching on the NAME alone would serve yesterday's fact.
        # Mix in what the file says now.
        f = _pm_find(_pm_slug(name))
        try:
            return f"{name}|{f.stat().st_mtime_ns}" if f else str(name)
        except Exception:  # noqa: BLE001
            return str(name)

    @classmethod
    def execute(cls, name="") -> io.NodeOutput:  # noqa: ANN001
        import torch

        f = _pm_find(_pm_slug(name))
        body = ""
        if f is not None:
            try:
                body = f.read_text(encoding="utf-8").strip()
            except Exception as exc:  # noqa: BLE001
                print(f"[agentY load item] could not read {f}: {exc}")
        path = _pm_entry_path(body)
        ext = _Path(path).suffix.lower() if path else ""

        if ext and ext in _COLLECT_IMG_EXTS:
            return io.NodeOutput(_stack_images([path]), body, path)
        if ext and ext in _COLLECT_VID_EXTS:
            vids = _load_videos([path])
            return io.NodeOutput(vids[0] if vids else body, body, path)
        # Not a file: the fact itself is the item. A blank 1x64x64 frame is NOT
        # substituted here — a text entry wired into an IMAGE slot should fail
        # loudly rather than quietly render black.
        return io.NodeOutput(body, body, path)


class AgentYRefNote(io.ComfyNode):
    """Name a reference, and say what it is FOR, on the wire that carries it.

    Drop it between a loader and whatever consumes it — LoadImage → add tag →
    hook anchor — and write what the agent should take from this input: "the face,
    not the styling"; "the light, not the architecture". The agent reads the note
    with the input, so a reference image stops being just "an image" and becomes an
    image with a job.

    ``tag`` is the short handle for that same reference — ``hero_face``,
    ``alley_light``. Once a tag exists anywhere on the canvas, typing ``#`` in any
    ``agentY hook`` prompt box opens a menu of every tag in the scene, so a
    directive can say ``#hero_face`` and mean exactly this wire. Without a tag the
    node behaves exactly as it always has: the prompt is the whole statement.

    Two things follow from the annotation living on the wire rather than in a
    separate node: the binding can't drift (there is nothing to keep in sync — the
    link IS the statement), and the agent still sees the real node behind it, so an
    anchor on a tag node reads as the LoadImage it wraps, plus the tag and the role.

    The class is still ``AgentYRefNote`` — it was called "agentY ref note" until
    the tag field arrived, and the class id is what every saved graph and the agent
    side key off. Renaming it would orphan every canvas that already has one.

    The output type follows the input, so it can be inserted into an existing wire
    of any type without changing what downstream nodes receive. On a normal run it
    is an identity passthrough.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        template = io.MatchType.Template("ref")
        return io.Schema(
            node_id="AgentYRefNote",
            display_name="agentY add tag",
            category="agentY",
            description=(
                "Tag the reference on this wire and say what it is FOR ('the face, not "
                "the styling'). The tag is what '#' offers in every hook prompt box. "
                "Sits on the wire; identity passthrough on a normal run."
            ),
            inputs=[
                io.MatchType.Input("input", template=template),
                # Optional so an API-format prompt saved before this field existed
                # still validates — those carry `role` and nothing else.
                io.String.Input(
                    "tag", default="", optional=True,
                    placeholder="tag name — e.g. hero_face (then #hero_face in any hook)",
                    tooltip=(
                        "A short name for this reference. Every tag on the canvas is "
                        "offered in an agentY hook's prompt box when you type '#', so a "
                        "directive can point at this exact wire by name instead of "
                        "describing it. Letters, digits, '_' and '-'; no spaces."
                    ),
                ),
                io.String.Input(
                    "role", multiline=True, default="",
                    placeholder="what to take from this reference — e.g. the face, not the styling",
                ),
                # Appended, never inserted: widgets_values is positional, so a
                # graph saved with [tag, role] reads correctly here and simply
                # gets the default.
                io.Boolean.Input(
                    "remember", default=False, optional=True,
                    label_on="remember for the project",
                    label_off="this graph only",
                    tooltip=(
                        "Should this reference outlive this graph? OFF (default) keeps "
                        "the tag where it is: a name for a wire on this canvas, gone "
                        "when the node is. ON also writes it into the project's memory "
                        "as a named reference — the file's path and what you said it is "
                        "for — so '#name' still resolves in a NEW graph, and a Claude "
                        "Desktop session on the same ComfyUI can read it too. Turning "
                        "it off stops refreshing the entry but does NOT delete it: a "
                        "graph that happens not to contain this tag must not silently "
                        "forget it. Remove it in the project-memory editor."
                    ),
                ),
            ],
            outputs=[io.MatchType.Output(template=template, display_name="output")],
        )

    @classmethod
    def execute(cls, input=None, role="", tag="", remember=False) -> io.NodeOutput:  # noqa: ANN001, A002, ARG003
        return io.NodeOutput(input)


# How many images the expander can hand out. Executable nodes cannot auto-grow
# outputs (the count is fixed at registration, same constraint as AgentYPython),
# so this is a ceiling rather than a preference — eight covers the reference
# counts the API video models actually accept.
_N_EXPAND_OUT = 8


class AgentYImageBatchExpand(io.ComfyNode):
    """Split a batch of images into one output per image.

    The problem it solves: an ``agentY image collector`` emits its files as a
    single IMAGE **batch**, and the API model nodes take references in numbered
    single-image slots (``image_1``, ``image_2``, …). Wire the batch straight into
    ``image_1`` and the node takes the FIRST image and silently ignores the rest —
    the video comes back built from one reference when you gave it five, and
    nothing anywhere reports an error.

    So: collector → this → one wire per slot. ``count`` says how many images
    actually arrived, which is what tells you whether the slots you wired are
    real.

    A slot beyond the end of the batch emits nothing rather than repeating the
    last image. Repeating would be the quiet failure again — a reference sheet
    with the same character twice, that nobody notices until the render.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        return io.Schema(
            node_id="AgentYImageBatchExpand",
            display_name="agentY expand image batch",
            category="agentY",
            description=(
                "Split an IMAGE batch (e.g. from an agentY image collector) into one "
                "image per output, so each can be wired into its own numbered slot on "
                "a model node. Wiring a batch into a single image_1 input uses only the "
                "first image. `count` reports how many arrived."
            ),
            inputs=[
                io.Image.Input("images", tooltip="The image batch to split, in order."),
            ],
            outputs=(
                [io.Image.Output(display_name=f"image_{i + 1}")
                 for i in range(_N_EXPAND_OUT)]
                + [io.Int.Output(display_name="count")]
            ),
        )

    @classmethod
    def execute(cls, images=None) -> io.NodeOutput:  # noqa: ANN001
        # A ComfyUI IMAGE is a [B, H, W, C] tensor; slicing with i:i+1 keeps the
        # batch dimension, so each output is a valid one-image batch rather than a
        # bare HWC array that downstream nodes would choke on.
        items: list = []
        if images is not None:
            try:
                items = [images[i:i + 1] for i in range(len(images))]
            except TypeError:                      # not sliceable — pass it through
                items = [images]
        outs = items[:_N_EXPAND_OUT]
        outs += [None] * (_N_EXPAND_OUT - len(outs))
        return io.NodeOutput(*outs, len(items))


# ── QA briefing ───────────────────────────────────────────────────────────────
# A `qa` hook says what "good" means in prose, which is right for the half that
# needs judgement — likeness, mood, whether the composition works. It is the wrong
# tool for the half that does not. "16:9" and "at least 1080p" and "not a soft
# render" are settled by measuring the file, and writing them as sentences for a
# vision model to re-decide is slower, less certain, and not repeatable.
#
# So the technical half gets controls. What this node emits is read by the agent
# exactly like a qa hook's directive, plus a machine-readable spec that agentY
# checks in code before the model is asked anything (src/utils/qa_checks.py).

_QA_RATIOS = ["any", "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9", "2.39:1"]
_QA_HEIGHTS = ["any", "720p", "1080p", "1440p", "2160p (4K)"]
# Kept in step with LIKENESS_SCORERS in agentY's src/utils/qa_checks.py, which
# reads these strings back. A face is measured by an ArcFace embedding, anything
# else by DreamSim — a perceptual metric trained on human judgements of exactly
# this kind of picture.
_QA_LIKENESS = ["any", "must match the reference face",
                "must match the reference subject"]


class AgentYQaBriefing(io.ComfyNode):
    """What "good" means for this graph's outputs — the technical half as controls.

    Drop it anywhere on the canvas and every output of the run is checked against
    it. The dropdowns and switches are decided by MEASURING the finished file, so
    they are exact and cost nothing: an aspect ratio is compared, not eyeballed.
    Whatever needs judgement goes in ``notes``, in your own words, and is read by
    the QA model the same way a ``qa`` hook's prompt is.

    Leave a control on "any" (or off) and it is not checked at all. Nothing here
    has a default opinion — an empty node enforces nothing.

    Wire reference images into ``reference`` when the criteria compare against
    something ("match this grade", "same character"); they are shown to the QA
    model alongside each output, and ``likeness`` turns that comparison into a
    measured score instead of an impression.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:  # noqa: N802
        refs = io.Autogrow.TemplatePrefix(
            input=io.AnyType.Input("reference"),
            prefix="reference",
            min=0,
            max=8,
        )
        return io.Schema(
            node_id="AgentYQaBriefing",
            display_name="agentY qa briefing",
            category="agentY",
            description=(
                "What counts as a good output for this graph. The technical checks "
                "(ratio, resolution, sharpness, grain, exposure) are decided by "
                "measuring the finished file, so they are exact; 'notes' carries "
                "everything that needs judgement. Anything left on 'any' is not "
                "checked. Inert on a normal run."
            ),
            inputs=[
                io.String.Input(
                    "notes", multiline=True, default="",
                    placeholder=(
                        "What needs judgement, in your own words — e.g. the character must "
                        "match the reference; warm evening light; no text anywhere"
                    ),
                    tooltip=(
                        "Read by the QA model exactly like a `qa` hook's prompt. Put the "
                        "things a measurement cannot settle here: likeness, mood, framing, "
                        "whether it looks right."
                    ),
                ),
                io.Combo.Input(
                    "aspect_ratio", options=_QA_RATIOS, default="any",
                    tooltip="Compared against the file's real dimensions, within a "
                            "rounding tolerance — 1312x736 counts as 16:9.",
                ),
                io.Combo.Input(
                    "resolution", options=_QA_HEIGHTS, default="any",
                    tooltip="Minimum SHORT side, which is how '1080p' is usually meant.",
                ),
                io.Combo.Input(
                    "sharpness", options=["any", "must be sharp"], default="any",
                    tooltip=(
                        "Fails a soft or blurry render. A shallow depth of field still "
                        "passes: if part of the frame is genuinely sharp, the soft areas "
                        "are read as depth of field rather than a bad render."
                    ),
                ),
                io.Combo.Input(
                    "grain", options=["any", "must be clean"], default="any",
                    tooltip="Fails visible grain or noise. Leave on 'any' when grain is "
                            "the look you asked for.",
                ),
                io.Boolean.Input(
                    "no_clipping", default=False,
                    label_on="no blown/crushed", label_off="exposure not checked",
                    tooltip=(
                        "Fails an output with more than 2% of pixels pinned at pure white "
                        "or pure black — detail there is gone and cannot be graded back. "
                        "A little clipping is normal (a light source, a spec highlight), "
                        "which is why it is a threshold rather than zero."
                    ),
                ),
                io.Boolean.Input(
                    "no_black_frames", default=False,
                    label_on="no black frames", label_off="black frames not checked",
                    tooltip="Video only. Fails a clip with a fully black sampled frame.",
                ),
                io.Boolean.Input(
                    "no_stalled_motion", default=False,
                    label_on="must keep moving", label_off="motion not checked",
                    tooltip="Video only. Fails a clip that freezes — sampled frames that "
                            "are essentially identical.",
                ),
                io.Combo.Input(
                    "likeness", options=_QA_LIKENESS, default="any",
                    tooltip=(
                        "Compares the output against the images wired into "
                        "`reference`, as a number rather than an opinion. 'face' "
                        "asks whether it is the same person; 'subject' asks whether "
                        "it is the same place, product or look. Needs at least one "
                        "reference wired in, and the first run downloads the "
                        "matching model."
                    ),
                ),
                io.Int.Input(
                    "retries", default=0, min=0, max=10,
                    tooltip=(
                        "How many times a failing output may be re-generated. 0 reports "
                        "the verdict and changes nothing, which is the safe default: each "
                        "retry is a real generation at real cost."
                    ),
                ),
                io.Autogrow.Input("references", template=refs),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, notes="", aspect_ratio="any", resolution="any", sharpness="any",
                grain="any", no_clipping=False, no_black_frames=False,
                no_stalled_motion=False, likeness="any", retries=0, references=None,
                **_legacy) -> io.NodeOutput:  # noqa: ANN001, ARG003
        # Inert on a normal run, like every other agentY annotation node: it says
        # what the agent should check, and a plain Queue is not the agent.
        return io.NodeOutput()


class _AgentYExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [AgentYHook, AgentYQaBriefing, AgentYPython, AgentYText,
                AgentYImageCollector, AgentYVideoCollector, AgentYImageBatchExpand,
                AgentYProjectMemoryGet, AgentYProjectMemorySet, AgentYRefNote,
                AgentYLoadItem]


async def comfy_entrypoint() -> ComfyExtension:
    return _AgentYExtension()


WEB_DIRECTORY = "./web"
