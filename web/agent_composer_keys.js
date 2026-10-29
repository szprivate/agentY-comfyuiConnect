// Word jumps in the composer, and the click that opens a result full size.
//
// Kept free of ComfyUI imports so tests can load it in node.
//
// Word jumps: the browser does Ctrl+Left/Right (Option on a Mac) itself; this
// module leaves those alone. Alt+Left/Right is not a text-editing key on
// Windows or Linux - the browser reads it as Back/Forward, which would leave
// ComfyUI - so the composer does that jump itself. Shift extends the selection.

const WORD = /[\p{L}\p{N}_]/u;
const isWord = (ch) => WORD.test(ch);

// Where a word jump from `pos` lands, the way Ctrl+arrows land on Windows:
// left goes to the start of the word at or before the caret, right goes to the
// start of the next word (past the rest of this word and the gap after it).
export function wordJumpTarget(text, pos, dir) {
  const s = String(text || "");
  let i = Math.max(0, Math.min(s.length, pos | 0));
  if (dir < 0) {
    while (i > 0 && !isWord(s[i - 1])) i--;
    while (i > 0 && isWord(s[i - 1])) i--;
    return i;
  }
  const n = s.length;
  if (i < n && isWord(s[i])) {
    while (i < n && isWord(s[i])) i++;
  } else if (i < n && !/\s/.test(s[i])) {
    while (i < n && !isWord(s[i]) && !/\s/.test(s[i])) i++;
  }
  while (i < n && /\s/.test(s[i])) i++;
  return i;
}

// The composer's Alt+Left/Right. Returns true when it took the key.
export function altWordJump(e, ta) {
  if (!e || !ta || !e.altKey || e.ctrlKey || e.metaKey) return false;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return false;
  const dir = e.key === "ArrowLeft" ? -1 : 1;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const back = ta.selectionDirection === "backward";
  if (e.shiftKey) {
    // Move the end the selection was growing from, keep the other one.
    const anchor = back ? end : start;
    const focus = back ? start : end;
    const to = wordJumpTarget(ta.value, focus, dir);
    if (to < anchor) ta.setSelectionRange(to, anchor, "backward");
    else ta.setSelectionRange(anchor, to, "forward");
  } else {
    const from = dir < 0 ? start : end;
    const to = wordJumpTarget(ta.value, from, dir);
    ta.setSelectionRange(to, to);
  }
  e.preventDefault();
  e.stopPropagation();
  return true;
}

// The address a click in the chat log should open full size, or "" for a
// click on anything else. Read off the clicked element itself rather than a
// listener on each picture: a conversation re-opened, or the page reloaded,
// rebuilds the log from saved HTML, and saved HTML carries no listeners.
export function fullSizeSrc(target) {
  const img = target && target.closest ? target.closest("img.ay-out-media") : null;
  return img ? (img.getAttribute("src") || "") : "";
}
