import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  type Sql,
  type Database,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  conversationMessagesResponseSchema,
  conversationDetailResponseSchema,
} from "@citygo/contracts";
import type { StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";

async function fixture(t: TestContext) {
  // Explicit synthetic memory DB/config only: no runtime env, service keys,
  // provider network, actual payments or email/SMS delivery adapters.
  const db = await connectDatabase("pglite://:memory:");
  const statements: string[] = [];
  function observe(sql: Sql): Sql {
    return {
      exec: async (text) => {
        statements.push(text);
        await sql.exec(text);
      },
      query: (text, values) => {
        statements.push(text);
        return sql.query(text, values);
      },
    };
  }
  const observed: Database = {
    ...observe(db),
    transaction: (work) => db.transaction((tx) => work(observe(tx))),
    close: () => db.close(),
  };
  let modelCalls = 0;
  const provider: StreamingProvider = {
    name: "openai",
    model: "synthetic/history-read-only",
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
  const owner = await repo.register(
    "history-owner@example.test",
    "synthetic-hash",
  );
  const other = await repo.register(
    "history-other@example.test",
    "synthetic-hash",
  );
  await db.query("update users set role='super_admin' where id=$1", [other]);
  const ownerToken = randomUUID(),
    otherToken = randomUUID();
  await repo.createSession(owner, tokenHash(ownerToken));
  await repo.createSession(other, tokenHash(otherToken));
  const thread = async (userId = owner, status = "open") =>
    (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key,status) values($1,'support',$2) returning id::text",
        [userId, status],
      )
    ).rows[0]!.id;
  const call = (
    path: string,
    token: string = ownerToken,
    cookie = false,
    version = "1",
  ) =>
    app.inject({
      method: "GET",
      url: path,
      headers: {
        [CONTRACT_VERSION_HEADER]: version,
        ...(cookie
          ? { cookie: "citygo=" + token, origin: "http://localhost:3000" }
          : {
              "x-citygo-client": "native",
              ...(token ? { authorization: "Bearer " + token } : {}),
            }),
      },
    });
  const message = async (
    threadId: string,
    id: string,
    role = "user",
    metadata: object = { agentKey: "support", status: "complete" },
  ) =>
    db.query(
      "insert into messages(id,thread_id,role,content,metadata) overriding system value values($1,$2,$3,$4,$5::jsonb)",
      [
        id,
        threadId,
        role,
        "Сохранённое сообщение " + id,
        JSON.stringify(metadata),
      ],
    );
  const snapshot = async () => {
    const tables = (
      await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name",
      )
    ).rows;
    const state: Record<string, string[]> = {};
    for (const { table_name } of tables) {
      assert.match(table_name, /^[a-z_][a-z0-9_]*$/);
      state[table_name] = (
        await db.query<{ row: string }>(
          'select to_jsonb(t)::text as row from "' + table_name + '" t',
        )
      ).rows
        .map((row) => row.row)
        .sort();
    }
    return {
      tables: state,
      sequences: (
        await db.query(
          "select sequencename,last_value::text as last_value from pg_sequences where schemaname='public' order by sequencename",
        )
      ).rows,
    };
  };
  const readOnly = async (before: Awaited<ReturnType<typeof snapshot>>) => {
    assert.deepEqual(
      await snapshot(),
      before,
      "history reads preserve every synthetic table and sequence",
    );
    assert.equal(modelCalls, 0);
    assert.ok(
      statements.every(
        (sql) =>
          !/^\s*(insert|update|delete|truncate|alter|create|drop|grant|revoke|call|refresh)\b/i.test(
            sql,
          ),
      ),
      "read routes issue no write statements",
    );
  };
  statements.length = 0;
  return {
    db,
    app,
    owner,
    other,
    ownerToken,
    otherToken,
    thread,
    message,
    call,
    snapshot,
    readOnly,
    statements,
  };
}

test("message history HTTP pages keep numeric order, full metadata and exact int64 cursors without reads changing data", async (t) => {
  const f = await fixture(t);
  const threadId = await f.thread();
  const ids: string[] = [];
  for (let index = 0; index < 205; index++) {
    const id = String(9_007_199_254_740_993n + BigInt(index));
    ids.push(id);
    await f.message(
      threadId,
      id,
      index === 204 || index % 2 ? "assistant" : "user",
      index === 204
        ? {
            agentKey: "support",
            status: "interrupted",
            failureCode: "AI_CREDIT_EXHAUSTED",
            citygoFavorite: true,
          }
        : {
            agentKey: "support",
            status: "complete",
            citygoFavorite: index === 105,
          },
    );
  }
  await f.message(threadId, "9007199254750993", "tool");
  await f.message(threadId, "9007199254750994", "system");
  f.statements.length = 0;
  const before = await f.snapshot();
  const path = "/v1/conversations/" + threadId + "/messages";
  const latestResponse = await f.call(path);
  assert.equal(latestResponse.statusCode, 200);
  assert.equal(latestResponse.headers["cache-control"], "no-store");
  const latest = conversationMessagesResponseSchema.parse(
    latestResponse.json(),
  );
  assert.equal(latest.userId, f.owner);
  assert.equal(latest.threadId, threadId);
  assert.deepEqual(
    latest.messages.map((row) => row.id),
    ids.slice(-100),
  );
  assert.equal(latest.nextCursor, ids[105]);
  assert.equal(latest.messages[0]!.favorite, true);
  assert.equal(latest.messages.at(-1)!.status, "interrupted");
  assert.equal(latest.messages.at(-1)!.failureCode, "AI_CREDIT_EXHAUSTED");
  assert.equal(latest.messages.at(-1)!.favorite, true);
  const middleResponse = await f.call(
    path + "?before=" + latest.nextCursor,
    f.ownerToken,
    true,
  );
  assert.equal(middleResponse.statusCode, 200);
  const middle = conversationMessagesResponseSchema.parse(
    middleResponse.json(),
  );
  assert.deepEqual(
    middle.messages.map((row) => row.id),
    ids.slice(5, 105),
  );
  assert.equal(middle.nextCursor, ids[5]);
  const oldest = conversationMessagesResponseSchema.parse(
    (await f.call(path + "?before=" + middle.nextCursor)).json(),
  );
  assert.deepEqual(
    oldest.messages.map((row) => row.id),
    ids.slice(0, 5),
  );
  assert.equal(oldest.nextCursor, null);
  assert.deepEqual(
    conversationMessagesResponseSchema.parse(
      (await f.call(path + "?before=" + ids[0])).json(),
    ),
    { userId: f.owner, threadId, messages: [], nextCursor: null },
  );
  const all = [...oldest.messages, ...middle.messages, ...latest.messages];
  assert.deepEqual(
    all.map((row) => row.id),
    ids,
  );
  assert.equal(new Set(all.map((row) => row.id)).size, 205);
  // Existing initial detail is deliberately unchanged: latest100, not all history.
  const detail = conversationDetailResponseSchema.parse(
    (await f.call("/v1/conversations/" + threadId)).json(),
  );
  assert.deepEqual(
    detail.thread.messages.map((row) => row.id),
    ids.slice(-100),
  );
  await f.readOnly(before);
});

test("history owner and visible-cursor membership cannot be bypassed by super-admin, sibling, hidden or absent messages", async (t) => {
  const f = await fixture(t);
  const own = await f.thread(),
    closed = await f.thread(f.owner, "closed"),
    foreign = await f.thread(f.other);
  await f.message(own, "9007199254740993");
  await f.message(closed, "9007199254740994", "assistant");
  await f.message(foreign, "9007199254740995");
  await f.message(own, "9007199254740996", "system");
  f.statements.length = 0;
  const before = await f.snapshot();
  const path = "/v1/conversations/" + own + "/messages";
  assert.equal((await f.call(path, "")).statusCode, 401);
  assert.equal((await f.call(path, f.otherToken)).statusCode, 404);
  assert.equal(
    (await f.call("/v1/conversations/" + foreign + "/messages")).statusCode,
    404,
  );
  for (const cursor of [
    "9007199254740994",
    "9007199254740995",
    "9007199254740996",
    "9223372036854775807",
  ])
    assert.equal((await f.call(path + "?before=" + cursor)).statusCode, 404);
  const closedResponse = await f.call(
    "/v1/conversations/" + closed + "/messages",
  );
  assert.equal(closedResponse.statusCode, 200);
  assert.deepEqual(
    conversationMessagesResponseSchema
      .parse(closedResponse.json())
      .messages.map((row) => row.id),
    ["9007199254740994"],
  );
  assert.equal(
    (await f.call("/v1/conversations/9223372036854775807/messages")).statusCode,
    404,
  );
  await f.readOnly(before);
});

test("history HTTP validates exact IDs, one strict cursor and contract version, then enforces current password/session gates", async (t) => {
  const f = await fixture(t);
  const threadId = await f.thread();
  await f.message(threadId, "9007199254740993");
  f.statements.length = 0;
  const before = await f.snapshot();
  const path = "/v1/conversations/" + threadId + "/messages";
  for (const query of [
    "before=",
    "before=0",
    "before=-1",
    "before=01",
    "before=1.5",
    "before=1e3",
    "before=9223372036854775808",
    "before=1&before=2",
    "before=1%0A",
    "userId=" + f.other,
    "limit=1000",
    "offset=0",
  ])
    assert.equal((await f.call(path + "?" + query)).statusCode, 400, query);
  for (const id of ["0", "01", "-1", "x", "9223372036854775808", "1%0A"])
    assert.equal(
      (await f.call("/v1/conversations/" + id + "/messages")).statusCode,
      400,
      id,
    );
  assert.equal(
    (await f.call(path, f.ownerToken, false, "unsupported")).statusCode,
    400,
  );
  await f.readOnly(before);
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.owner,
  ]);
  f.statements.length = 0;
  const temporary = await f.snapshot();
  assert.equal((await f.call(path)).statusCode, 403);
  await f.readOnly(temporary);
  await f.db.query(
    "update users set must_change_password=false,status='blocked' where id=$1",
    [f.owner],
  );
  f.statements.length = 0;
  const blocked = await f.snapshot();
  assert.equal((await f.call(path)).statusCode, 401);
  await f.readOnly(blocked);
  await f.db.query("update users set status='active' where id=$1", [f.owner]);
  await f.db.query("delete from sessions where user_id=$1", [f.owner]);
  f.statements.length = 0;
  const revoked = await f.snapshot();
  assert.equal((await f.call(path)).statusCode, 401);
  await f.readOnly(revoked);
});
