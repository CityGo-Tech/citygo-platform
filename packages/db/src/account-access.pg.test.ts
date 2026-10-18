import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AccountAccess,
  DomainError,
  Repository,
  connectDatabase,
  migrate,
  type Database,
  type Sql,
} from "./index.js";

const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires opt-in disposable PostgreSQL; PGlite is not concurrency evidence",
  timeout: 60000,
};

async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base, "An explicit disposable TEST_DATABASE_URL is required");
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  const name = "cg_accounts_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_accounts_test_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base);
  let created = false;
  const cleanup: { db?: Database } = {};
  t.after(async () => {
    try {
      await cleanup.db?.close();
      // Only this test's generated, confirmed-created database is removable.
      if (created) await admin.query(`drop database "${name}"`);
    } finally {
      await admin.close();
    }
  });
  await admin.query(`create database "${name}" template template0`);
  created = true;
  url.pathname = "/" + name;
  const db = await connectDatabase(url.toString());
  cleanup.db = db;
  await migrate(db);
  t.diagnostic(
    "Backend: isolated PostgreSQL database; independent backend locks are observed",
  );
  return { db, accounts: new AccountAccess(db), repo: new Repository(db) };
}

function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
type Pause = {
  kind: "query" | "exec";
  match: string;
  entered: ReturnType<typeof signal>;
  release: ReturnType<typeof signal>;
};
function pause(kind: Pause["kind"], match: string): Pause {
  return { kind, match, entered: signal(), release: signal() };
}
async function within<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Timed out waiting for a synthetic PostgreSQL barrier"),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Real transaction boundaries are retained. Two concurrent calls to this pool
// pin different pg clients; pg_stat_activity below proves actual lock waiting.
function tagged(db: Database, tag: string, gate?: Pause): Database {
  let held = false;
  const maybePause = async (kind: Pause["kind"], sql: string) => {
    if (!held && gate?.kind === kind && sql.startsWith(gate.match)) {
      held = true;
      gate.entered.open();
      await gate.release.promise;
    }
  };
  return {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('application_name',$1,true)", [tag]);
        return work({
          exec: async (sql) => {
            await tx.exec(sql);
            await maybePause("exec", sql);
          },
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            await maybePause("query", sql);
            return result;
          },
        });
      }),
  };
}
const securityQuery = "select bootstrap_completed from account_security_state";
async function waitForLock(db: Database, waiter: string, holder: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await db.query<{ blocked: boolean }>(
      `select exists (
         select 1 from pg_stat_activity waiting join pg_stat_activity holding
           on holding.pid=any(pg_blocking_pids(waiting.pid))
         where waiting.application_name=$1 and holding.application_name=$2
           and waiting.pid<>holding.pid and waiting.wait_event_type='Lock'
       ) as blocked`,
      [waiter, holder],
    );
    if (result.rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    "The second backend must really wait for the first backend's PostgreSQL lock",
  );
}
function status(code: number) {
  return (error: unknown) =>
    error instanceof DomainError && error.statusCode === code;
}
function observe<T>(promise: Promise<T>): Promise<T> {
  // Do not turn an expected early rejection into an unhandled process failure.
  void promise.catch(() => {});
  return promise;
}

test(
  "PostgreSQL verified login and password rotation serialize in both lock orders",
  pgOnly,
  async (t) => {
    for (const rotateFirst of [true, false]) {
      await t.test(
        rotateFirst
          ? "rotation wins before old login"
          : "old login commits before rotation",
        async (t) => {
          const { db, accounts, repo } = await fixture(t);
          const user = await repo.register(
            "race@example.test",
            "synthetic-old-hash",
          );
          await accounts.createVerifiedSession(
            user,
            "synthetic-old-hash",
            "a".repeat(64),
          );
          const gate = pause("query", securityQuery);
          const prefix = "cgacc_" + randomUUID().replaceAll("-", "");
          const first = new AccountAccess(tagged(db, prefix + "_first", gate));
          const second = new AccountAccess(tagged(db, prefix + "_second"));
          const rotate = (access: AccountAccess) =>
            access.changePassword(
              user,
              "synthetic-old-hash",
              "synthetic-new-hash",
              "b".repeat(64),
            );
          const login = (access: AccountAccess) =>
            access.createVerifiedSession(
              user,
              "synthetic-old-hash",
              "c".repeat(64),
            );
          const one = observe(rotateFirst ? rotate(first) : login(first));
          let two: ReturnType<typeof rotate> | undefined;
          try {
            await within(gate.entered.promise);
            two = observe(rotateFirst ? login(second) : rotate(second));
            await waitForLock(db, prefix + "_second", prefix + "_first");
          } finally {
            gate.release.open();
            await Promise.allSettled([one, ...(two ? [two] : [])]);
          }
          assert.ok(two);
          const results = await Promise.allSettled([one, two]);
          assert.equal(results[0]!.status, "fulfilled");
          if (rotateFirst) {
            assert.equal(results[1]!.status, "rejected");
            assert.ok(
              results[1]!.status === "rejected" &&
                status(401)(results[1]!.reason),
            );
          } else assert.equal(results[1]!.status, "fulfilled");
          assert.equal(
            (await accounts.credentials("race@example.test"))?.password_hash,
            "synthetic-new-hash",
          );
          assert.deepEqual(
            (
              await db.query(
                "select token_hash from sessions where user_id=$1",
                [user],
              )
            ).rows,
            [{ token_hash: "b".repeat(64) }],
          );
          await assert.rejects(
            accounts.createVerifiedSession(
              user,
              "synthetic-old-hash",
              "d".repeat(64),
            ),
            status(401),
          );
          await accounts.createVerifiedSession(
            user,
            "synthetic-new-hash",
            "e".repeat(64),
          );
        },
      );
    }
  },
);

test(
  "PostgreSQL two password rotations from the same verified hash have one CAS winner",
  pgOnly,
  async (t) => {
    const { db, accounts, repo } = await fixture(t);
    const user = await repo.register("cas@example.test", "synthetic-old-hash");
    const gate = pause("query", securityQuery);
    const prefix = "cgacc_" + randomUUID().replaceAll("-", "");
    const first = new AccountAccess(tagged(db, prefix + "_first", gate));
    const second = new AccountAccess(tagged(db, prefix + "_second"));
    const one = observe(
      first.changePassword(
        user,
        "synthetic-old-hash",
        "winner-hash",
        "1".repeat(64),
      ),
    );
    let two: ReturnType<typeof accounts.changePassword> | undefined;
    try {
      await within(gate.entered.promise);
      two = observe(
        second.changePassword(
          user,
          "synthetic-old-hash",
          "loser-hash",
          "2".repeat(64),
        ),
      );
      await waitForLock(db, prefix + "_second", prefix + "_first");
    } finally {
      gate.release.open();
      await Promise.allSettled([one, ...(two ? [two] : [])]);
    }
    await one;
    assert.ok(two);
    await assert.rejects(two, status(409));
    assert.equal(
      (await accounts.credentials("cas@example.test"))?.password_hash,
      "winner-hash",
    );
    assert.deepEqual((await db.query("select token_hash from sessions")).rows, [
      { token_hash: "1".repeat(64) },
    ]);
    assert.equal(
      (
        await db.query(
          "select 1 from audit_log where action='account-password-changed'",
        )
      ).rows.length,
      1,
    );
  },
);

test(
  "PostgreSQL competing super-admin demotions recheck the actor after a real lock wait",
  pgOnly,
  async (t) => {
    const { db, accounts, repo } = await fixture(t);
    const owner = await accounts.bootstrapAdmin("synthetic-bootstrap-hash");
    await accounts.changePassword(
      owner.id,
      "synthetic-bootstrap-hash",
      "synthetic-owner-hash",
      "3".repeat(64),
    );
    const peer = await repo.register(
      "peer@example.test",
      "synthetic-peer-hash",
    );
    await accounts.setRole(owner.id, peer, "super_admin");
    await accounts.createVerifiedSession(
      peer,
      "synthetic-peer-hash",
      "4".repeat(64),
    );
    const gate = pause("query", securityQuery);
    const prefix = "cgacc_" + randomUUID().replaceAll("-", "");
    const first = new AccountAccess(tagged(db, prefix + "_first", gate));
    const second = new AccountAccess(tagged(db, prefix + "_second"));
    const one = observe(first.setRole(owner.id, peer, "admin"));
    let two: ReturnType<typeof accounts.setRole> | undefined;
    try {
      await within(gate.entered.promise);
      two = observe(second.setRole(peer, owner.id, "admin"));
      await waitForLock(db, prefix + "_second", prefix + "_first");
    } finally {
      gate.release.open();
      await Promise.allSettled([one, ...(two ? [two] : [])]);
    }
    assert.equal((await one).role, "admin");
    assert.ok(two);
    await assert.rejects(two, status(403));
    assert.equal((await accounts.info(owner.id))?.role, "super_admin");
    assert.equal((await accounts.info(peer))?.role, "admin");
    assert.equal(
      (
        await db.query(
          "select 1 from users where role='super_admin' and status='active'",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (await db.query("select 1 from sessions where user_id=$1", [peer])).rows
        .length,
      0,
    );
    await assert.rejects(
      accounts.setRole(owner.id, owner.id, "user"),
      status(409),
    );
  },
);

test(
  "PostgreSQL bootstrap and first registration share the real users table lock",
  pgOnly,
  async (t) => {
    for (const bootstrapFirst of [true, false]) {
      await t.test(
        bootstrapFirst
          ? "bootstrap before registration and another bootstrap"
          : "registration before two bootstraps",
        async (t) => {
          const { db, accounts, repo } = await fixture(t);
          const gate = bootstrapFirst
            ? pause("exec", "lock table users in share row exclusive mode")
            : pause("query", "insert into users(auth_subject)");
          const prefix = "cgacc_" + randomUUID().replaceAll("-", "");
          const firstDb = tagged(db, prefix + "_first", gate);
          const nextDb = tagged(db, prefix + "_second");
          const thirdDb = tagged(db, prefix + "_third");
          const one = observe<unknown>(
            bootstrapFirst
              ? new AccountAccess(firstDb).bootstrapAdmin(
                  "synthetic-bootstrap-hash",
                )
              : new Repository(firstDb).register(
                  "first@example.test",
                  "synthetic-user-hash",
                ),
          );
          let two: Promise<unknown> | undefined;
          let three: ReturnType<typeof accounts.bootstrapAdmin> | undefined;
          try {
            await within(gate.entered.promise);
            two = observe<unknown>(
              bootstrapFirst
                ? new Repository(nextDb).register(
                    "first@example.test",
                    "synthetic-user-hash",
                  )
                : new AccountAccess(nextDb).bootstrapAdmin(
                    "synthetic-bootstrap-hash",
                  ),
            );
            await waitForLock(db, prefix + "_second", prefix + "_first");
            three = observe(
              new AccountAccess(thirdDb).bootstrapAdmin("other-bootstrap-hash"),
            );
            await waitForLock(
              db,
              prefix + "_third",
              bootstrapFirst ? prefix + "_first" : prefix + "_second",
            );
          } finally {
            gate.release.open();
            await Promise.allSettled([
              one,
              ...(two ? [two] : []),
              ...(three ? [three] : []),
            ]);
          }
          await one;
          assert.ok(two);
          assert.ok(three);
          if (bootstrapFirst) await two;
          else await assert.rejects(two, status(409));
          await assert.rejects(three, status(409));
          const users = (
            await db.query<{ username: string | null; role: string }>(
              "select username,role from users order by id",
            )
          ).rows;
          assert.equal(users.length, bootstrapFirst ? 2 : 1);
          assert.equal(
            users.filter((user) => user.role === "super_admin").length,
            bootstrapFirst ? 1 : 0,
          );
          assert.equal(
            users.filter((user) => user.username === "admin").length,
            bootstrapFirst ? 1 : 0,
          );
          assert.equal(
            (
              await db.query<{ bootstrap_completed: boolean }>(
                "select bootstrap_completed from account_security_state where id=1",
              )
            ).rows[0]!.bootstrap_completed,
            bootstrapFirst,
          );
          assert.equal(
            (await accounts.credentials("first@example.test"))?.role,
            "user",
          );
          assert.equal(await repo.session("uncreated-session"), undefined);
        },
      );
    }
  },
);

test(
  "PostgreSQL actual deployment grants permit account operations but not user erasure",
  pgOnly,
  async (t) => {
    const { db, accounts } = await fixture(t);
    const owner = await accounts.bootstrapAdmin("synthetic-bootstrap-hash");
    await accounts.changePassword(
      owner.id,
      "synthetic-bootstrap-hash",
      "synthetic-owner-hash",
      "5".repeat(64),
    );
    const suffix = randomUUID().replaceAll("-", "");
    const roles = {
      citygo_api: `cgacc_api_${suffix}`,
      citygo_worker: `cgacc_worker_${suffix}`,
      citygo_backup: `cgacc_backup_${suffix}`,
    };
    const created: string[] = [];
    const failures: unknown[] = [];
    try {
      for (const role of Object.values(roles)) {
        assert.match(role, /^cgacc_(api|worker|backup)_[a-f0-9]{32}$/);
        await db.exec(`create role ${role} nologin`);
        created.push(role);
        await db.exec(`grant usage on schema public to ${role}`);
      }
      const grants = (
        await readFile(
          new URL("../../../deploy/postgres/grants.sql", import.meta.url),
          "utf8",
        )
      )
        .replace(/^\\set[^\r\n]*(?:\r?\n|$)/gm, "")
        .replace(
          /\bcitygo_(api|worker|backup)\b/g,
          (name) => roles[name as keyof typeof roles],
        );
      await db.exec(grants);
      const asApi = <T>(work: (tx: Sql) => Promise<T>) =>
        db.transaction(async (tx) => {
          await tx.exec(`set local role ${roles.citygo_api}`);
          assert.equal(
            (await tx.query<{ role: string }>("select current_user as role"))
              .rows[0]!.role,
            roles.citygo_api,
          );
          return work(tx);
        });
      const runtime: Database = {
        ...db,
        exec: (sql) => asApi((tx) => tx.exec(sql)),
        query: <T>(sql: string, params?: unknown[]) =>
          asApi((tx) => tx.query<T>(sql, params)),
        transaction: asApi,
      };
      const api = new AccountAccess(runtime);
      const user = await new Repository(runtime).register(
        "runtime@example.test",
        "synthetic-old-hash",
      );
      await api.createVerifiedSession(
        user,
        "synthetic-old-hash",
        "6".repeat(64),
      );
      await api.changePassword(
        user,
        "synthetic-old-hash",
        "synthetic-new-hash",
        "7".repeat(64),
      );
      assert.equal((await api.list(owner.id)).length, 2);
      assert.equal((await api.setRole(owner.id, user, "admin")).role, "admin");
      await assert.rejects(runtime.query("delete from users where false"), {
        code: "42501",
      });
      await assert.rejects(
        runtime.query(
          "update user_credentials set user_id=user_id where false",
        ),
        { code: "42501" },
      );
      await assert.rejects(
        runtime.query(
          "insert into account_security_state(id) values (1) on conflict do nothing",
        ),
        { code: "42501" },
      );
      assert.equal((await db.query("select 1 from users")).rows.length, 2);
      assert.equal(
        (await db.query("select 1 from sessions where user_id=$1", [user])).rows
          .length,
        0,
      );
      assert.equal(
        (
          await db.query<{ reset: boolean }>(
            "select current_user=session_user as reset",
          )
        ).rows[0]!.reset,
        true,
      );
    } catch (error) {
      failures.push(error);
    } finally {
      // Cluster-global test roles are generated here, never shared runtime roles.
      for (const role of created.reverse()) {
        try {
          await db.exec(`drop owned by ${role}; drop role ${role}`);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        assert.deepEqual(
          (
            await db.query(
              "select rolname from pg_roles where rolname=any($1::text[])",
              [created],
            )
          ).rows,
          [],
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Account runtime grants or generated-role cleanup failed",
      );
  },
);
