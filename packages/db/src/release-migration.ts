import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Database, Sql } from "./index.js";

// Executor input, NOT operator approval. A trusted host controller must bind this
// to an independently approved image and a fresh backup in the SAME release lock.
export interface MigrationDigest {
  name: string;
  sha256: string;
}
export interface ReleaseMigrationPlan {
  version: 1;
  kind: "citygo-release-migration";
  operationId: string;
  targetSha: string;
  currentMigrations: MigrationDigest[];
  targetMigrations: MigrationDigest[];
  grantsSha256: string;
}
// A selected manifest is bounded to 256 KiB; this request carries inventories
// from TWO such manifests. Do not reject an otherwise valid selected release.
export const releaseInputLimit = 2 * 262144;
export const releaseSqlBytesLimit = 4 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
export const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export class ReleaseMigrationError extends Error {
  constructor(readonly code: string) {
    super(`Release migration rejected: ${code}`);
  }
}
function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new ReleaseMigrationError(code);
}
function exactKeys(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort()),
    "input-shape",
  );
}
function inventory(value: unknown): asserts value is MigrationDigest[] {
  requireValue(
    Array.isArray(value) && value.length > 0 && value.length <= 1000,
    "inventory",
  );
  let previous = 0;
  for (const item of value) {
    exactKeys(item, ["name", "sha256"]);
    requireValue(
      typeof item.name === "string" &&
        /^\d{4}_[a-z0-9_]+\.sql$/.test(item.name) &&
        typeof item.sha256 === "string" &&
        hashPattern.test(item.sha256),
      "inventory",
    );
    const number = Number(item.name.slice(0, 4));
    requireValue(number > previous, "inventory-order");
    previous = number;
  }
}
export function parseReleaseMigrationPlan(text: string): ReleaseMigrationPlan {
  requireValue(Buffer.byteLength(text) <= releaseInputLimit, "input-size");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ReleaseMigrationError("input-json");
  }
  // One compact JSON object, optionally followed by LF. This rejects duplicate
  // keys, noncanonical numbers/escapes and silent last-key-wins interpretations.
  requireValue(
    text === JSON.stringify(value) || text === JSON.stringify(value) + "\n",
    "input-canonical",
  );
  exactKeys(value, [
    "version",
    "kind",
    "operationId",
    "targetSha",
    "currentMigrations",
    "targetMigrations",
    "grantsSha256",
  ]);
  requireValue(
    value.version === 1 &&
      value.kind === "citygo-release-migration" &&
      typeof value.operationId === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId) &&
      typeof value.targetSha === "string" &&
      /^[a-f0-9]{40}$/.test(value.targetSha) &&
      typeof value.grantsSha256 === "string" &&
      hashPattern.test(value.grantsSha256),
    "input-identity",
  );
  inventory(value.currentMigrations);
  inventory(value.targetMigrations);
  requireValue(
    value.currentMigrations.length <= value.targetMigrations.length &&
      value.currentMigrations.every(
        (item, i) =>
          item.name ===
            (value.targetMigrations as MigrationDigest[])[i]?.name &&
          item.sha256 ===
            (value.targetMigrations as MigrationDigest[])[i]?.sha256,
      ),
    "history-prefix",
  );
  return value as unknown as ReleaseMigrationPlan;
}

// Lex only enough PostgreSQL SQL to split top-level statements safely. This is
// not a sandbox for malicious migration authors; SQL remains operator-reviewed.
// Quoted text, dollar bodies and nested comments must not hide a top-level COMMIT.
export function transactionBody(source: string, grants = false): string[] {
  let text = source.replaceAll("\r\n", "\n");
  if (grants) text = text.replace(/^\\set ON_ERROR_STOP on\n/, "");
  requireValue(!text.includes("\0"), "sql-shape");
  const statements: { sql: string; first: string; count: number }[] = [];
  let start = 0;
  let first = "";
  let count = 0;
  // Only the leading token and whether it is alone are needed. Do not retain
  // millions of tokens for a large statement in the 256 MiB jobs container.
  const token = (word: string) => {
    if (count === 0) first = word;
    count = Math.min(2, count + 1);
  };
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i]!)) {
      i++;
      continue;
    }
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth) {
        if (text.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      requireValue(depth === 0, "sql-comment");
      continue;
    }
    if (text[i] === "'" || text[i] === '"') {
      const quote = text[i]!;
      // E'...' backslash escapes; ordinary strings use standard_conforming_strings.
      const escaped =
        quote === "'" && /(?:^|[^a-z0-9_$])e$/i.test(text.slice(0, i));
      let closed = false;
      i++;
      while (i < text.length) {
        if (escaped && text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          if (text[i + 1] === quote) {
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      requireValue(closed, "sql-quote");
      token("<quoted>");
      continue;
    }
    const dollar = text.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];
    if (dollar) {
      const end = text.indexOf(dollar, i + dollar.length);
      requireValue(end >= 0, "sql-dollar");
      token("<body>");
      i = end + dollar.length;
      continue;
    }
    if (text[i] === ";") {
      if (count) statements.push({ sql: text.slice(start, i), first, count });
      count = 0;
      first = "";
      start = ++i;
      continue;
    }
    const word = text.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_$]*/)?.[0];
    if (word) {
      token(word.toLowerCase());
      i += word.length;
    } else {
      token(text[i]!);
      i++;
    }
  }
  requireValue(count === 0, "sql-terminator");
  requireValue(
    statements.length >= 3 &&
      statements[0]!.first === "begin" &&
      statements[0]!.count === 1 &&
      statements.at(-1)!.first === "commit" &&
      statements.at(-1)!.count === 1,
    "sql-wrapper",
  );
  const body = statements.slice(1, -1);
  const allowed = grants
    ? ["grant", "revoke"]
    : [
        "create",
        "alter",
        "drop",
        "insert",
        "update",
        "delete",
        "comment",
        "do",
        "select",
        "grant",
        "revoke",
      ];
  requireValue(
    body.every(({ first: leading }) => allowed.includes(leading)),
    "sql-command",
  );
  return body.map(({ sql }) => sql);
}
interface MigrationSource extends MigrationDigest {
  checksum: string;
  statements: string[];
}
export interface ReleaseMigrationAssets {
  migrations: { name: string; bytes: Buffer }[];
  grants: Buffer;
}
export async function loadReleaseMigrationAssets(
  directory: string,
  grantsFile: string,
): Promise<ReleaseMigrationAssets> {
  const entries = await readdir(directory, { withFileTypes: true });
  requireValue(
    entries.length > 0 &&
      entries.length <= 1000 &&
      entries.every((item) => item.isFile()),
    "image-files",
  );
  let total = 0;
  for (const { name } of entries) {
    const info = await lstat(join(directory, name));
    requireValue(info.isFile() && info.size <= 4 * 1024 * 1024, "image-file");
    total += info.size;
    requireValue(total <= releaseSqlBytesLimit, "image-total-size");
  }
  const read = async (file: string, limit = 4 * 1024 * 1024) => {
    const info = await lstat(file);
    requireValue(
      info.isFile() && !info.isSymbolicLink() && info.size <= limit,
      "image-file",
    );
    const data = await readFile(file);
    requireValue(data.length <= limit, "image-file");
    return data;
  };
  const migrations: ReleaseMigrationAssets["migrations"] = [];
  total = 0;
  for (const { name } of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const bytes = await read(join(directory, name));
    total += bytes.length;
    requireValue(total <= releaseSqlBytesLimit, "image-total-size");
    migrations.push({ name, bytes });
  }
  return { migrations, grants: await read(grantsFile, 262144) };
}
function prepared(plan: ReleaseMigrationPlan, assets: ReleaseMigrationAssets) {
  requireValue(
    assets.migrations.length === plan.targetMigrations.length,
    "image-inventory",
  );
  const migrations: MigrationSource[] = assets.migrations.map(
    ({ name, bytes }, i) => {
      requireValue(
        name === plan.targetMigrations[i]?.name &&
          sha256(bytes) === plan.targetMigrations[i]?.sha256,
        "image-checksum",
      );
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return {
        name,
        sha256: sha256(bytes),
        checksum: sha256(source.replaceAll("\r\n", "\n")),
        statements: transactionBody(source),
      };
    },
  );
  requireValue(sha256(assets.grants) === plan.grantsSha256, "grants-checksum");
  return {
    migrations,
    grants: transactionBody(
      new TextDecoder("utf-8", { fatal: true }).decode(assets.grants),
      true,
    ),
  };
}
async function verifyHistory(tx: Sql, expected: MigrationSource[]) {
  const result = await tx.query<{ name: string; checksum: string }>(
    'select name, checksum from public.citygo_migrations order by name collate "C" limit 1001',
  );
  requireValue(
    result.rows.length === expected.length &&
      result.rows.every(
        (row, i) =>
          row.name === expected[i]?.name &&
          row.checksum === expected[i]?.checksum,
      ),
    "database-history",
  );
}
export async function migrateRelease(
  db: Database,
  input: ReleaseMigrationPlan,
  assets: ReleaseMigrationAssets,
) {
  // Copy, validate and prepare ALL source bytes before opening a transaction.
  const plan = parseReleaseMigrationPlan(JSON.stringify(input));
  const { migrations, grants } = prepared(plan, assets);
  await db.transaction(async (tx) => {
    const identity = (
      await tx.query<{
        role: string;
        session: string;
        database: string;
        version: number;
        elevated: boolean;
      }>(
        "select current_user as role, session_user as session, current_database() as database, current_setting('server_version_num')::int as version, (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls) as elevated from pg_catalog.pg_roles where rolname=current_user",
      )
    ).rows[0];
    requireValue(
      identity?.role === "citygo_migrator" &&
        identity.session === "citygo_migrator" &&
        identity.database === "citygo_pilot" &&
        identity.elevated === false &&
        identity.version >= 170000 &&
        identity.version < 180000,
      "database-identity",
    );
    await tx.exec(
      "set local search_path = public, pg_catalog, pg_temp; set local standard_conforming_strings = on; set local statement_timeout = '60s'; set local lock_timeout = '3s'; set local idle_in_transaction_session_timeout = '10s'; set local transaction_timeout = '120s'",
    );
    // Use the SAME lock as the existing bootstrap/local migrator, but never wait
    // and silently continue after another migrator completes. No table creation.
    const lock = await tx.query<{ id: number }>(
      "select id from public.citygo_migration_lock where id=1 for update nowait",
    );
    requireValue(
      lock.rows.length === 1 && lock.rows[0]?.id === 1,
      "database-lock",
    );
    await tx.exec(
      "lock table public.citygo_migrations in share row exclusive mode nowait",
    );
    await verifyHistory(tx, migrations.slice(0, plan.currentMigrations.length));
    for (const migration of migrations.slice(plan.currentMigrations.length)) {
      for (const statement of migration.statements) await tx.exec(statement);
      await tx.query(
        "insert into public.citygo_migrations(name, checksum) values ($1,$2)",
        [migration.name, migration.checksum],
      );
    }
    // No shell/psql subprocess and no separate commit between DDL and ACLs.
    for (const statement of grants) await tx.exec(statement);
    await verifyHistory(tx, migrations);
  });
  // Returned only after COMMIT acknowledgement. Missing receipt/ambiguous commit
  // is an operator-reconciliation case, NEVER permission to retry or reopen.
  return {
    version: 1,
    kind: "citygo-release-migration-result",
    operationId: plan.operationId,
    targetSha: plan.targetSha,
    requestSha256: sha256(JSON.stringify(plan)),
    applied: plan.targetMigrations.slice(plan.currentMigrations.length),
    grantsSha256: plan.grantsSha256,
    committed: true,
    trafficAuthorized: false,
  };
}
