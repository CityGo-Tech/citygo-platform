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
import type { Dashboard, AiCredit } from "@citygo/contracts";
import { buildApp } from "./app.js";
import { seedTestBudget } from "./test-budget.js";

const RUB = 1_000_000;
async function fixture(
  t: TestContext,
  ceiling = 100 * RUB,
  mode: "routerai_at_cost" | "routerai_citygo_10x" = "routerai_at_cost",
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
  };
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
