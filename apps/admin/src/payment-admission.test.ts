import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, createClient } from "@citygo/api-client";
import type { PaymentAdmissionStatus } from "@citygo/contracts";
import {
  createPaymentAdmissionPanel,
  paymentAdmissionCommandFor,
} from "./payment-admission.js";

const requestId = "c2529a6e-c322-4b84-a4fd-6056e0ab5e28";
const status: PaymentAdmissionStatus = {
  revision: 4,
  acceptingNewCheckouts: false,
  reconciliationEnabled: true,
  mode: "closed",
  ownerUserId: null,
  leaseUntil: null,
  manualNpdResponsibilityAccepted: false,
  reconciliationCheckedAt: "2026-10-19T10:00:00.000Z",
  reconciliationOk: true,
  runtimeBindingMatches: true,
  available: false,
  reason: "closed",
  npdBacklog: {
    pendingRegistration: 2,
    pendingDelivery: 3,
    requiredCorrection: 1,
    review: 1,
    total: 3,
    oldestObservedAt: "2026-10-18T10:00:00.000Z",
  },
};
type Api = ReturnType<typeof createClient>;
const dashboard: Awaited<ReturnType<Api["dashboard"]>> = {
  user: {
    id: "1",
    email: "synthetic@example.test",
    role: "super_admin",
    mustChangePassword: false,
  },
  profile: null,
  xp: 0,
  quests: [],
  thread: null,
  provider: "unconfigured",
  aiAccess: { policy: null, granted: false, dailyLimit: 0 },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
function setup(
  patch: Partial<
    Pick<Api, "dashboard" | "paymentAdmission" | "commandPaymentAdmission">
  > = {},
) {
  let denied = 0;
  let commands = 0;
  const panel = createPaymentAdmissionPanel(
    "1",
    () => denied++,
    () => ({
      dashboard: async () => dashboard,
      paymentAdmission: async () => status,
      commandPaymentAdmission: async () => {
        commands++;
        return { ...status, revision: 5 };
      },
      ...patch,
    }),
  );
  return { panel, denied: () => denied, commands: () => commands };
}

test("admission defaults to no data/commands; explicit GET load does not open payment", async () => {
  const { panel, commands } = setup();
  assert.deepEqual(panel.getSnapshot(), {
    status: null,
    busy: false,
    error: "",
    notice: "",
  });
  await panel.command({ action: "close" });
  assert.equal(commands(), 0);
  await panel.load();
  assert.equal(panel.getSnapshot().status?.revision, 4);
  assert.equal(panel.getSnapshot().status?.available, false);
  assert.equal(commands(), 0);
});

test("commands use exact loaded CAS revision and UUID; continuous mode requires explicit responsibility", () => {
  assert.throws(
    () =>
      paymentAdmissionCommandFor(
        status,
        { action: "open", manualNpdResponsibilityAccepted: false },
        requestId,
      ),
    /Не подтверждена/,
  );
  assert.throws(
    () => paymentAdmissionCommandFor(status, { action: "close" }, "not-a-uuid"),
    /Не подтверждена/,
  );
  assert.deepEqual(
    paymentAdmissionCommandFor(
      status,
      { action: "open", manualNpdResponsibilityAccepted: true },
      requestId,
    ),
    {
      action: "open",
      mode: "continuous",
      manualNpdResponsibilityAccepted: true,
      requestId,
      expectedRevision: 4,
    },
  );
  assert.deepEqual(
    paymentAdmissionCommandFor(
      status,
      { action: "set_reconciliation", enabled: false },
      requestId,
    ),
    {
      action: "set_reconciliation",
      enabled: false,
      requestId,
      expectedRevision: 4,
    },
  );
  assert.deepEqual(
    paymentAdmissionCommandFor(status, { action: "close" }, requestId),
    {
      action: "close",
      requestId,
      expectedRevision: 4,
    },
  );
});

test("admin, changed owner and mandatory password change are denied before status or POST", async () => {
  for (const user of [
    { ...dashboard.user, role: "admin" as const },
    { ...dashboard.user, id: "2" },
    { ...dashboard.user, mustChangePassword: true },
    { ...dashboard.user, mustChangePassword: undefined },
  ]) {
    let fetched = 0;
    const { panel, denied, commands } = setup({
      dashboard: async () => ({ ...dashboard, user }),
      paymentAdmission: async () => {
        fetched++;
        return status;
      },
    });
    await panel.load();
    assert.equal(denied(), 1);
    assert.equal(fetched, 0);
    assert.equal(panel.getSnapshot().status, null);
    await panel.command({
      action: "open",
      manualNpdResponsibilityAccepted: true,
    });
    assert.equal(commands(), 0);
  }
});

test("each command rechecks current super admin, not the old loaded identity", async () => {
  let checks = 0;
  let role: "super_admin" | "admin" = "super_admin";
  const { panel, denied, commands } = setup({
    dashboard: async () => {
      checks++;
      return { ...dashboard, user: { ...dashboard.user, role } };
    },
  });
  await panel.load();
  role = "admin";
  await panel.command({ action: "close" });
  assert.equal(checks, 3);
  assert.equal(denied(), 1);
  assert.equal(commands(), 0);
  assert.equal(panel.getSnapshot().status, null);
});

test("missing acknowledgement does not POST, and successful acknowledgement is not persisted in a browser command template", async () => {
  const seen: unknown[] = [];
  const { panel } = setup({
    commandPaymentAdmission: async (input) => {
      seen.push(input);
      return { ...status, revision: input.expectedRevision + 1 };
    },
  });
  await panel.load();
  await panel.command({
    action: "open",
    manualNpdResponsibilityAccepted: false,
  });
  assert.equal(seen.length, 0);
  await panel.command({
    action: "open",
    manualNpdResponsibilityAccepted: true,
  });
  assert.equal(seen.length, 1);
  const command = seen[0] as Record<string, unknown>;
  assert.equal(command.expectedRevision, 4);
  assert.match(String(command.requestId), /^[0-9a-f-]{36}$/);
  assert.equal(command.manualNpdResponsibilityAccepted, true);
  assert.equal(Object.hasOwn(command, "runtimeBindingMatches"), false);
  panel.invalidate();
  assert.equal(panel.getSnapshot().status, null);
  await panel.command({
    action: "open",
    manualNpdResponsibilityAccepted: true,
  });
  assert.equal(seen.length, 1);
});

test("logout/focus invalidation suppresses late GET/POST results even when a transport ignores abort", async () => {
  for (const operation of ["load", "command"] as const) {
    const response = deferred<PaymentAdmissionStatus>();
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { panel, denied } = setup({
      paymentAdmission: async () =>
        operation === "load" ? (entered(), response.promise) : status,
      commandPaymentAdmission: async () => {
        entered();
        return response.promise;
      },
    });
    if (operation === "command") await panel.load();
    const pending =
      operation === "load" ? panel.load() : panel.command({ action: "close" });
    await reached;
    panel.invalidate();
    response.resolve({ ...status, revision: 5, available: true, reason: null });
    await pending;
    assert.deepEqual(panel.getSnapshot(), {
      status: null,
      busy: false,
      error: "",
      notice: "",
    });
    assert.equal(denied(), 0);
  }
});

test("late denied response cannot clear or expire a newly loaded session", async () => {
  const late = deferred<PaymentAdmissionStatus>();
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let count = 0;
  const { panel, denied } = setup({
    paymentAdmission: async () => {
      if (count++ === 0) {
        entered();
        return late.promise;
      }
      return { ...status, revision: 9 };
    },
  });
  const old = panel.load();
  await reached;
  panel.invalidate();
  await panel.load();
  late.reject(new ApiError(403, "Доступ закрыт"));
  await old;
  assert.equal(panel.getSnapshot().status?.revision, 9);
  assert.equal(denied(), 0);
});

test("permission changes during GET or POST suppress the returned data even without a browser event", async () => {
  for (const operation of ["load", "command"] as const) {
    let role: "super_admin" | "admin" = "super_admin";
    const response = deferred<PaymentAdmissionStatus>();
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { panel, denied } = setup({
      dashboard: async () => ({
        ...dashboard,
        user: { ...dashboard.user, role },
      }),
      paymentAdmission: async () =>
        operation === "load" ? (entered(), response.promise) : status,
      commandPaymentAdmission: async () => {
        entered();
        return response.promise;
      },
    });
    if (operation === "command") await panel.load();
    const pending =
      operation === "load" ? panel.load() : panel.command({ action: "close" });
    await reached;
    role = "admin";
    response.resolve({ ...status, revision: 5 });
    await pending;
    assert.equal(panel.getSnapshot().status, null);
    assert.equal(denied(), 1);
  }
});

test("401/403 erase the panel and revoke local access; CAS or uncertain result requires a fresh GET without retry", async () => {
  for (const code of [401, 403, 409, 503]) {
    let calls = 0;
    const { panel, denied } = setup({
      commandPaymentAdmission: async () => {
        calls++;
        throw new ApiError(code, "Не подтверждено");
      },
    });
    await panel.load();
    await panel.command({ action: "close" });
    assert.equal(panel.getSnapshot().status, null);
    assert.equal(panel.getSnapshot().busy, false);
    assert.equal(denied(), code === 401 || code === 403 ? 1 : 0);
    if (code >= 409) assert.match(panel.getSnapshot().error, /Обновите/);
    await panel.command({ action: "close" });
    assert.equal(calls, 1);
  }
});

test("synchronous duplicate clicks cannot issue two POSTs; controls and loaded status are hidden while pending", async () => {
  const response = deferred<PaymentAdmissionStatus>();
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const { panel } = setup({
    commandPaymentAdmission: async () => {
      calls++;
      entered();
      return response.promise;
    },
  });
  await panel.load();
  const first = panel.command({ action: "close" });
  assert.equal(panel.getSnapshot().status, null);
  assert.equal(panel.getSnapshot().busy, true);
  await panel.command({ action: "close" });
  await panel.load();
  await reached;
  assert.equal(calls, 1);
  response.resolve({ ...status, revision: 5 });
  await first;
  assert.equal(panel.getSnapshot().status?.revision, 5);
  assert.equal(panel.getSnapshot().busy, false);
});

test("refresh failure hides old status and responsibility form without exposing transport details", async () => {
  let count = 0;
  const { panel } = setup({
    paymentAdmission: async () => {
      if (count++ === 0) return status;
      throw new Error("private-secret-not-to-display");
    },
  });
  await panel.load();
  await panel.load();
  assert.equal(panel.getSnapshot().status, null);
  assert.match(panel.getSnapshot().error, /Старые данные скрыты/);
  assert.ok(!panel.getSnapshot().error.includes("private-secret"));
});
