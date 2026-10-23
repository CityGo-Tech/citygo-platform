import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import { connectDatabase, migrate } from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  emailRegistrationChallengeSchema,
} from "@citygo/contracts";
import { redactPaths } from "@citygo/observability";
import { buildApp } from "./app.js";
import type { RegistrationEmailDelivery } from "./email-registration.js";

const headers = {
  origin: "http://localhost:3000",
  [CONTRACT_VERSION_HEADER]: "1",
};
const email = "synthetic-email@example.test";
const password = "      "; // Six opaque characters remain valid, not trimmed.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const ageQuota = (db: Awaited<ReturnType<typeof connectDatabase>>) =>
  db.query(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 minutes'",
  );
async function fixture(
  t: TestContext,
  mode: "disabled" | "required",
  delivery?: RegistrationEmailDelivery,
) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
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
    emailRegistrationDelivery: delivery,
  });
  t.after(() => app.close());
  return {
    app,
    db,
    post: (url: string, payload: unknown) =>
      app.inject({ method: "POST", url, headers, payload: payload as object }),
  };
}

test("disabled flow preserves six-character registration, but cannot fake confirmation", async (t) => {
  const { app, post, db } = await fixture(t, "disabled");
  assert.deepEqual(
    (await app.inject({ url: "/v1/auth/registration-policy", headers })).json(),
    { emailVerification: "disabled" },
  );
  assert.equal(
    (await post("/v1/auth/email/register", { email, password })).statusCode,
    503,
  );
  assert.equal(
    (await db.query("select id from email_registrations")).rows.length,
    0,
  );
  assert.equal(
    (await post("/v1/auth/register", { email, password })).statusCode,
    200,
  );
});

test("required without delivery is honest unavailable, denies legacy bypass but preserves historical login", async (t) => {
  const { app, post, db } = await fixture(t, "required");
  assert.deepEqual(
    (await app.inject({ url: "/v1/auth/registration-policy", headers })).json(),
    { emailVerification: "unavailable" },
  );
  assert.equal(
    (await post("/v1/auth/register", { email, password })).statusCode,
    503,
  );
  assert.equal(
    (await post("/v1/auth/email/register", { email, password })).statusCode,
    503,
  );
  assert.equal((await db.query("select id from users")).rows.length, 0);
  const { hashPassword } = await import("./auth.js");
  const { Repository } = await import("@citygo/db");
  await new Repository(db).register(email, await hashPassword(password));
  assert.equal(
    (await post("/v1/auth/login", { email, password })).statusCode,
    200,
  );
  assert.equal(
    (await db.query("select user_id from account_email_verifications")).rows
      .length,
    0,
  );
});

test("real HTTP boundary requires delivered code and browser proof before minting an account/session", async (t) => {
  let delivered: { email: string; code: string } | undefined;
  const { app, post, db } = await fixture(t, "required", async (input) => {
    delivered = input;
  });
  assert.deepEqual(
    (await app.inject({ url: "/v1/auth/registration-policy", headers })).json(),
    { emailVerification: "required" },
  );
  const begun = await post("/v1/auth/email/register", { email, password });
  assert.equal(begun.statusCode, 200);
  assert.ok(!begun.headers["set-cookie"]);
  const challenge = emailRegistrationChallengeSchema.parse(begun.json());
  assert.equal(delivered?.email, email);
  assert.match(delivered!.code, /^[0-9]{6}$/);
  assert.equal(Object.hasOwn(challenge, "code"), false);
  assert.equal((await db.query("select id from users")).rows.length, 0);
  assert.equal((await db.query("select user_id from sessions")).rows.length, 0);
  const binding = {
    challengeId: challenge.challengeId,
    proof: challenge.proof,
  };
  assert.equal(
    (
      await post("/v1/auth/email/confirm", {
        ...binding,
        proof: "0".repeat(64),
        code: delivered!.code,
      })
    ).statusCode,
    400,
  );
  const wrongCode = delivered!.code === "000000" ? "111111" : "000000";
  assert.equal(
    (await post("/v1/auth/email/confirm", { ...binding, code: wrongCode }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await db.query<{ attempts: number }>(
        "select attempts from email_registrations",
      )
    ).rows[0]!.attempts,
    1,
  );
  const confirmed = await post("/v1/auth/email/confirm", {
    ...binding,
    code: delivered!.code,
  });
  assert.equal(confirmed.statusCode, 200);
  assert.ok(confirmed.headers["set-cookie"]);
  assert.equal(confirmed.json().user.email, email);
  assert.equal(confirmed.json().token, undefined);
  assert.equal(
    (await db.query("select user_id from account_email_verifications")).rows
      .length,
    1,
  );
  assert.equal(
    (await db.query("select id from ai_credit_entries")).rows.length,
    0,
  );
  assert.equal(
    (
      await post("/v1/auth/email/confirm", {
        ...binding,
        code: delivered!.code,
      })
    ).statusCode,
    400,
  );
});

test("delivery failure never creates an account or returns upstream secrets and still consumes quota", async (t) => {
  const { post, db } = await fixture(t, "required", async () => {
    throw Error("synthetic-private-provider-detail");
  });
  const response = await post("/v1/auth/email/register", { email, password });
  assert.equal(response.statusCode, 503);
  assert.ok(!response.body.includes("synthetic-private-provider-detail"));
  assert.equal((await db.query("select id from users")).rows.length, 0);
  assert.equal(
    (
      await db.query(
        "select id from email_registrations where delivery='failed'",
      )
    ).rows.length,
    1,
  );
  assert.equal(
    (await post("/v1/auth/email/register", { email, password })).statusCode,
    429,
  );
});

test("synthetic sender cannot be injected outside the explicit isolated test harness", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await assert.rejects(
    buildApp({
      db,
      config: readConfig({ NODE_ENV: "development" }),
      testing: true,
      emailRegistrationDelivery: async () => {},
    }),
    /isolated test harness/,
  );
  await assert.rejects(
    buildApp({
      db,
      config: readConfig({ NODE_ENV: "test" }),
      emailRegistrationDelivery: async () => {},
    }),
    /isolated test harness/,
  );
});

test("HTTP resend preserves its browser proof, replaces the OTP and creates exactly one account/session", async (t) => {
  const delivered: Parameters<RegistrationEmailDelivery>[0][] = [];
  const { post, db } = await fixture(t, "required", async (input) => {
    delivered.push(input);
  });
  const begun = await post("/v1/auth/email/register", { email, password });
  const challenge = emailRegistrationChallengeSchema.parse(begun.json());
  const binding = {
    challengeId: challenge.challengeId,
    proof: challenge.proof,
  };
  assert.equal(delivered.length, 1);
  const firstCode = delivered[0]!.code;
  const blocked = await post("/v1/auth/email/resend", binding);
  assert.equal(blocked.statusCode, 429);
  assert.equal(delivered.length, 1);
  await ageQuota(db);
  const resent = await post("/v1/auth/email/resend", binding);
  assert.equal(resent.statusCode, 200);
  const replacement = emailRegistrationChallengeSchema.parse(resent.json());
  assert.deepEqual(
    { challengeId: replacement.challengeId, proof: replacement.proof },
    binding,
  );
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1]!.email, email);
  assert.equal(
    (await post("/v1/auth/email/confirm", { ...binding, code: firstCode }))
      .statusCode,
    400,
  );
  const confirmed = await post("/v1/auth/email/confirm", {
    ...binding,
    code: delivered[1]!.code,
  });
  assert.equal(confirmed.statusCode, 200);
  assert.ok(confirmed.headers["set-cookie"]);
  assert.equal(confirmed.json().token, undefined);
  assert.equal(
    (
      await post("/v1/auth/email/confirm", {
        ...binding,
        code: delivered[1]!.code,
      })
    ).statusCode,
    400,
  );
  for (const table of [
    "users",
    "user_credentials",
    "sessions",
    "account_email_verifications",
  ])
    assert.equal((await db.query(`select 1 from ${table}`)).rows.length, 1);
  assert.equal(
    (await db.query("select 1 from ai_credit_entries")).rows.length,
    0,
  );
});

test("late failed delivery from an older HTTP resend cannot cancel the newly delivered code", async (t) => {
  const entered = deferred<void>();
  const staleSender = deferred<void>();
  const delivered: Parameters<RegistrationEmailDelivery>[0][] = [];
  const { post, db } = await fixture(t, "required", async (input) => {
    delivered.push(input);
    if (delivered.length === 2) {
      entered.resolve();
      await staleSender.promise;
    }
  });
  const begun = await post("/v1/auth/email/register", { email, password });
  const challenge = emailRegistrationChallengeSchema.parse(begun.json());
  const binding = {
    challengeId: challenge.challengeId,
    proof: challenge.proof,
  };
  await ageQuota(db);
  const staleResponse = post("/v1/auth/email/resend", binding);
  try {
    await entered.promise;
    await ageQuota(db);
    const current = await post("/v1/auth/email/resend", binding);
    assert.equal(current.statusCode, 200);
    assert.equal(delivered.length, 3);
  } finally {
    staleSender.reject(new Error("synthetic-private-late-provider-detail"));
  }
  const failed = await staleResponse;
  assert.equal(failed.statusCode, 503);
  assert.ok(!failed.body.includes("synthetic-private-late-provider-detail"));
  assert.equal(delivered[1]!.signal.aborted, true);
  assert.equal(
    (
      await db.query<{ delivery: string }>(
        "select delivery from email_registrations",
      )
    ).rows[0]!.delivery,
    "sent",
  );
  assert.equal(
    (
      await post("/v1/auth/email/confirm", {
        ...binding,
        code: delivered[1]!.code,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await post("/v1/auth/email/confirm", {
        ...binding,
        code: delivered[2]!.code,
      })
    ).statusCode,
    200,
  );
  assert.equal((await db.query("select 1 from users")).rows.length, 1);
  assert.equal((await db.query("select 1 from sessions")).rows.length, 1);
});

test("an unresponsive sender reaches the eight-second deadline, aborts and cannot create an account after a late completion", async (t) => {
  const entered = deferred<Parameters<RegistrationEmailDelivery>[0]>();
  const sender = deferred<void>();
  const { post, db } = await fixture(t, "required", async (input) => {
    entered.resolve(input);
    await sender.promise;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = post("/v1/auth/email/register", { email, password });
    const sent = await entered.promise;
    t.mock.timers.tick(7_999);
    assert.equal(sent.signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(sent.signal.aborted, true);
    const failed = await pending;
    assert.equal(failed.statusCode, 503);
    assert.ok(!failed.headers["set-cookie"]);
    assert.equal(failed.json().challengeId, undefined);
    assert.equal(failed.json().proof, undefined);
    assert.equal(
      (
        await db.query<{ delivery: string }>(
          "select delivery from email_registrations",
        )
      ).rows[0]!.delivery,
      "failed",
    );
    sender.resolve();
    await sender.promise;
    await Promise.resolve();
    for (const table of [
      "users",
      "sessions",
      "account_email_verifications",
      "ai_credit_entries",
    ])
      assert.equal((await db.query(`select 1 from ${table}`)).rows.length, 0);
    assert.equal(
      (
        await db.query<{ delivery: string }>(
          "select delivery from email_registrations",
        )
      ).rows[0]!.delivery,
      "failed",
    );
    assert.equal(
      (await db.query("select 1 from email_registration_rate_events")).rows
        .length,
      2,
    );
  } finally {
    sender.resolve();
    t.mock.timers.reset();
  }
});

test("only an explicit native confirmation returns a bearer token, backed by its one real synthetic session", async (t) => {
  let delivered: Parameters<RegistrationEmailDelivery>[0] | undefined;
  const { app, post, db } = await fixture(t, "required", async (input) => {
    delivered = input;
  });
  const challenge = emailRegistrationChallengeSchema.parse(
    (await post("/v1/auth/email/register", { email, password })).json(),
  );
  const confirmed = await app.inject({
    method: "POST",
    url: "/v1/auth/email/confirm",
    headers: { [CONTRACT_VERSION_HEADER]: "1", "x-citygo-client": "native" },
    payload: {
      challengeId: challenge.challengeId,
      proof: challenge.proof,
      code: delivered!.code,
    },
  });
  assert.equal(confirmed.statusCode, 200);
  const bearer = confirmed.json().token;
  assert.match(bearer, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(String(confirmed.headers["set-cookie"]).includes("HttpOnly"));
  const rows = (
    await db.query<{ token_hash: string; user_id: string }>(
      "select token_hash,user_id::text from sessions",
    )
  ).rows;
  assert.deepEqual(rows, [
    {
      token_hash: createHash("sha256").update(bearer).digest("hex"),
      user_id: confirmed.json().user.id,
    },
  ]);
  assert.equal(
    (await db.query("select 1 from ai_credit_entries")).rows.length,
    0,
  );
});

test("all registration writes obey Origin and contract-version guards before delivery or state changes", async (t) => {
  const delivered: Parameters<RegistrationEmailDelivery>[0][] = [];
  const { app, post, db } = await fixture(t, "required", async (input) => {
    delivered.push(input);
  });
  const challenge = emailRegistrationChallengeSchema.parse(
    (await post("/v1/auth/email/register", { email, password })).json(),
  );
  const binding = {
    challengeId: challenge.challengeId,
    proof: challenge.proof,
  };
  const cases = [
    {
      url: "/v1/auth/email/register",
      payload: { email: "other-synthetic@example.test", password },
    },
    { url: "/v1/auth/email/resend", payload: binding },
    {
      url: "/v1/auth/email/confirm",
      payload: { ...binding, code: delivered[0]!.code },
    },
  ];
  for (const command of cases) {
    const foreign = await app.inject({
      method: "POST",
      ...command,
      headers: { ...headers, origin: "https://foreign.example.test" },
    });
    assert.equal(foreign.statusCode, 403);
    assert.ok(!foreign.headers["set-cookie"]);
    const incompatible = await app.inject({
      method: "POST",
      ...command,
      headers: { ...headers, [CONTRACT_VERSION_HEADER]: "2" },
    });
    assert.equal(incompatible.statusCode, 400);
    assert.equal(incompatible.json().code, "CONTRACT_VERSION_UNSUPPORTED");
    assert.ok(!incompatible.headers["set-cookie"]);
  }
  assert.equal(delivered.length, 1);
  assert.equal(
    (await db.query("select 1 from email_registrations")).rows.length,
    1,
  );
  assert.equal(
    (
      await db.query<{ attempts: number }>(
        "select attempts from email_registrations",
      )
    ).rows[0]!.attempts,
    0,
  );
  assert.equal(
    (await db.query("select 1 from email_registration_rate_events")).rows
      .length,
    2,
  );
  assert.equal((await db.query("select 1 from users")).rows.length, 0);
  assert.equal((await db.query("select 1 from sessions")).rows.length, 0);
});

test("structured registration logs redact email, password, OTP, proof and credentials through the actual API logger", async (t) => {
  const records: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      records.push(String(chunk));
      done();
    },
  });
  const app = Fastify({
    logger: {
      level: "info",
      redact: redactPaths,
      stream,
      // Keep the explicit synthetic body visible to the logger so this test
      // exercises redaction rather than the default serializer omitting it.
      serializers: {
        req: (value: unknown) => value as Record<string, unknown>,
        res: (value: unknown) => value as Record<string, unknown>,
      },
    },
  });
  t.after(() => app.close());
  const canaries = {
    email: "synthetic-private-person@example.test",
    password: "synthetic-private-password",
    code: "012345",
    proof: "b".repeat(64),
    authorization: "Bearer SYNTHETIC-PRIVATE-AUTH",
    cookie: "SYNTHETIC-PRIVATE-COOKIE",
    setCookie: "SYNTHETIC-PRIVATE-SET-COOKIE",
    codeHash: "c".repeat(64),
    proofHash: "d".repeat(64),
  };
  app.log.info(
    {
      req: {
        headers: {
          authorization: canaries.authorization,
          cookie: canaries.cookie,
        },
        body: {
          email: canaries.email,
          password: canaries.password,
          code: canaries.code,
          proof: canaries.proof,
        },
      },
      res: { headers: { "set-cookie": canaries.setCookie } },
      codeHash: canaries.codeHash,
      proofHash: canaries.proofHash,
      event: "synthetic-registration-redaction",
    },
    "Synthetic registration logging",
  );
  const output = records.join("");
  assert.ok(output.includes("synthetic-registration-redaction"));
  for (const value of Object.values(canaries))
    assert.ok(!output.includes(value));
  const logged = JSON.parse(records[0]!);
  for (const key of ["email", "password", "code", "proof"])
    assert.equal(logged.req.body[key], "[Redacted]");
  assert.equal(logged.codeHash, "[Redacted]");
  assert.equal(logged.proofHash, "[Redacted]");
});
