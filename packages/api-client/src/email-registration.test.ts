import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createClient, createSessionGuard } from "./index.js";

const challengeId = "a274d301-c0e2-4e4a-b0f4-4bf8a513ff64";
const proof = "ab".repeat(32);
const challenge = {
  challengeId,
  proof,
  expiresAt: "2099-01-01T12:00:00.000Z",
  resendAfterSeconds: 60,
};
const consents = {
  policyVersion: "synthetic-v1",
  personalData: true as const,
  marketing: false,
};
const consentPolicy = {
  version: "synthetic-v1",
  personalData: {
    label: "Synthetic personal data",
    text: "Synthetic required text",
    url: "/legal/personal-data-consent",
    required: true,
  },
  marketing: {
    label: "Synthetic marketing",
    text: "Synthetic optional text",
    url: "/legal/marketing-consent",
    required: false,
  },
};
const user = { id: "1", email: "synthetic@example.test" };
const errorCode = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("registration policy and email methods use the exact auth paths without storing challenge data", async () => {
  for (const native of [false, true]) {
    const requests: {
      path: string;
      method: string;
      body: unknown;
      native: string | null;
      credentials: RequestCredentials | undefined;
    }[] = [];
    const result = { user, ...(native ? { token: "synthetic-session" } : {}) };
    const rotated = { ...challenge, proof: "cd".repeat(32) };
    const client = createClient("http://synthetic", {
      native,
      fetch: async (url, init) => {
        const path = String(url);
        requests.push({
          path,
          method: init?.method ?? "GET",
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
          native: new Headers(init?.headers).get("X-CityGo-Client"),
          credentials: init?.credentials,
        });
        return Response.json(
          path.endsWith("/registration-policy")
            ? { emailVerification: "required", consentPolicy }
            : path.endsWith("/confirm")
              ? result
              : path.endsWith("/resend")
                ? rotated
                : challenge,
        );
      },
    });
    assert.deepEqual(await client.registrationPolicy(), {
      emailVerification: "required",
      consentPolicy,
    });
    assert.deepEqual(
      await client.beginEmailRegistration(
        "SYNTHETIC@EXAMPLE.TEST",
        "  а!b ",
        consents,
      ),
      challenge,
    );
    assert.deepEqual(
      await client.resendEmailRegistration(challengeId, proof),
      rotated,
    );
    assert.deepEqual(
      await client.confirmEmailRegistration(
        challengeId,
        rotated.proof,
        "012345",
      ),
      result,
    );
    const common = { native: native ? "native" : null, credentials: "include" };
    assert.deepEqual(requests, [
      {
        ...common,
        path: "http://synthetic/v1/auth/registration-policy",
        method: "GET",
        body: null,
      },
      {
        ...common,
        path: "http://synthetic/v1/auth/email/register",
        method: "POST",
        body: { email: "synthetic@example.test", password: "  а!b ", consents },
      },
      {
        ...common,
        path: "http://synthetic/v1/auth/email/resend",
        method: "POST",
        body: { challengeId, proof },
      },
      {
        ...common,
        path: "http://synthetic/v1/auth/email/confirm",
        method: "POST",
        body: { challengeId, proof: rotated.proof, code: "012345" },
      },
    ]);
  }
});

test("native email confirmation requires an auth token while browser confirmation uses the existing auth contract", async () => {
  for (const native of [false, true]) {
    const client = createClient("http://synthetic", {
      native,
      fetch: async () => Response.json({ user }),
    });
    const confirming = client.confirmEmailRegistration(
      challengeId,
      proof,
      "123456",
    );
    if (native) await assert.rejects(confirming, errorCode("invalid_response"));
    else assert.deepEqual(await confirming, { user });
  }
});

test("invalid local registration data is rejected before any transport or credential effects", async () => {
  let calls = 0;
  const client = createClient("http://synthetic", {
    token: () => {
      calls++;
      return null;
    },
    fetch: async () => {
      calls++;
      return Response.json(challenge);
    },
  });
  for (const run of [
    () => client.beginEmailRegistration("invalid-email", "123456", consents),
    () => client.beginEmailRegistration(user.email, "12345", consents),
    () => client.resendEmailRegistration("not-a-uuid", proof),
    () => client.resendEmailRegistration(challengeId, "secret-invalid-proof"),
    () =>
      client.confirmEmailRegistration(
        challengeId,
        proof,
        "secret-invalid-code",
      ),
  ])
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Некорректные параметры подтверждения email");
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
  assert.equal(calls, 0);
});

test("strict challenge and policy responses reject OTPs, secrets and incorrect field types", async () => {
  for (const response of [
    {},
    { ...challenge, code: "123456" },
    { ...challenge, otp: "123456" },
    { ...challenge, password: "synthetic-password" },
    { ...challenge, token: "not-an-auth-response" },
    { ...challenge, resendAfterSeconds: 601 },
    { ...challenge, resendAfterSeconds: "60" },
  ]) {
    const client = createClient("http://synthetic", {
      fetch: async () => Response.json(response),
    });
    for (const run of [
      () => client.beginEmailRegistration(user.email, "123456", consents),
      () => client.resendEmailRegistration(challengeId, proof),
    ])
      await assert.rejects(run(), errorCode("invalid_response"));
  }
  for (const response of [
    {},
    { emailVerification: true },
    { emailVerification: "required", token: "secret" },
  ])
    await assert.rejects(
      createClient("http://synthetic", {
        fetch: async () => Response.json(response),
      }).registrationPolicy(),
      errorCode("invalid_response"),
    );
});

test("email auth 401s never publish an unauthorized event for the current account", async () => {
  let unauthorized = 0;
  const client = createClient("http://synthetic", {
    onUnauthorized: () => unauthorized++,
    fetch: async () =>
      Response.json({ error: "Not confirmed" }, { status: 401 }),
  });
  for (const run of [
    () => client.registrationPolicy(),
    () => client.beginEmailRegistration(user.email, "123456", consents),
    () => client.resendEmailRegistration(challengeId, proof),
    () => client.confirmEmailRegistration(challengeId, proof, "123456"),
  ])
    await assert.rejects(run(), errorCode("http"));
  assert.equal(unauthorized, 0);
});

test("a pre-cancelled email registration never fetches or reads account credentials", async () => {
  const controller = new AbortController();
  controller.abort();
  let effects = 0;
  const client = createClient("http://synthetic", {
    signal: () => controller.signal,
    token: () => {
      effects++;
      return "synthetic-session";
    },
    fetch: async () => {
      effects++;
      return Response.json(challenge);
    },
  });
  for (const run of [
    () => client.registrationPolicy(),
    () => client.beginEmailRegistration(user.email, "123456", consents),
    () => client.resendEmailRegistration(challengeId, proof),
    () => client.confirmEmailRegistration(challengeId, proof, "123456"),
  ])
    await assert.rejects(run(), errorCode("aborted"));
  assert.equal(effects, 0);
});

test("a late email confirmation cannot publish a session after owner change", async () => {
  for (const status of [200, 401]) {
    const session = createSessionGuard();
    const pending = deferred<Response>();
    let unauthorized = 0;
    let published = 0;
    let calls = 0;
    const client = createClient("http://synthetic", {
      signal: () => session.capture().signal,
      onUnauthorized: () => unauthorized++,
      native: true,
      fetch: async () => {
        calls++;
        return pending.promise;
      },
    });
    const result = client
      .confirmEmailRegistration(challengeId, proof, "123456")
      .then(() => {
        published++;
      });
    const rejected = assert.rejects(result, errorCode("aborted"));
    session.reset("another-account");
    pending.resolve(Response.json({ user, token: "late-session" }, { status }));
    await rejected;
    assert.equal(calls, 1);
    assert.equal(unauthorized, 0);
    assert.equal(published, 0);
  }
});

test("email resend deadlines do not retry when a transport ignores cancellation", async () => {
  const pending = deferred<Response>();
  let calls = 0;
  const client = createClient("http://synthetic", {
    limits: { requestTimeoutMs: 15 },
    fetch: async () => {
      calls++;
      return pending.promise;
    },
  });
  await assert.rejects(
    client.resendEmailRegistration(challengeId, proof),
    errorCode("timeout"),
  );
  pending.resolve(Response.json(challenge));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
});

test("default email begin and resend wait beyond the server's twenty-five-second delivery budget", async (t) => {
  for (const method of ["begin", "resend"] as const) {
    const pending = deferred<Response>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const client = createClient("http://synthetic", {
        fetch: async (_url, init) => {
          calls++;
          signal = init?.signal ?? undefined;
          return pending.promise;
        },
      });
      const result =
        method === "begin"
          ? client.beginEmailRegistration(user.email, "123456", consents)
          : client.resendEmailRegistration(challengeId, proof);
      t.mock.timers.tick(25_001);
      assert.equal(signal?.aborted, false);
      pending.resolve(Response.json(challenge));
      assert.deepEqual(await result, challenge);
      assert.equal(calls, 1);
    } finally {
      t.mock.timers.reset();
    }
  }
});

test("default email begin and resend still time out at thirty seconds without retry", async (t) => {
  for (const method of ["begin", "resend"] as const) {
    const pending = deferred<Response>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const client = createClient("http://synthetic", {
        fetch: async (_url, init) => {
          calls++;
          signal = init?.signal ?? undefined;
          return pending.promise;
        },
      });
      const result =
        method === "begin"
          ? client.beginEmailRegistration(user.email, "123456", consents)
          : client.resendEmailRegistration(challengeId, proof);
      const rejected = assert.rejects(result, errorCode("timeout"));
      t.mock.timers.tick(29_999);
      assert.equal(signal?.aborted, false);
      t.mock.timers.tick(1);
      await rejected;
      pending.resolve(Response.json(challenge));
      await Promise.resolve();
      assert.equal(signal?.aborted, true);
      assert.equal(calls, 1);
    } finally {
      t.mock.timers.reset();
    }
  }
});
