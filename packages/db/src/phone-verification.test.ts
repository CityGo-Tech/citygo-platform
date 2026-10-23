import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CITYGO_10X_TARIFF, routerAiCostMicros } from "@citygo/contracts";
import { AiCreditCharges } from "./ai-credit-charges.js";
import { AiCreditLedger } from "./ai-credit.js";
import {
  AccountAccess,
  DomainError,
  EmailRegistration,
  PhoneVerification,
  Repository,
  configurePhoneVerification,
  connectDatabase,
  migrate,
  type PhoneVerificationContext,
  type PhoneVerificationPolicy,
} from "./index.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const status = (code: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === code;
const defaultPolicy: PhoneVerificationPolicy = {
  identityKeyFingerprint: hash("synthetic-phone-key"),
  normalizationVersion: "e164-v1",
  limits: {
    userHourly: 3,
    phoneHourly: 3,
    ipHourly: 10,
    cooldownSeconds: 0,
    globalDaily: 100,
    globalTotal: 1000,
  },
};
const input = (phone = "synthetic-phone", ip = "synthetic-ip") => ({
  id: randomUUID(),
  phoneKey: hash(phone),
  proofHash: hash("synthetic-proof"),
  codeHash: hash("synthetic-code"),
  ipKey: hash(ip),
});
const confirmation = (value: ReturnType<typeof input>) => ({
  id: value.id,
  phoneKey: value.phoneKey,
  proofHash: value.proofHash,
  codeHash: value.codeHash,
});
async function fixture(t: TestContext, policy = defaultPolicy, bind = true) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  if (bind) await configurePhoneVerification(db, policy);
  async function user(name = randomUUID()): Promise<PhoneVerificationContext> {
    const sessionTokenHash = hash("synthetic-session-" + name);
    const email = new EmailRegistration(db),
      value = {
        id: randomUUID(),
        email: name + "@example.test",
        passwordHash: "synthetic-password-hash",
        proofHash: hash("email-proof"),
        codeHash: hash("email-code"),
        recipientKey: hash("email:" + name),
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
  const ctx = await user();
  const phone = new PhoneVerification(db, policy);
  const ledger = new AiCreditLedger(
    db,
    "routerai_citygo_10x",
    false,
    "fixed5_overdraft",
  );
  const money = async () =>
    (
      await db.query(`select jsonb_build_object(
    'accounts',(select coalesce(jsonb_agg(to_jsonb(t) order by user_id),'[]'::jsonb) from ai_credit_accounts t),
    'entries',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from ai_credit_entries t),
    'lots',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from credit_source_lots t),
    'claims',(select coalesce(jsonb_agg(to_jsonb(t) order by user_id),'[]'::jsonb) from phone_welcome_claims t),
    'debts',(select coalesce(jsonb_agg(to_jsonb(t) order by hold_id),'[]'::jsonb) from credit_charge_debts t),
    'repayments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from credit_debt_repayments t)
  ) as snapshot`)
    ).rows[0];
  return { db, phone, ctx, user, ledger, money };
}

test("unverified legacy email and a verification fact for a different current email cannot request SMS or claim a gift", async (t) => {
  const f = await fixture(t),
    repo = new Repository(f.db),
    userId = await repo.register("unverified@example.test", "synthetic-hash"),
    ctx = { userId, sessionTokenHash: hash("unverified-session") },
    value = input();
  await repo.createSession(userId, ctx.sessionTokenHash);
  await assert.rejects(f.phone.begin(ctx, value), status(403));
  assert.deepEqual(await f.phone.status(ctx), {
    alreadyGranted: false,
    giftStatus: "email_required",
  });
  assert.equal(
    (await f.db.query("select 1 from phone_verification_sends")).rows.length,
    0,
  );
  await f.phone.begin(f.ctx, value);
  await f.phone.markAccepted(value.id, value.codeHash);
  await f.db.query(
    "update user_credentials set email='changed-unverified@example.test' where user_id=$1",
    [f.ctx.userId],
  );
  await assert.rejects(
    f.phone.confirm(f.ctx, confirmation(value)),
    status(403),
  );
  assert.equal(
    (await f.db.query("select 1 from phone_welcome_claims")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries")).rows.length,
    0,
  );
});

test("phone core is unbound by default; explicit policy is idempotent and silent key/limit rotation fails closed", async (t) => {
  const f = await fixture(t, defaultPolicy, false),
    value = input();
  assert.equal(await f.phone.readiness(), false);
  await assert.rejects(f.phone.begin(f.ctx, value), status(503));
  await configurePhoneVerification(f.db, defaultPolicy);
  await configurePhoneVerification(f.db, defaultPolicy);
  assert.equal(await f.phone.readiness(), true);
  assert.deepEqual(await f.phone.status(f.ctx), {
    alreadyGranted: false,
    giftStatus: "eligible",
  });
  await f.phone.begin(f.ctx, value);
  await f.phone.markAccepted(value.id, value.codeHash);
  for (const policy of [
    { ...defaultPolicy, identityKeyFingerprint: hash("rotated-key") },
    { ...defaultPolicy, limits: { ...defaultPolicy.limits, globalDaily: 101 } },
  ]) {
    await assert.rejects(configurePhoneVerification(f.db, policy), status(409));
    const rotated = new PhoneVerification(f.db, policy);
    await assert.rejects(rotated.begin(f.ctx, input()), status(503));
    await assert.rejects(
      rotated.confirm(f.ctx, confirmation(value)),
      status(503),
    );
  }
  assert.equal(
    (await f.db.query("select 1 from phone_verification_sends")).rows.length,
    1,
  );
  assert.equal(
    (await f.db.query("select 1 from phone_welcome_claims")).rows.length,
    0,
  );
});

test("accepted user-bound OTP atomically grants one 500 CityGo bonus and trigger-created gift source; exact replay returns same receipt", async (t) => {
  const f = await fixture(t),
    value = input();
  const before = await f.money();
  const started = await f.phone.begin(f.ctx, value);
  assert.equal(started.id, value.id);
  assert.ok(Date.parse(started.expiresAt) > Date.now());
  assert.deepEqual(await f.money(), before);
  await assert.rejects(
    f.phone.confirm(f.ctx, confirmation(value)),
    status(400),
  );
  await f.phone.markAccepted(value.id, value.codeHash);
  const receipt = await f.phone.confirm(f.ctx, confirmation(value));
  assert.equal(receipt.grantedMicros, 500_000_000);
  assert.equal(receipt.alreadyGranted, false);
  assert.deepEqual(await f.phone.status(f.ctx), {
    alreadyGranted: true,
    giftStatus: "granted",
  });
  const after = await f.money();
  assert.deepEqual(await f.phone.confirm(f.ctx, confirmation(value)), {
    ...receipt,
    alreadyGranted: true,
  });
  assert.deepEqual(await f.money(), after);
  assert.equal(
    (await f.ledger.status(f.ctx.userId)).availableMicros,
    500_000_000,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select kind,gross_micros::text,source_operation_id::text from credit_source_lots",
      )
    ).rows,
    [
      {
        kind: "gift",
        gross_micros: "500000000",
        source_operation_id: receipt.operationId,
      },
    ],
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries where kind='bonus'"))
      .rows.length,
    1,
  );
  await assert.rejects(
    f.phone.begin(f.ctx, input("different-number")),
    status(409),
  );
  await assert.rejects(f.phone.begin(await f.user(), input()), status(409));
  assert.equal(
    (await f.db.query("select 1 from phone_verification_sends")).rows.length,
    1,
  );
});

test("wrong-code attempts commit, proof/owner/phone mismatches do not guess codes, five attempts stop confirmation", async (t) => {
  const f = await fixture(t),
    value = input(),
    other = await f.user();
  await f.phone.begin(f.ctx, value);
  await f.phone.markAccepted(value.id, value.codeHash);
  for (const [ctx, changes] of [
    [other, {}],
    [f.ctx, { proofHash: hash("bad-proof") }],
    [f.ctx, { phoneKey: hash("wrong-phone") }],
  ] as const)
    await assert.rejects(
      f.phone.confirm(ctx, { ...confirmation(value), ...changes }),
      status(400),
    );
  assert.equal(
    (
      await f.db.query<{ attempts: number }>(
        "select attempts from phone_verification_challenges",
      )
    ).rows[0]!.attempts,
    0,
  );
  for (let n = 1; n <= 5; n++) {
    await assert.rejects(
      f.phone.confirm(f.ctx, {
        ...confirmation(value),
        codeHash: hash("wrong-code"),
      }),
      status(400),
    );
    assert.equal(
      (
        await f.db.query<{ attempts: number }>(
          "select attempts from phone_verification_challenges",
        )
      ).rows[0]!.attempts,
      n,
    );
  }
  await assert.rejects(
    f.phone.confirm(f.ctx, confirmation(value)),
    status(400),
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_accounts")).rows.length,
    0,
  );
});

test("resend replaces code; delayed sender CAS, expired codes and superseded challenges cannot issue a gift", async (t) => {
  const f = await fixture(t),
    value = input();
  await f.phone.begin(f.ctx, value);
  const next = { ...value, codeHash: hash("replacement-code") };
  await f.phone.resend(f.ctx, next);
  await assert.rejects(
    f.phone.markAccepted(value.id, value.codeHash),
    status(400),
  );
  await assert.rejects(
    f.phone.cancelDelivery(value.id, value.codeHash),
    status(400),
  );
  await f.phone.markAccepted(next.id, next.codeHash);
  await assert.rejects(
    f.phone.confirm(f.ctx, confirmation(value)),
    status(400),
  );
  const newest = input("different-number");
  await f.phone.begin(f.ctx, newest);
  await assert.rejects(f.phone.confirm(f.ctx, confirmation(next)), status(400));
  await assert.rejects(
    f.phone.resend(f.ctx, { ...next, codeHash: hash("stale-resend") }),
    status(400),
  );
  await f.phone.markAccepted(newest.id, newest.codeHash);
  await f.db.query(
    "update phone_verification_challenges set expires_at=created_at+interval '1 microsecond' where id=$1",
    [newest.id],
  );
  await assert.rejects(
    f.phone.confirm(f.ctx, confirmation(newest)),
    status(400),
  );
  assert.equal(
    (await f.db.query("select 1 from phone_welcome_claims")).rows.length,
    0,
  );
});

for (const dimension of [
  "userHourly",
  "phoneHourly",
  "ipHourly",
  "globalDaily",
  "globalTotal",
  "cooldownSeconds",
] as const) {
  test(`durable ${dimension} quota is consumed before delivery and cannot be refunded by failed sends`, async (t) => {
    const limits = {
      ...defaultPolicy.limits,
      userHourly: 100,
      phoneHourly: 100,
      ipHourly: 100,
      [dimension]: dimension === "cooldownSeconds" ? 60 : 1,
    };
    const f = await fixture(t, { ...defaultPolicy, limits }),
      first = input();
    await f.phone.begin(f.ctx, first);
    await f.phone.cancelDelivery(first.id, first.codeHash);
    const sameUser =
      dimension === "userHourly" || dimension === "cooldownSeconds";
    const ctx = sameUser ? f.ctx : await f.user();
    const second = input(
      dimension === "phoneHourly" ? "synthetic-phone" : "other-phone",
      dimension === "ipHourly" ? "synthetic-ip" : "other-ip",
    );
    await assert.rejects(f.phone.begin(ctx, second), status(429));
    assert.equal(
      (await f.db.query("select 1 from phone_verification_sends")).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("select 1 from phone_verification_challenges")).rows
        .length,
      1,
    );
  });
}
test("zero admission caps deny instead of selecting defaults", async (t) => {
  const f = await fixture(t, {
    ...defaultPolicy,
    limits: { ...defaultPolicy.limits, globalTotal: 0 },
  });
  await assert.rejects(f.phone.begin(f.ctx, input()), status(429));
  assert.equal(
    (await f.db.query("select 1 from phone_verification_sends")).rows.length,
    0,
  );
});

test("legacy gift blocks a new SMS before quota consumption without guessing a historical verified phone", async (t) => {
  const f = await fixture(t);
  await f.ledger.grantWelcome(f.ctx.userId, f.ctx.userId);
  await assert.rejects(f.phone.begin(f.ctx, input()), status(409));
  assert.equal(
    (await f.db.query("select 1 from phone_verification_sends")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select 1 from phone_welcome_claims")).rows.length,
    0,
  );
});

test("deleted/recreated account, phone change and consumed challenge do not renew a claimed gift", async (t) => {
  const f = await fixture(t),
    value = input();
  await f.phone.begin(f.ctx, value);
  await f.phone.markAccepted(value.id, value.codeHash);
  await f.phone.confirm(f.ctx, confirmation(value));
  await f.db.query("update users set status='deleted' where id=$1", [
    f.ctx.userId,
  ]);
  const replacement = await f.user();
  await assert.rejects(f.phone.begin(replacement, input()), status(409));
  await assert.rejects(
    f.phone.confirm(replacement, confirmation(value)),
    status(400),
  );
  await assert.rejects(
    f.phone.confirm(f.ctx, confirmation(value)),
    status(401),
  );
  await assert.rejects(
    f.db.query("delete from users where id=$1", [f.ctx.userId]),
    /foreign key/,
  );
});

test("expired/revoked sessions, deleted users and temporary passwords fail closed even after an accepted delivery", async (t) => {
  const f = await fixture(t),
    value = input();
  await f.phone.begin(f.ctx, value);
  await f.phone.markAccepted(value.id, value.codeHash);
  await f.db.query(
    "update sessions set expires_at=clock_timestamp()-interval '1 second' where token_hash=$1",
    [f.ctx.sessionTokenHash],
  );
  await assert.rejects(
    f.phone.confirm(f.ctx, confirmation(value)),
    status(401),
  );
  await f.db.query(
    "update sessions set expires_at=clock_timestamp()+interval '1 day' where token_hash=$1",
    [f.ctx.sessionTokenHash],
  );
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.ctx.userId,
  ]);
  await assert.rejects(
    f.phone.confirm(f.ctx, confirmation(value)),
    status(403),
  );
  await f.db.query("update users set must_change_password=false where id=$1", [
    f.ctx.userId,
  ]);
  await new AccountAccess(f.db).changePassword(
    f.ctx.userId,
    "synthetic-password-hash",
    "new-synthetic-hash",
    hash("replacement-session"),
  );
  await assert.rejects(
    f.phone.confirm(f.ctx, confirmation(value)),
    status(401),
  );
  assert.equal(
    (await f.db.query("select 1 from phone_welcome_claims")).rows.length,
    0,
  );
});

test("gift status is account/session-bound, read-only and retains a consumed gift after reactivation", async (t) => {
  const f = await fixture(t),
    value = input();
  await f.phone.begin(f.ctx, value);
  await f.phone.markAccepted(value.id, value.codeHash);
  await f.phone.confirm(f.ctx, confirmation(value));
  const other = await f.user(),
    before = await f.money();
  assert.deepEqual(await f.phone.status(other), {
    alreadyGranted: false,
    giftStatus: "eligible",
  });
  assert.deepEqual(await f.phone.status(f.ctx), {
    alreadyGranted: true,
    giftStatus: "granted",
  });
  await f.db.query("update users set status='deleted' where id=$1", [
    f.ctx.userId,
  ]);
  await assert.rejects(f.phone.status(f.ctx), status(401));
  await f.db.query("update users set status='active' where id=$1", [
    f.ctx.userId,
  ]);
  assert.deepEqual(await f.phone.status(f.ctx), {
    alreadyGranted: true,
    giftStatus: "granted",
  });
  const next = {
    ...f.ctx,
    sessionTokenHash: hash("replacement-status-session"),
  };
  await new Repository(f.db).createSession(next.userId, next.sessionTokenHash);
  await f.db.query("delete from sessions where token_hash=$1", [
    f.ctx.sessionTokenHash,
  ]);
  await assert.rejects(f.phone.status(f.ctx), status(401));
  assert.deepEqual(await f.phone.status(next), {
    alreadyGranted: true,
    giftStatus: "granted",
  });
  await assert.rejects(
    f.phone.status({ ...other, sessionTokenHash: next.sessionTokenHash }),
    status(401),
  );
  assert.deepEqual(await f.money(), before);
});

test("post-claim failure rolls back consumption, 500 bonus, gift lot and audit together; safe retry grants once", async (t) => {
  const f = await fixture(t),
    value = input();
  await f.phone.begin(f.ctx, value);
  await f.phone.markAccepted(value.id, value.codeHash);
  await f.db
    .exec(`create function synthetic_fail_phone_audit() returns trigger language plpgsql as $$ begin
    if new.action='ai-credit-phone-welcome-granted' then raise exception 'synthetic-after-claim-fault'; end if; return new; end $$;
    create trigger synthetic_fail_phone_audit before insert on audit_log for each row execute function synthetic_fail_phone_audit()`);
  const before = await f.money();
  await assert.rejects(
    f.phone.confirm(f.ctx, confirmation(value)),
    /synthetic-after-claim-fault/,
  );
  assert.deepEqual(await f.money(), before);
  assert.equal(
    (
      await f.db.query<{ consumed: boolean }>(
        "select consumed_at is not null as consumed from phone_verification_challenges",
      )
    ).rows[0]!.consumed,
    false,
  );
  await f.db.exec(
    "drop trigger synthetic_fail_phone_audit on audit_log; drop function synthetic_fail_phone_audit()",
  );
  assert.equal(
    (await f.phone.confirm(f.ctx, confirmation(value))).alreadyGranted,
    false,
  );
});

test("phone gift invokes existing gift-first debt repayment without a second charge or modifying fixed5/10x", async (t) => {
  const f = await fixture(t),
    operation = randomUUID();
  await f.ledger.topUpConfirmed(f.ctx.userId, operation, {
    providerPaymentId: randomUUID(),
    merchantId: "synthetic-phone-shop",
    test: false,
    paidKopeks: 500,
    verifiedAt: "2026-10-23T00:00:00.000Z",
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  const thread = (
    await f.db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
      [f.ctx.userId],
    )
  ).rows[0]!.id;
  const requestId = randomUUID();
  await f.db.query(
    "insert into chat_requests(thread_id,request_id,status,ai_policy_id,ai_routing_revision) values($1,$2,'complete',$3,1)",
    [thread, requestId, hash("synthetic-policy")],
  );
  await f.db.query(
    `insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,
    money_currency,money_reserved_micros,money_budget_revision,money_rule_key) values($1,$2,1,$3,'routerai','synthetic/model',$4,1,'RUB',6000000,1,$4)`,
    [thread, requestId, f.ctx.userId, hash("synthetic-policy")],
  );
  const charges = new AiCreditCharges(
    f.db,
    CITYGO_10X_TARIFF,
    "fixed5_overdraft",
  );
  const hold = await f.db.transaction((tx) =>
    charges.reserve(
      tx,
      {
        userId: f.ctx.userId,
        threadId: thread,
        requestId,
        model: "synthetic/model",
        upstream: "synthetic",
      },
      6_000_000,
    ),
  );
  await charges.dispatch(f.ctx.userId, hold);
  await charges.identify(f.ctx.userId, hold, "synthetic-phone-debt-generation");
  await f.db.query(
    "update ai_credit_charges set response_complete=true where hold_id=$1",
    [hold],
  );
  await charges.settle(f.ctx.userId, hold, {
    generationId: "synthetic-phone-debt-generation",
    reference: hold,
    model: "synthetic/model",
    upstream: "synthetic",
    costRub: "1",
    amountMicros: routerAiCostMicros("1"),
    currency: "RUB",
  });
  assert.equal(
    (await f.ledger.status(f.ctx.userId)).outstandingDebtMicros,
    5_000_000,
  );
  const value = input();
  await f.phone.begin(f.ctx, value);
  await f.phone.markAccepted(value.id, value.codeHash);
  await f.phone.confirm(f.ctx, confirmation(value));
  const balance = await f.ledger.status(f.ctx.userId);
  assert.equal(balance.outstandingDebtMicros, 0);
  assert.equal(balance.availableMicros, 495_000_000);
  assert.deepEqual(
    (
      await f.db.query(
        "select kind,gross_micros::text,spent_micros::text from credit_source_lots order by kind",
      )
    ).rows,
    [
      { kind: "gift", gross_micros: "500000000", spent_micros: "5000000" },
      { kind: "paid", gross_micros: "5000000", spent_micros: "5000000" },
    ],
  );
  assert.equal(
    (await f.db.query("select 1 from credit_debt_repayments")).rows.length,
    1,
  );
  assert.equal(
    (
      await f.db.query(
        "select amount_micros::text from ai_credit_entries where kind='hold'",
      )
    ).rows[0]!.amount_micros,
    "5000000",
  );
  assert.equal(
    (
      await f.db.query(
        "select amount_micros::text from ai_credit_entries where kind='settle'",
      )
    ).rows[0]!.amount_micros,
    "10000000",
  );
});

test("restricted API can consume staged OTP but cannot bind identity, rewrite claims/quotas, delete evidence or grant Worker access", async (t) => {
  const f = await fixture(t);
  await f.db.exec(
    "create role citygo_api nologin; create role citygo_worker nologin; create role citygo_backup nologin; grant usage on schema public to citygo_api,citygo_worker,citygo_backup",
  );
  const grants = (
    await readFile(
      new URL("../../../deploy/postgres/grants.sql", import.meta.url),
      "utf8",
    )
  ).replace(/^\\set[^\n]*\n/gm, "");
  await f.db.exec(grants);
  await f.db.exec("set role citygo_api");
  await assert.rejects(
    configurePhoneVerification(f.db, defaultPolicy),
    /permission denied/,
  );
  const value = input();
  await f.phone.begin(f.ctx, value);
  await f.phone.markAccepted(value.id, value.codeHash);
  await f.phone.confirm(f.ctx, confirmation(value));
  for (const sql of [
    "delete from phone_welcome_claims",
    "update phone_welcome_claims set phone_key=repeat('a',64)",
    "delete from phone_verification_sends",
    "update phone_verification_sends set created_at=clock_timestamp()",
    "delete from phone_verification_challenges",
    "update phone_verification_control set identity_key_fingerprint=repeat('b',64)",
    "update phone_verification_challenges set phone_key=repeat('c',64)",
  ])
    await assert.rejects(f.db.exec(sql), /permission denied/);
  await f.db.exec("reset role; set role citygo_worker");
  for (const table of [
    "phone_verification_control",
    "phone_verification_challenges",
    "phone_verification_sends",
    "phone_welcome_claims",
  ])
    await assert.rejects(
      f.db.exec("select 1 from " + table),
      /permission denied/,
    );
});
