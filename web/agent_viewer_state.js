// What the bEpic viewer is showing, and the marks drawn on it, for the agent.
//
// The viewer (ComfyUI-ImageViewer) answers through window.bEpicViewerApi:
//
//   viewerState()      - open / docked / full screen / popped out, the tab and the
//                        tab list, the item on screen, the frame, the range picked
//                        on the timeline, compare, view, the 3D camera, and how many
//                        marks the item has
//   annotations(opts)  - the Annotation tool's marks on the item on screen, in
//                        words and normalised coordinates ({ frame, raw })
//
// Both are plain data from the viewer's JS state, so they read the same whether
// it is docked, full screen or popped out - nothing here touches its DOM or its
// shadow root.
//
// viewerState travels with each chat message (`viewer_state`), but only while the
// viewer is open: a closed viewer sends null, so a message carries nothing for
// the common case. Both answer the host's live reads (agent.request_viewer_state,
// agent.request_viewer_annotations; the routes /agent/viewer_state and
// /agent/viewer_annotations - get_viewer_state / get_viewer_annotations).

function viewerApi() {
  return typeof window !== "undefined" ? window.bEpicViewerApi : null;
}

/** The viewer's state, or null when it is not installed, too old, or closed. */
export function collectViewerState(api = viewerApi()) {
  try {
    const fn = api && api.viewerState;
    const got = typeof fn === "function" ? fn() : null;
    if (!got || typeof got !== "object" || !got.open) return null;
    return got;
  } catch (_) {
    return null;
  }
}

/** Whether the installed viewer can answer at all (an older one has no viewerState). */
export function viewerAnswers(api = viewerApi()) {
  return !!(api && typeof api.viewerState === "function");
}

/** The marks on the item on screen, or null when the viewer cannot say. */
export function collectViewerAnnotations(opts = {}, api = viewerApi()) {
  try {
    const fn = api && api.annotations;
    if (typeof fn !== "function") return null;
    const o = {};
    if (Number.isInteger(opts.frame) && opts.frame >= 0) o.frame = opts.frame;
    if (opts.raw) o.raw = true;
    const got = fn(o);
    return got && typeof got === "object" ? got : null;
  } catch (_) {
    return null;
  }
}
