import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  connectDatabase,
  DomainError,
  EmailRegistration,
  PasswordRecovery,
  AccountAccess,
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
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const status = (value: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === value;
function input(
  email = "synthetic-registration@example.test",
  ip = "synthetic-ip",
) {
  return {
    id: randomUUID(),
    email,
    passwordHash: "synthetic-hashed-password",
    proofHash: hash("proof"),
    codeHash: hash("code"),
    recipientKey: hash("recipient:" + email),
    ipKey: hash("ip:" + ip),
  };
}
function confirmation(value: ReturnType<typeof input>, session = "session") {
  return {
    id: value.id,
    proofHash: value.proofHash,
    codeHash: value.codeHash,
    sessionHash: hash(session),
  };
}
async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base, "An explicit disposable TEST_DATABASE_URL is required");
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  const name = "cg_recovery_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_recovery_test_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base);
  let created = false;
  const cleanup: { db?: Database } = {};
  t.after(async () => {
    try {
      await cleanup.db?.close();
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
    "Disposable PostgreSQL: independent backend lock waiting is observed, not simulated",
  );
  return db;
}
function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic PostgreSQL barrier timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function tagged(
  db: Database,
  tag: string,
  gate?: {
    entered: ReturnType<typeof signal>;
    release: ReturnType<typeof signal>;
  },
): Database {
  let held = false;
  return {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('application_name',$1,true)", [tag]);
        return work({
          exec: (sql) => tx.exec(sql),
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            if (!held && gate && sql.includes("from account_security_state")) {
              held = true;
              gate.entered.open();
              await gate.release.promise;
            }
            return result;
          },
        });
      }),
  };
}
async function waitForLock(db: Database, waiter: string, holder: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await db.query<{ blocked: boolean }>(
      `select exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
       on holding.pid=any(pg_blocking_pids(waiting.pid)) where waiting.application_name=$1
       and holding.application_name=$2 and waiting.pid<>holding.pid and waiting.wait_event_type='Lock') as blocked`,
      [waiter, holder],
    );
    if (result.rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    "Second PostgreSQL backend did not demonstrably wait for the first backend's lock",
  );
}
function observe<T>(promise: Promise<T>) {
  void promise.catch(() => {});
  return promise;
}

async function seeded(db: Database) {
  const registration = new EmailRegistration(db),
    v = input();
  await registration.begin(v);
  await registration.markSent(v.id, v.codeHash);
  const user = await registration.confirm(confirmation(v));
  await db.query(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '61 minutes'",
  );
  const recovery = {
    id: randomUUID(),
    email: v.email,
    proofHash: hash("recovery-proof"),
    codeHash: hash("recovery-code"),
    recipientKey: v.recipientKey,
    ipKey: v.ipKey,
  };
  return {
    user,
    value: recovery,
    confirmation: {
      id: recovery.id,
      proofHash: recovery.proofHash,
      codeHash: recovery.codeHash,
      newPasswordHash: "new-synthetic-password-hash",
    },
  };
}

test(
  "PostgreSQL independent confirmations serialize, change password once and revoke all sessions",
  pgOnly,
  async (t) => {
    const db = await fixture(t),
      f = await seeded(db),
      initial = new PasswordRecovery(db);
    await initial.begin(f.value);
    await initial.markSent(f.value.id, f.value.codeHash);
    const gate = { entered: signal(), release: signal() },
      prefix = "cg_recovery_" + randomUUID().replaceAll("-", "");
    const one = observe(
      new PasswordRecovery(tagged(db, prefix + "_first", gate)).confirm(
        f.confirmation,
      ),
    );
    let two: Promise<unknown> | undefined;
    try {
      await within(gate.entered.promise);
      two = observe(
        new PasswordRecovery(tagged(db, prefix + "_second")).confirm({
          ...f.confirmation,
          newPasswordHash: "loser-hash",
        }),
      );
      await waitForLock(db, prefix + "_second", prefix + "_first");
    } finally {
      gate.release.open();
      await Promise.allSettled([one, ...(two ? [two] : [])]);
    }
    await one;
    assert.ok(two);
    await assert.rejects(two, status(400));
    assert.equal(
      (await new AccountAccess(db).credentials(f.value.email))?.password_hash,
      f.confirmation.newPasswordHash,
    );
    assert.equal((await db.query("select 1 from sessions")).rows.length, 0);
    assert.equal(
      (
        await db.query(
          "select 1 from audit_log where action='account-password-recovered'",
        )
      ).rows.length,
      1,
    );
  },
);

test(
  "PostgreSQL ordinary password rotation and recovery cannot resurrect a stale credential in either lock order",
  pgOnly,
  async (t) => {
    for (const recoveryFirst of [false, true]) {
      const db = await fixture(t),
        f = await seeded(db),
        initial = new PasswordRecovery(db);
      await initial.begin(f.value);
      await initial.markSent(f.value.id, f.value.codeHash);
      const gate = { entered: signal(), release: signal() },
        prefix = "cg_recovery_" + randomUUID().replaceAll("-", "");
      const recovery = (store: Database) =>
        new PasswordRecovery(store).confirm(f.confirmation);
      const rotation = (store: Database) =>
        new AccountAccess(store).changePassword(
          f.user.id,
          "synthetic-hashed-password",
          "normal-rotation-hash",
          hash("rotation-session"),
        );
      const one = observe<unknown>(
        (recoveryFirst ? recovery : rotation)(
          tagged(db, prefix + "_first", gate),
        ),
      );
      let two: Promise<unknown> | undefined;
      try {
        await within(gate.entered.promise);
        two = observe<unknown>(
          (recoveryFirst ? rotation : recovery)(tagged(db, prefix + "_second")),
        );
        await waitForLock(db, prefix + "_second", prefix + "_first");
      } finally {
        gate.release.open();
        await Promise.allSettled([one, ...(two ? [two] : [])]);
      }
      await one;
      assert.ok(two);
      await assert.rejects(two, status(recoveryFirst ? 409 : 400));
      await assert.rejects(
        new AccountAccess(db).createVerifiedSession(
          f.user.id,
          "synthetic-hashed-password",
          hash("late-stale-login"),
        ),
        status(401),
      );
      assert.equal(
        (await new AccountAccess(db).credentials(f.value.email))?.password_hash,
        recoveryFirst ? f.confirmation.newPasswordHash : "normal-rotation-hash",
      );
      assert.equal(
        (await db.query("select 1 from sessions")).rows.length,
        recoveryFirst ? 0 : 1,
      );
    }
  },
);

test(
  "PostgreSQL actual API grants permit recovery and CAS delivery while denying identity, lifetime, deletion and Worker reads",
  pgOnly,
  async (t) => {
    const db = await fixture(t),
      f = await seeded(db),
      suffix = randomUUID().replaceAll("-", "");
    const roles = {
      citygo_api: `cg_recovery_api_${suffix}`,
      citygo_worker: `cg_recovery_worker_${suffix}`,
      citygo_backup: `cg_recovery_backup_${suffix}`,
    };
    const created: string[] = [],
      failures: unknown[] = [];
    try {
      for (const role of Object.values(roles)) {
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
      await db.exec(
        "revoke all on function citygo_guard_password_recovery() from public",
      );
      const asRole = <T>(role: string, work: (tx: Sql) => Promise<T>) =>
        db.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          return work(tx);
        });
      const runtime: Database = {
        ...db,
        query: <T>(sql: string, params?: unknown[]) =>
          asRole(roles.citygo_api, (tx) => tx.query<T>(sql, params)),
        exec: (sql) => asRole(roles.citygo_api, (tx) => tx.exec(sql)),
        transaction: (work) => asRole(roles.citygo_api, work),
      };
      const store = new PasswordRecovery(runtime);
      await store.begin(f.value);
      await store.markSent(f.value.id, f.value.codeHash);
      await assert.rejects(
        store.confirm({ ...f.confirmation, codeHash: hash("wrong-code") }),
        status(400),
      );
      await store.confirm(f.confirmation);
      for (const column of [
        "target_user_id",
        "credential_digest",
        "proof_hash",
        "recipient_key",
        "created_at",
        "expires_at",
      ])
        await assert.rejects(
          runtime.query(
            `update password_recovery_challenges set ${column}=${column} where false`,
          ),
          { code: "42501" },
        );
      await assert.rejects(
        runtime.query("delete from password_recovery_challenges where false"),
        { code: "42501" },
      );
      await assert.rejects(
        runtime.query("truncate password_recovery_challenges"),
        { code: "42501" },
      );
      await assert.rejects(
        asRole(roles.citygo_worker, (tx) =>
          tx.query("select 1 from password_recovery_challenges"),
        ),
        { code: "42501" },
      );
      assert.equal((await db.query("select 1 from sessions")).rows.length, 0);
    } catch (error) {
      failures.push(error);
    } finally {
      for (const role of created.reverse())
        try {
          await db.exec(`drop owned by ${role};drop role ${role}`);
        } catch (error) {
          failures.push(error);
        }
    }
    if (failures.length)
      throw new AggregateError(failures, "Synthetic recovery grants failed");
  },
);

test(
  "PostgreSQL registration and recovery serialize shared global admission in both lock orders, including decoys",
  pgOnly,
  async (t) => {
    for (const recoveryFirst of [false, true]) {
      const db = await fixture(t),
        limits = { daily: 1, total: 1 };
      const original = input(
        "registration-quota@example.test",
        "registration-ip",
      );
      const v = {
        id: randomUUID(),
        email: "decoy-quota@example.test",
        proofHash: hash("decoy-proof"),
        codeHash: hash("decoy-code"),
        recipientKey: hash("decoy-recipient"),
        ipKey: hash("decoy-ip"),
      };
      const gate = { entered: signal(), release: signal() },
        prefix = "cg_recovery_" + randomUUID().replaceAll("-", "");
      const recovery = (store: Database) =>
        new PasswordRecovery(store, limits).begin(v);
      const registration = (store: Database) =>
        new EmailRegistration(store, limits).begin(original);
      const one = observe<unknown>(
        (recoveryFirst ? recovery : registration)(
          tagged(db, prefix + "_first", gate),
        ),
      );
      let two: Promise<unknown> | undefined;
      try {
        await within(gate.entered.promise);
        two = observe<unknown>(
          (recoveryFirst ? registration : recovery)(
            tagged(db, prefix + "_second"),
          ),
        );
        await waitForLock(db, prefix + "_second", prefix + "_first");
      } finally {
        gate.release.open();
        await Promise.allSettled([one, ...(two ? [two] : [])]);
      }
      await one;
      assert.ok(two);
      await assert.rejects(two, status(429));
      for (const kind of ["recipient", "ip"])
        assert.equal(
          (
            await db.query(
              "select 1 from email_registration_rate_events where kind=$1",
              [kind],
            )
          ).rows.length,
          1,
        );
      assert.equal(
        (await db.query("select 1 from password_recovery_challenges")).rows
          .length,
        recoveryFirst ? 1 : 0,
      );
      assert.equal((await db.query("select 1 from users")).rows.length, 0);
    }
  },
);
