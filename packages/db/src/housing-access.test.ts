import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  HOUSING_MIGRATION,
  HOUSING_MIGRATION_SHA256,
} from "./housing-access.js";

test("synthetic readiness pins the exact unchanged 0012 migration, not just its name", async () => {
  const source = await readFile(
    new URL("../migrations/" + HOUSING_MIGRATION, import.meta.url),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex"),
    HOUSING_MIGRATION_SHA256,
  );
});
