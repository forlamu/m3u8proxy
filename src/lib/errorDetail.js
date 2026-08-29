// Turn ANY thrown/rejected value into one short single-line string.
//
// Every error-logging path routes through here so no code path can dump a
// raw error object: an axios error carries config/request (hundreds of
// lines), and an AggregateError has an EMPTY .message, so a bare
// `err?.message || err` falls through to dumping the whole object —
// silently defeating the [stats] 100-line cap this service relies on for
// disk safety.
//
// Pure, zero imports, zero side effects. The entire body sits inside an
// outer try/catch: the catch returns a fixed literal and performs NO
// property access on the input, so this function can never throw.
export default function errorDetail(err) {
  try {
    if (err === null) return "null";
    if (err === undefined) return "undefined";
    if (typeof err === "string") {
      return err.slice(0, 300) || "(empty string)";
    }
    if (typeof err !== "object") return String(err).slice(0, 300);

    const parts = [];
    if (typeof err.name === "string" && err.name) parts.push(err.name);
    if (typeof err.code === "string" && err.code) parts.push(err.code);
    else if (typeof err.code === "number") parts.push(String(err.code));
    const status = err.response && err.response.status;
    if (typeof status === "number") parts.push("status=" + status);
    if (typeof err.message === "string" && err.message) {
      parts.push(err.message.split("\n")[0].slice(0, 300));
    }
    // AggregateError: .message is usually empty; the useful detail is the
    // nested per-attempt codes (e.g. ETIMEDOUT twice for v4+v6 attempts).
    if (Array.isArray(err.errors) && err.errors.length) {
      const codes = err.errors.slice(0, 5).map((e) => {
        try {
          return String((e && (e.code || e.message)) || "?").slice(0, 80);
        } catch (_) {
          return "?";
        }
      });
      parts.push("errors=[" + codes.join(",") + "]");
    }
    return parts.length ? parts.join(" ") : "(unrecognized error object)";
  } catch (_) {
    return "(unprintable error)";
  }
}
