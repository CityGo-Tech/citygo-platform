import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { CITYGO_10X_TARIFF } from "@citygo/contracts";
import {
  AiCreditLedger,
  Repository,
  connectDatabase,
  ensureConversation,
  migrate,
  DomainError,
  type Database,
} from "./index.js";

async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const old = new Repository(db);
  const user = await old.register(randomUUID() + "@example.test", "synthetic"),
    other = await old.register(randomUUID() + "@example.test", "synthetic");
  const policyId = "a".repeat(64);
  await db.query(
    "insert into ai_routing(id,provider,policy_id,revision) values(1,'routerai',$1,1) on conflict(id)do update set provider='routerai',policy_id=$1,revision=1",
    [policyId],
  );
  await db.query(
    "insert into ai_consents(user_id,policy_id,granted)values($1,$2,true)",
    [user, policyId],
  );
  const a = await ensureConversation(db, user, "housing"),
    b = await ensureConversation(db, user, "job-search"),
    foreign = await ensureConversation(db, other, "housing");
  const repo = new Repository(
    db,
    true,
    CITYGO_10X_TARIFF,
    false,
    "fixed5_overdraft",
  );
  const access = {
    policyId,
    revision: 1,
    userDailyLimit: 100,
    globalDailyLimit: 100,
    fixed5CreditReadiness: true,
  };
  return { db, repo, old, user, other, a, b, foreign, access };
}
async function snapshot(db: Database) {
  const value: Record<string, unknown[]> = {};
  for (const table of [
    "messages",
    "chat_requests",
    "agent_threads",
    "ai_usage_daily",
    "ai_user_usage_daily",
    "ai_credit_entries",
  ])
    value[table] = (
      await db.query(
        `select to_jsonb(t)as value from ${table} t order by to_jsonb(t)::text`,
      )
    ).rows;
  return value;
}
test("fixed5 admission serializes different threads before a hold exists; expired leases do not permanently block new questions", async (t) => {
  const f = await fixture(t);
  const replies = await Promise.allSettled([
    f.repo.reserveChat(f.user, f.a.id, randomUUID(), "Первый вопрос", f.access),
    f.repo.reserveChat(f.user, f.b.id, randomUUID(), "Второй вопрос", f.access),
  ]);
  assert.equal(
    replies.filter((value) => value.status === "fulfilled").length,
    1,
  );
  assert.equal((await f.db.query("select *from messages")).rows.length, 1);
  assert.equal((await f.db.query("select *from chat_requests")).rows.length, 1);
  assert.equal(
    (await f.db.query("select accepted_requests from ai_usage_daily")).rows[0]!
      .accepted_requests,
    1,
  );
  const before = await snapshot(f.db);
  await assert.rejects(
    f.repo.reserveChat(
      f.user,
      f.b.id,
      randomUUID(),
      "Заблокированный вопрос",
      f.access,
    ),
    (e: unknown) => e instanceof DomainError && e.statusCode === 409,
  );
  assert.deepEqual(await snapshot(f.db), before);
  await f.db.query(
    "update agent_threads set busy_until=clock_timestamp()-interval '1 second'where user_id=$1",
    [f.user],
  );
  await f.repo.reserveChat(
    f.user,
    f.b.id,
    randomUUID(),
    "После истечения аренды",
    f.access,
  );
  assert.equal((await f.db.query("select *from messages")).rows.length, 2);
});
test("pending monetary hold refuses admission without question/quota writes; read-only preflight is owner/status/request bound", async (t) => {
  const f = await fixture(t);
  const credit = new AiCreditLedger(
    f.db,
    "routerai_citygo_10x",
    false,
    "fixed5_overdraft",
  );
  await credit.topUpConfirmed(f.user, randomUUID(), {
    providerPaymentId: "synthetic-" + randomUUID(),
    paidKopeks: 10000,
    merchantId: "synthetic",
    test: false,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  const hold = randomUUID();
  await credit.hold(f.user, hold, 5_000_000);
  const before = await snapshot(f.db);
  const preflight = await f.repo.chatRecoveryPreflight(
    f.user,
    f.a.id,
    randomUUID(),
  );
  assert.deepEqual(preflight.charges, [
    { holdId: hold, responseComplete: null, generationPresent: false },
  ]);
  await assert.rejects(
    f.repo.reserveChat(f.user, f.a.id, randomUUID(), "Не принят", f.access),
    (e: unknown) =>
      e instanceof DomainError && e.code === "AI_CREDIT_UNAVAILABLE",
  );
  await assert.rejects(
    f.repo.chatRecoveryPreflight(f.user, f.foreign.id, randomUUID()),
    /Чат не найден/,
  );
  assert.deepEqual(await snapshot(f.db), before);
  await f.db.query("update users set status='blocked'where id=$1", [f.user]);
  await assert.rejects(
    f.repo.chatRecoveryPreflight(f.user, f.a.id, randomUUID()),
    (e: unknown) => e instanceof DomainError && e.statusCode === 401,
  );
});
test("legacy nonfixed5 Repository keeps its old per-thread admission unless the server readiness flag is enabled", async (t) => {
  const f = await fixture(t);
  const { fixed5CreditReadiness: _, ...access } = f.access;
  void _;
  await f.old.reserveChat(f.user, f.a.id, randomUUID(), "A", access);
  await f.old.reserveChat(f.user, f.b.id, randomUUID(), "B", access);
  assert.equal((await f.db.query("select *from messages")).rows.length, 2);
});
