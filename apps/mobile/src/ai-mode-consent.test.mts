import assert from "node:assert/strict";
import test from "node:test";
import { createSessionGuard, type AiModeConsentView } from "@citygo/api-client";
import {
  aiModeIds,
  aiModeLabels,
  serviceConsentPolicy,
  type AiModeId,
  type Dashboard,
  type ServiceConsentState,
} from "@citygo/contracts";
import { createMobileAiModeConsent } from "./ai-mode-consent.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const policy = {
  ...serviceConsentPolicy,
  version: "synthetic-native-modes-v1",
  aiProcessing: {
    id: "a".repeat(64),
    version: "synthetic-modes",
    provider: "routerai" as const,
    model: "synthetic/modes",
    recipient: "Synthetic recipients",
    routing: "Synthetic route",
    data: "Synthetic context",
  },
};
const state = (required = true): ServiceConsentState => ({
  policy,
  personalDataGranted: true,
  marketingGranted: true,
  serviceConsentRequired: false,
  currentAiConsentRequired: required,
});
function board(required = false): Dashboard {
  return {
    user: {
      id: "1",
      email: "synthetic@example.test",
      serviceConsentRequired: false,
    },
    profile: null,
    quests: [],
    xp: 0,
    thread: null,
    provider: "unconfigured",
    aiAccess: {
      granted: true,
      dailyLimit: 0,
      policy: null,
      modes: {
        catalogId: "b".repeat(64),
        defaultMode: "balanced",
        options: aiModeIds.map((id) => ({
          id,
          label: aiModeLabels[id],
          available: true,
          consentRequired: required && id !== "balanced",
        })),
      },
    },
  };
}
function setup(
  changes: {
    load?: () => Promise<Response>;
    save?: () => Promise<Response>;
    owner?: () => Dashboard;
    refresh?: () => Promise<Dashboard | undefined>;
  } = {},
) {
  const session = createSessionGuard();
  session.reset("1");
  const requests: { path: string; method: string; body?: unknown }[] = [];
  const views: AiModeConsentView[] = [];
  let selected: AiModeId = "balanced";
  let denied = 0;
  const resource = createMobileAiModeConsent({
    base: "https://synthetic.invalid",
    token: "synthetic-native-credential",
    userId: "1",
    ticket: session.capture(),
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get("Authorization"),
        "Bearer synthetic-native-credential",
      );
      assert.equal(headers.get("X-CityGo-Client"), "native");
      const path = new URL(String(url)).pathname;
      requests.push({
        path,
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (path === "/v1/account/consents")
        return changes.load ? changes.load() : Response.json(state());
      if (path === "/v1/dashboard")
        return Response.json(changes.owner?.() ?? board(true));
      if (path === "/v1/account/ai-modes-consent")
        return changes.save ? changes.save() : Response.json(state(false));
      assert.fail("Unexpected native request: " + path);
    },
    refresh: changes.refresh ?? (async () => board()),
    select: (mode) => {
      selected = mode;
    },
    publish: (view) => views.push(view),
    onAccessDenied: () => {
      denied++;
    },
  });
  return {
    resource,
    session,
    requests,
    views,
    selected: () => selected,
    denied: () => denied,
  };
}

test("native confirms one explicit choice with the pinned credential and waits for the fresh catalog", async () => {
  const refreshed = deferred<Dashboard>();
  const refreshing = deferred<void>();
  const f = setup({
    refresh: () => {
      refreshing.resolve();
      return refreshed.promise;
    },
  });
  await f.resource.open("maximum");
  assert.equal(f.selected(), "balanced");
  await f.resource.confirm(false);
  assert.equal(f.requests.length, 1);
  const work = f.resource.confirm(true);
  await f.resource.confirm(true);
  await refreshing.promise;
  assert.equal(f.selected(), "balanced");
  assert.deepEqual(f.requests, [
    { path: "/v1/account/consents", method: "GET" },
    { path: "/v1/dashboard", method: "GET" },
    {
      path: "/v1/account/ai-modes-consent",
      method: "POST",
      body: {
        expectedUserId: "1",
        policyVersion: policy.version,
        policyId: policy.aiProcessing.id,
        personalData: true,
      },
    },
  ]);
  refreshed.resolve(board());
  await work;
  assert.equal(f.selected(), "maximum");
  assert.equal(f.views.at(-1)?.phase, "closed");
  f.resource.dispose();
});

test("native current registration grant selects without another POST", async () => {
  const f = setup({ load: async () => Response.json(state(false)) });
  await f.resource.open("minimum");
  assert.equal(f.selected(), "minimum");
  assert.equal(
    f.requests.some((request) => request.method === "POST"),
    false,
  );
  f.resource.dispose();
});

test("cancel during the final dashboard refresh cannot select a mode after its late success", async () => {
  const pending = deferred<Dashboard>();
  const refreshing = deferred<void>();
  const f = setup({
    refresh: () => {
      refreshing.resolve();
      return pending.promise;
    },
  });
  await f.resource.open("minimum");
  const work = f.resource.confirm(true);
  await refreshing.promise;
  f.resource.cancel();
  pending.resolve(board());
  await work;
  assert.equal(f.selected(), "balanced");
  assert.equal(f.views.at(-1)?.phase, "closed");
  f.resource.dispose();
});

test("cancelled load/save and session replacement ignore delayed success or denial", async () => {
  for (const phase of ["load", "save"] as const) {
    const pending = deferred<Response>();
    const started = deferred<void>();
    const f = setup({
      [phase]: () => {
        started.resolve();
        return pending.promise;
      },
    });
    const opening = f.resource.open("minimum");
    const work =
      phase === "load" ? opening : (await opening, f.resource.confirm(true));
    await started.promise;
    f.resource.cancel();
    f.session.reset("2");
    pending.resolve(Response.json({ error: "Old account" }, { status: 401 }));
    await work;
    assert.equal(f.selected(), "balanced");
    assert.equal(f.denied(), 0);
    assert.equal(f.views.at(-1)?.phase, "closed");
    f.resource.dispose();
  }
});

test("owner preflight prevents an old account's confirmation POST", async () => {
  const f = setup({
    owner: () => ({
      ...board(),
      user: { id: "2", email: "other@example.test" },
    }),
  });
  await f.resource.open("maximum");
  await f.resource.confirm(true);
  assert.equal(f.selected(), "balanced");
  assert.equal(
    f.requests.some((request) => request.method === "POST"),
    false,
  );
  f.resource.dispose();
});

test("native preflight refuses a revoked base consent or mandatory password change before POST", async () => {
  for (const user of [
    { ...board().user, serviceConsentRequired: true },
    { ...board().user, mustChangePassword: true },
  ]) {
    const f = setup({ owner: () => ({ ...board(), user }) });
    await f.resource.open("maximum");
    await f.resource.confirm(true);
    assert.equal(f.selected(), "balanced");
    assert.equal(
      f.requests.some((request) => request.method === "POST"),
      false,
    );
    f.resource.dispose();
  }
});

test("unconfirmed, blocked or superseded refreshed catalogs cannot select the new mode", async () => {
  const unavailable = board();
  unavailable.aiAccess.modes!.options[0]!.available = false;
  const absent = board();
  delete absent.aiAccess.modes;
  for (const current of [
    undefined,
    absent,
    unavailable,
    board(true),
    { ...board(), user: { ...board().user, id: "2" } },
    { ...board(), user: { ...board().user, mustChangePassword: true } },
    { ...board(), user: { ...board().user, serviceConsentRequired: true } },
  ]) {
    const f = setup({ refresh: async () => current });
    await f.resource.open("maximum");
    await f.resource.confirm(true);
    assert.equal(f.selected(), "balanced");
    assert.equal(f.views.at(-1)?.phase, "error");
    f.resource.dispose();
  }
});

test("policy conflict does not replay POST; explicit retry reloads before a new checkbox choice", async () => {
  let saves = 0;
  const f = setup({
    save: async () => {
      saves++;
      return saves === 1
        ? Response.json({ error: "PRIVATE_POLICY_DETAILS" }, { status: 409 })
        : Response.json(state(false));
    },
  });
  await f.resource.open("maximum");
  await f.resource.confirm(true);
  assert.equal(saves, 1);
  assert.equal(f.views.at(-1)?.phase, "error");
  assert.doesNotMatch(JSON.stringify(f.views), /PRIVATE_POLICY_DETAILS/);
  await f.resource.confirm(true);
  assert.equal(saves, 1);
  await f.resource.open("maximum");
  await f.resource.confirm(false);
  assert.equal(saves, 1);
  await f.resource.confirm(true);
  assert.equal(f.selected(), "maximum");
  assert.equal(saves, 2);
  f.resource.dispose();
});
