import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  AiCreditCharges,
  AiCreditLedger,
  connectDatabase,
  migrate,
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
  ceiling = 100 * RUB,
  mode: "routerai_at_cost" | "routerai_citygo_10x" = "routerai_at_cost",
) {
  const base = process.env.TEST_DATABASE_URL;
  if (base && !/^postgres(?:ql)?:\/\//.test(base))
    throw new Error("Invalid test database");
  const schema = "charging_test_" + randomUUID().replaceAll("-", "");
  const adminDb = base ? await connectDatabase(base) : null;
  let url = "pglite://:memory:";
  if (adminDb && base) {
    await adminDb.query('create schema "' + schema + '"');
    const scoped = new URL(base);
    scoped.searchParams.set("options", "-c search_path=" + schema);
    url = scoped.toString();
  }
  const db = await connectDatabase(url);
  await migrate(db);
  const state = {
    posts: 0,
    gets: 0,
    cost: "1.23456789",
    costDown: false,
    interrupted: false,
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
          JSON.stringify(receipt).replace(/}$/, `,"total_cost":${state.cost}}`),
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
      const events: unknown[] = [chunk("Проверьте условия аренды.")];
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
    async close() {
      await app.close();
      await db.close();
      if (adminDb) {
        await adminDb.query('drop schema "' + schema + '" cascade');
        await adminDb.close();
      }
    },
  };
}

test("RouterAI bonus admission, exact at-cost debit, request replay and history", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const blocked = await f.send();
  assert.match(blocked.body, /AI_CREDIT_EXHAUSTED/);
  assert.equal(f.state.posts, 0);
  assert.equal(
    (await f.db.query("select * from ai_model_attempts")).rows.length,
    0,
  );
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
  const f = await fixture(10 * RUB, "routerai_citygo_10x");
  t.after(f.close);
  assert.equal((await f.grant()).statusCode, 503);
  assert.equal((await f.balance()).bonusGranted, false);
  assert.match((await f.send()).body, /AI_CREDIT_EXHAUSTED/);
  assert.equal(f.state.posts, 0);
  // The trusted payment boundary is synthetic here. No real payment or gift is
  // invented on the server; the future YooKassa adapter must perform its GET.
  await new AiCreditLedger(f.db).topUpConfirmed(f.user.id, randomUUID(), {
    providerPaymentId: "synthetic-payment-" + randomUUID(),
    paidKopeks: 20000,
    merchantId: "synthetic-shop",
    test: true,
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

test("lost cost lookup keeps hold; owner-only reconciliation survives object recreation and is idempotent", async (t) => {
  const f = await fixture();
  t.after(f.close);
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
  const f = await fixture();
  t.after(f.close);
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
});

test("parallel requests cannot overspend one user credit; failed reservation rolls back operator money and attempts", async (t) => {
  const f = await fixture(400 * RUB);
  t.after(f.close);
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
  const f = await fixture();
  t.after(f.close);
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
});

test("cost overrun never overcharges the user and closes the operator budget", async (t) => {
  const f = await fixture();
  t.after(f.close);
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
  const f = await fixture();
  t.after(f.close);
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
  const f = await fixture();
  t.after(f.close);
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
