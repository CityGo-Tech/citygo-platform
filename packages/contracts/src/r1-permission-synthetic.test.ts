import assert from "node:assert/strict";
import test from "node:test";
import {
  r1SyntheticPermissionSnapshotSchema,
  r1SyntheticPermissionReceiptSchema,
  r1SyntheticPermissionWriteResponseSchema,
  r1SyntheticPermissionReadResponseSchema,
  projectR1SyntheticPermissionScope,
  r1SyntheticPermissionLookupResponseSchema,
  r1SyntheticPermissionRejectionHttpStatus,
} from "./r1-permission-synthetic.js";

const command = {
  schemaVersion: 1 as const,
  requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  expectedRevision: 0,
  action: "grant" as const,
  scope: "citygo_context" as const,
  notice: { id: "a".repeat(64), version: "fixture-v1" },
};
const receipt = {
  eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ownerId: "synthetic-owner",
  scope: "citygo_context" as const,
  revision: 1,
  configurationRevision: 1,
  recordedAt: "2026-10-05T00:00:00.000Z",
  command,
};
const notice = {
  reference: command.notice,
  definition: {
    mode: "synthetic_only" as const,
    scope: "citygo_context" as const,
    version: "fixture-v1",
    body: "Synthetic only; not a legal text.",
    routeDisclosureId: null,
    status: "approved_fixture" as const,
  },
};
const facts = {
  scope: "citygo_context" as const,
  lastDecision: receipt,
  notice,
  route: null,
};
const snapshot = {
  schemaVersion: 1,
  mode: "synthetic_only",
  status: "synthetic_snapshot",
  ownerId: receipt.ownerId,
  configurationRevision: 1,
  scopes: {
    citygo_context: {
      ...facts,
      revision: 1,
      ...projectR1SyntheticPermissionScope(facts),
    },
    ai_transfer: {
      scope: "ai_transfer",
      revision: 0,
      lastDecision: null,
      notice: null,
      route: null,
      grantAvailability: "notice_unavailable",
      resolution: "not_decided",
    },
  },
};

test("lookup accepts only a historical receipt or a bound point-in-time absence, never cancellation/admission", () => {
  const found = { status: "synthetic_recorded", replayed: true, receipt };
  const absent = {
    status: "not_recorded_at_read",
    ownerId: receipt.ownerId,
    scope: receipt.scope,
    requestId: command.requestId,
  };
  for (const valid of [
    found,
    absent,
    { status: "rejected", code: "STORE_NOT_READY" },
    { status: "unavailable", code: "STORAGE_UNAVAILABLE" },
  ])
    assert.equal(
      r1SyntheticPermissionLookupResponseSchema.safeParse(valid).success,
      true,
    );
  for (const invalid of [
    { ...found, replayed: false },
    { ...found, approved: true },
    { ...found, receipt: { ...receipt, scope: "ai_transfer" } },
    { ...absent, final: true },
    { ...absent, requestId: "not-a-uuid" },
    { ...absent, ownerId: "" },
    { status: "cancelled" },
    {
      status: "unconfirmed",
      code: "STORAGE_UNAVAILABLE",
      retry: "same_command",
    },
  ])
    assert.equal(
      r1SyntheticPermissionLookupResponseSchema.safeParse(invalid).success,
      false,
    );
  assert.equal(
    r1SyntheticPermissionWriteResponseSchema.safeParse({
      status: "rejected",
      code: "WRITE_NOT_COMMITTED",
    }).success,
    true,
  );
  assert.equal(
    r1SyntheticPermissionRejectionHttpStatus("WRITE_NOT_COMMITTED"),
    503,
  );
});
test("synthetic response schemas accept bound snapshots, receipts and explicit uncertainty", () => {
  assert.deepEqual(
    r1SyntheticPermissionSnapshotSchema.parse(snapshot),
    snapshot,
  );
  assert.deepEqual(
    r1SyntheticPermissionWriteResponseSchema.parse({
      status: "synthetic_recorded",
      replayed: true,
      receipt,
    }),
    { status: "synthetic_recorded", replayed: true, receipt },
  );
  assert.equal(
    r1SyntheticPermissionWriteResponseSchema.safeParse({
      status: "unconfirmed",
      code: "STORAGE_UNAVAILABLE",
      retry: "same_command",
    }).success,
    true,
  );
  assert.equal(
    r1SyntheticPermissionReadResponseSchema.safeParse({
      status: "unavailable",
      code: "STORAGE_UNAVAILABLE",
    }).success,
    true,
  );
});
test("strict synthetic responses reject extra authority, wrong modes/versions, omissions and coercion", () => {
  for (const extra of [
    { approved: true },
    { admitted: true },
    { mode: "production" },
    { schemaVersion: 2 },
    { configurationRevision: "1" },
  ])
    assert.equal(
      r1SyntheticPermissionSnapshotSchema.safeParse({ ...snapshot, ...extra })
        .success,
      false,
    );
  assert.equal(
    r1SyntheticPermissionSnapshotSchema.safeParse({
      ...snapshot,
      scopes: { citygo_context: snapshot.scopes.citygo_context },
    }).success,
    false,
  );
  assert.equal(
    r1SyntheticPermissionWriteResponseSchema.safeParse({
      status: "unconfirmed",
      code: "STORAGE_UNAVAILABLE",
    }).success,
    false,
  );
  assert.equal(
    r1SyntheticPermissionWriteResponseSchema.safeParse({
      status: "unconfirmed",
      code: "STORAGE_UNAVAILABLE",
      retry: "new_request_id",
    }).success,
    false,
  );
  assert.equal(
    r1SyntheticPermissionReadResponseSchema.safeParse({
      status: "synthetic_snapshot",
      scopes: [],
    }).success,
    false,
  );
});
test("receipt binds scope, server revision, canonical ID, owner and time", () => {
  for (const extra of [
    { scope: "ai_transfer" },
    { revision: 2 },
    { revision: "1" },
    { ownerId: "owner\n" },
    { recordedAt: "yesterday" },
    { eventId: "not-uuid" },
  ])
    assert.equal(
      r1SyntheticPermissionReceiptSchema.safeParse({ ...receipt, ...extra })
        .success,
      false,
    );
  assert.equal(
    r1SyntheticPermissionReceiptSchema.safeParse({
      ...receipt,
      command: { ...command, requestId: command.requestId.toUpperCase() },
    }).success,
    false,
  );
});
test("snapshot cannot relabel a revoked or stale grant as current, nor mix owner/scope/config revisions", () => {
  const state = snapshot.scopes.citygo_context;
  const inputs = [
    { ...snapshot, ownerId: "other" },
    { ...snapshot, configurationRevision: 0 },
    {
      ...snapshot,
      scopes: { ...snapshot.scopes, citygo_context: { ...state, revision: 0 } },
    },
    {
      ...snapshot,
      scopes: {
        ...snapshot.scopes,
        citygo_context: { ...state, scope: "ai_transfer" },
      },
    },
    {
      ...snapshot,
      scopes: {
        ...snapshot.scopes,
        citygo_context: {
          ...state,
          notice: null,
          grantAvailability: "notice_unavailable",
        },
      },
    },
    {
      ...snapshot,
      scopes: {
        ...snapshot.scopes,
        citygo_context: {
          ...state,
          lastDecision: { ...receipt, configurationRevision: 2 },
        },
      },
    },
  ];
  for (const input of inputs)
    assert.equal(
      r1SyntheticPermissionSnapshotSchema.safeParse(input).success,
      false,
    );
  const revoked = {
    ...state,
    lastDecision: {
      ...receipt,
      command: {
        schemaVersion: 1,
        requestId: command.requestId,
        expectedRevision: 0,
        action: "revoke",
        scope: "citygo_context",
      },
    },
  };
  assert.equal(
    r1SyntheticPermissionSnapshotSchema.safeParse({
      ...snapshot,
      scopes: { ...snapshot.scopes, citygo_context: revoked },
    }).success,
    false,
  );
});
test("projection separates historical action from current fixture availability and route", () => {
  assert.equal(
    projectR1SyntheticPermissionScope(facts).resolution,
    "current_fixture_grant",
  );
  assert.equal(
    projectR1SyntheticPermissionScope({ ...facts, notice: null }).resolution,
    "requires_new_action",
  );
  assert.equal(
    projectR1SyntheticPermissionScope({
      ...facts,
      notice: {
        ...notice,
        definition: { ...notice.definition, status: "withdrawn_fixture" },
      },
    }).grantAvailability,
    "notice_not_approved",
  );
  const aiFacts = {
    scope: "ai_transfer" as const,
    notice: {
      ...notice,
      definition: {
        ...notice.definition,
        scope: "ai_transfer" as const,
        routeDisclosureId: "b".repeat(64),
      },
    },
    route: { revision: 2, disclosureId: "b".repeat(64) },
    lastDecision: {
      ...receipt,
      scope: "ai_transfer" as const,
      command: {
        ...command,
        scope: "ai_transfer" as const,
        route: { revision: 1, disclosureId: "b".repeat(64) },
      },
    },
  };
  assert.equal(
    projectR1SyntheticPermissionScope(aiFacts).resolution,
    "requires_new_action",
  );
  assert.equal(
    projectR1SyntheticPermissionScope({ ...aiFacts, route: null })
      .grantAvailability,
    "route_unavailable",
  );
  assert.equal(
    projectR1SyntheticPermissionScope({
      ...aiFacts,
      route: { revision: 2, disclosureId: "c".repeat(64) },
    }).grantAvailability,
    "route_notice_mismatch",
  );
});
