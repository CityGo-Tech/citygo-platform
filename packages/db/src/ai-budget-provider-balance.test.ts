import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import type { AiExecution, AiBudgetInput } from "@citygo/contracts";
import { connectDatabase, migrate, Repository } from "./index.js";
import { aiBudget, changeAiBudget, reserveAiMoney } from "./ai-budget.js";
import { DomainError } from "./errors.js";

const execution: AiExecution = {
  key: "a".repeat(64),
  policy: {
    id: "b".repeat(64),
    provider: "routerai",
    version: "synthetic-v1",
    model: "synthetic/model",
    recipient: "synthetic-recipient",
    routing: "synthetic-routing",
    data: "synthetic-data",
  },
  maxInputBytes: 1000,
  maxOutputTokens: 100,
};
const rule = { key: execution.key, attemptCeilingMicros: 10 };
async function fixture() {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const user = await new Repository(db).register(
    "synthetic-budget@example.test",
    "SYNTHETIC-NOT-A-REAL-PASSWORD",
  );
  const current = () => aiBudget(db, [execution]);
  const change = (input: AiBudgetInput, available = [execution]) =>
    changeAiBudget(db, user, input, available);
  const provider = (revision = 1) =>
    change({
      expectedRevision: revision,
      enabled: true,
      mode: "routerai_balance",
      currency: "RUB",
      dailyLimitMicros: null,
      totalLimitMicros: null,
      userDailyLimitMicros: null,
      rules: [rule],
    });
  const reserve = (selected = execution) =>
    db.transaction(async (tx) => {
      await tx.query("select id from users where id=$1 for update", [user]);
      return reserveAiMoney(tx, selected, user);
    });
  return { db, user, current, change, provider, reserve };
}

test("0020 preserves existing fixed caps, counters, enablement and immutable audit", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter((name) => name.endsWith(".sql") && name < "0020_")
    .sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
  await db.query(
    "update ai_budget set enabled=true,currency='RUB',daily_limit_micros=100,total_limit_micros=200,total_reserved_micros=50,user_daily_limit_micros=25,rules=$1 where id=1",
    [JSON.stringify([{ ...execution, attemptCeilingMicros: 10 }])],
  );
  const before = (await db.query("select * from ai_budget")).rows[0]!;
  await db.exec(
    await readFile(
      new URL("0020_ai_budget_provider_balance.sql", directory),
      "utf8",
    ),
  );
  const { mode, ...after } = (await db.query("select * from ai_budget"))
    .rows[0]!;
  assert.equal(mode, "fixed");
  assert.deepEqual(after, before);
  assert.equal((await db.query("select * from audit_log")).rows.length, 0);
});

test("explicit provider mode removes only global money caps and retains audit counters", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.change({
    expectedRevision: 1,
    enabled: true,
    currency: "RUB",
    dailyLimitMicros: 10,
    totalLimitMicros: 10,
    userDailyLimitMicros: null,
    rules: [rule],
  });
  await f.reserve();
  await assert.rejects(
    f.reserve(),
    (e) => e instanceof DomainError && e.statusCode === 429,
  );
  await f.provider(2);
  for (let index = 0; index < 3; index++) await f.reserve();
  const status = await f.current();
  assert.equal(status.settings.mode, "routerai_balance");
  assert.equal(status.settings.dailyLimitMicros, null);
  assert.equal(status.settings.totalLimitMicros, null);
  assert.equal(status.totalReservedMicros, 40);
  assert.equal(status.reservedTodayMicros, 40);
  assert.equal(status.audit.length, 2);
  assert.equal(status.audit[0]!.payload.from.mode, "fixed");
  assert.equal(status.audit[0]!.payload.to.mode, "routerai_balance");
});

test("legacy clients preserve fixed mode and cannot silently change provider mode", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const legacy: AiBudgetInput = {
    expectedRevision: 1,
    enabled: true,
    currency: "RUB",
    dailyLimitMicros: 10,
    totalLimitMicros: 10,
    userDailyLimitMicros: 0,
    rules: [rule],
  };
  assert.equal((await f.change(legacy)).mode, "fixed");
  const { userDailyLimitMicros: _cap, ...withoutPersonalCap } = legacy;
  assert.equal(_cap, 0);
  await f.change({
    ...withoutPersonalCap,
    expectedRevision: 2,
    mode: "routerai_balance",
    dailyLimitMicros: null,
    totalLimitMicros: null,
  });
  assert.equal((await f.current()).settings.userDailyLimitMicros, 0);
  await assert.rejects(
    f.reserve(),
    (e) => e instanceof DomainError && e.statusCode === 429,
  );
  await assert.rejects(
    f.change({ ...legacy, expectedRevision: 3 }),
    (e) => e instanceof DomainError && e.statusCode === 409,
  );
  assert.equal((await f.current()).settings.mode, "routerai_balance");
  await f.change({
    ...legacy,
    expectedRevision: 3,
    mode: "fixed",
    userDailyLimitMicros: null,
  });
  assert.equal((await f.current()).settings.mode, "fixed");
});

test("provider mode still requires RouterAI policy, approved attempt ceiling and matching execution", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const gigachat = {
    ...execution,
    policy: { ...execution.policy, provider: "gigachat" as const },
  };
  await assert.rejects(
    f.change(
      {
        expectedRevision: 1,
        enabled: true,
        mode: "routerai_balance",
        currency: "RUB",
        dailyLimitMicros: null,
        totalLimitMicros: null,
        rules: [rule],
      },
      [gigachat],
    ),
  );
  await f.provider();
  await assert.rejects(f.reserve(gigachat));
  await assert.rejects(f.reserve({ ...execution, maxOutputTokens: 101 }));
  await assert.rejects(
    f.reserve({
      ...execution,
      policy: { ...execution.policy, id: "c".repeat(64) },
    }),
  );
  assert.equal((await f.current()).totalReservedMicros, 0);
  await f.reserve();
  assert.equal((await f.current()).totalReservedMicros, 10);
});

test("provider mode retains finite administrative stop and safe integer counter boundary", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.provider();
  await f.db.query("update ai_budget set total_reserved_micros=$1", [
    Number.MAX_SAFE_INTEGER - 10,
  ]);
  await f.reserve();
  assert.equal(
    (await f.current()).totalReservedMicros,
    Number.MAX_SAFE_INTEGER,
  );
  await assert.rejects(f.reserve());
  assert.equal(
    (await f.current()).totalReservedMicros,
    Number.MAX_SAFE_INTEGER,
  );
  await f.change({
    expectedRevision: 2,
    enabled: false,
    mode: "routerai_balance",
    currency: "RUB",
    dailyLimitMicros: null,
    totalLimitMicros: null,
    rules: [rule],
  });
  await assert.rejects(
    f.reserve(),
    (e) => e instanceof DomainError && e.statusCode === 503,
  );
  await assert.rejects(f.db.query("update ai_budget set mode='fixed'"));
  await assert.rejects(f.db.query("update ai_budget set currency='USD'"));
  await assert.rejects(
    f.db.query("update ai_budget set total_reserved_micros=9007199254740992"),
  );
});
