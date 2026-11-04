import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import {
  createAssistantContextResource,
  type AssistantContextView,
} from "./assistant-context-state";
import type { AiModeId, AssistantContextPreview } from "@citygo/contracts";
const value: AssistantContextPreview = {
  userId: "1",
  threadId: "2",
  generatedAt: "2026-11-02T00:00:00Z",
  profile: {
    targetCity: null,
    monthlyBudget: null,
    household: null,
    moveTargetDate: null,
  },
  agentKey: "support",
  closed: false,
  draftIncluded: true,
  messages: [
    { role: "user", content: "PRIVATE_QUESTION" },
    { role: "assistant", content: "PRIVATE_ANSWER" },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(
  read: (signal: AbortSignal) => Promise<AssistantContextPreview>,
  mode: { aiMode?: AiModeId; aiModeCatalogId?: string } = {},
) {
  const session = new AbortController();
  const scope = {
    userId: "1",
    threadId: "2",
    draft: "Новый вопрос",
    signal: session.signal,
    ...mode,
  };
  let current = { ...scope, enabled: true };
  const views: AssistantContextView[] = [];
  let denied = 0;
  const action = createAssistantContextResource({
    scope,
    current: () => current,
    read,
    publish: (v) => views.push(v),
    onAccessDenied: () => denied++,
  });
  return {
    action,
    views,
    session,
    setCurrent: (next: Partial<typeof current>) => {
      current = { ...current, ...next };
    },
    denied: () => denied,
  };
}
test("opening preview only reads once; double click shares work and completion preserves the selected owner", async () => {
  const next = deferred<AssistantContextPreview>();
  let calls = 0;
  const f = setup(async () => {
    calls++;
    return next.promise;
  });
  const first = f.action.load();
  await f.action.load();
  assert.equal(calls, 1);
  next.resolve(value);
  await first;
  assert.deepEqual(f.views.at(-1), { phase: "ready", value });
  assert.equal(f.denied(), 0);
  f.action.dispose();
});

const modeScope = {
  aiMode: "maximum" as const,
  aiModeCatalogId: "b".repeat(64),
};
function withMemory(mode: AiModeId = "maximum"): AssistantContextPreview {
  const quote =
    "Работаю у станции Тестовая; переезжаю с семьёй 🧳. <img src=x>";
  return {
    ...value,
    memory: {
      fragments: [
        {
          messageId: "9007199254740993",
          content: quote,
          start: 7,
          end: 7 + [...quote].length,
          sourceSha256: "a".repeat(64),
        },
      ],
      complete: false,
      indexComplete: false,
      indexedMessages: 3,
    },
    contextBudget: {
      strategy: "model_window_memory_v1",
      mode,
      contextWindowTokens: 1000000,
      maxInputTokens: 991808,
      maxOutputTokens: 4096,
      framingReserve: 4096,
      inputTextTokens: 1200,
      verification: "conservative_utf8",
      needsProviderCheck: true,
      mandatoryFits: true,
    },
  };
}

test("a memory preview preserves exact source quotes, bigint identity and partial-coverage metadata", async () => {
  const response = withMemory();
  const f = setup(async () => response, modeScope);
  await f.action.load();
  assert.deepEqual(f.views.at(-1), { phase: "ready", value: response });
  assert.equal(f.denied(), 0);
  f.action.dispose();
});

test("mode and catalog replacement suppress late success and auth errors without another read or private publication", async () => {
  for (const change of ["mode", "catalog"] as const)
    for (const status of [200, 401, 403]) {
      const next = deferred<AssistantContextPreview>();
      let calls = 0;
      const f = setup(async () => {
        calls++;
        const result = await next.promise;
        if (status !== 200) throw new ApiError(status, "OLD_PRIVATE_CONTEXT");
        return result;
      }, modeScope);
      const pending = f.action.load();
      f.setCurrent(
        change === "mode"
          ? { aiMode: "balanced" }
          : { aiModeCatalogId: "c".repeat(64) },
      );
      next.resolve(withMemory());
      await pending;
      await f.action.load();
      assert.equal(calls, 1);
      assert.deepEqual(f.views, [{ phase: "loading" }]);
      assert.equal(f.denied(), 0);
      f.action.dispose();
    }
});

test("a current-mode response cannot reuse a different mode budget and a new scope can load independently", async () => {
  const wrong = setup(async () => withMemory("balanced"), modeScope);
  await wrong.action.load();
  assert.deepEqual(wrong.views.at(-1), {
    phase: "error",
    message: "Не удалось показать контекст. Попробуйте ещё раз.",
  });
  assert.equal(wrong.denied(), 0);
  assert.equal(
    wrong.views.some((view) => view.phase === "ready"),
    false,
  );
  wrong.action.dispose();
  const response = withMemory("balanced");
  const replacement = setup(async () => response, {
    aiMode: "balanced",
    aiModeCatalogId: "c".repeat(64),
  });
  await replacement.action.load();
  assert.deepEqual(replacement.views.at(-1), {
    phase: "ready",
    value: response,
  });
  replacement.action.dispose();
});
test("close, expired session, changed owner/conversation and changed draft reject late private context", async () => {
  for (const change of ["close", "abort", "owner", "thread", "draft"]) {
    const next = deferred<AssistantContextPreview>();
    let signal!: AbortSignal;
    const f = setup(async (received) => {
      signal = received;
      return next.promise;
    });
    const loading = f.action.load();
    if (change === "close") f.action.dispose();
    if (change === "abort") f.session.abort();
    if (change === "owner") f.setCurrent({ userId: "3" });
    if (change === "thread") f.setCurrent({ threadId: "4" });
    if (change === "draft") f.setCurrent({ draft: "Другой вопрос" });
    next.resolve(value);
    await loading;
    assert.equal(
      f.views.some((view) => view.phase === "ready"),
      false,
    );
    assert.equal(f.denied(), 0);
    if (change === "close" || change === "abort")
      assert.equal(signal.aborted, true);
    f.action.dispose();
  }
});
test("a foreign response or current 401 is denied, but a delayed 401 after owner change cannot log out the new owner", async () => {
  const foreign = setup(async () => ({ ...value, userId: "9" }));
  await foreign.action.load();
  assert.equal(foreign.denied(), 1);
  assert.equal(
    foreign.views.some((v) => v.phase === "ready"),
    false,
  );
  const denied = setup(async () => {
    throw new ApiError(401, "Войдите");
  });
  await denied.action.load();
  assert.equal(denied.denied(), 1);
  const next = deferred<AssistantContextPreview>();
  const late = setup(async () => {
    await next.promise;
    throw new ApiError(401, "Войдите");
  });
  const reading = late.action.load();
  late.setCurrent({ userId: "8" });
  next.resolve(value);
  await reading;
  assert.equal(late.denied(), 0);
  late.action.dispose();
});
