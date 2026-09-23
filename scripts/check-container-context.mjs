import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Executed before install in the Docker build context. Fails closed, no contents logged.
const canary = "citygo-container-context-canary-20260923";
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      /^(\.env($|\.)|\.local$|\.ssh$|\.git$)/.test(entry.name) ||
      /\.(pem|key|dump|backup)$/.test(entry.name)
    )
      throw new Error("Disallowed file in container build context");
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symlink in build context");
    if (entry.isDirectory()) await check(path);
    else if (
      !path.endsWith("check-container-context.mjs") &&
      !path.endsWith("container-smoke.mjs") &&
      !path.endsWith("container-runtime.test.mjs")
    ) {
      if ((await readFile(path)).includes(Buffer.from(canary)))
        throw new Error("Test secret entered container build context");
    }
  }
}
await check(process.argv[2]);
