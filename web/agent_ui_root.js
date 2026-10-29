// Where agentY's floating pieces (the # tag menu, the Manage conversations page)
// are mounted, and how an event is read, when the panel is not in the plain page.
//
// The panel is ONE DOM, shown either in the ComfyUI sidebar (the page itself) or
// in the bEpic viewer, whose docked panel lives inside a shadow root (and, popped
// out, in another document). Three things that are true in the page are false
// there, and each broke something:
//   * a listener on `document` sees an event from inside a shadow root with its
//     target RETARGETED to the shadow host, so `e.target` is never the textarea;
//   * `document.body` is hidden wholesale by the viewer's full-screen mode
//     (`body > *:not(bepic-viewer-panel) {display:none}`), so anything appended
//     there vanishes with the page;
//   * a stylesheet in `document.head` does not reach a shadow root.
// So: read the real target off the composed path, mount next to the thing that
// asked for it, and put the stylesheet in that same root.

// The innermost element an event came from, through open shadow roots.
export function eventTarget(e) {
  const path = e && typeof e.composedPath === "function" ? e.composedPath() : null;
  return (path && path.length ? path[0] : e && e.target) || null;
}

// Whether an event happened inside `node` (shadow-root safe).
export function eventInside(e, node) {
  if (!node) return false;
  const path = e && typeof e.composedPath === "function" ? e.composedPath() : null;
  if (path && path.length) return path.includes(node);
  return !!(e && e.target && node.contains(e.target));
}

// The node to append a floating element to: the shadow root the anchor lives in,
// else the anchor's own document body (which is the popout's body when popped out).
export function uiRoot(anchor) {
  const doc = (anchor && anchor.ownerDocument) || document;
  const root = anchor && typeof anchor.getRootNode === "function" ? anchor.getRootNode() : null;
  if (root && root !== doc && root.host && typeof root.appendChild === "function") return root;
  return doc.body;
}

// Make sure `css` is present in whatever root `parent` (from uiRoot) belongs to.
export function ensureStyleIn(parent, id, css) {
  const doc = parent.ownerDocument || parent;
  const into = parent === doc.body ? doc.head : parent;
  for (const s of into.querySelectorAll ? into.querySelectorAll("style") : []) {
    if (s.id === id) return;
  }
  const s = doc.createElement("style");
  s.id = id;
  s.textContent = css;
  into.appendChild(s);
}
