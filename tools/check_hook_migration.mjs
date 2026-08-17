// Does a canvas saved by an older version still come back meaning the same thing?
//
//     node tools/check_hook_migration.mjs
//
// The hook node's `widgets_values` is POSITIONAL, so the only safe way to read an
// old file is to know which layout wrote it. Getting that wrong is silent and
// permanent — it already happened once, when a "length === 5 means the old
// layout" rule outlived the layout it described and every hook saved afterwards
// came back with its switches shifted by one. Nothing about that failure looks
// like a failure until you notice a hook doing the wrong thing weeks later.
//
// So this drives the REAL web/agent_hook.js through its real path —
// registerExtension -> beforeRegisterNodeDef -> configure — with `app` stubbed,
// since there is no ComfyUI here. Only that one import line is substituted; the
// migration logic under test is the shipped code, byte for byte.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "agent_hook.js");
const captured = [];
globalThis.window = {};
globalThis.__ay = { registerExtension: (e) => captured.push(e) };

const text = readFileSync(SRC, "utf8").replace(
  /^import \{ app \} from .*$/m, "const app = globalThis.__ay;");
const copy = join(mkdtempSync(join(tmpdir(), "ayhook-")), "agent_hook.mjs");
writeFileSync(copy, text, "utf8");
const mod = await import("file://" + copy.replace(/\\/g, "/"));

const ext = captured.find((e) => e.name === "agentY.hookNode");
assert.ok(ext, "the hook extension registered itself");

// Stands in for the node's own layout: one row per visible widget, plus the
// directive's textarea when it is showing. Rough on purpose — what is being
// checked is that hiding the box makes the node shorter, not by how much.
function widgets(purpose) {
  return [
    { name: "directive", value: "" },
    { name: "purpose", value: purpose, callback: null },
    { name: "remember", value: false, options: {} },
  ];
}

function computeSize() {
  const shown = (this.widgets || []).filter((w) => !w.hidden);
  const box = shown.find((w) => w.name === "directive");
  return [300, 30 + shown.length * 24 + (box ? 60 : 0)];
}

function migrate(widgets_values, properties, title) {
  let seen = null;
  const nodeType = function () {};
  nodeType.prototype.configure = function (info) { seen = info; };
  ext.beforeRegisterNodeDef(nodeType, { name: "AgentYHook" });
  const node = {
    widgets: [
      { name: "directive", value: widgets_values[0] },
      { name: "purpose", value: widgets_values[1] },
      { name: "remember", value: false, options: {} },
    ],
    properties: properties || {},
    title: title === undefined ? "agentY hook" : title,
    size: [300, 280],
    setDirtyCanvas() {},
    computeSize,
  };
  nodeType.prototype.configure.call(node, { widgets_values, properties: node.properties });
  return { values: seen.widgets_values, node, box: () => node.widgets[0].value };
}

// A fresh node, then the user picking a different purpose from the combo — the
// path that decides what the node looks like while it is being built, which is
// not the path `migrate` exercises (that one is a graph being loaded).
function fresh(purpose) {
  const nodeType = function () {};
  nodeType.prototype.onNodeCreated = function () {};
  ext.beforeRegisterNodeDef(nodeType, { name: "AgentYHook" });
  const node = {
    widgets: widgets(purpose),
    properties: {},
    size: [300, 280],
    setDirtyCanvas() {},
    computeSize,
  };
  nodeType.prototype.onNodeCreated.call(node);
  node.pick = (next) => {
    const w = node.widgets.find((x) => x.name === "purpose");
    w.value = next;
    w.callback(next);
  };
  node.box = () => node.widgets.find((x) => x.name === "directive");
  return node;
}

const T = [];
const t = (name, fn) => T.push([name, fn]);

// v2 = [directive, purpose, bake, memorize]. One switch on the node wrote BOTH
// fields (the panel sent `freeze: bake`), so the value that meant anything is
// whichever field that purpose actually read. Reading the other one silently
// turns memorizing on for a hook the user only asked to bake, and vice versa.
t("v2 make_workflow keeps the switch it actually read (bake)", () => {
  assert.deepStrictEqual(
    migrate(["do it", "make_workflow", true, false]).values,
    ["do it", "make_workflow", true]);
  assert.deepStrictEqual(
    migrate(["do it", "make_workflow", false, true]).values,
    ["do it", "make_workflow", false], "memorize was not what it read");
});

t("v2 text keeps the switch it actually read (memorize)", () => {
  assert.deepStrictEqual(
    migrate(["do it", "text", false, true]).values, ["do it", "text", true]);
  assert.deepStrictEqual(
    migrate(["do it", "text", true, false]).values,
    ["do it", "text", false], "`freeze: bake` rode along — it must reach nothing");
});

t("the 5-value layout resolves the same way", () => {
  // [directive, purpose, bake_to_canvas, freeze, memorize]
  assert.deepStrictEqual(
    migrate(["d", "make_workflow", true, true, false]).values,
    ["d", "make_workflow", true]);
  assert.deepStrictEqual(
    migrate(["d", "general_request", false, false, true]).values,
    ["d", "general_request", true]);
});

t("string booleans from a widget still count", () => {
  assert.deepStrictEqual(
    migrate(["d", "text", "false", "true"]).values, ["d", "text", true]);
});

t("an already-v3 file is left completely alone", () => {
  const v = ["d", "text", true];
  assert.deepStrictEqual(migrate(v, { agentY_schema: 3 }).values, v);
});

t("the version is stamped so the next load never has to guess", () => {
  assert.strictEqual(migrate(["d", "text", false, true]).node.properties.agentY_schema, 3);
});

t("the label follows the purpose", () => {
  const mk = migrate(["d", "make_workflow", true, false]).node;
  assert.strictEqual(mk.widgets.find((w) => w.name === "remember").label_on,
                     "bake into subgraph");
  const tx = migrate(["d", "text", false, true]).node;
  assert.strictEqual(tx.widgets.find((w) => w.name === "remember").label_on,
                     "memorize result");
});

t("the switch is hidden on the purposes that produce nothing to keep", () => {
  for (const p of ["qa", "iterate"]) {
    const n = migrate(["d", p, false, false]).node;
    assert.strictEqual(n.widgets.find((w) => w.name === "remember").hidden, true, p);
  }
  const n = migrate(["d", "text", false, false]).node;
  assert.strictEqual(n.widgets.find((w) => w.name === "remember").hidden, false);
});

// A review hook is a stop, not a request: there is nothing to instruct, so the
// prompt box is hidden. Which only works if an empty review hook still counts as
// a hook — see hookReaches, and the guard in agent_chat.js that calls it.
t("the prompt box is hidden on review, and nowhere else", () => {
  assert.strictEqual(fresh("review").box().hidden, true);
  for (const p of ["inline_parameter", "make_workflow", "text", "general_request",
                   "iterate", "qa"]) {
    assert.strictEqual(fresh(p).box().hidden, false, p);
  }
});

t("an empty review hook still reaches the agent; every other empty one does not", () => {
  assert.strictEqual(mod.hookReaches("review", ""), true);
  assert.strictEqual(mod.hookReaches("review", "   "), true);
  for (const p of ["inline_parameter", "make_workflow", "text", "qa"]) {
    assert.strictEqual(mod.hookReaches(p, ""), false, p);
    assert.strictEqual(mod.hookReaches(p, "do it"), true, p);
  }
});

t("switching to review shrinks the node, and switching back restores its height", () => {
  const n = fresh("inline_parameter");
  n.size[1] = 340;                     // the user made it roomy
  n.pick("review");
  assert.ok(n.size[1] < 340, `still ${n.size[1]} tall with no box to fill it`);
  n.pick("text");
  assert.strictEqual(n.size[1], 340, "their own height came back, not a computed one");
});

t("a review hook saved before the box was hidden loads compact", () => {
  // The one case where a load SHRINKS a node: the saved height was sized around
  // a box that is no longer drawn.
  const { node } = migrate(["", "review", false], { agentY_schema: 3 });
  assert.strictEqual(node.widgets.find((w) => w.name === "directive").hidden, true);
  assert.ok(node.size[1] < 280, `loaded ${node.size[1]} tall`);
});

// A question typed into the box before it was hidden would otherwise be stranded
// there: invisible, uneditable, and still the thing the agent asks.
t("a leftover question moves to the title, where it can be seen and changed", () => {
  const m = migrate(["which two read best as a wide?", "review", false], { agentY_schema: 3 });
  assert.strictEqual(m.node.title, "which two read best as a wide?");
  assert.strictEqual(m.box(), "", "and is not left behind in the box as well");
});

t("a hook the user named keeps its name", () => {
  const m = migrate(["which two?", "review", false], { agentY_schema: 3 }, "the big choice");
  assert.strictEqual(m.node.title, "the big choice");
  assert.strictEqual(m.box(), "which two?", "left where it is rather than dropped");
});

t("a paragraph is not a title, and is left alone", () => {
  const long = "pick the ones where the light matches ".repeat(3);
  const m = migrate([long, "review", false], { agentY_schema: 3 });
  assert.strictEqual(m.node.title, "agentY hook");
  assert.strictEqual(m.box(), long);
});

t("nothing is promoted on any other purpose", () => {
  for (const p of ["inline_parameter", "make_workflow", "text", "qa"]) {
    const m = migrate(["do it", p, false], { agentY_schema: 3 });
    assert.strictEqual(m.node.title, "agentY hook", p);
    assert.strictEqual(m.box(), "do it", p);
  }
});

t("a normal hook's saved height is still never shrunk", () => {
  const { node } = migrate(["d", "text", false], { agentY_schema: 3 });
  assert.strictEqual(node.size[1], 280);
});

t("a node that arrives already set to review is compact from the start", () => {
  // Pasted, or dropped on the canvas by the agent: no purpose change to react to.
  assert.ok(fresh("review").size[1] < 280);
  assert.strictEqual(fresh("text").size[1], 280, "and an ordinary one is untouched");
});

let bad = 0;
for (const [name, fn] of T) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { bad++; console.log("  FAIL " + name + "\n       " + e.message); }
}
console.log(`\n${T.length - bad}/${T.length} passed`);
process.exit(bad ? 1 : 0);
