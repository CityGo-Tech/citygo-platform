import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, type createClient } from "@citygo/api-client";
import type { AccountProfile } from "@citygo/contracts";
import {
  createAccountProfileResource,
  isAccountEmailCode,
  type AccountProfileState,
} from "./account-profile.state";

const stamp = Date.parse("2026-10-25T00:00:00Z");
const challenge = {
  challengeId: "e87ee322-c594-4dda-aedf-ce454d2f0001",
  proof: "ab".repeat(32),
  expiresAt: new Date(stamp + 600_000).toISOString(),
  resendAfterSeconds: 60,
};
const initial: AccountProfile = {
  userId: "17",
  email: "legacy@example.test",
  emailVerified: false,
  phoneVerified: false,
  giftStatus: "available",
  emailConfirmation: "available",
};
type Client = Pick<
  ReturnType<typeof createClient>,
  | "getAccountProfile"
  | "requestAccountEmailVerification"
  | "resendAccountEmailVerification"
  | "confirmAccountEmailVerification"
>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(profile = initial, userId = profile.userId) {
  let now = stamp,
    denied = 0,
    currentProfile = { ...profile };
  const owner = new AbortController(),
    states: AccountProfileState[] = [],
    calls: unknown[][] = [];
  const client: Client = {
    getAccountProfile: async () => {
      calls.push(["get"]);
      return { ...currentProfile };
    },
    requestAccountEmailVerification: async () => {
      calls.push(["request"]);
      return { ...challenge };
    },
    resendAccountEmailVerification: async (input) => {
      calls.push(["resend", input]);
      return { ...challenge, expiresAt: new Date(now + 600_000).toISOString() };
    },
    confirmAccountEmailVerification: async (input) => {
      calls.push(["confirm", input]);
      currentProfile = { ...currentProfile, emailVerified: true };
      return { userId, emailVerified: true };
    },
  };
  const resource = createAccountProfileResource({
    userId,
    client,
    sessionSignal: owner.signal,
    publish: (state) => states.push(state),
    now: () => now,
    onAccessDenied: () => {
      denied++;
    },
  });
  return {
    client,
    resource,
    owner,
    states,
    calls,
    last: () => states.at(-1)!,
    advance: (ms = 60_000) => {
      now += ms;
    },
    denied: () => denied,
  };
}

test("profile read is side-effect free and phone status is independent from a claimed gift", async () => {
  const s = setup({ ...initial, giftStatus: "claimed", phoneVerified: false });
  await s.resource.load();
  assert.deepEqual(s.calls, [["get"]]);
  assert.equal(s.last().profile?.phoneVerified, false);
  assert.equal(s.last().profile?.giftStatus, "claimed");
  assert.equal(s.last().challenge, null);
  s.resource.dispose();
});

test("username-only account with no real email cannot request a code", async () => {
  const s = setup({
    ...initial,
    email: null,
    emailConfirmation: "unavailable",
  });
  await s.resource.load();
  await s.resource.request();
  assert.deepEqual(s.calls, [["get"]]);
  assert.equal(s.last().profile?.email, null);
});

test("one explicit request and successful code update only the current owner and refresh gift eligibility", async () => {
  const s = setup();
  await s.resource.load();
  await s.resource.request();
  assert.deepEqual(s.calls, [["get"], ["request"]]);
  assert.equal(s.last().challenge?.resendAt, stamp + 60_000);
  await s.resource.confirm("012345");
  assert.deepEqual(s.calls, [
    ["get"],
    ["request"],
    [
      "confirm",
      {
        challengeId: challenge.challengeId,
        proof: challenge.proof,
        code: "012345",
      },
    ],
    ["get"],
  ]);
  assert.equal(s.last().profile?.emailVerified, true);
  assert.equal(s.last().challenge, null);
  assert.equal(s.last().busy, null);
  assert.match(s.last().notice, /Email подтверждён/);
  const published = JSON.stringify(s.states);
  for (const secret of [challenge.challengeId, challenge.proof, "012345"])
    assert.equal(published.includes(secret), false);
  await s.resource.confirm("012345");
  await s.resource.request();
  assert.equal(s.calls.length, 4);
});

test("ASCII six-digit validation and expiry prevent invalid confirmations from leaving the view", async () => {
  const s = setup();
  await s.resource.load();
  await s.resource.request();
  for (const value of ["12345", "1234567", " 123456", "١٢٣٤٥٦", "abcdef"]) {
    assert.equal(isAccountEmailCode(value), false);
    await s.resource.confirm(value);
  }
  assert.equal(isAccountEmailCode("000001"), true);
  s.advance(600_000);
  await s.resource.confirm("000001");
  await s.resource.resend();
  assert.equal(s.calls.length, 2);
  await s.resource.request();
  assert.equal(s.calls.filter(([kind]) => kind === "request").length, 2);
});

test("resend is explicit, waits its cooldown and never carries an editable email", async () => {
  const s = setup();
  await s.resource.load();
  await s.resource.request();
  await s.resource.resend();
  assert.equal(s.calls.length, 2);
  s.advance();
  await s.resource.resend();
  assert.deepEqual(s.calls.at(-1), [
    "resend",
    { challengeId: challenge.challengeId, proof: challenge.proof },
  ]);
  assert.equal(s.last().challenge?.resendAt, stamp + 120_000);
  await s.resource.resend();
  assert.equal(s.calls.length, 3);
});

test("lost send outcome is not retried automatically or immediately and provider details are hidden", async () => {
  const s = setup();
  s.client.requestAccountEmailVerification = async () => {
    s.calls.push(["request"]);
    throw new ApiError(502, "PRIVATE postbox-secret upstream reply");
  };
  await s.resource.load();
  await s.resource.request();
  await s.resource.request();
  assert.equal(s.calls.length, 2);
  assert.equal(s.last().challenge, null);
  assert.match(s.last().error, /отправку письма/);
  assert.doesNotMatch(
    JSON.stringify(s.states),
    /PRIVATE|postbox-secret|upstream/,
  );
  s.advance();
  await s.resource.request();
  assert.equal(s.calls.length, 3);
});

test("concurrent clicks issue one request, and cancellation prevents a late challenge from returning", async () => {
  const s = setup(),
    gate = deferred<typeof challenge>();
  s.client.requestAccountEmailVerification = () => {
    s.calls.push(["request"]);
    return gate.promise;
  };
  await s.resource.load();
  const request = s.resource.request();
  await s.resource.request();
  assert.equal(s.calls.length, 2);
  s.resource.cancelEmail();
  gate.resolve(challenge);
  await request;
  assert.equal(s.last().challenge, null);
  assert.equal(s.last().busy, null);
  assert.equal(s.last().notice, "");
});

test("late profile response cannot publish after account lifetime disposal", async () => {
  const a = setup(),
    gate = deferred<AccountProfile>();
  a.client.getAccountProfile = () => gate.promise;
  const loading = a.resource.load();
  a.resource.dispose();
  const published = a.states.length;
  const b = setup({ ...initial, userId: "42", email: "second@example.test" });
  await b.resource.load();
  gate.resolve(initial);
  await loading;
  assert.equal(a.states.length, published);
  assert.equal(b.last().profile?.email, "second@example.test");
});

test("logout erases pending capability and ignores a late confirmation and its refresh", async () => {
  const s = setup(),
    gate = deferred<{ userId: string; emailVerified: true }>();
  await s.resource.load();
  await s.resource.request();
  s.client.confirmAccountEmailVerification = () => gate.promise;
  const confirming = s.resource.confirm("012345");
  s.owner.abort();
  gate.resolve({ userId: "17", emailVerified: true });
  await confirming;
  assert.equal(s.last().phase, "closed");
  assert.equal(s.last().profile, null);
  assert.equal(s.last().challenge, null);
  assert.equal(s.calls.filter(([kind]) => kind === "get").length, 1);
});

test("GET or confirmation owner mismatch fails closed instead of adopting a different account", async () => {
  const get = setup();
  get.client.getAccountProfile = async () => ({
    ...initial,
    userId: "42",
    email: "PRIVATE@example.test",
  });
  await get.resource.load();
  assert.equal(get.denied(), 1);
  assert.equal(get.last().profile, null);
  assert.doesNotMatch(JSON.stringify(get.states), /PRIVATE/);
  const confirm = setup();
  await confirm.resource.load();
  await confirm.resource.request();
  confirm.client.confirmAccountEmailVerification = async () => ({
    userId: "42",
    emailVerified: true,
  });
  await confirm.resource.confirm("012345");
  assert.equal(confirm.denied(), 1);
  assert.equal(confirm.last().phase, "closed");
});

test("401 and consent-gate 403 close every operation and do not expose raw server bodies", async () => {
  for (const status of [401, 403])
    for (const operation of ["profile", "request", "confirm"]) {
      const s = setup(),
        fail = async () => {
          throw new ApiError(status, "PRIVATE consent/auth data");
        };
      if (operation === "profile") s.client.getAccountProfile = fail;
      await s.resource.load();
      if (operation === "request") {
        s.client.requestAccountEmailVerification = fail;
        await s.resource.request();
      }
      if (operation === "confirm") {
        await s.resource.request();
        s.client.confirmAccountEmailVerification = fail;
        await s.resource.confirm("012345");
      }
      assert.equal(s.denied(), 1);
      assert.equal(s.last().phase, "closed");
      assert.equal(s.last().profile, null);
      assert.doesNotMatch(JSON.stringify(s.states), /PRIVATE/);
      const before = s.calls.length;
      await s.resource.load();
      await s.resource.request();
      assert.equal(s.calls.length, before);
    }
});

test("bad code remains retryable, conflict discards capability, and confirmation survives only a failed GET", async () => {
  const bad = setup();
  await bad.resource.load();
  await bad.resource.request();
  bad.client.confirmAccountEmailVerification = async () => {
    throw new ApiError(400, "PRIVATE code 012345");
  };
  await bad.resource.confirm("012345");
  assert.match(bad.last().error, /Код не подошёл/);
  assert(bad.last().challenge);
  bad.client.confirmAccountEmailVerification = async () => {
    throw new ApiError(409, "PRIVATE");
  };
  await bad.resource.confirm("012345");
  assert.equal(bad.last().challenge, null);
  const s = setup();
  await s.resource.load();
  await s.resource.request();
  s.client.getAccountProfile = async () => {
    throw new Error("PRIVATE GET failure");
  };
  await s.resource.confirm("012345");
  assert.equal(s.last().profile?.emailVerified, true);
  assert.equal(s.last().challenge, null);
  assert.match(s.last().error, /остальные данные/);
  assert.doesNotMatch(s.last().error, /PRIVATE/);
});

test("ambiguous committed confirmation then a used-code error recovers through explicit own-profile GET", async () => {
  const s = setup();
  await s.resource.load();
  await s.resource.request();
  s.client.confirmAccountEmailVerification = async (input) => {
    s.calls.push(["confirm", input]);
    throw new ApiError(502, "Lost receipt after committed email update");
  };
  await s.resource.confirm("012345");
  assert.equal(s.last().profile?.emailVerified, false);
  assert(s.last().challenge);
  s.client.confirmAccountEmailVerification = async (input) => {
    s.calls.push(["confirm", input]);
    throw new ApiError(400, "Already consumed code");
  };
  await s.resource.confirm("012345");
  assert(s.last().challenge);
  s.client.getAccountProfile = async () => {
    s.calls.push(["get"]);
    return { ...initial, emailVerified: true };
  };
  await s.resource.load();
  assert.equal(s.last().profile?.emailVerified, true);
  assert.equal(s.last().challenge, null);
  assert.equal(s.last().error, "");
  assert.deepEqual(
    s.calls.map(([operation]) => operation),
    ["get", "request", "confirm", "confirm", "get"],
  );
  await s.resource.confirm("012345");
  await s.resource.request();
  assert.equal(s.calls.length, 5);
});
