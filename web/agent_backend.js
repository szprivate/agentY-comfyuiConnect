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

import { showNotice, clearNotices } from "./agent_notice.js";

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
// Every call to the host carries this. The host mints it per start and hands it
// to us through ComfyUI — an origin that refuses cross-site requests, so no other
// page can ask for it. Without it the host answers 403, which is the point: the
// Origin check is only as honest as the caller's browser, and a script on this
// machine has no browser to be honest for it.
const TOKEN_HEADER = "X-AgentY-Token";
// Endpoints the host answers without a token, mirrored from api_guard.PUBLIC_PATHS.
// They are the reason a refusal is invisible: /agentY/health keeps returning 200
// while everything else is refused, so the panel reports the host as up — and a
// "recovered" test that trusted any 200 would clear the warning on the very next
// heartbeat, a fraction of a second after raising it.
const PUBLIC_PATHS = [
  "/agentY/health", "/agentY/log_viewer", "/agentY/memory_viewer",
  "/agentY/project_memory_viewer",
];

function needsToken(url) {
  try {
    const path = new URL(url, location.origin).pathname;
    return !PUBLIC_PATHS.includes(path);
  } catch (_) {
    return true;
  }
}

// Captured BEFORE the wrapper below replaces window.fetch. Everything in this
// file talks to the host to work out where the host is and whether it is up — if
// those calls went through the wrapper they would wait on backendReady, which is
// the promise they are in the middle of resolving.
const realFetch = window.fetch.bind(window);

let discoveredPort = 0;
let sessionToken = "";
let lastAnnounced = "";

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
    const r = await realFetch(trimSlash(origin) + "/agentY/health",
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
    const r = await realFetch(HOST_INFO_URL, { cache: "no-store", signal: ctrl.signal });
    if (r.ok) {
      const info = await r.json();
      const port = Number(info && info.agent_server_port);
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        discoveredPort = port;
        localStorage.setItem(PORT_KEY, String(port));
      }
      // Deliberately NOT remembered in localStorage. It changes on every host
      // restart, so a stored copy is wrong more often than right — and the whole
      // reason this file exists is a stale pinned value that outlived its truth.
      sessionToken = String((info && info.session_token) || "");
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
  // Only when it changes. discover() re-runs on every 403 to refresh the token,
  // so logging unconditionally turned one line per page load into one per failed
  // request — the console equivalent of the banner problem.
  const now = backendBase();
  if (now !== lastAnnounced) {
    lastAnnounced = now;
    console.info(`[agentY] backend: ${now}`);
  }
}

// Kick off at import so the answer is usually in place before the first panel
// renders. Exported so a caller that must not guess — the chat panel's first
// health poll, which decides whether to show "host is down" — can wait for it.
export const backendReady = discover();

/** The host's session token, once discovery has run. "" before that, or if the
 *  host has never started on this machine. */
export function backendToken() {
  return sessionToken;
}

// Every request to the host must carry the token, and there are around fifty call
// sites across a dozen panels — plus whatever gets written next. Adding a header
// at each one guarantees that one of them will be missed, and a missed one is not
// a small bug: it is a panel that half works, failing with a 403 that reads like
// the host is broken.
//
// So it goes on at the one place every request already passes through. The test
// is the path, not the origin: "/agentY/" is this host's namespace and nothing
// else on the page uses it, so ComfyUI's own traffic is untouched — which matters,
// because this is a global patch and the rest of ComfyUI did not ask for it.
//
// Awaiting backendReady is what makes a panel that renders before discovery
// finishes still work. It always settles: discover() bounds both its fetches and
// swallows every failure.
(function installTokenHeader() {
  const real = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    let url = "";
    try {
      url = typeof input === "string" ? input : (input && input.url) || "";
    } catch (_) {
      url = "";
    }
    if (!url.includes("/agentY/")) return real(input, init);

    try {
      await backendReady;
    } catch (_) {
      // Discovery failing is not a reason to drop the request: the host may be
      // reachable at the remembered port with no token required.
    }

    // A TAB IS ALWAYS OLDER THAN THE TOKEN.
    //
    // The host mints a new one every time it starts, and this page read
    // /agent/host_info once, at load — which is before the host was started, or
    // before its last restart, or both. Having no token, or a token from a
    // previous host, is therefore the NORMAL state of a freshly opened panel, not
    // a fault.
    //
    // The first version treated an empty token as "nothing to add" and sent the
    // request bare. That skipped the retry below with it, so the panel 403'd
    // every request forever, said nothing on screen, and could only be fixed by
    // the reload it never asked for. Refresh instead: ComfyUI is same-origin and
    // up (it served this page), so asking it again is cheap and almost always
    // works.
    if (!sessionToken && needsToken(url)) await refreshToken();

    const send = () => {
      const opts = Object.assign({}, init);
      const headers = new Headers(
        (init && init.headers) ||
        (typeof input !== "string" && input && input.headers) || undefined);
      if (sessionToken) headers.set(TOKEN_HEADER, sessionToken);
      opts.headers = headers;
      return real(input, opts);
    };

    let res = await send();
    if (res.status !== 403) return settled(res, url);

    // Refused. Either the token is from a host that has since restarted, or we
    // had none. Both are fixed by asking ComfyUI again — once. A second 403 with
    // a token we just fetched is a real refusal, not a stale value.
    const stale = sessionToken;
    await refreshToken(true);
    if (sessionToken && sessionToken !== stale) {
      res = await send();
      if (res.status !== 403) return settled(res, url);
    }
    await announceRefusal(url, res);
    return res;
  };

  function settled(res, url) {
    // Recovered — but only a request that HAD to carry a token proves it. The
    // health poll answers 200 throughout a total lockout, so counting it would
    // clear the warning on the next heartbeat and leave the panel silent again.
    if (refusal && needsToken(url)) {
      refusal = "";
      clearNotices();
    }
    return res;
  }
})();

// Ask ComfyUI for the host's current token.
//
// Rate-limited and de-duplicated, because the two callers above are on the hot
// path: without this, a host that never returns a token (an extension older than
// this one) would mean a /agent/host_info round trip in front of every single
// request the panel makes.
let refreshAt = 0;
let refreshing = null;
const REFRESH_MS = 2000;

async function refreshToken(force = false) {
  const now = Date.now();
  if (!force && now - refreshAt < REFRESH_MS) return;
  if (refreshing) return refreshing;
  refreshAt = now;
  refreshing = discover().finally(() => { refreshing = null; });
  return refreshing;
}

// The host's own explanation of its last refusal, or "" when it is answering.
// Read by the chat panel, which otherwise shows "host offline" and a Start server
// button for what is really an authentication problem.
let refusal = "";

/** Why the host is refusing us, in its own words. "" when nothing is wrong. */
export function hostRefusal() {
  return refusal;
}

// A 403 a freshly fetched token could not fix.
//
// This has to reach the screen, not the console. /agentY/health is deliberately
// reachable without a token, so the panel goes on reporting the host as UP while
// every button quietly does nothing — the one symptom that points away from the
// cause. Nobody debugs a ComfyUI sidebar with devtools open.
//
// The host's own sentence is shown verbatim. It already says which of the three
// checks refused and what to do about it; this side knows none of that, and a
// message written here would be a guess that is wrong on the day it matters.
async function announceRefusal(url, res) {
  let detail = "";
  try {
    // clone(): the caller still has to be able to read this body.
    const data = await res.clone().json();
    detail = String((data && data.error) || "");
  } catch (_) {
    detail = "";
  }
  if (!detail) {
    detail = `The agentY host refused ${url} and did not say why. It may be an ` +
             "older version than this ComfyUI extension.";
  }
  console.warn(`[agentY] refused ${url} (403): ${detail}`);
  refusal = detail;
  showNotice("agentY host refused a request", detail, [
    { label: "Reload ComfyUI", onClick: () => location.reload() },
  ]);
}
