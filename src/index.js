import server from "./lib/server.js";
import errorDetail from "./lib/errorDetail.js";

// Last-resort safety net: a stray unhandled error (e.g. a transient upstream
// DNS failure) must never take the whole proxy down. Log it and keep serving.
// A real Error's stack is a bounded, genuinely useful string — keep it; any
// other thrown/rejected value goes through errorDetail() so nothing here can
// ever dump a raw object.
process.on("uncaughtException", (err) => {
  console.error(
    "Uncaught exception (kept alive):",
    typeof err?.stack === "string" ? err.stack : errorDetail(err)
  );
});

process.on("unhandledRejection", (reason) => {
  console.error(
    "Unhandled rejection (kept alive):",
    typeof reason?.stack === "string" ? reason.stack : errorDetail(reason)
  );
});

server();
