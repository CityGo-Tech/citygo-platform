import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import type { AiPolicy } from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
  buildServiceConsentPolicy,
  type Database,
  DomainError,
} from "./index.js";
import { assertAiConsentBasisAttempt } from "./ai-consent-compatibility.js";

const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fields = {
  version: "ai-recipient-v2",
  provider: "routerai" as const,
  model: "deepseek/deepseek-v4-pro-0813",
  recipient: "RouterAI",
  routing:
    "Дополнительный получатель (upstream): deepseek. Фильтр страны: cn. Фильтр не гарантирует место хранения данных.",
  data: "Exact synthetic legacy context and notice.",
};
const policy: AiPolicy = { id: hash(fields), ...fields };
const bundle: AiPolicy = {
  ...policy,
  id: hash("pg-current-mode-bundle"),
  version: "ai-assistant-modes-v1",
  model: "citygo/assistant-modes-v1",
  recipient: "Synthetic current recipients",
};
const execution = {
  key: hash({
    version: "ai-reserve-v1",
    policyId: policy.id,
    maxInputBytes: 8192,
    maxOutputTokens: 4096,
    creditReservationMode: "fixed5_overdraft",
  }),
  policy,
  maxInputBytes: 8192,
  maxOutputTokens: 4096,
};
const compatibility = { routingPolicyId: bundle.id, policy, execution };
const resolve = (row: { policyId: string | null }) =>
  [policy, bundle].find((p) => p.id === row.policyId) ?? null;
const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires opt-in disposable PostgreSQL; PGlite is not concurrency evidence",
  timeout: 60000,
};

async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base);
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.ok(
    ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
      (url.port === "55438" && url.pathname === "/citygo_synthetic"),
  );
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  const name = "cg_lazy_consent_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_lazy_consent_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base);
  const cleanup: { db?: Database } = {};
  let created = false;
  t.after(async () => {
    try {
      await cleanup.db?.close();
      if (created) await admin.query(`drop database "${name}"`);
    } finally {
      await admin.close();
    }
  });
  await admin.query(`create database "${name}" template template0`);
  created = true;
  url.pathname = "/" + name;
  const db = await connectDatabase(url.toString());
  cleanup.db = db;
  await migrate(db);
  await db.query(
    "insert into ai_routing(id,provider,policy_id,revision) values(1,'routerai',$1,1)",
    [policy.id],
  );
  const old = new ServiceConsents(db, resolve);
  const user = await old.register(
    "synthetic@example.test",
    "synthetic-hash",
    hash(randomUUID()),
    {
      policyVersion: (await old.policy()).version,
      personalData: true,
      marketing: true,
    },
  );
  await db.query("update ai_routing set policy_id=$1,revision=2 where id=1", [
    bundle.id,
  ]);
  const repoFor = (sql: Database) =>
    new Repository(
      sql,
      false,
      undefined,
      false,
      "fixed5_overdraft",
      false,
      compatibility,
    );
  const storeFor = (sql: Database) =>
    new ServiceConsents(sql, resolve, compatibility);
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'support','support') returning id::text",
      [user.id],
    )
  ).rows[0]!.id;
  const snapshot = {
    mode: "balanced" as const,
    catalogId: hash("pg-legacy-catalog"),
    policy,
    execution,
    upstream: "deepseek",
  };
  const access = {
    policyId: bundle.id,
    revision: 2,
    userDailyLimit: 100,
    globalDailyLimit: 100,
    modeSnapshot: snapshot,
  };
  const choice = {
    expectedUserId: user.id,
    policyId: bundle.id,
    policyVersion: buildServiceConsentPolicy(bundle).version,
    personalData: true,
  };
  return { db, user, thread, snapshot, access, choice, repoFor, storeFor };
}
function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function tagged(
  db: Database,
  tag: string,
  gate?: {
    held: ReturnType<typeof signal>;
    release: ReturnType<typeof signal>;
  },
): Database {
  return {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('application_name',$1,true)", [tag]);
        const value = await work(tx);
        if (gate) {
          gate.held.open();
          await gate.release.promise;
        }
        return value;
      }),
  };
}
async function within<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic PostgreSQL barrier timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function blocked(db: Database, waiter: string, holder: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = (
      await db.query<{ blocked: boolean }>(
        `select exists(select 1 from pg_stat_activity w join pg_stat_activity h on h.pid=any(pg_blocking_pids(w.pid)) where w.application_name=$1 and h.application_name=$2 and w.wait_event_type='Lock' and w.pid<>h.pid) as blocked`,
        [waiter, holder],
      )
    ).rows[0]!;
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Independent backend did not wait on the user lock");
}
async function race(
  f: Awaited<ReturnType<typeof fixture>>,
  first: (db: Database) => Promise<unknown>,
  second: (db: Database) => Promise<unknown>,
) {
  const prefix = "cg_lazy_" + randomUUID().replaceAll("-", ""),
    gate = { held: signal(), release: signal() };
  const winner = first(tagged(f.db, prefix + "_first", gate));
  void winner.catch(() => {});
  let loser: Promise<unknown> | undefined;
  try {
    await within(gate.held.promise);
    loser = second(tagged(f.db, prefix + "_second"));
    void loser.catch(() => {});
    await blocked(f.db, prefix + "_second", prefix + "_first");
  } finally {
    gate.release.open();
    await Promise.allSettled([winner, ...(loser ? [loser] : [])]);
  }
  await winner;
  assert.ok(loser);
  return { loser };
}
async function noProviderOrMoney(db: Database) {
  for (const table of [
    "ai_model_attempts",
    "ai_credit_charges",
    "credit_hold_allocations",
  ])
    assert.deepEqual((await db.query("select * from " + table)).rows, []);
}

test(
  "PostgreSQL lazy AI acceptance and legacy admission serialize both lock orders with real immutable grant receipts",
  pgOnly,
  async (t) => {
    for (const first of ["accept", "admit"] as const) {
      const f = await fixture(t),
        requestId = randomUUID();
      const accept = (db: Database) =>
        f.storeFor(db).acceptAiModes(f.user.id, f.choice);
      const admit = (db: Database) =>
        f
          .repoFor(db)
          .reserveChat(
            f.user.id,
            f.thread,
            requestId,
            "Synthetic last question",
            f.access,
          );
      const { loser } = await race(
        f,
        first === "accept" ? accept : admit,
        first === "accept" ? admit : accept,
      );
      if (first === "accept") {
        await assert.rejects(
          loser,
          (e: unknown) =>
            e instanceof DomainError &&
            e.statusCode === 409 &&
            e.code === "AI_MODE_CHANGED",
        );
        for (const table of [
          "chat_requests",
          "messages",
          "ai_request_modes",
          "ai_request_consent_bases",
        ])
          assert.deepEqual(
            (await f.db.query("select * from " + table)).rows,
            [],
          );
      } else {
        await loser;
        const receipt = (
          await f.db.query("select * from ai_request_consent_bases")
        ).rows[0]!;
        assert.equal(receipt.basis, "legacy-balanced");
        assert.equal(receipt.grant_policy_id, policy.id);
        await assertAiConsentBasisAttempt(
          f.db,
          {
            userId: f.user.id,
            threadId: f.thread,
            requestId,
            routingPolicyId: bundle.id,
            snapshot: f.snapshot,
          },
          compatibility,
        );
        assert.deepEqual(
          (await f.db.query("select * from ai_request_consent_bases")).rows,
          [receipt],
        );
      }
      assert.equal(
        (await f.storeFor(f.db).state(f.user.id)).currentAiConsentRequired,
        false,
      );
      assert.equal(
        (await f.storeFor(f.db).state(f.user.id)).marketingGranted,
        true,
      );
      await noProviderOrMoney(f.db);
    }
  },
);

test(
  "PostgreSQL AI revocation and legacy admission serialize both lock orders without automatic grants or new holds",
  pgOnly,
  async (t) => {
    for (const first of ["revoke", "admit"] as const) {
      const f = await fixture(t),
        requestId = randomUUID();
      const before = (
        await f.db.query("select * from service_consent_events order by id")
      ).rows;
      const revoke = (db: Database) => f.repoFor(db).aiConsent(f.user.id, null);
      const admit = (db: Database) =>
        f
          .repoFor(db)
          .reserveChat(
            f.user.id,
            f.thread,
            requestId,
            "Synthetic last question",
            f.access,
          );
      const { loser } = await race(
        f,
        first === "revoke" ? revoke : admit,
        first === "revoke" ? admit : revoke,
      );
      if (first === "revoke") {
        await assert.rejects(
          loser,
          (e: unknown) =>
            e instanceof DomainError &&
            e.statusCode === 403 &&
            e.code === "AI_CONSENT_REQUIRED",
        );
        for (const table of [
          "chat_requests",
          "messages",
          "ai_request_modes",
          "ai_request_consent_bases",
        ])
          assert.deepEqual(
            (await f.db.query("select * from " + table)).rows,
            [],
          );
      } else {
        await loser;
        await assertAiConsentBasisAttempt(
          f.db,
          {
            userId: f.user.id,
            threadId: f.thread,
            requestId,
            routingPolicyId: bundle.id,
            snapshot: f.snapshot,
          },
          compatibility,
        );
      }
      assert.equal(
        (await f.storeFor(f.db).state(f.user.id)).serviceConsentRequired,
        true,
      );
      assert.deepEqual(
        (await f.db.query("select * from service_consent_events order by id"))
          .rows,
        before,
      );
      assert.equal(
        (
          await f.db.query("select granted from ai_consents where user_id=$1", [
            f.user.id,
          ])
        ).rows[0]?.granted,
        false,
      );
      await noProviderOrMoney(f.db);
    }
  },
);
