import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertGigaChatCa, gigaChatCaSourcePath } from "./gigachat-ca.mjs";

// Executed before install in the Docker build context. Fails closed, no contents logged.
const canary = "citygo-container-context-canary-20260923";
async function check(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      /^(\.env($|\.)|\.local$|\.ssh$|\.git$)/.test(entry.name) ||
      /\.(pem|key|dump|backup|age)$/.test(entry.name) ||
      entry.name === "backup-storage.json"
    )
      throw new Error("Disallowed file in container build context");
    const path = join(directory, entry.name);
    const relativePath = relative + entry.name;
    if (entry.isSymbolicLink()) throw new Error("Symlink in build context");
    if (entry.isDirectory()) await check(path, relativePath + "/");
    else if (
      !path.endsWith("check-container-context.mjs") &&
      !path.endsWith("container-smoke.mjs") &&
      !path.endsWith("container-runtime.test.mjs")
    ) {
      const data = await readFile(path);
      if (entry.name.endsWith(".crt")) {
        if (relativePath !== gigaChatCaSourcePath)
          throw new Error("Unreviewed certificate in container build context");
        assertGigaChatCa(data);
      }
      if (
        data.includes(Buffer.from(canary)) ||
        /AGE-SECRET-KEY-1[0-9A-Z]{20,}/.test(data.toString("utf8"))
      )
        throw new Error("Test secret entered container build context");
    }
  }
}
await check(process.argv[2]);
