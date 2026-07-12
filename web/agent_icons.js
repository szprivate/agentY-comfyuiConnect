// agentY panel icons. The button→icon assignments live in the sibling
// iconsUI.json; this helper fetches that map once and swaps a button's emoji/text
// for the assigned inline Lucide SVG (MIT/ISC path data embedded in the JSON, so
// nothing loads from a CDN — CSP-safe and works offline). Every icon uses
// `currentColor`, so it follows the button's text colour automatically.
//
// Buttons keep their emoji/text as a fallback until the icons load, and forever if
// the fetch fails, so the panel is never blank. setButtonIcon() is idempotent and
// safe to call repeatedly (used to swap Send ↔ Stop).

let CFG = null;

// Resolve iconsUI.json as a sibling of this module, so it works no matter what
// path the extension is mounted under.
export const iconsReady = fetch(new URL("./iconsUI.json", import.meta.url), { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => { CFG = d; return d; })
  .catch(() => null);

// Build an <svg> string for a raw icon name (a key in iconsUI.json "icons").
export function iconSvg(iconName, size = 17) {
  if (!CFG) return null;
  const inner = (CFG.icons || {})[iconName];
  if (!inner) return null;
  const vb = CFG.viewBox || "0 0 24 24";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${vb}" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
  );
}

// Assign an icon to a button by its semantic key (a key in iconsUI.json
// "buttons"). `fallback` (emoji/text) shows until icons load or if the key is
// unmapped; `label` (optional) renders as text beside the icon. Stores its inputs
// on the element so applyIcons() can re-render after the async load.
export function setButtonIcon(elm, key, fallback, label) {
  if (!elm) return;
  if (key != null) elm.dataset.ayIcon = key;
  if (fallback != null) elm.dataset.ayFallback = fallback;
  if (label != null) elm.dataset.ayLabel = label;
  const name = CFG && (CFG.buttons || {})[elm.dataset.ayIcon];
  const svg = name ? iconSvg(name) : null;
  if (svg) {
    const lbl = elm.dataset.ayLabel;
    elm.innerHTML = svg + (lbl ? `<span class="ay-btn-label">${lbl}</span>` : "");
    elm.classList.add("ay-icon-btn");
  } else if (elm.dataset.ayFallback != null) {
    elm.textContent = elm.dataset.ayFallback;
    elm.classList.remove("ay-icon-btn");
  }
}

// Re-render every [data-ay-icon] button under `root`; call once icons load.
export function applyIcons(root) {
  if (!root) return;
  root.querySelectorAll("[data-ay-icon]").forEach((elm) =>
    setButtonIcon(elm, elm.dataset.ayIcon, elm.dataset.ayFallback, elm.dataset.ayLabel));
}
