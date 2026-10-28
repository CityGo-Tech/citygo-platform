import { syntheticConsentsFor } from "./test-service-consents.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  AiCreditLedger,
  connectDatabase,
  migrate,
  type Database,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { RouterAIProvider } from "@citygo/llm";
import type { AiCredit, Dashboard } from "@citygo/contracts";
import { buildApp } from "./app.js";
import { seedTestBudget } from "./test-budget.js";

async function fixture(t: TestContext) {
  // Never inherit a database URL, provider credentials, runtime profile or fetch.
  // These are synthetic in-memory balances and an injected in-process transport.
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
  const state = {
    posts: 0,
    gets: 0,
    costDown: true,
    contexts: [] as string[],
    beforeCostRead: undefined as (() => void) | undefined,
    disconnectResponse: undefined as (() => void) | undefined,
    messageError: undefined as (() => void) | undefined,
  };
  const references = new Map<string, string>();
  const provider = new RouterAIProvider("synthetic-only-key", "test/model", {
    upstream: "test-upstream",
    fetch: async (url, init) => {
      if (init?.method === "GET") {
        state.gets++;
        state.beforeCostRead?.();
        if (state.costDown)
          return new Response("synthetic unavailable", { status: 503 });
        const id = new URL(String(url)).searchParams.get("id")!;
        const receipt = {
          id,
          session_id: references.get(id),
          model: "test/model",
          provider: "test-upstream",
          api: "chat/completions",
          source: "api",
          has_web_search: false,
        };
        return new Response(
          `{"data":${JSON.stringify(receipt).replace(/}$/, ',"total_cost":0.2169533830464}')}}`,
          { headers: { "content-type": "application/json" } },
        );
      }
      assert.equal(url, "https://routerai.ru/api/v1/chat/completions");
      assert.equal(init?.method, "POST");
      state.posts++;
      const payload = JSON.parse(String(init?.body));
      state.contexts.push(JSON.stringify(payload.messages));
      const id = "gen-" + randomUUID();
      references.set(id, payload.session_id);
      return new Response(
        [
          {
            id,
            model: "test/model",
            choices: [
              {
                index: 0,
                delta: { content: "СИНТЕТИЧЕСКИЙ_ОТВЕТ_" + state.posts },
                finish_reason: null,
              },
            ],
          },
          {
            id,
            model: "test/model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
          "[DONE]",
        ]
          .map(
            (event) =>
              "data: " +
              (typeof event === "string" ? event : JSON.stringify(event)) +
              "\n\n",
          )
          .join(""),
        {
          headers: {
            "content-type": "text/event-stream",
            "x-generation-id": id,
          },
        },
      );
    },
  });
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    LLM_PROVIDER: "routerai",
    ROUTERAI_MODEL: provider.model,
    ROUTERAI_UPSTREAM: "test-upstream",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
  });
  await seedTestBudget(db, config, { routerai: provider });
  await db.query(
    "update ai_budget set daily_limit_micros=100000000,total_limit_micros=100000000,rules=jsonb_set(rules,'{0,attemptCeilingMicros}','6000000'::jsonb)",
  );
  let app = await buildApp({ db, config, provider, testing: true });
  cleanup.app = app;
  const observeTestResponse = () => {
    app.addHook("onRequest", (request, reply, done) => {
      if (/^\/v1\/threads\/\d+\/messages$/.test(request.url))
        state.disconnectResponse = () => reply.raw.emit("close");
      done();
    });
    app.addHook("onError", (request, _reply, _error, done) => {
      if (/^\/v1\/threads\/\d+\/messages$/.test(request.url))
        state.messageError?.();
      done();
    });
  };
  observeTestResponse();
  const call = (
    method: "GET" | "POST",
    path: string,
    token = "",
    payload?: object,
  ) =>
    app!.inject({
      method,
      url: path,
      headers: { origin: "http://localhost:3000", cookie: "citygo=" + token },
      ...(payload ? { payload } : {}),
    });
  const register = async () => {
    const response = await call("POST", "/v1/auth/register", "", {
      consents: await syntheticConsentsFor(app),
      email: randomUUID() + "@example.test",
      password: "123456",
    });
    assert.equal(response.statusCode, 200, response.body);
    const token = response.cookies[0]!.value;
    const board = (await call("GET", "/v1/dashboard", token)).json<Dashboard>();
    return { id: board.user.id, token, policyId: board.aiAccess.policy!.id };
  };
  const admin = await register(),
    user = await register();
  await db.query("update users set role='admin' where id=$1", [admin.id]);
  const ledger = new AiCreditLedger(
    db,
    "routerai_citygo_10x",
    false,
    "fixed5_overdraft",
  );
  await ledger.topUpConfirmed(user.id, randomUUID(), {
    providerPaymentId: "synthetic-payment-" + randomUUID(),
    paidKopeks: 10000,
    merchantId: "synthetic-shop",
    test: false,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  const consent = await call("POST", "/v1/ai/consent", user.token, {
    action: "granted",
    policyId: user.policyId,
  });
  assert.equal(consent.statusCode, 200, consent.body);
  const start = async (agentKey?: string) => {
    const response = await call(
      "POST",
      "/v1/conversations/start",
      user.token,
      agentKey ? { agentKey } : {},
    );
    assert.equal(response.statusCode, 200, response.body);
    return response.json().id as string;
  };
  const send = (thread: string, text: string, requestId = randomUUID()) =>
    call("POST", `/v1/threads/${thread}/messages`, user.token, {
      text,
      requestId,
      policyId: user.policyId,
      creditReservationMode: "fixed5_overdraft",
    });
  const balance = async () =>
    (await call("GET", "/v1/ai/credit", user.token)).json<AiCredit>();
  const recreate = async () => {
    await app.close();
    app = await buildApp({ db, config, provider, testing: true });
    cleanup.app = app;
    observeTestResponse();
  };
  return { db, state, call, user, admin, start, send, balance, recreate };
}

async function monetarySnapshot(db: Database) {
  const result: Record<string, unknown[]> = {};
  for (const table of [
    "ai_budget",
    "ai_budget_daily",
    "ai_model_attempt_daily",
    "ai_user_model_attempt_daily",
    "ai_model_attempts",
    "ai_credit_accounts",
    "ai_credit_entries",
    "ai_credit_charges",
    "credit_source_lots",
    "credit_hold_allocations",
    "credit_charge_debts",
    "credit_debt_repayments",
  ])
    result[table] = (
      await db.query(
        `select row_to_json(x) as value from ${table} x order by row_to_json(x)::text`,
      )
    ).rows;
  return result;
}

test("next explicit question recovers a completed owned charge after restart before accepting history; invalid targets and repeated IDs never fetch cost", async (t) => {
  const f = await fixture(t);
  const a = await f.start("housing"),
    b = await f.start("job-search");
  const firstId = randomUUID();
  assert.match(
    (await f.send(a, "Первый вопрос", firstId)).body,
    /"type":"done"/,
  );
  const snapshot = async () => {
    const result: Record<string, unknown[]> = {};
    for (const table of [
      "messages",
      "chat_requests",
      "agent_threads",
      "ai_usage_daily",
      "ai_user_usage_daily",
    ])
      result[table] = (
        await f.db.query(
          `select to_jsonb(t)as value from ${table} t order by to_jsonb(t)::text`,
        )
      ).rows;
    return result;
  };
  const before = await snapshot();
  const money = await monetarySnapshot(f.db);
  const retryId = randomUUID();
  const failed = await f.send(b, "Второй вопрос", retryId);
  assert.equal(failed.statusCode, 409);
  assert.match(failed.body, /AI_CREDIT_UNAVAILABLE/);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await monetarySnapshot(f.db), money);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 2);
  const foreign = await f.call(
    "POST",
    "/v1/conversations/start",
    f.admin.token,
    {},
  );
  assert.equal(foreign.statusCode, 200);
  const reads = f.state.gets;
  assert.equal(
    (await f.send(foreign.json().id, "Чужой разговор")).statusCode,
    404,
  );
  assert.equal((await f.send(a, "Повтор", firstId)).statusCode, 409);
  assert.equal(
    (
      await f.call("POST", `/v1/threads/${b}/messages`, f.user.token, {
        text: "Вопрос",
        requestId: randomUUID(),
        policyId: "0".repeat(64),
        creditReservationMode: "fixed5_overdraft",
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.call("POST", `/v1/threads/${b}/messages`, "", {
        text: "Вопрос",
        requestId: randomUUID(),
        policyId: f.user.policyId,
        creditReservationMode: "fixed5_overdraft",
      })
    ).statusCode,
    401,
  );
  await f.db.query("update users set status='blocked'where id=$1", [f.user.id]);
  assert.equal((await f.send(b, "Недоступный аккаунт")).statusCode, 401);
  await f.db.query("update users set status='active'where id=$1", [f.user.id]);
  assert.equal(f.state.gets, reads);
  assert.equal(f.state.posts, 1);
  await f.recreate();
  f.state.costDown = false;
  assert.match(
    (await f.send(b, "Второй вопрос", retryId)).body,
    /"type":"done"/,
  );
  assert.equal(f.state.posts, 2);
  assert.equal(f.state.gets, 4);
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal((await f.balance()).spentMicros, 4_339_066);
  const after = await snapshot();
  assert.equal((await f.send(b, "Повтор второго", retryId)).statusCode, 409);
  assert.deepEqual(await snapshot(), after);
  assert.equal(f.state.posts, 2);
  assert.equal(f.state.gets, 4);
});

test("a pending cost never prevents an explicit human help path or causes a model retry", async (t) => {
  const f = await fixture(t);
  const a = await f.start("housing"),
    b = await f.start("job-search");
  assert.match((await f.send(a, "Вопрос о переезде")).body, /"type":"done"/);
  const before = await monetarySnapshot(f.db);
  const gets = f.state.gets;
  assert.match((await f.send(b, "Нужен живой человек")).body, /"type":"done"/);
  assert.equal(f.state.gets, gets);
  assert.equal(f.state.posts, 1);
  assert.deepEqual(await monetarySnapshot(f.db), before);
});

test("client disconnect during explicit completed-charge GET never admits history or dispatches another model", async (t) => {
  const f = await fixture(t);
  const thread = await f.start("housing");
  assert.match((await f.send(thread, "Первый вопрос")).body, /"type":"done"/);
  const before = await monetarySnapshot(f.db);
  const history = async () =>
    (
      await f.db.query(`select
        (select jsonb_agg(to_jsonb(t) order by id) from messages t) as messages,
        (select jsonb_agg(to_jsonb(t) order by request_id) from chat_requests t) as requests,
        (select jsonb_agg(to_jsonb(t) order by id) from agent_threads t) as threads,
        (select jsonb_agg(to_jsonb(t)) from ai_usage_daily t) as quota,
        (select jsonb_agg(to_jsonb(t)) from ai_user_usage_daily t) as user_quota`)
    ).rows;
  const originalHistory = await history();
  const handlerRejected = new Promise<void>((resolve) => {
    f.state.messageError = resolve;
  });
  f.state.costDown = false;
  f.state.beforeCostRead = () => {
    assert.ok(f.state.disconnectResponse);
    f.state.disconnectResponse();
  };
  await assert.rejects(f.send(thread, "Отменённый новый вопрос"), {
    code: "LIGHT_ECONNRESET",
  });
  await handlerRejected;
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 2);
  assert.deepEqual(await monetarySnapshot(f.db), before);
  assert.deepEqual(await history(), originalHistory);
});

test("assistant selection is free; an unresolved fixed5 charge in A blocks paid B user-wide and their model contexts never mix", async (t) => {
  const f = await fixture(t);
  const before = await monetarySnapshot(f.db);
  const legacy = await f.start(),
    housing = await f.start("housing"),
    jobs = await f.start("job-search");
  assert.equal(new Set([legacy, housing, jobs]).size, 3);
  const list = await f.call("GET", "/v1/conversations", f.user.token);
  assert.equal(list.statusCode, 200, list.body);
  for (const id of [legacy, housing, jobs])
    assert.equal(
      (await f.call("GET", `/v1/conversations/${id}`, f.user.token)).statusCode,
      200,
    );
  assert.deepEqual(await monetarySnapshot(f.db), before);
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);

  const questionA = "МАРКЕР_ЖИЛЬЯ_A: как проверить квартиру?";
  assert.match((await f.send(housing, questionA)).body, /"type":"done"/);
  assert.equal(f.state.posts, 1);
  const pending = (await f.balance()).pending![0]!;
  assert.equal(pending.responseComplete, true);
  assert.equal((await f.balance()).heldMicros, 5_000_000);
  const reserved = await monetarySnapshot(f.db);

  const blockedRequest = randomUUID();
  const blocked = await f.send(
    jobs,
    "МАРКЕР_РАБОТЫ_B: первая попытка",
    blockedRequest,
  );
  assert.match(blocked.body, /AI_CREDIT_UNAVAILABLE/);
  assert.equal(
    f.state.posts,
    1,
    "switching assistants cannot bypass a user-wide pending charge",
  );
  assert.deepEqual(
    await monetarySnapshot(f.db),
    reserved,
    "refused admission rolls back budget, attempt and money together",
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int as n from ai_model_attempts where thread_id=$1 and request_id=$2",
        [jobs, blockedRequest],
      )
    ).rows[0]!.n,
    0,
  );
  const again = await f.call("GET", "/v1/conversations", f.user.token);
  assert.equal(again.statusCode, 200);
  assert.deepEqual(
    await monetarySnapshot(f.db),
    reserved,
    "listing never reconciles or sends a model request",
  );

  f.state.costDown = false;
  const reconcile = await f.call(
    "POST",
    "/v1/admin/ai/credit/reconcile",
    f.admin.token,
    { userId: f.user.id, holdId: pending.holdId, confirmReconcile: true },
  );
  assert.equal(reconcile.statusCode, 200, reconcile.body);
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal((await f.balance()).spentMicros, 2_169_533);
  assert.equal((await f.balance()).availableMicros, 97_830_467);
  const questionB = "МАРКЕР_РАБОТЫ_B: как составить резюме?";
  assert.match((await f.send(jobs, questionB)).body, /"type":"done"/);
  assert.equal(f.state.posts, 2);
  assert.ok(f.state.contexts[0]!.includes(questionA));
  assert.ok(!f.state.contexts[1]!.includes(questionA));
  assert.ok(!f.state.contexts[1]!.includes("СИНТЕТИЧЕСКИЙ_ОТВЕТ_1"));
  assert.ok(
    !f.state.contexts[1]!.includes("МАРКЕР_РАБОТЫ_B: первая попытка"),
    "an interrupted admission never becomes completed model context",
  );
  const sent = JSON.parse(f.state.contexts[1]!) as {
    role: string;
    content: string;
  }[];
  assert.deepEqual(sent.at(-1), { role: "user", content: questionB });
  const readA = await f.call(
    "GET",
    `/v1/conversations/${housing}`,
    f.user.token,
  );
  const readB = await f.call("GET", `/v1/conversations/${jobs}`, f.user.token);
  assert.ok(!readA.body.includes(questionB));
  assert.ok(!readB.body.includes(questionA));
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal((await f.balance()).spentMicros, 4_339_066);
  assert.equal((await f.balance()).availableMicros, 95_660_934);
});
