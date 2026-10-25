import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  AccountProfile,
  ServiceConsents,
  connectDatabase,
  migrate,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  accountProfileSchema,
  accountEmailVerificationChallengeSchema,
  CONTRACT_VERSION_HEADER,
} from "@citygo/contracts";
import { buildApp } from "./app.js";
import { hashPassword, newToken, tokenHash } from "./auth.js";
import { syntheticServiceConsents } from "./test-service-consents.js";
import type { RegistrationEmailDelivery } from "./email-registration.js";
const baseHeaders = {
  origin: "http://localhost:3000",
  [CONTRACT_VERSION_HEADER]: "1",
};
async function fixture(
  t: TestContext,
  delivery?: RegistrationEmailDelivery,
  mode: "disabled" | "required" = "required",
) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const token = newToken(),
    user = await new ServiceConsents(db).register(
      "legacy@example.test",
      await hashPassword("123456"),
      tokenHash(token),
      syntheticServiceConsents,
    );
  const app = await buildApp({
    db,
    testing: true,
    emailRegistrationDelivery: delivery,
    config: readConfig({
      NODE_ENV: "test",
      LLM_PROVIDER: "disabled",
      EMAIL_REGISTRATION_MODE: mode,
      EMAIL_REGISTRATION_SECRET: "a".repeat(64),
    }),
  });
  t.after(() => app.close());
  const headers = { ...baseHeaders, cookie: "citygo=" + token };
  const post = (url: string, payload: object) =>
    app.inject({ method: "POST", url, headers, payload });
  const get = () => app.inject({ url: "/v1/account/profile", headers });
  return { app, db, token, user, headers, post, get };
}
test("profile GET never sends; explicit authenticated code confirms only the current existing email without a new session", async (t) => {
  const delivered: Parameters<RegistrationEmailDelivery>[0][] = [],
    f = await fixture(t, async (x) => {
      delivered.push(x);
    });
  assert.deepEqual(accountProfileSchema.parse((await f.get()).json()), {
    userId: f.user.id,
    email: f.user.email,
    emailVerified: false,
    phoneVerified: false,
    giftStatus: "unavailable",
    emailConfirmation: "available",
  });
  assert.equal(delivered.length, 0);
  assert.equal(
    (await f.app.inject({ url: "/v1/account/profile", headers: baseHeaders }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await f.post("/v1/account/email/verification", {
        email: "other@example.test",
      })
    ).statusCode,
    400,
  );
  const start = await f.post("/v1/account/email/verification", {});
  assert.equal(start.statusCode, 200);
  const challenge = accountEmailVerificationChallengeSchema.parse(start.json());
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.email, f.user.email);
  assert.equal(start.headers["set-cookie"], undefined);
  const wrong = await f.post("/v1/account/email/verification/confirm", {
    ...challenge,
    expiresAt: undefined,
    resendAfterSeconds: undefined,
    code: delivered[0]!.code === "000000" ? "111111" : "000000",
  });
  assert.equal(wrong.statusCode, 400);
  const receipt = await f.post("/v1/account/email/verification/confirm", {
    challengeId: challenge.challengeId,
    proof: challenge.proof,
    code: delivered[0]!.code,
  });
  assert.equal(receipt.statusCode, 200);
  assert.deepEqual(receipt.json(), { userId: f.user.id, emailVerified: true });
  assert.equal(receipt.headers["set-cookie"], undefined);
  assert.equal((await f.get()).json().emailVerified, true);
  assert.equal(
    (
      await f.post("/v1/account/email/verification/confirm", {
        challengeId: challenge.challengeId,
        proof: challenge.proof,
        code: delivered[0]!.code,
      })
    ).statusCode,
    400,
  );
  for (const table of [
    "email_registrations",
    "phone_welcome_claims",
    "ai_credit_entries",
  ])
    assert.equal((await f.db.query(`select 1 from ${table}`)).rows.length, 0);
  assert.equal((await f.db.query("select 1 from sessions")).rows.length, 1);
});
test("unavailable delivery is truthful and cannot accept a caller-provided verification flag", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get()).json().emailConfirmation, "unavailable");
  assert.equal(
    (await f.post("/v1/account/email/verification", {})).statusCode,
    503,
  );
  assert.equal(
    (
      await f.post("/v1/account/email/verification/confirm", {
        emailVerified: true,
      })
    ).statusCode,
    503,
  );
  assert.equal(
    (await f.db.query("select 1 from account_email_confirmation_challenges"))
      .rows.length,
    0,
  );
});
test("failed or unknown delivery remains unusable, charged to the shared send quota, with upstream details hidden", async (t) => {
  let sends = 0;
  const f = await fixture(t, async () => {
    sends++;
    throw new Error("SECRET_UPSTREAM_DIAGNOSTIC");
  });
  const response = await f.post("/v1/account/email/verification", {});
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(
    response.body,
    /SECRET_UPSTREAM|proof|codeHash|credential/,
  );
  assert.equal(sends, 1);
  assert.equal(
    (
      await f.db.query<{ delivery: string }>(
        "select delivery from account_email_confirmation_challenges",
      )
    ).rows[0]!.delivery,
    "failed",
  );
  assert.equal(
    (await f.db.query("select 1 from email_registration_rate_events")).rows
      .length,
    2,
  );
  assert.equal(
    (await f.post("/v1/account/email/verification", {})).statusCode,
    429,
  );
  assert.equal(sends, 1);
  assert.equal((await f.get()).json().emailVerified, false);
});
test("resend is explicit, retains its handle and proof, and a registration OTP cannot satisfy account confirmation", async (t) => {
  const delivered: Parameters<RegistrationEmailDelivery>[0][] = [],
    f = await fixture(t, async (x) => {
      delivered.push(x);
    });
  const started = accountEmailVerificationChallengeSchema.parse(
    (await f.post("/v1/account/email/verification", {})).json(),
  );
  await f.db.exec(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 minutes'",
  );
  const result = await f.post("/v1/account/email/verification/resend", {
    challengeId: started.challengeId,
    proof: started.proof,
  });
  assert.equal(result.statusCode, 200);
  const resent = accountEmailVerificationChallengeSchema.parse(result.json());
  assert.equal(resent.challengeId, started.challengeId);
  assert.equal(resent.proof, started.proof);
  assert.equal(resent.expiresAt, started.expiresAt);
  assert.equal(delivered.length, 2);
  assert.equal(
    (
      await f.post("/v1/auth/email/confirm", {
        challengeId: started.challengeId,
        proof: started.proof,
        code: delivered[1]!.code,
      })
    ).statusCode,
    400,
  );
  const state = new AccountProfile(f.db),
    before = await state.summary({
      userId: f.user.id,
      sessionTokenHash: tokenHash(f.token),
    });
  assert.equal(before.emailVerified, false);
});
test("revoking the session while delivery is pending cannot turn a later code into proof", async (t) => {
  let sent!: Parameters<RegistrationEmailDelivery>[0];
  let release!: () => void;
  const delivery = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, async (x) => {
    sent = x;
    entered();
    await delivery;
  });
  const request = f.post("/v1/account/email/verification", {});
  await waiting;
  await f.db.query("delete from sessions where token_hash=$1", [
    tokenHash(f.token),
  ]);
  release();
  const response = await request;
  assert.equal(response.statusCode, 200);
  const challenge = accountEmailVerificationChallengeSchema.parse(
    response.json(),
  );
  assert.equal(
    (
      await f.post("/v1/account/email/verification/confirm", {
        challengeId: challenge.challengeId,
        proof: challenge.proof,
        code: sent.code,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await f.db.query("select 1 from account_email_verifications")).rows.length,
    0,
  );
});
