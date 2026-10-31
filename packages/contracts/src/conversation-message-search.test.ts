import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationMessageSearchQuerySchema as query,
  conversationMessageSearchPageSchema as page,
} from "./conversation-message-search.js";
const hit = (id: string) => ({
  messageId: id,
  role: "user",
  agentKey: "support",
  status: "complete",
  snippet: "Москва",
});
const valid = () => ({
  userId: "1",
  threadId: "9007199254740993",
  search: "Москва",
  matches: [hit("9223372036854775807"), hit("9007199254740993")],
  nextCursor: null,
});
test("message search contract accepts bounded literal Unicode and exact int64 IDs, rejects extra or malformed inputs", () => {
  assert.deepEqual(
    query.parse({
      search: "  50%_\\Москва 😀  ",
      before: "9223372036854775807",
    }),
    { search: "50%_\\Москва 😀", before: "9223372036854775807" },
  );
  for (const value of [
    { search: "" },
    { search: "x".repeat(161) },
    { search: "\0" },
    { search: "\ud800" },
    { search: "x", before: "9007199254740993\n" },
    { search: "x", userId: "2" },
    { search: "x", limit: 1000 },
  ])
    assert.equal(query.safeParse(value).success, false);
  assert.deepEqual(page.parse(valid()), valid());
});
test("message search response refuses duplicates, wrong order, oversized snippets and fabricated continuation", () => {
  for (const mutate of [
    (v: ReturnType<typeof valid>) => v.matches.reverse(),
    (v: ReturnType<typeof valid>) =>
      v.matches.push(hit(v.matches[0]!.messageId)),
    (v: ReturnType<typeof valid>) => (v.matches[0]!.snippet = "x".repeat(513)),
    (v: ReturnType<typeof valid>) => (v.nextCursor = "1" as never),
    (v: ReturnType<typeof valid>) => (v.matches[0]!.messageId = "invalid"),
  ]) {
    const value = valid();
    mutate(value);
    assert.equal(page.safeParse(value).success, false);
  }
  const matches = Array.from({ length: 20 }, (_, i) => hit(String(100 - i)));
  assert.equal(
    page.safeParse({ ...valid(), matches, nextCursor: "81" }).success,
    true,
  );
});
