// Explicit opt-in test entry, deliberately NOT *.test.ts. Connects only to the
// separately authorized disposable cg018 container on loopback port 55438.
// No environment/secret/TEST_DATABASE_URL reads, no application migrations.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { connectDatabase, type Database } from "@citygo/db";
import {
  prepareR1SyntheticNotice,
  R1SyntheticNoticeRegistry,
} from "./r1-permission-planner.js";
import {
  R1SyntheticPermissionStore,
  type R1SyntheticPermissionWriteResult,
} from "./r1-permission-store.js";

const adminUrl =
  "postgresql://cg018_synthetic:cg018-synthetic-local-only@127.0.0.1:55438/cg018_control";
const owner = "synthetic-owner-1";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const route = { revision: 2, disclosureId: "b".repeat(64) };
const contextNotice = prepareR1SyntheticNotice({
  mode: "synthetic_only",
  scope: "citygo_context",
  version: "fixture-v1",
  body: "Synthetic fixture. Not a legal notice.",
  routeDisclosureId: null,
  status: "approved_fixture",
});
const aiNotice = prepareR1SyntheticNotice({
  ...contextNotice.definition,
  scope: "ai_transfer",
  routeDisclosureId: route.disclosureId,
});
function registry(ai = aiNotice) {
  return new R1SyntheticNoticeRegistry({
    notices: [contextNotice, ai],
    current: {
      citygo_context: contextNotice.reference,
      ai_transfer: ai.reference,
    },
  });
}
const grant = {
  schemaVersion: 1,
  requestId,
  expectedRevision: 0,
  scope: "citygo_context",
  action: "grant",
  notice: contextNotice.reference,
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(3000, undefined, { signal: controller.signal }).then(() => {
        throw new Error("Synthetic coordination timed out");
      }),
    ]);
  } finally {
    controller.abort();
  }
}
async function fixture(t: TestContext) {
  const admin = await connectDatabase(adminUrl);
  const name = "cg018_case_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg018_case_[a-f0-9]{32}$/);
  let db: Database | null = null;
  let created = false;
  t.after(async () => {
    try {
      if (db) await db.close();
      // Only the exact, validated database created below, never a configured URL.
      if (created) await admin.query(`drop database "${name}"`);
    } finally {
      await admin.close();
    }
  });
  const identity = (
    await admin.query<{ role: string; database: string }>(
      "select current_user as role,current_database() as database",
    )
  ).rows[0];
  assert.deepEqual(identity, {
    role: "cg018_synthetic",
    database: "cg018_control",
  });
  await admin.query(`create database "${name}" template template0`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = "/" + name;
  db = await connectDatabase(url.toString());
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
function gated(db: Database) {
  const entered = deferred<void>();
  const released = deferred<void>();
  const wrapped: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          exec: (sql) => tx.exec(sql),
          async query<T>(sql: string, params?: unknown[]) {
            const result = await tx.query<T>(sql, params);
            if (
              sql.includes("from cg018_synthetic.runtime") &&
              sql.includes("for update")
            ) {
              entered.resolve();
              await bounded(released.promise);
            }
            return result;
          },
        }),
      ),
  };
  return {
    store: new R1SyntheticPermissionStore(wrapped, "synthetic_only"),
    entered: entered.promise,
    release: () => released.resolve(),
  };
}
function waiting(db: Database) {
  const started = deferred<number>();
  const wrapped: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          exec: (sql) => tx.exec(sql),
          async query<T>(sql: string, params?: unknown[]) {
            if (
              sql.includes("from cg018_synthetic.runtime") &&
              sql.includes("for update")
            ) {
              const row = (
                await tx.query<{ pid: number }>(
                  "select pg_backend_pid() as pid",
                )
              ).rows[0];
              started.resolve(row!.pid);
            }
            return tx.query<T>(sql, params);
          },
        }),
      ),
  };
  return {
    store: new R1SyntheticPermissionStore(wrapped, "synthetic_only"),
    started: started.promise,
  };
}
async function assertBlocked(db: Database, started: Promise<number>) {
  const pid = await bounded(started);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const row = (
      await db.query<{ blocked: boolean }>(
        "select cardinality(pg_blocking_pids($1))>0 as blocked",
        [pid],
      )
    ).rows[0];
    if (row?.blocked) return;
    await delay(10);
  }
  assert.fail("No real PostgreSQL lock wait observed");
}
async function commands(db: Database) {
  return (
    await db.query<{ n: number }>(
      "select count(*)::int as n from cg018_synthetic.commands",
    )
  ).rows[0]!.n;
}

test(
  "PostgreSQL: identical simultaneous requests wait and record exactly one event",
  { timeout: 15000 },
  async (t) => {
    const { db } = await fixture(t);
    const first = gated(db);
    const second = waiting(db);
    const a = first.store.execute(grant, owner);
    let b: Promise<R1SyntheticPermissionWriteResult> | undefined;
    try {
      await bounded(first.entered);
      b = second.store.execute(grant, owner);
      await assertBlocked(db, second.started);
      first.release();
      const [one, two] = await Promise.all([a, b]);
      recorded(one);
      recorded(two);
      assert.equal(one.replayed, false);
      assert.equal(two.replayed, true);
      assert.deepEqual(one.receipt, two.receipt);
      assert.equal(await commands(db), 1);
    } finally {
      first.release();
      await Promise.allSettled([a, ...(b ? [b] : [])]);
    }
  },
);

test(
  "PostgreSQL: simultaneous reuse of a request ID with different contents cannot overwrite the winner",
  { timeout: 15000 },
  async (t) => {
    const { db } = await fixture(t);
    const first = gated(db);
    const second = waiting(db);
    const a = first.store.execute(grant, owner);
    let b: Promise<R1SyntheticPermissionWriteResult> | undefined;
    try {
      await bounded(first.entered);
      b = second.store.execute(
        {
          schemaVersion: 1,
          requestId,
          expectedRevision: 0,
          scope: "citygo_context",
          action: "revoke",
        },
        owner,
      );
      await assertBlocked(db, second.started);
      first.release();
      recorded(await a);
      assert.deepEqual(await b, {
        status: "rejected",
        code: "REQUEST_ID_REUSED",
      });
      assert.equal(await commands(db), 1);
    } finally {
      first.release();
      await Promise.allSettled([a, ...(b ? [b] : [])]);
    }
  },
);

for (const action of ["grant", "revoke"] as const) {
  test(
    `PostgreSQL: ${action} wins the lock; the other stale action cannot overwrite it`,
    { timeout: 15000 },
    async (t) => {
      const { db } = await fixture(t);
      const first = gated(db);
      const second = waiting(db);
      const revoke = {
        schemaVersion: 1,
        requestId: otherId,
        expectedRevision: 0,
        scope: "citygo_context",
        action: "revoke",
      };
      const a = first.store.execute(action === "grant" ? grant : revoke, owner);
      let b: Promise<R1SyntheticPermissionWriteResult> | undefined;
      try {
        await bounded(first.entered);
        b = second.store.execute(action === "grant" ? revoke : grant, owner);
        await assertBlocked(db, second.started);
        first.release();
        const [one, two] = await Promise.all([a, b]);
        recorded(one);
        assert.equal(one.receipt.command.action, action);
        assert.deepEqual(two, {
          status: "rejected",
          code: "REVISION_CONFLICT",
        });
        assert.equal(await commands(db), 1);
      } finally {
        first.release();
        await Promise.allSettled([a, ...(b ? [b] : [])]);
      }
    },
  );
}

for (const change of ["route", "withdrawal"] as const) {
  test(
    `PostgreSQL: ${change} before a waiting grant rejects the stale action`,
    { timeout: 15000 },
    async (t) => {
      const { db } = await fixture(t);
      const first = gated(db);
      const second = waiting(db);
      const selected =
        change === "withdrawal"
          ? registry(
              prepareR1SyntheticNotice({
                ...aiNotice.definition,
                status: "withdrawn_fixture",
              }),
            )
          : registry();
      const a = first.store.replaceConfiguration(
        2,
        selected,
        change === "route" ? { ...route, revision: 3 } : null,
      );
      let b: Promise<R1SyntheticPermissionWriteResult> | undefined;
      try {
        await bounded(first.entered);
        b = second.store.execute(aiGrant, owner);
        await assertBlocked(db, second.started);
        first.release();
        assert.equal((await a).status, "configuration_updated");
        assert.deepEqual(await b, {
          status: "rejected",
          code: change === "route" ? "ROUTE_CHANGED" : "POLICY_NOT_APPROVED",
        });
        assert.equal(await commands(db), 0);
      } finally {
        first.release();
        await Promise.allSettled([a, ...(b ? [b] : [])]);
      }
    },
  );
}

test(
  "PostgreSQL: committed grant precedes waiting route replacement; replay keeps its old receipt",
  { timeout: 15000 },
  async (t) => {
    const { db, store } = await fixture(t);
    const first = gated(db);
    const second = waiting(db);
    const a = first.store.execute(aiGrant, owner);
    let b:
      | ReturnType<R1SyntheticPermissionStore["replaceConfiguration"]>
      | undefined;
    try {
      await bounded(first.entered);
      b = second.store.replaceConfiguration(2, registry(), {
        ...route,
        revision: 3,
      });
      await assertBlocked(db, second.started);
      first.release();
      const one = await a;
      recorded(one);
      assert.equal((await b).status, "configuration_updated");
      assert.equal(one.receipt.configurationRevision, 2);
      const replay = await store.execute(aiGrant, owner);
      recorded(replay);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.receipt, one.receipt);
      assert.equal(await commands(db), 1);
    } finally {
      first.release();
      await Promise.allSettled([a, ...(b ? [b] : [])]);
    }
  },
);

test(
  "PostgreSQL: concurrent configuration CAS records only the winner",
  { timeout: 15000 },
  async (t) => {
    const { db } = await fixture(t);
    const first = gated(db);
    const second = waiting(db);
    const a = first.store.replaceConfiguration(2, registry(), null);
    let b:
      | ReturnType<R1SyntheticPermissionStore["replaceConfiguration"]>
      | undefined;
    try {
      await bounded(first.entered);
      b = second.store.replaceConfiguration(2, registry(), {
        ...route,
        revision: 3,
      });
      await assertBlocked(db, second.started);
      first.release();
      assert.deepEqual(await a, {
        status: "configuration_updated",
        revision: 3,
      });
      assert.deepEqual(await b, {
        status: "rejected",
        code: "CONFIGURATION_CONFLICT",
      });
      const snapshots = (
        await db.query<{ n: number }>(
          "select count(*)::int as n from cg018_synthetic.configurations",
        )
      ).rows[0];
      assert.equal(snapshots!.n, 3);
    } finally {
      first.release();
      await Promise.allSettled([a, ...(b ? [b] : [])]);
    }
  },
);

test(
  "PostgreSQL: failure after decision update rolls back the journal and decision",
  { timeout: 15000 },
  async (t) => {
    const { db } = await fixture(t);
    const faulty: Database = {
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            exec: (sql) => tx.exec(sql),
            async query<T>(sql: string, params?: unknown[]) {
              const result = await tx.query<T>(sql, params);
              if (sql.includes("insert into cg018_synthetic.decisions"))
                throw new Error("Synthetic failure");
              return result;
            },
          }),
        ),
    };
    assert.deepEqual(
      await new R1SyntheticPermissionStore(faulty, "synthetic_only").execute(
        grant,
        owner,
      ),
      { status: "rejected", code: "WRITE_NOT_COMMITTED" },
    );
    assert.equal(await commands(db), 0);
    const decisions = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from cg018_synthetic.decisions",
      )
    ).rows[0];
    assert.equal(decisions!.n, 0);
  },
);
