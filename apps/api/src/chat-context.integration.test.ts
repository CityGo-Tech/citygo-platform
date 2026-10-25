import { syntheticServiceConsents } from "./test-service-consents.js";
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
import {
  CONTRACT_VERSION_HEADER,
  dashboardResponseSchema,
  type AiCredit,
} from "@citygo/contracts";
import type {
  ModelMessage,
  ModelRetryGuard,
  ModelStreamEvent,
  StreamingProvider,
} from "@citygo/llm";
import { buildApp } from "./app.js";
import { seedTestBudget } from "./test-budget.js";

const RUB = 1_000_000;
const MAX_INPUT_BYTES = 8192;
const syntheticAnswer = "Контрольный ответ на последний вопрос.";

async function fixture(t: TestContext) {
  // This regression never reads TEST_DATABASE_URL, environment files, external
  // credentials or the network. Every provider receipt and payment is synthetic.
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
  const calls: {
    instructions: string;
    messages: ModelMessage[];
    observedHoldMicros: string;
  }[] = [];
  let receiptCalls = 0;
  const provider: StreamingProvider = {
    name: "routerai",
    model: "synthetic/context-window",
    async *stream(
      instructions: string,
      messages: ModelMessage[],
      _signal: AbortSignal,
      guard?: ModelRetryGuard,
    ): AsyncIterable<ModelStreamEvent> {
      assert.ok(guard?.billing, "the real API must reserve before transport");
      const held = (
        await db.query<{ amount: string }>(
          "select amount_micros::text as amount from ai_credit_entries where operation_id=$1 and kind='hold'",
          [guard.billing.reference],
        )
      ).rows;
      assert.equal(held.length, 1);
      calls.push({
        instructions,
        messages: structuredClone(messages),
        observedHoldMicros: held[0]!.amount,
      });
      await guard.billing.onGeneration("gen-synthetic-context");
      yield { type: "delta", text: syntheticAnswer };
      yield {
        type: "complete",
        model: "synthetic/context-window",
        usage: { inputTokens: 5, outputTokens: 3 },
      };
    },
    async readCharge(generationId: string, reference: string) {
      receiptCalls++;
      return {
        generationId,
        reference,
        model: "synthetic/context-window",
        upstream: "synthetic-upstream",
        currency: "RUB",
        costRub: "0.237891",
        amountMicros: 237891,
      };
    },
  };
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    LLM_PROVIDER: "routerai",
    ROUTERAI_MODEL: provider.model,
    ROUTERAI_UPSTREAM: "synthetic-upstream",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
    LLM_MAX_INPUT_BYTES: String(MAX_INPUT_BYTES),
  });
  await seedTestBudget(db, config, { routerai: provider });
  await db.query(
    "update ai_budget set daily_limit_micros=$1,total_limit_micros=$1,rules=jsonb_set(rules,'{0,attemptCeilingMicros}',$2::jsonb)",
    [100 * RUB, String(6 * RUB)],
  );
  const app = await buildApp({ db, provider, config, testing: true });
  cleanup.app = app;
  const currentApp = app;
  const call = (
    method: "GET" | "POST",
    url: string,
    token = "",
    payload?: object,
  ) =>
    currentApp.inject({
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
    consents: syntheticServiceConsents,
    email: randomUUID() + "@example.test",
    password: "123456",
  });
  assert.equal(registration.statusCode, 200, registration.body);
  const token = registration.cookies[0]!.value;
  const start = await call("POST", "/v1/conversations/start", token, {});
  assert.equal(start.statusCode, 200, start.body);
  const threadId = start.json<{ id: string }>().id;
  const dashboard = async () => {
    const reply = await call("GET", "/v1/dashboard", token);
    assert.equal(reply.statusCode, 200, reply.body);
    return dashboardResponseSchema.parse(reply.json());
  };
  const board = await dashboard();
  const policyId = board.aiAccess.policy!.id;
  const consent = await call("POST", "/v1/ai/consent", token, {
    action: "granted",
    policyId,
  });
  assert.equal(consent.statusCode, 200, consent.body);
  await new AiCreditLedger(
    db,
    "routerai_citygo_10x",
    false,
    "fixed5_overdraft",
  ).topUpConfirmed(board.user.id, randomUUID(), {
    providerPaymentId: "synthetic-context-payment-" + randomUUID(),
    paidKopeks: 10000,
    merchantId: "synthetic-context-shop",
    test: false,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  const balance = async () => {
    const reply = await call("GET", "/v1/ai/credit", token);
    assert.equal(reply.statusCode, 200, reply.body);
    return reply.json<AiCredit>();
  };
  const send = (text: string, requestId = randomUUID()) =>
    call("POST", `/v1/threads/${threadId}/messages`, token, {
      text,
      requestId,
      policyId,
      creditReservationMode: "fixed5_overdraft",
    });
  return {
    db,
    threadId,
    dashboard,
    calls,
    balance,
    send,
    receiptCalls: () => receiptCalls,
  };
}

async function financialSnapshot(db: Database) {
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
  ]) {
    result[table] = (
      await db.query(
        `select row_to_json(x) as value from ${table} x order by row_to_json(x)::text`,
      )
    ).rows;
  }
  return result;
}

test("long paid dialogue keeps the latest question and whole stored history without orphan turns, with a five-CityGo hold and exact 10x debit", async (t) => {
  const f = await fixture(t);
  // IDs cross 99/100 so lexical ordering cannot accidentally satisfy this test.
  await f.db.query(
    `insert into messages(thread_id,role,content,metadata)
     select $1,case when i%2=1 then 'user' else 'assistant' end,
       'synthetic-old-' || i,
       '{"agentKey":"support","status":"complete"}'::jsonb
     from generate_series(1,96) i order by i`,
    [f.threadId],
  );
  const recent = [
    { role: "user", content: "FAILED-TURN-QUESTION", status: "complete" },
    { role: "assistant", content: "FAILED-TURN-ANSWER", status: "interrupted" },
    { role: "assistant", content: "ORPHAN-ASSISTANT", status: "complete" },
    { role: "user", content: "ORPHAN-USER", status: "complete" },
    { role: "user", content: "OLDER-LARGE-QUESTION", status: "complete" },
    { role: "assistant", content: "я".repeat(6000), status: "complete" },
    { role: "user", content: "NEWEST-PAIR-ONE-QUESTION", status: "complete" },
    {
      role: "assistant",
      content: "NEWEST-PAIR-ONE-ANSWER",
      status: "complete",
    },
    { role: "user", content: "FAILED-RETRY-QUESTION", status: "complete" },
    {
      role: "assistant",
      content: "FAILED-RETRY-ANSWER",
      status: "interrupted",
    },
    { role: "user", content: "NEWEST-PAIR-TWO-QUESTION", status: "complete" },
    {
      role: "assistant",
      content: "NEWEST-PAIR-TWO-ANSWER",
      status: "complete",
    },
  ];
  for (const message of recent) {
    await f.db.query(
      "insert into messages(thread_id,role,content,metadata) values ($1,$2,$3,$4)",
      [
        f.threadId,
        message.role,
        message.content,
        JSON.stringify({ agentKey: "support", status: message.status }),
      ],
    );
  }
  const stored = async () =>
    (
      await f.db.query<{ id: string; value: unknown }>(
        "select m.id::text as id,row_to_json(m) as value from messages m where thread_id=$1 order by m.id",
        [f.threadId],
      )
    ).rows;
  const before = await stored();
  assert.equal(before.length, 108);
  const currentQuestion = "Последний контрольный вопрос: назови следующий шаг.";
  const reply = await f.send(currentQuestion);
  assert.equal(reply.statusCode, 200, reply.body);
  assert.match(reply.body, /"type":"done"/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.receiptCalls(), 1);
  const sent = f.calls[0]!;
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({
        instructions: sent.instructions,
        messages: sent.messages,
      }),
      "utf8",
    ) <= MAX_INPUT_BYTES,
  );
  assert.equal(sent.observedHoldMicros, String(5 * RUB));
  assert.deepEqual(sent.messages.slice(1), [
    { role: "user", content: "NEWEST-PAIR-ONE-QUESTION" },
    { role: "assistant", content: "NEWEST-PAIR-ONE-ANSWER" },
    { role: "user", content: "NEWEST-PAIR-TWO-QUESTION" },
    { role: "assistant", content: "NEWEST-PAIR-TWO-ANSWER" },
    { role: "user", content: currentQuestion },
  ]);
  assert.deepEqual(sent.messages.at(-1), {
    role: "user",
    content: currentQuestion,
  });
  assert.doesNotMatch(
    JSON.stringify(sent.messages),
    /FAILED-|ORPHAN-|synthetic-old-/,
  );
  const after = await stored();
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.length, before.length + 2);
  const reloaded = await f.dashboard();
  assert.deepEqual(
    reloaded.thread!.messages.map(({ id }) => id),
    after.slice(-100).map(({ id }) => id),
  );
  assert.deepEqual(
    reloaded
      .thread!.messages.slice(-2)
      .map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: currentQuestion },
      { role: "assistant", content: syntheticAnswer },
    ],
  );
  const balance = await f.balance();
  assert.equal(balance.reservationMode, "fixed5_overdraft");
  assert.equal(balance.minimumRequestBalanceMicros, 5 * RUB);
  assert.equal(balance.grantedMicros, 100 * RUB);
  assert.equal(balance.spentMicros, 237891 * 10);
  assert.equal(balance.availableMicros, 100 * RUB - 237891 * 10);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.outstandingDebtMicros, 0);
  assert.deepEqual(balance.pending, []);
  assert.deepEqual(
    (
      await f.db.query(
        "select kind,amount_micros::text as amount from ai_credit_entries where kind in ('hold','settle') order by id",
      )
    ).rows,
    [
      { kind: "hold", amount: String(5 * RUB) },
      { kind: "settle", amount: String(237891 * 10) },
    ],
  );

  // Mandatory instructions/profile/current question still need to fit the
  // approved request bound. Refusal must not silently truncate this question,
  // reserve money, dispatch/retry, or rewrite any previously stored message.
  const beforeRefusal = await financialSnapshot(f.db);
  const historyBeforeRefusal = await stored();
  const refused = await f.send("я".repeat(3900));
  assert.equal(refused.statusCode, 200, refused.body);
  assert.match(refused.body, /"type":"error"/);
  assert.doesNotMatch(refused.body, /"type":"done"/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.receiptCalls(), 1);
  assert.deepEqual(await financialSnapshot(f.db), beforeRefusal);
  const historyAfterRefusal = await stored();
  assert.deepEqual(
    historyAfterRefusal.slice(0, historyBeforeRefusal.length),
    historyBeforeRefusal,
  );
  assert.equal(historyAfterRefusal.length, historyBeforeRefusal.length + 2);
  const failedHistory = (await f.dashboard()).thread!.messages;
  assert.equal(failedHistory.at(-2)!.content, "я".repeat(3900));
  assert.equal(failedHistory.at(-1)!.status, "interrupted");
});
