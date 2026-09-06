import { startServer } from "./runtime.js";
// Explicit development entry point; never included in the production build.
process.env.NODE_ENV = "development";
await startServer();
