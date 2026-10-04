import test from "node:test";
import assert from "node:assert/strict";
import {
  housingListQuerySchema,
  housingRecoveryQuerySchema,
  housingGetQuerySchema,
  housingHistoryQuerySchema,
  housingStorageLimitsSchema,
  housingListResponseSchema,
} from "./housing-api.js";

test("housing query numbers are canonical bounded wire strings, with no owner or extra fields", () => {
  assert.deepEqual(
    housingListQuerySchema.parse({
      planId: "1",
      planVersion: "2",
      limit: "50",
    }),
    {
      planId: "1",
      planVersion: 2,
      limit: 50,
    },
  );
  for (const value of [
    "0",
    "01",
    "+1",
    "1.0",
    "1e0",
    " 1",
    "1 ",
    "Infinity",
    "2147483648",
    ["1", "2"],
    1,
  ])
    assert.equal(
      housingRecoveryQuerySchema.safeParse({ planId: "1", planVersion: value })
        .success,
      false,
    );
  for (const value of ["0", "51", "01", "1e1", ["1", "2"]])
    assert.equal(
      housingListQuerySchema.safeParse({
        planId: "1",
        planVersion: "1",
        limit: value,
      }).success,
      false,
    );
  for (const extra of [
    { ownerId: "2" },
    { note: "private" },
    { cursor: "free" },
  ])
    assert.equal(
      housingListQuerySchema.safeParse({
        planId: "1",
        planVersion: "1",
        ...extra,
      }).success,
      false,
    );
  assert.equal(
    housingGetQuerySchema.safeParse({ revision: "01" }).success,
    false,
  );
  assert.equal(
    housingHistoryQuerySchema.safeParse({ beforeRevision: "2147483648" })
      .success,
    false,
  );
  assert.equal(
    housingListQuerySchema.safeParse({
      planId: "9223372036854775808",
      planVersion: "1",
    }).success,
    false,
  );
});

test("storage caps are explicit bounded integers; zero closes new writes", () => {
  const limits = housingStorageLimitsSchema.parse({});
  assert.deepEqual(limits, {
    briefsPerOwner: 100,
    briefsPerPlan: 10,
    commandsPerOwner: 1000,
    revisionsPerBrief: 250,
    commandBytes: 16384,
    snapshotBytes: 65536,
  });
  for (const [key, max] of Object.entries(limits)) {
    for (const value of [-1, 0.5, max + 1, Infinity, "1"])
      assert.equal(
        housingStorageLimitsSchema.safeParse({ [key]: value }).success,
        false,
      );
    assert.equal(
      housingStorageLimitsSchema.safeParse({ [key]: 0 }).success,
      !key.endsWith("Bytes"),
    );
  }
  assert.equal(
    housingStorageLimitsSchema.safeParse({ retentionDays: 30 }).success,
    false,
  );
});

test("selection DTO is content-free and bounded, without inventing a preferred draft", () => {
  const item = {
    id: "1",
    revision: 1,
    plan: { id: "1", version: 1 },
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  };
  assert.equal(
    housingListResponseSchema.safeParse({ items: [item], nextBeforeId: null })
      .success,
    true,
  );
  for (const extra of [
    { content: {} },
    { preferred: true },
    { title: "private" },
  ])
    assert.equal(
      housingListResponseSchema.safeParse({
        items: [{ ...item, ...extra }],
        nextBeforeId: null,
      }).success,
      false,
    );
  assert.equal(
    housingListResponseSchema.safeParse({
      items: Array(51).fill(item),
      nextBeforeId: null,
    }).success,
    false,
  );
});
