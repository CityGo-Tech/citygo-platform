import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createClient } from "./index.js";

test("knowledge client sends only the selected key and scope and rejects unrelated published evidence", async () => {
  const request = {
    factKey: "housing.rent.first_payment",
    scope: { kind: "global" },
    limit: 1,
  } as const;
  const fact = {
    fact: { id: "synthetic-rent", revision: 2 },
    factKey: request.factKey,
    scope: request.scope,
    statement: "Synthetic first-payment guidance.",
    reviewedAt: "2026-11-20T12:00:00Z",
    validUntil: "2026-12-20T12:00:00Z",
    evidence: [
      {
        source: { id: "synthetic-guide", revision: 2 },
        title: "Synthetic guide",
        publisher: "Synthetic publisher",
        url: "https://source.example.com/synthetic-guide",
        quote: "Synthetic first-payment guidance.",
        reviewedAt: "2026-11-19T12:00:00Z",
        validUntil: "2026-12-20T12:00:00Z",
      },
    ],
  };
  const hit = {
    status: "hit",
    researchNeeded: false,
    matches: [fact],
  };
  let response: unknown = hit;
  const calls: { path: string; method?: string; body: unknown }[] = [];
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      calls.push({
        path: String(url),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json(response);
    },
  });

  assert.deepEqual(await client.lookupKnowledge(request), hit);
  assert.deepEqual(calls, [
    {
      path: "http://synthetic/v1/knowledge/lookup",
      method: "POST",
      body: request,
    },
  ]);
  for (const matches of [
    [{ ...fact, factKey: "another.topic" }],
    [{ ...fact, scope: { kind: "city", cityId: "another-city" } }],
    [fact, fact],
  ]) {
    response = { ...hit, matches };
    await assert.rejects(
      client.lookupKnowledge(request),
      (error) => error instanceof ApiError && error.code === "invalid_response",
    );
  }
});
