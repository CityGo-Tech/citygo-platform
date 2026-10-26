import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createClient, createSessionGuard } from "./index.js";

const challengeId = "4a661457-835c-45f7-ad42-e1b0ef366fb9";
const proof = "ab".repeat(32);
const challenge = {
  challengeId,
  proof,
  expiresAt: "2099-01-01T12:00:00.000Z",
  resendAfterSeconds: 60,
};
const profile = {
  userId: "9007199254740993",
  email: "owner@example.test",
  emailVerified: false,
  phoneVerified: false,
  giftStatus: "unavailable",
  emailConfirmation: "available",
};
const receipt = { userId: profile.userId, emailVerified: true };
const code = (value: string) => (error: unknown) =>
  error instanceof ApiError && error.code === value;

test("account contact client uses authenticated own-account paths and explicit send commands", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      const path = String(url);
      requests.push({
        path,
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      assert.equal(init?.credentials, "include");
      return Response.json(
        path.endsWith("/profile")
          ? profile
          : path.endsWith("/confirm")
            ? receipt
            : challenge,
      );
    },
  });
  assert.deepEqual(await client.getAccountProfile(), profile);
  assert.equal(requests.length, 1);
  assert.deepEqual(await client.requestAccountEmailVerification(), challenge);
  assert.deepEqual(
    await client.resendAccountEmailVerification({ challengeId, proof }),
    challenge,
  );
  assert.deepEqual(
    await client.confirmAccountEmailVerification({
      challengeId,
      proof,
      code: "001234",
    }),
    receipt,
  );
  assert.deepEqual(requests, [
    { path: "http://synthetic/v1/account/profile", body: null },
    { path: "http://synthetic/v1/account/email/verification", body: {} },
    {
      path: "http://synthetic/v1/account/email/verification/resend",
      body: { challengeId, proof },
    },
    {
      path: "http://synthetic/v1/account/email/verification/confirm",
      body: { challengeId, proof, code: "001234" },
    },
  ]);
});

test("invalid confirmation data cannot read credentials or send another owner's address", async () => {
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
  for (const input of [
    { challengeId: "invalid", proof },
    { challengeId, proof, email: "other@example.test" },
  ])
    await assert.rejects(
      client.resendAccountEmailVerification(input),
      /Некорректные параметры подтверждения email/,
    );
  await assert.rejects(
    client.confirmAccountEmailVerification({
      challengeId,
      proof,
      code: "12345",
    }),
    /Некорректные параметры подтверждения email/,
  );
  assert.equal(effects, 0);
});

test("rejects leaked secrets, fake verification facts and mismatched resend capabilities", async () => {
  for (const response of [
    { ...profile, code: "123456" },
    { ...profile, email: null, emailVerified: true },
    { ...profile, phoneVerified: "yes" },
  ])
    await assert.rejects(
      createClient("http://synthetic", {
        fetch: async () => Response.json(response),
      }).getAccountProfile(),
      code("invalid_response"),
    );
  for (const response of [
    { ...challenge, proof: "cd".repeat(32) },
    { ...challenge, challengeId: "5a661457-835c-45f7-ad42-e1b0ef366fb9" },
    { ...challenge, code: "123456" },
  ])
    await assert.rejects(
      createClient("http://synthetic", {
        fetch: async () => Response.json(response),
      }).resendAccountEmailVerification({ challengeId, proof }),
      code("invalid_response"),
    );
  await assert.rejects(
    createClient("http://synthetic", {
      fetch: async () => Response.json({ ...receipt, token: "private" }),
    }).confirmAccountEmailVerification({ challengeId, proof, code: "001234" }),
    code("invalid_response"),
  );
});

test("session replacement aborts a late confirmation response without retry or publication", async () => {
  const guard = createSessionGuard();
  let resolve!: (response: Response) => void;
  let calls = 0,
    published = 0;
  const client = createClient("http://synthetic", {
    signal: () => guard.capture().signal,
    fetch: async () => {
      calls++;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    },
  });
  const pending = client
    .confirmAccountEmailVerification({ challengeId, proof, code: "001234" })
    .then(() => {
      published++;
    });
  const rejected = assert.rejects(pending, code("aborted"));
  guard.reset("other-owner");
  resolve(Response.json(receipt));
  await rejected;
  assert.equal(calls, 1);
  assert.equal(published, 0);
});
