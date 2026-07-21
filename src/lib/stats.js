import dotenv from "dotenv";

dotenv.config();

// Lightweight, disk-safe request accounting.
//
// One episode watched is ~240 segment requests, so a stdout line per request
// would put hundreds of thousands of lines a day on the VPS disk. Instead we
// keep plain integer counters in memory and flush ONE summary line on an
// interval, skipping the flush entirely while idle.
//
// This is a single node process (no cluster, no worker_threads), so these
// counters are global and complete. They are per-interval DELTAS, not
// cumulative totals, and they reset on every redeploy — that is expected.

const FLUSH_MS = Number(process.env.STATS_INTERVAL_MS) || 60000;

// Cap on distinct hosts tracked per interval. The proxy is publicly reachable
// and takes an arbitrary ?url=, so an unbounded map is a memory risk.
const MAX_HOSTS = 200;

// Cap on per-error stdout lines per interval, so a mass upstream outage can't
// turn the error path into the disk-filler this module exists to avoid.
const MAX_ERROR_LINES = 100;

// Connection-failure codes we name explicitly. ENOTFOUND (permanent DNS
// failure) and ECONNREFUSED are the ones actually observed in testing —
// without them the most common failures all collapse into "other" and the
// breakdown stops being useful. ECONNABORTED is what axios reports on its
// own timeout.
const ERROR_CODES = [
  "ETIMEDOUT",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "other",
];

function blankRoute() {
  return {
    total: 0,
    s2xx: 0,
    s3xx: 0,
    s4xx: 0,
    s5xx: 0,
    sother: 0,
    err: {
      ETIMEDOUT: 0,
      ECONNABORTED: 0,
      ECONNREFUSED: 0,
      ECONNRESET: 0,
      ENOTFOUND: 0,
      EAI_AGAIN: 0,
      ENETUNREACH: 0,
      other: 0,
    },
  };
}

let routes = {
  "/m3u8-proxy": blankRoute(),
  "/ts-proxy": blankRoute(),
};

// Hosts we could NOT CONNECT to. Deliberately excludes hosts that answered
// with a bad HTTP status — see recordError().
let hostErrors = Object.create(null);
let hostCount = 0;

let errorLines = 0;
let suppressedLines = 0;

function bumpStatus(route, status) {
  const s = Number(status);
  if (s >= 200 && s < 300) route.s2xx++;
  else if (s >= 300 && s < 400) route.s3xx++;
  else if (s >= 400 && s < 500) route.s4xx++;
  else if (s >= 500 && s < 600) route.s5xx++;
  else route.sother++;
}

function bumpHost(host) {
  let key = host || "unknown";
  if (hostErrors[key] === undefined && hostCount >= MAX_HOSTS) {
    key = "other";
  }
  if (hostErrors[key] === undefined) {
    hostErrors[key] = 0;
    hostCount++;
  }
  hostErrors[key]++;
}

// Extract a hostname for grouping without ever throwing on a malformed url.
export function hostOf(url) {
  try {
    return new URL(url).hostname || "unknown";
  } catch (_) {
    return "unparsed";
  }
}

// The upstream answered. Covers success AND upstream 4xx/5xx.
export function recordStatus(route, status) {
  try {
    const r = routes[route];
    if (!r) return;
    r.total++;
    bumpStatus(r, status);
  } catch (_) {
    // Accounting must never break a request.
  }
}

// A request that ended in the error path. Two very different failure types,
// counted separately on purpose:
//
//   err.response present  -> the host answered with a bad HTTP status
//                            (404/403/5xx). A content problem, not a
//                            reachability problem. Counted in the status
//                            class buckets ONLY, kept OUT of the host map so
//                            a title serving 200 missing-segment 404s can't
//                            drown the signal.
//
//   err.response absent   -> a true connection failure (DNS, timeout, reset).
//                            Counted in the error-code bucket AND the host
//                            map. This is the escalation signal: which hosts
//                            we could not reach at all.
export function recordError(route, err, host) {
  try {
    const r = routes[route];
    if (!r) return;
    r.total++;

    const status = err && err.response && err.response.status;
    if (typeof status === "number") {
      bumpStatus(r, status);
      return;
    }

    const code = err && err.code;
    const key = Object.prototype.hasOwnProperty.call(r.err, code)
      ? code
      : "other";
    r.err[key]++;
    bumpHost(host);
  } catch (_) {
    // Accounting must never break a request.
  }
}

// Rate limit for the per-error stdout lines.
export function shouldLogError() {
  try {
    if (errorLines < MAX_ERROR_LINES) {
      errorLines++;
      return true;
    }
    suppressedLines++;
    return false;
  } catch (_) {
    return false;
  }
}

function fmtRoute(r) {
  const parts = [`n=${r.total}`];
  if (r.s2xx) parts.push(`2xx=${r.s2xx}`);
  if (r.s3xx) parts.push(`3xx=${r.s3xx}`);
  if (r.s4xx) parts.push(`4xx=${r.s4xx}`);
  if (r.s5xx) parts.push(`5xx=${r.s5xx}`);
  if (r.sother) parts.push(`other=${r.sother}`);

  let errTotal = 0;
  for (const c of ERROR_CODES) errTotal += r.err[c];
  if (errTotal) {
    parts.push(`err=${errTotal}`);
    for (const c of ERROR_CODES) {
      if (r.err[c]) parts.push(`${c}=${r.err[c]}`);
    }
  }
  return `{${parts.join(" ")}}`;
}

function fmtHosts() {
  const entries = Object.keys(hostErrors)
    .map((h) => [h, hostErrors[h]])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (!entries.length) return "";
  return ` hosts:{${entries.map(([h, n]) => `${h}=${n}`).join(" ")}}`;
}

function flush() {
  try {
    const m = routes["/m3u8-proxy"];
    const t = routes["/ts-proxy"];

    // Idle interval — stay silent.
    if (m.total === 0 && t.total === 0 && suppressedLines === 0) {
      return;
    }

    const suppressed = suppressedLines
      ? ` suppressed_err_lines=${suppressedLines}`
      : "";

    console.log(
      `[stats] ${Math.round(FLUSH_MS / 1000)}s m3u8:${fmtRoute(m)} ts:${fmtRoute(
        t
      )}${fmtHosts()}${suppressed}`
    );
  } catch (e) {
    console.error("[stats] flush failed:", e?.message || e);
  } finally {
    routes = {
      "/m3u8-proxy": blankRoute(),
      "/ts-proxy": blankRoute(),
    };
    hostErrors = Object.create(null);
    hostCount = 0;
    errorLines = 0;
    suppressedLines = 0;
  }
}

const timer = setInterval(flush, FLUSH_MS);
// Never hold the process open at shutdown.
if (typeof timer.unref === "function") timer.unref();
