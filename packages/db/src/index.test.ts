import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectDatabase, migrate, type Database } from "./index.js";

test("first local startup creates parent directories and persists across restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citygo-persistence-"));
  assert.ok(
    resolve(directory).startsWith(resolve(tmpdir()) + "/") ||
      resolve(directory).startsWith(resolve(tmpdir()) + "\\"),
  );
  let db: Database | undefined;
  t.after(async () => {
    await db?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const url = "pglite://" + join(directory, "nested", "database");
  db = await connectDatabase(url);
  await migrate(db);
  await db.query(
    "insert into users(auth_subject) values ('persistence-smoke')",
  );
  await db.close();
  db = undefined;
  db = await connectDatabase(url);
  await migrate(db);
  assert.equal(
    (await db.query<{ auth_subject: string }>("select auth_subject from users"))
      .rows[0]!.auth_subject,
    "persistence-smoke",
  );
});
