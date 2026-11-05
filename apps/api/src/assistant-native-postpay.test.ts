import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readConfig } from "@citygo/config";
import { AiCreditLedger, connectDatabase, migrate } from "@citygo/db";
import {
  CONTRACT_VERSION_HEADER,
  conversationMessagesResponseSchema,
  dashboardResponseSchema,
  streamEventSchema,
  type AiCredit,
} from "@citygo/contracts";
import { RouterAIProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { createAssistantModes } from "./ai-modes.js";
import { syntheticConsentsFor } from "./test-service-consents.js";

const model = "openai/gpt-6.1-sol";
const answer = "Синтетический ответ с официальным источником.";
const source = {
  url: "https://www.mos.ru/transport/",
  title: "Транспорт Москвы",
};
const expectedSources = { version: "routerai_native_v1", citations: [source] };
const fullCost = "7.39182831114";

function events(body: string) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => streamEventSchema.parse(JSON.parse(line.slice(6))));
}

// The optional PostgreSQL target is exclusively an explicit disposable test DB.
// Nothing here discovers credentials, opens remote hosts or reuses application DBs.
async function openNativeTestDatabase(
  t: TestContext,
  closeApp: () => Promise<void>,
) {
  const requested = process.env.TEST_DATABASE_URL;
  let target: URL | undefined;
  if (requested !== undefined) {
    try {
      target = new URL(requested);
      const allowed =
        ["postgres:", "postgresql:"].includes(target.protocol) &&
        ((target.hostname === "127.0.0.1" &&
          ["55438", "55439"].includes(target.port) &&
          target.pathname === "/citygo_synthetic") ||
          (["localhost", "127.0.0.1"].includes(target.hostname) &&
            (target.port || "5432") === "5432" &&
            target.pathname === "/citygo_test")) &&
        target.search === "" &&
        target.hash === "";
      if (!allowed) throw Error("Rejected test target");
      if (target.hostname === "localhost") target.hostname = "127.0.0.1";
    } catch {
      // Do not reflect the URL/userinfo on malformed or disallowed input.
      throw Error(
        "Native postpay PostgreSQL requires an allowed disposable loopback database",
      );
    }
  }
  const databaseName = "native_postpay_" + randomUUID().replaceAll("-", "");
  let bootstrap: Awaited<ReturnType<typeof connectDatabase>> | undefined;
  let db: Awaited<ReturnType<typeof connectDatabase>> | undefined;
  let created = false;
  // Register before resource acquisition, including create/connect/migrate
  // failures. Every cleanup step runs even if an earlier step fails.
  t.after(async () => {
    const errors: unknown[] = [];
    try {
      await closeApp();
    } catch (error) {
      errors.push(error);
    }
    try {
      await db?.close();
    } catch (error) {
      errors.push(error);
    }
    if (created && bootstrap) {
      try {
        assert.match(databaseName, /^native_postpay_[a-f0-9]{32}$/);
        await bootstrap.query(`drop database "${databaseName}"`);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await bootstrap?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "Native postpay fixture cleanup failed");
  });
  if (target) {
    bootstrap = await connectDatabase(target.toString());
    assert.equal(
      (
        await bootstrap.query("select 1 from pg_database where datname=$1", [
          databaseName,
        ])
      ).rows.length,
      0,
    );
    await bootstrap.query(
      `create database "${databaseName}" template template0`,
    );
    created = true;
    target.pathname = "/" + databaseName;
    db = await connectDatabase(target.toString());
  } else {
    db = await connectDatabase("pglite://:memory:");
  }
  return db;
}
async function fixture(t: TestContext) {
  // Settings/data/transport are synthetic; only an explicitly guarded local
  // disposable PostgreSQL target may replace the default in-memory PGlite.
  // This is the actual native adapter; only its explicit transport is replaced.
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("Unexpected ambient network transport");
  });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const db = await openNativeTestDatabase(t, async () => {
    await app?.close();
  });
  await migrate(db);
  const state = {
    posts: 0,
    gets: 0,
    costDown: false,
    cost: fullCost,
    receiptPatch: {} as Record<string, unknown>,
    finish: "stop",
    annotations: true,
    heldAtTransport: [] as number[],
  };
  const references = new Map<string, string>();
  const getIds: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, "error");
    const held = (
      await db.query<{ held: string }>(
        "select coalesce(sum(held_micros),0)::text as held from ai_credit_accounts",
      )
    ).rows[0]!.held;
    state.heldAtTransport.push(Number(held));
    assert.equal(held, "0", "native postpay never holds customer money");
    if (init?.method === "GET") {
      const target = new URL(String(url));
      assert.equal(target.origin, "https://routerai.ru");
      assert.equal(target.pathname, "/api/v1/generation");
      const id = target.searchParams.get("id")!;
      assert.ok(
        references.has(id),
        "only the original generation is looked up",
      );
      state.gets++;
      getIds.push(id);
      if (state.costDown)
        return new Response("synthetic unavailable", { status: 503 });
      const receipt = {
        id,
        session_id: references.get(id),
        model,
        provider: "openai",
        api: "chat/completions",
        source: "api",
        has_web_search: true,
        usage: {
          input_tokens: 22621,
          output_tokens: 438,
          input_cached_tokens: 0,
          output_reasoning_tokens: 213,
        },
        ...state.receiptPatch,
      };
      // Keep the provider's numeric lexeme intact, not Number(cost) or token math.
      const raw =
        '{"data":' +
        JSON.stringify(receipt).slice(0, -1) +
        ',"total_cost":' +
        state.cost +
        "}}";
      return new Response(raw, {
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(url, "https://routerai.ru/api/v1/chat/completions");
    assert.equal(init?.method, "POST");
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.model, model);
    assert.equal(payload.stream, false);
    assert.deepEqual(payload.plugins, [
      { id: "web", engine: "native", max_results: 5 },
    ]);
    assert.deepEqual(payload.provider, {
      only: ["openai"],
      allow_fallbacks: false,
      country: "us",
    });
    assert.match(payload.session_id, /^[0-9a-f-]{36}$/);
    state.posts++;
    const id = "gen-native-postpay-synthetic-" + state.posts;
    references.set(id, payload.session_id);
    return new Response(
      JSON.stringify({
        id,
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            finish_reason: state.finish,
            message: {
              role: "assistant",
              content: answer,
              ...(state.annotations
                ? {
                    annotations: [
                      { type: "url_citation", url_citation: source },
                    ],
                  }
                : {}),
            },
          },
        ],
        usage: {
          prompt_tokens: 22621,
          completion_tokens: 438,
          total_tokens: 23059,
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const provider = new RouterAIProvider("synthetic-native-postpay-key", model, {
    upstream: "openai",
    country: "us",
    webSearch: { engine: "native", maxResults: 5 },
    nativeWebReceiptPolicy: "routerai-native-total-cost-postpay-test-v1",
    maxOutputTokens: 4096,
    reasoningEffort: "medium",
    fetch: transport,
  });
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    LLM_PROVIDER: "routerai",
    ROUTERAI_MODEL: "deepseek/deepseek-v4-pro-0813",
    ROUTERAI_UPSTREAM: "deepseek",
    ROUTERAI_COUNTRY: "cn",
    AI_ASSISTANT_MODES: "enabled",
    AI_MODES_DATA_NOTICE: "Synthetic native-search recipients only.",
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_test_v1",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
    AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
    AI_REQUEST_COST_LIMIT_MODE: "operator_ceiling",
    ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
    LLM_MAX_INPUT_BYTES: "65536",
    AI_MAXIMUM_REASONING_EFFORT: "medium",
  });
  const modeProviders = { maximum: provider };
  const modes = createAssistantModes(config, modeProviders)!;
  assert.equal(
    modes.routes.find((route) => route.id === "maximum")?.provider,
    provider,
  );
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const idleWaiters = new Set<() => void>();
  const isIdle = () =>
    [...timers.values()].some((item) => item.delay === 30000);
  let timerSequence = 0;
  const scheduler = {
    schedule(callback: () => void, delay: number) {
      const id = ++timerSequence;
      timers.set(id, { callback, delay });
      if (delay === 30000) for (const notify of [...idleWaiters]) notify();
      return id;
    },
    cancel(handle: unknown) {
      timers.delete(Number(handle));
    },
  };
  const idle = async () => {
    if (isIdle()) return;
    // Completion is a scheduler event, not a count of fast event-loop spins.
    // The bounded real timer only diagnoses a fixture deadlock; it never ticks
    // the production reconciler or changes any production timeout.
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(deadline);
        idleWaiters.delete(finish);
        resolve();
      };
      const deadline = setTimeout(() => {
        idleWaiters.delete(finish);
        reject(Error("Synthetic reconciliation did not become idle"));
      }, 5000);
      idleWaiters.add(finish);
      if (isIdle()) finish();
    });
  };
  await db.query(
    "update ai_budget set enabled=true,mode='fixed',currency='RUB',daily_limit_micros=1000000000,total_limit_micros=1000000000,rules=$1 where id=1",
    [
      JSON.stringify(
        modes.routes
          .filter((route) => route.provider)
          .map((route) => ({
            ...route.execution,
            attemptCeilingMicros: 6000000,
          })),
      ),
    ],
  );
  const open = async () => {
    app = await buildApp({
      db,
      config,
      modeProviders,
      testing: true,
      postpayReconcileScheduler: scheduler,
    });
    // Fastify starts the background reconciler from onReady, not buildApp.
    await app.ready();
    await idle();
  };
  await open();
  const call = (
    method: "GET" | "POST",
    url: string,
    token = "",
    payload?: object,
  ) =>
    app!.inject({
      method,
      url,
      headers: {
        origin: "http://localhost:3000",
        cookie: "citygo=" + token,
        [CONTRACT_VERSION_HEADER]: "1",
      },
      ...(payload ? { payload } : {}),
    });
  const registration = await call("POST", "/v1/auth/register", "", {
    email: randomUUID() + "@example.test",
    password: "123456",
    consents: await syntheticConsentsFor(app!),
  });
  assert.equal(registration.statusCode, 200, registration.body);
  const token = registration.cookies[0]!.value;
  const board = dashboardResponseSchema.parse(
    (await call("GET", "/v1/dashboard", token)).json(),
  );
  const ledger = new AiCreditLedger(
    db,
    "routerai_citygo_10x",
    false,
    "fixed5_overdraft",
  );
  await ledger.topUpConfirmed(board.user.id, randomUUID(), {
    providerPaymentId: "synthetic-native-funding-" + randomUUID(),
    merchantId: "synthetic-shop",
    paidKopeks: 50000,
    currency: "RUB",
    test: false,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded",
  });
  const start = await call("POST", "/v1/conversations/start", token, {
    agentKey: "housing",
  });
  assert.equal(start.statusCode, 200, start.body);
  const threadId = start.json<{ id: string }>().id;
  const send = (
    text = "Синтетический вопрос с поиском.",
    requestId = randomUUID(),
  ) =>
    call("POST", `/v1/threads/${threadId}/messages`, token, {
      text,
      requestId,
      aiMode: "maximum",
      aiModeCatalogId: modes.catalogId,
      policyId: modes.policy.id,
    });
  const balance = async () =>
    (await call("GET", "/v1/ai/credit", token)).json<AiCredit>();
  const history = async () => {
    const reply = await call(
      "GET",
      `/v1/conversations/${threadId}/messages`,
      token,
    );
    assert.equal(reply.statusCode, 200, reply.body);
    return conversationMessagesResponseSchema.parse(reply.json()).messages;
  };
  const tick = async () => {
    await idle();
    await db.query(
      "update ai_postpay_attempts set next_check_at=clock_timestamp() where state in('dispatched','pending')",
    );
    const waiting = [...timers.entries()].find(
      ([, item]) => item.delay === 30000,
    )!;
    timers.delete(waiting[0]);
    waiting[1].callback();
    await idle();
  };
  return {
    db,
    state,
    getIds,
    send,
    balance,
    history,
    tick,
    async reload() {
      // Keep the immediate startup cycle from racing the explicitly ticked read.
      await db.query(
        "update ai_postpay_attempts set next_check_at=clock_timestamp()+interval '1 hour' where state in('dispatched','pending')",
      );
      await app!.close();
      await open();
    },
    async attempt() {
      return (
        await db.query<{
          state: string;
          protocol: string;
          response_complete: boolean;
          receipt: { costRub: string } | null;
          observed_receipt: { costRub: string } | null;
        }>(
          "select state,protocol,response_complete,receipt,observed_receipt from ai_postpay_attempts order by created_at limit 1",
        )
      ).rows[0]!;
    },
  };
}

test("native postpay debits the full search-inclusive total exactly once after a completed source-bearing answer, never a hold", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID();
  const sent = await f.send("Синтетический вопрос с поиском.", requestId);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(events(sent.body).at(-1)?.type, "done", sent.body);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
  assert.deepEqual(f.state.heldAtTransport, [0, 0]);
  const paid = await f.balance();
  assert.equal(paid.heldMicros, 0);
  assert.equal(paid.spentMicros, 73_918_283);
  assert.equal(paid.availableMicros, 426_081_717);
  const row = await f.attempt();
  assert.equal(row.protocol, "chat/completions");
  assert.equal(row.state, "settled");
  assert.equal(row.receipt?.costRub, fullCost);
  assert.deepEqual(
    (await f.history()).at(-1)?.generation?.webSources,
    expectedSources,
  );
  await f.reload();
  assert.deepEqual(
    (await f.history()).at(-1)?.generation?.webSources,
    expectedSources,
  );
  await f.send("Синтетический вопрос с поиском.", requestId);
  await f.tick();
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
  assert.equal((await f.balance()).spentMicros, 73_918_283);
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries where kind='hold'")).rows
      .length,
    0,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries where kind='settle'"))
      .rows.length,
    1,
  );
  assert.equal(
    (
      await f.db.query(
        "select 1 from audit_log where action='ai-postpay-settled'",
      )
    ).rows.length,
    1,
  );
});

test("native cost outage preserves a completed answer and restart reconciles only its original generation without another POST", async (t) => {
  const f = await fixture(t);
  f.state.costDown = true;
  assert.equal(events((await f.send()).body).at(-1)?.type, "done");
  assert.equal((await f.attempt()).state, "pending");
  assert.equal((await f.balance()).spentMicros, 0);
  assert.equal((await f.balance()).heldMicros, 0);
  await f.reload();
  f.state.costDown = false;
  await f.tick();
  await f.tick();
  assert.equal((await f.attempt()).state, "settled");
  assert.equal((await f.balance()).spentMicros, 73_918_283);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 2);
  assert.equal(new Set(f.getIds).size, 1);
});

test("native wrong receipt identity or search flag never posts money and a later exact lookup repairs the same attempt", async (t) => {
  const f = await fixture(t);
  f.state.receiptPatch = { api: "responses" };
  assert.equal(events((await f.send()).body).at(-1)?.type, "done");
  for (const patch of [
    { id: "gen-other-synthetic" },
    { session_id: randomUUID() },
    { model: "openai/other" },
    { provider: "deepseek" },
    { source: "chat" },
    { has_web_search: false },
    { has_web_search: undefined },
  ]) {
    f.state.receiptPatch = patch;
    await f.tick();
    assert.equal((await f.attempt()).state, "pending");
    assert.equal((await f.balance()).spentMicros, 0);
    assert.equal((await f.balance()).heldMicros, 0);
    assert.equal(f.state.posts, 1);
  }
  f.state.receiptPatch = {};
  await f.tick();
  await f.tick();
  assert.equal((await f.attempt()).state, "settled");
  assert.equal((await f.balance()).spentMicros, 73_918_283);
  assert.equal(f.state.posts, 1);
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries where kind='settle'"))
      .rows.length,
    1,
  );
});

test("native zero observation remains pending until the full positive cost is available", async (t) => {
  const f = await fixture(t);
  f.state.cost = "0";
  assert.equal(events((await f.send()).body).at(-1)?.type, "done");
  const pending = await f.attempt();
  assert.equal(pending.state, "pending");
  assert.equal(pending.receipt, null);
  assert.equal(pending.observed_receipt?.costRub, "0");
  assert.equal((await f.balance()).spentMicros, 0);
  assert.equal((await f.balance()).heldMicros, 0);
  f.state.cost = fullCost;
  await f.tick();
  await f.tick();
  assert.equal((await f.attempt()).state, "settled");
  assert.equal((await f.balance()).spentMicros, 73_918_283);
  assert.equal(f.state.posts, 1);
});

test("native interrupted attempt keeps a positive lookup as observation only and does not block the next question", async (t) => {
  const f = await fixture(t);
  f.state.finish = "length";
  assert.equal(events((await f.send()).body).at(-1)?.type, "error");
  await f.tick();
  const interrupted = await f.attempt();
  assert.equal(interrupted.response_complete, false);
  assert.equal(interrupted.receipt, null);
  assert.equal(interrupted.observed_receipt?.costRub, fullCost);
  assert.equal((await f.balance()).spentMicros, 0);
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal((await f.history()).at(-1)?.generation?.webSources, undefined);
  f.state.finish = "stop";
  assert.equal(
    events((await f.send("Следующий синтетический вопрос.")).body).at(-1)?.type,
    "done",
  );
  assert.equal(f.state.posts, 2);
  assert.equal((await f.balance()).spentMicros, 73_918_283);
});

test("native postpay preserves the global operator stop before any generation or customer debit", async (t) => {
  const f = await fixture(t);
  await f.db.query("update ai_budget set enabled=false where id=1");
  const stopped = await f.send();
  assert.match(stopped.body, /AI_BUDGET_UNAVAILABLE|AI_BUDGET_DISABLED/);
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
  assert.equal((await f.balance()).spentMicros, 0);
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal(
    (await f.db.query("select 1 from ai_postpay_attempts")).rows.length,
    0,
  );
});
