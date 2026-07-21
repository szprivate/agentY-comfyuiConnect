"""Native OS file/folder picker for the agentY collector nodes.

Run as a SUBPROCESS by the ``/agent/pick_files`` route (never imported), so each
dialog is a fresh Tk process off ComfyUI's event loop — no Tk-on-a-thread issues,
no state leaking between calls.

Usage:  python _filepicker.py <kind:image|video> <mode:files|folder>

Prints a JSON array of the selected absolute paths to stdout (empty on cancel),
or ``{"error": "..."}`` when Tk is unavailable so the caller can report it.
"""
import json
import sys

try:
    import tkinter as tk
    from tkinter import filedialog
except Exception as exc:  # noqa: BLE001 — no Tk in this Python: report, don't crash
    print(json.dumps({"error": f"tkinter unavailable in the ComfyUI Python: {exc}"}))
    sys.exit(0)

_IMG = "*.png *.jpg *.jpeg *.webp *.bmp *.gif *.tiff"
_VID = "*.mp4 *.mov *.webm *.mkv *.avi *.m4v *.mpg *.mpeg"


def _main() -> None:
    kind = sys.argv[1].lower() if len(sys.argv) > 1 else "image"
    mode = sys.argv[2].lower() if len(sys.argv) > 2 else "files"

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
            is_video = kind == "video"
            label = "Videos" if is_video else "Images"
            pattern = _VID if is_video else _IMG
            sel = filedialog.askopenfilenames(
                title=f"agentY — select {label.lower()} (Ctrl/Shift-click for several)",
                filetypes=[(label, pattern), ("All files", "*.*")],
            )
            paths = list(sel)
    finally:
        try:
            root.destroy()
        except Exception:  # noqa: BLE001
            pass

    print(json.dumps(paths))


_main()
