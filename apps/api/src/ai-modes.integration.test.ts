import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readConfig } from "@citygo/config";
import { AiCreditLedger, connectDatabase, migrate } from "@citygo/db";
import {
  dashboardResponseSchema,
  type AiCredit,
  type AiModeId,
} from "@citygo/contracts";
import type {
  ModelMessage,
  ModelRetryGuard,
  StreamingProvider,
} from "@citygo/llm";
import { buildApp } from "./app.js";
import { createAssistantModes, type ModeProviders } from "./ai-modes.js";
import { syntheticConsentsFor } from "./test-service-consents.js";

async function fixture(t: TestContext, minimum = false) {
  const db = await connectDatabase("pglite://:memory:");
  const cleanup: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  t.after(async () => {
    await cleanup.app?.close();
    await db.close();
  });
  await migrate(db);
  const calls: { mode: AiModeId; messages: ModelMessage[]; held: string }[] =
    [];
  const references = new Map<string, string>();
  const reads: AiModeId[] = [];
  const failures = new Set<AiModeId>();
  const modeProviders: ModeProviders = {};
  if (minimum) {
    modeProviders.minimum = {
      name: "gigachat",
      model: "GigaChat-3-Ultra",
      async *stream(_instructions, messages, _signal, guard) {
        assert.equal(guard?.billing, undefined);
        calls.push({
          mode: "minimum",
          messages: structuredClone(messages),
          held: "0",
        });
        yield { type: "delta", text: "Синтетический ответ minimum" };
        yield {
          type: "complete",
          model: "GigaChat-3-Ultra",
          usage: { inputTokens: 4, outputTokens: 2 },
        };
      },
    };
  }
  for (const [mode, model, upstream, costRub, amountMicros] of [
    ["maximum", "openai/gpt-6.1-sol", "openai", "0.2", 200000],
    ["balanced", "deepseek/deepseek-v4-pro-0813", "deepseek", "0.1", 100000],
  ] as const) {
    modeProviders[mode] = {
      name: "routerai",
      model,
      async *stream(
        _instructions: string,
        messages: ModelMessage[],
        _signal: AbortSignal,
        guard?: ModelRetryGuard,
      ) {
        assert.ok(guard?.billing);
        const hold = (
          await db.query<{ held: string }>(
            "select amount_micros::text as held from ai_credit_entries where operation_id=$1 and kind='hold'",
            [guard.billing.reference],
          )
        ).rows[0]!;
        calls.push({
          mode,
          messages: structuredClone(messages),
          held: hold.held,
        });
        const id = "gen-synthetic-mode-" + randomUUID();
        references.set(id, guard.billing.reference);
        await guard.billing.onGeneration(id);
        yield { type: "delta", text: "Синтетический ответ " + mode };
        yield {
          type: "complete",
          model,
          usage: { inputTokens: 10, outputTokens: 4 },
        };
      },
      async readCharge(generationId, reference) {
        reads.push(mode);
        if (failures.has(mode))
          throw Error("Synthetic receipt temporarily unavailable");
        assert.equal(references.get(generationId), reference);
        return {
          generationId,
          reference,
          model,
          upstream,
          currency: "RUB",
          costRub,
          amountMicros,
        };
      },
    } satisfies StreamingProvider;
  }
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    LLM_PROVIDER: "routerai",
    AI_ASSISTANT_MODES: "enabled",
    AI_MODES_DATA_NOTICE: "Synthetic recipients only.",
    AI_CREDIT_MODE: minimum ? "disabled" : "routerai_citygo_10x",
    AI_CREDIT_RESERVATION_MODE: minimum ? "full" : "fixed5_overdraft",
    ...(minimum
      ? {
          GIGACHAT_MODEL: "GigaChat-3-Ultra",
          GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
        }
      : {}),
    ROUTERAI_MODEL: "deepseek/deepseek-v4-pro-0813",
    ROUTERAI_UPSTREAM: "deepseek",
    ROUTERAI_COUNTRY: "cn",
  });
  const modes = createAssistantModes(config, modeProviders)!;
  await db.query(
    "update ai_budget set enabled=true,mode='routerai_balance',currency='RUB',daily_limit_micros=null,total_limit_micros=null,rules=$1 where id=1",
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
  if (minimum)
    await db.query(
      "update ai_budget set mode='fixed',daily_limit_micros=100000000,total_limit_micros=100000000 where id=1",
    );
  const app = await buildApp({ db, config, modeProviders, testing: true });
  cleanup.app = app;
  const call = (
    method: "GET" | "POST",
    url: string,
    token = "",
    payload?: object,
  ) =>
    app!.inject({
      method,
      url,
      headers: { origin: "http://localhost:3000", cookie: "citygo=" + token },
      ...(payload ? { payload } : {}),
    });
  const registration = await call("POST", "/v1/auth/register", "", {
    email: randomUUID() + "@example.test",
    password: "123456",
    consents: await syntheticConsentsFor(app),
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
  if (!minimum)
    await ledger.topUpConfirmed(board.user.id, randomUUID(), {
      providerPaymentId: "synthetic-mode-payment-" + randomUUID(),
      merchantId: "synthetic-shop",
      paidKopeks: 10000,
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
    mode: AiModeId,
    text: string,
    requestId = randomUUID(),
    extra: object = {},
  ) =>
    call("POST", `/v1/threads/${threadId}/messages`, token, {
      text,
      requestId,
      aiMode: mode,
      aiModeCatalogId: modes.catalogId,
      policyId: modes.policy.id,
      creditReservationMode: "fixed5_overdraft",
      ...extra,
    });
  const balance = async () =>
    (await call("GET", "/v1/ai/credit", token)).json<AiCredit>();
  return {
    db,
    app,
    config,
    modes,
    call,
    token,
    board,
    threadId,
    send,
    calls,
    reads,
    failures,
    balance,
  };
}

test("HTTP mode switching preserves one conversation and last question, holds five CityGo and settles each exact provider charge times ten", async (t) => {
  const f = await fixture(t);
  const beforeRouting = (await f.db.query("select * from ai_routing")).rows;
  assert.deepEqual(
    f.board.aiAccess.modes!.options.map((mode) => [mode.label, mode.available]),
    [
      ["Максимум", true],
      ["Баланс", true],
      ["Минимум", false],
    ],
  );
  assert.equal(f.board.aiAccess.policy!.id, f.modes.policy.id);
  assert.equal(
    f.board.aiAccess.granted,
    true,
    "the registration choice covers the exact bundle",
  );
  const first = await f.send("balanced", "Первый вопрос о переезде");
  assert.match(first.body, /"type":"done"/);
  const second = await f.send(
    "maximum",
    "Последний вопрос: что сделать сегодня?",
  );
  assert.match(second.body, /"type":"done"/);
  assert.deepEqual(
    f.calls.map((call) => [call.mode, call.held]),
    [
      ["balanced", "5000000"],
      ["maximum", "5000000"],
    ],
  );
  assert.match(f.calls[1]!.messages[0]!.content, /Контекст переезда.*unknown/);
  assert.deepEqual(f.calls[1]!.messages.slice(1), [
    { role: "user", content: "Первый вопрос о переезде" },
    { role: "assistant", content: "Синтетический ответ balanced" },
    { role: "user", content: "Последний вопрос: что сделать сегодня?" },
  ]);
  assert.equal(
    f.calls[1]!.messages.filter(
      (message) => message.content === "Последний вопрос: что сделать сегодня?",
    ).length,
    1,
  );
  const balance = await f.balance();
  assert.equal(balance.grantedMicros, 100000000);
  assert.equal(balance.spentMicros, 3000000);
  assert.equal(balance.availableMicros, 97000000);
  assert.equal(balance.heldMicros, 0);
  assert.deepEqual(
    (await f.db.query("select * from ai_routing")).rows,
    beforeRouting,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select mode,provider,model from ai_request_modes order by created_at",
      )
    ).rows,
    [
      {
        mode: "balanced",
        provider: "routerai",
        model: "deepseek/deepseek-v4-pro-0813",
      },
      { mode: "maximum", provider: "routerai", model: "openai/gpt-6.1-sol" },
    ],
  );
  const reloaded = await f.call(
    "GET",
    `/v1/conversations/${f.threadId}`,
    f.token,
  );
  assert.equal(reloaded.statusCode, 200, reloaded.body);
  const history = reloaded.json<{
    thread: { messages: { content: string }[] };
  }>();
  assert.deepEqual(
    history.thread.messages.map((message) => message.content),
    [
      "Первый вопрос о переезде",
      "Синтетический ответ balanced",
      "Последний вопрос: что сделать сегодня?",
      "Синтетический ответ maximum",
    ],
  );
});

test("an isolated unpaid Minimum route stays direct and does not inherit the RouterAI upstream or create a money hold", async (t) => {
  const f = await fixture(t, true);
  assert.equal(
    f.board.aiAccess.modes!.options.find((mode) => mode.id === "minimum")!
      .available,
    true,
  );
  const response = await f.send("minimum", "Синтетический вопрос");
  assert.match(response.body, /"type":"done"/);
  assert.deepEqual(
    f.calls.map((call) => call.mode),
    ["minimum"],
  );
  assert.deepEqual(
    (await f.db.query("select provider,upstream from ai_request_modes")).rows,
    [{ provider: "gigachat", upstream: null }],
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_charges")).rows.length,
    0,
  );
  assert.equal(f.reads.length, 0);
});

test("stale catalogs, unavailable modes and duplicate request IDs cannot spend or create another accepted mode", async (t) => {
  const f = await fixture(t);
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const table of [
      "messages",
      "chat_requests",
      "ai_request_modes",
      "ai_model_attempts",
      "ai_usage_daily",
      "ai_credit_accounts",
      "ai_credit_entries",
      "ai_credit_charges",
    ])
      result[table] = (
        await f.db.query(
          `select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`,
        )
      ).rows;
    return result;
  };
  const before = await snapshot();
  assert.equal(
    (
      await f.send("maximum", "Не отправлять", randomUUID(), {
        aiModeCatalogId: "0".repeat(64),
      })
    ).statusCode,
    409,
  );
  assert.equal((await f.send("minimum", "Не отправлять")).statusCode, 503);
  assert.equal(
    (
      await f.send("maximum", "Не отправлять", randomUUID(), {
        aiMode: "unknown",
      })
    ).statusCode,
    400,
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(f.calls.length, 0);
  const id = randomUUID();
  assert.match(
    (await f.send("maximum", "Один вопрос", id)).body,
    /"type":"done"/,
  );
  const after = await snapshot();
  assert.equal((await f.send("balanced", "Один вопрос", id)).statusCode, 409);
  assert.deepEqual(await snapshot(), after);
  assert.equal(f.calls.length, 1);
});

test("an unresolved Maximum charge is reconciled by its original profile and blocks another mode without an automatic request", async (t) => {
  const f = await fixture(t);
  f.failures.add("maximum");
  assert.match(
    (await f.send("maximum", "Ответ с отложенной сверкой")).body,
    /"type":"done"/,
  );
  assert.equal((await f.balance()).heldMicros, 5000000);
  const blocked = await f.send("balanced", "Следующий вопрос");
  assert.match(blocked.body, /AI_CREDIT_UNAVAILABLE/);
  assert.equal(f.calls.length, 1);
  const charge = (
    await f.db.query<{ hold_id: string; model: string }>(
      "select hold_id::text,model from ai_credit_charges",
    )
  ).rows[0]!;
  assert.equal(charge.model, "openai/gpt-6.1-sol");
  await f.db.query("update users set role='super_admin' where id=$1", [
    f.board.user.id,
  ]);
  f.failures.clear();
  const reconciled = await f.call(
    "POST",
    "/v1/admin/ai/credit/reconcile",
    f.token,
    { userId: f.board.user.id, holdId: charge.hold_id, confirmReconcile: true },
  );
  assert.equal(reconciled.statusCode, 200, reconciled.body);
  assert.deepEqual(f.reads, ["maximum", "maximum"]);
  assert.equal(f.calls.length, 1);
  const balance = await f.balance();
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.spentMicros, 2000000);
  const repeated = await f.call(
    "POST",
    "/v1/admin/ai/credit/reconcile",
    f.token,
    { userId: f.board.user.id, holdId: charge.hold_id, confirmReconcile: true },
  );
  assert.equal(repeated.statusCode, 200);
  assert.equal(f.reads.length, 2);
});
