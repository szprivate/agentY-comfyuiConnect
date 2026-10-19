// What "save the open workflow" does, decided from plain facts, so the rules that
// keep the agent from overwriting anything are checkable without a ComfyUI page.
//
//   state: { temporary, modified, path, filename, taken }  - the active workflow
//          (taken: does another saved workflow already have the requested name?)
//   -> { action: "save" | "save_as" | "refuse", status?, message?, path? }

/** A file name for the workflows folder: no folder parts, no extension. */
export function cleanName(name) {
  let n = String(name || "").trim().replace(/\\/g, "/").split("/").pop() || "";
  n = n.replace(/\.json$/i, "").replace(/[<>:"|?*\u0000-\u001f]/g, "").replace(/^\.+/, "").trim();
  return n.slice(0, 120);
}

export function planSave(state, name, overwrite) {
  const s = state || {};
  const clean = cleanName(name);
  const label = s.path || s.filename || "this workflow";
  if (s.temporary) {
    if (!clean) {
      return { action: "refuse", status: "needs_name",
        message: "This workflow has never been saved. Give a short file name for what it does "
          + "(save_canvas_workflow(name=...))." };
    }
    if (s.taken) {
      return { action: "refuse", status: "name_taken", name: clean,
        message: `A workflow called ${clean} already exists and is not replaced. Pick another name.` };
    }
    return { action: "save_as", name: clean };
  }
  if (clean && clean !== cleanName(s.filename)) {
    // A new name for a workflow that already is a file: a copy under the new name.
    if (s.taken) {
      return { action: "refuse", status: "name_taken", name: clean,
        message: `A workflow called ${clean} already exists and is not replaced. Pick another name.` };
    }
    return { action: "save_as", name: clean };
  }
  if (!s.modified) {
    return { action: "refuse", status: "already_saved", path: s.path || "",
      message: `${label} has no unsaved changes; nothing was written.` };
  }
  if (!overwrite) {
    return { action: "refuse", status: "needs_overwrite", path: s.path || "",
      message: `${label} is already a saved file; saving would replace it. Nothing was written. `
        + "Say so to the user and call again with overwrite=true if they agree." };
  }
  return { action: "save", path: s.path || "" };
}
