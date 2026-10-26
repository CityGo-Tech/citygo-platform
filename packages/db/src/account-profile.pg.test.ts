import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AccountProfile,
  AccountAccess,
  Repository,
  DomainError,
  connectDatabase,
  migrate,
  type Database,
  type Sql,
} from "./index.js";
const pgOnly = {
  skip:
    !process.env.TEST_DATABASE_URL &&
    "Requires explicitly disposable PostgreSQL; PGlite is not independent lock evidence",
  timeout: 60000,
};
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const status = (n: number) => (e: unknown) =>
  e instanceof DomainError && e.statusCode === n;
async function fixture(t: TestContext) {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert(["postgres:", "postgresql:"].includes(url.protocol));
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert(
    ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
      (url.port === "55438" && url.pathname === "/citygo_synthetic"),
  );
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  const admin = await connectDatabase(url.toString()),
    name = "cg_account_email_" + randomUUID().replaceAll("-", "");
  const cleanup: { db?: Database } = {};
  let created = false;
  t.after(async () => {
    try {
      await cleanup.db?.close();
      if (created) await admin.exec(`drop database ${name}`);
    } finally {
      await admin.close();
    }
  });
  await admin.exec(`create database ${name} template template0`);
  created = true;
  url.pathname = "/" + name;
  const db = await connectDatabase(url.toString());
  cleanup.db = db;
  await migrate(db);
  const userId = await new Repository(db).register(
      "pg-account@example.test",
      "synthetic-old-hash",
    ),
    ctx = { userId, sessionTokenHash: h("synthetic-session") };
  await new Repository(db).createSession(userId, ctx.sessionTokenHash);
  const input = {
    ...ctx,
    id: randomUUID(),
    email: "pg-account@example.test",
    proofHash: h("proof"),
    codeHash: h("code"),
    recipientKey: h("recipient"),
    ipKey: h("ip"),
  };
  const state = new AccountProfile(db);
  await state.begin(input);
  await state.markSent(input.id, input.codeHash);
  const confirmation = {
    ...ctx,
    id: input.id,
    proofHash: input.proofHash,
    codeHash: input.codeHash,
  };
  return { db, ctx, input, confirmation };
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
          () => reject(new Error("Synthetic account-email barrier timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function tagged(
  db: Database,
  name: string,
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
        await tx.query("select set_config('application_name',$1,true)", [name]);
        return work({
          exec: (sql) => tx.exec(sql),
          query: async <T>(sql: string, args?: unknown[]) => {
            const result = await tx.query<T>(sql, args);
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
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const result = await db.query<{ blocked: boolean }>(
      `select exists(select 1 from pg_stat_activity waiting join pg_stat_activity holding
      on holding.pid=any(pg_blocking_pids(waiting.pid)) where waiting.application_name=$1 and holding.application_name=$2
      and waiting.pid<>holding.pid and waiting.wait_event_type='Lock') as blocked`,
      [waiter, holder],
    );
    if (result.rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    "Independent PostgreSQL backend did not demonstrably wait for account security lock",
  );
}
const observe = <T>(promise: Promise<T>) => {
  void promise.catch(() => {});
  return promise;
};

test(
  "PostgreSQL: simultaneous account confirmations wait on security lock and consume exactly one proof",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      gate = { entered: signal(), release: signal() },
      prefix = "cg_email_" + randomUUID().replaceAll("-", "");
    const one = observe(
      new AccountProfile(tagged(f.db, prefix + "_one", gate)).confirm(
        f.confirmation,
      ),
    );
    let two: Promise<unknown> | undefined;
    try {
      await within(gate.entered.promise);
      two = observe(
        new AccountProfile(tagged(f.db, prefix + "_two")).confirm(
          f.confirmation,
        ),
      );
      await waitForLock(f.db, prefix + "_two", prefix + "_one");
    } finally {
      gate.release.open();
    }
    await one;
    await assert.rejects(two!, status(400));
    assert.equal(
      (await f.db.query("select 1 from account_email_verifications")).rows
        .length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "select 1 from audit_log where action='account-email-verified'",
        )
      ).rows.length,
      1,
    );
    assert.equal((await f.db.query("select 1 from sessions")).rows.length, 1);
  },
);
test(
  "PostgreSQL: password rotation wins the shared lock before account confirmation and revokes the challenge session",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      gate = { entered: signal(), release: signal() },
      prefix = "cg_email_rotate_" + randomUUID().replaceAll("-", "");
    const rotation = observe(
      new AccountAccess(tagged(f.db, prefix + "_rotate", gate)).changePassword(
        f.ctx.userId,
        "synthetic-old-hash",
        "synthetic-new-hash",
        h("new-session"),
      ),
    );
    let confirmation: Promise<unknown> | undefined;
    try {
      await within(gate.entered.promise);
      confirmation = observe(
        new AccountProfile(tagged(f.db, prefix + "_confirm")).confirm(
          f.confirmation,
        ),
      );
      await waitForLock(f.db, prefix + "_confirm", prefix + "_rotate");
    } finally {
      gate.release.open();
    }
    await rotation;
    await assert.rejects(confirmation!, status(401));
    assert.equal(
      (await f.db.query("select 1 from account_email_verifications")).rows
        .length,
      0,
    );
  },
);
test(
  "PostgreSQL: runtime grants permit real account proof but forbid identity rewrites, deletion and Worker access",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      suffix = randomUUID().replaceAll("-", ""),
      roles = {
        citygo_api: "cgaemail_api_" + suffix,
        citygo_worker: "cgaemail_worker_" + suffix,
        citygo_backup: "cgaemail_backup_" + suffix,
      },
      created: string[] = [];
    try {
      for (const role of Object.values(roles)) {
        await f.db.exec(
          `create role ${role} nologin; grant usage on schema public to ${role}`,
        );
        created.push(role);
      }
      await f.db.exec(
        (
          await readFile(
            new URL("../../../deploy/postgres/grants.sql", import.meta.url),
            "utf8",
          )
        )
          .replace(/^\\set[^\r\n]*(?:\r?\n|$)/gm, "")
          .replace(
            /\bcitygo_(api|worker|backup)\b/g,
            (role) => roles[role as keyof typeof roles],
          ),
      );
      const asRole = <T>(role: string, work: (tx: Sql) => Promise<T>) =>
        f.db.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          return work(tx);
        });
      const runtime: Database = {
        ...f.db,
        query: <T>(sql: string, args?: unknown[]) =>
          asRole(roles.citygo_api, (tx) => tx.query<T>(sql, args)),
        exec: (sql) => asRole(roles.citygo_api, (tx) => tx.exec(sql)),
        transaction: (work) => asRole(roles.citygo_api, work),
      };
      await new AccountProfile(runtime).confirm(f.confirmation);
      for (const column of [
        "user_id",
        "email",
        "credential_digest",
        "session_token_hash",
        "proof_hash",
        "recipient_key",
        "created_at",
        "expires_at",
      ])
        await assert.rejects(
          runtime.query(
            `update account_email_confirmation_challenges set ${column}=${column} where false`,
          ),
          { code: "42501" },
        );
      await assert.rejects(
        runtime.query(
          "delete from account_email_confirmation_challenges where false",
        ),
        { code: "42501" },
      );
      await assert.rejects(
        runtime.query("truncate account_email_confirmation_challenges"),
        { code: "42501" },
      );
      await assert.rejects(
        asRole(roles.citygo_worker, (tx) =>
          tx.query("select 1 from account_email_confirmation_challenges"),
        ),
        { code: "42501" },
      );
      await assert.rejects(
        runtime.query(
          "update account_email_verifications set confirmation_id=null where false",
        ),
        { code: "42501" },
      );
    } finally {
      for (const role of created.reverse())
        await f.db.exec(`drop owned by ${role}; drop role ${role}`);
    }
  },
);
