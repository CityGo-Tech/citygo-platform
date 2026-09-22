import assert from "node:assert/strict";
import test from "node:test";
import { createClient, createSessionGuard } from "@citygo/api-client";
import type { Dashboard, Quest } from "@citygo/contracts";
import {
  allQuestsCompleted,
  canStopChat,
  completeQuest,
  completionNotice,
  createOperations,
  operationLabel,
  type CompletionReceipt,
  type OperationKind,
  type PendingOperation,
} from "./flow.js";

function quest(id: string, state: Quest["state"]): Quest {
  return { id, state, slug: `quest-${id}`, title: `Квест ${id}`, xpReward: 60 };
}
function board(quests: Quest[], xp = 0): Dashboard {
  return {
    user: { id: "synthetic", email: "synthetic@example.test" },
    profile: null,
    quests,
    xp,
    thread: null,
    provider: "unconfigured",
    aiAccess: { granted: false, dailyLimit: 0, policy: null },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("completion displays the actual award and only a server-confirmed available next quest", async () => {
  const session = createSessionGuard();
  let receipt: CompletionReceipt | null = null;
  let current = board([quest("1", "in_progress"), quest("2", "locked")]);
  const requests: string[] = [];
  const api = createClient("https://synthetic.invalid", {
    fetch: async (url) => {
      requests.push(String(url));
      return String(url).endsWith("/complete")
        ? Response.json({ awarded: 125 })
        : Response.json(
            board([quest("1", "completed"), quest("2", "available")], 125),
          );
    },
  });
  await completeQuest({
    questId: "1",
    complete: api.complete,
    ticket: session.capture(),
    received(value) {
      receipt = value;
      assert.equal(current.xp, 0, "never optimistically add an XP reward");
      assert.match(completionNotice(value), /\+125 XP/);
      assert.doesNotMatch(
        completionNotice(value),
        /Доступный квест|следующий шаг открыт/,
      );
    },
    async refresh(ticket) {
      const next = await api.dashboard();
      ticket.check();
      current = next;
      receipt = { ...receipt!, quests: next.quests };
      return next;
    },
  });
  assert.match(
    completionNotice(receipt!),
    /\+125 XP.*Доступный квест: Квест 2/,
  );
  assert.doesNotMatch(completionNotice(receipt!), /\+60 XP/);
  assert.equal(current.xp, 125);
  assert.deepEqual(requests, [
    "https://synthetic.invalid/v1/quests/1/complete",
    "https://synthetic.invalid/v1/dashboard",
  ]);
});

test("replayed completion shows zero new XP and never announces another award", async () => {
  let receipt: CompletionReceipt | undefined;
  const api = createClient("https://synthetic.invalid", {
    fetch: async () => Response.json({ awarded: 0 }),
  });
  await completeQuest({
    questId: "1",
    complete: api.complete,
    ticket: createSessionGuard().capture(),
    received: (value) => {
      receipt = value;
    },
    refresh: async () => {
      const next = board(
        [quest("1", "completed"), quest("2", "available")],
        60,
      );
      receipt = { ...receipt!, quests: next.quests };
      return next;
    },
  });
  assert.match(completionNotice(receipt!), /Новых XP не начислено \(0 XP\)/);
  assert.doesNotMatch(completionNotice(receipt!), /\+\d+ XP/);
});

test("last quest and a reload of a finished plan never invent a next quest", () => {
  const quests = [quest("1", "completed"), quest("2", "completed")];
  assert.equal(allQuestsCompleted(quests), true);
  for (const awarded of [60, 0]) {
    const message = completionNotice({ questId: "2", awarded, quests });
    assert.match(message, /Все квесты текущего плана завершены/);
    assert.doesNotMatch(message, /Доступный квест|следующий шаг открыт/);
  }
  assert.equal(allQuestsCompleted([]), false);
  assert.equal(
    allQuestsCompleted([quest("1", "completed"), quest("2", "locked")]),
    false,
  );
});

test("unknown, stale and locked plans never imply an unlocked next quest", () => {
  for (const quests of [
    undefined,
    [],
    [quest("1", "in_progress"), quest("2", "available")],
  ]) {
    const message = completionNotice({ questId: "1", awarded: 60, quests });
    assert.match(message, /Обновите план/);
    assert.doesNotMatch(message, /Доступный квест|Все квесты/);
  }
  assert.match(
    completionNotice({
      questId: "1",
      awarded: 60,
      quests: [quest("1", "completed"), quest("2", "locked")],
    }),
    /Следующий квест пока недоступен/,
  );
});

test("failed refresh keeps the confirmed receipt and manual recovery only reads the plan", async () => {
  let posts = 0,
    gets = 0,
    online = false;
  let receipt: CompletionReceipt | undefined;
  let current = board([quest("1", "in_progress")], 0);
  const api = createClient("https://synthetic.invalid", {
    fetch: async (url) => {
      if (String(url).endsWith("/complete")) {
        posts++;
        return Response.json({ awarded: 75 });
      }
      gets++;
      if (!online) throw new Error("offline");
      return Response.json(board([quest("1", "completed")], 75));
    },
  });
  const session = createSessionGuard();
  const refresh = async () => {
    const next = await api.dashboard();
    current = next;
    receipt = { ...receipt!, quests: next.quests };
    return next;
  };
  await assert.rejects(
    completeQuest({
      questId: "1",
      complete: api.complete,
      refresh,
      ticket: session.capture(),
      received: (value) => {
        receipt = value;
      },
    }),
  );
  assert.equal(posts, 1);
  assert.equal(gets, 1);
  assert.equal(current.xp, 0);
  assert.match(completionNotice(receipt!), /\+75 XP.*Обновите план/);
  online = true;
  await refresh();
  assert.equal(posts, 1);
  assert.equal(gets, 2);
  assert.equal(current.xp, 75);
  assert.match(completionNotice(receipt!), /\+75 XP.*Все квесты/);
});

test("HTTP rejection and invalid completion payload cannot publish a receipt or refresh as success", async () => {
  for (const response of [
    Response.json({ error: "Сначала обсудите критерии" }, { status: 409 }),
    Response.json({ awarded: "60" }),
  ]) {
    let received = 0,
      reads = 0;
    const api = createClient("https://synthetic.invalid", {
      fetch: async () => response,
    });
    await assert.rejects(
      completeQuest({
        questId: "1",
        complete: api.complete,
        ticket: createSessionGuard().capture(),
        received: () => {
          received++;
        },
        refresh: async () => {
          reads++;
          return undefined;
        },
      }),
    );
    assert.equal(received, 0);
    assert.equal(reads, 0);
  }
});

test("late completion from account A cannot publish a reward or refresh account B", async () => {
  const session = createSessionGuard();
  const pending = deferred<{ awarded: number }>();
  let receipts = 0,
    reads = 0;
  const task = completeQuest({
    questId: "1",
    complete: () => pending.promise,
    ticket: session.capture(),
    received: () => {
      receipts++;
    },
    refresh: async () => {
      reads++;
      return undefined;
    },
  });
  const rejected = assert.rejects(task, /Сессия клиента изменилась/);
  session.reset("B");
  pending.resolve({ awarded: 60 });
  await rejected;
  assert.equal(receipts, 0);
  assert.equal(reads, 0);
});

test("leaving account A during plan refresh cannot republish its completion after reset", async () => {
  const session = createSessionGuard();
  const loaded = deferred<Dashboard>();
  const started = deferred<void>();
  let receipt: CompletionReceipt | null = null;
  const task = completeQuest({
    questId: "1",
    complete: async () => ({ awarded: 60 }),
    ticket: session.capture(),
    received: (value) => {
      receipt = value;
    },
    refresh: async (ticket) => {
      started.resolve();
      const next = await loaded.promise;
      ticket.check();
      receipt = { ...receipt!, quests: next.quests };
      return next;
    },
  });
  await started.promise;
  session.reset("B");
  receipt = null;
  const rejected = assert.rejects(task, /Сессия клиента изменилась/);
  loaded.resolve(board([quest("1", "completed")], 60));
  await rejected;
  assert.equal(receipt, null);
});

test("all non-chat operations exclude stop and synchronously block a second press", () => {
  const gate = createOperations(() => {});
  for (const kind of [
    "auth",
    "questionnaire",
    "consent",
    "start",
    "complete",
    "refresh",
    "logout",
  ] satisfies OperationKind[]) {
    const operation = gate.begin(kind)!;
    assert.equal(canStopChat(gate.current()), false);
    assert.equal(
      gate.stopChat(() => assert.fail("must not abort a non-chat operation")),
      false,
    );
    assert.equal(gate.begin(kind), null);
    assert.equal(gate.begin("chat"), null);
    assert.ok(operationLabel(gate.current()!).length > 0);
    operation.refreshing();
    assert.equal(gate.current()?.kind, kind);
    operation.finish();
    assert.equal(gate.current(), null);
  }
});

test("chat may stop before the first token, once; history refresh stays busy without a stop button", () => {
  const states: (PendingOperation | null)[] = [];
  const gate = createOperations((state) => states.push(state));
  const chat = gate.begin("chat")!;
  const abort = new AbortController();
  let stops = 0;
  assert.equal(canStopChat(gate.current()), true);
  assert.equal(
    gate.stopChat(() => {
      stops++;
      abort.abort();
    }),
    true,
  );
  assert.equal(abort.signal.aborted, true);
  assert.equal(
    gate.stopChat(() => {
      stops++;
    }),
    false,
  );
  assert.equal(stops, 1);
  assert.equal(canStopChat(gate.current()), false);
  chat.refreshing();
  assert.equal(operationLabel(gate.current()!), "Обновляем историю…");
  assert.equal(canStopChat(gate.current()), false);
  assert.equal(gate.begin("complete"), null);
  chat.finish();
  assert.deepEqual(states, [
    { kind: "chat", phase: "streaming" },
    { kind: "chat", phase: "stopping" },
    { kind: "chat", phase: "refreshing" },
    null,
  ]);
});

test("a normally completed stream also disables stop during the follow-up GET", () => {
  const gate = createOperations(() => {});
  const chat = gate.begin("chat")!;
  chat.refreshing();
  assert.equal(
    gate.stopChat(() => assert.fail("stream is already complete")),
    false,
  );
  chat.finish();
  assert.equal(gate.current(), null);
});

test("logout preempts chat and stale finally cannot unlock another account's operation", () => {
  const gate = createOperations(() => {});
  const previous = gate.begin("chat")!;
  gate.reset();
  const logout = gate.begin("logout")!;
  previous.refreshing();
  previous.finish();
  assert.equal(gate.current()?.kind, "logout");
  logout.finish();
  const next = gate.begin("complete")!;
  previous.finish();
  logout.finish();
  assert.equal(gate.current()?.kind, "complete");
  next.finish();
  assert.equal(gate.current(), null);
});
