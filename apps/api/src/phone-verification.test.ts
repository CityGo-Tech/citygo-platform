import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  configurePhoneVerification,
  connectDatabase,
  migrate,
  Repository,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  phoneVerificationChallengeSchema,
  phoneVerificationReceiptSchema,
} from "@citygo/contracts";
import { buildApp } from "./app.js";
import { hashPassword, tokenHash } from "./auth.js";
import {
  phoneVerificationPolicy,
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
    delivery?: PhoneVerificationDelivery;
  } = {},
) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const config = readConfig({
    ...prepared,
    ...(options.disabled
      ? { PHONE_VERIFICATION_MODE: "disabled", SMS_RU_MODE: "disabled" }
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
          provider: "sms_ru",
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
    payload: { email: "verified-phone@example.test", password: "abcdef" },
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
      payload,
    });
  const money = async () => ({
    entries: (await db.query("select 1 from ai_credit_entries")).rows.length,
    claims: (await db.query("select 1 from phone_welcome_claims")).rows.length,
  });
  return { app, db, config, sent, post, auth, token, user, money };
}

test("HTTP email + phone OTP creates exactly one gift; replay is the same receipt, not another 500", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.app.inject({
        url: "/v1/phone-verification/policy",
        headers: f.auth,
      })
    ).json().phoneVerification,
    "required",
  );
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
  const response = await f.post("confirm", input);
  assert.equal(response.statusCode, 200);
  const receipt = phoneVerificationReceiptSchema.parse(response.json());
  assert.equal(receipt.grantedMicros, 500_000_000);
  assert.equal(receipt.alreadyGranted, false);
  assert.deepEqual((await f.post("confirm", input)).json(), {
    ...receipt,
    alreadyGranted: true,
  });
  assert.deepEqual(await f.money(), { entries: 1, claims: 1 });
  assert.equal(
    (await f.post("start", { phone: "+79990000002" })).statusCode,
    409,
  );
  assert.equal(f.sent.length, 1);
});

test("disabled/unbound phone preparation is honest unavailable; no SMS or money", async (t) => {
  for (const options of [{ disabled: true }, { bound: false }]) {
    const f = await fixture(t, options);
    const policy = await f.app.inject({
      url: "/v1/phone-verification/policy",
      headers: f.auth,
    });
    assert.equal(
      policy.json().phoneVerification,
      options.disabled ? "disabled" : "unavailable",
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
  await repo.createSession(userId, tokenHash(token));
  const response = await f.post(
    "start",
    { phone },
    { ...f.auth, authorization: "Bearer " + token },
  );
  assert.equal(response.statusCode, 403);
  assert.equal(f.sent.length, 0);
  assert.equal(
    (await f.db.query("select 1 from phone_verification_sends")).rows.length,
    0,
  );
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
