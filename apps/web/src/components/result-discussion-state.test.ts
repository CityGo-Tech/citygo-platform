import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import type { ResultDiscussionSource } from "@citygo/contracts";
import {
  createResultDiscussionResource,
  currentResultDiscussionInput,
  initialResultDiscussionDraft,
  resultDiscussionDraft,
  type ResultDiscussionState,
} from "./result-discussion-state";
const saved = (): ResultDiscussionSource => ({
  userId: "101",
  kind: "plan",
  id: "9007199254740993",
  revision: 1,
  title: "Мой шаг",
  text: "Точный сохранённый текст 🧳",
  assistantKey: "support",
  interrupted: false,
});
test("discussion appends reviewed text without truncating either draft and binds owner, target and session", () => {
  assert.equal(
    resultDiscussionDraft("  Проверено 🧳  ", "Мой прежний черновик"),
    "Мой прежний черновик\n\nПроверено 🧳",
  );
  for (const text of ["", "x".repeat(4001), "\0", "\ud800"])
    assert.throws(() => resultDiscussionDraft(text));
  assert.throws(() => resultDiscussionDraft("Новый текст", "x".repeat(3995)));
  assert.equal(
    initialResultDiscussionDraft({ ...saved(), text: "x".repeat(4001) }),
    "",
  );
  const controller = new AbortController();
  const input = {
    source: saved(),
    sessionSignal: controller.signal,
    target: "support" as const,
    text: "Обсудить",
  };
  assert.equal(
    currentResultDiscussionInput(input, "101", controller.signal),
    true,
  );
  assert.equal(
    currentResultDiscussionInput(input, "102", controller.signal),
    false,
  );
  assert.equal(
    currentResultDiscussionInput(input, "101", new AbortController().signal),
    false,
  );
  controller.abort();
  assert.equal(
    currentResultDiscussionInput(input, "101", controller.signal),
    false,
  );
});
test("discussion re-reads exact source and requires another explicit review after a concurrent edit", async () => {
  let next = saved();
  const states: ResultDiscussionState[] = [];
  const controller = new AbortController();
  const value = createResultDiscussionResource({
    owner: "101",
    selection: { kind: "plan", id: next.id },
    sessionSignal: controller.signal,
    read: async () => next,
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail("unexpected denial"),
  });
  assert.deepEqual(await value.load(), saved());
  next = { ...next, revision: 2, text: "Обновлённый шаг" };
  assert.equal(await value.confirm(), null);
  assert.match(states.at(-1)!.error, /изменился/);
  assert.equal((await value.confirm())!.text, next.text);
  value.dispose();
  assert.equal(states.at(-1)!.source, null);
});
test("discussion ignores late replies after abort and clears unavailable, malformed or foreign text", async () => {
  const controller = new AbortController();
  const states: ResultDiscussionState[] = [];
  let resolve!: (v: unknown) => void;
  let denied = 0;
  const pending = new Promise<unknown>((r) => (resolve = r));
  const value = createResultDiscussionResource({
    owner: "101",
    selection: { kind: "plan", id: saved().id },
    sessionSignal: controller.signal,
    read: () => pending,
    publish: (s) => states.push(s),
    onAccessDenied: () => denied++,
  });
  const request = value.load();
  controller.abort();
  resolve(saved());
  await request;
  assert.equal(states.at(-1)!.phase, "closed");
  assert.equal(states.at(-1)!.source, null);
  assert.equal(denied, 0);
  for (const response of [
    { ...saved(), userId: "102" },
    { ...saved(), id: "12" },
    new ApiError(404, "PRIVATE"),
    new ApiError(403, "PRIVATE"),
  ]) {
    const states: ResultDiscussionState[] = [];
    let denied = 0;
    const r = createResultDiscussionResource({
      owner: "101",
      selection: { kind: "plan", id: saved().id },
      sessionSignal: new AbortController().signal,
      read: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
      publish: (s) => states.push(s),
      onAccessDenied: () => denied++,
    });
    assert.equal(await r.load(), null);
    assert.equal(states.at(-1)!.source, null);
    assert.equal(
      denied,
      response instanceof ApiError && response.status === 403 ? 1 : 0,
    );
    assert.ok(!JSON.stringify(states).includes("PRIVATE"));
    r.dispose();
  }
});
