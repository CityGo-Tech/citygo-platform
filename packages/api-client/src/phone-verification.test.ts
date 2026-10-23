import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createClient, createSessionGuard } from "./index.js";

const phone = "+79990000000";
const challengeId = "a274d301-c0e2-4e4a-b0f4-4bf8a513ff64";
const proof = "ab".repeat(32);
const challenge = {
  challengeId,
  proof,
  expiresAt: "2099-01-01T12:00:00.000Z",
  resendAfterSeconds: 60,
};
const receipt = {
  operationId: "b274d301-c0e2-4e4a-b0f4-4bf8a513ff64",
  grantedMicros: 500_000_000,
  alreadyGranted: false,
};
const policy = { phoneVerification: "required", giftAmountMicros: 500_000_000 };
const errorCode = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("phone methods use authenticated exact paths and canonical bodies without persisting phone, proof or code", async () => {
  for (const native of [false, true]) {
    const requests: {
      path: string;
      method: string;
      body: unknown;
      native: string | null;
      authorization: string | null;
      credentials: RequestCredentials | undefined;
    }[] = [];
    const client = createClient("http://synthetic", {
      native,
      token: () => "synthetic-session",
      fetch: async (url, init) => {
        const path = String(url),
          headers = new Headers(init?.headers);
        requests.push({
          path,
          method: init?.method ?? "GET",
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
          native: headers.get("X-CityGo-Client"),
          authorization: headers.get("Authorization"),
          credentials: init?.credentials,
        });
        return Response.json(
          path.endsWith("/policy")
            ? policy
            : path.endsWith("/confirm")
              ? receipt
              : challenge,
        );
      },
    });
    assert.deepEqual(await client.phoneVerificationPolicy(), policy);
    assert.deepEqual(
      await client.beginPhoneVerification("8 (999) 000-00-00"),
      challenge,
    );
    assert.deepEqual(
      await client.resendPhoneVerification(challengeId, proof, "79990000000"),
      challenge,
    );
    assert.deepEqual(
      await client.confirmPhoneVerification(
        challengeId,
        proof,
        "+7 999 000 00 00",
        "012345",
      ),
      receipt,
    );
    const common = {
      native: native ? "native" : null,
      credentials: "include",
      authorization: "Bearer synthetic-session",
    };
    assert.deepEqual(requests, [
      {
        ...common,
        path: "http://synthetic/v1/phone-verification/policy",
        method: "GET",
        body: null,
      },
      {
        ...common,
        path: "http://synthetic/v1/phone-verification/start",
        method: "POST",
        body: { phone },
      },
      {
        ...common,
        path: "http://synthetic/v1/phone-verification/resend",
        method: "POST",
        body: { challengeId, proof, phone },
      },
      {
        ...common,
        path: "http://synthetic/v1/phone-verification/confirm",
        method: "POST",
        body: { challengeId, proof, phone, code: "012345" },
      },
    ]);
  }
});

test("invalid phone/capability/code input fails before fetch or reading credentials, with no input in diagnostics", async () => {
  let effects = 0;
  const client = createClient("http://synthetic", {
    token: () => {
      effects++;
      return null;
    },
    fetch: async () => {
      effects++;
      return Response.json(challenge);
    },
  });
  for (const run of [
    () => client.beginPhoneVerification("+77010000000"),
    () => client.beginPhoneVerification("+79990000000,+79990000001"),
    () =>
      client.beginPhoneVerification({
        phone,
        apiId: "synthetic-secret",
      } as unknown as string),
    () => client.resendPhoneVerification("invalid-id", proof, phone),
    () =>
      client.resendPhoneVerification(
        challengeId,
        "synthetic-invalid-proof",
        phone,
      ),
    () =>
      client.confirmPhoneVerification(
        challengeId,
        proof,
        phone,
        "synthetic-invalid-code",
      ),
    () =>
      client.confirmPhoneVerification(
        challengeId,
        proof,
        "+74991234567",
        "012345",
      ),
  ])
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Некорректные параметры подтверждения телефона",
      );
      assert.equal(error.message.includes("synthetic"), false);
      return true;
    });
  assert.equal(effects, 0);
});

test("policy and challenge responses reject unknown fields, provider secrets and malformed values", async () => {
  for (const response of [
    {},
    { ...policy, phoneVerification: true },
    { ...policy, giftAmountMicros: "500000000" },
    { ...policy, apiId: "synthetic-secret" },
  ])
    await assert.rejects(
      createClient("http://synthetic", {
        fetch: async () => Response.json(response),
      }).phoneVerificationPolicy(),
      errorCode("invalid_response"),
    );
  for (const response of [
    {},
    { ...challenge, phone },
    { ...challenge, code: "012345" },
    { ...challenge, apiId: "synthetic-secret" },
    { ...challenge, accepted: true },
    { ...challenge, simulated: false },
    { ...challenge, resendAfterSeconds: 601 },
    { ...challenge, proof: "invalid-proof" },
  ]) {
    const client = createClient("http://synthetic", {
      fetch: async () => Response.json(response),
    });
    for (const run of [
      () => client.beginPhoneVerification(phone),
      () => client.resendPhoneVerification(challengeId, proof, phone),
    ])
      await assert.rejects(run(), errorCode("invalid_response"));
  }
});

test("a resend response stays bound to exactly the same challenge and proof", async () => {
  for (const change of [
    { challengeId: receipt.operationId },
    { proof: "cd".repeat(32) },
  ])
    await assert.rejects(
      createClient("http://synthetic", {
        fetch: async () => Response.json({ ...challenge, ...change }),
      }).resendPhoneVerification(challengeId, proof, phone),
      errorCode("invalid_response"),
    );
});

test("only a strict gift operation receipt is accepted, never a delivery result or altered amount", async () => {
  for (const alreadyGranted of [false, true])
    assert.deepEqual(
      await createClient("http://synthetic", {
        fetch: async () => Response.json({ ...receipt, alreadyGranted }),
      }).confirmPhoneVerification(challengeId, proof, phone, "012345"),
      { ...receipt, alreadyGranted },
    );
  for (const response of [
    {},
    { ...receipt, operationId: "invalid-id" },
    { ...receipt, grantedMicros: 500_000_001 },
    { ...receipt, grantedMicros: "500000000" },
    { ...receipt, alreadyGranted: "false" },
    { ...receipt, token: "synthetic-token" },
    { ...receipt, phone },
    { provider: "sms_ru", mode: "test", accepted: false, simulated: true },
    {
      provider: "sms_ru",
      mode: "live",
      accepted: true,
      simulated: false,
      providerMessageId: "000000-10000000",
    },
  ])
    await assert.rejects(
      createClient("http://synthetic", {
        fetch: async () => Response.json(response),
      }).confirmPhoneVerification(challengeId, proof, phone, "012345"),
      errorCode("invalid_response"),
    );
});

test("phone endpoints are account-bound: every current-session 401 invalidates authorization", async () => {
  let unauthorized = 0;
  const client = createClient("http://synthetic", {
    onUnauthorized: () => unauthorized++,
    fetch: async () =>
      Response.json({ error: "Not authorized" }, { status: 401 }),
  });
  for (const run of [
    () => client.phoneVerificationPolicy(),
    () => client.beginPhoneVerification(phone),
    () => client.resendPhoneVerification(challengeId, proof, phone),
    () => client.confirmPhoneVerification(challengeId, proof, phone, "012345"),
  ])
    await assert.rejects(run(), errorCode("http"));
  assert.equal(unauthorized, 4);
});

test("pre-cancelled phone commands never fetch or read credentials", async () => {
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
    () => client.phoneVerificationPolicy(),
    () => client.beginPhoneVerification(phone),
    () => client.resendPhoneVerification(challengeId, proof, phone),
    () => client.confirmPhoneVerification(challengeId, proof, phone, "012345"),
  ])
    await assert.rejects(run(), errorCode("aborted"));
  assert.equal(effects, 0);
});

test("late phone replies cannot expose a capability or gift after the session owner changes", async () => {
  for (const route of ["policy", "start", "resend", "confirm"] as const)
    for (const status of [200, 401]) {
      const session = createSessionGuard(),
        pending = deferred<Response>();
      let unauthorized = 0,
        published = 0,
        calls = 0;
      const client = createClient("http://synthetic", {
        signal: () => session.capture().signal,
        onUnauthorized: () => unauthorized++,
        fetch: async () => {
          calls++;
          return pending.promise;
        },
      });
      const result = (
        route === "policy"
          ? client.phoneVerificationPolicy()
          : route === "start"
            ? client.beginPhoneVerification(phone)
            : route === "resend"
              ? client.resendPhoneVerification(challengeId, proof, phone)
              : client.confirmPhoneVerification(
                  challengeId,
                  proof,
                  phone,
                  "012345",
                )
      ).then(() => {
        published++;
      });
      const rejected = assert.rejects(result, errorCode("aborted"));
      session.reset("another-account");
      pending.resolve(
        Response.json(
          route === "policy"
            ? policy
            : route === "confirm"
              ? receipt
              : challenge,
          { status },
        ),
      );
      await rejected;
      assert.equal(calls, 1);
      assert.equal(unauthorized, 0);
      assert.equal(published, 0);
    }
});

test("a phone resend timeout never automatically retries an SMS with an unknown outcome", async (t) => {
  const pending = deferred<Response>();
  let calls = 0;
  const client = createClient("http://synthetic", {
    limits: { requestTimeoutMs: 15 },
    fetch: async () => {
      calls++;
      return pending.promise;
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rejected = assert.rejects(
      client.resendPhoneVerification(challengeId, proof, phone),
      errorCode("timeout"),
    );
    t.mock.timers.tick(15);
    await rejected;
    pending.resolve(Response.json(challenge));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 1);
  } finally {
    t.mock.timers.reset();
  }
});
