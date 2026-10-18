import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
export { Repository, DomainError } from "./repository.js";
export { AiCreditLedger } from "./ai-credit.js";
export { AiCreditCharges } from "./ai-credit-charges.js";
export {
  ensureConversation,
  type ConversationThread,
} from "./conversation-start.js";
export {
  AccountAccess,
  type AccountRole,
  type AccountInfo,
  type AccountCredentials,
} from "./account-access.js";
export {
  AccountReset,
  type AccountResetPlan,
  type AccountResetBlocker,
} from "./account-reset.js";
export {
  ClosedAccountRestart,
  type ClosedAccountRestartPlan,
  type ClosedAccountRestartInput,
  type ClosedAccountRestartReceipt,
} from "./closed-account-restart.js";
export {
  FreshAccountReset,
  type FreshAccountResetPlan,
  type FreshAccountResetInput,
  type FreshAccountResetReceipt,
} from "./fresh-account-reset.js";
export {
  PaymentTopupOrders,
  type PaymentTopupOrder,
} from "./payment-topup-orders.js";
export {
  assertRealAiDatabaseSafety,
  assertTestPaymentsDatabaseSafety,
} from "./payment-isolation.js";
export {
  HousingAnswers,
  type HousingBriefSnapshot,
  type HousingBriefSummary,
  type HousingBriefRecovery,
  type HousingBriefPage,
  type HousingBriefHistoryPage,
  type HousingBriefSelection,
  type HousingBriefSelectionPage,
} from "./housing-answers.js";
export { HousingStoredDataError } from "./housing-history.js";
export { verifyHousingReadiness } from "./housing-access.js";
import { createHash } from "node:crypto";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Sql {
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function connectDatabase(url: string): Promise<Database> {
  if (url.startsWith("pglite://")) {
    const path = url.slice("pglite://".length);
    if (path && path !== ":memory:")
      await mkdir(dirname(path), { recursive: true });
    const db = new PGlite(path === ":memory:" ? undefined : path);
    await db.waitReady;
    return {
      exec: async (sql) => {
        await db.exec(sql);
      },
      query: (sql, params) => db.query(sql, params),
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            exec: async (sql) => {
              await tx.exec(sql);
            },
            query: (sql, params) => tx.query(sql, params),
          }),
        ),
      close: () => db.close(),
    };
  }
  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://"))
    throw new Error("Unsupported database URL");
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 15000,
  });
  const query = async <T>(sql: string, params?: unknown[]) => ({
    rows: (await pool.query(sql, params)).rows as T[],
  });
  return {
    exec: async (sql) => {
      await pool.query(sql);
    },
    query,
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await work({
          exec: async (sql) => {
            await client.query(sql);
          },
          query: async <T>(sql: string, params?: unknown[]) => ({
            rows: (await client.query(sql, params)).rows as T[],
          }),
        });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
export async function migrate(db: Database) {
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  // A row lock works in both PostgreSQL and PGlite; it serializes concurrent migrators.
  await db.query(
    "create table if not exists citygo_migration_lock (id integer primary key)",
  );
  await db.query(
    "insert into citygo_migration_lock values (1) on conflict do nothing",
  );
  await db.transaction(async (tx) => {
    await tx.query(
      "select id from citygo_migration_lock where id=1 for update",
    );
    await tx.query(
      "create table if not exists citygo_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())",
    );
    for (const name of (await readdir(directory))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const source = await readFile(directory + "/" + name, "utf8");
      const checksum = createHash("sha256")
        .update(source.replaceAll("\r\n", "\n"))
        .digest("hex");
      const existing = (
        await tx.query<{ checksum: string }>(
          "select checksum from citygo_migrations where name=$1",
          [name],
        )
      ).rows[0];
      if (existing) {
        if (existing.checksum !== checksum)
          throw new Error("Applied migration changed: " + name);
        continue;
      }
      const sql = source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, "");
      // Both drivers accept multi-statement SQL without bind parameters.
      await tx.exec(sql);
      await tx.query(
        "insert into citygo_migrations(name, checksum) values ($1,$2)",
        [name, checksum],
      );
    }
  });
}
