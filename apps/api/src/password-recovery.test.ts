import { syntheticServiceConsents } from "./test-service-consents.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  connectDatabase,
  migrate,
  EmailRegistration,
  Repository,
  AccountAccess,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  passwordRecoveryChallengeSchema,
} from "@citygo/contracts";
import { redactPaths } from "@citygo/observability";
import { buildApp } from "./app.js";
import { hashPassword, tokenHash } from "./auth.js";
import type { PasswordRecoveryEmailDelivery } from "./password-recovery.js";

const headers = {
  origin: "http://localhost:3000",
  [CONTRACT_VERSION_HEADER]: "1",
};
const email = "synthetic-recovery@example.test";
const oldPassword = "synthetic-old-password";
const newPassword = "      ";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  t: TestContext,
  delivery?: PasswordRecoveryEmailDelivery,
  mode: "disabled" | "required" = "required",
) {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const app = await buildApp({
    db,
    testing: true,
    config: readConfig({
      NODE_ENV: "test",
      LLM_PROVIDER: "disabled",
      EMAIL_REGISTRATION_MODE: mode,
      EMAIL_REGISTRATION_SECRET: "a".repeat(64),
    }),
    passwordRecoveryDelivery: delivery,
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const post = (
    path: string,
    payload: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/" + path,
      headers: { ...headers, ...extra },
      payload: payload as object,
    });
  async function verified(address = email) {
    const state = new EmailRegistration(db);
    const id = randomUUID();
    const proofHash = hash(id + "proof"),
      codeHash = hash(id + "code");
    await state.begin({
      consents: syntheticServiceConsents,
      id,
      email: address,
      passwordHash: await hashPassword(oldPassword),
      proofHash,
      codeHash,
      recipientKey: hash(id + "recipient"),
      ipKey: hash(id + "ip"),
    });
    await state.markSent(id, codeHash);
    return state.confirm({
      id,
      proofHash,
      codeHash,
      sessionHash: hash(id + "session"),
    });
  }
  async function settled(id: string, expected = "sent") {
    for (let i = 0; i < 100; i++) {
      const row = (
        await db.query<{ delivery: string }>(
          "select delivery from password_recovery_challenges where id=$1",
          [id],
        )
      ).rows[0];
      if (row?.delivery === expected) return;
      await tick();
    }
    assert.fail("Recovery delivery did not settle");
  }
  const age = () =>
    db.query(
      "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 minutes'",
    );
  return { app, db, post, verified, settled, age };
}

test("recovery availability requires explicit email verification and a configured sender", async (t) => {
  for (const mode of ["disabled", "required"] as const) {
    const { app, db, post } = await fixture(t, undefined, mode);
    assert.deepEqual(
      (
        await app.inject({ url: "/v1/auth/password-recovery-policy", headers })
      ).json(),
      { passwordRecovery: "unavailable" },
    );
    assert.equal(
      (await post("password-recovery/request", { email })).statusCode,
      503,
    );
    assert.equal(
      (await db.query("select 1 from password_recovery_challenges")).rows
        .length,
      0,
    );
  }
});

test("verified recovery revokes A sessions without a late response erasing B's newer login cookie", async (t) => {
  const deliveries: Parameters<PasswordRecoveryEmailDelivery>[0][] = [];
  const { app, db, post, verified, settled } = await fixture(
    t,
    async (input) => {
      deliveries.push(input);
    },
  );
  const resetReady = deferred(),
    releaseReset = deferred();
  t.after(() => releaseReset.resolve());
  app.addHook("onSend", async (request, reply, payload) => {
    if (
      request.url === "/v1/auth/password-recovery/confirm" &&
      reply.statusCode === 200
    ) {
      resetReady.resolve();
      await releaseReset.promise;
    }
    return payload;
  });
  const user = await verified();
  await verified("another-owner@example.test");
  const browser = await post("login", { email, password: oldPassword });
  const cookie = String(browser.headers["set-cookie"]).split(";")[0]!;
  const native = await post(
    "login",
    { email, password: oldPassword },
    { "x-citygo-client": "native" },
  );
  const bearer = native.json().token;
  const candidate = await new AccountAccess(db).credentials(email);
  const begun = await post("password-recovery/request", {
    email: email.toUpperCase(),
  });
  assert.equal(begun.statusCode, 200);
  assert.equal(begun.headers["set-cookie"], undefined);
  const challenge = passwordRecoveryChallengeSchema.parse(begun.json());
  await settled(challenge.challengeId);
  assert.equal(deliveries.length, 1);
  const confirm = {
    challengeId: challenge.challengeId,
    proof: challenge.proof,
    code: deliveries[0]!.code,
    newPassword,
  };
  assert.equal(
    (
      await post("password-recovery/confirm", {
        ...confirm,
        code: confirm.code === "000000" ? "111111" : "000000",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await post("login", { email, password: oldPassword })).statusCode,
    200,
  );
  const resetting = post("password-recovery/confirm", confirm, {
    cookie,
    "x-citygo-client": "native",
  });
  await resetReady.promise;
  let otherCookie = "";
  try {
    // Complete B's login while A's reset response is deliberately held after
    // committing session revocation. Its cookie must survive A's later reply.
    const otherLogin = await post("login", {
      email: "another-owner@example.test",
      password: oldPassword,
    });
    assert.equal(otherLogin.statusCode, 200);
    otherCookie = String(otherLogin.headers["set-cookie"]).split(";")[0]!;
    assert.equal(
      (
        await app.inject({
          url: "/v1/dashboard",
          headers: { ...headers, cookie: otherCookie },
        })
      ).statusCode,
      200,
    );
  } finally {
    releaseReset.resolve();
  }
  const reset = await resetting;
  assert.equal(reset.statusCode, 200);
  assert.deepEqual(reset.json(), {
    passwordReset: true,
    sessionsRevoked: true,
  });
  assert.equal(reset.headers["set-cookie"], undefined);
  assert.equal(
    (
      await app.inject({
        url: "/v1/dashboard",
        headers: { ...headers, cookie: otherCookie },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await db.query("select 1 from sessions where user_id=$1", [user.id])).rows
      .length,
    0,
  );
  for (const authHeaders of [{ cookie }, { authorization: "Bearer " + bearer }])
    assert.equal(
      (
        await app.inject({
          url: "/v1/dashboard",
          headers: { ...headers, ...authHeaders },
        })
      ).statusCode,
      401,
    );
  assert.equal(
    (await post("login", { email, password: oldPassword })).statusCode,
    401,
  );
  assert.equal(
    (await post("login", { email, password: newPassword })).statusCode,
    200,
  );
  await assert.rejects(
    new AccountAccess(db).createVerifiedSession(
      user.id,
      candidate!.password_hash,
      tokenHash("synthetic-racing-old-login"),
    ),
  );
  assert.equal(
    (await post("password-recovery/confirm", confirm)).statusCode,
    400,
  );
  assert.equal(
    (await db.query("select 1 from ai_credit_entries")).rows.length,
    0,
  );
});

test("unknown, unverified and blocked accounts return the same challenge without delivery or account changes", async (t) => {
  let sent = 0;
  const { post, db, verified, settled } = await fixture(t, async () => {
    sent++;
  });
  await new Repository(db).register(
    "unverified@example.test",
    await hashPassword(oldPassword),
  );
  const blocked = await verified("blocked@example.test");
  await db.query("update users set status='blocked' where id=$1", [blocked.id]);
  for (const address of [
    "unknown@example.test",
    "unverified@example.test",
    "blocked@example.test",
  ]) {
    const result = await post("password-recovery/request", { email: address });
    assert.equal(result.statusCode, 200);
    const challenge = passwordRecoveryChallengeSchema.parse(result.json());
    assert.deepEqual(Object.keys(challenge).sort(), [
      "challengeId",
      "expiresAt",
      "proof",
      "resendAfterSeconds",
    ]);
    await settled(challenge.challengeId);
    assert.equal(
      (
        await post("password-recovery/confirm", {
          challengeId: challenge.challengeId,
          proof: challenge.proof,
          code: "012345",
          newPassword,
        })
      ).statusCode,
      400,
    );
  }
  assert.equal(sent, 0);
  assert.equal((await db.query("select 1 from users")).rows.length, 2);
});

test("a stalled or rejected provider cannot delay or change recovery acknowledgements and shutdown cancels pending delivery", async (t) => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const { app, db, post, verified, settled } = await fixture(
    t,
    async (input) => {
      calls++;
      signal = input.signal;
      if (calls === 1) return new Promise<void>(() => {});
      throw new Error("synthetic-provider-recipient-secret");
    },
  );
  let firstId = "";
  // Runtime registers its DB close after buildApp. Fastify executes onClose
  // hooks in reverse order; delivery must settle before this later hook runs.
  app.addHook("onClose", async () => {
    if (!firstId) return;
    assert.equal(
      (
        await db.query<{ delivery: string }>(
          "select delivery from password_recovery_challenges where id=$1",
          [firstId],
        )
      ).rows[0]!.delivery,
      "failed",
    );
  });
  await verified();
  await verified("second@example.test");
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("HTTP awaited recovery sender")),
      1000,
    );
    timer.unref();
  });
  const known = await Promise.race([
    post("password-recovery/request", { email }),
    timeout,
  ]);
  const first = passwordRecoveryChallengeSchema.parse(known.json());
  firstId = first.challengeId;
  assert.equal(known.statusCode, 200);
  const decoy = await post("password-recovery/request", {
    email: "unknown@example.test",
  });
  assert.equal(decoy.statusCode, known.statusCode);
  assert.deepEqual(
    Object.keys(decoy.json()).sort(),
    Object.keys(known.json()).sort(),
  );
  const failed = await post("password-recovery/request", {
    email: "second@example.test",
  });
  assert.equal(failed.statusCode, 200);
  const second = passwordRecoveryChallengeSchema.parse(failed.json());
  await settled(second.challengeId, "failed");
  assert.equal(
    (
      await post("password-recovery/confirm", {
        challengeId: second.challengeId,
        proof: second.proof,
        code: "000000",
        newPassword,
      })
    ).statusCode,
    400,
  );
  await app.close();
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 2);
  assert.equal(
    (
      await db.query<{ delivery: string }>(
        "select delivery from password_recovery_challenges where id=$1",
        [first.challengeId],
      )
    ).rows[0]!.delivery,
    "failed",
  );
});

test("recovery resend keeps the capability and rejects the old code; requests and malformed JSON never echo secrets", async (t) => {
  const deliveries: Parameters<PasswordRecoveryEmailDelivery>[0][] = [];
  const { post, app, verified, settled, age } = await fixture(
    t,
    async (input) => {
      deliveries.push(input);
    },
  );
  await verified();
  const first = passwordRecoveryChallengeSchema.parse(
    (await post("password-recovery/request", { email })).json(),
  );
  await settled(first.challengeId);
  await age();
  const binding = { challengeId: first.challengeId, proof: first.proof };
  const resent = await post("password-recovery/resend", binding);
  assert.equal(resent.statusCode, 200);
  assert.deepEqual(resent.json(), first);
  await settled(first.challengeId);
  assert.equal(deliveries.length, 2);
  if (deliveries[0]!.code !== deliveries[1]!.code)
    assert.equal(
      (
        await post("password-recovery/confirm", {
          ...binding,
          code: deliveries[0]!.code,
          newPassword,
        })
      ).statusCode,
      400,
    );
  const malformed = await app.inject({
    method: "POST",
    url: "/v1/auth/password-recovery/confirm",
    headers: { ...headers, "content-type": "application/json" },
    payload: '{"newPassword":"synthetic-secret-password",',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.includes("synthetic-secret-password"), false);
  const invalid = await post("password-recovery/confirm", {
    ...binding,
    code: "secret-invalid",
    newPassword: "secret-short",
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.includes("secret-"), false);
});

test("five wrong delivered codes remain locked across a manual resend", async (t) => {
  const deliveries: Parameters<PasswordRecoveryEmailDelivery>[0][] = [];
  const { post, db, verified, settled, age } = await fixture(
    t,
    async (input) => {
      deliveries.push(input);
    },
  );
  await verified();
  const challenge = passwordRecoveryChallengeSchema.parse(
    (await post("password-recovery/request", { email })).json(),
  );
  await settled(challenge.challengeId);
  const binding = {
    challengeId: challenge.challengeId,
    proof: challenge.proof,
  };
  const wrong = () =>
    deliveries.at(-1)!.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 3; i++)
    assert.equal(
      (
        await post("password-recovery/confirm", {
          ...binding,
          code: wrong(),
          newPassword,
        })
      ).statusCode,
      400,
    );
  await age();
  assert.equal(
    (await post("password-recovery/resend", binding)).statusCode,
    200,
  );
  await settled(challenge.challengeId);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await post("password-recovery/confirm", {
          ...binding,
          code: wrong(),
          newPassword,
        })
      ).statusCode,
      400,
    );
  assert.equal(
    (
      await db.query<{ attempts: number }>(
        "select attempts from password_recovery_challenges where id=$1",
        [challenge.challengeId],
      )
    ).rows[0]!.attempts,
    5,
  );
  assert.equal(
    (
      await post("password-recovery/confirm", {
        ...binding,
        code: deliveries.at(-1)!.code,
        newPassword,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await post("login", { email, password: oldPassword })).statusCode,
    200,
  );
});

test("delivery remains bounded at twenty-five seconds even when a sender ignores abort", async (t) => {
  let signal: AbortSignal | undefined;
  const { post, db, verified, settled } = await fixture(t, async (input) => {
    signal = input.signal;
    return new Promise<void>(() => {});
  });
  await verified();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const challenge = passwordRecoveryChallengeSchema.parse(
      (await post("password-recovery/request", { email })).json(),
    );
    for (let i = 0; i < 100 && !signal; i++) await tick();
    assert.ok(signal);
    t.mock.timers.tick(24_999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    await settled(challenge.challengeId, "failed");
    assert.equal((await db.query("select 1 from sessions")).rows.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("actual structured logger redacts recovery secrets at request and top-level paths", async (t) => {
  const records: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      records.push(String(chunk));
      done();
    },
  });
  const app = Fastify({
    logger: {
      redact: redactPaths,
      stream,
      serializers: {
        req: (value: unknown) => value as Record<string, unknown>,
      },
    },
  });
  t.after(() => app.close());
  const values = {
    newPassword: "private-new-password",
    password: "private-password",
    currentPassword: "private-current-password",
    email: "private@example.test",
    code: "012345",
    proof: "a".repeat(64),
    resetProof: "b".repeat(64),
    proofHash: "c".repeat(64),
    resetProofHash: "d".repeat(64),
    codeHash: "e".repeat(64),
    passwordHash: "f".repeat(64),
    newPasswordHash: "1".repeat(64),
  };
  app.log.info({
    ...values,
    req: { body: values },
    event: "synthetic-recovery-redaction",
  });
  const output = records.join("");
  assert.ok(output.includes("synthetic-recovery-redaction"));
  for (const value of Object.values(values))
    assert.equal(output.includes(value), false);
});
