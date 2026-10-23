import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  connectDatabase,
  DomainError,
  EmailRegistration,
  migrate,
  type Database,
  type EmailSendLimits,
} from "./index.js";

const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires opt-in disposable PostgreSQL; PGlite is not race evidence",
  timeout: 60_000,
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const status = (value: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === value;
function input() {
  const id = randomUUID();
  return {
    id,
    email: `synthetic-${id}@example.test`,
    passwordHash: "synthetic-email-global-hashed-password",
    proofHash: hash("synthetic-proof:" + id),
    codeHash: hash("synthetic-code:" + id),
    recipientKey: hash("synthetic-recipient:" + id),
    ipKey: hash("synthetic-ip:" + id),
  };
}

async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base, "An explicit disposable TEST_DATABASE_URL is required");
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.ok(
    ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
      (url.port === "55438" && url.pathname === "/citygo_synthetic"),
    "Only the designated local synthetic PostgreSQL base is permitted",
  );
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  const name = "cg_email_global_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_email_global_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base);
  const connections = new Set<Database>();
  let created = false;
  t.after(async () => {
    try {
      await Promise.all([...connections].map((db) => db.close()));
      if (created) await admin.query(`drop database "${name}"`);
    } finally {
      await admin.close();
    }
  });
  await admin.query(`create database "${name}" template template0`);
  created = true;
  url.pathname = "/" + name;
  const connect = async () => {
    const db = await connectDatabase(url.toString());
    connections.add(db);
    return db;
  };
  const db = await connect();
  await migrate(db);
  t.diagnostic("Isolated synthetic PostgreSQL clone; no provider network I/O");
  const disconnect = async (connection: Database) => {
    await connection.close();
    connections.delete(connection);
  };
  return { db, connect, disconnect };
}

function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
async function within<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Synthetic email PostgreSQL barrier timed out")),
          5_000,
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
              gate &&
              !held &&
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
async function blocked(db: Database, waiter: string, holder: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await db.query<{ blocked: boolean }>(
      `select exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
       on holding.pid=any(pg_blocking_pids(waiting.pid))
       where waiting.application_name=$1 and holding.application_name=$2
       and waiting.pid<>holding.pid and waiting.wait_event_type='Lock') as blocked`,
      [waiter, holder],
    );
    if (result.rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    "A distinct PostgreSQL backend did not demonstrably wait on the security lock",
  );
}
function observe<T>(promise: Promise<T>) {
  void promise.catch(() => undefined);
  return promise;
}
async function race(db: Database, limits: EmailSendLimits) {
  const gate = { entered: signal(), release: signal() };
  const prefix = "cg_email_global_" + randomUUID().replaceAll("-", "");
  const a = input(),
    b = input();
  assert.notEqual(a.email, b.email);
  assert.notEqual(a.recipientKey, b.recipientKey);
  assert.notEqual(a.ipKey, b.ipKey);
  const first = observe(
    new EmailRegistration(tagged(db, prefix + "_one", gate), limits).begin(a),
  );
  let second: Promise<unknown> | undefined;
  try {
    await within(gate.entered.promise);
    second = observe(
      new EmailRegistration(tagged(db, prefix + "_two"), limits).begin(b),
    );
    await blocked(db, prefix + "_two", prefix + "_one");
  } finally {
    gate.release.open();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
  assert.ok(second);
  await first;
  await assert.rejects(second, status(429));
  assert.deepEqual(
    (await db.query("select id::text from email_registrations")).rows,
    [{ id: a.id }],
  );
  assert.deepEqual(
    (
      await db.query(
        "select kind,key_hash from email_registration_rate_events order by kind",
      )
    ).rows,
    [
      { kind: "ip", key_hash: a.ipKey },
      { kind: "recipient", key_hash: a.recipientKey },
    ],
  );
}

for (const [name, limits] of [
  ["daily=1 independently", { daily: 1, total: 100 }],
  ["total=1 independently", { daily: 100, total: 1 }],
  ["daily=1 and total=1 together", { daily: 1, total: 1 }],
] as const) {
  test(
    `PostgreSQL global email ${name} admits exactly one of two different recipients/IPs`,
    pgOnly,
    async (t) => {
      const f = await fixture(t);
      await race(f.db, limits);
      t.diagnostic(
        "Distinct backend lock wait observed before releasing the winner",
      );
    },
  );
}

test(
  "PostgreSQL failed email delivery retains its global admission across a fresh connection and service instance",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      value = input(),
      limits = { daily: 1, total: 1 };
    const initial = new EmailRegistration(f.db, limits);
    await initial.begin(value);
    // Emulate a failed/unknown transport result: no actual email is sent here.
    await initial.cancelDelivery(value.id, value.codeHash);
    const previousPid = (
      await f.db.query<{ pid: number }>("select pg_backend_pid() as pid")
    ).rows[0]!.pid;
    await f.disconnect(f.db);
    const reconnected = await f.connect();
    assert.notEqual(
      previousPid,
      (
        await reconnected.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        )
      ).rows[0]!.pid,
    );
    const rejected = input();
    await assert.rejects(
      new EmailRegistration(reconnected, limits).begin(rejected),
      status(429),
    );
    assert.deepEqual(
      (
        await reconnected.query(
          "select id::text,delivery from email_registrations",
        )
      ).rows,
      [{ id: value.id, delivery: "failed" }],
    );
    assert.equal(
      (
        await reconnected.query(
          "select 1 from email_registration_rate_events where kind='recipient'",
        )
      ).rows.length,
      1,
    );
    for (const table of [
      "users",
      "sessions",
      "account_email_verifications",
      "ai_credit_entries",
    ])
      assert.equal(
        (await reconnected.query(`select 1 from ${table}`)).rows.length,
        0,
      );
  },
);
