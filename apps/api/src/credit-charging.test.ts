import { syntheticConsentsFor } from "./test-service-consents.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  AiCreditCharges,
  AiCreditLedger,
  Repository,
  connectDatabase,
  migrate,
  type Database,
  type Sql,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { RouterAIProvider } from "@citygo/llm";
import { testProfile } from "@citygo/testkit";
import type {
  Dashboard,
  AiCredit,
  AiControlStatus,
  AiBudgetInput,
  AiBudgetSettings,
} from "@citygo/contracts";
import { buildApp } from "./app.js";
import { seedTestBudget } from "./test-budget.js";

const RUB = 1_000_000;
async function fixture(
  t: TestContext,
  ceiling = 100 * RUB,
  mode: "routerai_at_cost" | "routerai_citygo_10x" = "routerai_at_cost",
  reservationMode: "full" | "fixed5_overdraft" = "full",
  requestCostLimitMode:
    "operator_ceiling" | "user_balance" = "operator_ceiling",
) {
  const base = process.env.TEST_DATABASE_URL;
  const database = "citygo_charging_" + randomUUID().replaceAll("-", "");
  assert.match(database, /^citygo_charging_[a-f0-9]{32}$/);
  let adminDb: Database | undefined,
    created = false;
  const cleanup: {
    db?: Database;
    app?: Awaited<ReturnType<typeof buildApp>>;
  } = {};
  // Register before setup so a failed migration or application construction
  // cannot leak this test's connections/database. Never drop a supplied target.
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of [
      async () => cleanup.app?.close(),
      async () => cleanup.db?.close(),
      async () => {
        if (created) await adminDb!.query(`drop database "${database}"`);
      },
      async () => adminDb?.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Synthetic charging cleanup failed");
  });
  let url = "pglite://:memory:";
  if (base) {
    const scoped = new URL(base);
    assert.ok(["postgres:", "postgresql:"].includes(scoped.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(scoped.hostname));
    assert.ok(["/citygo_test", "/citygo_synthetic"].includes(scoped.pathname));
    assert.equal(scoped.search, "");
    assert.equal(scoped.hash, "");
    adminDb = await connectDatabase(base);
    // Production trigger sources are deliberately public-qualified. A fresh
    // disposable database exercises that exact contract, without rewriting SQL
    // or changing search_path and without touching the entry database's tables.
    await adminDb.query(`create database "${database}" template template0`);
    created = true;
    scoped.pathname = "/" + database;
    url = scoped.toString();
  }
  const db = await connectDatabase(url);
  cleanup.db = db;
  await migrate(db);
  const state = {
    posts: 0,
    gets: 0,
    cost: "1.23456789",
    costDown: false,
    interrupted: false,
    emptyResponse: false,
    sameId: false,
  };
  const references = new Map<string, string>();
  const provider = new RouterAIProvider("synthetic-only-key", "test/model", {
    upstream: "test-upstream",
    fetch: async (url, init) => {
      if (init?.method === "GET") {
        state.gets++;
        if (state.costDown) return new Response("unavailable", { status: 503 });
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
          `{"data":${JSON.stringify(receipt).replace(/}$/, `,"total_cost":${state.cost}}`)}}`,
          { headers: { "content-type": "application/json" } },
        );
      }
      assert.equal(url, "https://routerai.ru/api/v1/chat/completions");
      state.posts++;
      const payload = JSON.parse(String(init?.body));
      assert.match(payload.session_id, /^[a-f0-9-]{36}$/);
      const id = state.sameId ? "gen-same" : "gen-" + randomUUID();
      references.set(id, payload.session_id);
      const chunk = (content: string, finish_reason: string | null = null) => ({
        id,
        model: "test/model",
        choices: [{ index: 0, delta: { content }, finish_reason }],
      });
      const events: unknown[] = state.emptyResponse
        ? []
        : [chunk("Проверьте условия аренды.")];
      if (!state.interrupted) events.push(chunk("", "stop"), "[DONE]");
      return new Response(
        events
          .map(
            (e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`,
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
    LLM_PROVIDER: "routerai",
    ROUTERAI_MODEL: provider.model,
    ROUTERAI_UPSTREAM: "test-upstream",
    ADMIN_USER_IDS: "1",
    AI_CREDIT_MODE: mode,
    AI_CREDIT_RESERVATION_MODE: reservationMode,
    AI_REQUEST_COST_LIMIT_MODE: requestCostLimitMode,
  });
  await seedTestBudget(db, config, { routerai: provider });
  await db.query(
    "update ai_budget set daily_limit_micros=$1,total_limit_micros=$1,rules=jsonb_set(rules,'{0,attemptCeilingMicros}',$2::jsonb)",
    [2000 * RUB, String(ceiling)],
  );
  const app = await buildApp({ db, config, provider, testing: true });
  cleanup.app = app;
  const call = (
    method: "GET" | "POST",
    path: string,
    token = "",
    body?: object,
    origin = "http://localhost:3000",
  ) =>
    app.inject({
      method,
      url: path,
      headers: { origin, cookie: "citygo=" + token },
      ...(body ? { payload: body } : {}),
    });
  const signup = async () => {
    const reply = await call("POST", "/v1/auth/register", "", {
      consents: await syntheticConsentsFor(app),
      email: randomUUID() + "@example.test",
      password: "Synthetic-password-123",
    });
    assert.equal(reply.statusCode, 200, reply.body);
    const token = reply.cookies[0]!.value;
    await call("POST", "/v1/questionnaire", token, testProfile);
    const board = (await call("GET", "/v1/dashboard", token)).json<Dashboard>();
    const thread = await call(
      "POST",
      `/v1/quests/${board.quests[0]!.id}/start`,
      token,
      {},
    );
    assert.equal(thread.statusCode, 200, thread.body);
    await call("POST", "/v1/ai/consent", token, {
      action: "granted",
      policyId: board.aiAccess.policy!.id,
    });
    return {
      id: board.user.id,
      token,
      thread: thread.json().id as string,
      policyId: board.aiAccess.policy!.id,
    };
  };
  const admin = await signup(),
    user = await signup();
  // Only this disposable fixture actor receives the persisted admin role;
  // ordinary registration and the legacy environment variable grant nothing.
  await db.query("update users set role='admin' where id=$1", [admin.id]);
  const grant = () =>
    call("POST", "/v1/admin/ai/credit/welcome", admin.token, {
      userId: user.id,
      confirmOneTime500Rub: true,
    });
  const send = (requestId = randomUUID(), thread = user.thread) =>
    call("POST", `/v1/threads/${thread}/messages`, user.token, {
      text: "Как выбрать квартиру?",
      requestId,
      policyId: user.policyId,
      ...(reservationMode === "fixed5_overdraft"
        ? { creditReservationMode: "fixed5_overdraft" }
        : {}),
    });
  const balance = async () =>
    (await call("GET", "/v1/ai/credit", user.token)).json<AiCredit>();
  return {
    db,
    app,
    call,
    admin,
    user,
    grant,
    send,
    balance,
    state,
    provider,
    config,
    reservationMode,
  };
}

type ChargingFixture = Awaited<ReturnType<typeof fixture>>;
async function budgetStatus(f: ChargingFixture) {
  const response = await f.call("GET", "/v1/admin/ai", f.admin.token);
  assert.equal(response.statusCode, 200, response.body);
  return response.json<AiControlStatus>().budget!;
}
function balanceBudgetInput(
  budget: Awaited<ReturnType<typeof budgetStatus>>,
  ceiling: number,
): AiBudgetInput {
  assert.equal(budget.settings.rules.length, 1);
  return {
    expectedRevision: budget.settings.revision,
    enabled: true,
    mode: "routerai_balance",
    currency: "RUB",
    dailyLimitMicros: null,
    totalLimitMicros: null,
    userDailyLimitMicros: null,
    rules: budget.settings.rules.map(({ key }) => ({
      key,
      attemptCeilingMicros: ceiling,
    })),
  };
}
async function fundSynthetic100Rub(f: ChargingFixture) {
  await new AiCreditLedger(f.db).topUpConfirmed(f.user.id, randomUUID(), {
    providerPaymentId: "synthetic-payment-" + randomUUID(),
    paidKopeks: 10000,
    merchantId: "synthetic-shop",
    test: false,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded",
    currency: "RUB",
  });
}
async function fundFixed5SyntheticCredit(
  f: ChargingFixture,
  paidKopeks: number,
) {
  const ledger = new AiCreditLedger(
    f.db,
    "routerai_citygo_10x",
    false,
    f.reservationMode,
  );
  const operationId = randomUUID();
  const receipt = {
    providerPaymentId: "synthetic-payment-" + randomUUID(),
    paidKopeks,
    merchantId: "synthetic-shop",
    test: false,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded" as const,
    currency: "RUB" as const,
  };
  await ledger.topUpConfirmed(f.user.id, operationId, receipt);
  return { ledger, operationId, receipt };
}
async function admissionSnapshot(f: ChargingFixture) {
  const result: Record<string, unknown[]> = {};
  // Fixed synthetic-only inventory: a refused reservation must roll back the
  // operator counters, wallet and paid-source allocations together.
  for (const table of [
    "account_security_state",
    "ai_budget",
    "ai_budget_daily",
    "ai_model_attempt_daily",
    "ai_user_model_attempt_daily",
    "ai_model_attempts",
    "ai_credit_accounts",
    "ai_credit_entries",
    "ai_credit_charges",
    "credit_charge_debts",
    "credit_debt_repayments",
    "credit_source_lots",
    "credit_hold_allocations",
  ])
    result[table] = (
      await f.db.query(
        `select row_to_json(x) as value from ${table} x order by row_to_json(x)::text`,
      )
    ).rows;
  return result;
}

test("RouterAI bonus admission, exact at-cost debit, request replay and history", async (t) => {
  const f = await fixture(t);
  const blockedId = randomUUID();
  const blocked = await f.send(blockedId);
  assert.match(blocked.body, /AI_CREDIT_EXHAUSTED/);
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
  assert.equal(
    (await f.db.query("select * from ai_model_attempts")).rows.length,
    0,
  );
  for (const table of ["ai_credit_charges", "ai_credit_entries"])
    assert.equal(
      (await f.db.query(`select count(*)::int as count from ${table}`)).rows[0]!
        .count,
      0,
    );
  const readBoard = async () =>
    (await f.call("GET", "/v1/dashboard", f.user.token)).json<Dashboard>();
  const refused = (await readBoard()).thread!.messages.at(-1)!;
  assert.equal(refused.role, "assistant");
  assert.equal(refused.status, "interrupted");
  assert.equal(refused.failureCode, "AI_CREDIT_EXHAUSTED");
  assert.ok(!refused.generation);
  assert.match(refused.content, /Недостаточно средств.*Пополните баланс/);
  assert.match(refused.content, /Запрос не отправлен ИИ, деньги не списаны/);
  assert.deepEqual((await readBoard()).thread!.messages.at(-1), refused);
  const metadata = (
    await f.db.query<{ metadata: Record<string, unknown> }>(
      "select metadata from messages where id=$1 and thread_id=$2",
      [refused.id, f.user.thread],
    )
  ).rows[0]!.metadata;
  assert.equal(metadata.source, "system");
  assert.equal(metadata.failureCode, "AI_CREDIT_EXHAUSTED");
  assert.equal(Object.hasOwn(metadata, "generation"), false);
  assert.equal((await f.send(blockedId)).statusCode, 409);
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
  assert.equal(
    Number(
      (await f.db.query("select total_reserved_micros from ai_budget")).rows[0]!
        .total_reserved_micros,
    ),
    0,
  );
  assert.equal((await f.grant()).statusCode, 200);
  const id = randomUUID();
  const response = await f.send(id);
  assert.match(response.body, /"type":"done"/);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
  const balance = await f.balance();
  assert.equal(balance.chargingStatus, "routerai_at_cost");
  assert.equal(balance.topUpAvailable, false);
  assert.equal(balance.spentMicros, 1234567);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.availableMicros, 500 * RUB - 1234567);
  assert.equal(balance.pending?.length, 0);
  assert.deepEqual(
    balance.history.map((e) => e.kind),
    ["settle", "hold", "bonus"],
  );
  assert.equal((await f.send(id)).statusCode, 409);
  assert.equal(f.state.posts, 1);
  await f.grant();
  assert.equal((await f.balance()).spentMicros, 1234567);
  const charge = (
    await f.db.query("select receipt,response_complete from ai_credit_charges")
  ).rows[0]!;
  assert.equal(charge.response_complete, true);
  const completed = (await readBoard()).thread!.messages.at(-1)!;
  assert.equal(completed.status, "complete");
  assert.ok(completed.generation);
  assert.ok(!completed.failureCode);
  assert.equal((charge.receipt as { costRub: string }).costRub, "1.23456789");
  assert.equal(
    Number(
      (await f.db.query("select total_reserved_micros from ai_budget")).rows[0]!
        .total_reserved_micros,
    ),
    100 * RUB,
    "operator cap remains conservative, not refunded as a wallet",
  );
});

test("CityGo 10x mode credits payment 1:1, debits the exact raw price and never grants an unverified phone gift", async (t) => {
  const f = await fixture(t, 10 * RUB, "routerai_citygo_10x");
  assert.equal((await f.grant()).statusCode, 503);
  assert.equal((await f.balance()).bonusGranted, false);
  assert.match((await f.send()).body, /AI_CREDIT_EXHAUSTED/);
  assert.equal(f.state.posts, 0);
  // Synthetic proof of a live-mode payment: both this fixture and RouterAI HTTP
  // below are mocked, with no payment/AI network calls or actual money. test:false
  // matters: a test-shop receipt must quarantine this DB from all model spending.
  await new AiCreditLedger(f.db).topUpConfirmed(f.user.id, randomUUID(), {
    providerPaymentId: "synthetic-payment-" + randomUUID(),
    paidKopeks: 20000,
    merchantId: "synthetic-shop",
    test: false,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  assert.equal((await f.balance()).availableMicros, 200 * RUB);
  assert.equal((await f.balance()).bonusGranted, false);
  const request = randomUUID();
  assert.match((await f.send(request)).body, /"type":"done"/);
  let balance = await f.balance();
  assert.equal(balance.chargingStatus, "routerai_citygo_10x");
  assert.equal(balance.spentMicros, 12345678);
  assert.equal(balance.heldMicros, 0);
  const saved = (
    await f.db.query<{
      receipt: { amountMicros: number; costRub: string };
      real_ceiling_micros: string;
      tariff_snapshot: { version: string };
    }>(
      "select receipt,real_ceiling_micros::text,tariff_snapshot from ai_credit_charges where user_id=$1",
      [f.user.id],
    )
  ).rows[0]!;
  assert.equal(saved.receipt.costRub, "1.23456789");
  assert.equal(saved.receipt.amountMicros, 1234567);
  assert.equal(saved.real_ceiling_micros, String(10 * RUB));
  assert.equal(saved.tariff_snapshot.version, "citygo-10x-v1");
  await f.send(request);
  assert.equal(f.state.posts, 1);
  assert.equal((await f.balance()).spentMicros, 12345678);
  f.state.costDown = true;
  assert.match((await f.send()).body, /"type":"done"/);
  balance = await f.balance();
  assert.equal(balance.heldMicros, 100 * RUB);
  assert.equal(balance.spentMicros, 12345678);
  f.state.costDown = false;
  const pending = balance.pending![0]!;
  const settled = await f.call(
    "POST",
    "/v1/admin/ai/credit/reconcile",
    f.admin.token,
    {
      userId: f.user.id,
      holdId: pending.holdId,
      confirmReconcile: true,
    },
  );
  assert.equal(settled.statusCode, 200, settled.body);
  assert.equal((await f.balance()).spentMicros, 24691356);
  const board = (
    await f.call("GET", "/v1/dashboard", f.user.token)
  ).json<Dashboard>();
  assert.equal(board.aiAccess.credit!.chargingStatus, "routerai_citygo_10x");
});

test("admin budget CAS lowers only future real ceilings from 10 to 6 RUB and allows another exact 10x debit from 97.830467 CityGo", async (t) => {
  const f = await fixture(t, 10 * RUB, "routerai_citygo_10x");
  let budget = await budgetStatus(f);
  const initial = await f.call(
    "POST",
    "/v1/admin/ai/budget",
    f.admin.token,
    balanceBudgetInput(budget, 10 * RUB),
  );
  assert.equal(initial.statusCode, 200, initial.body);
  await fundSynthetic100Rub(f);
  assert.equal((await f.balance()).availableMicros, 100 * RUB);
  f.state.cost = "0.2169533830464";
  const firstRequest = randomUUID();
  assert.match((await f.send(firstRequest)).body, /"type":"done"/);
  assert.equal((await f.balance()).availableMicros, 97830467);
  assert.equal((await f.balance()).spentMicros, 2169533);
  assert.equal((await f.balance()).heldMicros, 0);
  const oldCharge = async () =>
    (
      await f.db.query<{ value: Record<string, unknown> }>(
        "select row_to_json(c) as value from ai_credit_charges c where c.user_id=$1 and c.request_id=$2",
        [f.user.id, firstRequest],
      )
    ).rows[0]!.value;
  const oldSnapshot = await oldCharge();
  assert.equal(oldSnapshot.real_ceiling_micros, 10 * RUB);
  const oldHold = (
    await f.db.query("select * from ai_credit_entries where operation_id=$1", [
      oldSnapshot.hold_id,
    ])
  ).rows;
  assert.equal(Number(oldHold[0]!.amount_micros), 100 * RUB);
  const beforeDenied = await admissionSnapshot(f);
  const denied = await f.send();
  assert.match(denied.body, /AI_CREDIT_EXHAUSTED/);
  assert.deepEqual(await admissionSnapshot(f), beforeDenied);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
  budget = await budgetStatus(f);
  const input = balanceBudgetInput(budget, 6 * RUB);
  const changed = await f.call(
    "POST",
    "/v1/admin/ai/budget",
    f.admin.token,
    input,
  );
  assert.equal(changed.statusCode, 200, changed.body);
  const settings = changed.json<AiBudgetSettings>();
  assert.deepEqual(settings, {
    ...budget.settings,
    revision: budget.settings.revision + 1,
    rules: budget.settings.rules.map((rule) => ({
      ...rule,
      attemptCeilingMicros: 6 * RUB,
    })),
  });
  assert.equal(settings.mode, "routerai_balance");
  assert.equal(settings.dailyLimitMicros, null);
  assert.equal(settings.totalLimitMicros, null);
  assert.equal(settings.userDailyLimitMicros, null);
  const afterChanged = await admissionSnapshot(f);
  const stale = await f.call(
    "POST",
    "/v1/admin/ai/budget",
    f.admin.token,
    input,
  );
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().code, "REVISION_CONFLICT");
  assert.deepEqual(await admissionSnapshot(f), afterChanged);
  const secondRequest = randomUUID();
  assert.match((await f.send(secondRequest)).body, /"type":"done"/);
  assert.equal(f.state.posts, 2);
  assert.equal(f.state.gets, 2);
  const second = (
    await f.db.query<{
      real_ceiling_micros: string;
      held_micros: string;
      reserved_micros: string;
      settled_micros: string;
      receipt: { amountMicros: number; costRub: string };
      tariff_snapshot: {
        version: string;
        numerator: number;
        denominator: number;
      };
    }>(
      `select c.real_ceiling_micros::text,h.amount_micros::text as held_micros,
      a.money_reserved_micros::text as reserved_micros,s.amount_micros::text as settled_micros,c.receipt,c.tariff_snapshot
      from ai_credit_charges c join ai_credit_entries h on h.operation_id=c.hold_id
      join ai_credit_entries s on s.hold_id=c.hold_id and s.kind='settle'
      join ai_model_attempts a on a.thread_id=c.thread_id and a.request_id=c.request_id and a.attempt_number=c.attempt_number
      where c.user_id=$1 and c.request_id=$2`,
      [f.user.id, secondRequest],
    )
  ).rows[0]!;
  assert.equal(second.real_ceiling_micros, String(6 * RUB));
  assert.equal(second.held_micros, String(60 * RUB));
  assert.equal(second.reserved_micros, String(6 * RUB));
  assert.equal(second.receipt.costRub, "0.2169533830464");
  assert.equal(second.receipt.amountMicros, 216953);
  assert.equal(second.settled_micros, "2169533");
  assert.deepEqual(second.tariff_snapshot, {
    version: "citygo-10x-v1",
    realCurrency: "RUB",
    balanceUnit: "CITYGO_RUB",
    numerator: 10,
    denominator: 1,
  });
  const balance = await f.balance();
  assert.equal(balance.grantedMicros, 100 * RUB);
  assert.equal(balance.spentMicros, 4339066);
  assert.equal(balance.availableMicros, 95660934);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.pending?.length, 0);
  assert.equal(
    (await f.db.query("select 1 from ai_model_attempts")).rows.length,
    2,
  );
  assert.equal((await budgetStatus(f)).totalReservedMicros, 16 * RUB);
  assert.deepEqual(await oldCharge(), oldSnapshot);
  assert.deepEqual(
    (
      await f.db.query(
        "select * from ai_credit_entries where operation_id=$1",
        [oldSnapshot.hold_id],
      )
    ).rows,
    oldHold,
  );
});

test("lowering a future ceiling does not shrink an old pending hold or reprice its GET-only settlement", async (t) => {
  const f = await fixture(t, 10 * RUB, "routerai_citygo_10x");
  let budget = await budgetStatus(f);
  const configured = await f.call(
    "POST",
    "/v1/admin/ai/budget",
    f.admin.token,
    balanceBudgetInput(budget, 10 * RUB),
  );
  assert.equal(configured.statusCode, 200, configured.body);
  await fundSynthetic100Rub(f);
  // This mocked old receipt exceeds the NEW 6-RUB ceiling but is below its OWN
  // accepted 10-RUB ceiling. No provider or payment network is used.
  f.state.cost = "8";
  f.state.costDown = true;
  assert.match((await f.send()).body, /"type":"done"/);
  const held = (await f.balance()).pending![0]!;
  assert.equal(held.amountMicros, 100 * RUB);
  assert.equal(held.responseComplete, true);
  const charge = async () =>
    (
      await f.db.query<{ value: Record<string, unknown> }>(
        "select row_to_json(c) as value from ai_credit_charges c where c.hold_id=$1 and c.user_id=$2",
        [held.holdId, f.user.id],
      )
    ).rows[0]!.value;
  const original = await charge();
  assert.equal(original.receipt, null);
  budget = await budgetStatus(f);
  const changed = await f.call(
    "POST",
    "/v1/admin/ai/budget",
    f.admin.token,
    balanceBudgetInput(budget, 6 * RUB),
  );
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(await charge(), original);
  assert.equal((await f.balance()).heldMicros, 100 * RUB);
  assert.equal((await f.balance()).availableMicros, 0);
  const beforeDenied = await admissionSnapshot(f);
  assert.match((await f.send()).body, /AI_CREDIT_EXHAUSTED/);
  assert.deepEqual(await admissionSnapshot(f), beforeDenied);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
  f.state.costDown = false;
  const body = {
    userId: f.user.id,
    holdId: held.holdId,
    confirmReconcile: true,
  };
  const reconciled = await f.call(
    "POST",
    "/v1/admin/ai/credit/reconcile",
    f.admin.token,
    body,
  );
  assert.equal(reconciled.statusCode, 200, reconciled.body);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 2);
  const final = await charge();
  assert.deepEqual({ ...final, receipt: null }, original);
  assert.equal((final.receipt as { costRub: string }).costRub, "8");
  const balance = await f.balance();
  assert.equal(balance.spentMicros, 80 * RUB);
  assert.equal(balance.availableMicros, 20 * RUB);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.pending?.length, 0);
  const after = await budgetStatus(f);
  assert.equal(after.settings.enabled, true);
  assert.equal(after.settings.rules[0]!.attemptCeilingMicros, 6 * RUB);
  assert.equal(after.totalReservedMicros, 10 * RUB);
  const replay = await f.call(
    "POST",
    "/v1/admin/ai/credit/reconcile",
    f.admin.token,
    body,
  );
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 2);
  assert.equal(
    (await f.balance()).history.filter((entry) => entry.kind === "settle")
      .length,
    1,
  );
});

test("fixed5 reserves five CityGo, settles exact 10x debt and repays it once from a verified top-up", async (t) => {
  const f = await fixture(
    t,
    6 * RUB,
    "routerai_citygo_10x",
    "fixed5_overdraft",
  );
  await fundFixed5SyntheticCredit(f, 500);
  let balance = await f.balance();
  assert.equal(balance.reservationMode, "fixed5_overdraft");
  assert.equal(balance.minimumRequestBalanceMicros, 5 * RUB);
  assert.equal(balance.outstandingDebtMicros, 0);
  assert.equal(balance.availableMicros, 5 * RUB);
  f.state.cost = "0.8";
  assert.match((await f.send()).body, /"type":"done"/);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
  balance = await f.balance();
  assert.equal(balance.grantedMicros, 5 * RUB);
  assert.equal(balance.spentMicros, 8 * RUB);
  assert.equal(balance.availableMicros, -3 * RUB);
  assert.equal(balance.outstandingDebtMicros, 3 * RUB);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.pending?.length, 0);
  const firstCharge = (
    await f.db.query<{
      hold_id: string;
      reservation_mode: string;
      real_ceiling_micros: string;
      held_micros: string;
      settled_micros: string;
    }>(
      `select c.hold_id,c.reservation_mode,c.real_ceiling_micros::text,
      h.amount_micros::text as held_micros,s.amount_micros::text as settled_micros
      from ai_credit_charges c join ai_credit_entries h on h.operation_id=c.hold_id
      join ai_credit_entries s on s.hold_id=c.hold_id and s.kind='settle' where c.user_id=$1`,
      [f.user.id],
    )
  ).rows[0]!;
  assert.equal(firstCharge.reservation_mode, "fixed5_overdraft");
  assert.equal(firstCharge.real_ceiling_micros, String(6 * RUB));
  assert.equal(firstCharge.held_micros, String(5 * RUB));
  assert.equal(firstCharge.settled_micros, String(8 * RUB));
  assert.deepEqual(
    (
      await f.db.query(
        "select principal_micros::text as principal from credit_charge_debts where hold_id=$1 and user_id=$2",
        [firstCharge.hold_id, f.user.id],
      )
    ).rows,
    [{ principal: String(3 * RUB) }],
  );
  const beforeDenied = await admissionSnapshot(f);
  assert.match((await f.send()).body, /AI_CREDIT_EXHAUSTED/);
  assert.deepEqual(await admissionSnapshot(f), beforeDenied);
  assert.equal((await f.balance()).outstandingDebtMicros, 3 * RUB);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
  const payment = await fundFixed5SyntheticCredit(f, 10000);
  balance = await f.balance();
  assert.equal(balance.grantedMicros, 105 * RUB);
  assert.equal(balance.spentMicros, 8 * RUB);
  assert.equal(balance.availableMicros, 97 * RUB);
  assert.equal(balance.outstandingDebtMicros, 0);
  const paidLot = async () =>
    (
      await f.db.query<{
        gross: string;
        spent: string;
        held: string;
      }>(
        "select gross_micros::text as gross,spent_micros::text as spent,held_micros::text as held from credit_source_lots where paid_operation_id=$1 and user_id=$2",
        [payment.operationId, f.user.id],
      )
    ).rows[0]!;
  assert.deepEqual(await paidLot(), {
    gross: String(100 * RUB),
    spent: String(3 * RUB),
    held: "0",
  });
  assert.deepEqual(
    (
      await f.db.query(
        `select r.amount_micros::text as repaid,l.paid_operation_id as payment from credit_debt_repayments r
        join credit_source_lots l on l.id=r.source_lot_id where r.debt_hold_id=$1 and r.user_id=$2`,
        [firstCharge.hold_id, f.user.id],
      )
    ).rows,
    [{ repaid: String(3 * RUB), payment: payment.operationId }],
  );
  const afterPayment = await admissionSnapshot(f);
  await payment.ledger.topUpConfirmed(
    f.user.id,
    payment.operationId,
    payment.receipt,
  );
  // A provider notification replay can use a new local UUID, but never credits
  // or applies debt repayment a second time for the same verified payment.
  await payment.ledger.topUpConfirmed(f.user.id, randomUUID(), payment.receipt);
  assert.deepEqual(await admissionSnapshot(f), afterPayment);
  assert.equal((await f.balance()).outstandingDebtMicros, 0);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
  assert.match((await f.send()).body, /"type":"done"/);
  balance = await f.balance();
  assert.equal(balance.grantedMicros, 105 * RUB);
  assert.equal(balance.spentMicros, 16 * RUB);
  assert.equal(balance.availableMicros, 89 * RUB);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.outstandingDebtMicros, 0);
  assert.equal(balance.pending?.length, 0);
  assert.equal((await paidLot()).spent, String(11 * RUB));
  assert.equal(f.state.posts, 2);
  assert.equal(f.state.gets, 2);
});

test("fixed5 pending cost blocks another request and owned thread despite a positive free balance", async (t) => {
  const f = await fixture(
    t,
    6 * RUB,
    "routerai_citygo_10x",
    "fixed5_overdraft",
  );
  await fundFixed5SyntheticCredit(f, 10000);
  f.state.cost = "0.8";
  f.state.costDown = true;
  assert.match((await f.send()).body, /"type":"done"/);
  let balance = await f.balance();
  assert.equal(balance.heldMicros, 5 * RUB);
  assert.equal(balance.availableMicros, 95 * RUB);
  assert.equal(balance.spentMicros, 0);
  assert.equal(balance.outstandingDebtMicros, 0);
  assert.equal(balance.pending?.length, 1);
  const pending = balance.pending![0]!;
  assert.equal(pending.amountMicros, 5 * RUB);
  assert.equal(pending.responseComplete, true);
  const beforeDenied = await admissionSnapshot(f);
  const denied = await f.send();
  assert.equal(denied.statusCode, 409);
  assert.match(denied.body, /AI_CREDIT_UNAVAILABLE/);
  assert.deepEqual(await admissionSnapshot(f), beforeDenied);
  // The schema allows one open thread per account. Closing this synthetic
  // thread must not make its unresolved monetary hold cease to protect the user.
  await f.db.query("update agent_threads set status='closed' where id=$1", [
    f.user.thread,
  ]);
  const other = (
    await f.db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values ($1,'housing') returning id::text",
      [f.user.id],
    )
  ).rows[0]!.id;
  const deniedOther = await f.send(randomUUID(), other);
  assert.equal(deniedOther.statusCode, 409);
  assert.match(deniedOther.body, /AI_CREDIT_UNAVAILABLE/);
  assert.deepEqual(await admissionSnapshot(f), beforeDenied);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 3);
  f.state.costDown = false;
  const response = await f.call(
    "POST",
    "/v1/admin/ai/credit/reconcile",
    f.admin.token,
    {
      userId: f.user.id,
      holdId: pending.holdId,
      confirmReconcile: true,
    },
  );
  assert.equal(response.statusCode, 200, response.body);
  balance = await f.balance();
  assert.equal(balance.spentMicros, 8 * RUB);
  assert.equal(balance.availableMicros, 92 * RUB);
  assert.equal(balance.outstandingDebtMicros, 0);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.pending?.length, 0);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 4);
});

test("fixed5 application recreation preserves an old full reservation snapshot", async (t) => {
  const f = await fixture(t, 10 * RUB, "routerai_citygo_10x");
  await fundSynthetic100Rub(f);
  f.state.cost = "8";
  f.state.costDown = true;
  assert.match((await f.send()).body, /"type":"done"/);
  const pending = (await f.balance()).pending![0]!;
  assert.equal(pending.amountMicros, 100 * RUB);
  const snapshot = async () =>
    (
      await f.db.query<{ value: Record<string, unknown> }>(
        "select row_to_json(c) as value from ai_credit_charges c where c.hold_id=$1",
        [pending.holdId],
      )
    ).rows[0]!.value;
  const original = await snapshot();
  assert.equal(original.reservation_mode, "full");
  const switched = await buildApp({
    db: f.db,
    config: { ...f.config, AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft" },
    provider: f.provider,
    testing: true,
  });
  try {
    const call = (
      method: "GET" | "POST",
      path: string,
      token: string,
      body?: object,
    ) =>
      switched.inject({
        method,
        url: path,
        headers: { origin: "http://localhost:3000", cookie: "citygo=" + token },
        ...(body ? { payload: body } : {}),
      });
    const before = (
      await call("GET", "/v1/ai/credit", f.user.token)
    ).json<AiCredit>();
    assert.equal(before.reservationMode, "fixed5_overdraft");
    assert.equal(before.heldMicros, 100 * RUB);
    assert.deepEqual(await snapshot(), original);
    f.state.costDown = false;
    const response = await call(
      "POST",
      "/v1/admin/ai/credit/reconcile",
      f.admin.token,
      {
        userId: f.user.id,
        holdId: pending.holdId,
        confirmReconcile: true,
      },
    );
    assert.equal(response.statusCode, 200, response.body);
    const final = await snapshot();
    assert.deepEqual({ ...final, receipt: null }, original);
    const after = (
      await call("GET", "/v1/ai/credit", f.user.token)
    ).json<AiCredit>();
    assert.equal(after.spentMicros, 80 * RUB);
    assert.equal(after.availableMicros, 20 * RUB);
    assert.equal(after.heldMicros, 0);
    assert.equal(after.outstandingDebtMicros, 0);
    assert.equal(after.pending?.length, 0);
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.gets, 2);
  } finally {
    await switched.close();
  }
});

test("fixed5 still rejects exact external cost above the saved real ceiling without a blind debit or retry", async (t) => {
  const f = await fixture(
    t,
    6 * RUB,
    "routerai_citygo_10x",
    "fixed5_overdraft",
  );
  await fundFixed5SyntheticCredit(f, 500);
  f.state.cost = "6.0000001";
  assert.match((await f.send()).body, /"type":"done"/);
  const balance = await f.balance();
  assert.equal(balance.spentMicros, 0);
  assert.equal(balance.heldMicros, 5 * RUB);
  assert.equal(balance.availableMicros, 0);
  assert.equal(balance.outstandingDebtMicros, 0);
  assert.equal(balance.pending?.length, 1);
  assert.equal((await budgetStatus(f)).settings.enabled, false);
  const charge = (
    await f.db.query<{ receipt: unknown; response_complete: boolean }>(
      "select receipt,response_complete from ai_credit_charges where user_id=$1",
      [f.user.id],
    )
  ).rows[0]!;
  assert.equal(charge.receipt, null);
  assert.equal(charge.response_complete, true);
  assert.equal(
    balance.history.filter((entry) => entry.kind === "settle").length,
    0,
  );
  assert.equal(
    balance.history.filter((entry) => entry.kind === "release").length,
    0,
  );
  assert.match((await f.send()).body, /AI_BUDGET_UNAVAILABLE/);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
});

test("fixed5 admission refuses a real ceiling above six before changing counters or calling the provider", async (t) => {
  const f = await fixture(
    t,
    7 * RUB,
    "routerai_citygo_10x",
    "fixed5_overdraft",
  );
  await fundFixed5SyntheticCredit(f, 10000);
  const before = await admissionSnapshot(f);
  assert.match((await f.send()).body, /"type":"error"/);
  assert.deepEqual(await admissionSnapshot(f), before);
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
});

test("fixed5 admission still requires the full five CityGo initial balance", async (t) => {
  const f = await fixture(
    t,
    6 * RUB,
    "routerai_citygo_10x",
    "fixed5_overdraft",
  );
  await fundFixed5SyntheticCredit(f, 499);
  const before = await admissionSnapshot(f);
  assert.match((await f.send()).body, /AI_CREDIT_EXHAUSTED/);
  assert.deepEqual(await admissionSnapshot(f), before);
  const balance = await f.balance();
  assert.equal(balance.availableMicros, 4990000);
  assert.equal(balance.minimumRequestBalanceMicros, 5 * RUB);
  assert.equal(balance.outstandingDebtMicros, 0);
  assert.equal(balance.heldMicros, 0);
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
});

test("fixed5 interrupted transport keeps its unresolved five CityGo hold without free release or retry", async (t) => {
  const f = await fixture(
    t,
    6 * RUB,
    "routerai_citygo_10x",
    "fixed5_overdraft",
  );
  await fundFixed5SyntheticCredit(f, 10000);
  f.state.interrupted = true;
  assert.match((await f.send()).body, /"type":"error"/);
  const balance = await f.balance();
  assert.equal(balance.spentMicros, 0);
  assert.equal(balance.heldMicros, 5 * RUB);
  assert.equal(balance.availableMicros, 95 * RUB);
  assert.equal(balance.outstandingDebtMicros, 0);
  assert.equal(balance.pending?.length, 1);
  assert.equal(balance.pending![0]!.responseComplete, false);
  assert.equal(
    balance.history.filter((entry) => entry.kind === "release").length,
    0,
  );
  const reconciliation = await f.call(
    "POST",
    "/v1/admin/ai/credit/reconcile",
    f.admin.token,
    {
      userId: f.user.id,
      holdId: balance.pending![0]!.holdId,
      confirmReconcile: true,
    },
  );
  assert.equal(reconciliation.statusCode, 409, reconciliation.body);
  const beforeDenied = await admissionSnapshot(f);
  const historySnapshot = async () => {
    const state: Record<string, unknown[]> = {};
    for (const table of [
      "messages",
      "chat_requests",
      "agent_threads",
      "ai_usage_daily",
      "ai_user_usage_daily",
    ])
      state[table] = (
        await f.db.query(
          `select to_jsonb(t)as value from ${table} t order by to_jsonb(t)::text`,
        )
      ).rows;
    return state;
  };
  const historyBefore = await historySnapshot();
  const charge = (
    await f.db.query<{
      dispatched: boolean;
      response_complete: boolean;
      generation_present: boolean;
      receipt: unknown;
    }>(
      "select dispatched,response_complete,(generation_id is not null)as generation_present,receipt from ai_credit_charges where user_id=$1",
      [f.user.id],
    )
  ).rows[0]!;
  assert.deepEqual(charge, {
    dispatched: true,
    response_complete: false,
    generation_present: true,
    receipt: null,
  });
  const denied = await f.send();
  assert.equal(denied.statusCode, 409);
  assert.match(denied.body, /AI_CREDIT_UNAVAILABLE/);
  assert.deepEqual(await admissionSnapshot(f), beforeDenied);
  assert.deepEqual(
    await historySnapshot(),
    historyBefore,
    "an interrupted generation never creates repeated rejected questions, quota or chat records",
  );
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 0);
});

test("fixed5 paid chat rejects unaware clients before reserving chat while a free human handoff still works", async (t) => {
  const f = await fixture(
    t,
    6 * RUB,
    "routerai_citygo_10x",
    "fixed5_overdraft",
  );
  await fundFixed5SyntheticCredit(f, 500);
  const before = await admissionSnapshot(f);
  const chatRows = async () => ({
    messages: (await f.db.query("select * from messages order by id")).rows,
    requests: (
      await f.db.query(
        "select * from chat_requests order by thread_id,request_id",
      )
    ).rows,
  });
  const oldChat = await chatRows();
  const path = `/v1/threads/${f.user.thread}/messages`;
  for (const creditReservationMode of [undefined, "full"] as const) {
    const response = await f.call("POST", path, f.user.token, {
      text: "Как выбрать квартиру?",
      requestId: randomUUID(),
      policyId: f.user.policyId,
      ...(creditReservationMode ? { creditReservationMode } : {}),
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.headers["content-type"]!, /^application\/json/);
    assert.deepEqual(await admissionSnapshot(f), before);
    assert.deepEqual(await chatRows(), oldChat);
    assert.equal(f.state.posts, 0);
    assert.equal(f.state.gets, 0);
  }
  const human = await f.call("POST", path, f.user.token, {
    text: "Нужен живой риелтор",
    requestId: randomUUID(),
    policyId: f.user.policyId,
  });
  assert.match(human.body, /"type":"done"/);
  assert.deepEqual(await admissionSnapshot(f), before);
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
  f.state.cost = "0.1";
  assert.match((await f.send()).body, /"type":"done"/);
  assert.equal(f.state.posts, 1);
  assert.equal((await f.balance()).spentMicros, RUB);
});

test("a persisted model attempt cannot be relabeled as a pre-dispatch credit refusal", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const request = randomUUID();
  assert.match((await f.send(request)).body, /"type":"done"/);
  const lease = randomUUID();
  await f.db.query(
    "update agent_threads set lease_token=$2,busy_until=now()+interval '3 minutes' where id=$1",
    [f.user.thread, lease],
  );
  const snapshot = async () => {
    const result = [];
    for (const sql of [
      "select lease_token::text,busy_until::text from agent_threads where id=$1",
      "select request_id::text,status from chat_requests where thread_id=$1 order by request_id",
      "select id::text,content,metadata from messages where thread_id=$1 order by id",
      "select * from ai_model_attempts where thread_id=$1 order by request_id,attempt_number",
      "select * from ai_credit_charges where thread_id=$1 order by hold_id",
    ])
      result.push((await f.db.query(sql, [f.user.thread])).rows);
    for (const sql of [
      "select * from ai_credit_entries order by id",
      "select * from ai_credit_accounts order by user_id",
      "select * from ai_budget order by id",
      "select * from ai_budget_daily order by usage_day",
    ])
      result.push((await f.db.query(sql)).rows);
    return result;
  };
  const before = await snapshot();
  assert.equal(before[3]!.length, 1, "the fixture has a real attempt row");
  assert.equal(before[4]!.length, 1, "the fixture has a real charge row");
  await assert.rejects(
    new Repository(f.db).finishChat(
      f.user.thread,
      request,
      lease,
      "housing",
      "false refusal",
      false,
      false,
      undefined,
      undefined,
      "AI_CREDIT_EXHAUSTED",
    ),
    /Причина отказа не соответствует существующей попытке ИИ/,
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
});

test("lost cost lookup keeps hold; owner-only reconciliation survives object recreation and is idempotent", async (t) => {
  const f = await fixture(t);
  await f.grant();
  f.state.costDown = true;
  assert.match((await f.send()).body, /"type":"done"/);
  const pending = (await f.balance()).pending![0]!;
  assert.equal(pending.responseComplete, true);
  assert.equal((await f.balance()).heldMicros, 100 * RUB);
  const path = "/v1/admin/ai/credit/reconcile";
  const body = {
    userId: f.user.id,
    holdId: pending.holdId,
    confirmReconcile: true,
  };
  assert.equal((await f.call("POST", path, "", body)).statusCode, 401);
  assert.equal(
    (await f.call("POST", path, f.user.token, body)).statusCode,
    403,
  );
  assert.equal(
    (await f.call("POST", path, f.admin.token, body, "https://other.example"))
      .statusCode,
    403,
  );
  assert.equal(
    (await f.call("POST", path, f.admin.token, { ...body, userId: f.admin.id }))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.call("POST", path, f.admin.token, { ...body, amountMicros: 0 }))
      .statusCode,
    400,
  );
  f.state.costDown = false;
  const reconstructed = new AiCreditCharges(f.db);
  assert.equal(
    (await reconstructed.get(f.user.id, pending.holdId)).response_complete,
    true,
  );
  const results = await Promise.all([
    f.call("POST", path, f.admin.token, body),
    f.call("POST", path, f.admin.token, body),
  ]);
  results.forEach((r) => assert.equal(r.statusCode, 200, r.body));
  assert.equal(
    (await f.balance()).history.filter((e) => e.kind === "settle").length,
    1,
  );
  const reads = f.state.gets;
  assert.equal(
    (await f.call("POST", path, f.admin.token, body)).statusCode,
    200,
  );
  assert.equal(f.state.gets, reads);
  assert.equal(f.state.posts, 1);
});

test("interrupted transport is never free, never retried and cannot be automatically reconciled", async (t) => {
  const f = await fixture(t);
  await f.grant();
  f.state.interrupted = true;
  const response = await f.send();
  assert.match(response.body, /"type":"error"/);
  assert.match(response.body, /сверки/);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 0);
  const balance = await f.balance();
  assert.equal(balance.heldMicros, 100 * RUB);
  assert.equal(balance.spentMicros, 0);
  assert.equal(balance.pending![0]!.responseComplete, false);
  assert.equal(
    (
      await f.call("POST", "/v1/admin/ai/credit/reconcile", f.admin.token, {
        userId: f.user.id,
        holdId: balance.pending![0]!.holdId,
        confirmReconcile: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(f.state.gets, 0);
  const message = (await f.call("GET", "/v1/dashboard", f.user.token))
    .json<Dashboard>()
    .thread!.messages.at(-1)!;
  assert.equal(message.status, "interrupted");
  assert.equal(message.content, "Проверьте условия аренды.");
  assert.ok(message.generation);
  assert.ok(!message.failureCode);
});

test("an empty response after provider dispatch is not relabeled as a free credit refusal", async (t) => {
  const f = await fixture(t);
  await f.grant();
  f.state.emptyResponse = true;
  const response = await f.send();
  assert.match(response.body, /"type":"error"/);
  assert.doesNotMatch(response.body, /AI_CREDIT_EXHAUSTED/);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 0);
  assert.equal((await f.balance()).heldMicros, 100 * RUB);
  const message = (await f.call("GET", "/v1/dashboard", f.user.token))
    .json<Dashboard>()
    .thread!.messages.at(-1)!;
  assert.equal(message.status, "interrupted");
  assert.equal(message.content, "");
  assert.ok(message.generation);
  assert.ok(!message.failureCode);
});

test("parallel requests cannot overspend one user credit; failed reservation rolls back operator money and attempts", async (t) => {
  const f = await fixture(t, 400 * RUB);
  await f.grant();
  f.state.costDown = true;
  const results = await Promise.all([f.send(), f.send()]);
  assert.equal(
    results.filter((r) => r.body.includes('"type":"done"')).length,
    1,
  );
  assert.ok(
    results.some(
      (r) => r.statusCode === 409 || r.body.includes("AI_CREDIT_EXHAUSTED"),
    ),
  );
  assert.match((await f.send()).body, /AI_CREDIT_EXHAUSTED/);
  assert.equal(f.state.posts, 1);
  assert.equal((await f.balance()).heldMicros, 400 * RUB);
  assert.equal(
    (await f.db.query("select * from ai_model_attempts")).rows.length,
    1,
  );
  assert.equal(
    Number(
      (await f.db.query("select total_reserved_micros from ai_budget")).rows[0]!
        .total_reserved_micros,
    ),
    400 * RUB,
  );
});

test("proven no adapter entry releases user hold; an unknown provider outcome does not", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const mock = t.mock.method(
    AiCreditCharges.prototype,
    "dispatch",
    async () => {
      throw new Error("synthetic dispatch failure");
    },
  );
  t.after(() => {
    mock.mock.resetCalls();
    mock.mock.restore();
  });
  assert.match((await f.send()).body, /"type":"error"/);
  assert.equal(f.state.posts, 0);
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal((await f.balance()).availableMicros, 500 * RUB);
  assert.equal((await f.balance()).history[0]!.kind, "release");
  const message = (await f.call("GET", "/v1/dashboard", f.user.token))
    .json<Dashboard>()
    .thread!.messages.at(-1)!;
  assert.equal(message.status, "interrupted");
  assert.ok(message.generation);
  assert.ok(!message.failureCode);
});

test("cost overrun never overcharges the user and closes the operator budget", async (t) => {
  const f = await fixture(t);
  await f.grant();
  f.state.cost = "101";
  assert.match((await f.send()).body, /"type":"done"/);
  const balance = await f.balance();
  assert.equal(balance.spentMicros, 0);
  assert.equal(balance.heldMicros, 100 * RUB);
  assert.equal(
    (await f.db.query("select enabled from ai_budget")).rows[0]!.enabled,
    false,
  );
  assert.match((await f.send()).body, /AI_BUDGET_UNAVAILABLE/);
  assert.equal(f.state.posts, 1);
});

test("a reused provider generation cannot debit two requests", async (t) => {
  const f = await fixture(t);
  await f.grant();
  f.state.sameId = true;
  assert.match((await f.send()).body, /"type":"done"/);
  assert.match((await f.send()).body, /"type":"error"/);
  assert.equal((await f.balance()).spentMicros, 1234567);
  assert.equal((await f.balance()).heldMicros, 100 * RUB);
  assert.equal(f.state.posts, 2);
  assert.equal(f.state.gets, 1);
});

test("settlement ledger and receipt roll back together when receipt persistence fails", async (t) => {
  const f = await fixture(t);
  await f.grant();
  f.state.costDown = true;
  await f.send();
  const pending = (await f.balance()).pending![0]!;
  const charges = new AiCreditCharges(f.db);
  const charge = await charges.get(f.user.id, pending.holdId);
  f.state.costDown = false;
  const receipt = await f.provider.readCharge(
    charge.generation_id!,
    charge.hold_id,
    AbortSignal.timeout(1000),
  );
  const realTransaction = f.db.transaction.bind(f.db);
  const mock = t.mock.method(
    f.db,
    "transaction",
    <T>(work: (sql: Sql) => Promise<T>) =>
      realTransaction((tx) =>
        work({
          ...tx,
          query: async <R>(sql: string, params?: unknown[]) => {
            if (sql.startsWith("update ai_credit_charges set receipt"))
              throw new Error("synthetic write failure");
            return tx.query<R>(sql, params);
          },
        }),
      ),
  );
  await assert.rejects(
    charges.settle(f.user.id, charge.hold_id, receipt),
    /synthetic write failure/,
  );
  mock.mock.resetCalls();
  mock.mock.restore();
  assert.equal((await f.balance()).spentMicros, 0);
  assert.equal((await f.balance()).heldMicros, 100 * RUB);
  assert.equal((await charges.get(f.user.id, charge.hold_id)).receipt, null);
  await charges.settle(f.user.id, charge.hold_id, receipt);
  assert.equal((await f.balance()).spentMicros, 1234567);
  await assert.rejects(
    new AiCreditLedger(f.db).hold(f.user.id, randomUUID(), 500 * RUB),
    /Недостаточно/,
  );
});

test("user-balance admission snapshots 100 CityGo as 10 real RUB before fixed5 and settles an above-cap actual receipt without administrator or budget pause", async (t) => {
  const f = await fixture(
    t,
    6 * RUB,
    "routerai_citygo_10x",
    "fixed5_overdraft",
    "user_balance",
  );
  await fundSynthetic100Rub(f);
  f.state.cost = "20.000000123";
  const before = await budgetStatus(f);
  const request = randomUUID();
  const response = await f.send(request);
  assert.match(response.body, /"type":"done"/);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
  const balance = await f.balance();
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.spentMicros, 200_000_001);
  assert.equal(balance.availableMicros, -100_000_001);
  assert.equal(balance.outstandingDebtMicros, 100_000_001);
  const rows = await f.db.query<{
    mode: string;
    balance: string;
    ceiling: string;
    held: string;
    debit: string;
    receipt: { costRub: string };
  }>(
    `select c.cost_limit_mode as mode,c.balance_before_hold_micros::text as balance,c.real_ceiling_micros::text as ceiling,
     h.amount_micros::text as held,s.amount_micros::text as debit,c.receipt
     from ai_credit_charges c join ai_credit_entries h on h.operation_id=c.hold_id
     join ai_credit_entries s on s.hold_id=c.hold_id where c.user_id=$1`,
    [f.user.id],
  );
  assert.equal(rows.rows.length, 1);
  assert.deepEqual(
    { ...rows.rows[0], receipt: undefined },
    {
      mode: "user_balance",
      balance: "100000000",
      ceiling: "10000000",
      held: "5000000",
      debit: "200000001",
      receipt: undefined,
    },
  );
  assert.equal(rows.rows[0]!.receipt.costRub, "20.000000123");
  const after = await budgetStatus(f);
  assert.equal(after.settings.enabled, true);
  assert.equal(after.settings.revision, before.settings.revision);
  assert.equal(
    after.totalReservedMicros - before.totalReservedMicros,
    10 * RUB,
  );
  assert.equal(
    (
      await f.db.query(
        "select id from audit_log where action='ai-credit-balance-limit-exceeded'",
      )
    ).rows.length,
    1,
  );
  // The request UUID cannot dispatch or debit twice, even on explicit replay.
  await f.send(request);
  assert.equal(f.state.posts, 1);
  assert.equal((await f.balance()).spentMicros, 200_000_001);
});

test("unknown user-balance cost remains held; the next explicit message only recovers by GET before its one new model POST", async (t) => {
  const f = await fixture(
    t,
    6 * RUB,
    "routerai_citygo_10x",
    "fixed5_overdraft",
    "user_balance",
  );
  await fundSynthetic100Rub(f);
  f.state.costDown = true;
  assert.match((await f.send()).body, /"type":"done"/);
  assert.equal(f.state.posts, 1);
  let balance = await f.balance();
  assert.equal(balance.spentMicros, 0);
  assert.equal(balance.heldMicros, 5 * RUB);
  assert.equal(balance.availableMicros, 95 * RUB);
  assert.match((await f.send()).body, /AI_CREDIT_UNAVAILABLE/);
  assert.equal(
    f.state.posts,
    1,
    "Unconfirmed cost must never retry the model POST",
  );
  assert.equal((await budgetStatus(f)).settings.enabled, true);
  f.state.costDown = false;
  f.state.cost = "1.234567891";
  assert.match((await f.send()).body, /"type":"done"/);
  assert.equal(
    f.state.posts,
    2,
    "One newly requested answer after recovering the old receipt",
  );
  balance = await f.balance();
  assert.equal(balance.spentMicros, 24_691_356);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.pending?.length, 0);
  assert.equal(
    (
      await f.db.query(
        "select id from ai_credit_entries where user_id=$1 and kind='settle'",
        [f.user.id],
      )
    ).rows.length,
    2,
  );
});

test("a late known above-balance receipt is recovered automatically by GET, clears fixed5 and prevents a new model call until the negative balance is funded", async (t) => {
  const f = await fixture(
    t,
    6 * RUB,
    "routerai_citygo_10x",
    "fixed5_overdraft",
    "user_balance",
  );
  await fundSynthetic100Rub(f);
  f.state.costDown = true;
  assert.match((await f.send()).body, /"type":"done"/);
  assert.equal((await f.balance()).heldMicros, 5 * RUB);
  f.state.costDown = false;
  f.state.cost = "20.000000123";
  assert.match((await f.send()).body, /AI_CREDIT_EXHAUSTED/);
  assert.equal(
    f.state.posts,
    1,
    "GET settlement of an old charge never dispatches a model",
  );
  const balance = await f.balance();
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.availableMicros, -100_000_001);
  assert.equal(balance.spentMicros, 200_000_001);
  assert.equal((await budgetStatus(f)).settings.enabled, true);
  assert.equal(
    (
      await f.db.query(
        "select id from ai_credit_entries where user_id=$1 and kind='settle'",
        [f.user.id],
      )
    ).rows.length,
    1,
  );
});
