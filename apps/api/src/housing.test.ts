import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
  type Sql,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  type HousingStorageLimits,
  type QuestPlanReference,
  type R1HousingBriefDraft,
} from "@citygo/contracts";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";

type Brief = {
  id: string;
  revision: number;
  plan: QuestPlanReference;
  content: R1HousingBriefDraft;
};
async function fixture(
  t: TestContext,
  {
    enabled = true,
    grants = true,
    limits = {},
  }: {
    enabled?: boolean;
    grants?: boolean;
    limits?: Partial<HousingStorageLimits>;
  } = {},
) {
  let base: Database;
  let admin: Database | undefined;
  let databaseName: string | undefined;
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    admin = await connectDatabase(url.toString());
    databaseName = "cg012_api_test_" + randomUUID().replaceAll("-", "");
    await admin.query(
      'create database "' + databaseName + '" template template0',
    );
    url.pathname = "/" + databaseName;
    base = await connectDatabase(url.toString());
    t.diagnostic("Housing HTTP backend: isolated PostgreSQL");
  } else base = await connectDatabase("pglite://:memory:");
  const suffix = randomUUID().replaceAll("-", "");
  const roles = {
    citygo_api: "cg012_api_" + suffix,
    citygo_worker: "cg012_worker_" + suffix,
    citygo_backup: "cg012_backup_" + suffix,
  };
  const created: string[] = [];
  const lifecycle: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  t.after(async () => {
    try {
      if (lifecycle.app) await lifecycle.app.close();
      for (const role of created.reverse())
        await base.exec("drop owned by " + role + "; drop role " + role);
    } finally {
      await base.close();
      if (admin) {
        try {
          await admin.query('drop database "' + databaseName + '"');
        } finally {
          await admin.close();
        }
      }
    }
  });
  await migrate(base);
  for (const role of Object.values(roles)) {
    await base.exec("create role " + role + " nologin");
    created.push(role);
    await base.exec("grant usage on schema public to " + role);
  }
  const common = (
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
  await base.exec(common);
  if (grants) {
    const extra = (
      await readFile(
        new URL(
          "../../../packages/db/src/fixtures/housing-synthetic-grants.sql",
          import.meta.url,
        ),
        "utf8",
      )
    ).replaceAll("cg012_synthetic_api", roles.citygo_api);
    await base.exec(extra);
  }
  const transaction = <T>(work: (tx: Sql) => Promise<T>) =>
    base.transaction(async (tx) => {
      await tx.query("set local role " + roles.citygo_api);
      return work(tx);
    });
  const db: Database = {
    transaction,
    query: <T>(sql: string, values?: unknown[]) =>
      transaction((tx) => tx.query<T>(sql, values)),
    exec: (sql) => transaction((tx) => tx.exec(sql)),
    close: async () => {},
  };
  const app = await buildApp({
    db,
    testing: true,
    housingLimits: limits,
    config: readConfig({
      NODE_ENV: "test",
      R1_HOUSING_API_MODE: enabled ? "synthetic" : "disabled",
    }),
  });
  lifecycle.app = app;
  const diagnostics: unknown[] = [];
  app.addHook("onRequest", async (request) => {
    t.mock.method(request.log, "error", (entry: unknown) => {
      diagnostics.push(entry);
    });
  });
  await app.ready();
  const call = (
    method: "GET" | "POST",
    url: string,
    token = "",
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    app!.inject({
      method,
      url,
      headers: {
        origin: "http://localhost:3000",
        authorization: "Bearer " + token,
        "X-CityGo-Contract-Version": "1",
        ...headers,
      },
      ...(payload ? { payload } : {}),
    });
  async function person() {
    const repo = new Repository(base);
    const id = await repo.register(
      randomUUID() + "@example.test",
      "synthetic-unused-hash",
    );
    const token = randomUUID();
    await repo.createSession(id, tokenHash(token));
    const plan = (
      await base.query<QuestPlanReference>(
        "insert into relocation_plans(user_id,status,plan) values ($1,'active',$2) returning id::text,version",
        [id, JSON.stringify({ stages: ["housing-brief", "housing-viewing"] })],
      )
    ).rows[0]!;
    return { id, token, plan };
  }
  async function create(user: Awaited<ReturnType<typeof person>>) {
    const command = { commandId: randomUUID(), plan: user.plan };
    const response = await call(
      "POST",
      "/v1/housing/briefs",
      user.token,
      command,
    );
    assert.equal(response.statusCode, 200, response.body);
    return { command, brief: response.json<Brief>() };
  }
  async function counts() {
    return (
      await base.query(`select
      (select count(*)::int from r1_housing_briefs) as briefs,
      (select count(*)::int from r1_housing_commands) as commands,
      (select count(*)::int from r1_housing_brief_revisions) as revisions,
      (select count(*)::int from xp_events) as xp,
      (select count(*)::int from ai_model_attempts) as attempts,
      (select count(*)::int from consent_events) as consents`)
    ).rows[0]!;
  }
  return { base, db, app, roles, person, create, counts, call, diagnostics };
}
const planQuery = (plan: QuestPlanReference) =>
  "?planId=" + plan.id + "&planVersion=" + plan.version;
function answer(brief: Brief, state: object = { status: "undecided" }) {
  return {
    commandId: randomUUID(),
    plan: brief.plan,
    brief: { id: brief.id, revision: brief.revision },
    change: {
      field: "monthlyRentRub",
      expectedFieldRevision: brief.content.answers.monthlyRentRub.revision,
      answer: state,
    },
  };
}

test("housing routes default absent; production cannot be opted in even with a supplied config", async (t) => {
  const f = await fixture(t, { enabled: false, grants: false });
  assert.equal(
    (await f.call("POST", "/v1/housing/briefs", "", {})).statusCode,
    404,
  );
  await f.base.query(
    "delete from citygo_migrations where name='0012_housing_answer_history.sql'",
  );
  assert.equal(
    (await f.call("GET", "/ready")).statusCode,
    200,
    "disabled route does not add a rollout dependency",
  );
  const supplied = {
    ...readConfig({ NODE_ENV: "test", R1_HOUSING_API_MODE: "synthetic" }),
    NODE_ENV: "production" as const,
  };
  await assert.rejects(
    buildApp({ db: f.db, config: supplied, testing: true }),
    /synthetic-only/,
  );
});

test("synthetic housing: no full profile/AI/credit required; partial states, correction, history and replay", async (t) => {
  const f = await fixture(t);
  const user = await f.person();
  const url = "/v1/housing/briefs/recovery" + planQuery(user.plan);
  assert.equal((await f.call("GET", "/ready")).statusCode, 200);
  assert.deepEqual((await f.call("GET", url, user.token)).json(), {
    status: "not_found",
  });
  assert.deepEqual(await f.counts(), {
    briefs: 0,
    commands: 0,
    revisions: 0,
    xp: 0,
    attempts: 0,
    consents: 0,
  });
  const { command, brief } = await f.create(user);
  assert.equal(brief.content.answers.monthlyRentRub.status, "unasked");
  assert.equal(brief.content.answers.moveTiming.status, "unasked");
  assert.equal(brief.content.answers.housingType.status, "unasked");
  let current = brief;
  const saved: Brief[] = [brief];
  for (const state of [
    { status: "undecided" },
    { status: "declined" },
    { status: "known", value: { max: 60000 } },
    { status: "known", value: { max: 65000 } },
  ]) {
    const response = await f.call(
      "POST",
      "/v1/housing/answers",
      user.token,
      answer(current, state),
    );
    assert.equal(response.statusCode, 200, response.body);
    current = response.json<Brief>();
    saved.push(current);
    assert.equal(current.content.answers.moveTiming.status, "unasked");
  }
  assert.deepEqual((await f.call("GET", url, user.token)).json(), {
    status: "recovered",
    brief: current,
  });
  const first = (
    await f.call(
      "GET",
      "/v1/housing/briefs/" + brief.id + "/history?limit=2",
      user.token,
    )
  ).json();
  assert.deepEqual(first.items, saved.slice(-2).reverse());
  const rest = (
    await f.call(
      "GET",
      "/v1/housing/briefs/" +
        brief.id +
        "/history?limit=50&beforeRevision=" +
        first.nextBeforeRevision,
      user.token,
    )
  ).json();
  assert.deepEqual(rest.items, saved.slice(0, -2).reverse());
  assert.equal(rest.nextBeforeRevision, null);
  assert.deepEqual(
    (await f.call("POST", "/v1/housing/briefs", user.token, command)).json(),
    brief,
  );
  assert.deepEqual(await f.counts(), {
    briefs: 1,
    commands: 5,
    revisions: 5,
    xp: 0,
    attempts: 0,
    consents: 0,
  });
});

test("auth/owner/CSRF/strict input: foreign data is 404 before decode; failures have no writes", async (t) => {
  const f = await fixture(t);
  const a = await f.person(),
    b = await f.person();
  const { brief } = await f.create(a);
  const before = await f.counts();
  for (const url of [
    "/v1/housing/briefs" + planQuery(a.plan),
    "/v1/housing/briefs/recovery" + planQuery(a.plan),
    "/v1/housing/briefs/" + brief.id,
    "/v1/housing/briefs/" + brief.id + "/history",
  ]) {
    assert.equal((await f.call("GET", url)).statusCode, 401);
    assert.equal((await f.call("GET", url, b.token)).statusCode, 404);
  }
  const mutation = answer(brief);
  assert.equal(
    (await f.call("POST", "/v1/housing/answers", b.token, mutation)).statusCode,
    404,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/housing/answers", a.token, mutation, {
        origin: "https://evil.example",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/housing/answers", a.token, mutation, {
        "X-CityGo-Contract-Version": "2",
      })
    ).statusCode,
    400,
  );
  for (const url of [
    "/v1/housing/briefs?planId=" + a.plan.id + "&planVersion=01",
    "/v1/housing/briefs" + planQuery(a.plan) + "&limit=51",
    "/v1/housing/briefs" + planQuery(a.plan) + "&limit=1&limit=2",
    "/v1/housing/briefs" + planQuery(a.plan) + "&ownerId=" + b.id,
    "/v1/housing/briefs/" + brief.id + "?revision=1e0",
    "/v1/housing/briefs/" + brief.id + "/history?beforeRevision=0",
  ])
    assert.equal((await f.call("GET", url, a.token)).statusCode, 400, url);
  for (const payload of [
    { ...mutation, ownerId: b.id },
    {
      ...mutation,
      change: {
        ...mutation.change,
        actor: "user",
        provenance: { kind: "user_stated", eventId: randomUUID() },
      },
    },
  ])
    assert.equal(
      (await f.call("POST", "/v1/housing/answers", a.token, payload))
        .statusCode,
      400,
    );
  await f.base
    .exec(`alter table r1_housing_brief_revisions disable trigger r1_housing_revisions_immutable;
    update r1_housing_brief_revisions set content='{"schemaVersion":999,"secret":"PRIVATE_CANARY"}';
    alter table r1_housing_brief_revisions enable trigger r1_housing_revisions_immutable;`);
  const foreign = await f.call(
    "GET",
    "/v1/housing/briefs/" + brief.id,
    b.token,
  );
  const missing = await f.call("GET", "/v1/housing/briefs/999999", b.token);
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().error, missing.json().error);
  assert.deepEqual(await f.counts(), before);
});

test("explicit selection exposes only dates/IDs; stale CAS and archive writes do not overwrite history", async (t) => {
  const f = await fixture(t),
    user = await f.person();
  const { brief, command } = await f.create(user);
  const other = await f.create(user);
  assert.deepEqual(
    (
      await f.call(
        "GET",
        "/v1/housing/briefs/recovery" + planQuery(user.plan),
        user.token,
      )
    ).json(),
    { status: "selection_required" },
  );
  const page = (
    await f.call(
      "GET",
      "/v1/housing/briefs" + planQuery(user.plan) + "&limit=1",
      user.token,
    )
  ).json();
  assert.equal(page.items[0].id, other.brief.id);
  assert.equal(page.nextBeforeId, other.brief.id);
  assert.deepEqual(Object.keys(page.items[0]).sort(), [
    "createdAt",
    "id",
    "plan",
    "revision",
    "updatedAt",
  ]);
  assert.ok(!Number.isNaN(Date.parse(page.items[0].updatedAt)));
  const change = answer(brief);
  const updated = await f.call(
    "POST",
    "/v1/housing/answers",
    user.token,
    change,
  );
  assert.equal(updated.statusCode, 200);
  assert.equal(
    (
      await f.call("POST", "/v1/housing/answers", user.token, answer(brief))
    ).json().code,
    "REVISION_CONFLICT",
  );
  assert.equal(
    (
      await f.call("POST", "/v1/housing/answers", user.token, {
        ...change,
        change: { ...change.change, answer: { status: "declined" } },
      })
    ).statusCode,
    409,
  );
  await f.base.query(
    "update relocation_plans set status='archived' where id=$1",
    [user.plan.id],
  );
  const before = await f.counts();
  assert.deepEqual(
    (await f.call("POST", "/v1/housing/briefs", user.token, command)).json(),
    brief,
  );
  assert.deepEqual(
    (await f.call("POST", "/v1/housing/answers", user.token, change)).json(),
    updated.json(),
  );
  assert.equal(
    (
      await f.call(
        "POST",
        "/v1/housing/answers",
        user.token,
        answer(updated.json()),
      )
    ).json().code,
    "PLAN_STALE",
  );
  assert.equal(
    (await f.call("GET", "/v1/housing/briefs/" + brief.id, user.token))
      .statusCode,
    200,
  );
  assert.deepEqual(await f.counts(), before);
});

test("readiness requires exact 0012 and narrow privileges on every request, without leaking SQL", async (t) => {
  const f = await fixture(t, { grants: false }),
    user = await f.person();
  const url = "/v1/housing/briefs" + planQuery(user.plan);
  assert.equal((await f.call("GET", "/ready")).statusCode, 503);
  assert.equal((await f.call("GET", url, user.token)).statusCode, 503);
  const extra = (
    await readFile(
      new URL(
        "../../../packages/db/src/fixtures/housing-synthetic-grants.sql",
        import.meta.url,
      ),
      "utf8",
    )
  ).replaceAll("cg012_synthetic_api", f.roles.citygo_api);
  await f.base.exec(extra);
  assert.equal((await f.call("GET", "/ready")).statusCode, 200);
  const checksum = (
    await f.base.query<{ checksum: string }>(
      "select checksum from citygo_migrations where name='0012_housing_answer_history.sql'",
    )
  ).rows[0]!.checksum;
  for (const table of [
    "r1_housing_briefs",
    "r1_housing_commands",
    "r1_housing_brief_revisions",
  ]) {
    await f.base.exec("grant delete on " + table + " to " + f.roles.citygo_api);
    const response = await f.call("GET", url, user.token);
    assert.equal(response.statusCode, 503);
    assert.ok(!response.body.includes(table));
    await f.base.exec(
      "revoke delete on " + table + " from " + f.roles.citygo_api,
    );
  }
  for (const [grant, revoke] of [
    [
      "grant update (content) on r1_housing_brief_revisions to ",
      "revoke update (content) on r1_housing_brief_revisions from ",
    ],
    [
      "grant update on sequence r1_housing_briefs_id_seq to ",
      "revoke update on sequence r1_housing_briefs_id_seq from ",
    ],
    [
      "grant create on schema public to ",
      "revoke create on schema public from ",
    ],
  ]) {
    await f.base.exec(grant + f.roles.citygo_api);
    assert.equal((await f.call("GET", url, user.token)).statusCode, 503);
    await f.base.exec(revoke + f.roles.citygo_api);
    assert.equal((await f.call("GET", "/ready")).statusCode, 200);
  }
  for (const table of ["users", "relocation_plans"]) {
    await f.base.exec(
      "revoke update on " + table + " from " + f.roles.citygo_api,
    );
    assert.equal((await f.call("GET", url, user.token)).statusCode, 503);
    // Column-only UPDATE is sufficient for SELECT FOR UPDATE; no need to
    // expand the existing production table grants in this increment.
    await f.base.exec(
      "grant update (id) on " + table + " to " + f.roles.citygo_api,
    );
    assert.equal((await f.call("GET", "/ready")).statusCode, 200);
  }
  await f.base.exec(
    "revoke insert on r1_housing_commands from " + f.roles.citygo_api,
  );
  assert.equal((await f.call("GET", url, user.token)).statusCode, 503);
  await f.base.exec(
    "grant insert on r1_housing_commands to " + f.roles.citygo_api,
  );
  assert.equal((await f.call("GET", "/ready")).statusCode, 200);
  await f.base.query(
    "update citygo_migrations set checksum='changed' where name='0012_housing_answer_history.sql'",
  );
  assert.equal((await f.call("GET", "/ready")).statusCode, 503);
  assert.equal((await f.call("GET", url, user.token)).statusCode, 503);
  await f.base.query(
    "update citygo_migrations set checksum=$1 where name='0012_housing_answer_history.sql'",
    [checksum],
  );
  assert.equal((await f.call("GET", "/ready")).statusCode, 200);
  await f.base.query(
    "delete from citygo_migrations where name='0012_housing_answer_history.sql'",
  );
  assert.equal((await f.call("GET", url, user.token)).statusCode, 503);
  await f.base.query(
    "insert into citygo_migrations(name,checksum) values ('0012_housing_answer_history.sql',$1)",
    [checksum],
  );
  // Matching name/checksum is not evidence that the actual schema is usable.
  await f.base.exec(
    "alter table r1_housing_brief_revisions rename column content to unavailable_content",
  );
  assert.equal((await f.call("GET", "/ready")).statusCode, 503);
  await f.base.exec(
    "alter table r1_housing_brief_revisions rename column unavailable_content to content",
  );
  assert.equal((await f.call("GET", "/ready")).statusCode, 200);
  await f.base.exec("alter role " + f.roles.citygo_api + " createdb");
  assert.equal((await f.call("GET", url, user.token)).statusCode, 503);
  await f.base.exec("alter role " + f.roles.citygo_api + " nocreatedb");
  assert.equal((await f.call("GET", "/ready")).statusCode, 200);
  assert.deepEqual(await f.counts(), {
    briefs: 0,
    commands: 0,
    revisions: 0,
    xp: 0,
    attempts: 0,
    consents: 0,
  });
});

test("housing uses real cookie/bearer sessions, revoked or blocked users and oversized bodies fail closed", async (t) => {
  const f = await fixture(t),
    user = await f.person();
  const body = { commandId: randomUUID(), plan: user.plan };
  const cookie = { authorization: "", cookie: "citygo=" + user.token };
  assert.equal(
    (
      await f.call("POST", "/v1/housing/briefs", "", body, {
        ...cookie,
        origin: "",
      })
    ).statusCode,
    403,
  );
  const created = await f.call("POST", "/v1/housing/briefs", "", body, cookie);
  assert.equal(created.statusCode, 200);
  assert.equal(
    (
      await f.call("POST", "/v1/housing/briefs", user.token, body, {
        origin: "",
      })
    ).statusCode,
    200,
  );
  const brief = created.json<Brief>();
  const tooBig = answer(brief, {
    status: "undecided",
    note: "PRIVATE_CANARY".repeat(2000),
  });
  const before = await f.counts();
  const reply = await f.call("POST", "/v1/housing/answers", user.token, tooBig);
  assert.equal(reply.statusCode, 413);
  assert.ok(!reply.body.includes("PRIVATE_CANARY"));
  await f.base.query("update users set status='blocked' where id=$1", [
    user.id,
  ]);
  assert.equal(
    (await f.call("GET", "/v1/housing/briefs/" + brief.id, user.token))
      .statusCode,
    401,
  );
  await f.base.query("update users set status='active' where id=$1", [user.id]);
  await f.base.query("delete from sessions where user_id=$1", [user.id]);
  assert.equal(
    (await f.call("GET", "/v1/housing/briefs/" + brief.id, user.token))
      .statusCode,
    401,
  );
  assert.deepEqual(await f.counts(), before);
});

test("storage limit is non-retryable and atomic; reads/replay survive a full quota", async (t) => {
  const f = await fixture(t, { limits: { commandsPerOwner: 1 } }),
    user = await f.person();
  const { brief, command } = await f.create(user);
  const before = await f.counts();
  const response = await f.call(
    "POST",
    "/v1/housing/answers",
    user.token,
    answer(brief),
  );
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "HOUSING_STORAGE_LIMIT");
  assert.equal(response.json().retryable, false);
  assert.deepEqual(
    (await f.call("POST", "/v1/housing/briefs", user.token, command)).json(),
    brief,
  );
  assert.equal(
    (await f.call("GET", "/v1/housing/briefs/" + brief.id, user.token))
      .statusCode,
    200,
  );
  assert.deepEqual(await f.counts(), before);
});

test("corrupt owned history has generic 500 and safe resource diagnostics, not a payload or fallback", async (t) => {
  const f = await fixture(t),
    user = await f.person();
  const { brief } = await f.create(user);
  await f.base
    .exec(`alter table r1_housing_brief_revisions disable trigger r1_housing_revisions_immutable;
    update r1_housing_brief_revisions set content='{"schemaVersion":999,"secret":"PRIVATE_CANARY"}';
    alter table r1_housing_brief_revisions enable trigger r1_housing_revisions_immutable;`);
  const response = await f.call(
    "GET",
    "/v1/housing/briefs/" + brief.id,
    user.token,
  );
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().code, "INTERNAL_ERROR");
  assert.ok(!response.body.includes("PRIVATE_CANARY"));
  assert.equal(response.json().briefId, undefined);
  assert.ok(!JSON.stringify(f.diagnostics).includes("PRIVATE_CANARY"));
  assert.ok(
    f.diagnostics.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "briefId" in entry &&
        entry.briefId === brief.id,
    ),
  );
});
