import { syntheticServiceConsents } from "./test-service-consents.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  connectDatabase,
  DomainError,
  EmailRegistration,
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
    consents: syntheticServiceConsents,
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
  const name = "cg_email_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_email_test_[a-f0-9]{32}$/);
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
            if (
              !held &&
              gate &&
              sql.startsWith("select id from account_security_state")
            ) {
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

test(
  "PostgreSQL concurrent confirmation consumes the challenge and creates its account/session exactly once",
  pgOnly,
  async (t) => {
    const db = await fixture(t),
      value = input();
    const initial = new EmailRegistration(db);
    await initial.begin(value);
    await initial.markSent(value.id, value.codeHash);
    const gate = { entered: signal(), release: signal() },
      prefix = "cg_email_" + randomUUID().replaceAll("-", "");
    const one = observe(
      new EmailRegistration(tagged(db, prefix + "_first", gate)).confirm(
        confirmation(value, "winner-session"),
      ),
    );
    let two: Promise<unknown> | undefined;
    try {
      await within(gate.entered.promise);
      two = observe(
        new EmailRegistration(tagged(db, prefix + "_second")).confirm(
          confirmation(value, "loser-session"),
        ),
      );
      await waitForLock(db, prefix + "_second", prefix + "_first");
    } finally {
      gate.release.open();
      await Promise.allSettled([one, ...(two ? [two] : [])]);
    }
    const user = await one;
    assert.ok(two);
    await assert.rejects(two, status(400));
    assert.deepEqual(
      (await db.query("select user_id::text,token_hash from sessions")).rows,
      [{ user_id: user.id, token_hash: hash("winner-session") }],
    );
    for (const table of [
      "users",
      "user_credentials",
      "account_email_verifications",
    ])
      assert.equal((await db.query(`select 1 from ${table}`)).rows.length, 1);
    assert.equal(
      (await db.query("select 1 from ai_credit_entries")).rows.length,
      0,
    );
  },
);

test(
  "PostgreSQL concurrent recipient and IP quota admissions serialize across repository instances",
  pgOnly,
  async (t) => {
    const db = await fixture(t);
    for (const sameRecipient of [true, false]) {
      const prefix = "cg_email_" + randomUUID().replaceAll("-", ""),
        gate = { entered: signal(), release: signal() };
      const first = input(
        sameRecipient
          ? "synthetic-same@example.test"
          : "synthetic-tenth@example.test",
        sameRecipient ? "recipient-test-ip" : "ip-test",
      );
      const second = input(
        sameRecipient ? first.email : "synthetic-eleventh@example.test",
        sameRecipient ? "different-recipient-test-ip" : "ip-test",
      );
      if (!sameRecipient)
        for (let n = 0; n < 9; n++)
          await new EmailRegistration(db).begin(
            input(`synthetic-ip-${n}@example.test`, "ip-test"),
          );
      const one = observe(
        new EmailRegistration(tagged(db, prefix + "_first", gate), {
          daily: null,
          total: null,
        }).begin(first),
      );
      let two: Promise<unknown> | undefined;
      try {
        await within(gate.entered.promise);
        two = observe(
          new EmailRegistration(tagged(db, prefix + "_second"), {
            daily: null,
            total: null,
          }).begin(second),
        );
        await waitForLock(db, prefix + "_second", prefix + "_first");
      } finally {
        gate.release.open();
        await Promise.allSettled([one, ...(two ? [two] : [])]);
      }
      await one;
      assert.ok(two);
      await assert.rejects(two, status(429));
      assert.equal(
        (
          await db.query("select 1 from email_registrations where id=$1", [
            second.id,
          ])
        ).rows.length,
        0,
      );
    }
  },
);

test(
  "PostgreSQL mixed unlimited/finite global admissions share the same security lock and never exceed the finite field",
  pgOnly,
  async (t) => {
    for (const limits of [
      { daily: 1, total: null },
      { daily: null, total: 1 },
    ]) {
      const db = await fixture(t),
        prefix = "cg_email_global_" + randomUUID().replaceAll("-", ""),
        gate = { entered: signal(), release: signal() };
      const first = input(
        "mixed-first-" + prefix + "@example.test",
        "mixed-first-ip-" + prefix,
      );
      const second = input(
        "mixed-second-" + prefix + "@example.test",
        "mixed-second-ip-" + prefix,
      );
      const one = observe(
        new EmailRegistration(
          tagged(db, prefix + "_first", gate),
          limits,
        ).begin(first),
      );
      let two: Promise<unknown> | undefined;
      try {
        await within(gate.entered.promise);
        two = observe(
          new EmailRegistration(tagged(db, prefix + "_second"), limits).begin(
            second,
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
      await new EmailRegistration(db, limits).cancelDelivery(
        first.id,
        first.codeHash,
      );
      await assert.rejects(
        new EmailRegistration(db, limits).begin(
          input(
            "mixed-after-restart-" + prefix + "@example.test",
            "mixed-after-restart-ip-" + prefix,
          ),
        ),
        status(429),
      );
      assert.equal(
        (await db.query("select 1 from email_registrations")).rows.length,
        1,
      );
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
    }
  },
);

test(
  "PostgreSQL actual runtime grants support registration but deny identity rewrite, deletion and Worker access",
  pgOnly,
  async (t) => {
    const db = await fixture(t),
      suffix = randomUUID().replaceAll("-", "");
    const roles = {
      citygo_api: `cg_email_api_${suffix}`,
      citygo_worker: `cg_email_worker_${suffix}`,
      citygo_backup: `cg_email_backup_${suffix}`,
    };
    const created: string[] = [],
      failures: unknown[] = [];
    try {
      for (const role of Object.values(roles)) {
        assert.match(role, /^cg_email_(api|worker|backup)_[a-f0-9]{32}$/);
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
        "revoke all on function citygo_guard_email_registration() from public",
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
      const store = new EmailRegistration(runtime),
        value = input();
      await store.begin(value);
      await store.markSent(value.id, value.codeHash);
      await assert.rejects(
        store.confirm({ ...confirmation(value), codeHash: hash("wrong-code") }),
        status(400),
      );
      const user = await store.confirm(confirmation(value));
      assert.ok(user.id);
      assert.equal(
        (
          await db.query<{ attempts: number }>(
            "select attempts from email_registrations",
          )
        ).rows[0]!.attempts,
        1,
      );
      for (const table of [
        "email_registrations",
        "email_registration_rate_events",
        "account_email_verifications",
      ]) {
        for (const query of [
          `delete from ${table} where false`,
          `truncate ${table}`,
        ])
          await assert.rejects(runtime.query(query), { code: "42501" });
        await assert.rejects(
          asRole(roles.citygo_worker, (tx) =>
            tx.query(`select 1 from ${table}`),
          ),
          { code: "42501" },
        );
      }
      for (const column of [
        "email",
        "password_hash",
        "proof_hash",
        "recipient_key",
        "created_at",
      ])
        await assert.rejects(
          runtime.query(
            `update email_registrations set ${column}=${column} where false`,
          ),
          { code: "42501" },
        );
      await assert.rejects(
        runtime.query(
          "update account_email_verifications set email=email where false",
        ),
        { code: "42501" },
      );
      assert.equal((await db.query("select 1 from sessions")).rows.length, 1);
    } catch (error) {
      failures.push(error);
    } finally {
      for (const role of created.reverse()) {
        try {
          await db.exec(`drop owned by ${role}; drop role ${role}`);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Synthetic email registration grants checks failed",
      );
  },
);
