import assert from "node:assert/strict";
import test from "node:test";
import {
  resultDiscussionSourceSchema,
  resultDiscussionParamsSchema,
} from "@citygo/contracts";
import { ApiError, createClient } from "./index.js";
const source = {
  userId: "1",
  kind: "plan" as const,
  id: "9007199254740993",
  revision: 1,
  title: "Шаг",
  text: "Точно 🧳",
  assistantKey: "support" as const,
  interrupted: false,
};
test("discussion source contract rejects invalid identity and client rejects mismatched or private response fields", async () => {
  for (const v of [
    { ...source, kind: "favorites" },
    { ...source, revision: null },
    { ...source, userId: "-1" },
    { ...source, text: "" },
    { ...source, secret: "no" },
  ])
    assert.equal(resultDiscussionSourceSchema.safeParse(v).success, false);
  for (const v of [
    { kind: "plan", id: "../../" },
    { kind: "all", id: "1" },
    { kind: "plan", id: "1", query: "no" },
  ])
    assert.equal(resultDiscussionParamsSchema.safeParse(v).success, false);
  const paths: string[] = [];
  let response: unknown = source;
  const client = createClient("http://synthetic", {
    fetch: async (url) => {
      paths.push(String(url));
      return Response.json(response);
    },
  });
  assert.deepEqual(
    await client.resultDiscussionSource({ kind: "plan", id: source.id }),
    source,
  );
  assert.equal(
    paths[0],
    "http://synthetic/v1/results/plan/9007199254740993/discussion-source",
  );
  response = { ...source, id: "3" };
  await assert.rejects(
    client.resultDiscussionSource({ kind: "plan", id: source.id }),
    (e) => e instanceof ApiError && e.code === "invalid_response",
  );
  const n = paths.length;
  await assert.rejects(
    client.resultDiscussionSource({ kind: "plan", id: "../../" }),
  );
  assert.equal(paths.length, n);
});
