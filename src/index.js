import server from "./lib/server.js";

// Last-resort safety net: a stray unhandled error (e.g. a transient upstream
// DNS failure) must never take the whole proxy down. Log it and keep serving.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (kept alive):", err?.stack || err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (kept alive):", reason);
});

server();