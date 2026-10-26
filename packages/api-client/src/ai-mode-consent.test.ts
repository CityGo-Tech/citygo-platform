import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./transport.js";
import { createSessionGuard } from "./session.js";
import {
  serviceConsentPolicy,
  type AiModeId,
  type ServiceConsentState,
} from "@citygo/contracts";
import {
  createAiModeConsentResource,
  type AiModeConsentChoice,
  type AiModeConsentView,
} from "./ai-mode-consent.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const policy = {
  ...serviceConsentPolicy,
  version: "synthetic-new-modes-v1",
  aiProcessing: {
    id: "a".repeat(64),
    version: "synthetic-modes",
    provider: "routerai" as const,
    model: "synthetic/modes",
    recipient: "Synthetic current recipients",
    routing: "Synthetic route",
    data: "Synthetic shared conversation",
  },
};
const state = (currentAiConsentRequired = true): ServiceConsentState => ({
  policy,
  personalDataGranted: true,
  marketingGranted: false,
  serviceConsentRequired: false,
  currentAiConsentRequired,
});
function setup(
  changes: Partial<Parameters<typeof createAiModeConsentResource>[0]> = {},
) {
  const session = createSessionGuard();
  session.reset("101");
  const views: AiModeConsentView[] = [];
  const saves: AiModeConsentChoice[] = [];
  const selected: AiModeId[] = [];
  let denied = 0;
  let baseRequired = 0;
  const resource = createAiModeConsentResource({
    userId: "101",
    sessionSignal: session.capture().signal,
    load: async () => state(),
    save: async (choice) => {
      saves.push(choice);
      return state(false);
    },
    verifyOwner: async () => true,
    onConfirmed: async (mode) => {
      selected.push(mode);
    },
    onBaseConsentRequired: async () => {
      baseRequired++;
    },
    onAccessDenied: () => {
      denied++;
    },
    publish: (view) => views.push(view),
    ...changes,
  });
  return {
    session,
    resource,
    views,
    saves,
    selected,
    denied: () => denied,
    baseRequired: () => baseRequired,
  };
}

test("choosing a new mode only loads a current snapshot; unchecked choice never saves or selects", async () => {
  const f = setup();
  await f.resource.open("maximum");
  assert.equal(f.views.at(-1)?.phase, "ready");
  await f.resource.confirm(false);
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.selected, []);
  f.resource.cancel();
  assert.equal(f.views.at(-1)?.phase, "closed");
  assert.deepEqual(f.selected, []);
  f.resource.dispose();
});

test("explicit confirmation binds account and exact policy, never marketing, and waits for persistence", async () => {
  const saved = deferred<ServiceConsentState>();
  const saves: AiModeConsentChoice[] = [];
  const f = setup({
    save: async (choice) => {
      saves.push(choice);
      return saved.promise;
    },
  });
  await f.resource.open("minimum");
  const first = f.resource.confirm(true);
  await Promise.resolve();
  const duplicate = f.resource.confirm(true);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0], {
    expectedUserId: "101",
    policyVersion: policy.version,
    policyId: policy.aiProcessing.id,
    personalData: true,
  });
  assert.deepEqual(f.selected, []);
  saved.resolve(state(false));
  await Promise.all([first, duplicate]);
  assert.deepEqual(f.selected, ["minimum"]);
  assert.equal(f.views.at(-1)?.phase, "closed");
  f.resource.dispose();
});

test("current registration/current grant selects without another confirmation POST", async () => {
  const f = setup({ load: async () => state(false) });
  await f.resource.open("maximum");
  assert.deepEqual(f.selected, ["maximum"]);
  assert.deepEqual(f.saves, []);
  assert.equal(
    f.views.some((view) => view.phase === "ready"),
    false,
  );
  f.resource.dispose();
});

test("an old server without an explicit current-grant flag cannot widen consent", async () => {
  const f = setup({
    load: async () => ({ ...state(), currentAiConsentRequired: undefined }),
  });
  await f.resource.open("maximum");
  assert.equal(f.views.at(-1)?.phase, "error");
  assert.deepEqual(f.selected, []);
  assert.deepEqual(f.saves, []);
  f.resource.dispose();
});

test("a cancelled delayed load or stale denial cannot reopen the modal or revoke another session", async () => {
  const pending = deferred<ServiceConsentState>();
  let requestSignal: AbortSignal | undefined;
  const f = setup({
    load: async (signal) => {
      requestSignal = signal;
      return pending.promise;
    },
  });
  const work = f.resource.open("maximum");
  f.resource.cancel();
  assert.equal(requestSignal?.aborted, true);
  pending.reject(new ApiError(401, "Old account"));
  await work;
  assert.equal(f.views.at(-1)?.phase, "closed");
  assert.equal(f.denied(), 0);
  assert.deepEqual(f.selected, []);
  f.resource.dispose();
});

test("a later mode choice owns its snapshot; a late earlier snapshot cannot replace it", async () => {
  const first = deferred<ServiceConsentState>();
  let loads = 0;
  const f = setup({
    load: async () => (++loads === 1 ? first.promise : state()),
  });
  const old = f.resource.open("maximum");
  await f.resource.open("minimum");
  first.resolve(state(false));
  await old;
  const latest = f.views.at(-1);
  assert.equal(latest?.phase, "ready");
  assert.equal(latest && "mode" in latest && latest.mode, "minimum");
  assert.deepEqual(f.selected, []);
  f.resource.dispose();
});

test("cancelling an in-flight save never selects a mode after its late success", async () => {
  const pending = deferred<ServiceConsentState>();
  const f = setup({ save: async () => pending.promise });
  await f.resource.open("maximum");
  const work = f.resource.confirm(true);
  await Promise.resolve();
  f.resource.cancel();
  pending.resolve(state(false));
  await work;
  assert.deepEqual(f.selected, []);
  assert.equal(f.views.at(-1)?.phase, "closed");
  f.resource.dispose();
});

test("cross-tab/account session rotation aborts old work including late failure", async () => {
  const pending = deferred<ServiceConsentState>();
  const f = setup({ save: async () => pending.promise });
  await f.resource.open("minimum");
  const work = f.resource.confirm(true);
  await Promise.resolve();
  f.session.reset("202");
  pending.reject(new ApiError(401, "Old authorization"));
  await work;
  assert.deepEqual(f.selected, []);
  assert.equal(f.denied(), 0);
  assert.equal(f.views.at(-1)?.phase, "closed");
  f.resource.dispose();
});

test("an owner mismatch refuses the consent POST", async () => {
  const f = setup({ verifyOwner: async () => false });
  await f.resource.open("maximum");
  await f.resource.confirm(true);
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.selected, []);
  assert.equal(f.views.at(-1)?.phase, "closed");
  f.resource.dispose();
});

test("revoked/no-base consent delegates to the global gate without widening a legacy grant", async () => {
  const f = setup({
    load: async () => ({ ...state(), serviceConsentRequired: true }),
  });
  await f.resource.open("maximum");
  assert.equal(f.baseRequired(), 1);
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.selected, []);
  f.resource.dispose();
});

test("failed loading and changed policy do not auto-retry or select", async () => {
  let loads = 0;
  const f = setup({
    load: async () => {
      loads++;
      throw new ApiError(503, "PRIVATE_PROVIDER_DETAILS");
    },
  });
  await f.resource.open("maximum");
  assert.equal(loads, 1);
  assert.equal(f.views.at(-1)?.phase, "error");
  assert.doesNotMatch(JSON.stringify(f.views), /PRIVATE_PROVIDER/);
  assert.deepEqual(f.selected, []);
  f.resource.dispose();
  const changed = setup({
    save: async () => ({
      ...state(false),
      policy: { ...policy, version: "next" },
    }),
  });
  await changed.resource.open("maximum");
  await changed.resource.confirm(true);
  assert.equal(changed.views.at(-1)?.phase, "error");
  assert.deepEqual(changed.selected, []);
  changed.resource.dispose();
});

test("selection and session cancellation work without native AbortSignal.any support", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
  Object.defineProperty(AbortSignal, "any", {
    value: undefined,
    configurable: true,
  });
  try {
    const pending = deferred<ServiceConsentState>();
    let requestSignal: AbortSignal | undefined;
    const f = setup({
      save: async (_choice, signal) => {
        requestSignal = signal;
        return pending.promise;
      },
    });
    await f.resource.open("minimum");
    const work = f.resource.confirm(true);
    await Promise.resolve();
    f.session.reset("202");
    assert.equal(requestSignal?.aborted, true);
    pending.resolve(state(false));
    await work;
    assert.deepEqual(f.selected, []);
    assert.equal(f.views.at(-1)?.phase, "closed");
    f.resource.dispose();
  } finally {
    Object.defineProperty(AbortSignal, "any", descriptor);
  }
});
