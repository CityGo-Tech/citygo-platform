import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("actual current-facade replacement cannot change v1 readers, writers or command replay", async (t) => {
  // No inherited provider credentials, NODE_OPTIONS or .env loading. The only
  // database input is the same explicit test-cluster URL used by DB fixtures.
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TEST_DATABASE_URL",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--import",
      "tsx",
      fileURLToPath(
        new URL("./fixtures/housing-future-facade.mjs", import.meta.url),
      ),
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env,
      windowsHide: true,
      timeout: 90000,
      maxBuffer: 1024 * 1024,
    },
  );
  const backend = process.env.TEST_DATABASE_URL ? "PostgreSQL" : "PGlite";
  assert.equal(
    stdout.trim(),
    "Facade substitution: v1 read/create/edit/replay PASS; backend=" + backend,
  );
  t.diagnostic("Facade substitution backend: " + backend);
});
