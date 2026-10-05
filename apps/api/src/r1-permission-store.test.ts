import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import { connectDatabase, type Database, type Sql } from "@citygo/db";
import {
  prepareR1SyntheticNotice,
  R1SyntheticNoticeRegistry,
} from "./r1-permission-planner.js";
import {
  R1SyntheticPermissionStore,
  type R1SyntheticPermissionWriteResult,
} from "./r1-permission-store.js";

const owner = "synthetic-owner-1";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherRequestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const route = { revision: 2, disclosureId: "b".repeat(64) };
const notice = prepareR1SyntheticNotice({
  mode: "synthetic_only",
  scope: "citygo_context",
  version: "fixture-v1",
  body: "Synthetic context fixture. Not a legal notice.",
  routeDisclosureId: null,
  status: "approved_fixture",
});
const aiNotice = prepareR1SyntheticNotice({
  ...notice.definition,
  scope: "ai_transfer",
  body: "Synthetic AI fixture. Not a legal notice.",
  routeDisclosureId: route.disclosureId,
});
function registry(context = notice, ai = aiNotice) {
  return new R1SyntheticNoticeRegistry({
    notices: [context, ai],
    current: { citygo_context: context.reference, ai_transfer: ai.reference },
  });
}
const grant = {
  schemaVersion: 1,
  requestId,
  expectedRevision: 0,
  action: "grant",
  scope: "citygo_context",
  notice: notice.reference,
};
const aiGrant = {
  ...grant,
  scope: "ai_transfer",
  notice: aiNotice.reference,
  route,
};
function recorded(
  result: R1SyntheticPermissionWriteResult,
): asserts result is Extract<
  R1SyntheticPermissionWriteResult,
  { status: "synthetic_recorded" }
> {
  assert.equal(result.status, "synthetic_recorded");
}
async function fixture(t: TestContext) {
  // Never reads TEST_DATABASE_URL/.env; always a new memory-only fixture.
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await db.exec(
    await readFile(
      new URL("./fixtures/r1-permissions-synthetic.sql", import.meta.url),
      "utf8",
    ),
  );
  const store = new R1SyntheticPermissionStore(db, "synthetic_only");
  assert.deepEqual(await store.replaceConfiguration(1, registry(), route), {
    status: "configuration_updated",
    revision: 2,
  });
  return { db, store };
}
async function counts(db: Database) {
  return (
    await db.query<{ commands: number; decisions: number }>(
      `select (select count(*)::int from cg018_synthetic.commands) as commands,
            (select count(*)::int from cg018_synthetic.decisions) as decisions`,
    )
  ).rows[0];
}
function failingAfter(db: Database, fragment: string): Database {
  return {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          exec: (sql) => tx.exec(sql),
          async query<T>(sql: string, params?: unknown[]) {
            const result = await tx.query<T>(sql, params);
            if (sql.includes(fragment))
              throw new Error("synthetic-private-SQL-do-not-echo");
            return result;
          },
        }),
      ),
  };
}

test("a decision, immutable journal entry and database timestamp are recorded together", async (t) => {
  const { db, store } = await fixture(t);
  const input = structuredClone(grant);
  const result = await store.execute(input, owner);
  recorded(result);
  assert.equal(result.replayed, false);
  assert.equal(result.receipt.ownerId, owner);
  assert.equal(result.receipt.revision, 1);
  assert.equal(result.receipt.configurationRevision, 2);
  assert.equal(result.receipt.scope, "citygo_context");
  assert.match(result.receipt.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Object.isFrozen(result.receipt.command), true);
  assert.deepEqual(input, grant);
  assert.deepEqual(await counts(db), { commands: 1, decisions: 1 });
  const pointer = (
    await db.query<{ revision: number; event_id: string }>(
      "select revision,event_id::text from cg018_synthetic.decisions where owner_id=$1 and scope=$2",
      [owner, grant.scope],
    )
  ).rows[0];
  assert.deepEqual(pointer, { revision: 1, event_id: result.receipt.eventId });
});

test("identical replay after a later revoke returns the original receipt, never current approval", async (t) => {
  const { db, store } = await fixture(t);
  const first = await store.execute(grant, owner);
  recorded(first);
  const revoke = {
    schemaVersion: 1,
    requestId: otherRequestId,
    expectedRevision: 1,
    scope: "citygo_context",
    action: "revoke",
  };
  const second = await store.execute(revoke, owner);
  recorded(second);
  const replay = await new R1SyntheticPermissionStore(
    db,
    "synthetic_only",
  ).execute(
    {
      notice: { version: notice.reference.version, id: notice.reference.id },
      action: "grant",
      scope: "citygo_context",
      schemaVersion: 1,
      expectedRevision: 0,
      requestId: requestId.toUpperCase(),
    },
    owner,
  );
  recorded(replay);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(second.receipt.revision, 2);
  assert.deepEqual(await counts(db), { commands: 2, decisions: 1 });
});

test("AI replay survives route replacement and policy withdrawal without becoming a new grant", async (t) => {
  const { db, store } = await fixture(t);
  const first = await store.execute(aiGrant, owner);
  recorded(first);
  const withdrawn = prepareR1SyntheticNotice({
    ...aiNotice.definition,
    status: "withdrawn_fixture",
  });
  assert.equal(
    (await store.replaceConfiguration(2, registry(notice, withdrawn), null))
      .status,
    "configuration_updated",
  );
  const replay = await store.execute(aiGrant, owner);
  recorded(replay);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.deepEqual(
    await store.execute(
      { ...aiGrant, requestId: otherRequestId, expectedRevision: 1 },
      owner,
    ),
    { status: "rejected", code: "POLICY_NOT_APPROVED" },
  );
  assert.deepEqual(await counts(db), { commands: 1, decisions: 1 });
  const oldSnapshot = (
    await db.query<{ snapshot: { notices: unknown[] } }>(
      "select snapshot from cg018_synthetic.configurations where revision=2",
    )
  ).rows[0];
  assert.equal(oldSnapshot!.snapshot.notices.length, 2);
});

test("reusing a successful request ID with different contents rejects without touching the decision", async (t) => {
  const { db, store } = await fixture(t);
  recorded(await store.execute(grant, owner));
  for (const changed of [
    { ...grant, expectedRevision: 1 },
    {
      schemaVersion: 1,
      requestId,
      expectedRevision: 1,
      scope: "citygo_context",
      action: "revoke",
    },
    { ...grant, notice: { ...notice.reference, version: "fixture-v2" } },
  ])
    assert.deepEqual(await store.execute(changed, owner), {
      status: "rejected",
      code: "REQUEST_ID_REUSED",
    });
  assert.deepEqual(await counts(db), { commands: 1, decisions: 1 });
});

test("same request ID is isolated by authenticated owner and independent permission scope", async (t) => {
  const { db, store } = await fixture(t);
  const a = await store.execute(grant, owner);
  const b = await store.execute(grant, "synthetic-owner-2");
  const c = await store.execute(aiGrant, owner);
  recorded(a);
  recorded(b);
  recorded(c);
  assert.notEqual(a.receipt.eventId, b.receipt.eventId);
  assert.notEqual(a.receipt.eventId, c.receipt.eventId);
  assert.equal(b.replayed, false);
  assert.equal(c.receipt.revision, 1);
  assert.deepEqual(await counts(db), { commands: 3, decisions: 3 });
});

for (const fragment of [
  "insert into cg018_synthetic.commands",
  "insert into cg018_synthetic.decisions",
]) {
  test(`failure after ${fragment} rolls back the entire synthetic write`, async (t) => {
    const { db } = await fixture(t);
    const store = new R1SyntheticPermissionStore(
      failingAfter(db, fragment),
      "synthetic_only",
    );
    assert.deepEqual(await store.execute(grant, owner), {
      status: "rejected",
      code: "WRITE_NOT_COMMITTED",
    });
    assert.deepEqual(await counts(db), { commands: 0, decisions: 0 });
    recorded(
      await new R1SyntheticPermissionStore(db, "synthetic_only").execute(
        grant,
        owner,
      ),
    );
  });
}

test("lost acknowledgement after commit is recovered by replay without a second event", async (t) => {
  const { db, store } = await fixture(t);
  const lostAck: Database = {
    ...db,
    async transaction<T>(work: (tx: Sql) => Promise<T>) {
      await db.transaction(work);
      throw new Error("synthetic-lost-ack-do-not-echo");
    },
  };
  assert.deepEqual(
    await new R1SyntheticPermissionStore(lostAck, "synthetic_only").execute(
      grant,
      owner,
    ),
    { status: "unconfirmed", code: "STORAGE_UNAVAILABLE" },
  );
  assert.deepEqual(await counts(db), { commands: 1, decisions: 1 });
  const replay = await store.execute(grant, owner);
  recorded(replay);
  assert.equal(replay.replayed, true);
  assert.deepEqual(await counts(db), { commands: 1, decisions: 1 });
});

test("stale revision or changed notice/route cannot append a new event", async (t) => {
  const { db, store } = await fixture(t);
  recorded(await store.execute(grant, owner));
  assert.deepEqual(
    await store.execute({ ...grant, requestId: otherRequestId }, owner),
    { status: "rejected", code: "REVISION_CONFLICT" },
  );
  assert.deepEqual(
    await store.execute(
      { ...aiGrant, route: { ...route, revision: 1 } },
      owner,
    ),
    { status: "rejected", code: "ROUTE_CHANGED" },
  );
  assert.deepEqual(
    await store.execute(
      { ...aiGrant, notice: { ...aiNotice.reference, id: route.disclosureId } },
      owner,
    ),
    { status: "rejected", code: "NOTICE_CHANGED" },
  );
  assert.deepEqual(await counts(db), { commands: 1, decisions: 1 });
});

test("revoke ignores unavailable or invalid current policy contents, but still checks revision", async (t) => {
  const { db, store } = await fixture(t);
  recorded(await store.execute(aiGrant, owner));
  await db.query(
    "insert into cg018_synthetic.configurations (revision,snapshot) values (3,$1::jsonb)",
    [JSON.stringify({ malformed: "synthetic-private-text-do-not-echo" })],
  );
  await db.query(
    "update cg018_synthetic.runtime set configuration_revision=3 where id=1",
  );
  assert.deepEqual(
    await store.execute({ ...grant, requestId: otherRequestId }, owner),
    { status: "rejected", code: "STORED_DATA_INVALID" },
  );
  const revoke = {
    schemaVersion: 1,
    requestId: otherRequestId,
    scope: "ai_transfer",
    action: "revoke",
    expectedRevision: 1,
  };
  const result = await store.execute(revoke, owner);
  recorded(result);
  assert.equal(result.receipt.revision, 2);
  assert.deepEqual(await counts(db), { commands: 2, decisions: 1 });
});

test("disabled modes, unauthenticated identities and forged command authority never enter a transaction", async () => {
  const db: Database = {
    async query() {
      throw new Error("must not query");
    },
    async exec() {
      throw new Error("must not exec");
    },
    async transaction() {
      throw new Error("must not transact");
    },
    async close() {},
  };
  for (const mode of ["production", "disabled", "test", ""])
    assert.deepEqual(
      await new R1SyntheticPermissionStore(db, mode).execute(grant, owner),
      { status: "rejected", code: "SYNTHETIC_ONLY" },
    );
  const store = new R1SyntheticPermissionStore(db, "synthetic_only");
  for (const invalidOwner of [null, "", "bad owner", `${owner}\n`])
    assert.deepEqual(await store.execute(grant, invalidOwner), {
      status: "rejected",
      code: "UNAUTHENTICATED",
    });
  for (const extra of [
    { ownerId: owner },
    { recordedAt: "2026-10-05T00:00:00Z" },
    { approved: true },
  ])
    assert.deepEqual(await store.execute({ ...grant, ...extra }, owner), {
      status: "rejected",
      code: "INVALID_COMMAND",
    });
});

test("missing fixture readiness and raw driver failures fail closed without input disclosure", async (t) => {
  const { db, store } = await fixture(t);
  await db.query("delete from cg018_synthetic.runtime where id=1");
  assert.deepEqual(await store.execute(grant, owner), {
    status: "rejected",
    code: "STORE_NOT_READY",
  });
  const failed = {
    ...db,
    async transaction<T>(): Promise<T> {
      throw new Error("postgres://synthetic-key-owner-policy-do-not-echo");
    },
  };
  assert.deepEqual(
    await new R1SyntheticPermissionStore(failed, "synthetic_only").execute(
      grant,
      owner,
    ),
    { status: "rejected", code: "WRITE_NOT_COMMITTED" },
  );
  assert.deepEqual(await counts(db), { commands: 0, decisions: 0 });
});

test("invalid stored replay is rejected instead of fabricating evidence", async (t) => {
  const { db, store } = await fixture(t);
  await db.query(
    `insert into cg018_synthetic.commands
    (owner_id,scope,request_id,fingerprint,command,event_id,result_revision,configuration_revision)
    values ($1,'citygo_context',$2,$3,$4::jsonb,$5,1,2)`,
    [
      owner,
      requestId,
      "a".repeat(64),
      JSON.stringify({ private: "synthetic-do-not-echo" }),
      otherRequestId,
    ],
  );
  assert.deepEqual(await store.execute(grant, owner), {
    status: "rejected",
    code: "STORED_DATA_INVALID",
  });
  assert.deepEqual(await counts(db), { commands: 1, decisions: 0 });
});

test("configuration CAS and route high-water mark reject stale replacement and route ABA reuse", async (t) => {
  const { db, store } = await fixture(t);
  assert.deepEqual(await store.replaceConfiguration(1, registry(), route), {
    status: "rejected",
    code: "CONFIGURATION_CONFLICT",
  });
  assert.deepEqual(
    await store.replaceConfiguration(2, registry(), {
      ...route,
      disclosureId: "c".repeat(64),
    }),
    { status: "rejected", code: "ROUTE_REVISION_REUSED" },
  );
  assert.deepEqual(await store.replaceConfiguration(2, registry(), null), {
    status: "configuration_updated",
    revision: 3,
  });
  assert.deepEqual(await store.replaceConfiguration(3, registry(), route), {
    status: "rejected",
    code: "ROUTE_REVISION_REUSED",
  });
  assert.deepEqual(
    await store.replaceConfiguration(3, registry(), { ...route, revision: 3 }),
    { status: "configuration_updated", revision: 4 },
  );
  assert.deepEqual(await store.execute(aiGrant, owner), {
    status: "rejected",
    code: "ROUTE_CHANGED",
  });
  assert.deepEqual(await counts(db), { commands: 0, decisions: 0 });
});

test("failed configuration replacement rolls back the snapshot and runtime pointer together", async (t) => {
  const { db, store } = await fixture(t);
  const failed = new R1SyntheticPermissionStore(
    failingAfter(db, "update cg018_synthetic.runtime"),
    "synthetic_only",
  );
  assert.deepEqual(await failed.replaceConfiguration(2, registry(), null), {
    status: "rejected",
    code: "WRITE_NOT_COMMITTED",
  });
  const snapshots = (
    await db.query<{ n: number }>(
      "select count(*)::int as n from cg018_synthetic.configurations",
    )
  ).rows[0];
  assert.equal(snapshots!.n, 2);
  recorded(await store.execute(aiGrant, owner));
});

test("notice versions cannot silently change text across configurations, even after another scope was validated", async (t) => {
  const { db, store } = await fixture(t);
  const changedContext = prepareR1SyntheticNotice({
    ...notice.definition,
    version: "fixture-v2",
    body: "Synthetic revised context. Not a legal notice.",
  });
  const changedAi = prepareR1SyntheticNotice({
    ...aiNotice.definition,
    body: "Changed text under the old version.",
  });
  assert.deepEqual(
    await store.replaceConfiguration(
      2,
      registry(changedContext, changedAi),
      route,
    ),
    { status: "rejected", code: "NOTICE_VERSION_REUSED" },
  );
  const existing = (
    await db.query<{ n: number }>(
      "select count(*)::int as n from cg018_synthetic.notices",
    )
  ).rows[0];
  assert.equal(existing!.n, 2);
  assert.deepEqual(
    await store.replaceConfiguration(2, registry(changedContext), route),
    { status: "configuration_updated", revision: 3 },
  );
  assert.deepEqual(await store.execute(grant, owner), {
    status: "rejected",
    code: "NOTICE_CHANGED",
  });
});

test("SQL constraints link a decision to its own event and keep fixture history immutable", async (t) => {
  const { db, store } = await fixture(t);
  const result = await store.execute(grant, owner);
  recorded(result);
  await assert.rejects(
    db.query(
      `insert into cg018_synthetic.decisions (owner_id,scope,revision,event_id)
    values ($1,'citygo_context',1,$2)`,
      ["synthetic-other-owner", result.receipt.eventId],
    ),
  );
  for (const sql of [
    "update cg018_synthetic.commands set result_revision=2",
    "delete from cg018_synthetic.commands",
    "update cg018_synthetic.configurations set snapshot='{}'::jsonb",
    "delete from cg018_synthetic.configurations where revision=1",
    "update cg018_synthetic.notices set record='{}'::jsonb",
  ])
    await assert.rejects(db.query(sql));
  assert.deepEqual(await counts(db), { commands: 1, decisions: 1 });
});
