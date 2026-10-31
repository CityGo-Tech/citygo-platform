import { registerSyntheticConsentingUser } from "./test-service-consents.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
  type Sql,
} from "@citygo/db";
import {
  CONTRACT_VERSION_HEADER,
  personalPlanPageSchema,
  personalPlanItemResultSchema,
  personalPlanRemoveResultSchema,
  personalPlanSummarySchema,
} from "@citygo/contracts";
import { readConfig } from "@citygo/config";
import type { StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";

async function fixture(t: TestContext) {
  // All data/config/adapters are synthetic and explicit. Runtime environment
  // files, provider/email/SMS keys, cloud services and real payments are absent.
  const db = await connectDatabase("pglite://:memory:");
  let corruptStoredOutput = false;
  function instrument(sql: Sql): Sql {
    return {
      exec: (text) => sql.exec(text),
      query: async <T>(text: string, values?: unknown[]) => {
        const result = await sql.query<T>(text, values);
        if (corruptStoredOutput && /from personal_plan_items\b/.test(text))
          return {
            rows: result.rows.map((row) => ({ ...row, title: "" })) as T[],
          };
        return result;
      },
    };
  }
  const observed: Database = {
    ...instrument(db),
    transaction: (work) => db.transaction((tx) => work(instrument(tx))),
    close: () => db.close(),
  };
  let modelCalls = 0;
  const provider: StreamingProvider = {
    name: "openai",
    model: "synthetic/personal-plan-no-model",
    async *stream() {
      modelCalls++;
      yield { type: "delta", text: "Unexpected synthetic model call" };
    },
  };
  await migrate(db);
  const app = await buildApp({
    db: observed,
    provider,
    testing: true,
    config: readConfig({
      NODE_ENV: "test",
      DATABASE_URL: "pglite://:memory:",
      WEB_ORIGIN: "http://localhost:3000",
      LLM_PROVIDER: "disabled",
      YOOKASSA_MODE: "disabled",
      EMAIL_REGISTRATION_MODE: "disabled",
      PHONE_VERIFICATION_MODE: "disabled",
      AI_CREDIT_MODE: "routerai_citygo_10x",
      AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
    }),
  });
  t.after(async () => {
    try {
      await app.close();
    } finally {
      await db.close();
    }
  });
  const repo = new Repository(db);
  const owner = await registerSyntheticConsentingUser(
    db,
    "plan-owner@example.test",
    "synthetic-hash",
    app,
  );
  const other = await registerSyntheticConsentingUser(
    db,
    "plan-other@example.test",
    "synthetic-hash",
    app,
  );
  await db.query("update users set role='super_admin' where id=$1", [other]);
  const ownerToken = randomUUID(),
    otherToken = randomUUID();
  await repo.createSession(owner, tokenHash(ownerToken));
  await repo.createSession(other, tokenHash(otherToken));
  const thread = async (userId: string) =>
    (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
        [userId],
      )
    ).rows[0]!.id;
  const ownerThread = await thread(owner),
    otherThread = await thread(other);
  const message = async (threadId: string, role: string) =>
    (
      await db.query<{ id: string }>(
        "insert into messages(thread_id,role,content,metadata) values($1,$2,$3,$4::jsonb) returning id::text",
        [
          threadId,
          role,
          "Synthetic source " + role,
          JSON.stringify({ agentKey: "support", status: "complete" }),
        ],
      )
    ).rows[0]!.id;
  const sources = {
    user: await message(ownerThread, "user"),
    assistant: await message(ownerThread, "assistant"),
    system: await message(ownerThread, "system"),
    tool: await message(ownerThread, "tool"),
    other: await message(otherThread, "user"),
  };
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
    token: string = ownerToken,
    cookie = false,
    version = "1",
  ) =>
    app.inject({
      method,
      url,
      headers: {
        [CONTRACT_VERSION_HEADER]: version,
        ...(cookie
          ? { origin: "http://localhost:3000", cookie: "citygo=" + token }
          : {
              "x-citygo-client": "native",
              ...(token ? { authorization: "Bearer " + token } : {}),
            }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const create = (sourceMessageId = sources.assistant) => ({
    operationId: randomUUID(),
    sourceMessageId,
    title: "Сравнить варианты",
    details: "Выбрать собственный следующий шаг",
  });
  const legacySnapshot = async () => {
    const names = (
      await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name<>'personal_plan_items' order by table_name",
      )
    ).rows;
    const tables: Record<string, string[]> = {};
    for (const { table_name } of names) {
      assert.match(table_name, /^[a-z_][a-z0-9_]*$/);
      tables[table_name] = (
        await db.query<{ row: string }>(
          'select to_jsonb(t)::text as row from "' + table_name + '" t',
        )
      ).rows
        .map((row) => row.row)
        .sort();
    }
    return {
      tables,
      sequences: (
        await db.query(
          "select sequencename,last_value::text as last_value from pg_sequences where schemaname='public' and sequencename not like 'personal_plan_items_%' order by sequencename",
        )
      ).rows,
    };
  };
  return {
    db,
    app,
    owner,
    other,
    ownerToken,
    otherToken,
    ownerThread,
    sources,
    call,
    create,
    legacySnapshot,
    modelCalls: () => modelCalls,
    corrupt: () => {
      corruptStoredOutput = true;
    },
  };
}

test("HTTP filtered plan and all-page summary require current ownership and exclude tombstones without model or money calls", async (t) => {
  const f = await fixture(t);
  const items = [];
  for (let index = 0; index < 24; index++) {
    const r = await f.call("POST", "/v1/personal-plan", f.create());
    assert.equal(r.statusCode, 200, r.body);
    items.push(personalPlanItemResultSchema.parse(r.json()).item);
  }
  for (const item of items.slice(0, 2)) {
    const r = await f.call("PATCH", "/v1/personal-plan/" + item.id, {
      expectedRevision: 1,
      title: item.title,
      details: item.details,
      status: "completed",
    });
    assert.equal(r.statusCode, 200, r.body);
  }
  assert.equal(
    (
      await f.call("DELETE", "/v1/personal-plan/" + items[2]!.id, {
        expectedRevision: 1,
      })
    ).statusCode,
    200,
  );
  const summary = await f.call("GET", "/v1/personal-plan/summary");
  assert.equal(summary.statusCode, 200, summary.body);
  assert.deepEqual(personalPlanSummarySchema.parse(summary.json()), {
    userId: f.owner,
    total: 23,
    pending: 21,
    completed: 2,
  });
  const first = personalPlanPageSchema.parse(
    (await f.call("GET", "/v1/personal-plan?status=pending")).json(),
  );
  assert.equal(first.items.length, 20);
  assert.ok(first.items.every((item) => item.status === "pending"));
  assert.ok(first.nextBefore);
  const next = personalPlanPageSchema.parse(
    (
      await f.call(
        "GET",
        "/v1/personal-plan?status=pending&before=" + first.nextBefore,
      )
    ).json(),
  );
  assert.equal(next.items.length, 1);
  assert.equal(next.nextBefore, null);
  assert.equal(
    (await f.call("GET", "/v1/personal-plan?status=all")).statusCode,
    400,
  );
  assert.equal(
    (await f.call("GET", "/v1/personal-plan/summary?userId=" + f.owner))
      .statusCode,
    400,
  );
  assert.equal(
    (await f.call("GET", "/v1/personal-plan/summary", undefined, ""))
      .statusCode,
    401,
  );
  assert.deepEqual(
    (
      await f.call("GET", "/v1/personal-plan/summary", undefined, f.otherToken)
    ).json(),
    { userId: f.other, total: 0, pending: 0, completed: 0 },
  );
  await f.db.query("delete from sessions where user_id=$1", [f.owner]);
  assert.equal(
    (await f.call("GET", "/v1/personal-plan/summary")).statusCode,
    401,
  );
  assert.equal(
    (await f.call("GET", "/v1/personal-plan?status=pending")).statusCode,
    401,
  );
  assert.equal(f.modelCalls(), 0);
});

test("personal plan HTTP CRUD persists a private action and preserves all legacy, money and AI state", async (t) => {
  const f = await fixture(t);
  const before = await f.legacySnapshot();
  const command = f.create();
  const created = await f.call("POST", "/v1/personal-plan", {
    ...command,
    title: "  Сравнить варианты  ",
  });
  assert.equal(created.statusCode, 200, created.body);
  const first = personalPlanItemResultSchema.parse(created.json());
  assert.equal(first.userId, f.owner);
  assert.equal(first.item.title, command.title);
  assert.equal(first.item.status, "pending");
  assert.equal(first.item.revision, 1);
  assert.deepEqual(first.item.source, {
    messageId: f.sources.assistant,
    threadId: f.ownerThread,
    role: "assistant",
  });
  const path = "/v1/personal-plan/" + first.item.id;
  const changed = await f.call("PATCH", path, {
    expectedRevision: 1,
    title: "Следующий шаг",
    details: "",
    status: "completed",
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().item.revision, 2);
  const replay = await f.call("POST", "/v1/personal-plan", command);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(
    replay.json().item.title,
    "Следующий шаг",
    "create replay returns the current item without overwriting edits",
  );
  assert.equal(
    (
      await f.call("POST", "/v1/personal-plan", {
        ...command,
        title: "Different request",
      })
    ).statusCode,
    409,
  );
  const reopened = await f.call("PATCH", path, {
    expectedRevision: 2,
    title: "Следующий шаг",
    details: "",
    status: "pending",
  });
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.equal(reopened.json().item.revision, 3);
  const stale = await f.call("PATCH", path, {
    expectedRevision: 1,
    title: "Stale",
    details: "",
    status: "completed",
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().code, "REVISION_CONFLICT");
  assert.equal(stale.json().currentVersion, 3);
  assert.equal(
    (await f.call("DELETE", path, { expectedRevision: 2 })).statusCode,
    409,
  );
  const list = await f.call("GET", "/v1/personal-plan");
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.headers["cache-control"], "no-store");
  assert.equal(list.headers[CONTRACT_VERSION_HEADER.toLowerCase()], "1");
  assert.equal(personalPlanPageSchema.parse(list.json()).items[0]!.revision, 3);
  const removed = await f.call("DELETE", path, { expectedRevision: 3 });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(personalPlanRemoveResultSchema.parse(removed.json()), {
    userId: f.owner,
    itemId: first.item.id,
    removed: true,
  });
  assert.equal(
    (await f.call("DELETE", path, { expectedRevision: 1 })).statusCode,
    200,
  );
  assert.equal(
    (await f.call("POST", "/v1/personal-plan", command)).statusCode,
    409,
    "deleted create replay must never resurrect a step",
  );
  assert.deepEqual((await f.call("GET", "/v1/personal-plan")).json().items, []);
  const own = await f.call(
    "POST",
    "/v1/personal-plan",
    f.create(f.sources.user),
  );
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().item.source.role, "user");
  assert.equal(f.modelCalls(), 0);
  assert.deepEqual(
    await f.legacySnapshot(),
    before,
    "personal steps do not write profile, messages, quests, XP, policies, ledger, payments or legacy sequences",
  );
});

test("personal plan HTTP owner boundary rejects forged owners, hidden sources and cross-owner super admins", async (t) => {
  const f = await fixture(t);
  const before = await f.legacySnapshot();
  assert.equal(
    (await f.call("GET", "/v1/personal-plan", undefined, "")).statusCode,
    401,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/personal-plan", {
        ...f.create(),
        userId: f.other,
      })
    ).statusCode,
    400,
  );
  for (const sourceMessageId of [
    f.sources.system,
    f.sources.tool,
    f.sources.other,
    "9223372036854775807",
  ])
    assert.equal(
      (await f.call("POST", "/v1/personal-plan", f.create(sourceMessageId)))
        .statusCode,
      404,
    );
  const created = await f.call("POST", "/v1/personal-plan", f.create());
  const id = created.json().item.id;
  const path = "/v1/personal-plan/" + id;
  assert.equal(
    (
      await f.call(
        "POST",
        "/v1/personal-plan",
        f.create(f.sources.user),
        f.otherToken,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.call(
        "PATCH",
        path,
        {
          expectedRevision: 1,
          title: "Forged",
          details: "",
          status: "completed",
        },
        f.otherToken,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await f.call("DELETE", path, { expectedRevision: 1 }, f.otherToken))
      .statusCode,
    404,
  );
  assert.deepEqual(
    personalPlanPageSchema.parse(
      (
        await f.call("GET", "/v1/personal-plan", undefined, f.otherToken)
      ).json(),
    ),
    { userId: f.other, items: [], nextBefore: null },
  );
  assert.equal(
    (
      await f.call(
        "GET",
        "/v1/personal-plan?userId=" + f.owner,
        undefined,
        f.otherToken,
      )
    ).statusCode,
    400,
  );
  assert.equal(f.modelCalls(), 0);
  assert.deepEqual(await f.legacySnapshot(), before);
});

test("personal plan HTTP validates strict canonical IDs, commands, pages and wire versions", async (t) => {
  const f = await fixture(t);
  for (const id of ["01", "0", "-1", "1e3", "9223372036854775808", "1%0A"])
    assert.equal(
      (
        await f.call("PATCH", "/v1/personal-plan/" + id, {
          expectedRevision: 1,
          title: "Step",
          details: "",
          status: "pending",
        })
      ).statusCode,
      400,
    );
  for (const query of [
    "?before=1%0A",
    "?before=1&before=2",
    "?before=01",
    "?limit=200",
    "?ownerId=1",
  ])
    assert.equal(
      (await f.call("GET", "/v1/personal-plan" + query)).statusCode,
      400,
    );
  for (const change of [
    { operationId: "bad" },
    { title: " " },
    { title: "x".repeat(121) },
    { details: "x".repeat(4001) },
    { sourceMessageId: "1\n" },
    { status: "completed" },
    { xp: 60 },
    { confirmedFact: true },
  ])
    assert.equal(
      (await f.call("POST", "/v1/personal-plan", { ...f.create(), ...change }))
        .statusCode,
      400,
    );
  assert.equal(
    (await f.call("POST", "/v1/personal-plan?ownerId=2", f.create()))
      .statusCode,
    400,
  );
  assert.equal(
    (await f.call("DELETE", "/v1/personal-plan/1", { expectedRevision: 0 }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await f.call(
        "GET",
        "/v1/personal-plan",
        undefined,
        f.ownerToken,
        false,
        "2",
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (await f.call("GET", "/v1/personal-plan?before=9223372036854775807"))
      .statusCode,
    200,
    "a cursor is only a numeric boundary, not an ownership capability",
  );
  assert.equal(f.modelCalls(), 0);
});

test("personal plan HTTP enforces cookie origin and account/password/session gates on every verb", async (t) => {
  const f = await fixture(t);
  const created = await f.call("POST", "/v1/personal-plan", f.create());
  const path = "/v1/personal-plan/" + created.json().item.id;
  for (const method of ["POST", "PATCH", "DELETE"] as const) {
    const reply = await f.app.inject({
      method,
      url: method === "POST" ? "/v1/personal-plan" : path,
      headers: {
        origin: "https://untrusted.example",
        cookie: "citygo=" + f.ownerToken,
        [CONTRACT_VERSION_HEADER]: "1",
      },
      payload:
        method === "POST"
          ? f.create()
          : method === "PATCH"
            ? {
                expectedRevision: 1,
                title: "Step",
                details: "",
                status: "pending",
              }
            : { expectedRevision: 1 },
    });
    assert.equal(reply.statusCode, 403, reply.body);
  }
  const cookie = await f.call(
    "PATCH",
    path,
    {
      expectedRevision: 1,
      title: "Cookie step",
      details: "",
      status: "pending",
    },
    f.ownerToken,
    true,
  );
  assert.equal(cookie.statusCode, 200, cookie.body);
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.owner,
  ]);
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
    const reply = await f.call(
      method,
      method === "GET" || method === "POST" ? "/v1/personal-plan" : path,
      method === "GET"
        ? undefined
        : method === "POST"
          ? f.create()
          : {
              expectedRevision: 2,
              title: "Step",
              details: "",
              status: "pending",
            },
    );
    assert.equal(reply.statusCode, 403, reply.body);
  }
  await f.db.query(
    "update users set must_change_password=false,status='blocked' where id=$1",
    [f.owner],
  );
  assert.equal((await f.call("GET", "/v1/personal-plan")).statusCode, 401);
  await f.db.query("update users set status='active' where id=$1", [f.owner]);
  await f.db.query("delete from sessions where user_id=$1", [f.owner]);
  assert.equal((await f.call("GET", "/v1/personal-plan")).statusCode, 401);
  assert.equal(f.modelCalls(), 0);
});

test("personal plan corrupt stored output is a bounded generic server failure, not user validation", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.call("POST", "/v1/personal-plan", f.create())).statusCode,
    200,
  );
  f.corrupt();
  const reply = await f.call("GET", "/v1/personal-plan");
  assert.equal(reply.statusCode, 500, reply.body);
  assert.equal(reply.json().code, "INTERNAL_ERROR");
  assert.equal(reply.json().fields, undefined);
  assert.doesNotMatch(
    reply.body,
    /Zod|password|synthetic-hash|personal_plan_items/,
  );
  assert.equal(f.modelCalls(), 0);
});

test("HTTP manual plan steps need an active owner, preserve null source and never call a model or alter money", async (t) => {
  const f = await fixture(t);
  const before = await f.legacySnapshot();
  const command = { ...f.create(), sourceMessageId: null };
  assert.equal(
    (await f.call("POST", "/v1/personal-plan", command, "")).statusCode,
    401,
  );
  const first = await f.call("POST", "/v1/personal-plan", command);
  assert.equal(first.statusCode, 200, first.body);
  const result = personalPlanItemResultSchema.parse(first.json());
  assert.equal(result.item.source, null);
  assert.deepEqual(
    (await f.call("POST", "/v1/personal-plan", command)).json(),
    result,
  );
  const foreign = await f.call(
    "PATCH",
    "/v1/personal-plan/" + result.item.id,
    {
      expectedRevision: 1,
      title: "Foreign",
      details: "",
      status: "pending",
    },
    f.otherToken,
  );
  assert.equal(foreign.statusCode, 404);
  assert.equal(
    (
      await f.call("POST", "/v1/personal-plan", {
        ...command,
        sourceMessageId: f.sources.assistant,
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(
    personalPlanPageSchema.parse(
      (await f.call("GET", "/v1/personal-plan")).json(),
    ).items,
    [result.item],
  );
  assert.deepEqual(await f.legacySnapshot(), before);
  assert.equal(f.modelCalls(), 0);
});

test("HTTP personal plan search uses literal title/details matching and current owner without AI or balance changes", async (t) => {
  const f = await fixture(t);
  for (const title of ["Район 100%_\\", "Район обычный"]) {
    const result = await f.call("POST", "/v1/personal-plan", {
      ...f.create(),
      title,
      details: "Детали дороги",
    });
    assert.equal(result.statusCode, 200, result.body);
  }
  const before = await f.legacySnapshot();
  for (const search of ["%", "_", "\\", "район 100%_\\"]) {
    const url =
      "/v1/personal-plan?" + new URLSearchParams({ search, status: "pending" });
    const response = await f.call("GET", url);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().items.length, 1);
    assert.equal(response.json().items[0].title, "Район 100%_\\");
    assert.deepEqual(
      (await f.call("GET", url, undefined, f.otherToken)).json().items,
      [],
    );
  }
  assert.equal(
    (
      await f.call(
        "GET",
        "/v1/personal-plan?search=" + encodeURIComponent("детали дороги"),
      )
    ).json().items.length,
    2,
  );
  for (const query of [
    "search=",
    "search=a&search=b",
    "search=" + "a".repeat(161),
    "search=a%00b",
  ])
    assert.equal(
      (await f.call("GET", "/v1/personal-plan?" + query)).statusCode,
      400,
    );
  assert.equal(
    (await f.call("GET", "/v1/personal-plan?search=район", undefined, ""))
      .statusCode,
    401,
  );
  assert.deepEqual(await f.legacySnapshot(), before);
  assert.equal(f.modelCalls(), 0);
});

test("HTTP full plan export returns the complete private snapshot and rejects query, foreign sessions and password gates without provider calls", async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 23; n++)
    assert.equal(
      (await f.call("POST", "/v1/personal-plan", f.create())).statusCode,
      200,
    );
  const before = await f.legacySnapshot();
  const response = await f.call("GET", "/v1/personal-plan/export");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.json().userId, f.owner);
  assert.equal(response.json().items.length, 23);
  assert.equal(
    (
      await f.call("GET", "/v1/personal-plan/export", undefined, f.otherToken)
    ).json().items.length,
    0,
  );
  assert.equal(
    (await f.call("GET", "/v1/personal-plan/export?before=1")).statusCode,
    400,
  );
  assert.equal(
    (await f.call("GET", "/v1/personal-plan/export", undefined, "")).statusCode,
    401,
  );
  assert.deepEqual(await f.legacySnapshot(), before);
  assert.equal(f.modelCalls(), 0);
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.owner,
  ]);
  assert.equal(
    (await f.call("GET", "/v1/personal-plan/export")).statusCode,
    403,
  );
});
