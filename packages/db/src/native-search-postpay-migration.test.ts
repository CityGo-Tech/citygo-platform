import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { CITYGO_10X_TARIFF, type AiPolicy } from "@citygo/contracts";
import {
  AiCreditLedger,
  Repository,
  ServiceConsents,
  connectDatabase,
  migrate,
  type AiRequestModeSnapshot,
} from "./index.js";
import { applyFixtureMigration } from "./test-service-consents.js";

const nativeVersion = "ai-mode-route-web-search-postpay-test-v1";
const h = (value: string) => createHash("sha256").update(value).digest("hex");
const common: AiPolicy = {
  id: h("native-migration-consent"),
  provider: "routerai",
  model: "citygo-bundle",
  version: "synthetic-v1",
  recipient: "Synthetic recipients",
  routing: "Synthetic routing",
  data: "Synthetic data",
};
function snapshot(
  change: {
    mode?: "maximum" | "balanced";
    version?: string;
    model?: string;
    upstream?: string;
  } = {},
): AiRequestModeSnapshot {
  const mode = change.mode ?? "maximum";
  const model = change.model ?? "openai/gpt-6.1-sol";
  const version = change.version ?? nativeVersion;
  const upstream = change.upstream ?? "openai";
  const identity = JSON.stringify({ mode, model, version, upstream });
  const policy: AiPolicy = {
    ...common,
    id: h(identity + "policy"),
    model,
    version,
  };
  return {
    mode,
    catalogId: h(identity + "catalog"),
    policy,
    upstream,
    execution: {
      key: h(identity + "execution"),
      policy: { ...policy },
      maxInputBytes: 2048,
      maxOutputTokens: 64,
    },
  };
}

async function fixture47(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await db.exec(
    "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now()); create table citygo_migration_lock(id integer primary key); insert into citygo_migration_lock values(1)",
  );
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql") && name < "0048_")
    .sort())
    await applyFixtureMigration(db, name);
  assert.equal(
    (await db.query("select 1 from citygo_migrations")).rows.length,
    47,
  );
  const repo = new Repository(
    db,
    true,
    CITYGO_10X_TARIFF,
    false,
    "fixed5_overdraft",
    false,
    undefined,
    "operator_ceiling",
    "postpay_actual_v1",
  );
  await repo.initializeAiRouting(common);
  const consents = new ServiceConsents(db, () => common);
  const createOwner = async () => {
    const user = (
      await consents.register(
        randomUUID() + "@example.test",
        "synthetic-hash",
        h(randomUUID()),
        {
          policyVersion: (await consents.policy()).version,
          personalData: true,
          marketing: false,
        },
      )
    ).id;
    await new AiCreditLedger(db).topUpConfirmed(user, randomUUID(), {
      providerPaymentId: "synthetic-migration-funding-" + randomUUID(),
      merchantId: "synthetic-shop",
      paidKopeks: 50000,
      currency: "RUB",
      test: false,
      verifiedAt: new Date().toISOString(),
      verification: "server_get_succeeded",
    });
    return user;
  };
  const user = await createOwner();
  let prepared = 0;
  let budgetRevision = 1;
  const routing = await repo.aiRouting();
  const prepare = async (selected: AiRequestModeSnapshot) => {
    // Each isolated scenario has its own ordinary fixture account/thread; do
    // not duplicate or disable the one-open-conversation constraints.
    const owner = prepared++ === 0 ? user : await createOwner();
    // Use the actual administration API and its normal rule bound. A new
    // scenario changes the single admitted profile before the request snapshot;
    // no production cap or financial guard is bypassed for this fixture.
    const budget = await repo.changeAiBudget(
      owner,
      {
        expectedRevision: budgetRevision,
        enabled: true,
        currency: "RUB",
        mode: "fixed",
        dailyLimitMicros: 1_000_000_000,
        totalLimitMicros: 1_000_000_000,
        userDailyLimitMicros: null,
        rules: [
          { key: selected.execution.key, attemptCeilingMicros: 6_000_000 },
        ],
      },
      [selected.execution],
    );
    budgetRevision = budget.revision;
    const existing = (
      await db.query<{ id: string }>(
        "select id::text from agent_threads where user_id=$1 and status<>'closed'",
        [owner],
      )
    ).rows[0];
    const thread =
      existing?.id ??
      (
        await db.query<{ id: string }>(
          "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
          [owner],
        )
      ).rows[0]!.id;
    const requestId = randomUUID();
    const request = await repo.reserveChat(
      owner,
      thread,
      requestId,
      "Synthetic migration question",
      {
        policyId: common.id,
        revision: routing.revision,
        userDailyLimit: 100,
        globalDailyLimit: 200,
        modeSnapshot: selected,
      },
    );
    return (protocol: "responses" | "chat/completions") =>
      repo.reserveAiAttempt({
        userId: owner,
        threadId: thread,
        requestId,
        lease: request.lease,
        attemptNumber: 1,
        provider: selected.policy.provider,
        model: selected.policy.model,
        policyId: selected.policy.id,
        consentPolicyId: common.id,
        routingRevision: routing.revision,
        userDailyLimit: 100,
        globalDailyLimit: 200,
        execution: selected.execution,
        upstream: selected.upstream,
        mode: { id: selected.mode, catalogId: selected.catalogId },
        protocol,
      });
  };
  const rows = async () => {
    const names = (
      await db.query<{ name: string }>(
        "select tablename as name from pg_tables where schemaname='public' and tablename not in('citygo_migrations','citygo_migration_lock') order by tablename",
      )
    ).rows;
    const result = [];
    for (const { name } of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      result.push({
        name,
        rows: (
          await db.query(
            `select to_jsonb(t) as row from public."${name}" t order by to_jsonb(t)::text`,
          )
        ).rows,
      });
    }
    return result;
  };
  return { db, repo, user, prepare, rows };
}

test("0048 upgrades47 without changing data, function OID/security/ACL or existing attempt immutability", async (t) => {
  const f = await fixture47(t);
  const legacy = await f.prepare(
    snapshot({ version: "synthetic-old-version" }),
  );
  const legacyId = await legacy("responses");
  assert(legacyId);
  const role = "native_acl_" + randomUUID().replaceAll("-", "");
  assert.match(role, /^native_acl_[a-f0-9]{32}$/);
  await f.db.exec(
    `create role ${role} nologin; revoke execute on function public.citygo_guard_postpay_attempt() from public; grant execute on function public.citygo_guard_postpay_attempt() to ${role}`,
  );
  const metadata = async () =>
    (
      await f.db.query(
        "select p.oid::text,p.proowner::text,p.prosecdef,p.proconfig::text,p.proacl::text,t.oid::text as trigger_oid,t.tgfoid::text from pg_proc p join pg_trigger t on t.tgfoid=p.oid where p.oid='public.citygo_guard_postpay_attempt()'::regprocedure and t.tgname='ai_postpay_guard'",
      )
    ).rows;
  const beforeData = await f.rows(),
    beforeFunction = await metadata();
  assert.equal(beforeFunction.length, 1);
  assert.notEqual(
    beforeFunction[0]!.proacl,
    null,
    "the upgrade must retain a real explicit ACL, not just a null default",
  );
  await applyFixtureMigration(f.db, "0048_native_search_postpay.sql");
  assert.equal(
    (await f.db.query("select 1 from citygo_migrations")).rows.length,
    48,
  );
  assert.deepEqual(await f.rows(), beforeData);
  assert.deepEqual(await metadata(), beforeFunction);
  await assert.rejects(
    f.db.query(
      "update ai_postpay_attempts set protocol='chat/completions' where id=$1",
      [legacyId],
    ),
    /immutable/,
  );
  await assert.rejects(
    f.db.query("delete from ai_postpay_attempts where id=$1", [legacyId]),
    /retained/,
  );
  const native = await f.prepare(snapshot());
  assert(await native("chat/completions"));
});

test("0048 accepts only the reserved native version with exact Maximum/OpenAI/Sol/Chat identity, retaining old protocols", async (t) => {
  const f = await fixture47(t);
  const beforeUpgrade = await f.prepare(snapshot());
  await assert.rejects(
    beforeUpgrade("chat/completions"),
    /Postpay admission identity or balance is invalid/,
  );
  await applyFixtureMigration(f.db, "0048_native_search_postpay.sql");
  assert(await beforeUpgrade("chat/completions"));
  const cases = [
    { profile: snapshot(), protocol: "responses" as const },
    {
      profile: snapshot({ version: "synthetic-old-version" }),
      protocol: "chat/completions" as const,
    },
    {
      profile: snapshot({ version: "future-version" }),
      protocol: "chat/completions" as const,
    },
    {
      profile: snapshot({ model: "openai/other" }),
      protocol: "chat/completions" as const,
    },
    {
      profile: snapshot({ model: "openai/other" }),
      protocol: "responses" as const,
    },
    {
      profile: snapshot({ upstream: "deepseek" }),
      protocol: "chat/completions" as const,
    },
    {
      profile: snapshot({ upstream: "deepseek" }),
      protocol: "responses" as const,
    },
    {
      profile: snapshot({ mode: "balanced" }),
      protocol: "chat/completions" as const,
    },
  ];
  for (const entry of cases) {
    const admit = await f.prepare(entry.profile),
      before = await f.rows();
    await assert.rejects(
      admit(entry.protocol),
      /Postpay admission identity or balance is invalid/,
    );
    assert.deepEqual(
      await f.rows(),
      before,
      "a rejected admission cannot alter attempts, quotas or money",
    );
  }
  assert(
    await (
      await f.prepare(snapshot({ version: "synthetic-old-version" }))
    )("responses"),
  );
});

const productionVersion = "ai-mode-route-web-search-postpay-v1";

async function fixture48(t: TestContext) {
  const f = await fixture47(t);
  await applyFixtureMigration(f.db, "0048_native_search_postpay.sql");
  assert.equal(
    (await f.db.query("select 1 from citygo_migrations")).rows.length,
    48,
  );
  return f;
}

test("0049 upgrades48 without changing existing rows, function OID/security/ACL or attempt immutability", async (t) => {
  const f = await fixture48(t);
  const old = await f.prepare(snapshot());
  const oldId = await old("chat/completions");
  assert(oldId);
  const production = await f.prepare(snapshot({ version: productionVersion }));
  await assert.rejects(
    production("chat/completions"),
    /Postpay admission identity or balance is invalid/,
  );
  const role = "production_acl_" + randomUUID().replaceAll("-", "");
  assert.match(role, /^production_acl_[a-f0-9]{32}$/);
  await f.db.exec(
    `create role ${role} nologin; revoke execute on function public.citygo_guard_postpay_attempt() from public; grant execute on function public.citygo_guard_postpay_attempt() to ${role}`,
  );
  const metadata = async () =>
    (
      await f.db.query(
        "select p.oid::text,p.proowner::text,p.prosecdef,p.proconfig::text,p.proacl::text,t.oid::text as trigger_oid,t.tgfoid::text from pg_proc p join pg_trigger t on t.tgfoid=p.oid where p.oid='public.citygo_guard_postpay_attempt()'::regprocedure and t.tgname='ai_postpay_guard'",
      )
    ).rows;
  const beforeRows = await f.rows(),
    beforeFunction = await metadata();
  assert.equal(beforeFunction.length, 1);
  assert.notEqual(beforeFunction[0]!.proacl, null);
  await migrate(f.db);
  assert.equal(
    (await f.db.query("select 1 from citygo_migrations")).rows.length,
    49,
  );
  assert.deepEqual(await f.rows(), beforeRows);
  assert.deepEqual(await metadata(), beforeFunction);
  assert.equal(
    (await f.db.query("select 1 from pg_tables where schemaname='public'")).rows
      .length,
    80,
  );
  assert.equal(
    (await f.db.query("select 1 from pg_sequences where schemaname='public'"))
      .rows.length,
    23,
  );
  await assert.rejects(
    f.db.query(
      "update ai_postpay_attempts set protocol='responses' where id=$1",
      [oldId],
    ),
    /immutable/,
  );
  await assert.rejects(
    f.db.query("delete from ai_postpay_attempts where id=$1", [oldId]),
    /retained/,
  );
  assert(await production("chat/completions"));
  assert(await (await f.prepare(snapshot()))("chat/completions"));
});

test("0049 admits both reserved native versions only for exact Maximum/OpenAI/Sol/Chat and retains legacy protocols", async (t) => {
  const f = await fixture48(t);
  await applyFixtureMigration(f.db, "0049_native_search_production.sql");
  for (const version of [nativeVersion, productionVersion]) {
    assert(await (await f.prepare(snapshot({ version })))("chat/completions"));
    const cases = [
      { profile: snapshot({ version }), protocol: "responses" as const },
      {
        profile: snapshot({ version, model: "openai/other" }),
        protocol: "chat/completions" as const,
      },
      {
        profile: snapshot({ version, model: "openai/other" }),
        protocol: "responses" as const,
      },
      {
        profile: snapshot({ version, upstream: "deepseek" }),
        protocol: "chat/completions" as const,
      },
      {
        profile: snapshot({ version, upstream: "deepseek" }),
        protocol: "responses" as const,
      },
      {
        profile: snapshot({ version, mode: "balanced" }),
        protocol: "chat/completions" as const,
      },
    ];
    for (const entry of cases) {
      const admit = await f.prepare(entry.profile),
        before = await f.rows();
      await assert.rejects(
        admit(entry.protocol),
        /Postpay admission identity or balance is invalid/,
      );
      assert.deepEqual(
        await f.rows(),
        before,
        "reserved native versions cannot fall back or alter quotas, attempts or money",
      );
    }
  }
  for (const version of ["synthetic-old-version", "future-version"]) {
    const rejected = await f.prepare(snapshot({ version })),
      before = await f.rows();
    await assert.rejects(
      rejected("chat/completions"),
      /Postpay admission identity or balance is invalid/,
    );
    assert.deepEqual(await f.rows(), before);
    assert(await (await f.prepare(snapshot({ version })))("responses"));
    assert(
      await (
        await f.prepare(
          snapshot({
            version,
            mode: "balanced",
            model: "deepseek/deepseek-v4-pro-0813",
            upstream: "deepseek",
          }),
        )
      )("chat/completions"),
    );
  }
});

test("0049 function replacement and migration receipt roll back atomically after a late failure", async (t) => {
  const f = await fixture48(t);
  assert(await (await f.prepare(snapshot()))("chat/completions"));
  const capture = async () => ({
    rows: await f.rows(),
    journal: (
      await f.db.query(
        "select name,checksum,applied_at::text from citygo_migrations order by name",
      )
    ).rows,
    function: (
      await f.db.query(
        "select p.oid::text,p.proowner::text,p.prosecdef,p.proconfig::text,p.proacl::text,pg_get_functiondef(p.oid) as definition,t.oid::text as trigger_oid,t.tgfoid::text from pg_proc p join pg_trigger t on t.tgfoid=p.oid where p.oid='public.citygo_guard_postpay_attempt()'::regprocedure and t.tgname='ai_postpay_guard'",
      )
    ).rows,
  });
  const before = await capture();
  const name = "0049_native_search_production.sql";
  const source = await readFile(
    new URL("../migrations/" + name, import.meta.url),
    "utf8",
  );
  await assert.rejects(
    f.db.transaction(async (tx) => {
      await tx.exec(
        source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
      );
      await tx.query(
        "insert into citygo_migrations(name,checksum) values($1,$2)",
        [name, h(source.replaceAll("\r\n", "\n"))],
      );
      const installed = (
        await tx.query<{ definition: string }>(
          "select pg_get_functiondef('public.citygo_guard_postpay_attempt()'::regprocedure) as definition",
        )
      ).rows[0]!.definition;
      assert.ok(installed.includes(productionVersion));
      assert.ok(installed.includes(nativeVersion));
      throw new Error("Synthetic late migration49 failure");
    }),
    /Synthetic late migration49 failure/,
  );
  assert.deepEqual(await capture(), before);
  const native = await f.prepare(snapshot());
  assert(await native("chat/completions"));
  const production = await f.prepare(snapshot({ version: productionVersion }));
  await assert.rejects(
    production("chat/completions"),
    /Postpay admission identity or balance is invalid/,
  );
});
