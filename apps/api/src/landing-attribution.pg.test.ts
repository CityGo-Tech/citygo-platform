import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import {
  connectDatabase,
  migrate,
  EmailRegistration,
  ServiceConsents,
  type Database,
  type Sql,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { buildApp } from "./app.js";
import { syntheticServiceConsents } from "./test-service-consents.js";

const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires an explicitly opted-in disposable PostgreSQL test database",
  timeout: 60000,
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const attribution = {
  landingVersion: "v8" as const,
  source: "vk",
  medium: "cpc",
  campaignId: "synthetic-pg17",
  content: "decision",
};
function registration() {
  const id = randomUUID();
  return {
    id,
    email: id + "@example.test",
    passwordHash: "synthetic-already-hashed-password",
    proofHash: hash("proof:" + id),
    codeHash: hash("code:" + id),
    recipientKey: hash("recipient:" + id),
    ipKey: hash("synthetic-ip:" + id),
    consents: syntheticServiceConsents,
    landingAttribution: attribution,
  };
}
function confirmation(
  value: ReturnType<typeof registration>,
  codeHash = value.codeHash,
) {
  return {
    id: value.id,
    proofHash: value.proofHash,
    codeHash,
    sessionHash: hash("session:" + value.id),
  };
}
const sqlCode = (code: string) => (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === code;

async function fixture(t: TestContext, through = 50) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base, "Explicit TEST_DATABASE_URL required");
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  const name = "cg_attr_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_attr_test_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base);
  let created = false;
  const cleanup: { db?: Database } = {};
  const roles: string[] = [];
  const closeBeforeDatabase: (() => Promise<void>)[] = [];
  t.after(async () => {
    try {
      for (const close of closeBeforeDatabase.reverse()) await close();
      const cleanupDb = cleanup.db;
      if (cleanupDb)
        for (const role of roles.reverse()) {
          assert.match(role, /^cg_attr_(api|worker|backup)_[a-f0-9]{32}$/);
          await cleanupDb.exec(`drop owned by ${role};drop role ${role}`);
        }
    } finally {
      await cleanup.db?.close();
      try {
        if (created) await admin.exec(`drop database "${name}"`);
      } finally {
        await admin.close();
      }
    }
  });
  await admin.exec(`create database "${name}" template template0`);
  created = true;
  url.pathname = "/" + name;
  const db = await connectDatabase(url.toString());
  cleanup.db = db;
  if (through === 50) await migrate(db);
  else {
    assert.equal(through, 49);
    await db.exec(
      "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
    );
    const directory = new URL(
      "../../../packages/db/migrations/",
      import.meta.url,
    );
    const names = (await readdir(directory))
      .filter((n) => n.endsWith(".sql"))
      .sort()
      .slice(0, through);
    assert.equal(names.length, 49);
    assert.equal(names.at(-1), "0049_native_search_production.sql");
    for (const name of names) {
      const source = await readFile(new URL(name, directory), "utf8");
      await db.transaction(async (tx) => {
        await tx.exec(
          source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
        );
        await tx.query(
          "insert into citygo_migrations(name,checksum)values($1,$2)",
          [name, hash(source.replaceAll("\r\n", "\n"))],
        );
      });
    }
  }
  t.diagnostic(
    "Disposable PostgreSQL " +
      (
        await db.query<{ v: string }>(
          "select current_setting('server_version') as v",
        )
      ).rows[0]?.v,
  );
  return { db, url: url.toString(), roles, closeBeforeDatabase };
}

async function runtimeDatabase(
  f: Awaited<ReturnType<typeof fixture>>,
  grantSet: "production" | "fixture" = "production",
) {
  const suffix = randomUUID().replaceAll("-", "");
  const roleNames = {
    citygo_api: "cg_attr_api_" + suffix,
    citygo_worker: "cg_attr_worker_" + suffix,
    citygo_backup: "cg_attr_backup_" + suffix,
  };
  for (const role of Object.values(roleNames)) {
    assert.match(role, /^cg_attr_(api|worker|backup)_[a-f0-9]{32}$/);
    await f.db.exec(
      `create role ${role} nologin;grant usage on schema public to ${role}`,
    );
    f.roles.push(role);
  }
  const grants = (
    await readFile(
      new URL(
        grantSet === "fixture"
          ? "../../../deploy/fixtures/grants.sql"
          : "../../../deploy/postgres/grants.sql",
        import.meta.url,
      ),
      "utf8",
    )
  )
    .replace(/^\\set[^\n]*\n/gm, "")
    .replace(
      /\bcitygo_(?:api|worker|backup)\b/g,
      (name) => roleNames[name as keyof typeof roleNames],
    );
  await f.db.exec(grants);
  const asRole = <T>(role: string, work: (tx: Sql) => Promise<T>) =>
    f.db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      return work(tx);
    });
  const api: Database = {
    exec: (sql) => asRole(roleNames.citygo_api, (tx) => tx.exec(sql)),
    query: <T>(sql: string, params?: unknown[]) =>
      asRole(roleNames.citygo_api, (tx) => tx.query<T>(sql, params)),
    transaction: (work) => asRole(roleNames.citygo_api, work),
    close: async () => {},
  };
  return { api, asRole, roleNames };
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
          () => reject(new Error("Synthetic PG barrier timeout")),
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
  name: string,
  gate?: {
    entered: ReturnType<typeof signal>;
    release: ReturnType<typeof signal>;
  },
): Database {
  return {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('application_name',$1,true)", [name]);
        return work({
          exec: (sql) => tx.exec(sql),
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            if (
              gate &&
              sql.startsWith("select id from account_security_state")
            ) {
              gate.entered.open();
              await gate.release.promise;
            }
            return result;
          },
        });
      }),
  };
}

test(
  "PostgreSQL actual fixture grants support HTTP legacy/null and OTP/attributed registration without relabel or Worker access",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    const { api, asRole, roleNames } = await runtimeDatabase(f, "fixture");
    const legacyApp = await buildApp({
      db: api,
      testing: true,
      config: readConfig({
        NODE_ENV: "test",
        LLM_PROVIDER: "disabled",
        EMAIL_REGISTRATION_MODE: "disabled",
      }),
    });
    f.closeBeforeDatabase.push(() => legacyApp.close());
    const headers = {
      origin: "http://localhost:3000",
      [CONTRACT_VERSION_HEADER]: "1",
      "x-citygo-client": "native",
    };
    const policy = (
      await legacyApp.inject({ url: "/v1/auth/registration-policy" })
    ).json<{ consentPolicy: { version: string } }>();
    const consents = {
      policyVersion: policy.consentPolicy.version,
      personalData: true,
      marketing: false,
    };
    const credentials = {
      email: "synthetic-fixture-legacy@example.test",
      password: "synthetic-fixture-password",
      consents,
    };
    const denied = await legacyApp.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers,
      payload: {
        ...credentials,
        consents: { ...consents, personalData: false },
      },
    });
    assert.equal(denied.statusCode, 400);
    const validationPermission = (
      await api.query<{ allowed: boolean }>(
        "select has_function_privilege(current_user,'public.citygo_valid_landing_attribution(jsonb)','EXECUTE') as allowed",
      )
    ).rows[0]?.allowed;
    // Match the container smoke: no attribution argument means an immutable
    // SQL NULL first touch. The CHECK still needs the exact validator EXECUTE.
    const registered = await legacyApp.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers,
      payload: credentials,
    });
    assert.equal(
      registered.statusCode,
      200,
      registered.body + "; validator EXECUTE=" + validationPermission,
    );
    const first = registered.json<{ user: { id: string } }>().user;
    assert.deepEqual(
      (
        await api.query(
          "select user_id::text,landing_attribution from user_acquisition order by user_id",
        )
      ).rows,
      [{ user_id: first.id, landing_attribution: null }],
    );
    let code = "";
    const otpApp = await buildApp({
      db: api,
      testing: true,
      config: readConfig({
        NODE_ENV: "test",
        LLM_PROVIDER: "disabled",
        EMAIL_REGISTRATION_MODE: "required",
        EMAIL_REGISTRATION_SECRET: "a".repeat(64),
      }),
      emailRegistrationDelivery: async (input) => {
        code = input.code;
      },
    });
    f.closeBeforeDatabase.push(() => otpApp.close());
    const started = await otpApp.inject({
      method: "POST",
      url: "/v1/auth/email/register",
      headers,
      payload: {
        ...credentials,
        email: "synthetic-fixture-otp@example.test",
        landingAttribution: attribution,
      },
    });
    assert.equal(started.statusCode, 200, started.body);
    const challenge = started.json<{ challengeId: string; proof: string }>();
    await assert.rejects(
      api.query(
        "update email_registrations set landing_attribution=$1::jsonb where id=$2",
        [JSON.stringify({ landingVersion: "v1" }), challenge.challengeId],
      ),
      (error) => sqlCode("42501")(error) || sqlCode("23514")(error),
    );
    const completed = await otpApp.inject({
      method: "POST",
      url: "/v1/auth/email/confirm",
      headers,
      payload: {
        challengeId: challenge.challengeId,
        proof: challenge.proof,
        code,
      },
    });
    assert.equal(completed.statusCode, 200, completed.body);
    const second = completed.json<{ user: { id: string } }>().user;
    for (const sql of [
      "update user_acquisition set landing_attribution=null",
      "delete from user_acquisition",
      "truncate user_acquisition",
    ])
      await assert.rejects(api.exec(sql), sqlCode("42501"));
    await assert.rejects(
      asRole(roleNames.citygo_worker, (tx) =>
        tx.query("select * from user_acquisition"),
      ),
      sqlCode("42501"),
    );
    assert.deepEqual(
      (
        await api.query(
          "select user_id::text,landing_attribution from user_acquisition order by user_id",
        )
      ).rows,
      [
        { user_id: first.id, landing_attribution: null },
        { user_id: second.id, landing_attribution: attribution },
      ],
    );
  },
);

test(
  "PostgreSQL independent OTP confirmations wait on the account lock and bind the original first touch once",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    const other = await connectDatabase(f.url);
    f.closeBeforeDatabase.push(() => other.close());
    const value = registration();
    const owner = new EmailRegistration(f.db);
    await owner.begin(value);
    await f.db.query(
      "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 minutes'",
    );
    const replacement = hash("replacement:" + value.id);
    await owner.resend({
      id: value.id,
      proofHash: value.proofHash,
      codeHash: replacement,
      ipKey: value.ipKey,
    });
    await owner.markSent(value.id, replacement);
    await assert.rejects(
      f.db.query(
        "update email_registrations set landing_attribution=$1::jsonb where id=$2",
        [JSON.stringify({ landingVersion: "v1" }), value.id],
      ),
      sqlCode("23514"),
    );
    const gate = { entered: signal(), release: signal() };
    const firstName = "cg_attr_hold_" + randomUUID().replaceAll("-", "");
    const secondName = "cg_attr_wait_" + randomUUID().replaceAll("-", "");
    const first = new EmailRegistration(tagged(f.db, firstName, gate)).confirm(
      confirmation(value, replacement),
    );
    void first.catch(() => {});
    let second: ReturnType<EmailRegistration["confirm"]> | undefined;
    let results: PromiseSettledResult<Awaited<typeof first>>[] = [];
    try {
      await within(gate.entered.promise);
      second = new EmailRegistration(tagged(other, secondName)).confirm(
        confirmation(value, replacement),
      );
      void second.catch(() => {});
      const deadline = Date.now() + 5000;
      let waited = false;
      while (Date.now() < deadline) {
        const state = (
          await f.db.query<{ blocked: boolean }>(
            `select exists(select 1 from pg_stat_activity w join pg_stat_activity h
        on h.pid=any(pg_blocking_pids(w.pid)) where w.application_name=$1 and h.application_name=$2
        and w.pid<>h.pid and w.wait_event_type='Lock') as blocked`,
            [secondName, firstName],
          )
        ).rows[0];
        if (state?.blocked) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(
        waited,
        true,
        "A distinct PostgreSQL backend must demonstrably wait",
      );
    } finally {
      gate.release.open();
      results = await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.deepEqual(
      (await f.db.query("select landing_attribution from user_acquisition"))
        .rows,
      [{ landing_attribution: attribution }],
    );
    for (const table of [
      "users",
      "user_credentials",
      "sessions",
      "user_acquisition",
    ])
      assert.equal(
        (
          await f.db.query<{ n: number }>(
            `select count(*)::int as n from ${table}`,
          )
        ).rows[0]?.n,
        1,
      );
  },
);

test(
  "PostgreSQL actual grants allow first-touch creation, forbid relabel/erase/Worker reads, and rollback both signup paths atomically",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    const { api, asRole, roleNames } = await runtimeDatabase(f);
    const legacy = new ServiceConsents(api);
    const account = await legacy.register(
      "synthetic-role@example.test",
      "synthetic-hash",
      hash("legacy-session"),
      syntheticServiceConsents,
      attribution,
    );
    assert.deepEqual(
      (await api.query("select landing_attribution from user_acquisition"))
        .rows,
      [{ landing_attribution: attribution }],
    );
    for (const sql of [
      "update user_acquisition set landing_attribution=null",
      "delete from user_acquisition",
      "truncate user_acquisition",
      "update email_registrations set landing_attribution=null",
    ])
      await assert.rejects(api.exec(sql), sqlCode("42501"));
    await assert.rejects(
      asRole(roleNames.citygo_worker, (tx) =>
        tx.query("select * from user_acquisition"),
      ),
      sqlCode("42501"),
    );
    await assert.rejects(
      api.query(
        "insert into user_acquisition(user_id,landing_attribution)values($1,$2::jsonb)",
        [account.id, JSON.stringify({ landingVersion: "v1" })],
      ),
      sqlCode("23514"),
    );
    const value = registration();
    const email = new EmailRegistration(api);
    await email.begin(value);
    await email.markSent(value.id, value.codeHash);
    await f.db
      .exec(`create function synthetic_attr_session_failure()returns trigger language plpgsql as $$begin raise exception 'synthetic session failure';end$$;
    create trigger synthetic_attr_session_failure before insert on sessions for each row execute function synthetic_attr_session_failure()`);
    await assert.rejects(
      email.confirm(confirmation(value)),
      /synthetic session failure/,
    );
    await assert.rejects(
      legacy.register(
        "synthetic-rollback@example.test",
        "hash",
        hash("rollback-session"),
        syntheticServiceConsents,
        { landingVersion: "v1" },
      ),
      /synthetic session failure/,
    );
    assert.equal(
      (await f.db.query<{ n: number }>("select count(*)::int as n from users"))
        .rows[0]?.n,
      1,
    );
    assert.equal(
      (
        await f.db.query<{ n: number }>(
          "select count(*)::int as n from user_acquisition",
        )
      ).rows[0]?.n,
      1,
    );
    assert.equal(
      (
        await f.db.query<{ consumed_user_id: string | null }>(
          "select consumed_user_id from email_registrations where id=$1",
          [value.id],
        )
      ).rows[0]?.consumed_user_id,
      null,
    );
    await f.db.exec(
      "drop trigger synthetic_attr_session_failure on sessions;drop function synthetic_attr_session_failure()",
    );
    await email.confirm(confirmation(value));
    assert.equal(
      (
        await f.db.query<{ n: number }>(
          "select count(*)::int as n from user_acquisition",
        )
      ).rows[0]?.n,
      2,
    );
  },
);

test(
  "PostgreSQL API readiness rejects schema49 and requires physical attribution guards under the deployed API role",
  pgOnly,
  async (t) => {
    const f = await fixture(t, 49);
    const config = readConfig({ NODE_ENV: "test", LLM_PROVIDER: "disabled" });
    const before = await buildApp({ db: f.db, config, testing: true });
    f.closeBeforeDatabase.push(() => before.close());
    assert.equal((await before.inject({ url: "/ready" })).statusCode, 503);
    await migrate(f.db);
    const { api } = await runtimeDatabase(f);
    const app = await buildApp({ db: api, config, testing: true });
    f.closeBeforeDatabase.push(() => app.close());
    assert.equal((await app.inject({ url: "/ready" })).statusCode, 200);
    for (const [table, trigger] of [
      ["user_acquisition", "user_acquisition_identity"],
      ["email_registrations", "email_registration_attribution_identity"],
    ]) {
      await f.db.exec(`alter table ${table} disable trigger ${trigger}`);
      assert.equal((await app.inject({ url: "/ready" })).statusCode, 503);
      await f.db.exec(`alter table ${table} enable trigger ${trigger}`);
      assert.equal((await app.inject({ url: "/ready" })).statusCode, 200);
    }
    for (const table of [
      "users",
      "user_acquisition",
      "ai_credit_entries",
      "ai_model_attempts",
    ])
      assert.equal(
        (
          await f.db.query<{ n: number }>(
            `select count(*)::int as n from ${table}`,
          )
        ).rows[0]?.n,
        0,
      );
  },
);
