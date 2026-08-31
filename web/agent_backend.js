// Where the agentY chat host is, as far as this browser tab is concerned.
//
// Six panels used to answer this each with their own `const DEFAULT_PORT = 5000`
// and an identical backendBase(). The number was never right anywhere but a
// default Windows install:
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
// Set by hand (devtools) to pin a backend — a full origin such as
// "http://127.0.0.1:5001". Still wins over everything: someone who typed an
// address means it. Delete the key to go back to following the host.
const BACKEND_KEY = "agentY_backend";
// The last port discovery found, remembered so a reload starts out right instead
// of spending its first requests on the fallback.
const PORT_KEY = "agentY_backend_port";
// Only for a tab that has never reached host_info and has nothing remembered.
// Deliberately the Windows number: the Mac case is exactly the one discovery
// fixes, and a wrong guess here is corrected within a moment of the first fetch.
const FALLBACK_PORT = 5000;

let discoveredPort = 0;

function rememberedPort() {
  const raw = Number(localStorage.getItem(PORT_KEY));
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 0;
}

/** The agentY host's origin. Synchronous, so every existing call site is unchanged. */
export function backendBase() {
  const pinned = localStorage.getItem(BACKEND_KEY);
  if (pinned) return pinned;
  const port = discoveredPort || rememberedPort() || FALLBACK_PORT;
  return `http://${location.hostname || "127.0.0.1"}:${port}`;
}

/** Ask this origin which port the host is on, and remember the answer. */
async function discover() {
  try {
    const r = await fetch(HOST_INFO_URL, { cache: "no-store" });
    if (!r.ok) return;
    const info = await r.json();
    const port = Number(info && info.agent_server_port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return;
    discoveredPort = port;
    localStorage.setItem(PORT_KEY, String(port));
  } catch {
    // ComfyUI unreachable, or an extension too old to answer. Neither is worth a
    // console error: the remembered port or the fallback still gives a usable
    // address, and the panel's own health polling reports a host that is really
    // down far better than a failed side-request would.
  }
}

// Kick off at import so the answer is usually in place before the first panel
// renders. Exported so a caller that must not guess — the chat panel's first
// health poll, which decides whether to show "host is down" — can wait for it.
export const backendReady = discover();
