import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { customerInteractionNameSchema } from "@citygo/contracts";
import * as product from "./product-analytics";
import type { useProductAnalytics } from "./use-product-analytics";

// Evaluate the actual hook with deterministic React effect/ref lifetimes, DOM,
// identity API and downloaded SDK. No browser, provider or external network.
const compiled = ts.transpileModule(
  readFileSync(new URL("./use-product-analytics.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const id = "cga_" + "a".repeat(64);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Options = Parameters<typeof useProductAnalytics>[0];
function harness() {
  const commands: unknown[][] = [];
  const records: string[] = [];
  const timers: (() => void)[] = [];
  const scripts: {
    onload?: () => void;
    onerror?: () => void;
    remove(): void;
  }[] = [];
  const target = new EventTarget();
  const storage = new Map<string, string>();
  let refsIndex = 0;
  const refs: { current: unknown }[] = [];
  let effectsIndex = 0;
  const effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  const scheduled: (() => void)[] = [];
  const signal = new AbortController();
  let clock = Date.now();
  let masked = true;
  const win: {
    ym?: product.YandexMetrika;
    location: product.AnalyticsLocation;
    localStorage: {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
      removeItem(key: string): void;
    };
    addEventListener: EventTarget["addEventListener"];
    removeEventListener: EventTarget["removeEventListener"];
    dispatchEvent: EventTarget["dispatchEvent"];
  } = {
    location: {
      origin: "https://pilot.xn--c1ajazlh.xn--p1ai",
      pathname: "/",
      search: "",
      hash: "",
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  const doc = {
    referrer: "",
    querySelector: () => (masked ? {} : null),
    createElement: () => ({ remove() {} }),
    head: {
      append: (script: (typeof scripts)[number]) => {
        scripts.push(script);
      },
    },
  };
  const navigator = { doNotTrack: "0", globalPrivacyControl: false };
  const evaluatedModule = {
    exports: {} as { useProductAnalytics: typeof useProductAnalytics },
  };
  vm.runInNewContext(compiled, {
    module: evaluatedModule,
    exports: evaluatedModule.exports,
    window: win,
    document: doc,
    navigator,
    Event,
    Date: { now: () => clock },
    crypto: { randomUUID },
    setTimeout: (callback: () => void) => {
      timers.push(callback);
    },
    require(name: string) {
      if (name === "@citygo/contracts")
        return { customerInteractionNameSchema };
      if (name === "./product-analytics") return product;
      if (name === "react")
        return {
          useRef(value: unknown) {
            const index = refsIndex++;
            return (refs[index] ??= { current: value });
          },
          useEffect(callback: () => void | (() => void), deps: unknown[]) {
            const index = effectsIndex++;
            const previous = effects[index];
            if (
              previous &&
              deps.every((item, i) => Object.is(item, previous.deps[i]))
            )
              return;
            scheduled.push(() => {
              previous?.cleanup?.();
              const cleanup = callback();
              effects[index] = {
                deps,
                cleanup: typeof cleanup === "function" ? cleanup : undefined,
              };
            });
          },
        };
      throw new Error("Unexpected hook dependency");
    },
  });
  let identityReads = 0,
    dashboardReads = 0;
  let lookup = async (): Promise<{ analyticsUserId: string | null }> => ({
    analyticsUserId: id,
  });
  let dashboard = async () => ({ user: { id: "101", role: "user" } });
  const options: Options = {
    config: { enabled: true, counterId: 113847047, webvisor: true },
    ownerId: "101",
    role: "user",
    blocked: false,
    surface: "profile",
    sessionSignal: signal.signal,
    client: {
      analyticsIdentity: () => {
        identityReads++;
        return lookup();
      },
      dashboard: () => {
        dashboardReads++;
        return dashboard();
      },
      recordProductEvent: async (event) => {
        records.push(event);
      },
    },
  };
  return {
    options,
    win,
    doc,
    navigator,
    signal,
    commands,
    records,
    scripts,
    timers,
    identityReads: () => identityReads,
    dashboardReads: () => dashboardReads,
    lookup: (next: typeof lookup) => {
      lookup = next;
    },
    dashboard: (next: typeof dashboard) => {
      dashboard = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    mask: (value: boolean) => {
      masked = value;
    },
    render() {
      refsIndex = effectsIndex = 0;
      const result = evaluatedModule.exports.useProductAnalytics(options);
      for (const work of scheduled.splice(0)) work();
      return result;
    },
    load(preserveStub = false) {
      if (preserveStub) {
        const queue = (win.ym!.a ??= []);
        queue.push = (...items) => {
          for (const item of items) commands.push(item as unknown[]);
          return queue.length;
        };
      } else
        win.ym = (...args) => {
          commands.push(args);
        };
      scripts.at(-1)?.onload?.();
    },
    page(name: "pagehide" | "pageshow", persisted = true) {
      const event = new Event(name);
      Object.defineProperty(event, "persisted", { value: persisted });
      target.dispatchEvent(event);
    },
    dispose() {
      for (const effect of effects) effect.cleanup?.();
      signal.abort();
    },
  };
}
const goals = (h: ReturnType<typeof harness>) =>
  h.commands.filter((c) => c[1] === "reachGoal").map((c) => c[2]);

test("a standard SDK may preserve the original function without blocking goals or BFCache", async () => {
  const h = harness();
  h.render();
  await turn();
  const stub = h.win.ym;
  h.load(true);
  await turn();
  assert.equal(h.win.ym, stub);
  product.trackProductEvent("wallet_opened", { surface: "wallet" });
  h.page("pagehide");
  h.page("pageshow");
  await turn();
  await turn();
  product.trackProductEvent("phone_opened", { surface: "phone" });
  assert.deepEqual(goals(h), ["citygo_wallet_opened", "citygo_phone_opened"]);
  h.dispose();
});

test("only observed registration stages bridge confirmation once, with fast or slow SDK", async () => {
  for (const fast of [false, true]) {
    const h = harness();
    h.options.ownerId = null;
    h.options.role = undefined;
    const analytics = h.render();
    await turn();
    if (fast) {
      h.load();
      await turn();
    }
    const flow = analytics.beginRegistration(h.signal.signal);
    analytics.registrationCodeSent(
      flow,
      "123e4567-e89b-42d3-a456-426614174001",
      h.signal.signal,
    );
    const prepared = analytics.prepareRegistrationSuccess(
      flow,
      { id: "101", role: "user" },
      h.signal.signal,
      "123e4567-e89b-42d3-a456-426614174001",
    );
    assert.equal(prepared, flow);
    h.signal.abort();
    const next = new AbortController();
    analytics.authSuccess(
      "registration_completed",
      { id: "101", role: "user" },
      next.signal,
      prepared,
    );
    h.options.ownerId = "101";
    h.options.role = "user";
    h.options.sessionSignal = next.signal;
    h.render();
    await turn();
    if (!fast) {
      h.load();
      await turn();
    }
    assert.deepEqual(
      goals(h).filter((goal) =>
        String(goal).startsWith("citygo_registration_"),
      ),
      [
        "citygo_registration_started",
        "citygo_registration_code_sent",
        "citygo_registration_completed",
      ],
    );
    h.render();
    await turn();
    assert.equal(
      goals(h).filter((goal) => goal === "citygo_registration_started").length,
      1,
    );
    next.abort();
    h.dispose();
  }
});

test("late identity and script load retain real phone/gift/reply milestones in order", async () => {
  const h = harness(),
    identity = deferred<{ analyticsUserId: string }>();
  h.doc.referrer = "https://t.me/";
  h.lookup(() => identity.promise);
  h.render();
  product.trackProductEvent("phone_verified", { surface: "phone" }, "receipt");
  product.trackProductEvent("gift_granted", { surface: "phone" }, "receipt");
  product.trackProductEvent("ai_request_submitted", {
    surface: "chat",
    mode: "balanced",
  });
  product.trackProductEvent(
    "ai_response_completed",
    { surface: "chat", mode: "balanced" },
    "request",
  );
  assert.equal(h.scripts.length, 0);
  identity.resolve({ analyticsUserId: id });
  await turn();
  assert.equal(h.scripts.length, 1);
  assert.equal(h.commands.length, 0);
  assert.equal(h.win.ym?.a?.length ?? 0, 0);
  product.trackProductEvent("wallet_opened", { surface: "wallet" });
  h.load();
  await turn();
  assert.deepEqual(goals(h), [
    "citygo_phone_verified",
    "citygo_gift_granted",
    "citygo_ai_request_submitted",
    "citygo_ai_response_completed",
    "citygo_wallet_opened",
  ]);
  assert.deepEqual(h.records, ["ai_request_submitted", "wallet_opened"]);
  assert.deepEqual(
    h.commands.find((c) => c[1] === "setUserID"),
    [113847047, "setUserID", id],
  );
  assert(
    h.commands
      .filter((c) => c[1] === "reachGoal")
      .every((c) =>
        Object.keys(c[3] as object).every((key) =>
          ["surface", "mode", "assistant"].includes(key),
        ),
      ),
  );
  h.dispose();
});

test("an expired auth handoff cannot requeue registration stages when the SDK finally loads", async () => {
  const h = harness();
  h.options.ownerId = null;
  h.options.role = undefined;
  const analytics = h.render();
  await turn();
  const flow = analytics.beginRegistration(h.signal.signal);
  analytics.registrationCodeSent(
    flow,
    "123e4567-e89b-42d3-a456-426614174001",
    h.signal.signal,
  );
  const prepared = analytics.prepareRegistrationSuccess(
    flow,
    { id: "101", role: "user" },
    h.signal.signal,
    "123e4567-e89b-42d3-a456-426614174001",
  );
  h.signal.abort();
  const next = new AbortController();
  analytics.authSuccess(
    "registration_completed",
    { id: "101", role: "user" },
    next.signal,
    prepared,
  );
  h.options.ownerId = "101";
  h.options.role = "user";
  h.options.sessionSignal = next.signal;
  h.render();
  await turn();
  h.advance(120_001);
  h.load();
  await turn();
  assert.deepEqual(goals(h), []);
  product.trackProductEvent("wallet_opened", { surface: "wallet" });
  assert.deepEqual(goals(h), ["citygo_wallet_opened"]);
  next.abort();
  h.dispose();
});

test("pending auth receipt belongs only to the trusted user and exact new signal", async () => {
  const h = harness();
  h.options.ownerId = null;
  h.options.role = undefined;
  const analytics = h.render();
  await turn();
  const next = new AbortController();
  h.signal.abort(); // Email confirmation invalidates the anonymous lifetime first.
  analytics.authSuccess(
    "registration_completed",
    { id: "101", role: "user" },
    next.signal,
  );
  h.options.ownerId = "101";
  h.options.role = "user";
  h.options.sessionSignal = next.signal;
  const latest = h.render();
  await turn();
  assert.equal(h.commands.length, 0);
  h.load();
  await turn();
  assert.deepEqual(goals(h), ["citygo_registration_completed"]);
  h.render();
  await turn();
  assert.deepEqual(goals(h), ["citygo_registration_completed"]);
  latest.authSuccess(
    "login_completed",
    { id: "202", role: "user" },
    next.signal,
  );
  latest.authSuccess(
    "login_completed",
    { id: "101", role: "super_admin" },
    next.signal,
  );
  assert.deepEqual(goals(h), ["citygo_registration_completed"]);
  next.abort();
  h.dispose();
});

test("auth handoff expires and cannot cross another owner, logout or admin", async () => {
  for (const reason of ["expired", "other-owner", "logout", "admin"] as const) {
    const h = harness();
    h.options.ownerId = null;
    h.options.role = undefined;
    const analytics = h.render();
    await turn();
    const next = new AbortController();
    h.signal.abort();
    analytics.authSuccess(
      "registration_completed",
      { id: "101", role: "user" },
      next.signal,
    );
    h.options.ownerId = reason === "other-owner" ? "202" : "101";
    h.options.role = reason === "admin" ? "admin" : "user";
    h.options.sessionSignal = next.signal;
    if (reason === "expired") h.advance(120_001);
    if (reason === "logout") next.abort();
    h.render();
    await turn();
    h.load();
    await turn();
    assert(!goals(h).includes("citygo_registration_completed"), reason);
    next.abort();
    h.dispose();
  }
});

test("logout, masking, unsafe URLs and opt-out discard pending milestones", async () => {
  for (const reason of [
    "logout",
    "opt-out",
    "private-referrer",
    "query",
    "mask",
    "admin",
    "dnt",
    "gpc",
  ] as const) {
    const h = harness(),
      identity = deferred<{ analyticsUserId: string }>();
    h.lookup(() => identity.promise);
    if (reason === "private-referrer")
      h.doc.referrer = "https://mail.example/private/receipt";
    if (reason === "query")
      h.win.location.search = "?email=secret@example.test";
    if (reason === "mask") h.mask(false);
    if (reason === "admin") h.options.role = "admin";
    if (reason === "dnt") h.navigator.doNotTrack = "1";
    if (reason === "gpc") h.navigator.globalPrivacyControl = true;
    h.render();
    product.trackProductEvent("gift_granted", { surface: "phone" }, "receipt");
    if (reason === "logout") h.signal.abort();
    if (reason === "opt-out") {
      h.win.localStorage.setItem("citygo.analytics.optout", "1");
      h.win.dispatchEvent(new Event("citygo:analytics-preference"));
    }
    identity.resolve({ analyticsUserId: id });
    await turn();
    assert.equal(h.scripts.length, 0, reason);
    assert.equal(h.commands.length, 0, reason);
    h.dispose();
  }
});

test("BFCache rechecks the actual session and restarts only the same user", async () => {
  for (const changed of [false, true]) {
    const h = harness();
    h.render();
    await turn();
    h.load();
    await turn();
    product.trackProductEvent("wallet_opened", { surface: "wallet" });
    h.page("pagehide");
    product.trackProductEvent("phone_opened", { surface: "phone" });
    if (changed)
      h.dashboard(async () => ({ user: { id: "202", role: "admin" } }));
    h.page("pageshow");
    await turn();
    await turn();
    product.trackProductEvent("phone_opened", { surface: "phone" });
    assert.equal(h.dashboardReads(), 1);
    assert.equal(h.scripts.length, 1);
    assert.equal(
      h.commands.filter((c) => c[1] === "init").length,
      changed ? 1 : 2,
    );
    assert.equal(
      goals(h).filter((g) => g === "citygo_phone_opened").length,
      changed ? 0 : 1,
    );
    assert.equal(h.records.length, changed ? 1 : 2);
    h.dispose();
  }
});

test("identity transient retry is bounded and canceled before another request", async () => {
  for (const reason of [
    "recover",
    "exhausted",
    "unauthorized",
    "abort",
  ] as const) {
    const h = harness();
    let calls = 0;
    h.lookup(async () => {
      calls++;
      if (reason === "recover" && calls === 2) return { analyticsUserId: id };
      throw Object.assign(new Error("Synthetic identity failure"), {
        status: reason === "unauthorized" ? 401 : 503,
      });
    });
    h.render();
    await turn();
    assert.equal(h.timers.length, reason === "unauthorized" ? 0 : 1);
    if (reason === "abort") h.signal.abort();
    for (const timer of h.timers.splice(0)) timer();
    await turn();
    assert.equal(
      h.identityReads(),
      ["recover", "exhausted"].includes(reason) ? 2 : 1,
    );
    assert.equal(h.timers.length, 0);
    assert.equal(h.scripts.length, reason === "recover" ? 1 : 0);
    h.dispose();
  }
});

test("a click during a pending BFCache session check belongs to neither old nor replacement owner", async () => {
  for (const same of [true, false]) {
    const h = harness();
    h.render();
    await turn();
    h.load();
    await turn();
    product.trackProductEvent("wallet_opened", { surface: "wallet" });
    const checked = deferred<{ user: { id: string; role: string } }>();
    h.dashboard(() => checked.promise);
    h.page("pagehide");
    h.page("pageshow");
    product.trackProductEvent("phone_opened", { surface: "phone" });
    assert.equal(h.records.length, 1);
    assert.equal(h.identityReads(), 1);
    checked.resolve({ user: { id: same ? "101" : "202", role: "user" } });
    await turn();
    await turn();
    product.trackProductEvent("phone_opened", { surface: "phone" });
    assert.equal(h.records.length, same ? 2 : 1);
    assert.equal(
      goals(h).filter((goal) => goal === "citygo_phone_opened").length,
      same ? 1 : 0,
    );
    h.dispose();
  }
});

test("a blocked SDK neither retries nor breaks first-party actions", async () => {
  const h = harness();
  h.render();
  await turn();
  product.trackProductEvent("gift_granted", { surface: "phone" }, "receipt");
  h.scripts[0]!.onerror?.();
  await turn();
  product.trackProductEvent("wallet_opened", { surface: "wallet" });
  h.page("pagehide");
  h.page("pageshow");
  await turn();
  await turn();
  assert.equal(h.scripts.length, 1);
  assert.equal(goals(h).length, 0);
  assert.deepEqual(h.records, ["wallet_opened"]);
  h.dispose();
});
