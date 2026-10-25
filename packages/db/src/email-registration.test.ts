import { syntheticServiceConsents } from "./test-service-consents.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AccountAccess,
  connectDatabase,
  DomainError,
  EmailRegistration,
  migrate,
  Repository,
  type Database,
  type EmailSendLimits,
} from "./index.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const status = (value: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === value;
function input(
  email = "synthetic-registration@example.test",
  ip = "synthetic-ip",
) {
  return {
    consents: syntheticServiceConsents,
    id: randomUUID(),
    email,
    passwordHash: "synthetic-already-hashed-password",
    proofHash: hash("synthetic-proof"),
    codeHash: hash("synthetic-code"),
    recipientKey: hash("recipient:" + email),
    ipKey: hash("ip:" + ip),
  };
}
async function fixture(t: TestContext) {
  // Fixed in-memory synthetic database. Never read runtime credentials/env URLs.
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const store = new EmailRegistration(db);
  const repo = new Repository(db);
  const access = new AccountAccess(db);
  const proof = (
    value: ReturnType<typeof input>,
    codeHash = value.codeHash,
  ) => ({
    id: value.id,
    proofHash: value.proofHash,
    codeHash,
    sessionHash: hash("session:" + value.id),
  });
  const ageQuota = () =>
    db.query(
      "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 minutes'",
    );
  return { db, store, repo, access, proof, ageQuota };
}

function trackQueries(db: Database) {
  const statements: string[] = [];
  const tracked: Database = {
    ...db,
    query: <T>(sql: string, params?: unknown[]) => {
      statements.push(sql);
      return db.query<T>(sql, params);
    },
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          exec: (sql) => tx.exec(sql),
          query: <T>(sql: string, params?: unknown[]) => {
            statements.push(sql);
            return tx.query<T>(sql, params);
          },
        }),
      ),
  };
  return { db: tracked, statements };
}

test("explicit unlimited email admission preserves events across failures/restarts without a global history count", async (t) => {
  const f = await fixture(t),
    tracked = trackQueries(f.db);
  const limits: EmailSendLimits = { daily: null, total: null };
  const frozen = new EmailRegistration(tracked.db, limits);
  limits.daily = limits.total = 0;
  for (let n = 0; n < 24; n++) {
    const store =
      n % 2
        ? new EmailRegistration(tracked.db, { daily: null, total: null })
        : frozen;
    const value = input(
      "unlimited-" + n + "@example.test",
      "unlimited-ip-" + n,
    );
    await store.begin(value);
    if (n % 2) await store.markSent(value.id, value.codeHash);
    else await store.cancelDelivery(value.id, value.codeHash);
    if (n === 11)
      await f.db.query(
        "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 days'",
      );
  }
  assert.equal(
    (await f.db.query("select 1 from email_registrations")).rows.length,
    24,
  );
  for (const kind of ["recipient", "ip"])
    assert.equal(
      (
        await f.db.query(
          "select 1 from email_registration_rate_events where kind=$1",
          [kind],
        )
      ).rows.length,
      24,
    );
  const quotaQueries = tracked.statements.filter(
    (sql) =>
      sql.includes("from email_registration_rate_events") &&
      sql.trimStart().startsWith("select"),
  );
  assert.equal(quotaQueries.length, 24);
  for (const sql of quotaQueries) {
    assert.match(sql, /as recipient_count/);
    assert.match(sql, /where created_at>clock_timestamp\(\)-interval '1 hour'/);
    assert.doesNotMatch(sql, /as (?:daily|total)\b/);
  }
  // Events are retained even with unlimited admission, so a later bounded
  // instance cannot forget earlier attempts or provider failures.
  await assert.rejects(
    new EmailRegistration(tracked.db, { daily: 2, total: 2 }).begin(
      input("bounded-after-unlimited@example.test", "new-bounded-ip"),
    ),
    status(429),
  );
  assert.equal((await f.db.query("select 1 from users")).rows.length, 0);
});

test("a finite daily cap with unlimited total counts only the current UTC day", async (t) => {
  const f = await fixture(t),
    tracked = trackQueries(f.db);
  const store = new EmailRegistration(tracked.db, { daily: 2, total: null });
  const first = input("daily-only-one@example.test", "daily-ip-one");
  await store.begin(first);
  await store.cancelDelivery(first.id, first.codeHash);
  await new EmailRegistration(tracked.db, { daily: 2, total: null }).begin(
    input("daily-only-two@example.test", "daily-ip-two"),
  );
  await assert.rejects(
    store.begin(input("daily-only-blocked@example.test", "daily-ip-three")),
    status(429),
  );
  await f.db.query(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 days'",
  );
  for (let n = 0; n < 2; n++)
    await new EmailRegistration(tracked.db, { daily: 2, total: null }).begin(
      input("daily-next-" + n + "@example.test", "daily-next-ip-" + n),
    );
  await assert.rejects(
    store.begin(input("daily-next-blocked@example.test", "daily-next-ip")),
    status(429),
  );
  const globalQueries = tracked.statements.filter((sql) =>
    /as daily\b/.test(sql),
  );
  assert.equal(globalQueries.length, 6);
  for (const sql of globalQueries) {
    assert.match(sql, /and created_at>=date_trunc\('day'/);
    assert.doesNotMatch(sql, /as total\b/);
  }
});

test("unlimited daily admission still enforces a finite all-time cap across a new UTC day and restart", async (t) => {
  const f = await fixture(t),
    tracked = trackQueries(f.db);
  const first = input("total-only-one@example.test", "total-ip-one");
  const store = new EmailRegistration(tracked.db, { daily: null, total: 2 });
  await store.begin(first);
  await store.cancelDelivery(first.id, first.codeHash);
  await new EmailRegistration(tracked.db, { daily: null, total: 2 }).begin(
    input("total-only-two@example.test", "total-ip-two"),
  );
  await f.db.query(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 days'",
  );
  await assert.rejects(
    new EmailRegistration(tracked.db, { daily: null, total: 2 }).begin(
      input("total-only-blocked@example.test", "total-ip-three"),
    ),
    status(429),
  );
  const globalQueries = tracked.statements.filter((sql) =>
    /as total\b/.test(sql),
  );
  assert.equal(globalQueries.length, 3);
  for (const sql of globalQueries) {
    assert.doesNotMatch(sql, /as daily\b|date_trunc/);
    assert.match(sql, /where kind='recipient'/);
  }
});

test("unlimited global admission never removes recipient cooldown, three/hour or ten/IP/hour protections", async (t) => {
  const f = await fixture(t);
  const store = new EmailRegistration(f.db, { daily: null, total: null });
  const value = input("unlimited-recipient@example.test", "recipient-ip");
  await store.begin(value);
  await store.cancelDelivery(value.id, value.codeHash);
  await assert.rejects(
    new EmailRegistration(f.db, { daily: null, total: null }).begin(
      input(value.email, "different-recipient-ip"),
    ),
    status(429),
  );
  for (const code of ["second-unlimited", "third-unlimited"]) {
    await f.ageQuota();
    await new EmailRegistration(f.db, { daily: null, total: null }).resend({
      id: value.id,
      proofHash: value.proofHash,
      codeHash: hash(code),
      ipKey: value.ipKey,
    });
  }
  await f.ageQuota();
  await assert.rejects(
    store.resend({
      id: value.id,
      proofHash: value.proofHash,
      codeHash: hash("fourth-unlimited"),
      ipKey: value.ipKey,
    }),
    status(429),
  );
  for (let n = 0; n < 10; n++)
    await new EmailRegistration(f.db, { daily: null, total: null }).begin(
      input("unlimited-shared-ip-" + n + "@example.test", "shared-ip"),
    );
  await assert.rejects(
    store.begin(input("unlimited-ip-blocked@example.test", "shared-ip")),
    status(429),
  );
  await store.begin(
    input("unlimited-independent-ip@example.test", "independent-ip"),
  );
});

test("zero remains deny in mixed modes; only explicit null or a bounded integer is a valid field", async (t) => {
  const f = await fixture(t);
  for (const limits of [
    { daily: 0, total: null },
    { daily: null, total: 0 },
  ])
    await assert.rejects(
      new EmailRegistration(f.db, limits).begin(input()),
      status(429),
    );
  assert.equal(
    (await f.db.query("select 1 from email_registration_rate_events")).rows
      .length,
    0,
  );
  assert.equal(
    (await f.db.query("select 1 from email_registrations")).rows.length,
    0,
  );
  for (const invalid of [
    undefined,
    -1,
    -Infinity,
    NaN,
    Infinity,
    1.2,
    1000001,
    "unlimited",
    "10",
    false,
    {},
    [],
  ])
    for (const field of ["daily", "total"])
      assert.throws(
        () =>
          new EmailRegistration(f.db, {
            daily: null,
            total: null,
            [field]: invalid,
          } as unknown as EmailSendLimits),
        /Invalid email send admission limits/,
      );
  for (const invalid of [null, [], 0, {}, { daily: null }, { total: null }])
    assert.throws(
      () => new EmailRegistration(f.db, invalid as unknown as EmailSendLimits),
      /Invalid email send admission limits/,
    );
  // The optional whole argument remains backward-compatible, unlike an
  // undefined daily/total field in an explicit object.
  assert.doesNotThrow(() => new EmailRegistration(f.db, undefined));
});

test("global email admissions survive failures/restart and cannot be increased by mutating config", async (t) => {
  const f = await fixture(t);
  const limits = { daily: 2, total: 2 };
  const store = new EmailRegistration(f.db, limits);
  limits.daily = limits.total = 100;
  const first = input("global-one@example.test");
  await store.begin(first);
  await store.cancelDelivery(first.id, first.codeHash);
  await new EmailRegistration(f.db, { daily: 2, total: 2 }).begin(
    input("global-two@example.test"),
  );
  await assert.rejects(
    store.begin(input("global-three@example.test")),
    status(429),
  );
  assert.equal(
    (await f.db.query("select 1 from email_registrations")).rows.length,
    2,
  );
  assert.equal(
    (
      await f.db.query(
        "select 1 from email_registration_rate_events where kind='recipient'",
      )
    ).rows.length,
    2,
  );
});

test("email zero admission cap denies before storing a challenge or send; total survives a new UTC day", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    new EmailRegistration(f.db, { daily: 0, total: 10 }).begin(input()),
    status(429),
  );
  assert.equal(
    (await f.db.query("select 1 from email_registration_rate_events")).rows
      .length,
    0,
  );
  const store = new EmailRegistration(f.db, { daily: 1, total: 1 });
  await store.begin(input("all-time-one@example.test"));
  await f.db.query(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 days'",
  );
  await assert.rejects(
    store.begin(input("all-time-two@example.test")),
    status(429),
  );
  for (const invalid of [-1, 1.2, NaN, Infinity, 1000001])
    assert.throws(
      () => new EmailRegistration(f.db, { daily: invalid, total: 10 }),
    );
});

test("pending email registration creates no user/session/credit; delivered confirmation creates one verified ordinary account", async (t) => {
  const f = await fixture(t),
    value = input();
  const started = await f.store.begin(value);
  assert.equal(started.id, value.id);
  assert.ok(Date.parse(started.expiresAt) > Date.now() + 590_000);
  for (const table of [
    "users",
    "sessions",
    "account_email_verifications",
    "ai_credit_accounts",
    "ai_credit_entries",
    "ai_model_attempts",
    "payment_topup_orders",
  ])
    assert.equal((await f.db.query(`select 1 from ${table}`)).rows.length, 0);
  await assert.rejects(f.store.confirm(f.proof(value)), status(400));
  await f.store.markSent(value.id, value.codeHash);
  const user = await f.store.confirm(f.proof(value));
  assert.deepEqual(user, {
    id: "1",
    email: value.email,
    username: null,
    role: "user",
    mustChangePassword: false,
    serviceConsentRequired: false,
  });
  assert.equal(
    (await f.access.credentials(value.email))?.password_hash,
    value.passwordHash,
  );
  assert.equal((await f.repo.session(f.proof(value).sessionHash))?.id, user.id);
  assert.deepEqual(
    (
      await f.db.query<{ email: string; registration_id: string }>(
        "select email,registration_id::text from account_email_verifications",
      )
    ).rows,
    [{ email: value.email, registration_id: value.id }],
  );
  assert.deepEqual(
    (
      await f.db.query<{ payload: unknown }>(
        "select payload from audit_log where action='account-email-verified'",
      )
    ).rows[0]!.payload,
    { method: "registration-code" },
  );
  for (const table of [
    "ai_credit_accounts",
    "ai_credit_entries",
    "credit_source_lots",
    "ai_model_attempts",
    "payment_topup_orders",
  ])
    assert.equal((await f.db.query(`select 1 from ${table}`)).rows.length, 0);
  await assert.rejects(f.store.confirm(f.proof(value)), status(400));
  assert.equal((await f.db.query("select 1 from users")).rows.length, 1);
  assert.equal((await f.db.query("select 1 from sessions")).rows.length, 1);
});

test("incorrect OTP attempts commit and exhaust after five; missing/wrong proof cannot burn the owner's attempts", async (t) => {
  const f = await fixture(t),
    value = input();
  await f.store.begin(value);
  await f.store.markSent(value.id, value.codeHash);
  await assert.rejects(
    f.store.confirm({ ...f.proof(value), proofHash: hash("wrong-owner") }),
    status(400),
  );
  await assert.rejects(
    f.store.confirm({ ...f.proof(value), id: randomUUID() }),
    status(400),
  );
  assert.equal(
    (
      await f.db.query<{ attempts: number }>(
        "select attempts from email_registrations",
      )
    ).rows[0]!.attempts,
    0,
  );
  for (let n = 1; n <= 5; n++) {
    await assert.rejects(
      f.store.confirm(f.proof(value, hash("wrong-code"))),
      status(400),
    );
    assert.equal(
      (
        await f.db.query<{ attempts: number }>(
          "select attempts from email_registrations",
        )
      ).rows[0]!.attempts,
      n,
    );
  }
  await assert.rejects(f.store.confirm(f.proof(value)), status(400));
  assert.equal((await f.db.query("select 1 from users")).rows.length, 0);
});

test("expiry/delivery failure fail closed; resending invalidates old codes and stale delivery callbacks", async (t) => {
  const f = await fixture(t),
    value = input();
  await f.store.begin(value);
  await f.store.cancelDelivery(value.id, value.codeHash);
  await assert.rejects(f.store.confirm(f.proof(value)), status(400));
  await assert.rejects(f.store.markSent(value.id, value.codeHash), status(400));
  await f.ageQuota();
  const codeHash = hash("replacement-code");
  const resent = await f.store.resend({
    id: value.id,
    proofHash: value.proofHash,
    codeHash,
    ipKey: value.ipKey,
  });
  assert.equal(resent.email, value.email);
  await assert.rejects(f.store.markSent(value.id, value.codeHash), status(400));
  await assert.rejects(
    f.store.cancelDelivery(value.id, value.codeHash),
    status(400),
  );
  await f.store.markSent(value.id, codeHash);
  await assert.rejects(f.store.confirm(f.proof(value)), status(400));
  assert.equal(
    (
      await f.db.query<{ attempts: number }>(
        "select attempts from email_registrations",
      )
    ).rows[0]!.attempts,
    1,
  );
  // Test-only clock fixture: make both timestamps earlier, then restore the
  // immutable identity trigger before executing the real repository method.
  await f.db.exec(
    "alter table email_registrations disable trigger email_registration_identity",
  );
  await f.db.query(
    "update email_registrations set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '10 minutes'",
  );
  await f.db.exec(
    "alter table email_registrations enable trigger email_registration_identity",
  );
  await assert.rejects(f.store.confirm(f.proof(value, codeHash)), status(400));
  assert.equal((await f.db.query("select 1 from users")).rows.length, 0);
});

test("recipient cooldown and three/hour quota persist across send failures and repository instances", async (t) => {
  const f = await fixture(t),
    first = input();
  await f.store.begin(first);
  const other = new EmailRegistration(f.db);
  await assert.rejects(other.begin(input()), status(429));
  await f.store.cancelDelivery(first.id, first.codeHash);
  await f.ageQuota();
  await other.resend({
    id: first.id,
    proofHash: first.proofHash,
    codeHash: hash("second"),
    ipKey: first.ipKey,
  });
  await f.ageQuota();
  await other.resend({
    id: first.id,
    proofHash: first.proofHash,
    codeHash: hash("third"),
    ipKey: first.ipKey,
  });
  await f.ageQuota();
  await assert.rejects(
    f.store.resend({
      id: first.id,
      proofHash: first.proofHash,
      codeHash: hash("fourth"),
      ipKey: first.ipKey,
    }),
    status(429),
  );
  assert.equal(
    (
      await f.db.query(
        "select 1 from email_registration_rate_events where kind='recipient'",
      )
    ).rows.length,
    3,
  );
  assert.equal(
    (
      await f.db.query(
        "select 1 from email_registration_rate_events where kind='ip'",
      )
    ).rows.length,
    3,
  );
  assert.equal((await f.db.query("select 1 from users")).rows.length, 0);
});

test("IP quota spans distinct recipients; independent IP remains available and expired quota stops counting", async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 10; n++)
    await f.store.begin(input(`synthetic-${n}@example.test`));
  await assert.rejects(
    f.store.begin(input("synthetic-blocked@example.test")),
    status(429),
  );
  await f.store.begin(
    input("synthetic-other-ip@example.test", "different-synthetic-ip"),
  );
  await f.db.query(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '61 minutes'",
  );
  await f.store.begin(input("synthetic-after-window@example.test"));
  assert.equal(
    (await f.db.query("select 1 from email_registrations")).rows.length,
    12,
  );
});

test("concurrent confirmation has one commit; two pending registrations for one email cannot replace its credentials", async (t) => {
  const f = await fixture(t),
    first = input();
  await f.store.begin(first);
  await f.store.markSent(first.id, first.codeHash);
  // PGlite serializes transactions. This asserts replay/state-machine safety;
  // independent-connection lock races belong in the PostgreSQL suite.
  const both = await Promise.allSettled([
    f.store.confirm(f.proof(first)),
    new EmailRegistration(f.db).confirm(f.proof(first)),
  ]);
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await f.db.query("select 1 from users")).rows.length, 1);
  assert.equal((await f.db.query("select 1 from sessions")).rows.length, 1);
  const second = input("synthetic-collision@example.test"),
    third = {
      ...input(second.email),
      passwordHash: "different-synthetic-hash",
      proofHash: hash("different-proof"),
    };
  await f.store.begin(second);
  await f.ageQuota();
  await f.store.begin(third);
  await f.store.markSent(second.id, second.codeHash);
  await f.store.markSent(third.id, third.codeHash);
  await f.store.confirm(f.proof(second));
  await assert.rejects(f.store.confirm(f.proof(third)), status(409));
  assert.equal(
    (await f.access.credentials(second.email))?.password_hash,
    second.passwordHash,
  );
  assert.equal((await f.db.query("select 1 from users")).rows.length, 2);
});

test("existing/bootstrap accounts are not declared verified, changed or granted a gift", async (t) => {
  const f = await fixture(t);
  const admin = await f.access.bootstrapAdmin("synthetic-admin-hash");
  const existing = await f.repo.register(
    "synthetic-existing@example.test",
    "existing-synthetic-hash",
  );
  await assert.rejects(
    f.store.begin(input("synthetic-existing@example.test")),
    status(409),
  );
  assert.deepEqual(await f.access.info(admin.id), admin);
  assert.equal(
    (await f.access.credentials("synthetic-existing@example.test"))?.id,
    existing,
  );
  for (const table of [
    "email_registrations",
    "account_email_verifications",
    "email_registration_rate_events",
    "ai_credit_entries",
  ])
    assert.equal((await f.db.query(`select 1 from ${table}`)).rows.length, 0);
});

test("input is bounded, registration identity/consumption cannot be rewritten, and grants omit Worker/deletion", async (t) => {
  const f = await fixture(t),
    value = input();
  for (const changed of [
    { ...value, email: "UPPER@EXAMPLE.TEST" },
    { ...value, email: "bad" },
    { ...value, id: "bad" },
    { ...value, codeHash: "123456" },
    { ...value, ipKey: "raw-IP" },
    { ...value, passwordHash: "" },
    { ...value, unexpected: true },
  ])
    await assert.rejects(f.store.begin(changed), status(400));
  await f.store.begin(value);
  await assert.rejects(f.store.begin(value), status(409));
  await assert.rejects(
    f.store.resend({
      id: value.id,
      proofHash: hash("wrong-proof"),
      codeHash: hash("new-code"),
      ipKey: value.ipKey,
    }),
    status(400),
  );
  for (const change of [
    "email='replacement@example.test'",
    "password_hash='changed'",
    "proof_hash=repeat('b',64)",
    "recipient_key=repeat('b',64)",
    "created_at=created_at-interval '1 hour'",
  ])
    await assert.rejects(
      f.db.query(`update email_registrations set ${change}`),
    );
  await f.store.markSent(value.id, value.codeHash);
  await f.store.confirm(f.proof(value));
  await assert.rejects(
    f.db.query(
      "update email_registrations set consumed_user_id=null,consumed_at=null",
    ),
  );
  const grants = await readFile(
    new URL("../../../deploy/postgres/grants.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    grants,
    /grant select, insert on email_registrations, email_registration_rate_events,\s*account_email_verifications to citygo_api;/,
  );
  assert.match(
    grants,
    /grant update \(code_hash,delivery,attempts,expires_at,consumed_user_id,consumed_at\)\s*on email_registrations to citygo_api;/,
  );
  assert.doesNotMatch(
    grants,
    /grant[^;]*(?:email_registrations|email_registration_rate_events|account_email_verifications)[^;]*to citygo_worker/i,
  );
  assert.doesNotMatch(
    grants,
    /grant[^;]*(?:delete|truncate)[^;]*(?:email_registrations|email_registration_rate_events|account_email_verifications)/i,
  );
});
