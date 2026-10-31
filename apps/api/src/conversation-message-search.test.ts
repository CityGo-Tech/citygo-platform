import { registerSyntheticConsentingUser } from "./test-service-consents.js";
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
  conversationMessageSearchPageSchema,
} from "@citygo/contracts";
import type { StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { serializeRequestLog } from "./customer-observability.js";

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
  const owner = await registerSyntheticConsentingUser(
    db,
    "history-owner@example.test",
    "synthetic-hash",
    app,
  );
  const other = await registerSyntheticConsentingUser(
    db,
    "history-other@example.test",
    "synthetic-hash",
    app,
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

test("message search HTTP authorizes each bounded literal page and preserves all data without provider calls", async (t) => {
  const f = await fixture(t),
    thread = await f.thread(f.owner, "closed");
  for (let i = 0; i < 22; i++)
    await f.message(
      thread,
      String(9007199254740993n + BigInt(i)),
      i % 2 ? "assistant" : "user",
    );
  const foreign = await f.thread(f.other);
  await f.message(foreign, "9007199254742000");
  const query = "Сохранённое сообщение";
  const path =
    "/v1/conversations/" +
    thread +
    "/messages/search?search=" +
    encodeURIComponent(query);
  f.statements.length = 0;
  const before = await f.snapshot();
  const first = await f.call(path, f.ownerToken, true);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["cache-control"], "no-store");
  const page = conversationMessageSearchPageSchema.parse(first.json());
  assert.equal(page.matches.length, 20);
  assert.equal(page.matches[0]!.messageId, "9007199254741014");
  const second = await f.call(path + "&before=" + page.nextCursor);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().matches.length, 2);
  assert.equal(second.json().nextCursor, null);
  assert.equal((await f.call(path, f.otherToken)).statusCode, 404);
  assert.equal((await f.call(path, "")).statusCode, 401);
  assert.equal(
    (await f.call(path + "&before=9007199254742000")).statusCode,
    404,
  );
  for (const suffix of [
    "&limit=1000",
    "&before=01",
    "&before=9223372036854775808",
  ])
    assert.equal((await f.call(path + suffix)).statusCode, 400);
  for (const search of ["", " ", "x".repeat(161), "private\u0000term"])
    assert.equal(
      (
        await f.call(
          "/v1/conversations/" +
            thread +
            "/messages/search?search=" +
            encodeURIComponent(search),
        )
      ).statusCode,
      400,
    );
  await f.readOnly(before);
  await f.db.query("delete from sessions where user_id=$1", [f.owner]);
  assert.equal((await f.call(path)).statusCode, 401);
});
test("message search request logging strips private literal terms and cursors", () => {
  const log = serializeRequestLog({
    method: "GET",
    url: "/v1/conversations/20/messages/search?search=PRIVATE%40example.test&before=9007199254740993",
    hostname: "example.test",
    ip: "127.0.0.1",
  });
  assert.equal(log.url, "/v1/conversations/20/messages/search");
  assert(!JSON.stringify(log).includes("PRIVATE"));
  assert(!JSON.stringify(log).includes("9007199254740993"));
});
