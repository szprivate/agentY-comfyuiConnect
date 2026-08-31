// Where the agentY chat host is, as far as this browser tab is concerned.
//
// Six panels used to answer this each with their own `const DEFAULT_PORT = 5000`
// and an identical backendBase(). The number was only ever right on a default
// Windows install:
//
//   * macOS does not leave 5000 free. ControlCenter's AirPlay Receiver listens on
//     *:5000 on a stock Mac, and it ANSWERS — a 403 from `Server: AirTunes/...`,
//     not a refused connection. So the panel reported the host as down while the
//     host was running perfectly well one port over, and every obvious check said
//     everything was fine.
//   * `--port` on the launcher, AGENTY_UI_PORT, and agent_server_url in the
//     settings files are all server-side. Nothing ever told the browser.
//
// So the port is asked for rather than assumed. /agent/host_info is served by the
// agentY ComfyUI extension on THIS origin — always reachable when ComfyUI is up,
// even when the agentY host is down — and it reports the port the host recorded
// when it last started: the one it actually bound, however that was chosen.

const HOST_INFO_URL = "/agent/host_info";
// A backend pinned by hand (devtools), e.g. "http://192.168.1.5:5001", for a host
// that is not on this machine. Still wins — someone who typed an address means it
// — but see dropStalePin(): it stops winning once it stops answering.
const BACKEND_KEY = "agentY_backend";
// The last port discovery found, remembered so a reload starts out right instead
// of spending its first requests on the fallback.
const PORT_KEY = "agentY_backend_port";
// Only for a tab that has never reached host_info and has nothing remembered.
// Deliberately the Windows number: the Mac case is exactly the one discovery
// fixes, and a wrong guess here is corrected within a moment of the first fetch.
const FALLBACK_PORT = 5000;
// Nothing here may hang. backendReady is awaited by the panel's "is the host up"
// check, so a fetch that never settles would leave the panel deciding forever —
// which looks like a blank panel, not like an error.
const PROBE_MS = 2500;

let discoveredPort = 0;

function rememberedPort() {
  const raw = Number(localStorage.getItem(PORT_KEY));
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 0;
}

function trimSlash(s) {
  return String(s).replace(/\/+$/, "");
}

function discoveredOrigin() {
  return `http://${location.hostname || "127.0.0.1"}:${discoveredPort}`;
}

/** The agentY host's origin. Synchronous, so every existing call site is unchanged. */
export function backendBase() {
  const pinned = localStorage.getItem(BACKEND_KEY);
  if (pinned) return trimSlash(pinned);
  const port = discoveredPort || rememberedPort() || FALLBACK_PORT;
  return `http://${location.hostname || "127.0.0.1"}:${port}`;
}

/** Does a host answer /agentY/health at this origin? Never throws, never hangs. */
async function answers(origin) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_MS);
  try {
    const r = await fetch(trimSlash(origin) + "/agentY/health",
                          { cache: "no-store", signal: ctrl.signal });
    return r.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// A pin that no longer answers is worse than no pin at all: it outranks discovery
// silently and forever, so the panel keeps dialling an address nothing is on
// while every server-side check says the system is healthy. That is not
// hypothetical — the documented way to work around the AirPlay clash was to pin a
// port by hand, and the pin then survived the fix that made it unnecessary.
//
// So a pin has to keep earning it. If it disagrees with discovery AND does not
// answer, it is dropped and said so out loud. A pin that still answers is left
// alone: pointing the panel at a host on another machine is a real thing to want.
async function dropStalePin() {
  const pinned = localStorage.getItem(BACKEND_KEY);
  if (!pinned || !discoveredPort) return;
  if (trimSlash(pinned) === discoveredOrigin()) return;   // agrees; nothing to do
  if (await answers(pinned)) return;                      // still good; respect it
  localStorage.removeItem(BACKEND_KEY);
  console.warn(
    `[agentY] Ignoring localStorage.agentY_backend = ${pinned} — nothing is ` +
    `answering there. The host reports ${discoveredOrigin()}; using that. ` +
    `(The pin has been removed; set it again if you meant it.)`);
}

/** Ask this origin which port the host is on, and remember the answer. */
async function discover() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_MS);
  try {
    const r = await fetch(HOST_INFO_URL, { cache: "no-store", signal: ctrl.signal });
    if (r.ok) {
      const info = await r.json();
      const port = Number(info && info.agent_server_port);
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        discoveredPort = port;
        localStorage.setItem(PORT_KEY, String(port));
      }
    }
  } catch (_) {
    // ComfyUI unreachable, or an extension too old to answer. Neither is worth a
    // console error: the remembered port or the fallback still gives a usable
    // address, and the panel's own health polling reports a host that is really
    // down far better than a failed side-request would.
  } finally {
    clearTimeout(timer);
  }
  try {
    await dropStalePin();
  } catch (_) {
    // Never let tidying up be the reason the panel fails to start.
  }
  console.info(`[agentY] backend: ${backendBase()}`);
}

// Kick off at import so the answer is usually in place before the first panel
// renders. Exported so a caller that must not guess — the chat panel's first
// health poll, which decides whether to show "host is down" — can wait for it.
export const backendReady = discover();
