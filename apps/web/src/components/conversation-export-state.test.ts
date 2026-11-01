import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import type { ConversationExportSnapshot } from "@citygo/contracts";
import {
  createConversationExportAction,
  conversationExportText,
  conversationExportFilename,
  type ConversationExportState,
} from "./conversation-export-state";
const value: ConversationExportSnapshot = {
  version: 1,
  userId: "1",
  thread: {
    id: "9007199254740993",
    agentKey: "support",
    assistantKey: null,
    closed: true,
  },
  generatedAt: "2026-11-01T10:00:00Z",
  messages: [
    {
      id: "1",
      role: "user",
      content: "Старый вопрос😀\n<script>literal</script>",
      agentKey: "support",
      status: "complete",
      failureCode: null,
      createdAt: "2026-11-01T09:00:00Z",
    },
    {
      id: "9007199254740994",
      role: "assistant",
      content: "Полный прерванный фрагмент",
      agentKey: "housing",
      status: "interrupted",
      failureCode: null,
      createdAt: "2026-11-01T09:01:00Z",
    },
    {
      id: "9007199254740995",
      role: "assistant",
      content: "",
      agentKey: "support",
      status: "interrupted",
      failureCode: "AI_CREDIT_EXHAUSTED",
      createdAt: "2026-11-01T09:02:00Z",
    },
  ],
};
test("TXT preserves whole Unicode texts, persisted interruption states, empty history and safe exact-ID filename", () => {
  const text = conversationExportText(value);
  assert.ok(text.includes(value.messages[0]!.content));
  assert.ok(text.includes(value.messages[1]!.content));
  assert.ok(
    text.indexOf(value.messages[0]!.content) <
      text.indexOf(value.messages[1]!.content),
  );
  assert.match(text, /Ответ прерван/);
  assert.match(text, /недостаточно средств/);
  assert.equal(
    conversationExportFilename(value),
    "citygo-dialog-9007199254740993.txt",
  );
  assert.match(
    conversationExportText({ ...value, messages: [] }),
    /пока нет сохранённых сообщений/,
  );
  assert.throws(() =>
    conversationExportFilename({
      ...value,
      thread: { ...value.thread, id: "../private\n" },
    }),
  );
});
test("export is explicit, coalesces concurrent clicks and drops cancelled/session/owner/thread/disabled late results", async () => {
  for (const reason of [
    "cancel",
    "logout",
    "dispose",
    "owner",
    "thread",
    "disabled",
  ]) {
    let resolve!: (value: ConversationExportSnapshot) => void,
      reads = 0,
      downloads = 0;
    const session = new AbortController();
    let current = {
      userId: "1",
      threadId: value.thread.id,
      signal: session.signal,
      enabled: true,
    };
    const action = createConversationExportAction({
      scope: current,
      current: () => current,
      read: () => {
        reads++;
        return new Promise((done) => (resolve = done));
      },
      download: () => downloads++,
      publish: () => {},
      onAccessDenied: () => assert.fail(),
    });
    assert.equal(reads, 0);
    const pending = action.run();
    await action.run();
    assert.equal(reads, 1);
    if (reason === "cancel") action.cancel();
    else if (reason === "logout") session.abort();
    else if (reason === "dispose") action.dispose();
    else
      current = {
        ...current,
        ...(reason === "owner"
          ? { userId: "2" }
          : reason === "thread"
            ? { threadId: "2" }
            : { enabled: false }),
      };
    resolve(value);
    await pending;
    assert.equal(downloads, 0);
    action.dispose();
  }
});
test("cancelled first request cannot complete a newer export and completed downloads can run again explicitly", async () => {
  const pending: ((value: ConversationExportSnapshot) => void)[] = [];
  const session = new AbortController();
  const current = {
    userId: "1",
    threadId: value.thread.id,
    signal: session.signal,
    enabled: true,
  };
  let downloads = 0;
  const action = createConversationExportAction({
    scope: current,
    current: () => current,
    read: () => new Promise((done) => pending.push(done)),
    download: (text, name) => {
      downloads++;
      assert.equal(text, conversationExportText(value));
      assert.equal(name, conversationExportFilename(value));
    },
    publish: () => {},
    onAccessDenied: () => assert.fail(),
  });
  const first = action.run();
  action.cancel();
  const second = action.run();
  pending[0]!(value);
  await first;
  assert.equal(downloads, 0);
  pending[1]!(value);
  await second;
  assert.equal(downloads, 1);
  action.dispose();
});
test("foreign scope closes access, known limit errors are useful and raw server errors never appear", async () => {
  const session = new AbortController();
  const current = {
    userId: "1",
    threadId: value.thread.id,
    signal: session.signal,
    enabled: true,
  };
  let denied = 0,
    downloads = 0;
  for (const changed of [
    { ...value, userId: "2" },
    { ...value, thread: { ...value.thread, id: "2" } },
  ]) {
    const a = createConversationExportAction({
      scope: current,
      current: () => current,
      read: async () => changed,
      download: () => downloads++,
      publish: () => {},
      onAccessDenied: () => denied++,
    });
    await a.run();
    a.dispose();
  }
  assert.equal(denied, 2);
  assert.equal(downloads, 0);
  for (const code of [401, 403, 404, 413, 500]) {
    const states: ConversationExportState[] = [];
    const a = createConversationExportAction({
      scope: current,
      current: () => current,
      read: async () => {
        throw new ApiError(code, "PRIVATE_SERVER_CONTENT");
      },
      download: () => assert.fail(),
      publish: (s) => states.push(s),
      onAccessDenied: () => denied++,
    });
    await a.run();
    if ([404, 413, 500].includes(code)) {
      assert.ok(states.at(-1)!.error);
      assert(!JSON.stringify(states).includes("PRIVATE"));
      assert.equal(states.at(-1)!.started, false);
    }
    a.dispose();
  }
  assert.equal(denied, 4);
});

test("browser download failure never claims success and stays explicitly retryable", async () => {
  const session = new AbortController();
  const current = {
    userId: "1",
    threadId: value.thread.id,
    signal: session.signal,
    enabled: true,
  };
  const states: ConversationExportState[] = [];
  let downloads = 0;
  const action = createConversationExportAction({
    scope: current,
    current: () => current,
    read: async () => value,
    download: () => {
      downloads++;
      throw new Error("PRIVATE_BROWSER_DETAIL");
    },
    publish: (state) => states.push(state),
    onAccessDenied: () => assert.fail(),
  });
  await action.run();
  assert.equal(downloads, 1);
  assert.equal(states.at(-1)!.started, false);
  assert.equal(states.at(-1)!.busy, false);
  assert.ok(states.at(-1)!.error);
  assert(!JSON.stringify(states).includes("PRIVATE"));
  await action.run();
  assert.equal(downloads, 2);
  action.dispose();
});
