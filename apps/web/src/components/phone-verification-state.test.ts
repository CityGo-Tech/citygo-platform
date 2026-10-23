import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, type createClient } from "@citygo/api-client";
import {
  createPhoneVerificationResource,
  isPhoneCode,
  maskPhone,
  normalizePhone,
  phoneDeliveryLabel,
  type PhoneVerificationState,
} from "./phone-verification-state";

const phone = "+79990000000";
const challenge = {
  challengeId: "a274d301-c0e2-4e4a-b0f4-4bf8a513ff64",
  proof: "ab".repeat(32),
  expiresAt: "2099-01-01T12:00:00Z",
  resendAfterSeconds: 60,
};
const receipt = {
  operationId: "b274d301-c0e2-4e4a-b0f4-4bf8a513ff64",
  grantedMicros: 500_000_000 as const,
  alreadyGranted: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let time = Date.parse("2026-10-24T00:00:00Z");
  const owner = new AbortController();
  const states: PhoneVerificationState[] = [];
  const calls: unknown[][] = [];
  const client: Pick<
    ReturnType<typeof createClient>,
    | "phoneVerificationPolicy"
    | "beginPhoneVerification"
    | "resendPhoneVerification"
    | "confirmPhoneVerification"
  > = {
    phoneVerificationPolicy: async () => ({
      phoneVerification: "required" as const,
      giftAmountMicros: 500_000_000 as const,
      giftStatus: "eligible" as const,
      deliveryProvider: "prosto_sms" as const,
    }),
    beginPhoneVerification: async (
      ...args: [string, "sms_ru" | "prosto_sms"]
    ) => {
      calls.push(["start", ...args]);
      return challenge;
    },
    resendPhoneVerification: async (
      ...args: [string, string, string, "sms_ru" | "prosto_sms"]
    ) => {
      calls.push(["resend", ...args]);
      return challenge;
    },
    confirmPhoneVerification: async (
      ...args: [string, string, string, string]
    ) => {
      calls.push(["confirm", ...args]);
      return receipt;
    },
  };
  let granted = 0,
    denied = 0;
  const resource = createPhoneVerificationResource({
    client,
    sessionSignal: owner.signal,
    publish: (state) => states.push(state),
    now: () => time,
    onGranted: () => {
      granted++;
    },
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
      time += ms;
    },
    granted: () => granted,
    denied: () => denied,
  };
}

test("normalization accepts only Russian mobiles and masking never exposes the full number", () => {
  for (const raw of [
    phone,
    "8 (999) 000-00-00",
    "79990000000",
    "+7 999 000 00 00",
  ])
    assert.equal(normalizePhone(raw), phone);
  for (const raw of [
    "+77010000000",
    "+74991234567",
    "phone",
    "",
    "+79990000000,+79990000001",
  ])
    assert.equal(normalizePhone(raw), null);
  assert.equal(maskPhone(phone), "+7 ••• •••-00-00");
  assert.equal(maskPhone("invalid"), "");
  assert.equal(phoneDeliveryLabel("prosto_sms"), "ProstoSMS");
  assert.equal(phoneDeliveryLabel("sms_ru"), "SMS.ru");
  assert.equal(phoneDeliveryLabel("none"), null);
  assert.equal(isPhoneCode("012345"), true);
  for (const code of ["12345", "1234567", " 123456", "١٢٣٤٥٦", "abc123"])
    assert.equal(isPhoneCode(code), false);
});

test("policy loads without sending; consent and a valid number are required before one explicit SMS", async () => {
  const s = setup();
  await s.resource.load();
  assert.equal(s.last().phase, "ready");
  assert.deepEqual(s.calls, []);
  await s.resource.start(phone, false);
  assert.match(s.last().error, /согласие.*ProstoSMS/);
  assert.equal(s.last().error.includes("SMS.ru"), false);
  await s.resource.start("+77010000000", true);
  assert.deepEqual(s.calls, []);
  await s.resource.start("8 (999) 000-00-00", true);
  assert.deepEqual(s.calls, [["start", phone, "prosto_sms"]]);
  assert.equal(s.last().receipt, null);
  assert.equal(s.granted(), 0);
  const projection = JSON.stringify(s.states);
  assert.equal(projection.includes(phone), false);
  assert.equal(projection.includes(challenge.proof), false);
  assert.equal(projection.includes(challenge.challengeId), false);
  s.resource.dispose();
});

test("disabled, unavailable, email-required and prior gift policies cannot send or claim", async () => {
  for (const [mode, status, expected] of [
    ["disabled", "unavailable", "disabled"],
    ["unavailable", "unavailable", "unavailable"],
    ["required", "email_required", "email-required"],
    ["required", "granted", "already-granted"],
    ["required", "unavailable", "unavailable"],
  ] as const) {
    const s = setup();
    s.client.phoneVerificationPolicy = async () => ({
      phoneVerification: mode,
      giftStatus: status,
      deliveryProvider: mode === "disabled" ? "none" : "prosto_sms",
      giftAmountMicros: 500_000_000,
    });
    await s.resource.load();
    assert.equal(s.last().phase, expected);
    await s.resource.start(phone, true);
    await s.resource.confirm("012345");
    assert.deepEqual(s.calls, []);
    assert.equal(s.granted(), 0);
    s.resource.dispose();
  }
});

test("resend needs an explicit action after cooldown and preserves the private challenge", async () => {
  const s = setup();
  await s.resource.load();
  await s.resource.start(phone, true);
  await s.resource.resend(true);
  assert.equal(s.calls.length, 1);
  s.advance();
  assert.equal(s.calls.length, 1);
  await s.resource.resend(false);
  assert.equal(s.calls.length, 1);
  await s.resource.resend(true);
  assert.deepEqual(s.calls.at(-1), [
    "resend",
    challenge.challengeId,
    challenge.proof,
    phone,
    "prosto_sms",
  ]);
  s.resource.dispose();
});

test("wrong code does not grant; only strict confirmed receipt refreshes the balance once", async () => {
  const s = setup();
  await s.resource.load();
  await s.resource.start(phone, true);
  s.client.confirmPhoneVerification = async () => {
    throw new ApiError(400, "SYNTHETIC_SECRET_DO_NOT_RENDER");
  };
  await s.resource.confirm("000000");
  assert.equal(s.last().phase, "ready");
  assert.equal(s.granted(), 0);
  assert.equal(s.last().error.includes("SYNTHETIC"), false);
  s.client.confirmPhoneVerification = async () => receipt;
  await s.resource.confirm("012345");
  assert.equal(s.last().phase, "confirmed");
  assert.equal(s.last().challenge, null);
  assert.deepEqual(s.last().receipt, receipt);
  assert.equal(s.granted(), 1);
  await s.resource.confirm("012345");
  assert.equal(s.granted(), 1);
  s.resource.dispose();
});

test("a provider delivery result, wrong amount or extra fields can never be displayed as a grant", async () => {
  for (const raw of [
    { accepted: true, mode: "live", simulated: false },
    { ...receipt, grantedMicros: 501_000_000 },
    { ...receipt, token: "synthetic" },
  ]) {
    const s = setup();
    await s.resource.load();
    await s.resource.start(phone, true);
    s.client.confirmPhoneVerification = async () => raw as typeof receipt;
    await s.resource.confirm("012345");
    assert.equal(s.last().phase, "ready");
    assert.equal(s.last().receipt, null);
    assert.equal(s.granted(), 0);
    s.resource.dispose();
  }
});

test("unknown send outcome stays throttled with no automatic resend or invented challenge", async () => {
  const s = setup();
  await s.resource.load();
  s.client.beginPhoneVerification = async () => {
    s.calls.push(["start"]);
    throw new ApiError(0, "synthetic", "timeout");
  };
  await s.resource.start(phone, true);
  assert.equal(s.last().challenge, null);
  assert.equal(s.last().receipt, null);
  await s.resource.start(phone, true);
  assert.equal(s.calls.length, 1);
  s.advance(120_000);
  assert.equal(s.calls.length, 1);
  assert.match(s.last().error, /только по вашему действию/);
  s.resource.dispose();
});

test("concurrent button actions cannot duplicate an SMS and expired code cannot confirm/resend", async () => {
  const s = setup();
  const delayed = deferred<typeof challenge>();
  const started = deferred<void>();
  s.client.beginPhoneVerification = async () => {
    s.calls.push(["start"]);
    started.resolve();
    return delayed.promise;
  };
  await s.resource.load();
  const first = s.resource.start(phone, true);
  await s.resource.start(phone, true);
  await started.promise;
  assert.equal(s.calls.length, 1);
  delayed.resolve({ ...challenge, expiresAt: "2026-10-24T00:00:01Z" });
  await first;
  s.advance();
  await s.resource.confirm("012345");
  await s.resource.resend(true);
  assert.equal(s.calls.length, 1);
  s.resource.reset();
  assert.equal(s.last().challenge, null);
  s.resource.dispose();
});

test("owner abort and unmount discard capabilities; late replies cannot restore UI or gift", async () => {
  for (const action of ["start", "confirm"] as const) {
    const s = setup();
    await s.resource.load();
    if (action === "confirm") await s.resource.start(phone, true);
    const delayed = deferred<typeof challenge & typeof receipt>();
    const entered = deferred<void>();
    if (action === "start")
      s.client.beginPhoneVerification = async () => {
        entered.resolve();
        return delayed.promise;
      };
    else
      s.client.confirmPhoneVerification = async () => {
        entered.resolve();
        return delayed.promise;
      };
    const running =
      action === "start"
        ? s.resource.start(phone, true)
        : s.resource.confirm("012345");
    await entered.promise;
    s.owner.abort();
    assert.equal(s.last().phase, "closed");
    delayed.resolve({ ...challenge, ...receipt });
    await running;
    assert.equal(s.last().phase, "closed");
    assert.equal(s.granted(), 0);
    assert.equal(s.denied(), 0);
    s.resource.dispose();
  }
  const s = setup();
  await s.resource.load();
  const delayed = deferred<typeof challenge>();
  s.client.beginPhoneVerification = async () => delayed.promise;
  const running = s.resource.start(phone, true);
  s.resource.dispose();
  const count = s.states.length;
  delayed.resolve(challenge);
  await running;
  assert.equal(s.states.length, count);
});

test("current-session401 closes the panel and invalidates auth, old failures cannot", async () => {
  const s = setup();
  await s.resource.load();
  s.client.beginPhoneVerification = async () => {
    throw new ApiError(401, "synthetic");
  };
  await s.resource.start(phone, true);
  assert.equal(s.last().phase, "closed");
  assert.equal(s.denied(), 1);
  s.resource.dispose();
});

test("a confirmation conflict clears the capability and permits explicit status reconciliation without another SMS", async () => {
  const s = setup();
  await s.resource.load();
  await s.resource.start(phone, true);
  s.client.confirmPhoneVerification = async () => {
    throw new ApiError(409, "synthetic conflict");
  };
  await s.resource.confirm("012345");
  assert.equal(s.last().phase, "unavailable");
  assert.equal(s.last().challenge, null);
  assert.equal(s.last().receipt, null);
  s.client.phoneVerificationPolicy = async () => ({
    phoneVerification: "required",
    giftAmountMicros: 500_000_000,
    giftStatus: "granted",
    deliveryProvider: "prosto_sms",
  });
  await s.resource.load();
  assert.equal(s.last().phase, "already-granted");
  assert.deepEqual(s.calls, [["start", phone, "prosto_sms"]]);
  assert.equal(s.granted(), 0);
  s.resource.dispose();
});

test("provider changes before start, resend or confirm require fresh consent and discard the old capability without writing", async () => {
  for (const action of ["start", "resend", "confirm"] as const) {
    const s = setup();
    await s.resource.load();
    if (action !== "start") {
      await s.resource.start(phone, true);
      s.advance();
    }
    const before = s.calls.length;
    s.client.phoneVerificationPolicy = async () => ({
      phoneVerification: "required",
      giftAmountMicros: 500_000_000,
      giftStatus: "eligible",
      deliveryProvider: "sms_ru",
    });
    if (action === "start") await s.resource.start(phone, true);
    else if (action === "resend") await s.resource.resend(true);
    else await s.resource.confirm("012345");
    assert.equal(s.last().deliveryProvider, "sms_ru");
    assert.equal(s.last().phase, "ready");
    assert.equal(s.last().challenge, null);
    assert.match(s.last().error, /согласие заново/);
    assert.equal(s.calls.length, before);
    assert.equal(s.granted(), 0);
    s.resource.dispose();
  }
});

test("fresh granted policy suppresses confirmation replay and disabled/failed policy never sends a number", async () => {
  const s = setup();
  await s.resource.load();
  await s.resource.start(phone, true);
  s.client.phoneVerificationPolicy = async () => ({
    phoneVerification: "required",
    giftAmountMicros: 500_000_000,
    giftStatus: "granted",
    deliveryProvider: "prosto_sms",
  });
  await s.resource.confirm("012345");
  assert.equal(s.last().phase, "already-granted");
  assert.equal(s.granted(), 0);
  assert.deepEqual(s.calls, [["start", phone, "prosto_sms"]]);
  s.resource.dispose();
  for (const unavailable of [false, true]) {
    const x = setup();
    await x.resource.load();
    x.client.phoneVerificationPolicy = async () => {
      if (unavailable) throw new Error("synthetic network failure");
      return {
        phoneVerification: "disabled",
        giftAmountMicros: 500_000_000,
        giftStatus: "unavailable",
        deliveryProvider: "none",
      };
    };
    await x.resource.start(phone, true);
    assert.deepEqual(x.calls, []);
    assert.equal(x.granted(), 0);
    x.resource.dispose();
  }
});

test("none or unsupported provider policies fail closed before consent or phone writes", async () => {
  for (const deliveryProvider of ["none", "unsupported", undefined]) {
    const s = setup();
    s.client.phoneVerificationPolicy = async () =>
      ({
        phoneVerification: "required",
        giftAmountMicros: 500_000_000,
        giftStatus: "eligible",
        deliveryProvider,
      }) as Awaited<ReturnType<typeof s.client.phoneVerificationPolicy>>;
    await s.resource.load();
    assert.equal(s.last().phase, "unavailable");
    await s.resource.start(phone, true);
    assert.deepEqual(s.calls, []);
    assert.equal(s.granted(), 0);
    s.resource.dispose();
  }
});

test("send conflict discards capability without implying a used gift and allows only status reconciliation", async () => {
  const s = setup();
  await s.resource.load();
  s.client.beginPhoneVerification = async () => {
    s.calls.push(["start"]);
    throw new ApiError(409, "synthetic provider conflict");
  };
  await s.resource.start(phone, true);
  assert.equal(s.last().phase, "unavailable");
  assert.equal(s.last().challenge, null);
  assert.match(s.last().error, /Условия отправки SMS изменились/);
  assert.equal(s.last().error.includes("подарок уже"), false);
  await s.resource.load();
  assert.equal(s.last().phase, "ready");
  assert.equal(s.calls.length, 1);
  assert.equal(s.granted(), 0);
  s.resource.dispose();
});
