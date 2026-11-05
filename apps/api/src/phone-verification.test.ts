import { syntheticServiceConsents } from "./test-service-consents.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  configurePhoneVerification,
  connectDatabase,
  migrate,
  Repository,
  PhoneContacts,
  ServiceConsents,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  phoneVerificationChallengeSchema,
  phoneVerificationPolicySchema,
  phoneVerificationReceiptSchema,
  accountProfileSchema,
} from "@citygo/contracts";
import { buildApp } from "./app.js";
import { hashPassword, tokenHash } from "./auth.js";
import { ProstoSmsDeliveryError } from "./verification-delivery/prosto-sms.js";
import {
  phoneVerificationPolicy,
  PHONE_DELIVERY_DEADLINE_MS,
  type PhoneVerificationDelivery,
} from "./phone-verification.js";

// No runtime env, provider network, real phone, key or money in this harness.
const phone = "+79990000001";
const headers = {
  origin: "http://localhost:3000",
  [CONTRACT_VERSION_HEADER]: "1",
  "x-citygo-client": "native",
};
const prepared = {
  NODE_ENV: "test",
  LLM_PROVIDER: "disabled",
  AI_CREDIT_MODE: "routerai_citygo_10x",
  AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
  EMAIL_REGISTRATION_MODE: "required",
  EMAIL_REGISTRATION_SECRET: "a".repeat(64),
  PHONE_VERIFICATION_MODE: "sms_ru",
  PHONE_VERIFICATION_SECRET: "b".repeat(64),
  SMS_RU_MODE: "live",
  SMS_RU_API_ID: "synthetic-api-id-123",
  SMS_RU_FROM: "CityGo",
  PHONE_SMS_GLOBAL_DAILY_LIMIT: "10",
  PHONE_SMS_GLOBAL_TOTAL_LIMIT: "20",
};
async function fixture(
  t: TestContext,
  options: {
    bound?: boolean;
    disabled?: boolean;
    prostoSms?: boolean;
    unlimitedGlobal?: boolean;
    delivery?: PhoneVerificationDelivery;
  } = {},
) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const config = readConfig({
    ...prepared,
    ...(options.prostoSms
      ? {
          PHONE_VERIFICATION_MODE: "prosto_sms",
          SMS_RU_MODE: "disabled",
          SMS_RU_API_ID: undefined,
          SMS_RU_FROM: undefined,
          PROSTOSMS_MODE: "live",
          PROSTOSMS_API_KEY: "synthetic-prosto-key-123456",
          PROSTOSMS_SENDER: "CityGo",
        }
      : {}),
    ...(options.disabled
      ? { PHONE_VERIFICATION_MODE: "disabled", SMS_RU_MODE: "disabled" }
      : {}),
    ...(options.unlimitedGlobal
      ? {
          PHONE_SMS_GLOBAL_DAILY_LIMIT: "unlimited",
          PHONE_SMS_GLOBAL_TOTAL_LIMIT: "unlimited",
        }
      : {}),
  });
  if (options.bound !== false && !options.disabled)
    await configurePhoneVerification(db, phoneVerificationPolicy(config)!);
  const sent: { phone: string; code: string }[] = [];
  let emailCode = "";
  const app = await buildApp({
    db,
    config,
    testing: true,
    emailRegistrationDelivery: async ({ code }) => {
      emailCode = code;
    },
    phoneVerificationDelivery:
      options.delivery ??
      (async ({ phone, code }) => {
        sent.push({ phone, code });
        return {
          provider: options.prostoSms ? "prosto_sms" : "sms_ru",
          mode: "live",
          accepted: true,
          simulated: false,
          providerMessageId: "synthetic-message-id",
        };
      }),
  });
  t.after(() => app.close());
  const begin = await app.inject({
    method: "POST",
    url: "/v1/auth/email/register",
    headers,
    payload: {
      consents: syntheticServiceConsents,
      email: "verified-phone@example.test",
      password: "abcdef",
    },
  });
  assert.equal(begin.statusCode, 200);
  const binding = phoneVerificationChallengeSchema.parse(begin.json());
  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/email/confirm",
    headers,
    payload: {
      challengeId: binding.challengeId,
      proof: binding.proof,
      code: emailCode,
    },
  });
  assert.equal(verified.statusCode, 200);
  const { token, user } = verified.json<{
    token: string;
    user: { id: string };
  }>();
  const auth = { ...headers, authorization: "Bearer " + token };
  const post = (path: string, payload: object, ownHeaders = auth) =>
    app.inject({
      method: "POST",
      url: "/v1/phone-verification/" + path,
      headers: ownHeaders,
      payload:
        path === "start" || path === "resend"
          ? {
              expectedDeliveryProvider: options.prostoSms
                ? "prosto_sms"
                : "sms_ru",
              ...payload,
            }
          : payload,
    });
  const money = async () => ({
    entries: (await db.query("select 1 from ai_credit_entries")).rows.length,
    claims: (await db.query("select 1 from phone_welcome_claims")).rows.length,
  });
  return {
    app,
    db,
    config,
    sent,
    post,
    auth,
    token,
    user,
    money,
    lastEmailCode: () => emailCode,
  };
}

test("HTTP email + phone OTP creates exactly one gift; replay is the same receipt, not another 500", async (t) => {
  const f = await fixture(t);
  const policy = phoneVerificationPolicySchema.parse(
    (
      await f.app.inject({
        url: "/v1/phone-verification/policy",
        headers: f.auth,
      })
    ).json(),
  );
  assert.equal(policy.phoneVerification, "required");
  assert.equal(policy.deliveryProvider, "sms_ru");
  const start = await f.post("start", { phone: "8 (999) 000-00-01" });
  assert.equal(start.statusCode, 200);
  const challenge = phoneVerificationChallengeSchema.parse(start.json());
  assert.ok(!start.body.includes(f.sent[0]!.code));
  assert.ok(!start.body.includes(phone));
  assert.deepEqual(
    f.sent.map((x) => x.phone),
    ["79990000001"],
  );
  assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
  const input = {
    challengeId: challenge.challengeId,
    proof: challenge.proof,
    phone,
    code: f.sent[0]!.code,
  };
  const wrong = await f.post("confirm", {
    ...input,
    code: input.code === "000000" ? "111111" : "000000",
  });
  assert.equal(wrong.statusCode, 400);
  assert.equal(
    (
      await f.db.query(
        "select 1 from phone_contact_bindings where protected_phone is not null",
      )
    ).rows.length,
    0,
  );
  const response = await f.post("confirm", input);
  assert.equal(response.statusCode, 200);
  const receipt = phoneVerificationReceiptSchema.parse(response.json());
  assert.equal(receipt.grantedMicros, 500_000_000);
  assert.equal(receipt.alreadyGranted, false);
  const protectedBeforeReplay = (
    await f.db.query<{ protected_phone: string }>(
      "select protected_phone from phone_contact_bindings where user_id=$1",
      [f.user.id],
    )
  ).rows[0]!.protected_phone;
  assert.match(protectedBeforeReplay, /^pc1\./);
  assert.ok(!protectedBeforeReplay.includes(phone));
  assert.deepEqual((await f.post("confirm", input)).json(), {
    ...receipt,
    alreadyGranted: true,
  });
  assert.equal(
    (
      await f.db.query<{ protected_phone: string }>(
        "select protected_phone from phone_contact_bindings where user_id=$1",
        [f.user.id],
      )
    ).rows[0]!.protected_phone,
    protectedBeforeReplay,
  );
  assert.deepEqual(await f.money(), { entries: 1, claims: 1 });
  assert.deepEqual(
    (
      await f.app.inject({
        url: "/v1/phone-verification/policy",
        headers: f.auth,
      })
    ).json(),
    {
      phoneVerification: "required",
      deliveryProvider: "sms_ru",
      giftAmountMicros: 500_000_000,
      giftStatus: "granted",
    },
  );
  assert.equal(
    (await f.post("start", { phone: "+79990000002" })).statusCode,
    409,
  );
  assert.equal(f.sent.length, 1);
});

test("saved customer phones are disclosed only to a current super-admin session, never a user or ordinary admin", async (t) => {
  const f = await fixture(t, { prostoSms: true });
  const start = await f.post("start", { phone });
  assert.equal(start.statusCode, 200, start.body);
  const challenge = phoneVerificationChallengeSchema.parse(start.json());
  const accepted = await f.post("confirm", {
    challengeId: challenge.challengeId,
    proof: challenge.proof,
    phone,
    code: f.sent[0]!.code,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const listing = (ownHeaders = f.auth, query = "") =>
    f.app.inject({
      url: "/v1/admin/phone-contacts" + query,
      headers: ownHeaders,
    });
  assert.equal(
    (await listing({ ...headers, authorization: "" })).statusCode,
    401,
  );
  assert.equal((await listing()).statusCode, 403);
  await f.db.query("update users set role='admin' where id=$1", [f.user.id]);
  assert.equal((await listing()).statusCode, 403);
  await f.db.query("update users set role='super_admin' where id=$1", [
    f.user.id,
  ]);
  const visible = await listing();
  assert.equal(visible.statusCode, 200, visible.body);
  assert.equal(visible.headers["cache-control"], "no-store");
  const body = visible.json();
  assert.equal(body.contacts.length, 1);
  assert.deepEqual(body.contacts[0], {
    userId: f.user.id,
    email: "verified-phone@example.test",
    username: null,
    phone,
    verifiedAt: body.contacts[0].verifiedAt,
  });
  assert.match(body.contacts[0].verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.nextAfterUserId, null);
  assert.ok(!visible.body.includes("pc1."));
  assert.ok(!visible.body.includes("phoneKey"));
  const invalidQuery = await listing(f.auth, "?afterUserId=0");
  assert.equal(invalidQuery.statusCode, 400);
  const policy = await f.app.inject({
    url: "/v1/phone-verification/policy",
    headers: f.auth,
  });
  assert.ok(!policy.body.includes(phone));
  const audit = await f.db.query<{ payload: unknown }>(
    "select payload from audit_log where action='customer-phone-contacts-viewed'",
  );
  assert.equal(audit.rows.length, 1);
  assert.ok(!JSON.stringify(audit.rows).includes(phone));
  assert.ok(!JSON.stringify(audit.rows).includes("pc1."));
  assert.equal(f.sent.length, 1);
  assert.deepEqual(await f.money(), { entries: 1, claims: 1 });
  await f.db.query("delete from sessions where token_hash=$1", [
    tokenHash(f.token),
  ]);
  assert.equal((await listing()).statusCode, 401);
});

test("HTTP distinct verified accounts cannot claim one normalized 8/+7 mobile twice, including an already accepted second challenge", async (t) => {
  for (const secondPending of [false, true]) {
    const f = await fixture(t, { prostoSms: true, unlimitedGlobal: true });
    const registration = await f.app.inject({
      method: "POST",
      url: "/v1/auth/email/register",
      headers,
      payload: {
        consents: syntheticServiceConsents,
        email: "second-phone-owner@example.test",
        password: "abcdef",
      },
    });
    assert.equal(registration.statusCode, 200);
    const emailProof = phoneVerificationChallengeSchema.parse(
      registration.json(),
    );
    const verified = await f.app.inject({
      method: "POST",
      url: "/v1/auth/email/confirm",
      headers,
      payload: {
        challengeId: emailProof.challengeId,
        proof: emailProof.proof,
        code: f.lastEmailCode(),
      },
    });
    assert.equal(verified.statusCode, 200);
    const other = verified.json<{ token: string; user: { id: string } }>();
    assert.notEqual(other.user.id, f.user.id);
    const otherAuth = { ...f.auth, authorization: "Bearer " + other.token };
    const first = await f.post("start", { phone: "8 (999) 000-00-01" });
    assert.equal(first.statusCode, 200);
    const firstProof = phoneVerificationChallengeSchema.parse(first.json());
    let otherProof:
      ReturnType<typeof phoneVerificationChallengeSchema.parse> | undefined;
    if (secondPending) {
      // Move only synthetic send timestamps past the shared number cooldown.
      // Both SMS admissions precede the first successful ownership proof.
      await f.db.query(
        "update phone_verification_sends set created_at=created_at-interval '61 seconds'",
      );
      const pending = await f.post("start", { phone }, otherAuth);
      assert.equal(pending.statusCode, 200);
      otherProof = phoneVerificationChallengeSchema.parse(pending.json());
      assert.equal(f.sent.length, 2);
      assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
    }
    const request = {
      challengeId: firstProof.challengeId,
      proof: firstProof.proof,
      phone,
      code: f.sent[0]!.code,
    };
    const granted = await f.post("confirm", request);
    assert.equal(granted.statusCode, 200);
    const receipt = phoneVerificationReceiptSchema.parse(granted.json());
    assert.equal(receipt.alreadyGranted, false);
    assert.equal(receipt.grantedMicros, 500_000_000);
    assert.deepEqual(
      f.sent.map((value) => value.phone),
      Array(secondPending ? 2 : 1).fill("79990000001"),
    );
    const snapshot = async () =>
      (
        await f.db.query(`select jsonb_build_object(
      'accounts',(select coalesce(jsonb_agg(to_jsonb(t) order by user_id),'[]'::jsonb) from ai_credit_accounts t),
      'entries',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from ai_credit_entries t),
      'lots',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from credit_source_lots t),
      'claims',(select coalesce(jsonb_agg(to_jsonb(t) order by user_id),'[]'::jsonb) from phone_welcome_claims t),
      'challenges',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from phone_verification_challenges t),
      'sends',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from phone_verification_sends t),
      'debts',(select coalesce(jsonb_agg(to_jsonb(t) order by hold_id),'[]'::jsonb) from credit_charge_debts t),
      'repayments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from credit_debt_repayments t)
    ) as value`)
      ).rows[0]!.value;
    const before = await snapshot(),
      sentBefore = f.sent.length;
    assert.equal(
      (await f.post("start", { phone: "+7 (999) 000-00-01" }, otherAuth))
        .statusCode,
      409,
    );
    assert.equal(f.sent.length, sentBefore);
    assert.deepEqual(
      await snapshot(),
      before,
      "Claimed normalized mobile rejects before another challenge, quota admission or money write",
    );
    if (otherProof) {
      assert.equal(
        (
          await f.post(
            "confirm",
            {
              challengeId: otherProof.challengeId,
              proof: otherProof.proof,
              phone: "89990000001",
              code: f.sent[1]!.code,
            },
            otherAuth,
          )
        ).statusCode,
        409,
      );
      assert.equal(f.sent.length, sentBefore);
      assert.deepEqual(
        await snapshot(),
        before,
        "A second accepted code cannot consume its challenge or create a second bonus/lot",
      );
    }
    assert.deepEqual((await f.post("confirm", request)).json(), {
      ...receipt,
      alreadyGranted: true,
    });
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await f.money(), { entries: 1, claims: 1 });
    assert.deepEqual(
      (
        await f.db.query(
          "select user_id::text,granted_micros::text from ai_credit_accounts",
        )
      ).rows,
      [{ user_id: f.user.id, granted_micros: "500000000" }],
    );
    assert.equal(
      (
        await f.db.query(
          "select count(distinct phone_key)::int as n from phone_verification_challenges",
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (await f.db.query("select 1 from credit_source_lots")).rows.length,
      1,
    );
  }
});

for (const transfer of [false, true])
  test(`HTTP contact ${transfer ? "transfer" : "unlink"} preserves the gift, rejects the old OTP and cannot grant another account a second 500`, async (t) => {
    const f = await fixture(t, { prostoSms: true });
    const start = await f.post("start", { phone });
    assert.equal(start.statusCode, 200);
    const challenge = phoneVerificationChallengeSchema.parse(start.json());
    const confirmation = {
      challengeId: challenge.challengeId,
      proof: challenge.proof,
      phone,
      code: f.sent[0]!.code,
    };
    assert.equal((await f.post("confirm", confirmation)).statusCode, 200);
    const registration = await f.app.inject({
      method: "POST",
      url: "/v1/auth/email/register",
      headers,
      payload: {
        consents: syntheticServiceConsents,
        email: "contact-receiver@example.test",
        password: "abcdef",
      },
    });
    assert.equal(registration.statusCode, 200);
    const pending = phoneVerificationChallengeSchema.parse(registration.json());
    const registered = await f.app.inject({
      method: "POST",
      url: "/v1/auth/email/confirm",
      headers,
      payload: {
        challengeId: pending.challengeId,
        proof: pending.proof,
        code: f.lastEmailCode(),
      },
    });
    assert.equal(registered.statusCode, 200);
    const receiver = registered.json<{ token: string; user: { id: string } }>();
    const receiverAuth = {
      ...headers,
      authorization: "Bearer " + receiver.token,
    };
    const source = (
      await f.db.query<{
        id: string;
        phone_key: string;
        policy_fingerprint: string;
      }>(
        "select id::text,phone_key,policy_fingerprint from phone_contact_bindings where user_id=$1 and unlinked_at is null",
        [f.user.id],
      )
    ).rows[0]!;
    const retained = async () => {
      const snapshot: Record<string, unknown> = {};
      for (const table of [
        "ai_credit_accounts",
        "ai_credit_entries",
        "credit_source_lots",
        "credit_hold_allocations",
        "credit_charge_debts",
        "credit_debt_repayments",
        "ai_credit_topups",
        "payment_topup_orders",
        "payment_refunds",
        "npd_receipt_tasks",
        "phone_welcome_claims",
        "phone_verification_challenges",
        "phone_verification_sends",
        "phone_verification_control",
      ])
        snapshot[table] = (
          await f.db.query(
            `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as value from ${table} t`,
          )
        ).rows[0]!.value;
      return snapshot;
    };
    const before = await retained();
    const command = {
      operationId: randomUUID(),
      fromUserId: f.user.id,
      toUserId: transfer ? receiver.user.id : null,
      expectedSourceBindingId: source.id,
      expectedPhoneKey: source.phone_key,
      expectedPolicyFingerprint: source.policy_fingerprint,
      authoritySha256: "c".repeat(64),
      reason: "owner-request" as const,
    };
    const contacts = new PhoneContacts(f.db);
    const changed = await contacts.changeByOperator(command);
    assert.equal(changed.replayed, false);
    assert.deepEqual(await contacts.changeByOperator(command), {
      ...changed,
      replayed: true,
    });
    assert.deepEqual(await retained(), before);
    const getProfile = async (ownHeaders: typeof f.auth) => {
      const response = await f.app.inject({
        url: "/v1/account/profile",
        headers: ownHeaders,
      });
      assert.equal(response.statusCode, 200);
      return accountProfileSchema.parse(response.json());
    };
    const senderProfile = await getProfile(f.auth);
    assert.equal(senderProfile.phoneVerified, false);
    assert.equal(senderProfile.giftStatus, "claimed");
    const receiverProfile = await getProfile(receiverAuth);
    assert.equal(receiverProfile.phoneVerified, transfer);
    assert.equal(
      receiverProfile.giftStatus,
      transfer ? "unavailable" : "available",
    );
    const policy = await f.app.inject({
      url: "/v1/phone-verification/policy",
      headers: receiverAuth,
    });
    assert.equal(policy.statusCode, 200);
    assert.equal(
      phoneVerificationPolicySchema.parse(policy.json()).giftStatus,
      transfer ? "phone_bound" : "eligible",
    );
    assert.equal((await f.post("confirm", confirmation)).statusCode, 409);
    assert.equal(
      (await f.post("start", { phone: "8 (999) 000-00-01" }, receiverAuth))
        .statusCode,
      409,
    );
    assert.equal(f.sent.length, 1);
    assert.deepEqual(await retained(), before);
    assert.deepEqual(await f.money(), { entries: 1, claims: 1 });
    assert.equal(
      (await f.db.query("select 1 from phone_contact_changes")).rows.length,
      1,
    );
  });

test("ProstoSMS synthetic receipt confirms one phone and grants once, without SMS.ru fallback", async (t) => {
  const f = await fixture(t, { prostoSms: true });
  const policy = await f.app.inject({
    url: "/v1/phone-verification/policy",
    headers: f.auth,
  });
  assert.equal(policy.statusCode, 200);
  assert.equal(
    phoneVerificationPolicySchema.parse(policy.json()).giftStatus,
    "eligible",
  );
  assert.equal(policy.json().deliveryProvider, "prosto_sms");
  const start = await f.post("start", { phone });
  assert.equal(start.statusCode, 200);
  const challenge = phoneVerificationChallengeSchema.parse(start.json());
  const input = {
    challengeId: challenge.challengeId,
    proof: challenge.proof,
    phone,
    code: f.sent[0]!.code,
  };
  const confirmed = await f.post("confirm", input);
  assert.equal(confirmed.statusCode, 200);
  const receipt = phoneVerificationReceiptSchema.parse(confirmed.json());
  assert.equal(receipt.grantedMicros, 500_000_000);
  assert.deepEqual((await f.post("confirm", input)).json(), {
    ...receipt,
    alreadyGranted: true,
  });
  assert.deepEqual(await f.money(), { entries: 1, claims: 1 });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(
    (
      await f.app.inject({
        url: "/v1/phone-verification/policy",
        headers: f.auth,
      })
    ).json(),
    {
      phoneVerification: "required",
      deliveryProvider: "prosto_sms",
      giftAmountMicros: 500_000_000,
      giftStatus: "granted",
    },
  );
});

test("explicit unlimited ProstoSMS globals preserve cooldown, code checks and one gift beyond prior finite total counts", async (t) => {
  const f = await fixture(t, { prostoSms: true, unlimitedGlobal: true });
  assert.deepEqual(phoneVerificationPolicy(f.config)!.limits, {
    userHourly: 3,
    phoneHourly: 3,
    ipHourly: 10,
    cooldownSeconds: 60,
    globalDaily: null,
    globalTotal: null,
  });
  const first = await f.post("start", { phone });
  assert.equal(first.statusCode, 200);
  // Old synthetic admission history is outside every hourly window. It is
  // intentionally above the former finite fixture's total20, without calling
  // any provider or disabling a DB constraint.
  await f.db.query(`insert into phone_verification_sends
    (id,challenge_id,user_id,phone_key,ip_key,policy_fingerprint,created_at)
    select gen_random_uuid(),s.challenge_id,s.user_id,repeat('c',64),repeat('d',64),s.policy_fingerprint,
      clock_timestamp()-interval '2 hours'
    from phone_verification_sends s cross join generate_series(1,21) n`);
  assert.equal(
    (await f.post("start", { phone: "+79990000002" })).statusCode,
    429,
  );
  assert.equal(
    f.sent.length,
    1,
    "Unlimited globals do not remove the owner cooldown",
  );
  await f.db.query(
    "update phone_verification_sends set created_at=created_at-interval '61 seconds'",
  );
  const start = await f.post("start", { phone: "+79990000002" });
  assert.equal(start.statusCode, 200);
  assert.equal(f.sent.length, 2);
  const binding = phoneVerificationChallengeSchema.parse(start.json());
  const input = { ...binding, phone: "+79990000002", code: f.sent[1]!.code };
  const confirm = {
    challengeId: input.challengeId,
    proof: input.proof,
    phone: input.phone,
    code: input.code,
  };
  assert.equal(
    (
      await f.post("confirm", {
        ...confirm,
        code: confirm.code === "000000" ? "111111" : "000000",
      })
    ).statusCode,
    400,
  );
  assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
  const accepted = await f.post("confirm", confirm);
  assert.equal(accepted.statusCode, 200);
  const receipt = phoneVerificationReceiptSchema.parse(accepted.json());
  assert.equal(receipt.grantedMicros, 500_000_000);
  assert.deepEqual((await f.post("confirm", confirm)).json(), {
    ...receipt,
    alreadyGranted: true,
  });
  assert.deepEqual(await f.money(), { entries: 1, claims: 1 });
  const bound = (
    await f.db.query<{
      policy: { limits: { globalDaily: null; globalTotal: null } };
    }>("select policy from phone_verification_control where id=1")
  ).rows[0]!.policy;
  assert.equal(bound.limits.globalDaily, null);
  assert.equal(bound.limits.globalTotal, null);
});

test("provider rejection with unlimited globals never grants a gift or retries and keeps the original three-per-user protection", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    prostoSms: true,
    unlimitedGlobal: true,
    delivery: async () => {
      calls++;
      throw new ProstoSmsDeliveryError("rejected", "rejected");
    },
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await f.post("start", { phone });
    assert.equal(response.statusCode, 503);
    assert.equal(
      calls,
      attempt,
      "Only an explicit new HTTP action invokes delivery",
    );
    assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
    await f.db.query(
      "update phone_verification_sends set created_at=created_at-interval '61 seconds'",
    );
  }
  assert.equal((await f.post("start", { phone })).statusCode, 429);
  assert.equal(calls, 3);
  assert.equal(
    (await f.db.query("select 1 from phone_verification_sends")).rows.length,
    3,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select distinct delivery from phone_verification_challenges",
      )
    ).rows,
    [{ delivery: "failed" }],
  );
  assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
});

test("an accepted receipt from another SMS provider cannot unlock the selected ProstoSMS path", async (t) => {
  let sends = 0;
  const f = await fixture(t, {
    prostoSms: true,
    delivery: async () => {
      sends++;
      return {
        provider: "sms_ru",
        mode: "live",
        accepted: true,
        simulated: false,
        providerMessageId: "000000-10000000",
      };
    },
  });
  assert.equal((await f.post("start", { phone })).statusCode, 503);
  assert.equal(sends, 1);
  assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
  assert.equal(
    (await f.db.query("select delivery from phone_verification_challenges"))
      .rows[0]!.delivery,
    "failed",
  );
});

test("consented provider mismatch rejects start/resend before quota, challenge changes or SMS in either selected channel", async (t) => {
  for (const prostoSms of [false, true]) {
    const f = await fixture(t, { prostoSms });
    const selected = prostoSms ? "prosto_sms" : "sms_ru";
    const other = prostoSms ? "sms_ru" : "prosto_sms";
    const wrongStart = await f.post("start", {
      phone,
      expectedDeliveryProvider: other,
    });
    assert.equal(wrongStart.statusCode, 409);
    assert.equal(wrongStart.json().code, "CONFLICT");
    assert.equal(
      wrongStart.json().error,
      "Провайдер SMS изменился. Обновите условия подтверждения телефона.",
    );
    assert.equal(f.sent.length, 0);
    assert.equal(
      (await f.db.query("select 1 from phone_verification_sends")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("select 1 from phone_verification_challenges")).rows
        .length,
      0,
    );
    const start = await f.post("start", {
      phone,
      expectedDeliveryProvider: selected,
    });
    assert.equal(start.statusCode, 200);
    const challenge = phoneVerificationChallengeSchema.parse(start.json());
    const binding = {
      challengeId: challenge.challengeId,
      proof: challenge.proof,
      phone,
    };
    const beforeChallenge = (
      await f.db.query("select * from phone_verification_challenges")
    ).rows;
    const beforeSends = (
      await f.db.query("select * from phone_verification_sends")
    ).rows;
    const wrongResend = await f.post("resend", {
      ...binding,
      expectedDeliveryProvider: other,
    });
    assert.equal(wrongResend.statusCode, 409);
    assert.equal(wrongResend.json().code, "CONFLICT");
    assert.deepEqual(
      (await f.db.query("select * from phone_verification_challenges")).rows,
      beforeChallenge,
    );
    assert.deepEqual(
      (await f.db.query("select * from phone_verification_sends")).rows,
      beforeSends,
    );
    assert.equal(f.sent.length, 1);
    for (const [path, payload] of [
      ["start", { phone }],
      ["resend", binding],
    ] as const) {
      const missing = await f.app.inject({
        method: "POST",
        url: "/v1/phone-verification/" + path,
        headers: f.auth,
        payload,
      });
      assert.equal(missing.statusCode, 400);
    }
    assert.deepEqual(
      (await f.db.query("select * from phone_verification_challenges")).rows,
      beforeChallenge,
    );
    assert.deepEqual(
      (await f.db.query("select * from phone_verification_sends")).rows,
      beforeSends,
    );
    // Synthetic fixture clock aging only: the real durable cooldown stays60s.
    await f.db.query(
      "update phone_verification_sends set created_at=created_at-interval '61 seconds'",
    );
    const resend = await f.post("resend", {
      ...binding,
      expectedDeliveryProvider: selected,
    });
    assert.equal(resend.statusCode, 200);
    assert.equal(f.sent.length, 2);
    assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
  }
});

test("selected provider is pinned once for policy, admission and receipt checks, not a mutable caller option", async (t) => {
  const f = await fixture(t, { prostoSms: true });
  f.config.PHONE_VERIFICATION_MODE = "sms_ru";
  const policy = await f.app.inject({
    url: "/v1/phone-verification/policy",
    headers: f.auth,
  });
  assert.equal(policy.json().deliveryProvider, "prosto_sms");
  const start = await f.post("start", {
    phone,
    expectedDeliveryProvider: "prosto_sms",
  });
  assert.equal(start.statusCode, 200);
  assert.equal(f.sent.length, 1);
  assert.equal(
    (await f.db.query("select delivery from phone_verification_challenges"))
      .rows[0]!.delivery,
    "accepted",
  );
  assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
});

test("disabled/unbound phone preparation is honest unavailable with its selected provider; no SMS or money", async (t) => {
  for (const options of [
    { disabled: true },
    { bound: false },
    { bound: false, prostoSms: true },
  ]) {
    const f = await fixture(t, options);
    const policy = await f.app.inject({
      url: "/v1/phone-verification/policy",
      headers: f.auth,
    });
    assert.equal(
      policy.json().phoneVerification,
      options.disabled ? "disabled" : "unavailable",
    );
    assert.equal(
      phoneVerificationPolicySchema.parse(policy.json()).giftStatus,
      "unavailable",
    );
    assert.equal(
      policy.json().deliveryProvider,
      options.disabled ? "none" : options.prostoSms ? "prosto_sms" : "sms_ru",
    );
    assert.equal((await f.post("start", { phone })).statusCode, 503);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
  }
});

test("test-mode SMS receipt and unknown delivery cannot enable confirmation or refund admission quotas", async (t) => {
  let code = "";
  const f = await fixture(t, {
    delivery: async (input) => {
      code = input.code;
      return {
        provider: "sms_ru",
        mode: "test",
        accepted: false,
        simulated: true,
      };
    },
  });
  const response = await f.post("start", { phone });
  assert.equal(response.statusCode, 503);
  assert.ok(!response.body.includes(code));
  assert.equal(
    (await f.db.query("select delivery from phone_verification_challenges"))
      .rows[0]!.delivery,
    "failed",
  );
  assert.equal(
    (await f.db.query("select 1 from phone_verification_sends")).rows.length,
    1,
  );
  assert.equal((await f.post("start", { phone })).statusCode, 429);
  assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
});

test("phone routes enforce session, same-origin, strict inputs and temporary-password gate before sends", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.post("start", { phone }, headers as typeof f.auth)).statusCode,
    401,
  );
  assert.equal(
    (
      await f.post(
        "start",
        { phone },
        { ...f.auth, origin: "https://evil.example" },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post("start", {
        phone,
        verified: true,
        grantedMicros: 500_000_000,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await f.post("start", { phone: "+77000000001" })).statusCode,
    400,
  );
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.user.id,
  ]);
  assert.equal((await f.post("start", { phone })).statusCode, 403);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
});

test("a legacy unverified email account cannot send an SMS or receive a gift", async (t) => {
  const f = await fixture(t);
  const repo = new Repository(f.db);
  const userId = await repo.register(
    "legacy-phone@example.test",
    await hashPassword("abcdef"),
  );
  const token = "synthetic-legacy-phone-session";
  await new ServiceConsents(f.db).choose(userId, syntheticServiceConsents);
  await repo.createSession(userId, tokenHash(token));
  const response = await f.post(
    "start",
    { phone },
    { ...f.auth, authorization: "Bearer " + token },
  );
  assert.equal(response.statusCode, 403);
  const policy = await f.app.inject({
    url: "/v1/phone-verification/policy",
    headers: { ...f.auth, authorization: "Bearer " + token },
  });
  assert.equal(policy.statusCode, 200);
  assert.equal(
    phoneVerificationPolicySchema.parse(policy.json()).giftStatus,
    "email_required",
  );
  assert.equal(f.sent.length, 0);
  assert.equal(
    (await f.db.query("select 1 from phone_verification_sends")).rows.length,
    0,
  );
});

test("disabled policy never reads phone tables and unbound policy never reads gift history", async (t) => {
  const disabled = await fixture(t, { disabled: true });
  await disabled.db.exec(
    "drop table phone_contact_changes,phone_contact_bindings,phone_welcome_claims,phone_verification_sends,phone_verification_challenges,phone_verification_control",
  );
  assert.deepEqual(
    (
      await disabled.app.inject({
        url: "/v1/phone-verification/policy",
        headers: disabled.auth,
      })
    ).json(),
    {
      phoneVerification: "disabled",
      deliveryProvider: "none",
      giftAmountMicros: 500_000_000,
      giftStatus: "unavailable",
    },
  );
  const unbound = await fixture(t, { bound: false });
  await unbound.db.exec(
    "drop table phone_contact_changes,phone_contact_bindings,phone_welcome_claims,phone_verification_sends,phone_verification_challenges",
  );
  assert.deepEqual(
    (
      await unbound.app.inject({
        url: "/v1/phone-verification/policy",
        headers: unbound.auth,
      })
    ).json(),
    {
      phoneVerification: "unavailable",
      deliveryProvider: "sms_ru",
      giftAmountMicros: 500_000_000,
      giftStatus: "unavailable",
    },
  );
});

test("policy reauthorizes every reload and never serves another account after session revocation", async (t) => {
  const f = await fixture(t);
  const policy = await f.app.inject({
    url: "/v1/phone-verification/policy",
    headers: f.auth,
  });
  assert.equal(
    phoneVerificationPolicySchema.parse(policy.json()).giftStatus,
    "eligible",
  );
  await f.db.query("delete from sessions where token_hash=$1", [
    tokenHash(f.token),
  ]);
  assert.equal(
    (
      await f.app.inject({
        url: "/v1/phone-verification/policy",
        headers: f.auth,
      })
    ).statusCode,
    401,
  );
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.user.id,
  ]);
  await new Repository(f.db).createSession(f.user.id, tokenHash(f.token));
  assert.equal(
    (
      await f.app.inject({
        url: "/v1/phone-verification/policy",
        headers: f.auth,
      })
    ).statusCode,
    403,
  );
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
});

test("outer SMS deadline leaves adapter cleanup time and ignores a late accepted result without retry or gift", async (t) => {
  let entered!: () => void,
    release!: (value: Awaited<ReturnType<PhoneVerificationDelivery>>) => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let sends = 0,
    signal: AbortSignal | undefined;
  const f = await fixture(t, {
    delivery: async (input) => {
      sends++;
      signal = input.signal;
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const pending = f.post("start", { phone }).then((value) => {
      settled = true;
      return value;
    });
    await ready;
    t.mock.timers.tick(8_000);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(signal?.aborted, false);
    t.mock.timers.tick(PHONE_DELIVERY_DEADLINE_MS - 8_000);
    const response = await pending;
    assert.equal(response.statusCode, 503);
    assert.equal(signal?.aborted, true);
    release({
      provider: "sms_ru",
      mode: "live",
      accepted: true,
      simulated: false,
      providerMessageId: "synthetic-late",
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sends, 1);
    assert.equal(
      (await f.db.query("select delivery from phone_verification_challenges"))
        .rows[0]!.delivery,
      "failed",
    );
    assert.equal(
      (await f.db.query("select 1 from phone_verification_sends")).rows.length,
      1,
    );
    assert.deepEqual(await f.money(), { entries: 0, claims: 0 });
  } finally {
    t.mock.timers.reset();
  }
});

test("configured provider factory does not bypass injection guard outside the isolated harness", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  const config = readConfig({ ...prepared, NODE_ENV: "development" });
  await assert.rejects(
    buildApp({
      db,
      config,
      testing: true,
      phoneVerificationDelivery: async () => ({
        provider: "sms_ru",
        mode: "test",
        accepted: false,
        simulated: true,
      }),
    }),
    /isolated test harness/,
  );
});
