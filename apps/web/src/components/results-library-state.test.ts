import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@citygo/api-client";
import type { FavoriteMessage, PersonalPlanItem } from "@citygo/contracts";
import {
  createResultsResource,
  resultMessageTitle,
  resultPreview,
  type ResultsState,
} from "./results-library-state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const plan: PersonalPlanItem[] = Array.from({ length: 45 }, (_, i) => ({
    id: String(9007199254741100n - BigInt(i)),
    title: "Шаг " + i,
    details: "Точный текст шага " + i,
    status: i % 2 ? "pending" : "completed",
    revision: 1,
    source: { messageId: "11", threadId: "10", role: "assistant" },
    createdAt: "2026-10-28T10:00:00Z",
    updatedAt: "2026-10-28T10:00:00Z",
  }));
  const favorites: FavoriteMessage[] = Array.from({ length: 29 }, (_, i) => ({
    id: String(9007199254741300n - BigInt(i)),
    threadId: "10",
    role: "assistant",
    agentKey: "support",
    status: "complete",
    content: "Ответ " + i,
  }));
  const slice = <T extends { id: string }>(rows: T[], before?: string) => {
    const matching = rows.filter(
      (item) => !before || BigInt(item.id) < BigInt(before),
    );
    return {
      items: matching.slice(0, 20),
      nextBefore: matching.length > 20 ? matching[19]!.id : null,
    };
  };
  const session = new AbortController();
  let denied = 0;
  const published: ResultsState[] = [];
  const reads: { category: string; before?: string; signal: AbortSignal }[] =
    [];
  const planPage = (before?: string) => ({
    userId: "1",
    ...slice(plan, before),
  });
  const favoritePage = (before?: string) => {
    const value = slice(favorites, before);
    return { userId: "1", messages: value.items, nextBefore: value.nextBefore };
  };
  const client = {
    plan: async (
      before: string | undefined,
      signal: AbortSignal,
    ): Promise<unknown> => {
      reads.push({ category: "plan", before, signal });
      return planPage(before);
    },
    summary: async (): Promise<unknown> => ({
      userId: "1",
      total: 45,
      pending: 22,
      completed: 23,
    }),
    favorites: async (
      before: string | undefined,
      signal: AbortSignal,
    ): Promise<unknown> => {
      reads.push({ category: "favorites", before, signal });
      return favoritePage(before);
    },
  };
  const resource = createResultsResource({
    userId: "1",
    sessionSignal: session.signal,
    client,
    publish: (state) => published.push(state),
    onAccessDenied: () => denied++,
  });
  return {
    resource,
    session,
    client,
    reads,
    planPage,
    favoritePage,
    published,
    denied: () => denied,
  };
}

test("both categories use their own twenty-item bigint cursor and preserve loaded pages when switching", async () => {
  const s = setup();
  await s.resource.load();
  await s.resource.loadMore();
  assert.equal(s.resource.snapshot().plan.items.length, 40);
  assert.equal(s.reads[1]?.before, "9007199254741081");
  assert.equal(s.resource.snapshot().summary?.total, 45);
  await s.resource.select("favorites");
  assert.equal(s.resource.snapshot().favorites.items.length, 20);
  await s.resource.loadMore();
  assert.equal(s.resource.snapshot().favorites.items.length, 29);
  assert.equal(s.reads.at(-1)?.before, "9007199254741281");
  await s.resource.select("plan");
  assert.equal(s.resource.snapshot().plan.items.length, 40);
  assert.equal(s.reads.length, 4);
  await s.resource.loadMore();
  assert.equal(s.resource.snapshot().plan.items.length, 45);
  assert.equal(s.resource.snapshot().plan.nextBefore, null);
});

test("switching categories aborts an old page and discards its late data", async () => {
  const s = setup();
  await s.resource.load();
  const gate = deferred<unknown>();
  const original = s.client.plan;
  s.client.plan = (before, signal) => {
    s.reads.push({ category: "plan", before, signal });
    return gate.promise;
  };
  const oldRead = s.resource.loadMore();
  const signal = s.reads.at(-1)!.signal;
  await s.resource.select("favorites");
  assert.equal(signal.aborted, true);
  gate.resolve(s.planPage("9007199254741081"));
  await oldRead;
  assert.equal(s.resource.snapshot().category, "favorites");
  assert.equal(s.resource.snapshot().plan.items.length, 20);
  s.client.plan = original;
  await s.resource.select("plan");
  assert.equal(s.resource.snapshot().plan.items.length, 20);
  assert.equal(s.resource.snapshot().plan.phase, "ready");
});

test("duplicate load-more clicks share one read", async () => {
  const s = setup();
  await s.resource.load();
  const gate = deferred<unknown>();
  let calls = 0;
  s.client.plan = async () => {
    calls++;
    return gate.promise;
  };
  const first = s.resource.loadMore();
  await s.resource.loadMore();
  assert.equal(calls, 1);
  gate.resolve(s.planPage("9007199254741081"));
  await first;
  assert.equal(s.resource.snapshot().plan.items.length, 40);
});

for (const target of ["plan", "summary", "favorites"] as const) {
  test(
    "a foreign " +
      target +
      " response clears both categories before invalidating access",
    async () => {
      const s = setup();
      await s.resource.load();
      if (target === "plan")
        s.client.plan = async () => ({ ...s.planPage(), userId: "2" });
      if (target === "summary")
        s.client.summary = async () => ({
          userId: "2",
          total: 1,
          pending: 1,
          completed: 0,
        });
      if (target === "favorites")
        s.client.favorites = async () => ({ ...s.favoritePage(), userId: "2" });
      await (target === "favorites"
        ? s.resource.select("favorites")
        : s.resource.load());
      assert.equal(s.denied(), 1);
      assert.equal(s.resource.snapshot().closed, true);
      assert.deepEqual(s.resource.snapshot().plan.items, []);
      assert.deepEqual(s.resource.snapshot().favorites.items, []);
      assert.equal(s.resource.snapshot().summary, null);
      assert.equal(s.published.at(-1)?.closed, true);
    },
  );
}

for (const status of [401, 403]) {
  test("access " + status + " closes the results lifetime", async () => {
    const s = setup();
    await s.resource.load();
    s.client.favorites = async () => {
      throw new ApiError(status, "PRIVATE_DETAILS");
    };
    await s.resource.select("favorites");
    assert.equal(s.denied(), 1);
    assert.equal(s.resource.snapshot().closed, true);
    assert.equal(
      JSON.stringify(s.resource.snapshot()).includes("PRIVATE_DETAILS"),
      false,
    );
  });
}

for (const action of ["abort", "dispose"] as const) {
  test(
    "a late response after " + action + " cannot publish saved content",
    async () => {
      const s = setup();
      const gate = deferred<unknown>();
      s.client.plan = async (_, signal) => {
        s.reads.push({ category: "plan", signal });
        return gate.promise;
      };
      const loading = s.resource.load();
      if (action === "abort") s.session.abort();
      else s.resource.dispose();
      const count = s.published.length;
      assert.equal(s.reads[0]!.signal.aborted, true);
      gate.resolve(s.planPage());
      await loading;
      assert.equal(s.published.length, count);
      assert.deepEqual(s.resource.snapshot().plan.items, []);
    },
  );
}

test("malformed favorite cursor, duplicate IDs, and a replayed page are never appended", async () => {
  for (const fault of ["cursor", "duplicate", "replay"] as const) {
    const s = setup();
    await s.resource.select("favorites");
    const initial = s.favoritePage();
    s.client.favorites = async (before) => {
      if (fault === "replay") return initial;
      const value = s.favoritePage(before);
      return fault === "cursor"
        ? { ...value, nextBefore: "1" }
        : { ...value, messages: [value.messages[0], value.messages[0]] };
    };
    await s.resource.loadMore();
    assert.equal(s.resource.snapshot().favorites.phase, "error");
    assert.equal(s.resource.snapshot().favorites.items.length, 20);
    assert.equal(s.denied(), 0);
  }
});

test("a failed first read has a generic error and can retry without touching the other category", async () => {
  const s = setup();
  const original = s.client.favorites;
  s.client.favorites = async () => {
    throw new Error("PRIVATE_DETAILS");
  };
  await s.resource.load();
  await s.resource.select("favorites");
  assert.match(s.resource.snapshot().favorites.error, /Попробуйте/);
  assert.equal(s.resource.snapshot().plan.items.length, 20);
  s.client.favorites = original;
  await s.resource.load();
  assert.equal(s.resource.snapshot().favorites.phase, "ready");
});

test("previews bound one-megabyte saved content while the original remains exact", () => {
  const text = "<script>private()</script>\n" + "я".repeat(1024 * 1024 - 26);
  assert.equal(resultPreview(text).length, 421);
  assert.equal(resultPreview(text), text.slice(0, 420) + "…");
  assert.equal(resultMessageTitle(text), "<script>private()</script>");
  assert.equal(resultMessageTitle(""), "Сохранённое сообщение");
  assert.equal(resultMessageTitle("x".repeat(1000)).length, 81);
  assert(text.endsWith("я"));
});
