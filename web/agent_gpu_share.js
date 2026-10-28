import { app } from "../../scripts/app.js";
import { backendBase } from "./agent_backend.js";

// One graphics card for ComfyUI and a local model server (Strata).
//
// Strata holds the whole card while it runs, and a render beside it starves -
// both crawl. Graphs the agentY host queues itself pass its own check; a graph
// queued from this page (the Queue button, the panel's prompt loop) does not reach
// the host. So before app.queuePrompt the host is asked (POST /agentY/strata/yield)
// to send Strata away when a model the agent uses runs on it. It answers at once
// when Strata is not used, and is a no-op when the host is not running. The model
// starts again with the agent's next call, once the queue is empty.
//
// Never blocks the queue for good: after STOP_WAIT_MS the graph is queued anyway.
// "Not used" and "host not reachable" are remembered for SKIP_MS, so a Queue click
// on a machine without Strata (or with the host down) costs nothing most times.

const STOP_WAIT_MS = 180000;
const SKIP_MS = 30000;
let skipUntil = 0;

async function strataYield() {
  if (Date.now() < skipUntil) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STOP_WAIT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(backendBase() + "/agentY/strata/yield", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!j || !j.used) skipUntil = Date.now() + SKIP_MS;
    if (j && j.used && j.stopped && Date.now() - t0 > 1500) {
      app.extensionManager?.toast?.add?.({
        severity: "info", summary: "agentY",
        detail: "The local model (Strata) was stopped so this render has the GPU. It starts again with the agent's next call.",
        life: 6000,
      });
    }
  } catch (_) {
    // Host down, or the stop took too long: queue anyway.
    if (Date.now() - t0 < STOP_WAIT_MS) skipUntil = Date.now() + SKIP_MS;
  } finally {
    clearTimeout(timer);
  }
}

app.registerExtension({
  name: "agentY.gpuShare.strata",
  async setup() {
    const orig = app.queuePrompt;
    if (typeof orig !== "function" || orig.__ayGpuShare) return;
    const wrapped = async function () {
      await strataYield();
      return orig.apply(this, arguments);
    };
    wrapped.__ayGpuShare = true;
    app.queuePrompt = wrapped;
  },
});
