// Explicit opt-in ONLY, not *.test.ts: separately authorized disposable
// cg018 container. Literal fake credentials, no env or production URL reads.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { connectDatabase, type Database } from "@citygo/db";
import { r1SyntheticPermissionSnapshotSchema } from "@citygo/contracts";
import { verifyR1SyntheticPermissionReadiness } from "./r1-permission-access.js";
import { R1SyntheticPermissionStore } from "./r1-permission-store.js";
import { permissionReviewScenarios } from "./r1-permission-review.fixture.js";
import {
  prepareR1SyntheticNotice,
  R1SyntheticNoticeRegistry,
} from "./r1-permission-planner.js";
import {
  permissionHttpFixture,
  syntheticGrant,
  syntheticRevoke,
  syntheticContext,
  syntheticAi,
  syntheticRoute,
} from "./r1-permission-http.fixture.js";

const adminUrl =
  "postgresql://cg018_synthetic:cg018-synthetic-local-only@127.0.0.1:55438/cg018_control";
for (const scenario of permissionReviewScenarios)
  test("PostgreSQL review regression: " + scenario.name, (t) =>
    withPostgres(t, (base, inner) => scenario.run(inner, base)),
  );
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
      delay(5000, undefined, { signal: controller.signal }).then(() => {
        throw new Error("Synthetic coordination timed out");
      }),
    ]);
  } finally {
    controller.abort();
  }
}
async function observeBlock(base: Database, holder: number, waiter: number) {
  for (let i = 0; i < 100; i++) {
    const blocked = (
      await base.query<{ blocked: boolean }>(
        "select $1=any(pg_blocking_pids($2)) as blocked",
        [holder, waiter],
      )
    ).rows[0]!.blocked;
    if (blocked) return;
    await delay(20);
  }
  throw new Error("Actual PostgreSQL row lock was not observed");
}
async function withPostgres(
  t: TestContext,
  run: (base: Database, inner: TestContext) => Promise<void>,
) {
  const admin = await connectDatabase(adminUrl);
  const name = "cg018_case_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg018_case_[a-f0-9]{32}$/);
  let created = false;
  const lifecycle: { base?: Database } = {};
  t.after(async () => {
    try {
      if (lifecycle.base) await lifecycle.base.close();
      if (created) await admin.query(`drop database "${name}"`);
    } finally {
      await admin.close();
    }
  });
  assert.deepEqual(
    (
      await admin.query(
        "select current_user as role,current_database() as database",
      )
    ).rows[0],
    {
      role: "cg018_synthetic",
      database: "cg018_control",
    },
  );
  await admin.query(`create database "${name}" template template0`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = "/" + name;
  const base = await connectDatabase(url.toString());
  lifecycle.base = base;
  // Subtest hooks clean its exact random fixture roles before the parent DB
  // is closed/dropped, including setup/assertion failures.
  await t.test("isolated HTTP fixture", (inner) => run(base, inner));
}

test("PostgreSQL: real narrow role writes/replays, forbids config/history mutations and fails unsafe readiness", async (t) => {
  await withPostgres(t, async (base, inner) => {
    const f = await permissionHttpFixture(inner, { base });
    const user = await f.person();
    const command = syntheticGrant();
    const first = await f.call(user.token, command);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(
      (await f.call(user.token, syntheticRevoke("citygo_context", 1)))
        .statusCode,
      200,
    );
    const replay = await f.call(user.token, command);
    assert.equal(replay.json().replayed, true);
    assert.deepEqual(replay.json().receipt, first.json().receipt);
    for (const sql of [
      "update cg018_synthetic.runtime set configuration_revision=1",
      "insert into cg018_synthetic.configurations (revision,snapshot) values (3,'{}')",
      "delete from cg018_synthetic.commands",
      "update cg018_synthetic.notices set record='{}'",
      "truncate cg018_synthetic.commands cascade",
    ])
      await assert.rejects(f.scoped.query(sql));
    assert.equal(
      await base.transaction(verifyR1SyntheticPermissionReadiness),
      false,
    );
    await base.exec(
      "grant update (mode) on cg018_synthetic.runtime to " + f.roles.citygo_api,
    );
    const unsafe = await f.call(user.token, syntheticGrant("ai_transfer"));
    assert.equal(unsafe.statusCode, 503);
    assert.deepEqual(unsafe.json(), {
      status: "rejected",
      code: "STORE_NOT_READY",
    });
    assert.deepEqual(await f.counts(), {
      commands: 2,
      decisions: 1,
      consents: 0,
      attempts: 0,
      xp: 0,
    });
  });
});

test("PostgreSQL: two HTTP commands share durable owner capacity under an observed row lock", async (t) => {
  await withPostgres(t, async (base, inner) => {
    const firstLocked = deferred<number>();
    const secondWaiting = deferred<number>();
    const release = deferred<void>();
    let locks = 0;
    const wrap = (db: Database): Database => ({
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            ...tx,
            async query<T>(sql: string, values?: unknown[]) {
              if (
                !sql.includes(
                  "from cg018_synthetic.runtime where id=1 for update",
                )
              )
                return tx.query<T>(sql, values);
              const ordinal = ++locks;
              const pid = (
                await tx.query<{ pid: number }>(
                  "select pg_backend_pid() as pid",
                )
              ).rows[0]!.pid;
              if (ordinal === 2) secondWaiting.resolve(pid);
              const result = await tx.query<T>(sql, values);
              if (ordinal === 1) {
                firstLocked.resolve(pid);
                await bounded(release.promise);
              }
              return result;
            },
          }),
        ),
    });
    const f = await permissionHttpFixture(inner, { base, quota: 1, wrap });
    const user = await f.person();
    const command = syntheticGrant();
    const first = f.call(user.token, command);
    let second: ReturnType<typeof f.call> | undefined;
    try {
      const holder = await bounded(firstLocked.promise);
      second = f.call(user.token, syntheticGrant("ai_transfer"));
      const waiter = await bounded(secondWaiting.promise);
      let observed = false;
      for (let i = 0; i < 100; i++) {
        const blocked = (
          await base.query<{ blocked: boolean }>(
            "select $1=any(pg_blocking_pids($2)) as blocked",
            [holder, waiter],
          )
        ).rows[0]!.blocked;
        if (blocked) {
          observed = true;
          break;
        }
        await delay(20);
      }
      assert.equal(
        observed,
        true,
        "Actual PostgreSQL row lock was not observed",
      );
    } finally {
      release.resolve();
      // Settle in-flight HTTP work before subtest hooks/role teardown even on
      // assertion/coordination failure. No external model work exists here.
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    assert.equal((await first).statusCode, 200);
    assert.equal((await second!).statusCode, 429);
    assert.equal((await f.call(user.token, command)).json().replayed, true);
    const revoke = syntheticRevoke("citygo_context", 1);
    assert.equal((await f.call(user.token, revoke)).statusCode, 200);
    assert.equal(
      (await f.call(user.token, syntheticRevoke("citygo_context", 2)))
        .statusCode,
      429,
    );
    assert.deepEqual(await f.counts(), {
      commands: 2,
      decisions: 1,
      consents: 0,
      attempts: 0,
      xp: 0,
    });
  });
});

test("PostgreSQL: lost HTTP acknowledgement is unconfirmed, same command recovers one committed event", async (t) => {
  await withPostgres(t, async (base, inner) => {
    let lose = true;
    const wrap = (db: Database): Database => ({
      ...db,
      async transaction(work) {
        let wrote = false;
        const result = await db.transaction((tx) =>
          work({
            ...tx,
            async query<T>(sql: string, values?: unknown[]) {
              const result = await tx.query<T>(sql, values);
              if (sql.includes("insert into cg018_synthetic.decisions"))
                wrote = true;
              return result;
            },
          }),
        );
        if (wrote && lose) {
          lose = false;
          throw new Error("synthetic-sensitive-diagnostic");
        }
        return result;
      },
    });
    const f = await permissionHttpFixture(inner, { base, wrap });
    const user = await f.person();
    const command = syntheticGrant("ai_transfer");
    const first = await f.call(user.token, command);
    assert.equal(first.statusCode, 503);
    assert.deepEqual(first.json(), {
      status: "unconfirmed",
      code: "STORAGE_UNAVAILABLE",
      retry: "same_command",
    });
    const recovered = await f.call(user.token, command);
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.json().replayed, true);
    assert.deepEqual(await f.counts(), {
      commands: 1,
      decisions: 1,
      consents: 0,
      attempts: 0,
      xp: 0,
    });
  });
});

test("PostgreSQL: configuration write blocks GET, which returns one coherent new snapshot", async (t) => {
  await withPostgres(t, async (base, inner) => {
    const firstLocked = deferred<number>();
    const readWaiting = deferred<number>();
    const release = deferred<void>();
    const wrap = (db: Database): Database => ({
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            ...tx,
            async query<T>(sql: string, values?: unknown[]) {
              if (
                sql.includes(
                  "from cg018_synthetic.runtime where id=1 for share",
                )
              )
                readWaiting.resolve(
                  (
                    await tx.query<{ pid: number }>(
                      "select pg_backend_pid() as pid",
                    )
                  ).rows[0]!.pid,
                );
              return tx.query<T>(sql, values);
            },
          }),
        ),
    });
    const f = await permissionHttpFixture(inner, { base, wrap });
    const user = await f.person();
    assert.equal((await f.call(user.token, syntheticGrant())).statusCode, 200);
    assert.equal(
      (await f.call(user.token, syntheticGrant("ai_transfer"))).statusCode,
      200,
    );
    const changed = prepareR1SyntheticNotice({
      ...syntheticContext.definition,
      version: "fixture-v2",
      body: "Changed synthetic context only, no legal effect.",
    });
    const nextRegistry = new R1SyntheticNoticeRegistry({
      notices: [changed, syntheticAi],
      current: {
        citygo_context: changed.reference,
        ai_transfer: syntheticAi.reference,
      },
    });
    const write = base.transaction(async (tx) => {
      await tx.query(
        "select id from cg018_synthetic.runtime where id=1 for update",
      );
      firstLocked.resolve(
        (await tx.query<{ pid: number }>("select pg_backend_pid() as pid"))
          .rows[0]!.pid,
      );
      await bounded(release.promise);
      const control = new R1SyntheticPermissionStore(
        { ...base, transaction: (work) => work(tx) },
        "synthetic_only",
      );
      assert.equal(
        (
          await control.replaceConfiguration(2, nextRegistry, {
            ...syntheticRoute,
            revision: 3,
          })
        ).status,
        "configuration_updated",
      );
    });
    let read: ReturnType<typeof f.current> | undefined;
    try {
      const holder = await bounded(firstLocked.promise);
      read = f.current(user.token);
      // inject is lazy until awaited/then'ed; start the request now.
      read.then(
        () => {},
        () => {},
      );
      const waiter = await bounded(readWaiting.promise);
      await observeBlock(base, holder, waiter);
    } finally {
      release.resolve();
      await Promise.allSettled([write, ...(read ? [read] : [])]);
    }
    await write;
    const response = await read!;
    assert.equal(response.statusCode, 200, response.body);
    const snapshot = r1SyntheticPermissionSnapshotSchema.parse(response.json());
    assert.equal(snapshot.configurationRevision, 3);
    assert.equal(
      snapshot.scopes.citygo_context.notice?.reference.id,
      changed.reference.id,
    );
    assert.equal(snapshot.scopes.ai_transfer.route?.revision, 3);
    for (const state of Object.values(snapshot.scopes)) {
      assert.equal(state.resolution, "requires_new_action");
      assert.equal(state.revision, 1);
      assert.equal(state.lastDecision?.configurationRevision, 2);
    }
    assert.equal((await f.counts())!.commands, 2);
  });
});

test("PostgreSQL: GET SHARE blocks revoke; an earlier snapshot and replay do not imply future authority", async (t) => {
  await withPostgres(t, async (base, inner) => {
    const readLocked = deferred<number>();
    const writeWaiting = deferred<number>();
    const release = deferred<void>();
    let firstRead = true;
    let waitForWrite = false;
    const wrap = (db: Database): Database => ({
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            ...tx,
            async query<T>(sql: string, values?: unknown[]) {
              if (
                waitForWrite &&
                sql.includes(
                  "from cg018_synthetic.runtime where id=1 for update",
                )
              )
                writeWaiting.resolve(
                  (
                    await tx.query<{ pid: number }>(
                      "select pg_backend_pid() as pid",
                    )
                  ).rows[0]!.pid,
                );
              const result = await tx.query<T>(sql, values);
              if (
                firstRead &&
                sql.includes(
                  "from cg018_synthetic.runtime where id=1 for share",
                )
              ) {
                firstRead = false;
                readLocked.resolve(
                  (
                    await tx.query<{ pid: number }>(
                      "select pg_backend_pid() as pid",
                    )
                  ).rows[0]!.pid,
                );
                await bounded(release.promise);
              }
              return result;
            },
          }),
        ),
    });
    const f = await permissionHttpFixture(inner, { base, wrap });
    const user = await f.person();
    const command = syntheticGrant();
    assert.equal((await f.call(user.token, command)).statusCode, 200);
    const read = f.current(user.token);
    read.then(
      () => {},
      () => {},
    );
    let write: ReturnType<typeof f.call> | undefined;
    try {
      const holder = await bounded(readLocked.promise);
      waitForWrite = true;
      write = f.call(user.token, syntheticRevoke("citygo_context", 1));
      write.then(
        () => {},
        () => {},
      );
      const waiter = await bounded(writeWaiting.promise);
      await observeBlock(base, holder, waiter);
    } finally {
      release.resolve();
      await Promise.allSettled([read, ...(write ? [write] : [])]);
    }
    const earlier = await read;
    assert.equal(earlier.statusCode, 200, earlier.body);
    assert.equal(
      earlier.json().scopes.citygo_context.resolution,
      "current_fixture_grant",
    );
    assert.equal((await write!).statusCode, 200);
    const now = await f.current(user.token);
    assert.equal(now.statusCode, 200, now.body);
    assert.equal(now.json().scopes.citygo_context.resolution, "revoked");
    assert.equal(now.json().scopes.citygo_context.revision, 2);
    assert.equal((await f.call(user.token, command)).json().replayed, true);
    assert.equal(
      (await f.current(user.token)).json().scopes.citygo_context.resolution,
      "revoked",
    );
    assert.equal((await f.counts())!.commands, 2);
  });
});

test("PostgreSQL: corrupted owner pointer fails closed without foreign reads or journal repair", async (t) => {
  await withPostgres(t, async (base, inner) => {
    const f = await permissionHttpFixture(inner, { base });
    const a = await f.person();
    const b = await f.person();
    const grant = await f.call(a.token, syntheticGrant());
    await f.call(a.token, syntheticRevoke("citygo_context", 1));
    await base.query(
      "update cg018_synthetic.decisions set revision=1,event_id=$1 where owner_id=$2",
      [grant.json().receipt.eventId, a.id],
    );
    const broken = await f.current(a.token);
    assert.equal(broken.statusCode, 503);
    assert.deepEqual(broken.json(), {
      status: "rejected",
      code: "STORED_DATA_INVALID",
    });
    const other = await f.current(b.token);
    assert.equal(other.statusCode, 200, other.body);
    assert.equal(other.json().ownerId, b.id);
    assert.equal(other.json().scopes.citygo_context.lastDecision, null);
    assert.equal(
      (await f.current(b.token, "?ownerId=" + a.id)).statusCode,
      400,
    );
    assert.equal((await f.counts())!.commands, 2);
  });
});
