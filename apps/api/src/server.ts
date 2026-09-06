import { startServer } from "./runtime.js";
// This is the only built API entry point. Even a stale .env cannot downgrade it.
process.env.NODE_ENV = "production";
await startServer();
