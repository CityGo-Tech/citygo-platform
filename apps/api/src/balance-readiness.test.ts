import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { connectDatabase, migrate } from "@citygo/db";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";

async function fixture(t: TestContext, schema44 = false) {
  const db = await connectDatabase("pglite://:memory:");
  const cleanup: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  t.after(async () => {
    await cleanup.app?.close();
    await db.close();
  });
  if (schema44) {
    await db.exec(
      "create table citygo_migration_lock(id integer primary key);insert into citygo_migration_lock values(1);create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
    );
    const directory = new URL(
      "../../../packages/db/migrations/",
      import.meta.url,
    );
    const names = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .slice(0, 44);
    assert.equal(names.length, 44);
    assert.equal(names.at(-1), "0044_conversation_titles.sql");
    for (const name of names) {
      const source = await readFile(new URL(name, directory), "utf8");
      await db.transaction(async (tx) => {
        await tx.exec(
          source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
        );
        await tx.query(
          "insert into citygo_migrations(name,checksum) values($1,$2)",
          [
            name,
            createHash("sha256")
              .update(source.replaceAll("\r\n", "\n"))
              .digest("hex"),
          ],
        );
      });
    }
  } else await migrate(db);
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    LLM_PROVIDER: "disabled",
  });
  assert.equal(config.AI_REQUEST_COST_LIMIT_MODE, "operator_ceiling");
  const app = await buildApp({ db, config, testing: true });
  cleanup.app = app;
  return { db, app };
}

test("readiness rejects actual schema44 under legacy default and turns ready only after applying45 without creating money or model attempts", async (t) => {
  const f = await fixture(t, true);
  const before = (
    await f.db.query(
      "select (select count(*)::int from users) as users,(select count(*)::int from ai_credit_entries) as entries,(select count(*)::int from ai_model_attempts) as attempts",
    )
  ).rows;
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/health" })).statusCode,
    200,
  );
  const old = await f.app.inject({ method: "GET", url: "/ready" });
  assert.equal(old.statusCode, 503, old.body);
  assert.match(old.body, /примените миграции/);
  assert.equal(
    (await f.db.query("select name from citygo_migrations")).rows.length,
    44,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select (select count(*)::int from users) as users,(select count(*)::int from ai_credit_entries) as entries,(select count(*)::int from ai_model_attempts) as attempts",
      )
    ).rows,
    before,
  );
  await migrate(f.db);
  const current = await f.app.inject({ method: "GET", url: "/ready" });
  assert.equal(current.statusCode, 200, current.body);
  assert.deepEqual(current.json(), { status: "ok" });
  assert.equal(
    (await f.db.query("select name from citygo_migrations")).rows.length,
    45,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select (select count(*)::int from users) as users,(select count(*)::int from ai_credit_entries) as entries,(select count(*)::int from ai_model_attempts) as attempts",
      )
    ).rows,
    before,
  );
});

for (const column of ["cost_limit_mode", "balance_before_hold_micros"] as const)
  test(`readiness rejects a missing physical ${column} column even with the45 receipt`, async (t) => {
    const f = await fixture(t);
    assert.equal(
      (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
      200,
    );
    // Synthetic corruption only: prove the gate reads physical schema, not just
    // a potentially misleading migration receipt. No production rollback tool.
    await f.db.exec(
      `alter table ai_credit_charges drop column ${column} cascade`,
    );
    assert.equal(
      (
        await f.db.query(
          "select name from citygo_migrations where name='0045_ai_balance_request_cost_limit.sql'",
        )
      ).rows.length,
      1,
    );
    const response = await f.app.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 503, response.body);
  });
