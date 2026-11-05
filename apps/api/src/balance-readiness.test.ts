import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { connectDatabase, migrate } from "@citygo/db";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";

async function fixture(t: TestContext, oldSchema = 0) {
  const db = await connectDatabase("pglite://:memory:");
  const cleanup: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  t.after(async () => {
    await cleanup.app?.close();
    await db.close();
  });
  if (oldSchema) {
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
      .slice(0, oldSchema);
    assert.equal(names.length, oldSchema);
    assert.equal(
      names.at(-1),
      (
        {
          44: "0044_conversation_titles.sql",
          45: "0045_ai_balance_request_cost_limit.sql",
          46: "0046_postpay_actual.sql",
          47: "0047_conversation_memory.sql",
        } as Record<number, string>
      )[oldSchema],
    );
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

test("readiness rejects actual schema44 under legacy default and turns ready only after applying48 without creating money or model attempts", async (t) => {
  const f = await fixture(t, 44);
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
    48,
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

test("readiness rejects actual schema46 until memory47 exists and checks its physical source guard", async (t) => {
  const f = await fixture(t, 46);
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    503,
  );
  await migrate(f.db);
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    200,
  );
  await f.db.exec(
    "alter table conversation_memory_fragments disable trigger conversation_memory_fragment_guard",
  );
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    503,
  );
  await f.db.exec(
    "alter table conversation_memory_fragments enable trigger conversation_memory_fragment_guard",
  );
  await f.db.exec(
    "alter table conversation_memory_fragments disable trigger conversation_memory_update_guard",
  );
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    503,
  );
  await f.db.exec(
    "alter table conversation_memory_fragments enable trigger conversation_memory_update_guard",
  );
  await f.db.exec(
    "alter table conversation_memory_fragments drop column source_sha256 cascade",
  );
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    503,
  );
  assert.equal(
    (
      await f.db.query(
        "select name from citygo_migrations where name='0047_conversation_memory.sql'",
      )
    ).rows.length,
    1,
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

test("readiness rejects actual schema45 until postpay46 physical tables and billing discriminator exist", async (t) => {
  const f = await fixture(t, 45);
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    503,
  );
  await migrate(f.db);
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    200,
  );
  await f.db.exec(
    "alter table gigachat_request_fees drop column billing_mode cascade",
  );
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    503,
  );
});
for (const table of [
  "ai_postpay_attempts",
  "credit_postpay_liabilities",
  "credit_postpay_repayments",
])
  test(`readiness rejects missing physical postpay table ${table} with receipt46 retained`, async (t) => {
    const f = await fixture(t);
    await f.db.exec(`drop table ${table} cascade`);
    assert.equal(
      (
        await f.db.query(
          "select name from citygo_migrations where name='0046_postpay_actual.sql'",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
      503,
    );
  });

test("readiness rejects schema47 and a forged48 receipt with the historical postpay guard", async (t) => {
  const f = await fixture(t, 47);
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    503,
  );
  await migrate(f.db);
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    200,
  );
  const oldSource = await readFile(
    new URL(
      "../../../packages/db/migrations/0046_postpay_actual.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const oldGuard =
    /create function citygo_guard_postpay_attempt\(\) returns trigger[\s\S]*?\$\$;/.exec(
      oldSource,
    );
  assert.ok(
    oldGuard,
    "Use the exact historical trigger rather than a second implementation",
  );
  await f.db.exec(
    oldGuard[0].replace("create function", "create or replace function"),
  );
  assert.equal(
    (
      await f.db.query(
        "select name from citygo_migrations where name='0048_native_search_postpay.sql'",
      )
    ).rows.length,
    1,
  );
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    503,
  );
  await f.db.exec(
    await readFile(
      new URL(
        "../../../packages/db/migrations/0048_native_search_postpay.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    200,
  );
  await f.db.exec(
    "alter table ai_postpay_attempts disable trigger ai_postpay_guard",
  );
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    503,
  );
  await f.db.exec(
    "alter table ai_postpay_attempts enable trigger ai_postpay_guard",
  );
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    200,
  );
});
