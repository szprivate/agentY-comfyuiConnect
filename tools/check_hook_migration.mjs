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
await import("file://" + copy.replace(/\\/g, "/"));

const ext = captured.find((e) => e.name === "agentY.hookNode");
assert.ok(ext, "the hook extension registered itself");

function migrate(widgets_values, properties) {
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
    size: [300, 280],
    setDirtyCanvas() {},
  };
  nodeType.prototype.configure.call(node, { widgets_values, properties: node.properties });
  return { values: seen.widgets_values, node };
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

let bad = 0;
for (const [name, fn] of T) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { bad++; console.log("  FAIL " + name + "\n       " + e.message); }
}
console.log(`\n${T.length - bad}/${T.length} passed`);
process.exit(bad ? 1 : 0);
