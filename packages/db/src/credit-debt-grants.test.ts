import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { AiCreditLedger, connectDatabase, migrate } from "./index.js";

const repayment = "citygo_apply_credit_debt_repayments(bigint)";
const permissionDenied = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  error.code === "42501" &&
  error.message.includes("citygo_apply_credit_debt_repayments");

async function fixture(t: TestContext) {
  // Memory only. Roles exist BEFORE migration: functions must have the actual
  // citygo_migrator ownership/default ACL, not postgres's permissive defaults.
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await db.exec(`create role citygo_migrator nologin nosuperuser nocreatedb nocreaterole;
    create role citygo_api nologin nosuperuser nocreatedb nocreaterole;
    create role citygo_worker nologin nosuperuser nocreatedb nocreaterole;
    create role citygo_backup nologin nosuperuser nocreatedb nocreaterole;
    create role synthetic_public_only nologin nosuperuser nocreatedb nocreaterole;
    revoke all on schema public from public;
    grant usage,create on schema public to citygo_migrator;
    grant usage on schema public to citygo_api,citygo_worker,citygo_backup,synthetic_public_only;`);
  const init = await readFile(
    new URL("../../../deploy/postgres/init.sql", import.meta.url),
    "utf8",
  );
  const defaultAcl = init
    .split(/\r?\n/)
    .filter((line) =>
      /^alter default privileges for role citygo_migrator revoke execute on functions from public;$/.test(
        line,
      ),
    );
  assert.equal(defaultAcl.length, 1, "Use the exact production default ACL");
  await db.exec(defaultAcl[0]!);
  await db.exec("set role citygo_migrator");
  await migrate(db);
  assert.equal(
    (await db.query("select name from citygo_migrations")).rows.length,
    49,
  );
  const initial = (
    await db.query<{ owner: string; elevated: boolean; api: boolean }>(
      `select pg_get_userbyid(p.proowner) as owner,p.prosecdef as elevated,
      has_function_privilege('citygo_api',p.oid,'EXECUTE') as api
      from pg_proc p where p.oid=$1::regprocedure`,
      [repayment],
    )
  ).rows[0]!;
  assert.deepEqual(initial, {
    owner: "citygo_migrator",
    elevated: false,
    api: false,
  });
  const grants = (
    await readFile(
      new URL("../../../deploy/postgres/grants.sql", import.meta.url),
      "utf8",
    )
  ).replace(/^\\set[^\n]*\n/gm, "");
  await db.exec(grants);
  await db.exec("set role citygo_api");
  assert.equal(
    (await db.query<{ role: string }>("select current_user::text as role"))
      .rows[0]!.role,
    "citygo_api",
  );
  const user = (
    await db.query<{ id: string }>(
      "insert into users(auth_subject) values ($1) returning id::text",
      ["synthetic-debt-function-grants-" + randomUUID()],
    )
  ).rows[0]!.id;
  const ledger = new AiCreditLedger(db, "routerai_citygo_10x");
  const setMigrator = () => db.exec("reset role; set role citygo_migrator");
  const setApi = () => db.exec("reset role; set role citygo_api");
  const money = async () =>
    (
      await db.query(`select jsonb_build_object(
      'accounts',(select coalesce(jsonb_agg(to_jsonb(a) order by user_id),'[]'::jsonb) from ai_credit_accounts a),
      'entries',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]'::jsonb) from ai_credit_entries e),
      'lots',(select coalesce(jsonb_agg(to_jsonb(l) order by id),'[]'::jsonb) from credit_source_lots l),
      'topups',(select coalesce(jsonb_agg(to_jsonb(p) order by operation_id),'[]'::jsonb) from ai_credit_topups p),
      'receipts',(select coalesce(jsonb_agg(to_jsonb(n) order by id),'[]'::jsonb) from npd_receipt_tasks n)
      ) as snapshot`)
    ).rows[0];
  const topup = () =>
    ledger.topUpConfirmed(user, randomUUID(), {
      providerPaymentId: randomUUID(),
      merchantId: "synthetic-debt-grants",
      test: false,
      paidKopeks: 10_000,
      verifiedAt: "2026-10-21T00:00:00.000Z",
      verification: "server_get_succeeded",
      currency: "RUB",
    });
  return { db, user, ledger, grants, setMigrator, setApi, money, topup };
}

test("repayment EXECUTE belongs only to API, not PUBLIC/Worker/backup or other functions", async (t) => {
  const f = await fixture(t);
  const acl = (
    await f.db.query<{
      api: boolean;
      worker: boolean;
      backup: boolean;
      public_only: boolean;
      public_execute: boolean;
      other_function: boolean;
    }>(
      `select has_function_privilege('citygo_api',p.oid,'EXECUTE') as api,
      has_function_privilege('citygo_worker',p.oid,'EXECUTE') as worker,
      has_function_privilege('citygo_backup',p.oid,'EXECUTE') as backup,
      has_function_privilege('synthetic_public_only',p.oid,'EXECUTE') as public_only,
      exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute,
      has_function_privilege('citygo_api','citygo_check_credit_debt_conservation()','EXECUTE') as other_function
      from pg_proc p where p.oid=$1::regprocedure`,
      [repayment],
    )
  ).rows[0];
  assert.deepEqual(acl, {
    api: true,
    worker: false,
    backup: false,
    public_only: false,
    public_execute: false,
    other_function: false,
  });
  const before = await f.money();
  await f.db.query("select citygo_apply_credit_debt_repayments($1)", [f.user]);
  assert.deepEqual(await f.money(), before);
  for (const role of [
    "citygo_worker",
    "citygo_backup",
    "synthetic_public_only",
  ]) {
    await f.db.exec("reset role; set role " + role);
    await assert.rejects(
      f.db.query("select citygo_apply_credit_debt_repayments($1)", [f.user]),
      permissionDenied,
    );
  }
});

test("missing exact function grant reproduces 42501 in direct and new-source paths with atomic rollback", async (t) => {
  const f = await fixture(t);
  await f.setMigrator();
  // Reproduce the former grants defect inside this memory fixture only. Do not
  // rewrite migration SQL, broaden roles, elevate the function or hide failure.
  await f.db.exec(
    "revoke execute on function citygo_apply_credit_debt_repayments(bigint) from citygo_api",
  );
  await f.setApi();
  const before = await f.money();
  await assert.rejects(
    f.db.query("select citygo_apply_credit_debt_repayments($1)", [f.user]),
    permissionDenied,
  );
  await assert.rejects(f.ledger.grantWelcome(f.user, f.user), permissionDenied);
  assert.deepEqual(await f.money(), before);
  await assert.rejects(f.topup(), permissionDenied);
  assert.deepEqual(await f.money(), before);
  // Applying canonical grants restores only the reviewed invoker entry point.
  await f.setMigrator();
  await f.db.exec(f.grants);
  await f.setApi();
  await f.db.query("select citygo_apply_credit_debt_repayments($1)", [f.user]);
});

test("gift and verified synthetic paid lots invoke debt repayment under restricted API privileges", async (t) => {
  const f = await fixture(t);
  // Trusted server primitives with entirely fictional postings. This fixture
  // does not enable the public gift endpoint or make a YooKassa/AI request.
  await f.ledger.grantWelcome(f.user, f.user);
  await f.topup();
  const lots = (
    await f.db.query<{ kind: string; gross: string }>(
      "select kind,gross_micros::text as gross from credit_source_lots where user_id=$1 order by kind",
      [f.user],
    )
  ).rows;
  assert.deepEqual(lots, [
    { kind: "gift", gross: "500000000" },
    { kind: "paid", gross: "100000000" },
  ]);
  const balance = await f.ledger.status(f.user);
  assert.equal(balance.grantedMicros, 600_000_000);
  assert.equal(balance.spentMicros, 0);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.availableMicros, 600_000_000);
  assert.equal(
    (await f.db.query("select id from npd_receipt_tasks")).rows.length,
    1,
  );
});
