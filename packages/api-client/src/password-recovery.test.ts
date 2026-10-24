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
const receipt = { passwordReset: true, sessionsRevoked: true };
const errorCode = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;
test("recovery client uses exact paths, normalizes email and never requests or returns a session", async () => {
  for (const native of [false, true]) {
    const requests: { path: string; body: unknown }[] = [];
    const client = createClient("http://synthetic", {
      native,
      fetch: async (url, init) => {
        const path = String(url);
        requests.push({
          path,
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        });
        assert.equal(init?.credentials, "include");
        return Response.json(
          path.endsWith("-policy")
            ? { passwordRecovery: "available" }
            : path.endsWith("/confirm")
              ? receipt
              : challenge,
        );
      },
    });
    assert.deepEqual(await client.passwordRecoveryPolicy(), {
      passwordRecovery: "available",
    });
    assert.deepEqual(
      await client.beginPasswordRecovery("SYNTHETIC@EXAMPLE.TEST"),
      challenge,
    );
    assert.deepEqual(
      await client.resendPasswordRecovery(challengeId, proof),
      challenge,
    );
    assert.deepEqual(
      await client.confirmPasswordRecovery(
        challengeId,
        proof,
        "012345",
        "      ",
      ),
      receipt,
    );
    assert.deepEqual(requests, [
      { path: "http://synthetic/v1/auth/password-recovery-policy", body: null },
      {
        path: "http://synthetic/v1/auth/password-recovery/request",
        body: { email: "synthetic@example.test" },
      },
      {
        path: "http://synthetic/v1/auth/password-recovery/resend",
        body: { challengeId, proof },
      },
      {
        path: "http://synthetic/v1/auth/password-recovery/confirm",
        body: { challengeId, proof, code: "012345", newPassword: "      " },
      },
    ]);
  }
});
test("recovery rejects malformed local data before reading credentials or sending a request", async () => {
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
    () => client.beginPasswordRecovery("invalid"),
    () => client.resendPasswordRecovery("invalid", proof),
    () => client.confirmPasswordRecovery(challengeId, proof, "12345", "secret"),
    () => client.confirmPasswordRecovery(challengeId, proof, "123456", "short"),
  ])
    await assert.rejects(run(), {
      message: "Некорректные параметры восстановления доступа",
    });
  assert.equal(effects, 0);
});
test("recovery rejects mismatched resend and secret-bearing success responses", async () => {
  for (const response of [
    { ...challenge, proof: "cd".repeat(32) },
    { ...challenge, challengeId: "b274d301-c0e2-4e4a-b0f4-4bf8a513ff64" },
    { ...challenge, code: "123456" },
  ])
    await assert.rejects(
      createClient("http://synthetic", {
        fetch: async () => Response.json(response),
      }).resendPasswordRecovery(challengeId, proof),
      errorCode("invalid_response"),
    );
  for (const response of [
    { ...receipt, token: "secret" },
    { ...receipt, user: {} },
    { passwordReset: true },
    { ...receipt, sessionsRevoked: false },
  ])
    await assert.rejects(
      createClient("http://synthetic", {
        fetch: async () => Response.json(response),
      }).confirmPasswordRecovery(challengeId, proof, "123456", "new-password"),
      errorCode("invalid_response"),
    );
});
test("recovery aborts stale responses without retries, session publication or unauthorized events", async () => {
  const guard = createSessionGuard();
  let resolve!: (response: Response) => void;
  let calls = 0,
    published = 0,
    unauthorized = 0;
  const client = createClient("http://synthetic", {
    signal: () => guard.capture().signal,
    onUnauthorized: () => unauthorized++,
    fetch: async () => {
      calls++;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    },
  });
  const request = client
    .confirmPasswordRecovery(challengeId, proof, "123456", "new-password")
    .then(() => {
      published++;
    });
  const rejected = assert.rejects(request, errorCode("aborted"));
  guard.reset("different-owner");
  resolve(Response.json(receipt));
  await rejected;
  assert.equal(calls, 1);
  assert.equal(published, 0);
  assert.equal(unauthorized, 0);
});
test("recovery timeout does not replay mutation and pre-abort never reads credentials", async () => {
  let calls = 0;
  const client = createClient("http://synthetic", {
    limits: { requestTimeoutMs: 10 },
    fetch: async () => {
      calls++;
      return new Promise<Response>(() => {});
    },
  });
  await assert.rejects(
    client.resendPasswordRecovery(challengeId, proof),
    errorCode("timeout"),
  );
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  const aborted = createClient("http://synthetic", {
    signal: () => controller.signal,
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
    () => aborted.passwordRecoveryPolicy(),
    () => aborted.beginPasswordRecovery("synthetic@example.test"),
    () => aborted.resendPasswordRecovery(challengeId, proof),
    () =>
      aborted.confirmPasswordRecovery(
        challengeId,
        proof,
        "123456",
        "new-password",
      ),
  ])
    await assert.rejects(run(), errorCode("aborted"));
  assert.equal(calls, 1);
});
