import assert from "node:assert/strict";
import test from "node:test";
import { createClient, ApiError } from "./index.js";
import type {
  SupportRequest,
  SupportRequestsPage,
  AdminSupportRequestsPage,
} from "@citygo/contracts";
const item: SupportRequest = {
  id: "9007199254740993",
  operationId: "41111111-1111-4111-8111-111111111111",
  body: "Помогите разобраться с первым шагом моего переезда.",
  status: "open",
  revision: 1,
  createdAt: "2026-10-30T10:00:00Z",
  updatedAt: "2026-10-30T10:00:00Z",
  closedAt: null,
};
const invalid = (error: unknown) =>
  error instanceof ApiError && error.code === "invalid_response";
test("validated support pages retain owner identity and the complete request DTO in public method types", async () => {
  let response: unknown = { userId: "1", requests: [item], nextBefore: null };
  const client = createClient("http://synthetic", {
    fetch: async () => Response.json(response),
  });
  const ownerPage: SupportRequestsPage = await client.supportRequests();
  assert.equal(ownerPage.userId, "1");
  assert.deepEqual(ownerPage.requests[0], item);
  const adminItem = {
    ...item,
    owner: { userId: "1", email: "synthetic@example.test", username: null },
  };
  response = { actorId: "2", requests: [adminItem], nextBefore: null };
  const adminPage: AdminSupportRequestsPage =
    await client.adminSupportRequests();
  assert.equal(adminPage.actorId, "2");
  assert.deepEqual(adminPage.requests[0], adminItem);
});
test("support client validates before transport, uses exact verbs and verifies operation/body/id plus bigint pagination", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let response: unknown = { userId: "1", request: item };
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init!.method!,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(response);
    },
  });
  await client.createSupportRequest({
    operationId: item.operationId,
    body: item.body,
  });
  assert.equal(calls[0]?.method, "POST");
  response = {
    userId: "1",
    request: { ...item, operationId: "51111111-1111-4111-8111-111111111111" },
  };
  await assert.rejects(
    client.createSupportRequest({
      operationId: item.operationId,
      body: item.body,
    }),
    invalid,
  );
  response = { userId: "1", requests: [item, item], nextBefore: null };
  await assert.rejects(client.supportRequests(), invalid);
  response = { userId: "1", requests: [item], nextBefore: null };
  await assert.rejects(client.supportRequests({ before: item.id }), invalid);
  await assert.rejects(client.supportRequests({ status: "closed" }), invalid);
  const admin = {
    ...item,
    owner: { userId: "1", email: "synthetic@example.test", username: null },
  };
  response = { actorId: "2", request: admin };
  await client.adminSupportRequest(item.id);
  response = {
    actorId: "2",
    request: {
      ...admin,
      status: "closed",
      revision: 2,
      closedAt: item.updatedAt,
    },
  };
  await client.setSupportRequestStatus(item.id, {
    expectedRevision: 1,
    status: "closed",
  });
  assert.equal(calls.at(-1)?.method, "PATCH");
  const before = calls.length;
  await assert.rejects(
    client.createSupportRequest({ operationId: item.operationId, body: "bad" }),
  );
  assert.equal(calls.length, before);
});

test("human reply client rejects foreign request, changed body, duplicate pages and invalid commands before transport", async () => {
  const reply = {
    id: "9007199254740995",
    requestId: item.id,
    operationId: "51111111-1111-4111-8111-111111111111",
    body: "Начните со списка подходящих районов.",
    createdAt: item.createdAt,
  };
  const command = {
    operationId: reply.operationId,
    expectedRevision: 1,
    body: reply.body,
  };
  let response: unknown = {
    actorId: "2",
    request: {
      ...item,
      revision: 2,
      owner: { userId: "1", email: "synthetic@example.test", username: null },
    },
    reply,
  };
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async () => {
      calls++;
      return Response.json(response);
    },
  });
  await client.replyToSupportRequest(item.id, command);
  const before = calls;
  await assert.rejects(
    client.replyToSupportRequest(item.id, { ...command, body: "\0" }),
  );
  assert.equal(calls, before);
  response = {
    ...(response as object),
    reply: { ...reply, body: "Другой ответ" },
  };
  await assert.rejects(client.replyToSupportRequest(item.id, command), invalid);
  response = {
    userId: "1",
    requestId: item.id,
    replies: [{ ...reply, requestId: "2" }],
    nextBefore: null,
  };
  await assert.rejects(client.supportReplies(item.id), invalid);
  response = {
    userId: "1",
    requestId: item.id,
    replies: [reply, reply],
    nextBefore: null,
  };
  await assert.rejects(client.supportReplies(item.id), invalid);
  response = {
    userId: "1",
    requestId: item.id,
    replies: [reply],
    nextBefore: reply.id,
  };
  await assert.rejects(client.supportReplies(item.id), invalid);
  response = {
    userId: "1",
    requestId: item.id,
    replies: [reply],
    nextBefore: null,
  };
  await assert.rejects(
    client.supportReplies(item.id, { before: reply.id }),
    invalid,
  );
});

test("support unread client validates cursor/page identity and never acknowledges a GET", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let response: unknown = {
    userId: "1",
    unreadRequests: 1,
    unreadReplies: 1,
    requests: [
      { requestId: item.id, lastReplyId: "9007199254740999", unreadReplies: 1 },
    ],
    nextBefore: null,
  };
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init!.method!,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(response);
    },
  });
  await client.supportUpdates();
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.body, null);
  await assert.rejects(client.supportUpdates({ before: item.id }), invalid);
  response = {
    userId: "1",
    unreadRequests: 2,
    unreadReplies: 2,
    requests: [
      { requestId: item.id, lastReplyId: "2", unreadReplies: 1 },
      { requestId: item.id, lastReplyId: "3", unreadReplies: 1 },
    ],
    nextBefore: null,
  };
  await assert.rejects(client.supportUpdates(), invalid);
  response = { userId: "1", request: item };
  await client.supportRequest(item.id);
  await assert.rejects(client.supportRequest("2"), invalid);
  response = {
    userId: "1",
    requestId: item.id,
    throughReplyId: "9007199254740999",
    unreadReplies: 0,
  };
  await client.markSupportRepliesRead(item.id, {
    throughReplyId: "9007199254740998",
  });
  assert.equal(calls.at(-1)!.method, "POST");
  assert.deepEqual(calls.at(-1)!.body, { throughReplyId: "9007199254740998" });
  await assert.rejects(
    client.markSupportRepliesRead("2", { throughReplyId: "3" }),
    invalid,
  );
  await assert.rejects(
    client.markSupportRepliesRead(item.id, {
      throughReplyId: "9007199254741000",
    }),
    invalid,
  );
  const count = calls.length;
  await assert.rejects(
    client.markSupportRepliesRead(item.id, { throughReplyId: "0" }),
  );
  assert.equal(calls.length, count);
});
