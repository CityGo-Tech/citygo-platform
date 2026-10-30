import assert from "node:assert/strict";
import test from "node:test";
import { createClient, ApiError } from "./index.js";
import type { SupportRequest } from "@citygo/contracts";
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
