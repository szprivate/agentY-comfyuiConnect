// agent_combo.js
// A model dropdown you can type into: click it, type part of a model's name, and
// the list shows only what matches (with its vendor headings); arrows move,
// Enter picks, Esc leaves it as it was.
//
// The native <select> stays underneath as the one source of truth, hidden: its
// `value`, `disabled`, options and `change` event keep working for the code that
// already builds, reads and listens to it. The box only shows it and writes it —
// a pick sets select.value and fires `change`, exactly as choosing from the
// native list would. Options are read from the select each time the list opens,
// so a select rebuilt later (a model list refreshed from the host) needs nothing.

const STYLE_ID = "agentY-combo-styles";

function injectStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const css = `
  .ay-combo{position:relative;display:inline-flex;align-items:center;min-width:0;cursor:text;}
  .ay-combo > select{display:none !important;}
  .ay-combo-input{flex:1;min-width:0;width:100%;background:transparent;border:none;outline:none;
    color:inherit;font:inherit;padding:0;margin:0;text-overflow:ellipsis;}
  .ay-combo-input::placeholder{color:#8a909b;opacity:1;}
  .ay-combo-input:disabled{cursor:not-allowed;}
  .ay-combo-caret{flex:0 0 auto;margin-left:6px;color:#8a909b;font-size:10px;cursor:pointer;user-select:none;}
  .ay-combo.ay-combo-disabled{opacity:.45;cursor:not-allowed;}
  .ay-combo-list{position:fixed;z-index:100000;max-height:320px;overflow-y:auto;background:#1e2128;
    border:1px solid #3a4150;border-radius:7px;box-shadow:0 8px 24px rgba(0,0,0,.45);padding:4px 0;
    font:12.5px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6e8ec;}
  .ay-combo-group{padding:6px 10px 3px;color:#8a909b;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;}
  .ay-combo-item{padding:5px 10px 5px 16px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .ay-combo-item.ay-combo-cur{color:#9db6ff;}
  .ay-combo-item.ay-combo-act{background:rgba(111,151,255,.22);}
  .ay-combo-item mark{background:none;color:#ffd479;font-weight:600;}
  .ay-combo-none{padding:8px 12px;color:#8a909b;}
  `;
  const s = doc.createElement("style");
  s.id = STYLE_ID;
  s.textContent = css;
  doc.head.append(s);
}

// The select's options as [{value, label, group}], in order.
function readOptions(select) {
  const out = [];
  for (const o of select.options) {
    const g = o.parentElement && o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label : "";
    out.push({ value: o.value, label: o.textContent, group: g });
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// The label with every searched word highlighted.
function highlight(label, words) {
  if (!words.length) return escapeHtml(label);
  const low = label.toLowerCase();
  const marks = new Array(label.length).fill(false);
  for (const w of words) {
    let i = low.indexOf(w);
    while (i >= 0) { for (let k = i; k < i + w.length; k++) marks[k] = true; i = low.indexOf(w, i + w.length); }
  }
  let html = "", open = false;
  for (let i = 0; i < label.length; i++) {
    if (marks[i] && !open) { html += "<mark>"; open = true; }
    if (!marks[i] && open) { html += "</mark>"; open = false; }
    html += escapeHtml(label[i]);
  }
  return html + (open ? "</mark>" : "");
}

/**
 * Make a <select> searchable. Returns the element to put where the select
 * would have gone (the select moves inside it, hidden). The box takes the
 * select's classes, so the field styling that applied to the select applies to
 * the box. `placeholder` is what an empty search box says.
 */
export function searchableSelect(select, { placeholder = "Type to filter…" } = {}) {
  const doc = select.ownerDocument || document;
  injectStyles(doc);
  const wrap = doc.createElement("span");
  wrap.className = `${select.className} ay-combo`.trim();
  if (select.title) wrap.title = select.title;
  const input = doc.createElement("input");
  input.type = "text";
  input.className = "ay-combo-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  const caret = doc.createElement("span");
  caret.className = "ay-combo-caret";
  caret.textContent = "▾";
  wrap.append(select, input, caret);

  let list = null, items = [], active = -1, isOpen = false;

  const current = () => {
    const o = select.options[select.selectedIndex];
    return o ? { value: o.value, label: o.textContent } : { value: "", label: "" };
  };
  // Closed, the box shows the choice — an empty value (a "switch model…" or an
  // "inherit" entry) as a greyed placeholder rather than as text.
  const showCurrent = () => {
    if (isOpen) return;
    const c = current();
    input.value = c.value ? c.label : "";
    input.placeholder = c.value ? "" : (c.label || placeholder);
    const off = !!select.disabled;
    input.disabled = off;
    wrap.classList.toggle("ay-combo-disabled", off);
  };

  const position = () => {
    if (!list) return;
    const r = wrap.getBoundingClientRect();
    const win = doc.defaultView || window;
    const below = win.innerHeight - r.bottom;
    list.style.left = `${Math.max(4, r.left)}px`;
    list.style.minWidth = `${Math.max(220, r.width)}px`;
    list.style.maxWidth = `${Math.max(320, win.innerWidth - r.left - 8)}px`;
    if (below < 200 && r.top > below) {
      list.style.top = "";
      list.style.bottom = `${win.innerHeight - r.top + 2}px`;
      list.style.maxHeight = `${Math.min(320, r.top - 8)}px`;
    } else {
      list.style.bottom = "";
      list.style.top = `${r.bottom + 2}px`;
      list.style.maxHeight = `${Math.min(320, below - 8)}px`;
    }
  };

  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const cur = select.value;
    const all = readOptions(select);
    const hits = all.filter((o) => {
      const hay = `${o.group} ${o.label} ${o.value}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    list.innerHTML = "";
    items = [];
    let lastGroup = null;
    for (const o of hits) {
      if (o.group !== lastGroup) {
        lastGroup = o.group;
        if (o.group) {
          const g = doc.createElement("div");
          g.className = "ay-combo-group";
          g.textContent = o.group;
          list.append(g);
        }
      }
      const it = doc.createElement("div");
      it.className = "ay-combo-item" + (o.value === cur ? " ay-combo-cur" : "");
      it.innerHTML = highlight(o.label, words);
      if (o.value && o.value !== o.label) it.title = o.value;
      // mousedown, not click: the search box must keep the focus until the pick.
      it.addEventListener("mousedown", (e) => { e.preventDefault(); pick(o.value); });
      it.addEventListener("mousemove", () => setActive(items.indexOf(entry)));
      const entry = { el: it, value: o.value };
      items.push(entry);
      list.append(it);
    }
    if (!items.length) {
      const none = doc.createElement("div");
      none.className = "ay-combo-none";
      none.textContent = "No model matches";
      list.append(none);
    }
    // With a search, the first match is ready for Enter; without one, the choice.
    const start = words.length ? 0 : items.findIndex((i) => i.value === cur);
    setActive(Math.max(0, start), true);
  };

  const setActive = (i, scroll) => {
    if (items[active]) items[active].el.classList.remove("ay-combo-act");
    active = items.length ? Math.max(0, Math.min(items.length - 1, i)) : -1;
    if (items[active]) {
      items[active].el.classList.add("ay-combo-act");
      if (scroll) items[active].el.scrollIntoView({ block: "nearest" });
    }
  };

  const onScroll = (e) => { if (list && !list.contains(e.target)) position(); };
  const open = () => {
    if (isOpen || select.disabled) return;
    isOpen = true;
    const c = current();
    input.value = "";
    input.placeholder = c.value ? c.label : placeholder;
    list = doc.createElement("div");
    list.className = "ay-combo-list";
    list.addEventListener("mousedown", (e) => e.preventDefault());
    doc.body.append(list);
    render();
    position();
    const win = doc.defaultView || window;
    win.addEventListener("resize", position);
    doc.addEventListener("scroll", onScroll, true);
  };
  const close = () => {
    if (!isOpen) return;
    isOpen = false;
    if (list) list.remove();
    list = null;
    items = [];
    active = -1;
    const win = doc.defaultView || window;
    win.removeEventListener("resize", position);
    doc.removeEventListener("scroll", onScroll, true);
    showCurrent();
  };
  const pick = (value) => {
    const changed = select.value !== value;
    select.value = value;
    close();
    input.blur();
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  input.addEventListener("focus", open);
  input.addEventListener("mousedown", () => { if (doc.activeElement === input && !isOpen) open(); });
  input.addEventListener("input", () => { if (!isOpen) open(); render(); });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    // Typing here is a search, not a ComfyUI shortcut.
    e.stopPropagation();
    if (!isOpen && (e.key === "ArrowDown" || e.key === "Enter")) { open(); e.preventDefault(); return; }
    if (!isOpen) return;
    if (e.key === "ArrowDown") { setActive(active + 1, true); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setActive(active - 1, true); e.preventDefault(); }
    else if (e.key === "PageDown") { setActive(active + 10, true); e.preventDefault(); }
    else if (e.key === "PageUp") { setActive(active - 10, true); e.preventDefault(); }
    else if (e.key === "Enter") { if (items[active]) pick(items[active].value); e.preventDefault(); }
    else if (e.key === "Escape") { close(); input.blur(); e.preventDefault(); }
  });
  input.addEventListener("keyup", (e) => e.stopPropagation());
  caret.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (isOpen) { close(); input.blur(); } else input.focus();
  });
  wrap.addEventListener("mousedown", (e) => {
    if (e.target === wrap) { e.preventDefault(); input.focus(); }
  });

  // Keep the box in step with the select, whoever changes it: a pick, code
  // setting .value or .selectedIndex, the options being rebuilt, disabled.
  select.addEventListener("change", showCurrent);
  const proto = Object.getPrototypeOf(select);
  for (const prop of ["value", "selectedIndex"]) {
    let d = null;
    for (let p = proto; p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, prop);
    if (!d || !d.set) continue;
    Object.defineProperty(select, prop, {
      configurable: true,
      get() { return d.get.call(this); },
      set(v) { d.set.call(this, v); showCurrent(); },
    });
  }
  new MutationObserver(() => { showCurrent(); if (isOpen && list) render(); })
    .observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });

  showCurrent();
  return wrap;
}
