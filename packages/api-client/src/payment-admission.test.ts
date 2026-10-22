import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, createClient, createSessionGuard } from "./index.js";
import type { PaymentAdmissionCommand } from "@citygo/contracts";

const requestId = "c2529a6e-c322-4b84-a4fd-6056e0ab5e28";
const status = {
  revision: 1,
  acceptingNewCheckouts: false,
  reconciliationEnabled: false,
  mode: "closed",
  ownerUserId: null,
  leaseUntil: null,
  manualNpdResponsibilityAccepted: false,
  reconciliationCheckedAt: null,
  reconciliationOk: false,
  runtimeBindingMatches: false,
  available: false,
  reason: "closed",
  npdBacklog: {
    pendingRegistration: 0,
    pendingDelivery: 0,
    requiredCorrection: 0,
    review: 0,
    total: 0,
    oldestObservedAt: null,
  },
} as const;

test("payment admission uses strict admin and owner endpoints, credentials and single CAS commands", async () => {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const client = createClient("/api", {
    fetch: async (url, init) => {
      assert.equal(init?.credentials, "include");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url: String(url), method: init?.method ?? "GET", body });
      return Response.json(
        String(url).endsWith("/availability")
          ? { available: false }
          : { ...status, revision: body ? body.expectedRevision + 1 : 1 },
      );
    },
  });
  await client.paymentAdmission();
  assert.deepEqual(await client.paymentAvailability(), { available: false });
  const commands: PaymentAdmissionCommand[] = [
    { action: "close", requestId, expectedRevision: 1 },
    {
      action: "set_reconciliation",
      enabled: true,
      requestId,
      expectedRevision: 2,
    },
    {
      action: "open",
      mode: "continuous",
      manualNpdResponsibilityAccepted: true,
      requestId,
      expectedRevision: 3,
    },
  ];
  for (const command of commands) await client.commandPaymentAdmission(command);
  assert.deepEqual(requests, [
    { url: "/api/v1/admin/payments/admission", method: "GET", body: undefined },
    { url: "/api/v1/payments/availability", method: "GET", body: undefined },
    ...commands.map((body) => ({
      url: "/api/v1/admin/payments/admission/commands",
      method: "POST",
      body,
    })),
  ]);
});

test("admission rejects extra binding/health fields, missing responsibility and invalid CAS before fetch", async () => {
  let calls = 0;
  const client = createClient("/api", {
    fetch: async () => {
      calls++;
      return Response.json(status);
    },
  });
  const command = { action: "close", requestId, expectedRevision: 1 };
  for (const input of [
    { ...command, expectedRevision: 0 },
    { ...command, requestId: "private-person@example.test" },
    { ...command, merchantId: "private-person@example.test" },
    { ...command, reconciliationOk: true },
    { ...command, reconciliationCheckedAt: "2026-10-19T10:00:00.000Z" },
    { ...command, runtimeBindingMatches: true },
    { ...command, action: "open", mode: "continuous" },
    {
      ...command,
      action: "open",
      mode: "continuous",
      manualNpdResponsibilityAccepted: false,
    },
  ])
    await assert.rejects(
      client.commandPaymentAdmission(input as PaymentAdmissionCommand),
      (error: Error) =>
        /Некорректная команда/.test(error.message) &&
        !error.message.includes("private-person"),
    );
  assert.equal(calls, 0);
});

test("admission response validates the complete strict status and rejects unsafe owner projections", async () => {
  for (const body of [
    { ...status, reason: "made_up" },
    { ...status, revision: "1" },
    { ...status, available: "false" },
    { ...status, npdBacklog: { ...status.npdBacklog, total: -1 } },
    { ...status, merchantSecret: "not-to-be-shown" },
    { available: false },
  ]) {
    const client = createClient("/api", {
      fetch: async () => Response.json(body),
    });
    await assert.rejects(
      client.paymentAdmission(),
      (error: unknown) =>
        error instanceof ApiError && error.code === "invalid_response",
    );
  }
  for (const body of [
    status,
    { available: false, npdBacklog: status.npdBacklog },
    { available: true, ownerUserId: "1" },
    { available: "true" },
  ]) {
    const client = createClient("/api", {
      fetch: async () => Response.json(body),
    });
    await assert.rejects(client.paymentAvailability(), /не соответствует/);
  }
});

test("admission rejects a command result without a newer revision, but accepts an idempotent later revision", async () => {
  for (const revision of [1, 0]) {
    const client = createClient("/api", {
      fetch: async () => Response.json({ ...status, revision }),
    });
    await assert.rejects(
      client.commandPaymentAdmission({
        action: "close",
        requestId,
        expectedRevision: 1,
      }),
      (error: unknown) =>
        error instanceof ApiError && error.code === "invalid_response",
    );
  }
  const client = createClient("/api", {
    fetch: async () => Response.json({ ...status, revision: 9 }),
  });
  assert.equal(
    (
      await client.commandPaymentAdmission({
        action: "close",
        requestId,
        expectedRevision: 1,
      })
    ).revision,
    9,
  );
});

test("admission 401/403/409 and network errors do not retry a command", async () => {
  for (const status of [401, 403, 409, "network"] as const) {
    let calls = 0;
    let unauthorized = 0;
    const client = createClient("/api", {
      onUnauthorized: () => unauthorized++,
      fetch: async () => {
        calls++;
        if (status === "network") throw new TypeError("network unavailable");
        return Response.json({ error: "Обновите состояние" }, { status });
      },
    });
    await assert.rejects(
      client.commandPaymentAdmission({
        action: "close",
        requestId,
        expectedRevision: 1,
      }),
    );
    assert.equal(calls, 1);
    assert.equal(unauthorized, status === 401 ? 1 : 0);
  }
});

test("late admission GET/POST cannot expose prior session status or expire the next session", async () => {
  for (const kind of ["get", "post"] as const) {
    for (const code of [200, 401, 403]) {
      const session = createSessionGuard();
      let done!: (response: Response) => void;
      let expired = 0;
      const client = createClient("/api", {
        signal: () => session.capture().signal,
        onUnauthorized: () => expired++,
        fetch: () =>
          new Promise((resolve) => {
            done = resolve;
          }),
      });
      const pending =
        kind === "get"
          ? client.paymentAdmission()
          : client.commandPaymentAdmission({
              action: "close",
              requestId,
              expectedRevision: 1,
            });
      const rejected = assert.rejects(pending, /прежней сессии/);
      session.reset();
      done(Response.json({ ...status, revision: 2 }, { status: code }));
      await rejected;
      assert.equal(expired, 0);
    }
  }
});

test("owner availability is refreshed, never cached as permission to pay", async () => {
  let calls = 0;
  const client = createClient("/api", {
    fetch: async () => Response.json({ available: calls++ === 0 }),
  });
  assert.deepEqual(await client.paymentAvailability(), { available: true });
  assert.deepEqual(await client.paymentAvailability(), { available: false });
  assert.equal(calls, 2);
});
