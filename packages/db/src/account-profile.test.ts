import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import {
  AccountProfile,
  AiCreditLedger,
  EmailRegistration,
  PasswordRecovery,
  PhoneVerification,
  configurePhoneVerification,
  Repository,
  DomainError,
  connectDatabase,
  migrate,
  type Database,
} from "./index.js";
import { syntheticServiceConsents } from "./test-service-consents.js";
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const status = (n: number) => (e: unknown) =>
  e instanceof DomainError && e.statusCode === n;
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    userId = await repo.register(
      "legacy@example.test",
      "synthetic-password-hash",
    );
  const ctx = { userId, sessionTokenHash: h("first-session") };
  await repo.createSession(userId, ctx.sessionTokenHash);
  const state = new AccountProfile(db);
  const begin = () => ({
    ...ctx,
    id: randomUUID(),
    email: "legacy@example.test",
    proofHash: h("account-proof"),
    codeHash: h("account-code"),
    recipientKey: h("recipient"),
    ipKey: h("ip"),
  });
  return { db, repo, state, ctx, begin };
}
async function age(db: Database) {
  await db.exec(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '61 minutes'",
  );
}
const confirm = (
  x: ReturnType<Awaited<ReturnType<typeof fixture>>["begin"]>,
) => ({
  userId: x.userId,
  sessionTokenHash: x.sessionTokenHash,
  id: x.id,
  proofHash: x.proofHash,
  codeHash: x.codeHash,
});

test("existing account confirmation records its own consumed proof and preserves identity, sessions, consents and money", async (t) => {
  const f = await fixture(t),
    input = f.begin();
  assert.deepEqual(await f.state.summary(f.ctx), {
    userId: f.ctx.userId,
    email: input.email,
    emailVerified: false,
    phoneVerified: false,
    giftClaimed: false,
  });
  await f.state.begin(input);
  await assert.rejects(f.state.confirm(confirm(input)), status(400));
  await f.state.markSent(input.id, input.codeHash);
  assert.deepEqual(await f.state.confirm(confirm(input)), {
    userId: f.ctx.userId,
    emailVerified: true,
  });
  await assert.rejects(f.state.confirm(confirm(input)), status(400));
  await assert.rejects(
    f.state.begin({ ...f.begin(), id: randomUUID() }),
    status(409),
  );
  const proof = (
    await f.db.query<{
      registration_id: string | null;
      confirmation_id: string;
      email: string;
    }>(
      "select registration_id::text,confirmation_id::text,email from account_email_verifications where user_id=$1",
      [f.ctx.userId],
    )
  ).rows[0]!;
  assert.equal(proof.registration_id, null);
  assert.equal(proof.confirmation_id, input.id);
  assert.equal(proof.email, input.email);
  assert.equal((await f.state.summary(f.ctx)).emailVerified, true);
  for (const [table, count] of [
    ["users", 1],
    ["sessions", 1],
    ["email_registrations", 0],
    ["service_consent_events", 0],
    ["ai_credit_entries", 0],
    ["phone_welcome_claims", 0],
  ] as const)
    assert.equal(
      (
        await f.db.query<{ n: number }>(
          `select count(*)::int as n from ${table}`,
        )
      ).rows[0]!.n,
      count,
    );
  const audit = (
    await f.db.query<{ payload: unknown }>(
      "select payload from audit_log where action='account-email-verified'",
    )
  ).rows[0]!.payload;
  assert.deepEqual(audit, {
    method: "account-email-code",
    confirmationId: input.id,
  });
});
test("wrong guesses commit, resend preserves the five-guess budget and expiry, delayed delivery cannot affect the newer code", async (t) => {
  const f = await fixture(t),
    input = f.begin();
  await f.state.begin(input);
  await f.state.markSent(input.id, input.codeHash);
  await assert.rejects(
    f.state.confirm({ ...confirm(input), codeHash: h("wrong") }),
    status(400),
  );
  await age(f.db);
  const codeHash = h("new-code");
  const sent = await f.state.resend({
    ...f.ctx,
    id: input.id,
    proofHash: input.proofHash,
    codeHash,
    ipKey: input.ipKey,
  });
  await assert.rejects(f.state.markSent(input.id, input.codeHash), status(400));
  await assert.rejects(
    f.state.cancelDelivery(input.id, input.codeHash),
    status(400),
  );
  await f.state.markSent(input.id, codeHash);
  for (let i = 0; i < 4; i++)
    await assert.rejects(f.state.confirm(confirm(input)), status(400));
  await assert.rejects(
    f.state.confirm({ ...confirm(input), codeHash }),
    status(400),
  );
  const row = (
    await f.db.query<{ attempts: number; expiresAt: string }>(
      `select attempts,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from account_email_confirmation_challenges where id=$1`,
      [input.id],
    )
  ).rows[0]!;
  assert.equal(row.attempts, 5);
  assert.equal(row.expiresAt, sent.expiresAt);
  assert.equal((await f.state.summary(f.ctx)).emailVerified, false);
});
test("expired account-email challenge or issuing session cannot be confirmed or renewed by resend", async (t) => {
  const f = await fixture(t),
    input = f.begin();
  const started = await f.state.begin(input);
  await f.state.markSent(input.id, input.codeHash);
  await assert.rejects(
    f.state.confirm({ ...confirm(input), codeHash: h("wrong-expiry-guess") }),
    status(400),
  );
  await age(f.db);
  const replacement = h("replacement-before-expiry");
  const resent = await f.state.resend({
    ...f.ctx,
    id: input.id,
    proofHash: input.proofHash,
    codeHash: replacement,
    ipKey: input.ipKey,
  });
  assert.equal(resent.expiresAt, started.expiresAt);
  await f.state.markSent(input.id, replacement);
  // Synthetic clock fixture only: the runtime has no such DDL privilege. The
  // identity trigger is restored before exercising the expired state.
  await f.db.exec(
    "alter table account_email_confirmation_challenges disable trigger account_email_confirmation_identity",
  );
  try {
    await f.db.query(
      "update account_email_confirmation_challenges set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '10 minutes' where id=$1",
      [input.id],
    );
  } finally {
    await f.db.exec(
      "alter table account_email_confirmation_challenges enable trigger account_email_confirmation_identity",
    );
  }
  const snapshot = () =>
    f.db.query(
      "select attempts,expires_at::text,code_hash,consumed_at,invalidated_at from account_email_confirmation_challenges where id=$1",
      [input.id],
    );
  const before = (await snapshot()).rows;
  assert.equal(before[0]!.attempts, 1);
  const events = (
    await f.db.query("select 1 from email_registration_rate_events")
  ).rows.length;
  await assert.rejects(
    f.state.resend({
      ...f.ctx,
      id: input.id,
      proofHash: input.proofHash,
      codeHash: h("expired-replacement"),
      ipKey: input.ipKey,
    }),
    status(400),
  );
  await assert.rejects(
    f.state.confirm({ ...confirm(input), codeHash: replacement }),
    status(400),
  );
  await assert.rejects(f.state.markSent(input.id, replacement), status(400));
  await assert.rejects(
    f.db.query(
      "update account_email_confirmation_challenges set expires_at=expires_at+interval '1 hour' where id=$1",
      [input.id],
    ),
    { code: "23514" },
  );
  assert.deepEqual((await snapshot()).rows, before);
  assert.equal(
    (await f.db.query("select 1 from email_registration_rate_events")).rows
      .length,
    events,
  );
  assert.equal(
    (await f.db.query("select 1 from account_email_verifications")).rows.length,
    0,
  );
  assert.equal((await f.state.summary(f.ctx)).emailVerified, false);

  const s = await fixture(t),
    value = s.begin();
  await s.state.begin(value);
  await s.state.markSent(value.id, value.codeHash);
  await assert.rejects(
    s.state.confirm({ ...confirm(value), codeHash: h("wrong-session-guess") }),
    status(400),
  );
  await s.db.query(
    "update sessions set expires_at=clock_timestamp()-interval '1 second' where token_hash=$1",
    [value.sessionTokenHash],
  );
  const sessionBefore = (
    await s.db.query(
      "select attempts,expires_at::text,code_hash,consumed_at,invalidated_at from account_email_confirmation_challenges where id=$1",
      [value.id],
    )
  ).rows;
  await assert.rejects(
    s.state.resend({
      ...s.ctx,
      id: value.id,
      proofHash: value.proofHash,
      codeHash: h("expired-session-replacement"),
      ipKey: value.ipKey,
    }),
    status(401),
  );
  await assert.rejects(s.state.confirm(confirm(value)), status(401));
  await assert.rejects(s.state.summary(s.ctx), status(401));
  assert.deepEqual(
    (
      await s.db.query(
        "select attempts,expires_at::text,code_hash,consumed_at,invalidated_at from account_email_confirmation_challenges where id=$1",
        [value.id],
      )
    ).rows,
    sessionBefore,
  );
  assert.equal(sessionBefore[0]!.attempts, 1);
  assert.equal(
    (await s.db.query("select 1 from email_registration_rate_events")).rows
      .length,
    2,
  );
  assert.equal(
    (await s.db.query("select 1 from account_email_verifications")).rows.length,
    0,
  );
});

test("challenge cannot cross users or sessions, revoked sessions and rotated passwords are rechecked", async (t) => {
  const f = await fixture(t),
    input = f.begin();
  await f.state.begin(input);
  await f.state.markSent(input.id, input.codeHash);
  const other = await f.repo.register("other@example.test", "other-password"),
    otherSession = h("other-session");
  await f.repo.createSession(other, otherSession);
  await assert.rejects(
    f.state.confirm({
      ...confirm(input),
      userId: other,
      sessionTokenHash: otherSession,
    }),
    status(400),
  );
  const second = h("second-session");
  await f.repo.createSession(f.ctx.userId, second);
  await assert.rejects(
    f.state.confirm({ ...confirm(input), sessionTokenHash: second }),
    status(400),
  );
  await f.db.query("delete from sessions where token_hash=$1", [
    input.sessionTokenHash,
  ]);
  await assert.rejects(f.state.confirm(confirm(input)), status(401));
  await f.repo.createSession(f.ctx.userId, input.sessionTokenHash);
  await f.db.query(
    "update user_credentials set password_hash='rotated' where user_id=$1",
    [f.ctx.userId],
  );
  await assert.rejects(f.state.confirm(confirm(input)), status(400));
  await f.db.query("update users set status='blocked' where id=$1", [
    f.ctx.userId,
  ]);
  await assert.rejects(f.state.summary(f.ctx), status(401));
});
test("new begin invalidates older proofs; failed delivery and spoofed email cannot create verification", async (t) => {
  const f = await fixture(t),
    first = f.begin();
  await f.state.begin(first);
  await f.state.markSent(first.id, first.codeHash);
  await age(f.db);
  const second = f.begin();
  await f.state.begin(second);
  await assert.rejects(f.state.confirm(confirm(first)), status(400));
  await f.state.cancelDelivery(second.id, second.codeHash);
  await assert.rejects(f.state.confirm(confirm(second)), status(400));
  await age(f.db);
  await assert.rejects(
    f.state.begin({ ...f.begin(), email: "spoof@example.test" }),
    status(400),
  );
  assert.equal(
    (await f.db.query("select 1 from account_email_verifications")).rows.length,
    0,
  );
});
test("shared recipient and global email quotas are consumed before delivery, including failed sends", async (t) => {
  const f = await fixture(t),
    input = f.begin();
  await f.state.begin(input);
  await f.state.cancelDelivery(input.id, input.codeHash);
  await assert.rejects(f.state.begin(f.begin()), status(429));
  const recovery = new PasswordRecovery(f.db);
  await assert.rejects(
    recovery.begin({
      id: randomUUID(),
      email: input.email,
      proofHash: h("recovery-proof"),
      codeHash: h("recovery-code"),
      recipientKey: input.recipientKey,
      ipKey: input.ipKey,
    }),
    status(429),
  );
  await age(f.db);
  const capped = new AccountProfile(f.db, { daily: null, total: 1 });
  await assert.rejects(capped.begin(f.begin()), status(429));
  assert.equal(
    (await f.db.query("select 1 from email_registration_rate_events")).rows
      .length,
    2,
  );
});
test("only the exact bootstrap placeholder is omitted; profile reads do not grant gifts", async (t) => {
  const f = await fixture(t);
  await f.db.query("update users set username='admin' where id=$1", [
    f.ctx.userId,
  ]);
  await f.db.query(
    "update user_credentials set email='admin@citygo.invalid' where user_id=$1",
    [f.ctx.userId],
  );
  assert.equal((await f.state.summary(f.ctx)).email, null);
  await assert.rejects(
    f.state.begin({ ...f.begin(), email: "admin@citygo.invalid" }),
    status(400),
  );
  await f.db.query("update users set username=null where id=$1", [
    f.ctx.userId,
  ]);
  assert.equal((await f.state.summary(f.ctx)).email, "admin@citygo.invalid");
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries")).rows.length,
    0,
  );
});
test("phone status requires the exact consumed challenge and claim; a bonus alone is not a confirmed phone", async (t) => {
  const f = await fixture(t),
    input = f.begin();
  await f.state.begin(input);
  await f.state.markSent(input.id, input.codeHash);
  await f.state.confirm(confirm(input));
  const policy = {
    identityKeyFingerprint: h("phone-identity"),
    normalizationVersion: "e164-v1" as const,
    limits: {
      userHourly: 3,
      phoneHourly: 3,
      ipHourly: 10,
      cooldownSeconds: 60,
      globalDaily: null,
      globalTotal: null,
    },
  };
  await configurePhoneVerification(f.db, policy);
  const phone = new PhoneVerification(f.db, policy);
  const value = {
    id: randomUUID(),
    phoneKey: h("synthetic-phone"),
    proofHash: h("phone-proof"),
    codeHash: h("phone-code"),
    ipKey: h("phone-ip"),
  };
  await phone.begin(f.ctx, value);
  await phone.markAccepted(value.id, value.codeHash);
  await phone.confirm(f.ctx, {
    id: value.id,
    phoneKey: value.phoneKey,
    proofHash: value.proofHash,
    codeHash: value.codeHash,
  });
  const profile = await f.state.summary(f.ctx);
  assert.equal(profile.phoneVerified, true);
  assert.equal(profile.giftClaimed, true);
  const other = await f.repo.register("bonus-only@example.test", "hash"),
    ctx = { userId: other, sessionTokenHash: h("bonus-session") };
  await f.repo.createSession(other, ctx.sessionTokenHash);
  await new AiCreditLedger(
    f.db,
    "routerai_citygo_10x",
    false,
    "fixed5_overdraft",
  ).grantWelcome(other, other);
  const bonus = await f.state.summary(ctx);
  assert.equal(bonus.giftClaimed, true);
  assert.equal(bonus.phoneVerified, false);
});

test("schema30 registration evidence upgrades unchanged; XOR and proof guards reject invented verification", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith(".sql") && n < "0031_")
    .sort())
    await db.exec(
      (await readFile(new URL(name, directory), "utf8"))
        .replace(/^begin;\s*/i, "")
        .replace(/commit;\s*$/i, ""),
    );
  const r = new EmailRegistration(db),
    input = {
      id: randomUUID(),
      email: "old-verified@example.test",
      passwordHash: "old-hash",
      proofHash: h("p"),
      codeHash: h("c"),
      recipientKey: h("r"),
      ipKey: h("i"),
      consents: syntheticServiceConsents,
    };
  await r.begin(input);
  await r.markSent(input.id, input.codeHash);
  const user = await r.confirm({
    id: input.id,
    proofHash: input.proofHash,
    codeHash: input.codeHash,
    sessionHash: h("old-session"),
  });
  const before = (
    await db.query(
      "select user_id::text,registration_id::text,email,verified_at::text from account_email_verifications",
    )
  ).rows;
  await db.exec(
    await readFile(
      new URL("0031_account_email_confirmation.sql", directory),
      "utf8",
    ),
  );
  assert.deepEqual(
    (
      await db.query(
        "select user_id::text,registration_id::text,email,verified_at::text from account_email_verifications",
      )
    ).rows,
    before,
  );
  assert.equal(
    (
      await db.query<{ confirmation_id: string | null }>(
        "select confirmation_id from account_email_verifications",
      )
    ).rows[0]!.confirmation_id,
    null,
  );
  await assert.rejects(
    db.query(
      "insert into account_email_verifications(user_id,email) values($1,$2)",
      [user.id, input.email],
    ),
  );
  const repo = new Repository(db),
    legacy = await repo.register("invented@example.test", "hash");
  await assert.rejects(
    db.query(
      "insert into account_email_verifications(user_id,registration_id,email) values($1,$2,$3)",
      [legacy, input.id, "invented@example.test"],
    ),
  );
});
