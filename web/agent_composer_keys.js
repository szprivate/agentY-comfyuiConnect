// Word jumps in the composer, and the click that shows a result full size.
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

// Show a result picture full size OVER the panel, in the panel's own document.
//
// It used to be window.open(src). The panel is one DOM that also lives in the
// bEpic viewer: docked in its shadow root, full-screen, or popped out into a
// window of its own. The listener runs in the ComfyUI page's realm, so from the
// popout it called the PAGE's window.open: the picture opened as a tab of the
// ComfyUI window behind the popout (or not at all where that window's popup
// blocker stops a call it did not see the click for) - nothing happened where
// the user was looking. Full-screen, a new tab took them out of the viewer. An
// overlay inside the panel (.ay-wrap is position:relative) needs no window and
// no gesture, and is the same in all four places. A plain link in it still
// opens a tab, from the window the panel is in.
export function showFullSize(target, src) {
  if (!target || !src) return null;
  const doc = target.ownerDocument || document;
  const holder = (target.closest && target.closest(".ay-wrap")) || doc.body;
  holder.querySelector(":scope > .ay-lightbox")?.remove();
  let href = src;
  try { href = new URL(src, window.location.href).href; } catch (_) {}
  const box = doc.createElement("div");
  box.className = "ay-lightbox";
  box.title = "Click or Esc to close";
  box.style.cssText = "position:absolute;inset:0;z-index:300;display:flex;flex-direction:column;"
    + "align-items:center;justify-content:center;gap:8px;padding:10px;box-sizing:border-box;"
    + "background:rgba(8,9,12,.94);cursor:zoom-out;";
  const img = doc.createElement("img");
  img.className = "ay-lightbox-img";
  img.src = href;
  img.alt = (target.getAttribute && target.getAttribute("alt")) || "";
  img.style.cssText = "max-width:100%;max-height:calc(100% - 34px);object-fit:contain;display:block;"
    + "border-radius:4px;background:#000;";
  const link = doc.createElement("a");
  link.className = "ay-lightbox-open";
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Open in a new tab ↗";
  link.style.cssText = "color:#9db6ff;font:12px ui-sans-serif,system-ui,sans-serif;text-decoration:none;cursor:pointer;";
  box.append(img, link);
  const close = () => {
    box.remove();
    doc.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  box.addEventListener("click", (e) => {
    if (e.target === link) return;   // the link opens its tab; the overlay stays
    e.stopPropagation();
    close();
  });
  doc.addEventListener("keydown", onKey, true);
  holder.appendChild(box);
  return box;
}
