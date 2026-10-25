import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createClient, createSessionGuard } from "./index.js";

const policy = {
  version: "synthetic-v1",
  personalData: {
    label: "Synthetic required",
    text: "Required synthetic text",
    url: "/legal/personal-data-consent",
    required: true,
  },
  marketing: {
    label: "Synthetic optional",
    text: "Optional synthetic text",
    url: "/legal/marketing-consent",
    required: false,
  },
};
const choice = {
  policyVersion: policy.version,
  personalData: true as const,
  marketing: false,
};
const state = {
  policy,
  personalDataGranted: true,
  marketingGranted: false,
  serviceConsentRequired: false,
};

test("public policy and authenticated consent endpoints preserve explicit marketing refusal", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      requests.push({
        path: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(
        String(url).endsWith("consent-policy") ? policy : state,
      );
    },
  });
  assert.deepEqual(await client.legalConsentPolicy(), policy);
  assert.deepEqual(await client.accountConsents(), state);
  assert.deepEqual(await client.setAccountConsents(choice), state);
  assert.deepEqual(requests, [
    {
      path: "http://synthetic/v1/legal/consent-policy",
      method: "GET",
      body: null,
    },
    { path: "http://synthetic/v1/account/consents", method: "GET", body: null },
    {
      path: "http://synthetic/v1/account/consents",
      method: "POST",
      body: choice,
    },
  ]);
});

test("missing choices, mandatory refusal, and coercible marketing values never reach registration transport", async () => {
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  for (const consents of [
    undefined,
    { ...choice, personalData: false },
    { ...choice, marketing: "false" },
    { policyVersion: policy.version, personalData: true },
  ]) {
    await assert.rejects(
      client.auth(
        "register",
        "synthetic@example.test",
        "123456",
        consents as typeof choice,
      ),
    );
    await assert.rejects(
      client.beginEmailRegistration(
        "synthetic@example.test",
        "123456",
        consents as typeof choice,
      ),
    );
  }
  assert.equal(calls, 0);
});

test("a consent write must confirm the same frozen version and exact marketing choice", async () => {
  for (const response of [
    { ...state, marketingGranted: true },
    { ...state, personalDataGranted: false },
    { ...state, serviceConsentRequired: true },
    { ...state, policy: { ...policy, version: "another-version" } },
  ]) {
    await assert.rejects(
      createClient("http://synthetic", {
        fetch: async () => Response.json(response),
      }).setAccountConsents(choice),
      (error: unknown) =>
        error instanceof ApiError && error.code === "invalid_response",
    );
  }
});

test("policy changes and service gates surface without retry or default acceptance", async () => {
  for (const [status, code] of [
    [409, "SERVICE_CONSENT_POLICY_CHANGED"],
    [403, "SERVICE_CONSENT_REQUIRED"],
  ] as const) {
    let calls = 0;
    const client = createClient("http://synthetic", {
      fetch: async () => {
        calls++;
        return Response.json(
          { error: "Synthetic consent action required", code },
          { status },
        );
      },
    });
    await assert.rejects(
      client.setAccountConsents(choice),
      (error: unknown) =>
        error instanceof ApiError && error.serverCode === code,
    );
    assert.equal(calls, 1);
  }
});

test("an old owner cannot publish late consent acceptance", async () => {
  const session = createSessionGuard();
  session.reset("old");
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const client = createClient("http://synthetic", {
    signal: () => session.capture().signal,
    fetch: async () => pending,
  });
  const result = client.setAccountConsents(choice);
  const rejected = assert.rejects(
    result,
    (error: unknown) => error instanceof ApiError && error.code === "aborted",
  );
  session.reset("new");
  resolve(Response.json(state));
  await rejected;
});
