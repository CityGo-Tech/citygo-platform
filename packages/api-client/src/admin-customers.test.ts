import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createClient } from "./index.js";

const at = "2026-10-28T00:00:00.000Z";
const account = {
  userId: "9",
  email: "synthetic@example.test",
  username: null,
  role: "user",
  status: "active",
  createdAt: at,
  lastActivityAt: at,
  emailVerified: true,
  phoneVerified: true,
  giftClaimed: true,
  availableMicros: -1,
  heldMicros: 0,
  spentMicros: 500_000_001,
  messageCount: 2,
  conversationCount: 1,
};
const detail = {
  account,
  analyticsUserId: null,
  profile: null,
  personalPlan: { items: [], nextBeforeId: null },
  favoritesCount: 0,
  activeSessions: 1,
};
const conversation = {
  id: "20",
  agentKey: "housing",
  assistantKey: "housing",
  status: "open",
  createdAt: at,
  lastMessageAt: at,
  messageCount: 2,
};
const message = {
  id: "9007199254740993",
  role: "assistant",
  content: "Синтетический ответ",
  createdAt: at,
};
const item = {
  id: "10",
  title: "Проверить район",
  details: "Синтетический план",
  status: "pending",
  createdAt: at,
  updatedAt: at,
};
const event = {
  id: "message:10",
  kind: "message",
  label: "Отправлено сообщение",
  occurredAt: at,
  conversationId: "20",
  messageId: "10",
  amountMicros: null,
};
const invalid = (error: unknown) =>
  error instanceof ApiError && error.code === "invalid_response";

test("private account explorer sends bounded read-only requests with encoded search/cursors", async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const responses = [
    { accounts: [account], nextAfterUserId: null },
    detail,
    { userId: "9", conversations: [conversation], nextBeforeId: null },
    {
      userId: "9",
      conversationId: "20",
      messages: [message],
      nextBeforeId: null,
    },
    { userId: "9", items: [item], nextBeforeId: null },
    {
      userId: "9",
      items: [{ ...message, messageId: message.id, conversationId: "20" }],
      nextBeforeId: null,
    },
    { userId: "9", events: [event], nextCursor: null },
    {
      days: 7,
      from: at,
      to: at,
      basis: "registered_cohort",
      steps: [{ key: "registered", label: "Зарегистрировались", users: 1 }],
      recentActivity: [],
    },
  ];
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      calls.push({
        path: String(url).replace("http://synthetic", ""),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      return Response.json(responses.shift());
    },
  });
  await client.adminCustomerAccounts({
    search: "a&b@example.test",
    afterUserId: "8",
    limit: 1,
  });
  await client.adminCustomerAccount("9");
  await client.adminCustomerConversations("9", { before: "21" });
  await client.adminCustomerMessages("9", "20", {
    before: "9007199254740994",
    limit: 25,
  });
  await client.adminCustomerPlan("9");
  await client.adminCustomerFavorites("9");
  await client.adminCustomerActivity("9", { before: "opaque_cursor" });
  await client.adminCustomerFunnel({ days: 7 });
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/v1/admin/customer-accounts?search=a%26b%40example.test&afterUserId=8&limit=1",
      "/v1/admin/customer-accounts/9",
      "/v1/admin/customer-accounts/9/conversations?before=21&limit=25",
      "/v1/admin/customer-accounts/9/conversations/20/messages?before=9007199254740994&limit=25",
      "/v1/admin/customer-accounts/9/plan?limit=25",
      "/v1/admin/customer-accounts/9/favorites?limit=25",
      "/v1/admin/customer-accounts/9/activity?before=opaque_cursor&limit=50",
      "/v1/admin/customer-funnel?days=7",
    ],
  );
  assert(
    calls.every((call) => call.method === "GET" && call.body === undefined),
  );
});

test("private explorer rejects malformed identifiers and unsupported query fields before transport", async () => {
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  for (const id of [
    "0",
    "01",
    "-1",
    "9/../10",
    "9?userId=10",
    "9".repeat(19),
  ]) {
    await assert.rejects(client.adminCustomerAccount(id));
    await assert.rejects(client.adminCustomerMessages("9", id));
  }
  await assert.rejects(client.adminCustomerAccounts({ limit: 100 }));
  await assert.rejects(
    client.adminCustomerAccounts({ search: "x".repeat(101) }),
  );
  await assert.rejects(
    client.adminCustomerMessages("9", "20", { before: "1&export=true" }),
  );
  await assert.rejects(client.adminCustomerFunnel({ days: 91 }));
  assert.equal(calls, 0);
});

test("private reads reject another account or conversation even from an otherwise valid response", async () => {
  const cases: [
    unknown,
    (client: ReturnType<typeof createClient>) => Promise<unknown>,
  ][] = [
    [
      { ...detail, account: { ...account, userId: "10" } },
      (api) => api.adminCustomerAccount("9"),
    ],
    [
      { userId: "10", conversations: [], nextBeforeId: null },
      (api) => api.adminCustomerConversations("9"),
    ],
    [
      { userId: "10", conversationId: "20", messages: [], nextBeforeId: null },
      (api) => api.adminCustomerMessages("9", "20"),
    ],
    [
      { userId: "9", conversationId: "21", messages: [], nextBeforeId: null },
      (api) => api.adminCustomerMessages("9", "20"),
    ],
    [
      { userId: "10", items: [], nextBeforeId: null },
      (api) => api.adminCustomerPlan("9"),
    ],
    [
      { userId: "10", items: [], nextBeforeId: null },
      (api) => api.adminCustomerFavorites("9"),
    ],
    [
      { userId: "10", events: [], nextCursor: null },
      (api) => api.adminCustomerActivity("9"),
    ],
  ];
  for (const [response, call] of cases) {
    const client = createClient("http://synthetic", {
      fetch: async () => Response.json(response),
    });
    await assert.rejects(call(client), invalid);
  }
});

test("history pagination preserves bigint ordering and rejects duplicates, stale cursors and leaked secrets", async () => {
  const pages = [
    {
      userId: "9",
      conversationId: "20",
      messages: [message, message],
      nextBeforeId: null,
    },
    {
      userId: "9",
      conversationId: "20",
      messages: [message, { ...message, id: "9007199254740992" }],
      nextBeforeId: null,
    },
    {
      userId: "9",
      conversationId: "20",
      messages: [message],
      nextBeforeId: "9007199254740992",
    },
    {
      userId: "9",
      conversationId: "20",
      messages: [{ ...message, providerToken: "must-not-escape" }],
      nextBeforeId: null,
    },
  ];
  for (const page of pages) {
    const client = createClient("http://synthetic", {
      fetch: async () => Response.json(page),
    });
    await assert.rejects(client.adminCustomerMessages("9", "20"), invalid);
  }
  const client = createClient("http://synthetic", {
    fetch: async () =>
      Response.json({
        userId: "9",
        conversationId: "20",
        messages: [message],
        nextBeforeId: null,
      }),
  });
  await assert.rejects(
    client.adminCustomerMessages("9", "20", { before: message.id }),
    invalid,
  );
});

test("analytics client sends only the allowlisted event, never text or account contact fields", async () => {
  const bodies: unknown[] = [];
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      if (String(url).endsWith("/identity"))
        return Response.json({ analyticsUserId: "cga_" + "a".repeat(64) });
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return Response.json({ recorded: true });
    },
  });
  assert.equal(
    (await client.analyticsIdentity()).analyticsUserId,
    "cga_" + "a".repeat(64),
  );
  await client.recordProductEvent("wallet_opened");
  assert.deepEqual(bodies, [{ event: "wallet_opened" }]);
  await assert.rejects(client.recordProductEvent("message text" as never));
  await assert.rejects(
    client.recordProductEvent({
      event: "wallet_opened",
      email: "private@example.test",
    } as never),
  );
  assert.equal(bodies.length, 1);
});
