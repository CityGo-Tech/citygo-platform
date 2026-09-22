import test from "node:test";
import assert from "node:assert/strict";
import {
  apiErrorResponseSchema,
  errorMetadata,
  supportsContractVersion,
} from "./protocol.js";
import { streamEventSchema } from "./responses.js";
import {
  r1ProfileSchema,
  r1PlanSchema,
  r1QuestSchema,
  r1ArtifactMetadataSchema,
  r1RunSchema,
  r1SourceSchema,
  r1HumanCaseSchema,
  r1PageRequestSchema,
  r1CommandSchema,
} from "./r1.js";

const base = { schemaVersion: 1, id: "1", revision: 1, ownerId: "user-1" };
const ref = { id: "1", revision: 1 };
const date = "2026-09-23T00:00:00Z";
const requestId = "7c31f2e0-76ef-4e1c-876a-fd546cf2d6f4";
const samples = [
  [
    "profile",
    r1ProfileSchema,
    {
      ...base,
      data: {
        originCity: "Казань",
        targetCity: "Москва",
        monthlyBudget: 50000,
        moveTargetDate: "2000-01-01",
        household: "solo",
      },
    },
  ],
  [
    "plan",
    r1PlanSchema,
    { ...base, profile: ref, status: "active", quests: [ref] },
  ],
  [
    "quest",
    r1QuestSchema,
    { ...base, plan: ref, definition: ref, state: "available", xpReward: 60 },
  ],
  [
    "artifact metadata",
    r1ArtifactMetadataSchema,
    {
      ...base,
      plan: ref,
      quest: ref,
      kind: "housing_brief",
      sources: [],
      createdAt: date,
    },
  ],
  [
    "run",
    r1RunSchema,
    {
      ...base,
      threadId: "1",
      requestId,
      plan: ref,
      quest: ref,
      agentKey: "housing",
      status: "rejected",
      artifacts: [],
    },
  ],
  [
    "source",
    r1SourceSchema,
    {
      ...base,
      kind: "synthetic",
      title: "Synthetic fixture",
      url: null,
      jurisdiction: "RU-MOW",
      scope: "Housing pilot fixture",
      reviewedAt: null,
      validUntil: null,
      status: "draft",
    },
  ],
  [
    "human case",
    r1HumanCaseSchema,
    {
      ...base,
      plan: null,
      threadId: null,
      status: "submitted",
      operatorId: null,
      createdAt: date,
      updatedAt: date,
    },
  ],
] as const;
for (const [name, schema, sample] of samples) {
  test(`R1 ${name} validates explicit versions and rejects malformed metadata`, () => {
    assert.equal(schema.safeParse(sample).success, true);
    assert.equal(
      schema.safeParse({ ...sample, additiveFutureField: true }).success,
      true,
    );
    for (const patch of [
      { schemaVersion: 2 },
      { schemaVersion: undefined },
      { revision: 0 },
      { revision: "1" },
      { id: " " },
    ])
      assert.equal(
        schema.safeParse({ ...sample, ...patch }).success,
        false,
        JSON.stringify(patch),
      );
    if (name !== "source")
      assert.equal(
        schema.safeParse({ ...sample, ownerId: undefined }).success,
        false,
      );
  });
}
test("R1 references, states and pagination are bounded; legacy rows are not silently upgraded", () => {
  assert.equal(
    r1PlanSchema.safeParse({ ...samples[1][2], quests: [ref, ref] }).success,
    false,
  );
  assert.equal(
    r1QuestSchema.safeParse({ ...samples[2][2], plan: { id: "1" } }).success,
    false,
  );
  assert.equal(
    r1QuestSchema.safeParse({ ...samples[2][2], state: "unknown" }).success,
    false,
  );
  assert.equal(
    r1ArtifactMetadataSchema.safeParse({ ...samples[3][2], kind: "resume" })
      .success,
    false,
  );
  assert.equal(
    r1RunSchema.safeParse({ ...samples[4][2], status: "success" }).success,
    false,
  );
  assert.equal(
    r1SourceSchema.safeParse({ ...samples[5][2], url: "javascript:alert(1)" })
      .success,
    false,
  );
  assert.equal(
    r1HumanCaseSchema.safeParse({ ...samples[6][2], status: "online" }).success,
    false,
  );
  assert.deepEqual(r1PageRequestSchema.parse({}), { limit: 20 });
  for (const limit of [0, 101, "20"])
    assert.equal(r1PageRequestSchema.safeParse({ limit }).success, false);
  assert.equal(
    r1CommandSchema.safeParse({
      schemaVersion: 1,
      requestId,
      expectedVersion: 1,
    }).success,
    true,
  );
  assert.equal(
    r1CommandSchema.safeParse({
      schemaVersion: 1,
      requestId,
      expectedVersion: 0,
    }).success,
    false,
  );
  assert.equal(
    r1CommandSchema.safeParse({
      schemaVersion: 1,
      requestId,
      expectedVersion: 1,
      awardXp: 60,
    }).success,
    false,
  );
});
test("wire v1 supports headerless clients but never coerces unsupported versions", () => {
  for (const version of [undefined, null, "1"])
    assert.equal(supportsContractVersion(version), true);
  for (const version of ["", "0", "2", "1,2", "01", " 1 ", ["1"], 1])
    assert.equal(supportsContractVersion(version), false);
});
test("legacy and enriched HTTP/SSE errors remain readable; unknown codes have a safe fallback", () => {
  assert.deepEqual(apiErrorResponseSchema.parse({ error: "Legacy" }), {
    error: "Legacy",
  });
  const metadata = errorMetadata("REVISION_CONFLICT", requestId, 2);
  assert.deepEqual(
    apiErrorResponseSchema.parse({ error: "Refresh", ...metadata }),
    { error: "Refresh", ...metadata },
  );
  assert.equal(
    apiErrorResponseSchema.safeParse({ error: "Refresh", code: "FUTURE_CODE" })
      .success,
    true,
  );
  assert.equal(
    apiErrorResponseSchema.safeParse({ error: "Refresh", retryable: "true" })
      .success,
    false,
  );
  assert.equal(
    streamEventSchema.safeParse({ type: "error", message: "Legacy" }).success,
    true,
  );
  assert.equal(
    streamEventSchema.safeParse({
      type: "error",
      message: "Refresh",
      ...metadata,
    }).success,
    true,
  );
  assert.equal(
    streamEventSchema.safeParse({
      type: "error",
      message: "Refresh",
      contractVersion: "2",
    }).success,
    false,
  );
});
