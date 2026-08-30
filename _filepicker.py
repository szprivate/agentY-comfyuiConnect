"""Native OS file/folder picker for the agentY collector nodes.

Run as a SUBPROCESS by the ``/agent/pick_files`` route (never imported), so each
dialog is a fresh Tk process off ComfyUI's event loop — no Tk-on-a-thread issues,
no state leaking between calls.

Usage:  python _filepicker.py <kind:media|image|video> <mode:files|folder>

``media`` is what the merged collector asks for — both filters in one dialog, with
"Media files" preselected so a mixed folder can be picked from in one pass.

Prints a JSON array of the selected absolute paths to stdout (empty on cancel),
or ``{"error": "..."}`` when no dialog can be opened at all.

Tk is the first choice everywhere. On macOS it is regularly absent — Homebrew's
python is packaged without it unless python-tk is installed too, and ComfyUI's
bundled interpreter is whatever the user had — so there is an AppleScript fallback,
which needs nothing installed because osascript is part of the system. Without it
the collector nodes are simply unusable on a common Mac setup, and the error
("tkinter unavailable") names a package the user never asked for.
"""
import json
import subprocess
import sys

_EXTS_IMG = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff"]
_EXTS_VID = ["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpg", "mpeg"]

try:
    import tkinter as tk
    from tkinter import filedialog
    _HAVE_TK = True
except Exception as _exc:  # noqa: BLE001 — no Tk here; try the OS instead
    # Kept as a string, not the exception: Python unbinds the `as` name at the end
    # of the except block, so referring to it later is a NameError that only fires
    # on the machine that already had the first problem.
    _TK_ERR = str(_exc)
    _HAVE_TK = False

_IMG = "*.png *.jpg *.jpeg *.webp *.bmp *.gif *.tiff"
_VID = "*.mp4 *.mov *.webm *.mkv *.avi *.m4v *.mpg *.mpeg"


def _exts_for(kind: str) -> list:
    if kind == "video":
        return _EXTS_VID
    if kind == "image":
        return _EXTS_IMG
    return _EXTS_IMG + _EXTS_VID


def _osascript_pick(kind: str, mode: str) -> list:
    """The same dialog through AppleScript, for a Python without Tk.

    Raises on anything that is not a plain cancel, so the caller can report the
    real reason rather than an empty selection the user did not make.
    """
    label = {"video": "videos", "image": "images"}.get(kind, "media files")
    if mode == "folder":
        src = ('set f to choose folder with prompt "agentY — select a folder"\n'
               'return POSIX path of f')
    else:
        types = ", ".join('"%s"' % e for e in _exts_for(kind))
        src = (f'set fs to choose file with prompt "agentY — select {label}" '
               f'of type {{{types}}} with multiple selections allowed\n'
               'set out to ""\n'
               'repeat with f in fs\n'
               '  set out to out & POSIX path of f & linefeed\n'
               'end repeat\n'
               'return out')
    proc = subprocess.run(["osascript", "-e", src], capture_output=True, text=True)
    if proc.returncode != 0:
        err = (proc.stderr or "").strip()
        # -128 is "User canceled", which is an answer, not a failure.
        if "-128" in err or "User canceled" in err:
            return []
        raise RuntimeError(err or f"osascript exited {proc.returncode}")
    return [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]


def _tk_pick(kind: str, mode: str) -> list:
    root = tk.Tk()
    root.withdraw()
    # Force the dialog to the front (otherwise it can open behind the browser).
    try:
        root.attributes("-topmost", True)
        root.update()
    except Exception:  # noqa: BLE001
        pass

    paths: list = []
    try:
        if mode == "folder":
            d = filedialog.askdirectory(title="agentY — select a folder")
            if d:
                paths = [d]
        else:
            if kind == "video":
                label, types = "Videos", [("Videos", _VID)]
            elif kind == "image":
                label, types = "Images", [("Images", _IMG)]
            else:
                # The merged collector: one dialog for both, the combined filter
                # first so a mixed folder shows everything usable by default.
                label = "Media files"
                types = [("Media files", _IMG + " " + _VID),
                         ("Images", _IMG), ("Videos", _VID)]
            sel = filedialog.askopenfilenames(
                title=f"agentY — select {label.lower()} (Ctrl/Shift-click for several)",
                filetypes=types + [("All files", "*.*")],
            )
            paths = list(sel)
    finally:
        try:
            root.destroy()
        except Exception:  # noqa: BLE001
            pass
    return paths


def _main() -> None:
    kind = sys.argv[1].lower() if len(sys.argv) > 1 else "image"
    mode = sys.argv[2].lower() if len(sys.argv) > 2 else "files"

    if _HAVE_TK:
        print(json.dumps(_tk_pick(kind, mode)))
        return
    if sys.platform == "darwin":
        try:
            print(json.dumps(_osascript_pick(kind, mode)))
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": f"the macOS file dialog failed: {exc}"}))
        return
    print(json.dumps({"error": f"tkinter unavailable in the ComfyUI Python: {_TK_ERR}"}))


_main()
