import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { ApiError, createClient } from "./index.js";
const headers = { [CONTRACT_VERSION_HEADER]: "1" };
const result = () => ({
  userId: "1",
  threadId: "9007199254740993",
  search: "50%_\\Москва",
  matches: [
    {
      messageId: "9007199254740994",
      role: "user",
      agentKey: "support",
      status: "complete",
      snippet: "50%_\\Москва",
    },
  ],
  nextCursor: null,
});
test("search client sends one encoded authenticated GET with exact IDs and no request body", async () => {
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      calls++;
      const u = new URL(String(url));
      assert.equal(
        u.pathname,
        "/v1/conversations/9007199254740993/messages/search",
      );
      assert.deepEqual(Object.fromEntries(u.searchParams), {
        search: "50%_\\Москва",
        before: "9223372036854775807",
      });
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(init?.credentials, "include");
      return Response.json(result(), { headers });
    },
  });
  assert.deepEqual(
    await client.searchConversationMessages(
      "9007199254740993",
      "  50%_\\Москва ",
      "9223372036854775807",
    ),
    result(),
  );
  assert.equal(calls, 1);
});
test("search client rejects mismatched thread/query or a result outside the requested keyset", async () => {
  for (const mutate of [
    (r: ReturnType<typeof result>) => (r.threadId = "2"),
    (r: ReturnType<typeof result>) => (r.search = "other"),
    (r: ReturnType<typeof result>) =>
      (r.matches[0]!.messageId = "9223372036854775807"),
  ]) {
    const data = result();
    mutate(data);
    const client = createClient("http://synthetic", {
      fetch: async () => Response.json(data, { headers }),
    });
    await assert.rejects(
      client.searchConversationMessages(
        "9007199254740993",
        "50%_\\Москва",
        "9223372036854775807",
      ),
      (e) => e instanceof ApiError && e.code === "invalid_response",
    );
  }
});
