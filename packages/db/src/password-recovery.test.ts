import { syntheticServiceConsents } from "./test-service-consents.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AccountAccess,
  AccountReset,
  ClosedAccountRestart,
  FreshAccountReset,
  EmailRegistration,
  PasswordRecovery,
  Repository,
  connectDatabase,
  migrate,
  DomainError,
  type Database,
} from "./index.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const status = (n: number) => (e: unknown) =>
  e instanceof DomainError && e.statusCode === n;
function input(email = "verified@example.test", ip = "test-ip") {
  return {
    id: randomUUID(),
    email,
    proofHash: hash("proof"),
    codeHash: hash("code"),
    recipientKey: hash("recipient:" + email),
    ipKey: hash("ip:" + ip),
  };
}
function confirm(value: ReturnType<typeof input>, codeHash = value.codeHash) {
  return {
    id: value.id,
    proofHash: value.proofHash,
    codeHash,
    newPasswordHash: "new-synthetic-salted-password-hash",
  };
}
async function age(db: Database) {
  await db.query(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '61 minutes'",
  );
}
async function verified(db: Database, email = "verified@example.test") {
  const r = new EmailRegistration(db),
    value = {
      consents: syntheticServiceConsents,
      ...input(email),
      passwordHash: "old-synthetic-salted-password-hash",
    };
  await r.begin(value);
  await r.markSent(value.id, value.codeHash);
  const user = await r.confirm({
    id: value.id,
    proofHash: value.proofHash,
    codeHash: value.codeHash,
    sessionHash: hash("registration-session:" + email),
  });
  await age(db);
  return user;
}
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  return {
    db,
    store: new PasswordRecovery(db),
    access: new AccountAccess(db),
    repo: new Repository(db),
  };
}
async function challenge(db: Database, id: string) {
  return (
    await db.query<{
      attempts: number;
      delivery: string;
      target_user_id: string | null;
      credential_digest: string | null;
      consumed_at: string | null;
      invalidated_at: string | null;
    }>(
      "select attempts,delivery,target_user_id::text,credential_digest,consumed_at,invalidated_at from password_recovery_challenges where id=$1",
      [id],
    )
  ).rows[0]!;
}

test("recovery changes exactly one verified account, revokes every session, invalidates sibling codes and preserves account data", async (t) => {
  const f = await fixture(t),
    user = await verified(f.db),
    value = input();
  await f.db.query(
    "update users set role='admin',username='synthetic-admin' where id=$1",
    [user.id],
  );
  await f.db.query(
    "insert into relocation_profiles(user_id,target_city,preferences) values($1,'Казань','{\"test\":true}')",
    [user.id],
  );
  await f.db.query("insert into ai_credit_accounts(user_id) values($1)", [
    user.id,
  ]);
  const thread = (
    await f.db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'housing') returning id::text",
      [user.id],
    )
  ).rows[0]!;
  await f.db.query(
    "insert into messages(thread_id,role,content) values($1,'user','Сохранённый запрос')",
    [thread.id],
  );
  await f.access.createVerifiedSession(
    user.id,
    "old-synthetic-salted-password-hash",
    hash("second-session"),
  );
  const preserved = [
    "relocation_profiles",
    "ai_credit_accounts",
    "ai_credit_entries",
    "messages",
    "account_email_verifications",
    "payment_topup_orders",
  ];
  const before = await Promise.all(
    preserved.map(
      async (table) =>
        (await f.db.query(`select * from ${table} order by 1`)).rows,
    ),
  );
  const begun = await f.store.begin(value);
  assert.equal(begun.email, value.email);
  assert.ok(Date.parse(begun.expiresAt) > Date.now() + 9 * 60000);
  const stored = await challenge(f.db, value.id);
  assert.equal(stored.target_user_id, user.id);
  assert.equal(
    stored.credential_digest,
    hash("old-synthetic-salted-password-hash"),
  );
  await f.store.markSent(value.id, value.codeHash);
  await age(f.db);
  const sibling = input();
  await f.store.begin(sibling);
  await f.store.markSent(sibling.id, sibling.codeHash);
  const both = await Promise.allSettled([
    f.store.confirm(confirm(value)),
    new PasswordRecovery(f.db).confirm(confirm(value)),
  ]);
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await f.db.query("select 1 from sessions")).rows.length, 0);
  assert.equal(
    (await f.access.credentials(value.email))?.password_hash,
    confirm(value).newPasswordHash,
  );
  assert.ok((await challenge(f.db, sibling.id)).invalidated_at);
  await assert.rejects(f.store.confirm(confirm(sibling)), status(400));
  await assert.rejects(
    f.access.createVerifiedSession(
      user.id,
      "old-synthetic-salted-password-hash",
      hash("stale-login"),
    ),
    status(401),
  );
  const account = await f.access.info(user.id);
  assert.equal(account?.role, "admin");
  assert.equal(account?.username, "synthetic-admin");
  for (let i = 0; i < preserved.length; i++)
    assert.deepEqual(
      (await f.db.query(`select * from ${preserved[i]} order by 1`)).rows,
      before[i],
      preserved[i],
    );
  const audit = (
    await f.db.query<{ payload: unknown }>(
      "select payload from audit_log where action='account-password-recovered'",
    )
  ).rows;
  assert.deepEqual(audit, [
    { payload: { method: "email-code", sessionsRevoked: true } },
  ]);
});

test("unknown, unverified, blocked, deleted and bootstrap addresses persist decoys without revealing email or changing users", async (t) => {
  const f = await fixture(t);
  const admin = await f.access.bootstrapAdmin("admin-synthetic-hash");
  await f.repo.register("unverified@example.test", "legacy-hash");
  for (const state of ["blocked", "deleted"]) {
    const u = await verified(f.db, state + "@example.test");
    await f.db.query("update users set status=$2 where id=$1", [u.id, state]);
  }
  const before = (
    await f.db.query("select * from user_credentials order by user_id")
  ).rows;
  for (const email of [
    "missing@example.test",
    "unverified@example.test",
    "blocked@example.test",
    "deleted@example.test",
    admin.email,
  ]) {
    const v = input(email),
      result = await f.store.begin(v);
    assert.deepEqual(Object.keys(result).sort(), ["expiresAt", "id"]);
    const c = await challenge(f.db, v.id);
    assert.equal(c.target_user_id, null);
    assert.equal(c.credential_digest, null);
    await f.store.markSent(v.id, v.codeHash);
    await assert.rejects(f.store.confirm(confirm(v)), status(400));
  }
  assert.deepEqual(
    (await f.db.query("select * from user_credentials order by user_id")).rows,
    before,
  );
  // A decoy must not acquire an account created after its issuance.
  const future = input("future@example.test");
  await f.store.begin(future);
  await age(f.db);
  await verified(f.db, future.email);
  const next = hash("future-code");
  const resent = await f.store.resend({
    id: future.id,
    proofHash: future.proofHash,
    codeHash: next,
    ipKey: future.ipKey,
  });
  assert.equal(resent.email, undefined);
  await f.store.markSent(future.id, next);
  await assert.rejects(f.store.confirm(confirm(future, next)), status(400));
});

test("proof ownership protects guesses; five wrong codes commit across restarts and resends never restore attempts or lifetime", async (t) => {
  const f = await fixture(t);
  await verified(f.db);
  const v = input(),
    b = await f.store.begin(v);
  await f.store.markSent(v.id, v.codeHash);
  await assert.rejects(
    f.store.confirm({ ...confirm(v), proofHash: hash("wrong-proof") }),
    status(400),
  );
  await assert.rejects(
    f.store.confirm({ ...confirm(v), id: randomUUID() }),
    status(400),
  );
  assert.equal((await challenge(f.db, v.id)).attempts, 0);
  for (let n = 1; n <= 2; n++) {
    await assert.rejects(
      new PasswordRecovery(f.db).confirm(confirm(v, hash("wrong-code"))),
      status(400),
    );
    assert.equal((await challenge(f.db, v.id)).attempts, n);
  }
  await age(f.db);
  const replacement = hash("replacement-code"),
    resent = await f.store.resend({
      id: v.id,
      proofHash: v.proofHash,
      codeHash: replacement,
      ipKey: v.ipKey,
    });
  assert.equal(resent.expiresAt, b.expiresAt);
  assert.equal((await challenge(f.db, v.id)).attempts, 2);
  await f.store.markSent(v.id, replacement);
  for (let n = 3; n <= 5; n++) {
    await assert.rejects(
      f.store.confirm(confirm(v, hash("wrong-code"))),
      status(400),
    );
    assert.equal((await challenge(f.db, v.id)).attempts, n);
  }
  await assert.rejects(f.store.confirm(confirm(v, replacement)), status(400));
  await age(f.db);
  await assert.rejects(
    f.store.resend({
      id: v.id,
      proofHash: v.proofHash,
      codeHash: hash("third"),
      ipKey: v.ipKey,
    }),
    status(400),
  );
});

test("failed delivery and stale callbacks cannot affect replacement codes; expired challenges cannot be revived", async (t) => {
  const f = await fixture(t);
  await verified(f.db);
  const v = input();
  await f.store.begin(v);
  await f.store.cancelDelivery(v.id, v.codeHash);
  await assert.rejects(f.store.markSent(v.id, v.codeHash), status(400));
  await assert.rejects(f.store.confirm(confirm(v)), status(400));
  await age(f.db);
  const next = hash("replacement");
  await f.store.resend({
    id: v.id,
    proofHash: v.proofHash,
    codeHash: next,
    ipKey: v.ipKey,
  });
  await assert.rejects(f.store.cancelDelivery(v.id, v.codeHash), status(400));
  await assert.rejects(f.store.markSent(v.id, v.codeHash), status(400));
  assert.equal((await challenge(f.db, v.id)).delivery, "pending");
  await f.store.markSent(v.id, next);
  // Test-only clock fixture; production may never rewrite the fixed lifetime.
  await f.db.exec(
    "alter table password_recovery_challenges disable trigger password_recovery_identity",
  );
  await f.db.query(
    "update password_recovery_challenges set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '10 minutes'",
  );
  await f.db.exec(
    "alter table password_recovery_challenges enable trigger password_recovery_identity",
  );
  await assert.rejects(f.store.confirm(confirm(v, next)), status(400));
  await assert.rejects(
    f.store.resend({
      id: v.id,
      proofHash: v.proofHash,
      codeHash: hash("later"),
      ipKey: v.ipKey,
    }),
    status(400),
  );
});

test("normal password rotation, revoked verification and blocked status invalidate outstanding recovery authorization", async (t) => {
  for (const mode of ["password", "verification", "status"]) {
    const f = await fixture(t);
    const user = await verified(f.db),
      v = input();
    await f.store.begin(v);
    await f.store.markSent(v.id, v.codeHash);
    if (mode === "password")
      await f.access.changePassword(
        user.id,
        "old-synthetic-salted-password-hash",
        "normal-new-hash",
        hash("rotation-session"),
      );
    if (mode === "verification")
      await f.db.query(
        "delete from account_email_verifications where user_id=$1",
        [user.id],
      );
    if (mode === "status")
      await f.db.query("update users set status='blocked' where id=$1", [
        user.id,
      ]);
    await assert.rejects(f.store.confirm(confirm(v)), status(400));
  }
});

test("recovery and registration share durable recipient/IP/global quotas including decoys, failures and numeric zero", async (t) => {
  const f = await fixture(t),
    v = input("unknown@example.test");
  await f.store.begin(v);
  await f.store.cancelDelivery(v.id, v.codeHash);
  const reg = new EmailRegistration(f.db);
  await assert.rejects(
    reg.begin({
      consents: syntheticServiceConsents,
      ...input(v.email),
      passwordHash: "hash",
    }),
    status(429),
  );
  for (let n = 2; n <= 3; n++) {
    await f.db.query(
      "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 minutes'",
    );
    await new PasswordRecovery(f.db).resend({
      id: v.id,
      proofHash: v.proofHash,
      codeHash: hash("code" + n),
      ipKey: v.ipKey,
    });
  }
  await f.db.query(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 minutes'",
  );
  await assert.rejects(f.store.begin(input(v.email)), status(429));
  await assert.rejects(
    new PasswordRecovery(f.db, { daily: 0, total: null }).begin(
      input("daily-zero@example.test"),
    ),
    status(429),
  );
  await assert.rejects(
    new PasswordRecovery(f.db, { daily: null, total: 0 }).begin(
      input("total-zero@example.test"),
    ),
    status(429),
  );
  const total = (
    await f.db.query<{ n: number }>(
      "select count(*)::int as n from email_registration_rate_events where kind='recipient'",
    )
  ).rows[0]!.n;
  await assert.rejects(
    new PasswordRecovery(f.db, { daily: null, total }).begin(
      input("total-cap@example.test"),
    ),
    status(429),
  );
  await age(f.db);
  const mutable = {
      daily: null as number | null,
      total: null as number | null,
    },
    unlimited = new PasswordRecovery(f.db, mutable);
  mutable.daily = mutable.total = 0;
  for (let n = 0; n < 10; n++)
    await unlimited.begin(input("ip-" + n + "@example.test", "same-ip"));
  await assert.rejects(
    unlimited.begin(input("ip-blocked@example.test", "same-ip")),
    status(429),
  );
  for (const bad of [
    { daily: undefined, total: null },
    { daily: -1, total: null },
    { daily: NaN, total: null },
  ])
    assert.throws(() => new PasswordRecovery(f.db, bad as never));
});

test("recovery schema constrains identity/lifetime and grants only runtime state transitions; reset tools retain its history", async (t) => {
  const f = await fixture(t),
    v = input();
  await f.store.begin(v);
  for (const set of [
    "target_user_id=1",
    "proof_hash=repeat('a',64)",
    "recipient_key=repeat('a',64)",
    "expires_at=expires_at+interval '1 hour'",
    "attempts=-1",
  ])
    await assert.rejects(
      f.db.query(`update password_recovery_challenges set ${set}`),
    );
  const plans = [
    await new AccountReset(f.db).plan(),
    await new ClosedAccountRestart(f.db).plan(),
    await new FreshAccountReset(f.db).plan(),
  ];
  for (const plan of plans)
    assert.equal(plan.counts.password_recovery_challenges, 1);
  for (const plan of plans.slice(1))
    assert.ok(
      plan.blockers.some(
        (blocker) =>
          blocker.code === "PASSWORD_RECOVERY_HISTORY_REQUIRES_REVIEW" &&
          blocker.count === 1,
      ),
    );
  assert.equal(
    (await f.db.query("select 1 from password_recovery_challenges")).rows
      .length,
    1,
  );
  const grants = await readFile(
    new URL("../../../deploy/postgres/grants.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    grants,
    /grant select, insert on password_recovery_challenges to citygo_api/,
  );
  assert.match(
    grants,
    /grant update \(code_hash,delivery,attempts,consumed_at,invalidated_at\)\s+on password_recovery_challenges to citygo_api/,
  );
  assert.doesNotMatch(
    grants,
    /grant[^;]*(?:delete|truncate)[^;]*password_recovery_challenges/i,
  );
  assert.doesNotMatch(
    grants,
    /grant[^;]*password_recovery_challenges[^;]*to citygo_worker/i,
  );
});
