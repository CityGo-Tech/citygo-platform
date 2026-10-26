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
  currentAiConsentRequired: false,
};

const aiPolicy = {
  ...policy,
  aiProcessing: {
    id: "a".repeat(64),
    version: "synthetic-modes-v1",
    provider: "routerai",
    model: "citygo/synthetic-modes",
    recipient: "Synthetic recipients",
    routing: "Synthetic route",
    data: "Synthetic context",
  },
};
const modeChoice = {
  expectedUserId: "1",
  policyVersion: aiPolicy.version,
  policyId: aiPolicy.aiProcessing.id,
  personalData: true as const,
};

test("new mode confirmation sends only the explicit frozen AI choice and preserves marketing", async () => {
  for (const marketingGranted of [false, true]) {
    const requests: unknown[] = [];
    const accepted = { ...state, policy: aiPolicy, marketingGranted };
    const client = createClient("http://synthetic", {
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json(accepted);
      },
    });
    assert.deepEqual(await client.confirmAiModesConsent(modeChoice), accepted);
    assert.deepEqual(requests, [
      {
        url: "http://synthetic/v1/account/ai-modes-consent",
        body: modeChoice,
      },
    ]);
  }
});

test("new mode confirmation rejects guessed choices before transport and mismatched evidence without retry", async () => {
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  for (const invalid of [
    { ...modeChoice, personalData: false },
    { ...modeChoice, policyId: "not-a-policy" },
    { ...modeChoice, marketing: true },
  ]) {
    await assert.rejects(
      client.confirmAiModesConsent(invalid as typeof modeChoice),
    );
  }
  assert.equal(calls, 0);
  for (const response of [
    { ...state, policy: aiPolicy, currentAiConsentRequired: undefined },
    { ...state, policy: aiPolicy, currentAiConsentRequired: true },
    { ...state, policy: aiPolicy, serviceConsentRequired: true },
    { ...state, policy: aiPolicy, personalDataGranted: false },
    { ...state, policy: { ...aiPolicy, version: "changed" } },
    {
      ...state,
      policy: {
        ...aiPolicy,
        aiProcessing: { ...aiPolicy.aiProcessing, id: "b".repeat(64) },
      },
    },
  ]) {
    let sent = 0;
    await assert.rejects(
      createClient("http://synthetic", {
        fetch: async () => {
          sent++;
          return Response.json(response);
        },
      }).confirmAiModesConsent(modeChoice),
      (error: unknown) =>
        error instanceof ApiError && error.code === "invalid_response",
    );
    assert.equal(sent, 1);
  }
});

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
