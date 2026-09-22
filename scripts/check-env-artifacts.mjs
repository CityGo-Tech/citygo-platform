import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { root } from "./env.mjs";

// CI injects this deliberately fake value into both private and public-prefix
// environment variables before builds. No real credentials are read or printed.
const marker = Buffer.from("citygo-env-isolation-canary-20260922");
let checked = 0;
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) check(path);
    else if (entry.isFile()) {
      if (readFileSync(path).includes(marker))
        throw new Error(
          "Environment canary found in build artifacts (contents hidden)",
        );
      checked++;
    }
  }
}
// Missing artifacts must fail, not silently produce a passing zero-file scan.
check(join(root, "apps/web/.next/static"));
check(join(root, "apps/mobile/dist"));
if (!checked) throw new Error("No client build artifacts found");
console.log(`Environment canary absent from ${checked} client build artifacts`);
