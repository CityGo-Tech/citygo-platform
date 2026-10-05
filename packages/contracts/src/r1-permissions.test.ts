import assert from "node:assert/strict";
import test from "node:test";
import { aiConsentSchema } from "./ai-access.js";
import {
  r1PermissionCommandSchema,
  r1ContextPermissionCommandSchema,
  r1AiPermissionCommandSchema,
  r1NoticeReferenceSchema,
} from "./r1-permissions.js";

// Synthetic references only: no registered/approved notice exists for these IDs.
const base = {
  schemaVersion: 1,
  requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  expectedRevision: 0,
};
const notice = { id: "a".repeat(64), version: "r1-synthetic-v1" };
const route = { revision: 1, disclosureId: "b".repeat(64) };
const contextGrant = {
  ...base,
  scope: "citygo_context",
  action: "grant",
  notice,
};
const aiGrant = {
  ...base,
  scope: "ai_transfer",
  action: "grant",
  notice,
  route,
};

test("context and AI actions have independent shapes and references", () => {
  assert.deepEqual(
    r1ContextPermissionCommandSchema.parse(contextGrant),
    contextGrant,
  );
  assert.deepEqual(r1AiPermissionCommandSchema.parse(aiGrant), aiGrant);
  assert.equal(
    r1ContextPermissionCommandSchema.safeParse(aiGrant).success,
    false,
  );
  assert.equal(
    r1AiPermissionCommandSchema.safeParse(contextGrant).success,
    false,
  );
  assert.equal(r1PermissionCommandSchema.safeParse(contextGrant).success, true);
  assert.equal(r1PermissionCommandSchema.safeParse(aiGrant).success, true);
});

for (const scope of ["citygo_context", "ai_transfer"] as const) {
  test(`${scope} revoke needs neither a current notice nor a current route`, () => {
    const revoke = { ...base, expectedRevision: 2, scope, action: "revoke" };
    assert.deepEqual(r1PermissionCommandSchema.parse(revoke), revoke);
    for (const extra of [{ notice }, { route }, { erase: true }]) {
      assert.equal(
        r1PermissionCommandSchema.safeParse({ ...revoke, ...extra }).success,
        false,
      );
    }
  });
}

test("AI grant cannot omit either full notice or technical route binding", () => {
  for (const key of ["notice", "route"] as const) {
    const candidate: Record<string, unknown> = { ...aiGrant };
    delete candidate[key];
    assert.equal(r1PermissionCommandSchema.safeParse(candidate).success, false);
  }
  for (const candidate of [
    { ...aiGrant, route: { revision: 1 } },
    { ...aiGrant, route: { disclosureId: route.disclosureId } },
    { ...aiGrant, notice: { id: notice.id } },
    { ...aiGrant, notice: { version: notice.version } },
  ])
    assert.equal(r1PermissionCommandSchema.safeParse(candidate).success, false);
});

test("owner, approval, time, text and other permissions cannot be asserted by a client", () => {
  for (const extra of [
    { ownerId: "another-user" },
    { userId: "another-user" },
    { actorId: "operator" },
    { grantedAt: "2026-10-05T00:00:00Z" },
    { approved: true },
    { ready: true },
    { policy: { text: "fake approved text" } },
    { aiConsent: true },
    { humanHelpAllowed: false },
    { marketing: true },
    { permissions: ["citygo_context", "ai_transfer"] },
  ]) {
    for (const input of [contextGrant, aiGrant]) {
      assert.equal(
        r1PermissionCommandSchema.safeParse({ ...input, ...extra }).success,
        false,
      );
    }
  }
  for (const extra of [
    { approved: true },
    { text: "private" },
    { recipients: ["unknown"] },
  ]) {
    assert.equal(
      r1PermissionCommandSchema.safeParse({
        ...aiGrant,
        notice: { ...notice, ...extra },
      }).success,
      false,
    );
  }
  for (const extra of [
    { provider: "unknown" },
    { country: "us" },
    { fallback: true },
  ]) {
    assert.equal(
      r1PermissionCommandSchema.safeParse({
        ...aiGrant,
        route: { ...route, ...extra },
      }).success,
      false,
    );
  }
});

test("one command cannot bundle actions or introduce unimplemented marketing/human scopes", () => {
  for (const scope of [
    "all",
    "marketing",
    "human_help",
    ["citygo_context", "ai_transfer"],
  ]) {
    assert.equal(
      r1PermissionCommandSchema.safeParse({ ...contextGrant, scope }).success,
      false,
    );
  }
  for (const input of [
    [contextGrant, aiGrant],
    { commands: [contextGrant, aiGrant] },
    { ...contextGrant, action: ["grant", "revoke"] },
    { ...contextGrant, route },
  ])
    assert.equal(r1PermissionCommandSchema.safeParse(input).success, false);
});

test("decision revisions are explicit bounded integers; zero is accepted without default/coercion", () => {
  for (const expectedRevision of [0, 1, 2147483647]) {
    assert.equal(
      r1PermissionCommandSchema.safeParse({ ...contextGrant, expectedRevision })
        .success,
      true,
    );
  }
  for (const expectedRevision of [
    undefined,
    null,
    -1,
    0.5,
    2147483648,
    Infinity,
    NaN,
    "0",
    true,
  ]) {
    assert.equal(
      r1PermissionCommandSchema.safeParse({ ...contextGrant, expectedRevision })
        .success,
      false,
    );
  }
});

test("route revisions are positive bounded integers, not client routing instructions", () => {
  for (const revision of [1, 2147483647]) {
    assert.equal(
      r1PermissionCommandSchema.safeParse({
        ...aiGrant,
        route: { ...route, revision },
      }).success,
      true,
    );
  }
  for (const revision of [0, -1, 0.5, 2147483648, undefined, "1", true]) {
    assert.equal(
      r1PermissionCommandSchema.safeParse({
        ...aiGrant,
        route: { ...route, revision },
      }).success,
      false,
    );
  }
});

test("notice and disclosure hashes are canonical bounded references without URLs or secrets", () => {
  for (const id of [
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "z".repeat(64),
    ` ${notice.id}`,
    `${notice.id}\n`,
    "https://example.test/notice",
  ]) {
    assert.equal(
      r1NoticeReferenceSchema.safeParse({ ...notice, id }).success,
      false,
    );
    assert.equal(
      r1PermissionCommandSchema.safeParse({
        ...aiGrant,
        route: { ...route, disclosureId: id },
      }).success,
      false,
    );
  }
  for (const version of [
    "",
    " ",
    "r1 v1",
    "r1/v1",
    "V1",
    "a".repeat(81),
    "v1\n",
    "https://example.test/notice",
  ]) {
    assert.equal(
      r1NoticeReferenceSchema.safeParse({ ...notice, version }).success,
      false,
    );
  }
});

test("wire version, explicit action and idempotency key are mandatory", () => {
  for (const schemaVersion of [undefined, "1", 0, 2]) {
    assert.equal(
      r1PermissionCommandSchema.safeParse({ ...contextGrant, schemaVersion })
        .success,
      false,
    );
  }
  for (const requestId of [
    undefined,
    "",
    "request",
    "https://example.test/id",
  ]) {
    assert.equal(
      r1PermissionCommandSchema.safeParse({ ...contextGrant, requestId })
        .success,
      false,
    );
  }
  for (const action of [
    undefined,
    true,
    "granted",
    "continue",
    "complete",
    "delete",
  ]) {
    assert.equal(
      r1PermissionCommandSchema.safeParse({ ...contextGrant, action }).success,
      false,
    );
  }
});

test("legacy AI input stays compatible but is never parsed as a new R1 command", () => {
  for (const legacy of [
    { action: "granted", policyId: notice.id },
    { action: "revoked" },
  ]) {
    assert.equal(aiConsentSchema.safeParse(legacy).success, true);
    assert.equal(r1PermissionCommandSchema.safeParse(legacy).success, false);
  }
});
