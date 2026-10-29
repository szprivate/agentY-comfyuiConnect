// What the user has picked in a history panel, for the agent.
//
// Two panels keep a history the user can pick from:
//
//   the bEpic viewer's history strip (ComfyUI-ImageViewer) - asked through
//       window.bEpicViewerApi.historySelection(), which answers with the picked
//       snapshots' files (multi-selection, a compare pin, or one older snapshot
//       clicked open). Plain data from the viewer's JS state, so it reads the
//       same whether the viewer is docked, full screen or popped out - nothing
//       here touches its DOM or its shadow root.
//   ComfyUI's own Media Assets / queue sidebar - its selection is a Pinia store
//       ("assetSelection") of asset ids. Not an extension API, so every step is
//       guarded and an absent store is simply "nothing picked". The store is
//       cleared when the sidebar closes, so a stale pick does not linger. The
//       ids say which run (and often which file) they are; the host resolves them
//       (agenty_core.tools.history_selection).
//
// The answer travels with each chat message (`history_selection`) and answers
// the host's live read (agent.request_history_selection, the route
// /agent/history_selection). It is `null` when nothing is picked anywhere, so a
// message carries nothing for the common case.

/** Most asset ids sent; the count says how many there were. */
export const ASSET_IDS_CAP = 50;

function piniaStores() {
  try {
    const host = document.querySelector("#vue-app")
      || [...document.body.children].find((e) => e.__vue_app__);
    return host?.__vue_app__?.config?.globalProperties?.$pinia?._s || null;
  } catch (_) {
    return null;
  }
}

/** The viewer's answer, or null when it has none (not installed, nothing picked). */
export function viewerSelection(api = (typeof window !== "undefined" ? window.bEpicViewerApi : null)) {
  try {
    const fn = api && api.historySelection;
    const got = typeof fn === "function" ? fn() : null;
    if (!got || !Array.isArray(got.items) || !got.items.length) return null;
    return got;
  } catch (_) {
    return null;
  }
}

/** The ids picked in ComfyUI's assets sidebar, or null. */
export function assetsSelection(stores = piniaStores()) {
  try {
    const sel = stores && typeof stores.get === "function" ? stores.get("assetSelection") : null;
    if (!sel) return null;
    let ids = sel.selectedIdsArray;
    if (!Array.isArray(ids)) {
      const set = sel.selectedAssetIds;
      ids = set && typeof set[Symbol.iterator] === "function" ? [...set] : [];
    }
    ids = ids.map((x) => String(x || "")).filter(Boolean);
    if (!ids.length) return null;
    return { source: "comfy_assets", count: ids.length, ids: ids.slice(0, ASSET_IDS_CAP) };
  } catch (_) {
    return null;
  }
}

/** `{ viewer, assets }` with whichever has a pick, or null when neither does. */
export function collectHistorySelection() {
  const viewer = viewerSelection();
  const assets = assetsSelection();
  if (!viewer && !assets) return null;
  const out = {};
  if (viewer) out.viewer = viewer;
  if (assets) out.assets = assets;
  return out;
}
