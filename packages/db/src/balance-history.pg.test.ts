import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { serviceConsentPolicy } from "@citygo/contracts";
import {
  BalanceHistory,
  AiCreditLedger,
  Repository,
  ServiceConsents,
  connectDatabase,
  migrate,
  DomainError,
  type Database,
  type Sql,
} from "./index.js";

test(
  "PostgreSQL history uses existing API grants and indexes; account revocation waits for the authorized read and the next read is denied",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires explicitly supplied disposable local PostgreSQL",
    timeout: 60000,
  },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.ok(
      ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
        (url.port === "55438" && url.pathname === "/citygo_synthetic"),
    );
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    const suffix = randomUUID().replaceAll("-", ""),
      name = "cg_balance_" + suffix,
      admin = await connectDatabase(url.toString());
    const roles = {
      citygo_api: "cgb_api_" + suffix,
      citygo_worker: "cgb_worker_" + suffix,
      citygo_backup: "cgb_backup_" + suffix,
    };
    const cleanup: { db?: Database } = {};
    let created = false;
    const createdRoles: string[] = [];
    t.after(async () => {
      try {
        if (cleanup.db) {
          for (const role of createdRoles.reverse())
            await cleanup.db.exec(`drop owned by ${role};drop role ${role}`);
          await cleanup.db.close();
        }
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
    const database = db;
    await migrate(db);
    for (const role of Object.values(roles)) {
      await db.exec(
        `create role ${role} nologin;grant usage on schema public to ${role}`,
      );
      createdRoles.push(role);
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
      database.transaction(async (tx) => {
        await tx.exec(`set local role ${roles.citygo_api}`);
        return work(tx);
      });
    const runtime: Database = {
      query: <T>(sql: string, params?: unknown[]) =>
        asApi((tx) => tx.query<T>(sql, params)),
      exec: (sql) => asApi((tx) => tx.exec(sql)),
      transaction: asApi,
      close: async () => {},
    };
    const repo = new Repository(db),
      userId = await repo.register("pg-history@example.test", "synthetic"),
      sessionTokenHash = createHash("sha256")
        .update(randomUUID())
        .digest("hex"),
      context = { userId, sessionTokenHash };
    await repo.createSession(userId, sessionTokenHash);
    await new ServiceConsents(db).choose(userId, {
      policyVersion: serviceConsentPolicy.version,
      personalData: true,
      marketing: false,
    });
    await new AiCreditLedger(db).grantWelcome(userId, userId);
    const history = new BalanceHistory(runtime),
      first = await history.list(context);
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0]!.amountMicros, 500_000_000);
    const plan = await db.transaction(async (tx) => {
      await tx.exec("set local enable_seqscan=off");
      return tx.query<{ "QUERY PLAN": string }>(
        "explain select id from ai_credit_entries where user_id=$1 and kind='bonus' order by created_at desc,id desc limit 21",
        [userId],
      );
    });
    assert.match(
      plan.rows.map((row) => row["QUERY PLAN"]).join("\n"),
      /ai_credit_visible_history/,
    );
    // Pause only after authorizing under real row locks, before reading the page.
    let entered: () => void = () => {},
      release: () => void = () => {};
    const enteredRead = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const paused: Database = {
      ...runtime,
      transaction: (work) =>
        asApi((tx) =>
          work({
            ...tx,
            query: async <T>(sql: string, params?: unknown[]) => {
              if (sql.includes('as "creditThrough"')) {
                entered();
                await gate;
              }
              return tx.query<T>(sql, params);
            },
          }),
        ),
    };
    const pending = new BalanceHistory(paused).list(context);
    await Promise.race([
      enteredRead,
      pending.then(() => {
        throw new Error("Read finished without the planned authorization gate");
      }),
    ]);
    let revoked = false;
    const revocation = database.transaction(async (tx) => {
      await tx.query(
        "select id from account_security_state where id=1 for update",
      );
      await tx.query("update users set status='blocked' where id=$1", [userId]);
      revoked = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      assert.equal(revoked, false);
    } finally {
      release();
    }
    assert.deepEqual(await pending, first);
    await revocation;
    await assert.rejects(
      history.list(context),
      (error) => error instanceof DomainError && error.statusCode === 401,
    );
    assert.equal(
      (await db.query("select count(*)::text as n from ai_credit_entries"))
        .rows[0]!.n,
      "1",
    );
  },
);
