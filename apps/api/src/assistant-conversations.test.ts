import { registerSyntheticConsentingUser } from "./test-service-consents.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate, type Database } from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  agentKeys,
  CONTRACT_VERSION_HEADER,
  conversationDetailResponseSchema,
  conversationListResponseSchema,
  dashboardResponseSchema,
  startResponseSchema,
} from "@citygo/contracts";
import { instructions } from "@citygo/agents";
import type { ModelMessage, StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { seedTestBudget } from "./test-budget.js";

async function fixture(t: TestContext) {
  // No inherited environment, external database, provider or payment adapter.
  const db = await connectDatabase("pglite://:memory:");
  const cleanup: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  t.after(async () => {
    try {
      await cleanup.app?.close();
    } finally {
      await db.close();
    }
  });
  await migrate(db);
  const calls: { instructions: string; messages: ModelMessage[] }[] = [];
  const provider: StreamingProvider = {
    name: "openai",
    model: "synthetic/conversations",
    async *stream(prompt, messages) {
      calls.push({ instructions: prompt, messages: structuredClone(messages) });
      yield {
        type: "delta",
        text: "Синтетический ответ выбранного помощника.",
      };
      yield { type: "complete", model: "synthetic/conversations" };
    },
  };
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    LLM_PROVIDER: "openai",
    OPENAI_MODEL: provider.model,
  });
  await seedTestBudget(db, config, { openai: provider });
  const app = await buildApp({ db, provider, config, testing: true });
  cleanup.app = app;
  const currentApp = app;
  const owner = await registerSyntheticConsentingUser(
      db,
      "owner@example.test",
      "synthetic",
      app,
    ),
    other = await registerSyntheticConsentingUser(
      db,
      "other@example.test",
      "synthetic",
      app,
    );
  await db.query("update users set role='super_admin' where id=$1", [other]);
  const tokens = [randomUUID(), randomUUID()];
  for (const [index, id] of [owner, other].entries())
    await db.query(
      "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
      [tokenHash(tokens[index]!), id],
    );
  const call = (
    method: "GET" | "POST",
    path: string,
    token?: string,
    payload?: object,
  ) =>
    currentApp.inject({
      method,
      url: path,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        "x-citygo-client": "native",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      ...(payload !== undefined ? { payload } : {}),
    });
  const start = async (agentKey?: (typeof agentKeys)[number]) => {
    const reply = await call(
      "POST",
      "/v1/conversations/start",
      tokens[0],
      agentKey === undefined ? {} : { agentKey },
    );
    assert.equal(reply.statusCode, 200, reply.body);
    return startResponseSchema.parse(reply.json());
  };
  const consent = async () => {
    const board = await call("GET", "/v1/dashboard", tokens[0]);
    assert.equal(board.statusCode, 200, board.body);
    const policy = dashboardResponseSchema.parse(board.json()).aiAccess.policy;
    assert.ok(policy);
    const reply = await call("POST", "/v1/ai/consent", tokens[0], {
      action: "granted",
      policyId: policy.id,
    });
    assert.equal(reply.statusCode, 200, reply.body);
    return policy.id;
  };
  return { db, calls, owner, other, tokens, call, start, consent };
}

async function costs(db: Database) {
  const result: Record<string, unknown[]> = {};
  for (const table of [
    "ai_budget",
    "ai_budget_daily",
    "ai_model_attempts",
    "ai_credit_accounts",
    "ai_credit_entries",
    "ai_credit_charges",
    "credit_source_lots",
    "credit_hold_allocations",
    "credit_charge_debts",
    "credit_debt_repayments",
    "payment_topup_orders",
    "payment_refunds",
  ])
    result[table] = (await db.query("select * from " + table)).rows;
  return result;
}

test("conversation HTTP: five assistants, owner-only history, numeric pagination and zero-cost opening", async (t) => {
  const f = await fixture(t);
  const before = await costs(f.db);
  for (const path of ["/v1/conversations", "/v1/conversations/1"])
    assert.equal((await f.call("GET", path)).statusCode, 401);
  assert.equal(
    (await f.call("POST", "/v1/conversations/start", undefined, {})).statusCode,
    401,
  );
  const ids = new Set<string>();
  for (const agentKey of agentKeys) {
    const thread = await f.start(agentKey);
    assert.equal(thread.agentKey, agentKey);
    assert.ok(!ids.has(thread.id));
    ids.add(thread.id);
    const detail = await f.call(
      "GET",
      "/v1/conversations/" + thread.id,
      f.tokens[0],
    );
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.headers["cache-control"], "no-store");
    assert.deepEqual(conversationDetailResponseSchema.parse(detail.json()), {
      userId: f.owner,
      thread: {
        id: thread.id,
        agentKey,
        assistantKey: agentKey,
        closed: false,
        messages: [],
      },
    });
    assert.equal(
      (await f.call("GET", "/v1/conversations/" + thread.id, f.tokens[1]))
        .statusCode,
      404,
      "super admin does not override conversation ownership",
    );
  }
  // Include history beyond one page and beyond JS's exact Number range.
  await f.db.query(
    "insert into agent_threads(id,user_id,agent_key,status) overriding system value values(9007199254740993,$1,'support','closed')",
    [f.owner],
  );
  await f.db.query(
    `insert into messages(id,thread_id,role,content,metadata) overriding system value values
     (9007199254740993,9007199254740993,'user','Мой сохранённый вопрос',
      '{"agentKey":"support","status":"complete","citygoFavorite":true}'),
     (9007199254740994,9007199254740993,'assistant',$1,
      '{"agentKey":"support","status":"interrupted","citygoFavorite":true}')`,
    ["Я".repeat(300)],
  );
  const oldDetail = await f.call(
    "GET",
    "/v1/conversations/9007199254740993",
    f.tokens[0],
  );
  assert.equal(oldDetail.statusCode, 200, oldDetail.body);
  assert.equal(oldDetail.json().userId, f.owner);
  const historical = conversationDetailResponseSchema.parse(
    oldDetail.json(),
  ).thread;
  assert.equal(historical.closed, true);
  assert.equal(historical.assistantKey, null);
  assert.deepEqual(
    historical.messages.map((message) => ({
      id: message.id,
      role: message.role,
      favorite: message.favorite,
    })),
    [
      { id: "9007199254740993", role: "user", favorite: true },
      { id: "9007199254740994", role: "assistant", favorite: true },
    ],
  );
  assert.equal(historical.messages[1]!.content.length, 300);
  for (let i = 0; i < 17; i++)
    await f.db.query(
      "insert into agent_threads(user_id,agent_key,status) values($1,'housing','closed')",
      [f.owner],
    );
  const firstReply = await f.call("GET", "/v1/conversations", f.tokens[0]);
  assert.equal(firstReply.statusCode, 200, firstReply.body);
  const first = conversationListResponseSchema.parse(firstReply.json());
  assert.equal(first.userId, f.owner);
  assert.equal(first.conversations.length, 20);
  assert.equal(first.conversations[0]!.id, "9007199254740993");
  assert.equal(first.conversations[0]!.preview, "Я".repeat(240));
  assert.equal(first.nextCursor, first.conversations.at(-1)!.id);
  for (let i = 1; i < first.conversations.length; i++)
    assert.ok(
      BigInt(first.conversations[i - 1]!.id) >
        BigInt(first.conversations[i]!.id),
    );
  const nextReply = await f.call(
    "GET",
    "/v1/conversations?before=" + first.nextCursor,
    f.tokens[0],
  );
  assert.equal(nextReply.statusCode, 200, nextReply.body);
  const next = conversationListResponseSchema.parse(nextReply.json());
  assert.equal(next.userId, f.owner);
  assert.equal(next.conversations.length, 3);
  assert.equal(next.nextCursor, null);
  assert.ok(
    next.conversations.every(
      (thread) => !first.conversations.some((old) => old.id === thread.id),
    ),
  );
  const other = await f.call("GET", "/v1/conversations", f.tokens[1]);
  assert.deepEqual(conversationListResponseSchema.parse(other.json()), {
    userId: f.other,
    conversations: [],
    nextCursor: null,
  });
  assert.equal(
    (await f.call("GET", "/v1/conversations/9223372036854775807", f.tokens[0]))
      .statusCode,
    404,
  );
  assert.deepEqual(await costs(f.db), before);
  assert.equal(f.calls.length, 0);
});

test("conversation HTTP rejects forged assistants, owner hints and malformed cursors without side effects", async (t) => {
  const f = await fixture(t);
  const before = await costs(f.db);
  for (const payload of [
    { agentKey: "bubble" },
    { agentKey: null },
    { agentKey: ["housing"] },
    { agentKey: "toString" },
    { agentKey: "support", userId: f.other },
  ])
    assert.equal(
      (await f.call("POST", "/v1/conversations/start", f.tokens[0], payload))
        .statusCode,
      400,
    );
  for (const query of [
    "before=0",
    "before=-1",
    "before=01",
    "before=1.5",
    "before=9223372036854775808",
    "before=1&before=2",
    "userId=" + f.other,
  ])
    assert.equal(
      (await f.call("GET", "/v1/conversations?" + query, f.tokens[0]))
        .statusCode,
      400,
    );
  for (const id of ["0", "01", "-1", "x", "9223372036854775808"])
    assert.equal(
      (await f.call("GET", "/v1/conversations/" + id, f.tokens[0])).statusCode,
      400,
    );
  assert.deepEqual((await f.db.query("select id from agent_threads")).rows, []);
  assert.deepEqual(await costs(f.db), before);
  assert.equal(f.calls.length, 0);
});

test("explicit assistant routing stays pinned through keywords; legacy routing and human handoff remain", async (t) => {
  const f = await fixture(t);
  const policyId = await f.consent();
  const legacy = await f.start();
  const emptyBody = await f.call(
    "POST",
    "/v1/conversations/start",
    f.tokens[0],
  );
  assert.equal(emptyBody.statusCode, 200, emptyBody.body);
  assert.deepEqual(
    emptyBody.json(),
    legacy,
    "the old empty-body start remains idempotent",
  );
  const send = async (id: string, text: string) => {
    const reply = await f.call(
      "POST",
      "/v1/threads/" + id + "/messages",
      f.tokens[0],
      { text, policyId, requestId: randomUUID() },
    );
    assert.equal(reply.statusCode, 200, reply.body);
    assert.match(reply.body, /"type":"done"/);
    assert.doesNotMatch(reply.body, /"type":"error"/);
    return reply;
  };
  await send(legacy.id, "Помоги составить резюме");
  assert.equal(f.calls.at(-1)!.instructions, instructions("resume-builder"));
  const questions = {
    housing: "Помоги составить резюме",
    "job-search": "Как арендовать квартиру?",
    "resume-builder": "Как искать работу?",
    "digital-mentor": "Как арендовать жилье?",
    support: "Как составить резюме?",
  };
  for (const agentKey of agentKeys) {
    const thread = await f.start(agentKey);
    const reply = await send(thread.id, questions[agentKey]);
    assert.doesNotMatch(reply.body, /"type":"handoff"/);
    assert.equal(f.calls.at(-1)!.instructions, instructions(agentKey));
    const detail = await f.call(
      "GET",
      "/v1/conversations/" + thread.id,
      f.tokens[0],
    );
    const data = conversationDetailResponseSchema.parse(detail.json()).thread;
    assert.equal(data.agentKey, agentKey);
    assert.equal(data.assistantKey, agentKey);
    assert.deepEqual(
      data.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(data.messages[0]!.content, questions[agentKey]);
  }
  const housing = await f.start("housing");
  const beforeHuman = f.calls.length;
  const human = await send(housing.id, "Нужен живой риелтор");
  assert.match(human.body, /"type":"handoff"/);
  assert.equal(
    f.calls.length,
    beforeHuman,
    "a human request never invokes the synthetic model",
  );
  assert.deepEqual(
    (
      await f.db.query<{ human: boolean }>(
        "select requires_human as human from agent_handoffs where thread_id=$1",
        [housing.id],
      )
    ).rows,
    [{ human: true }],
  );
});

test("conversation HTTP applies owner-bound search and filters and rejects forged filter input", async (t) => {
  const f = await fixture(t);
  for (const [owner, agent, status, text] of [
    [f.owner, "housing", "closed", "MATCH & literal"],
    [f.owner, "support", "closed", "MATCH"],
    [f.other, "housing", "closed", "MATCH & literal"],
  ]) {
    const id = (
      await f.db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key,conversation_agent_key,status) values($1,$2,$2,$3) returning id::text",
        [owner, agent, status],
      )
    ).rows[0]!.id;
    await f.db.query(
      "insert into messages(thread_id,role,content) values($1,'user',$2)",
      [id, text],
    );
  }
  const reply = await f.call(
    "GET",
    "/v1/conversations?search=MATCH%20%26&assistantKey=housing&status=closed",
    f.tokens[0],
  );
  assert.equal(reply.statusCode, 200, reply.body);
  const page = conversationListResponseSchema.parse(reply.json());
  assert.equal(page.userId, f.owner);
  assert.equal(page.conversations.length, 1);
  assert.equal(page.conversations[0]!.preview, "MATCH & literal");
  for (const query of [
    "search=" + "x".repeat(161),
    "status=open",
    "assistantKey=bubble",
    "search=x&search=y",
    "userId=" + f.other,
  ])
    assert.equal(
      (await f.call("GET", "/v1/conversations?" + query, f.tokens[0]))
        .statusCode,
      400,
    );
  assert.equal(f.calls.length, 0);
});
