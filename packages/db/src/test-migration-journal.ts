import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import type { Database } from "./index.js";

export async function assertFixtureMigrationJournal(db: Database) {
  const files = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied = await db.query<{ name: string }>(
    "select name from citygo_migrations order by name",
  );
  assert.deepEqual(
    applied.rows.map(({ name }) => name),
    files,
  );
}
