import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { ApiError, createClient } from "./index.js";
const cursor = "a".repeat(20) + "." + "b".repeat(43);
const page = () => ({
  userId: "1",
  filter: "spend",
  entries: [
    {
      id: "credit:9007199254740993",
      kind: "spend",
      direction: "debit",
      amountMicros: 2_170_001,
      createdAt: "2026-11-01T00:00:00.000001Z",
    },
  ],
  nextCursor: null,
});
test("balance history client validates before one credentialed GET with no body and rejects filter/amount corruption", async () => {
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      calls++;
      const u = new URL(String(url));
      assert.equal(u.pathname, "/v1/ai/credit/history");
      assert.equal(u.searchParams.get("filter"), "spend");
      assert.equal(u.searchParams.get("cursor"), cursor);
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(init?.credentials, "include");
      return Response.json(page(), {
        headers: { [CONTRACT_VERSION_HEADER]: "1" },
      });
    },
  });
  assert.deepEqual(
    await client.balanceHistory({ filter: "spend", cursor }),
    page(),
  );
  assert.equal(calls, 1);
  await assert.rejects(client.balanceHistory({ filter: "hold" } as never));
  assert.equal(calls, 1);
  for (const corrupt of [
    (p: ReturnType<typeof page>) => {
      p.filter = "gift";
    },
    (p: ReturnType<typeof page>) => {
      p.entries[0]!.amountMicros = 0.01;
    },
    (p: ReturnType<typeof page>) => {
      p.entries.push(p.entries[0]!);
    },
  ]) {
    const p = page();
    corrupt(p);
    const broken = createClient("http://synthetic", {
      fetch: async () =>
        Response.json(p, { headers: { [CONTRACT_VERSION_HEADER]: "1" } }),
    });
    await assert.rejects(
      broken.balanceHistory({ filter: "spend" }),
      (e) => e instanceof ApiError && e.code === "invalid_response",
    );
  }
});
