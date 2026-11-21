import assert from "node:assert/strict";
import test from "node:test";
import { createSessionGuard } from "@citygo/api-client";
import {
  CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  type ResultDiscussionSource,
} from "@citygo/contracts";
import {
  observeSavedPlanLinks,
  readSavedPlanResult,
  savedPlanIdFromUrl,
} from "./saved-plan-link.js";

const resultId = "42";
const ownerId = "7";
const exactUrl =
  "https://synthetic.invalid/api/v1/results/plan/42/discussion-source";
const link = (id: string) => `citygo://results/plan/${id}`;
const result: ResultDiscussionSource = {
  userId: ownerId,
  kind: "plan",
  id: resultId,
  revision: 2,
  title: "Проверить документы для аренды",
  text: "Уточнить состав первого платежа до просмотра.",
  assistantKey: "support",
  interrupted: false,
};

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function linkingFixture(getInitialURL: () => Promise<string | null>) {
  let listener: ((event: { url: string }) => void) | undefined;
  let removed = false;
  return {
    getInitialURL,
    addEventListener(type: "url", receive: (event: { url: string }) => void) {
      assert.equal(type, "url");
      listener = receive;
      return {
        remove() {
          removed = true;
        },
      };
    },
    incoming(url: string) {
      // Invoke even after remove to cover an already queued native callback.
      listener?.({ url });
    },
    removed: () => removed,
  };
}

function fixture(
  fetch: typeof globalThis.fetch = async () => response(result),
) {
  const session = createSessionGuard();
  session.reset(ownerId);
  const screen = new AbortController();
  function open(token = "first-synthetic-session") {
    return readSavedPlanResult({
      base: "https://synthetic.invalid/api",
      fetch,
      id: resultId,
      signal: screen.signal,
      access: { token, userId: ownerId, sessionTicket: session.capture() },
    });
  }
  return { open, screen, session };
}

test("native link accepts only a canonical CityGo plan ID", () => {
  for (const id of ["1", resultId, "9223372036854775807"])
    assert.equal(savedPlanIdFromUrl(link(id)), id);

  for (const url of [
    link(""),
    link("0"),
    link("042"),
    link("9223372036854775808"),
    link("42\n"),
    link("%34%32"),
    link("42/"),
    link("42/../43"),
    link("42?"),
    link("42?token=synthetic"),
    link("42#"),
    link("42#private"),
    " citygo://results/plan/42",
    "CITYGO://results/plan/42",
    "citygo://results:80/plan/42",
    "citygo://evil@results/plan/42",
    "citygo://results.evil.invalid/plan/42",
    "citygo://results/favorites/42",
    "citygo:///results/plan/42",
    "https://synthetic.invalid/results/plan/42",
  ])
    assert.equal(savedPlanIdFromUrl(url), null, JSON.stringify(url));
});

test("cold open loads the saved plan link even if an unrelated event arrives first", async () => {
  const cold = deferred<string | null>();
  const linking = linkingFixture(() => cold.promise);
  const opened: string[] = [];
  const unsubscribe = observeSavedPlanLinks(linking, (id) => opened.push(id));

  linking.incoming("citygo://other/path");
  cold.resolve(link(resultId));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, [resultId]);

  linking.incoming(link("43"));
  assert.deepEqual(opened, [resultId, "43"]);
  unsubscribe();
  assert.equal(linking.removed(), true);
});

test("a valid warm link supersedes a delayed cold link", async () => {
  const cold = deferred<string | null>();
  const linking = linkingFixture(() => cold.promise);
  const opened: string[] = [];
  const unsubscribe = observeSavedPlanLinks(linking, (id) => opened.push(id));

  linking.incoming(link("43"));
  cold.resolve(link(resultId));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ["43"]);

  unsubscribe();
});

test("unsubscribing prevents delayed initial and queued event navigation", async () => {
  const cold = deferred<string | null>();
  const linking = linkingFixture(() => cold.promise);
  const opened: string[] = [];
  const unsubscribe = observeSavedPlanLinks(linking, (id) => opened.push(id));

  unsubscribe();
  linking.incoming(link("43"));
  cold.resolve(link(resultId));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(linking.removed(), true);
  assert.deepEqual(opened, []);
});

test("opening a saved plan uses a single authenticated, read-only native API request", async () => {
  const requests: { url: string; method: string | undefined }[] = [];
  const f = fixture(async (url, init) => {
    requests.push({ url: String(url), method: init?.method });
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.get("Authorization"),
      "Bearer first-synthetic-session",
    );
    assert.equal(headers.get("X-CityGo-Client"), "native");
    assert.equal(headers.get(CONTRACT_VERSION_HEADER), CONTRACT_VERSION);
    assert.equal(init?.body, undefined);
    return response(result);
  });

  assert.deepEqual(await f.open(), { phase: "opened", result });
  assert.deepEqual(requests, [{ url: exactUrl, method: "GET" }]);
});

test("expired session returns no saved data and a subsequent login opens the same exact result", async () => {
  const requested: { url: string; token: string | null }[] = [];
  const f = fixture(async (url, init) => {
    const token = new Headers(init?.headers).get("Authorization");
    requested.push({ url: String(url), token });
    return token === "Bearer first-synthetic-session"
      ? response({ error: "Сессия завершена" }, 401)
      : response(result);
  });

  assert.deepEqual(await f.open(), { phase: "expired" });
  f.session.reset();
  f.session.reset(ownerId);
  assert.deepEqual(await f.open("new-synthetic-session"), {
    phase: "opened",
    result,
  });
  assert.deepEqual(requested, [
    { url: exactUrl, token: "Bearer first-synthetic-session" },
    { url: exactUrl, token: "Bearer new-synthetic-session" },
  ]);
});

test("foreign or unavailable plan link does not expose a saved result", async () => {
  for (const status of [403, 404]) {
    const f = fixture(async () => response({ error: "Недоступно" }, status));
    assert.deepEqual(await f.open(), { phase: "unavailable" });
  }

  for (const foreign of [
    { ...result, userId: "8" },
    { ...result, id: "43" },
    { ...result, kind: "favorites", revision: null },
  ]) {
    const f = fixture(async () => response(foreign));
    const opened = await f.open();
    assert.ok(opened);
    assert.notEqual(opened.phase, "opened");
    assert.equal("result" in opened, false);
  }
});

test("an unavailable transport permits retry without creating any new request", async () => {
  let requests = 0;
  const f = fixture(async () => {
    requests++;
    return response({ error: "Временно недоступно" }, 503);
  });

  assert.deepEqual(await f.open(), { phase: "retry" });
  assert.equal(requests, 1);
});

test("late responses are ignored after closing the screen or changing account", async () => {
  for (const cancel of [
    (f: ReturnType<typeof fixture>) => f.screen.abort(),
    (f: ReturnType<typeof fixture>) => f.session.reset("8"),
  ]) {
    const started = deferred<AbortSignal>();
    const late = deferred<Response>();
    const f = fixture(async (_url, init) => {
      assert.ok(init?.signal);
      started.resolve(init.signal);
      return late.promise;
    });

    const pending = f.open();
    const signal = await started.promise;
    cancel(f);
    assert.equal(signal.aborted, true);
    late.resolve(response(result));
    assert.equal(await pending, null);
  }
});
