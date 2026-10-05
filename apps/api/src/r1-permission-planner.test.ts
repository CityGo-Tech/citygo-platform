import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareR1SyntheticNotice,
  prepareR1SyntheticPermissionCommand,
  R1SyntheticNoticeRegistry,
  type R1SyntheticNotice,
  type R1SyntheticPermissionContext,
  type R1SyntheticPermissionPreparation,
} from "./r1-permission-planner.js";

const route = { revision: 2, disclosureId: "b".repeat(64) };
const ownerId = "synthetic-owner-1";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const contextNotice = prepareR1SyntheticNotice({
  mode: "synthetic_only",
  scope: "citygo_context",
  version: "fixture-v1",
  body: "Synthetic context fixture. Not a legal notice.",
  routeDisclosureId: null,
  status: "approved_fixture",
});
const aiNotice = prepareR1SyntheticNotice({
  ...contextNotice.definition,
  scope: "ai_transfer",
  body: "Synthetic AI fixture. Not a legal notice.",
  routeDisclosureId: route.disclosureId,
});
function registry(
  context: R1SyntheticNotice | null = contextNotice,
  ai: R1SyntheticNotice | null = aiNotice,
) {
  return new R1SyntheticNoticeRegistry({
    notices: [context, ai].filter((item) => item !== null),
    current: {
      citygo_context: context?.reference ?? null,
      ai_transfer: ai?.reference ?? null,
    },
  });
}
function context(
  scope: "citygo_context" | "ai_transfer" = "citygo_context",
): R1SyntheticPermissionContext {
  return {
    mode: "synthetic_only",
    authenticatedOwnerId: ownerId,
    decision: { ownerId, scope, revision: 3 },
    registry: registry(),
    currentRoute: { ...route },
  };
}
const grant = {
  schemaVersion: 1,
  requestId,
  expectedRevision: 3,
  action: "grant",
  scope: "citygo_context",
  notice: { ...contextNotice.reference },
};
const aiGrant = {
  ...grant,
  scope: "ai_transfer",
  notice: { ...aiNotice.reference },
  route: { ...route },
};
function prepared(
  result: R1SyntheticPermissionPreparation,
): asserts result is Extract<
  R1SyntheticPermissionPreparation,
  { status: "prepared" }
> {
  assert.equal(result.status, "prepared");
}
function rejected(
  input: unknown,
  trusted: R1SyntheticPermissionContext,
  code: string,
) {
  assert.deepEqual(prepareR1SyntheticPermissionCommand(input, trusted), {
    status: "rejected",
    code,
  });
}

test("fixture snapshot binds full text, scope, version and route, not object key order", () => {
  const reordered = prepareR1SyntheticNotice({
    status: contextNotice.definition.status,
    body: contextNotice.definition.body,
    mode: "synthetic_only",
    routeDisclosureId: null,
    version: contextNotice.definition.version,
    scope: "citygo_context",
  });
  assert.deepEqual(reordered, contextNotice);
  for (const changed of [
    { ...contextNotice.definition, version: "fixture-v2" },
    { ...contextNotice.definition, body: `${contextNotice.definition.body} ` },
    {
      ...contextNotice.definition,
      body: "Different fields/recipients/retention in full text.",
    },
    {
      ...contextNotice.definition,
      scope: "ai_transfer",
      routeDisclosureId: route.disclosureId,
    },
    { ...aiNotice.definition, routeDisclosureId: "c".repeat(64) },
  ]) {
    const reference =
      changed.scope === "ai_transfer" &&
      changed.body === aiNotice.definition.body
        ? aiNotice.reference
        : contextNotice.reference;
    assert.notEqual(
      prepareR1SyntheticNotice(changed).reference.id,
      reference.id,
    );
  }
  assert.equal(
    prepareR1SyntheticNotice({
      ...contextNotice.definition,
      status: "withdrawn_fixture",
    }).reference.id,
    contextNotice.reference.id,
  );
});

test("fixture preparation rejects real modes, missing bodies, authority extras and inconsistent route bindings", () => {
  for (const input of [
    { ...contextNotice.definition, mode: "production" },
    { ...contextNotice.definition, mode: undefined },
    { ...contextNotice.definition, body: " " },
    { ...contextNotice.definition, body: "x".repeat(16385) },
    { ...contextNotice.definition, routeDisclosureId: route.disclosureId },
    { ...aiNotice.definition, routeDisclosureId: null },
    { ...contextNotice.definition, approved: true },
    { ...contextNotice.definition, credentials: "synthetic-do-not-echo" },
    { ...contextNotice.definition, status: "approved" },
  ])
    assert.throws(
      () => prepareR1SyntheticNotice(input),
      /^Error: Invalid synthetic notice definition$/,
    );
});

test("registry detects tampered references and duplicate scope/version definitions", () => {
  const current = {
    citygo_context: contextNotice.reference,
    ai_transfer: null,
  };
  for (const notices of [
    [
      {
        ...contextNotice,
        reference: { ...contextNotice.reference, id: "d".repeat(64) },
      },
    ],
    [
      {
        ...contextNotice,
        reference: { ...contextNotice.reference, version: "fixture-v2" },
      },
    ],
    [contextNotice, contextNotice],
    [
      contextNotice,
      prepareR1SyntheticNotice({
        ...contextNotice.definition,
        body: "Changed text under the same version.",
      }),
    ],
  ])
    assert.throws(
      () => new R1SyntheticNoticeRegistry({ notices, current }),
      /Duplicate version or inconsistent synthetic notice/,
    );
});

test("registry selections are explicit, scope-specific and never inferred from newest fixtures", () => {
  const newer = prepareR1SyntheticNotice({
    ...contextNotice.definition,
    version: "fixture-v2",
  });
  const selected = new R1SyntheticNoticeRegistry({
    notices: [newer, contextNotice],
    current: { citygo_context: contextNotice.reference, ai_transfer: null },
  });
  assert.deepEqual(selected.current("citygo_context"), contextNotice);
  const none = new R1SyntheticNoticeRegistry({
    notices: [contextNotice, newer],
    current: { citygo_context: null, ai_transfer: null },
  });
  assert.equal(none.current("citygo_context"), null);
  for (const current of [
    {
      citygo_context: { id: "d".repeat(64), version: "fixture-v1" },
      ai_transfer: null,
    },
    {
      citygo_context: { ...contextNotice.reference, version: "fixture-v2" },
      ai_transfer: null,
    },
    { citygo_context: null, ai_transfer: contextNotice.reference },
  ])
    assert.throws(
      () =>
        new R1SyntheticNoticeRegistry({ notices: [contextNotice], current }),
      /Invalid explicit synthetic notice selection/,
    );
});

test("registry copies and freezes caller-owned records and selections", () => {
  const record = {
    reference: { ...contextNotice.reference },
    definition: { ...contextNotice.definition },
  };
  const current = {
    citygo_context: { ...contextNotice.reference },
    ai_transfer: null,
  };
  const selected = new R1SyntheticNoticeRegistry({
    notices: [record],
    current,
  });
  record.definition.body = "mutated";
  record.reference.id = "c".repeat(64);
  current.citygo_context.id = "d".repeat(64);
  assert.deepEqual(selected.current("citygo_context"), contextNotice);
  assert.equal(
    Reflect.set(
      selected.current("citygo_context")!.definition,
      "status",
      "withdrawn_fixture",
    ),
    false,
  );
  assert.equal(
    Reflect.set(
      selected.current("citygo_context")!.reference,
      "id",
      "d".repeat(64),
    ),
    false,
  );
});

test("preparation is synthetic-only, authenticated and side-effect-free", () => {
  const input = structuredClone(grant);
  const trusted = context();
  const previous = structuredClone(trusted.decision);
  const result = prepareR1SyntheticPermissionCommand(input, trusted);
  prepared(result);
  assert.equal(result.ownerId, ownerId);
  assert.equal(result.nextRevision, 4);
  assert.match(result.commandFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(input, grant);
  assert.deepEqual(trusted.decision, previous);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.command), true);
  assert.equal(
    result.command.action === "grant" && Object.isFrozen(result.command.notice),
    true,
  );
  for (const mode of ["disabled", "production", "test", ""])
    rejected(input, { ...trusted, mode }, "SYNTHETIC_ONLY");
  for (const authenticatedOwnerId of [
    null,
    "",
    "bad owner",
    `${ownerId}\n`,
    `${ownerId}\r\n`,
  ])
    rejected(input, { ...trusted, authenticatedOwnerId }, "UNAUTHENTICATED");
});

test("context grant does not depend on AI approval, selection, route or budget", () => {
  prepared(
    prepareR1SyntheticPermissionCommand(grant, {
      ...context(),
      registry: registry(contextNotice, null),
      currentRoute: null,
    }),
  );
  prepared(
    prepareR1SyntheticPermissionCommand(grant, {
      ...context(),
      registry: registry(
        contextNotice,
        prepareR1SyntheticNotice({
          ...aiNotice.definition,
          status: "withdrawn_fixture",
        }),
      ),
      currentRoute: { revision: 9, disclosureId: "c".repeat(64) },
    }),
  );
  prepared(
    prepareR1SyntheticPermissionCommand(aiGrant, {
      ...context("ai_transfer"),
      registry: registry(null, aiNotice),
    }),
  );
});

test("grant rejects unselected, missing, draft and withdrawn fixtures without fallback", () => {
  rejected(grant, { ...context(), registry: null }, "POLICY_UNAVAILABLE");
  rejected(
    grant,
    { ...context(), registry: registry(null, aiNotice) },
    "POLICY_UNAVAILABLE",
  );
  for (const status of ["draft_fixture", "withdrawn_fixture"] as const) {
    const notice = prepareR1SyntheticNotice({
      ...contextNotice.definition,
      status,
    });
    assert.equal(notice.reference.id, contextNotice.reference.id);
    rejected(
      grant,
      { ...context(), registry: registry(notice) },
      "POLICY_NOT_APPROVED",
    );
  }
});

test("grant binds exactly the selected notice id and version, not a technical AI hash", () => {
  rejected(
    { ...grant, notice: { ...grant.notice, id: "c".repeat(64) } },
    context(),
    "NOTICE_CHANGED",
  );
  rejected(
    { ...grant, notice: { ...grant.notice, version: "fixture-v2" } },
    context(),
    "NOTICE_CHANGED",
  );
  rejected(
    {
      ...aiGrant,
      notice: { id: route.disclosureId, version: aiNotice.reference.version },
    },
    context("ai_transfer"),
    "NOTICE_CHANGED",
  );
  const changed = prepareR1SyntheticNotice({
    ...contextNotice.definition,
    version: "fixture-v2",
    body: "Changed complete notice.",
  });
  rejected(
    grant,
    { ...context(), registry: registry(changed) },
    "NOTICE_CHANGED",
  );
});

test("AI grant requires a current route matching revision, disclosure and the bound full notice", () => {
  prepared(
    prepareR1SyntheticPermissionCommand(aiGrant, context("ai_transfer")),
  );
  rejected(
    aiGrant,
    { ...context("ai_transfer"), currentRoute: null },
    "ROUTE_UNAVAILABLE",
  );
  rejected(
    aiGrant,
    { ...context("ai_transfer"), currentRoute: { ...route, revision: 3 } },
    "ROUTE_CHANGED",
  );
  rejected(
    aiGrant,
    {
      ...context("ai_transfer"),
      currentRoute: { ...route, disclosureId: "c".repeat(64) },
    },
    "ROUTE_CHANGED",
  );
  const changedRoute = { revision: 3, disclosureId: "c".repeat(64) };
  rejected(
    { ...aiGrant, route: changedRoute },
    { ...context("ai_transfer"), currentRoute: changedRoute },
    "ROUTE_CHANGED",
  );
  rejected(
    { ...aiGrant, route: { ...route, revision: 1 } },
    context("ai_transfer"),
    "ROUTE_CHANGED",
  );
});

for (const scope of ["citygo_context", "ai_transfer"] as const) {
  test(`${scope} revocation is preparable with no current registry or route`, () => {
    const input = {
      schemaVersion: 1,
      requestId,
      scope,
      action: "revoke",
      expectedRevision: 3,
    };
    const trusted = { ...context(scope), registry: null, currentRoute: null };
    prepared(prepareR1SyntheticPermissionCommand(input, trusted));
    rejected({ ...input, expectedRevision: 2 }, trusted, "REVISION_CONFLICT");
    rejected(
      input,
      { ...trusted, authenticatedOwnerId: null },
      "UNAUTHENTICATED",
    );
  });
}

test("owner and scope are checked independently of revision equality", () => {
  rejected(
    grant,
    {
      ...context(),
      decision: {
        ownerId: "synthetic-owner-2",
        scope: "citygo_context",
        revision: 3,
      },
    },
    "OWNER_OR_SCOPE_MISMATCH",
  );
  rejected(
    grant,
    { ...context(), decision: { ownerId, scope: "ai_transfer", revision: 3 } },
    "OWNER_OR_SCOPE_MISMATCH",
  );
  rejected(
    grant,
    {
      ...context(),
      decision: { ownerId, scope: "citygo_context", revision: -1 },
    },
    "INVALID_DECISION",
  );
  rejected(
    grant,
    {
      ...context(),
      decision: {
        ownerId: `${ownerId}\n`,
        scope: "citygo_context",
        revision: 3,
      },
    },
    "INVALID_DECISION",
  );
  for (const extra of [
    { ownerId },
    { serverTime: "2026-10-05T00:00:00Z" },
    { approved: true },
  ])
    rejected({ ...grant, ...extra }, context(), "INVALID_COMMAND");
});

test("zero is an initial revision rather than a wildcard; stale fresh-state checks do not write", () => {
  const initial = { ...context(), decision: null };
  const first = prepareR1SyntheticPermissionCommand(
    { ...grant, expectedRevision: 0 },
    initial,
  );
  prepared(first);
  assert.equal(first.nextRevision, 1);
  rejected(grant, initial, "REVISION_CONFLICT");
  rejected({ ...grant, expectedRevision: 0 }, context(), "REVISION_CONFLICT");
  const afterOtherCommand = {
    ...context(),
    decision: { ownerId, scope: "citygo_context" as const, revision: 4 },
  };
  rejected(grant, afterOtherCommand, "REVISION_CONFLICT");
  rejected(
    { ...grant, expectedRevision: 2147483647 },
    {
      ...context(),
      decision: { ownerId, scope: "citygo_context", revision: 2147483647 },
    },
    "REVISION_EXHAUSTED",
  );
});

test("fingerprints are stable across property order and UUID case, but distinguish route and request changes", () => {
  const original = prepareR1SyntheticPermissionCommand(
    aiGrant,
    context("ai_transfer"),
  );
  const reordered = prepareR1SyntheticPermissionCommand(
    {
      route: { disclosureId: route.disclosureId, revision: route.revision },
      notice: {
        version: aiNotice.reference.version,
        id: aiNotice.reference.id,
      },
      scope: "ai_transfer",
      action: "grant",
      expectedRevision: 3,
      schemaVersion: 1,
      requestId: requestId.toUpperCase(),
    },
    context("ai_transfer"),
  );
  prepared(original);
  prepared(reordered);
  assert.equal(original.commandFingerprint, reordered.commandFingerprint);
  assert.equal(reordered.command.requestId, requestId);
  const nextRoute = { ...route, revision: 3 };
  const other = prepareR1SyntheticPermissionCommand(
    { ...aiGrant, route: nextRoute },
    { ...context("ai_transfer"), currentRoute: nextRoute },
  );
  prepared(other);
  assert.notEqual(original.commandFingerprint, other.commandFingerprint);
  const anotherRequest = prepareR1SyntheticPermissionCommand(
    { ...aiGrant, requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    context("ai_transfer"),
  );
  prepared(anotherRequest);
  assert.notEqual(
    original.commandFingerprint,
    anotherRequest.commandFingerprint,
  );
});

test("payload fingerprint is not a replacement for owner-scoped replay storage", () => {
  const first = prepareR1SyntheticPermissionCommand(grant, context());
  const second = prepareR1SyntheticPermissionCommand(grant, {
    ...context(),
    authenticatedOwnerId: "synthetic-owner-2",
    decision: {
      ownerId: "synthetic-owner-2",
      scope: "citygo_context",
      revision: 3,
    },
  });
  prepared(first);
  prepared(second);
  assert.notEqual(first.ownerId, second.ownerId);
  assert.equal(first.commandFingerprint, second.commandFingerprint);
});

test("rejection is content-free and legacy consent cannot become a new prepared action", () => {
  for (const input of [
    { action: "granted", policyId: route.disclosureId },
    { action: "revoked" },
    { ...grant, body: "synthetic-private-content-do-not-echo" },
  ])
    rejected(input, context(), "INVALID_COMMAND");
});
