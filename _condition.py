"""The `agentY condition` node's work: ask a decision model about pictures.

A decision model (Ollama's "decision" category - Cloudflare's clef and
clef-flash read images) does not write. It is given a picture and typed
questions and answers each with a probability. That is exactly a condition:

    the woman looks frustrated
    not: the woman looks angry

Each line is one yes/no statement about the picture; a line that starts with
``not:`` must be FALSE. The condition is met when every line holds at the
threshold.

Kept apart from the node class so it runs without ComfyUI (the tests do), and
talks to Ollama over plain HTTP: the decision endpoint is not in Ollama's Python
library.

The weights are not part of any install. The first time a model is asked for it
is pulled through Ollama (10 GB for clef-flash, 18 GB for clef), with progress.
"""

from __future__ import annotations

import base64
import io as _io
import json
import os
import urllib.error
import urllib.request

MODELS = ("clef-flash", "clef")
# What each needs on the card, in GB - to decide whether ComfyUI must make room.
VRAM_GB = {"clef-flash": 11.0, "clef": 19.0}
ENDPOINT = "/v1/systemone"
MAX_STATEMENTS = 32
BATCH_MODES = ("every image must pass", "any image may pass", "first image only")


class ConditionError(RuntimeError):
    """The condition could not be judged; the message is for the person at the canvas."""


def host() -> str:
    """Where Ollama listens: ``OLLAMA_HOST`` if set, else the local default."""
    raw = (os.environ.get("OLLAMA_HOST") or "").strip() or "http://127.0.0.1:11434"
    if "://" not in raw:
        raw = "http://" + raw
    # "localhost" costs seconds per request to an IPv4-only server on Windows.
    return raw.rstrip("/").replace("://localhost", "://127.0.0.1").replace("://0.0.0.0", "://127.0.0.1")


def parse(condition: str) -> list[tuple[str, bool]]:
    """``[(statement, must_be_true)]`` from the node's text, one per line."""
    out = []
    for line in str(condition or "").splitlines():
        text = line.strip().lstrip("-*• ").strip()
        if not text or text.startswith("#"):
            continue
        want = True
        low = text.lower()
        for prefix in ("not:", "not :", "no:", "never:"):
            if low.startswith(prefix):
                want, text = False, text[len(prefix):].strip()
                break
        if text:
            out.append((text, want))
    if len(out) > MAX_STATEMENTS:
        raise ConditionError(f"{len(out)} statements are more than one condition takes ({MAX_STATEMENTS}).")
    return out


def _call(url: str, body: dict | None = None, timeout: float = 30.0) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace") or "{}")


def installed(model: str, base: str | None = None) -> bool:
    base = base or host()
    try:
        names = [str(m.get("name") or "") for m in _call(base + "/api/tags", timeout=10).get("models") or []]
    except Exception as exc:  # noqa: BLE001
        raise ConditionError(
            f"Ollama does not answer at {base} ({exc}). The agentY condition node asks a decision model "
            f"that runs in Ollama: install and start Ollama (ollama.com), or set OLLAMA_HOST.") from None
    return any(n == model or n.split(":")[0] == model for n in names)


def pull(model: str, base: str | None = None, progress=None) -> None:
    """Download *model* through Ollama. ``progress(done, total, status)`` as it goes."""
    base = base or host()
    req = urllib.request.Request(base + "/api/pull", data=json.dumps({"model": model, "stream": True}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=24 * 3600) as r:
            for raw in r:
                try:
                    msg = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if msg.get("error"):
                    raise ConditionError(f"Ollama could not download {model}: {msg['error']}")
                if progress:
                    progress(int(msg.get("completed") or 0), int(msg.get("total") or 0), str(msg.get("status") or ""))
    except ConditionError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ConditionError(f"The download of {model} through Ollama stopped: {exc}") from None
    if not installed(model, base):
        raise ConditionError(f"Ollama finished the download of {model}, but does not list the model.")


def ensure(model: str, base: str | None = None, progress=None) -> bool:
    """Make sure *model* is there, downloading it on first use. Returns whether it
    had to be downloaded."""
    if model not in MODELS:
        raise ConditionError(f"unknown decision model: {model!r} (there are: {', '.join(MODELS)})")
    if installed(model, base):
        return False
    pull(model, base, progress)
    return True


def encode(pixels, side: int = 1024) -> str:
    """One ComfyUI image (``[H, W, C]`` floats 0..1, or a PIL image) as base64 JPEG."""
    from PIL import Image
    if not isinstance(pixels, Image.Image):
        import numpy as np
        arr = np.clip(np.asarray(pixels, dtype="float32") * 255.0, 0, 255).astype("uint8")
        if arr.ndim == 2:
            arr = np.stack([arr] * 3, axis=-1)
        pixels = Image.fromarray(arr[:, :, :3])
    image = pixels.convert("RGB")
    image.thumbnail((side, side))
    buf = _io.BytesIO()
    image.save(buf, "JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def ask(model: str, image_b64: str, statements, base: str | None = None, keep_alive: str = "30s") -> list[float]:
    """The probability that each statement is TRUE of the picture."""
    base = base or host()
    questions = {f"s{i}": {"type": "noul", "instructions": f"Is this true of the picture: {text}"}
                 for i, (text, _want) in enumerate(statements)}
    body = {"model": model, "state": "Look at the attached picture and judge each statement about it.",
            "images": [image_b64], "questions": questions, "keep_alive": keep_alive}
    try:
        got = _call(base + ENDPOINT, body, timeout=600)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        hint = (" This Ollama may be too old for decision models (clef needs 0.35.1 or later)."
                if exc.code == 404 else "")
        raise ConditionError(f"Ollama refused the question to {model} ({exc.code}): {detail}{hint}") from None
    except Exception as exc:  # noqa: BLE001
        raise ConditionError(f"Ollama did not answer the question to {model}: {exc}") from None
    answers = got.get("answers") or {}
    out = []
    for i in range(len(statements)):
        value = (answers.get(f"s{i}") or {}).get("noul")
        if not isinstance(value, (int, float)):
            raise ConditionError(f"{model} gave no answer to statement {i + 1}.")
        out.append(float(value))
    return out


def judge(probabilities, statements, threshold: float) -> dict:
    """One picture's verdict from the model's probabilities.

    ``holds`` of a statement is how strongly it is as the condition wants it: the
    probability itself, or one minus it for a ``not:`` line. The picture passes
    when every statement holds at the threshold; its ``score`` is the weakest.
    """
    rows = []
    for p, (text, want) in zip(probabilities, statements):
        holds = p if want else 1.0 - p
        rows.append({"statement": text, "wanted": want, "probability": round(p, 4),
                     "holds": round(holds, 4), "ok": holds >= threshold})
    score = min((r["holds"] for r in rows), default=0.0)
    return {"met": bool(rows) and all(r["ok"] for r in rows), "score": round(score, 4), "rows": rows}


def combine(verdicts, mode: str) -> tuple[bool, float]:
    """The condition over a batch of pictures."""
    if not verdicts:
        return False, 0.0
    if mode == BATCH_MODES[2]:
        return verdicts[0]["met"], verdicts[0]["score"]
    if mode == BATCH_MODES[1]:
        return any(v["met"] for v in verdicts), max(v["score"] for v in verdicts)
    return all(v["met"] for v in verdicts), min(v["score"] for v in verdicts)


def report(verdicts, met: bool, model: str, threshold: float) -> str:
    lines = [f"{'MET' if met else 'NOT MET'} ({model}, threshold {threshold:g})"]
    for n, v in enumerate(verdicts, 1):
        if len(verdicts) > 1:
            lines.append(f"image {n}: {'pass' if v['met'] else 'fail'}")
        for r in v["rows"]:
            mark = "ok " if r["ok"] else "NO "
            lead = "" if r["wanted"] else "not: "
            lines.append(f"  {mark}{r['probability']:.2f}  {lead}{r['statement']}")
    return "\n".join(lines)
