import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { createClient, ApiError } from "./index.js";
const headers = { [CONTRACT_VERSION_HEADER]: "1" };
const value = {
  userId: "1",
  threadId: "9007199254740993",
  title: null as string | null,
  revision: "0",
  updatedAt: null as string | null,
};
test("title client uses exact thread and CAS IDs, PATCH, credentials and a trimmed bounded body", async () => {
  let n = 0;
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      assert.equal(
        String(url),
        "http://synthetic/v1/conversations/9007199254740993/title",
      );
      assert.equal(init!.credentials, "include");
      n++;
      if (n === 1) {
        assert.equal(init!.method, "GET");
        assert.equal(init!.body, undefined);
        return Response.json(value, { headers });
      }
      assert.equal(init!.method, "PATCH");
      assert.deepEqual(JSON.parse(init!.body as string), {
        title: "Жильё",
        expectedRevision: "9007199254740993",
      });
      return Response.json(
        {
          ...value,
          title: "Жильё",
          revision: "9007199254740994",
          updatedAt: "2026-11-01T00:00:00Z",
        },
        { headers },
      );
    },
  });
  await client.conversationTitle(value.threadId);
  await client.updateConversationTitle(value.threadId, {
    title: "  Жильё  ",
    expectedRevision: "9007199254740993",
  });
  assert.equal(n, 2);
});
test("title client rejects wrong thread, content or revision echoes and invalid input before transport", async () => {
  for (const result of [
    { ...value, threadId: "2" },
    { ...value, title: "other", revision: "1" },
    { ...value, title: "Жильё", revision: "3" },
  ]) {
    const client = createClient("http://synthetic", {
      fetch: async () => Response.json(result, { headers }),
    });
    await assert.rejects(
      client.updateConversationTitle(value.threadId, {
        title: "Жильё",
        expectedRevision: "0",
      }),
      (e) => e instanceof ApiError && e.code === "invalid_response",
    );
  }
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async () => {
      calls++;
      return Response.json(value, { headers });
    },
  });
  await assert.rejects(
    client.updateConversationTitle(value.threadId, {
      title: "\n",
      expectedRevision: "0",
    }),
  );
  assert.equal(calls, 0);
});
