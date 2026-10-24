import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import {
  PhoneVerification,
  Repository,
  EmailRegistration,
  DomainError,
  connectDatabase,
  configurePhoneVerification,
  migrate,
  type Database,
  type PhoneVerificationContext,
  type PhoneVerificationPolicy,
} from "./index.js";

const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires opt-in disposable PostgreSQL; PGlite is not race evidence",
  timeout: 60000,
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const policy: PhoneVerificationPolicy = {
  identityKeyFingerprint: hash("synthetic-pg-phone-key"),
  normalizationVersion: "e164-v1",
  limits: {
    userHourly: 10,
    phoneHourly: 10,
    ipHourly: 10,
    cooldownSeconds: 0,
    globalDaily: 100,
    globalTotal: 1000,
  },
};
const input = () => ({
  id: randomUUID(),
  phoneKey: hash("synthetic-same-phone"),
  proofHash: hash("synthetic-proof"),
  codeHash: hash("synthetic-code"),
  ipKey: hash("synthetic-ip"),
});
const confirm = (v: ReturnType<typeof input>) => ({
  id: v.id,
  phoneKey: v.phoneKey,
  proofHash: v.proofHash,
  codeHash: v.codeHash,
});
const status = (n: number) => (e: unknown) =>
  e instanceof DomainError && e.statusCode === n;
async function fixture(t: TestContext, chosen = policy) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base);
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.ok(
    ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
      (url.port === "55438" && url.pathname === "/citygo_synthetic"),
  );
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  const name = "cg_phone_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_phone_test_[a-f0-9]{32}$/);
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
  await configurePhoneVerification(db, chosen);
  async function user(): Promise<PhoneVerificationContext> {
    const name = randomUUID(),
      sessionTokenHash = hash(name),
      email = new EmailRegistration(db),
      value = {
        id: randomUUID(),
        email: name + "@example.test",
        passwordHash: "synthetic-hash",
        proofHash: hash("email-proof"),
        codeHash: hash("email-code"),
        recipientKey: hash("recipient:" + name),
        ipKey: hash("email-ip:" + name),
      };
    await email.begin(value);
    await email.markSent(value.id, value.codeHash);
    const account = await email.confirm({
      id: value.id,
      proofHash: value.proofHash,
      codeHash: value.codeHash,
      sessionHash: sessionTokenHash,
    });
    return { userId: account.id, sessionTokenHash };
  }
  return { db, user, phone: new PhoneVerification(db, chosen) };
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
    entered: ReturnType<typeof signal>;
    release: ReturnType<typeof signal>;
  },
): Database {
  let held = false;
  return {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('application_name',$1,true)", [tag]);
        return work({
          exec: (sql) => tx.exec(sql),
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            if (
              gate &&
              !held &&
              sql.startsWith("select id from account_security_state")
            ) {
              held = true;
              gate.entered.open();
              await gate.release.promise;
            }
            return result;
          },
        });
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
          () => reject(new Error("PostgreSQL phone barrier timed out")),
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
        `select exists(select 1 from pg_stat_activity w join pg_stat_activity h
      on h.pid=any(pg_blocking_pids(w.pid)) where w.application_name=$1 and h.application_name=$2
      and w.wait_event_type='Lock' and w.pid<>h.pid) as blocked`,
        [waiter, holder],
      )
    ).rows[0]!;
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    "Independent PostgreSQL backend did not actually wait on the first transaction",
  );
}
function observe<T>(promise: Promise<T>) {
  void promise.catch(() => {});
  return promise;
}
async function race<T, U>(
  db: Database,
  chosen: PhoneVerificationPolicy,
  one: (p: PhoneVerification) => Promise<T>,
  two: (p: PhoneVerification) => Promise<U>,
) {
  const gate = { entered: signal(), release: signal() },
    prefix = "cg_phone_" + randomUUID().replaceAll("-", "");
  const first = observe(
    one(new PhoneVerification(tagged(db, prefix + "_first", gate), chosen)),
  );
  let second: Promise<U> | undefined;
  try {
    await within(gate.entered.promise);
    second = observe(
      two(new PhoneVerification(tagged(db, prefix + "_second"), chosen)),
    );
    await blocked(db, prefix + "_second", prefix + "_first");
  } finally {
    gate.release.open();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
  assert.ok(second);
  return { first, second };
}

test(
  "PostgreSQL two sessions confirming one challenge receive one operation/bonus/lot, including unknown-commit replay",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      ctx = await f.user(),
      v = input();
    const secondSession = { ...ctx, sessionTokenHash: hash("second-session") };
    await new Repository(f.db).createSession(
      ctx.userId,
      secondSession.sessionTokenHash,
    );
    await f.phone.begin(ctx, v);
    await f.phone.markAccepted(v.id, v.codeHash);
    const { first, second } = await race(
      f.db,
      policy,
      (p) => p.confirm(ctx, confirm(v)),
      (p) => p.confirm(secondSession, confirm(v)),
    );
    const receipt = await first;
    assert.equal(receipt.alreadyGranted, false);
    assert.deepEqual(await second, { ...receipt, alreadyGranted: true });
    assert.deepEqual(await f.phone.confirm(ctx, confirm(v)), {
      ...receipt,
      alreadyGranted: true,
    });
    for (const table of [
      "phone_welcome_claims",
      "ai_credit_entries",
      "credit_source_lots",
    ])
      assert.equal((await f.db.query("select 1 from " + table)).rows.length, 1);
  },
);

test(
  "PostgreSQL two accounts proving the same mobile race to exactly one 500 gift, never two grants or orphan lots",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      a = await f.user(),
      b = await f.user(),
      va = input(),
      vb = input();
    await f.phone.begin(a, va);
    await f.phone.markAccepted(va.id, va.codeHash);
    await f.phone.begin(b, vb);
    await f.phone.markAccepted(vb.id, vb.codeHash);
    const { first, second } = await race(
      f.db,
      policy,
      (p) => p.confirm(a, confirm(va)),
      (p) => p.confirm(b, confirm(vb)),
    );
    await first;
    await assert.rejects(second, status(409));
    assert.deepEqual(
      (
        await f.db.query(
          "select user_id::text,granted_micros::text from ai_credit_accounts",
        )
      ).rows,
      [{ user_id: a.userId, granted_micros: "500000000" }],
    );
    assert.equal(
      (await f.db.query("select 1 from phone_welcome_claims")).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("select 1 from credit_source_lots")).rows.length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "select 1 from phone_verification_challenges where consumed_at is not null",
        )
      ).rows.length,
      1,
    );
  },
);

test(
  "PostgreSQL shared global admissions cap cannot be overspent by independent API instances",
  pgOnly,
  async (t) => {
    const chosen = { ...policy, limits: { ...policy.limits, globalTotal: 1 } },
      f = await fixture(t, chosen),
      a = await f.user(),
      b = await f.user();
    const { first, second } = await race(
      f.db,
      chosen,
      (p) => p.begin(a, input()),
      (p) => p.begin(b, input()),
    );
    await first;
    await assert.rejects(second, status(429));
    assert.equal(
      (await f.db.query("select 1 from phone_verification_sends")).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("select 1 from phone_verification_challenges")).rows
        .length,
      1,
    );
  },
);

test(
  "PostgreSQL failed OTP counters commit across replicas and revoked sessions cannot consume accepted codes",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      ctx = await f.user(),
      v = input();
    await f.phone.begin(ctx, v);
    await f.phone.markAccepted(v.id, v.codeHash);
    const wrong = { ...confirm(v), codeHash: hash("wrong") };
    const { first, second } = await race(
      f.db,
      policy,
      (p) => p.confirm(ctx, wrong),
      (p) => p.confirm(ctx, wrong),
    );
    await assert.rejects(first, status(400));
    await assert.rejects(second, status(400));
    assert.equal(
      (
        await f.db.query<{ attempts: number }>(
          "select attempts from phone_verification_challenges",
        )
      ).rows[0]!.attempts,
      2,
    );
    await f.db.query("delete from sessions where token_hash=$1", [
      ctx.sessionTokenHash,
    ]);
    await assert.rejects(f.phone.confirm(ctx, confirm(v)), status(401));
    assert.equal(
      (await f.db.query("select 1 from phone_welcome_claims")).rows.length,
      0,
    );
  },
);
