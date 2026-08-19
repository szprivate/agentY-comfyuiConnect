import { app } from "../../scripts/app.js";

// `agentY load item` frontend — the preview.
//
// The node loads one entry from the project's memory: a remembered reference
// image or clip, or a written fact (a character's prompt, the grade). Which of
// those it is decides the type of its `item` output, and the point of showing a
// preview here is that NOTHING HAS TO RUN to find out: the file is already on
// disk, so the answer to "which image is #hero_face again" should not cost a
// Queue Prompt. That is the same argument the collector nodes make for holding
// literal paths.
//
// Two ComfyUI-side routes back this (see __init__.py): /agent/pm_item says what an
// entry holds, and /agent/pm_file serves the media. The file is addressed by ENTRY
// NAME, never by path, so the only things reachable are what the store already
// points at.

const NODE = "AgentYLoadItem";
const PREVIEW_H = 160;

function getWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name) || null;
}

function origin() {
  try { return window.location.origin; } catch (_) { return ""; }
}

function el(tag, style) {
  const e = document.createElement(tag);
  Object.assign(e.style, style || {});
  return e;
}

function buildBox() {
  const box = el("div", {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: "100%", height: "100%", minHeight: "40px", overflow: "hidden",
    borderRadius: "6px", background: "rgba(0,0,0,.25)",
    font: "12px system-ui, sans-serif", color: "#bbb", textAlign: "center",
    padding: "4px", boxSizing: "border-box",
  });
  return box;
}

// What the node shows for the entry currently selected. Called on creation, on a
// configure (a loaded graph), and whenever the dropdown changes.
async function refresh(node) {
  const box = node.__ayPreview;
  if (!box) return;
  const name = String((getWidget(node, "name") || {}).value || "").trim();
  if (!name || name.startsWith("(")) {
    box.replaceChildren(document.createTextNode("nothing stored yet"));
    return;
  }
  // A token per request, so a slow fetch for a previous name cannot land after a
  // faster one for the name that replaced it and leave the wrong picture up.
  const token = (node.__ayToken = (node.__ayToken || 0) + 1);
  box.replaceChildren(document.createTextNode("…"));

  let info = null;
  try {
    const r = await fetch(origin() + "/agent/pm_item?name=" + encodeURIComponent(name),
                          { cache: "no-store" });
    info = await r.json();
  } catch (_) {
    info = null;
  }
  if (token !== node.__ayToken) return;
  if (!info || !info.ok || !info.found) {
    box.replaceChildren(document.createTextNode("no entry called “" + name + "”"));
    return;
  }

  // The URL carries the token as a cache-buster: the path is keyed by NAME, so an
  // entry repointed at a different file would otherwise keep showing the old one.
  const src = origin() + "/agent/pm_file?name=" + encodeURIComponent(name) +
              "&v=" + Date.now();

  if (info.kind === "image") {
    const img = el("img", { maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
                            display: "block" });
    img.src = src;
    img.alt = name;
    img.onerror = () => {
      box.replaceChildren(document.createTextNode("file missing: " + (info.path || "?")));
    };
    box.replaceChildren(img);
    return;
  }
  if (info.kind === "video") {
    const vid = el("video", { maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
                              display: "block" });
    vid.src = src;
    vid.controls = true;
    vid.muted = true;
    vid.loop = true;
    vid.playsInline = true;
    // Wheel over a DOM widget would scrub/scroll instead of zooming the canvas,
    // which is not what a wheel means anywhere else in ComfyUI.
    vid.addEventListener("wheel", (e) => { e.preventDefault(); }, { passive: false });
    vid.onerror = () => {
      box.replaceChildren(document.createTextNode("file missing: " + (info.path || "?")));
    };
    box.replaceChildren(vid);
    return;
  }

  // A written fact has no picture; show its first lines, which is what the entry
  // IS. Cheap, and it answers "which one did I pick" without opening the store.
  const text = el("div", {
    width: "100%", height: "100%", overflow: "hidden", textAlign: "left",
    whiteSpace: "pre-wrap", color: "#ddd", fontSize: "11px", lineHeight: "1.35",
  });
  text.textContent = String(info.text || "").split("\n").slice(0, 6).join("\n");
  box.replaceChildren(text);
}

app.registerExtension({
  name: "agentY.loadItem",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      const node = this;
      node.color = "#3a2a4a";
      node.bgcolor = "#2a2030";
      if (!node.title || node.title === NODE) node.title = "agentY load item";

      const box = buildBox();
      node.__ayPreview = box;
      const w = node.addDOMWidget("preview", "agentY_preview", box, {
        serialize: false,
        hideOnZoom: false,
      });
      if (w) {
        w.serialize = false;
        // Give the widget a floor so a fresh node opens with somewhere to draw,
        // rather than a zero-height strip the user has to find and pull open.
        w.computeLayoutSize = () => ({ minHeight: PREVIEW_H, minWidth: 180 });
      }
      if (!node.size || (node.size[0] === 0 && node.size[1] === 0)) {
        node.size = [260, 260];
      }

      const name = getWidget(node, "name");
      if (name) {
        const orig = name.callback;
        name.callback = function (...args) {
          const rr = orig ? orig.apply(this, args) : undefined;
          refresh(node);
          return rr;
        };
      }
      refresh(node);
      return r;
    };

    const configure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (info) {
      const r = configure ? configure.call(this, info) : undefined;
      // The value arrives during configure, so the preview is asked for after it.
      setTimeout(() => refresh(this), 0);
      return r;
    };
  },
});
