import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readConfig } from "@citygo/config";
import {
  AiCreditLedger,
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
} from "@citygo/db";
import {
  dashboardResponseSchema,
  type AiCredit,
  type AiModeId,
  type AgentKey,
} from "@citygo/contracts";
import type {
  ModelMessage,
  ModelRetryGuard,
  StreamingProvider,
} from "@citygo/llm";
import { buildApp } from "./app.js";
import { createAssistantModes, type ModeProviders } from "./ai-modes.js";
import { syntheticConsentsFor } from "./test-service-consents.js";
import { hashPassword, tokenHash } from "./auth.js";

async function fixture(
  t: TestContext,
  options: {
    minimum?: "free" | "fixed";
    legacy?: boolean;
    agentKey?: AgentKey;
  } = {},
) {
  const minimum = options.minimum !== undefined;
  const freeMinimum = options.minimum === "free";
  const fixedMinimum = options.minimum === "fixed";
  const db = await connectDatabase("pglite://:memory:");
  const cleanup: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  let markMinimumStarted!: () => void;
  let releaseMinimum!: () => void;
  const minimumStarted = new Promise<void>((resolve) => {
    markMinimumStarted = resolve;
  });
  const minimumGate = new Promise<void>((resolve) => {
    releaseMinimum = resolve;
  });
  const control = {
    blockMinimum: false,
    minimumRaw: "Синтетический ответ minimum",
  };
  t.after(async () => {
    releaseMinimum();
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
        let held = "0";
        if (fixedMinimum) {
          const fees = (
            await db.query<{
              state: string;
              held: string;
              snapshot: Record<string, unknown>;
            }>(
              `select f.state,f.snapshot,e.amount_micros::text as held
 from gigachat_request_fees f join ai_credit_entries e on e.operation_id=f.hold_id and e.kind='hold'
 where f.state='dispatched'`,
            )
          ).rows;
          assert.equal(fees.length, 1);
          assert.equal(fees[0]!.held, "5000000");
          assert.equal(fees[0]!.snapshot.feeCitygoMicros, 3000000);
          assert.equal(fees[0]!.snapshot.operatorCostRubMicros, 0);
          held = fees[0]!.held;
        }
        calls.push({
          mode: "minimum",
          messages: structuredClone(messages),
          held,
        });
        markMinimumStarted();
        if (control.blockMinimum) await minimumGate;
        yield { type: "delta", text: control.minimumRaw };
        if (failures.has("minimum"))
          throw Error("Synthetic Minimum stream interrupted");
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
    AI_CREDIT_MODE: freeMinimum ? "disabled" : "routerai_citygo_10x",
    AI_CREDIT_RESERVATION_MODE: freeMinimum ? "full" : "fixed5_overdraft",
    ...(minimum
      ? {
          GIGACHAT_MODEL: "GigaChat-3-Ultra",
          GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
          ...(fixedMinimum
            ? {
                AI_MINIMUM_FIXED_FEE: "enabled",
                GIGACHAT_CREDENTIALS: Buffer.from(
                  "synthetic-http-account:synthetic-http-secret",
                ).toString("base64"),
              }
            : {}),
        }
      : {}),
    ROUTERAI_MODEL: "deepseek/deepseek-v4-pro-0813",
    ROUTERAI_UPSTREAM: "deepseek",
    ROUTERAI_COUNTRY: "cn",
    ...(options.legacy
      ? {
          ROUTERAI_DATA_NOTICE: "Synthetic original recipient notice.",
          LLM_MAX_INPUT_BYTES: "8192",
          ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
        }
      : {}),
  });
  const modes = createAssistantModes(config, modeProviders)!;
  let legacyToken: string | undefined;
  if (options.legacy) {
    const compatibility = modes.legacyBalancedCompatibility!;
    assert.ok(compatibility);
    await new Repository(db).initializeAiRouting(compatibility.policy);
    const originalConsents = new ServiceConsents(
      db,
      () => compatibility.policy,
    );
    const policy = await originalConsents.policy();
    legacyToken = randomUUID();
    await originalConsents.register(
      randomUUID() + "@example.test",
      await hashPassword("123456"),
      tokenHash(legacyToken),
      { policyVersion: policy.version, personalData: true, marketing: true },
    );
    // A synthetic operator activates the new bundle; it grants no user consent.
    await db.query(
      "update ai_routing set policy_id=$1,revision=revision+1 where id=1",
      [modes.policy.id],
    );
  }
  await db.query(
    "update ai_budget set enabled=true,mode='routerai_balance',currency='RUB',daily_limit_micros=null,total_limit_micros=null,rules=$1 where id=1",
    [
      JSON.stringify(
        [
          ...modes.routes
            .filter((route) => route.provider && !route.fixedFee)
            .map((route) => route.execution),
          ...(options.legacy
            ? [modes.legacyBalancedCompatibility!.execution]
            : []),
        ].map((execution) => ({
          ...execution,
          attemptCeilingMicros: 6000000,
        })),
      ),
    ],
  );
  if (freeMinimum)
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
  let token = legacyToken;
  if (!token) {
    const registration = await call("POST", "/v1/auth/register", "", {
      email: randomUUID() + "@example.test",
      password: "123456",
      consents: await syntheticConsentsFor(app),
    });
    assert.equal(registration.statusCode, 200, registration.body);
    token = registration.cookies[0]!.value;
  }
  const board = dashboardResponseSchema.parse(
    (await call("GET", "/v1/dashboard", token)).json(),
  );
  const ledger = new AiCreditLedger(
    db,
    "routerai_citygo_10x",
    false,
    "fixed5_overdraft",
  );
  if (!freeMinimum)
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
    agentKey: options.agentKey ?? "housing",
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
    control,
    minimumStarted,
    releaseMinimum,
  };
}

test("Minimum CV: clarification and rejected/interrupted plans cost no fixed fee; one validated draft settles exactly 3 RUB", async (t) => {
  const f = await fixture(t, { minimum: "fixed", agentKey: "job-search" });
  const question =
    "Адаптируй резюме. Факты профиля: SQL. Требования вакансии: Power BI; объяснять бизнесу.";
  const before = await f.balance();
  const clarification = await f.send(
    "minimum",
    "Составь резюме. Вакансия: Power BI.",
  );
  assert.match(clarification.body, /"type":"done"/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.balance(), before);
  f.control.minimumRaw = JSON.stringify({
    sections: [{ kind: "skills", facts: [{ id: "F1", quote: "SQL." }] }],
    advice: ["business", "review"],
    question: "business",
  });
  const accepted = await f.send("minimum", question);
  assert.match(accepted.body, /"type":"done"/);
  assert.doesNotMatch(accepted.body, /"type":"error"/);
  assert.equal((await f.balance()).spentMicros, 3_000_000);
  assert.equal((await f.balance()).heldMicros, 0);
  f.control.minimumRaw = "Владею Power BI, рост выручки 40%";
  const rejected = await f.send("minimum", question);
  assert.match(rejected.body, /VALIDATION_ERROR/);
  assert.doesNotMatch(
    rejected.body,
    /Владею Power BI|рост выручки|"type":"done"/,
  );
  assert.equal((await f.balance()).spentMicros, 3_000_000);
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal(f.calls.length, 2);
  // Failed requests conservatively keep the provider capacity lease until its
  // deadline. Use a fresh isolated provider account for the interruption case,
  // rather than weakening that production no-blind-retry guard for this test.
  const g = await fixture(t, { minimum: "fixed", agentKey: "job-search" });
  g.control.minimumRaw = "Владею Power BI, рост выручки 40%";
  g.failures.add("minimum");
  const interrupted = await g.send("minimum", question);
  assert.match(interrupted.body, /"type":"error"/);
  assert.doesNotMatch(
    interrupted.body,
    /Владею Power BI|рост выручки|"type":"done"/,
  );
  assert.equal((await g.balance()).spentMicros, 0);
  assert.equal((await g.balance()).heldMicros, 0);
  const history = (
    await f.db.query<{ content: string }>(
      "select content from messages where thread_id=$1 and role='assistant'",
      [f.threadId],
    )
  ).rows;
  assert.doesNotMatch(JSON.stringify(history), /Владею Power BI|рост выручки/);
  assert.equal(g.calls.length, 1);
  const interruptedHistory = (
    await g.db.query<{ content: string }>(
      "select content from messages where thread_id=$1 and role='assistant'",
      [g.threadId],
    )
  ).rows;
  assert.doesNotMatch(
    JSON.stringify(interruptedHistory),
    /Владею Power BI|рост выручки/,
  );
  assert.equal(f.reads.length, 0);
});

test("HTTP retained consent keeps original Balanced usable without rewriting grants and blocks new recipients before any reservation", async (t) => {
  const f = await fixture(t, { legacy: true, minimum: "fixed" });
  const consentBefore = (
    await f.db.query("select * from service_consent_events order by id")
  ).rows;
  const aiBefore = (await f.db.query("select * from ai_consents")).rows;
  assert.equal(f.board.user.serviceConsentRequired, false);
  assert.equal(f.board.aiAccess.granted, true);
  assert.notEqual(f.board.aiAccess.modes!.catalogId, f.modes.catalogId);
  assert.deepEqual(
    f.board.aiAccess.modes!.options.map(
      ({ id, available, consentRequired }) => [
        id,
        available,
        Boolean(consentRequired),
      ],
    ),
    [
      ["maximum", true, true],
      ["balanced", true, false],
      ["minimum", true, true],
    ],
  );
  const before = await f.balance();
  for (const mode of ["maximum", "minimum"] as const) {
    const blocked = await f.send(
      mode,
      "Новый получатель ещё не выбран",
      randomUUID(),
      { aiModeCatalogId: f.board.aiAccess.modes!.catalogId },
    );
    assert.equal(blocked.statusCode, 403, blocked.body);
    assert.equal(blocked.json().code, "AI_MODES_CONSENT_REQUIRED");
  }
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.db.query("select 1 from chat_requests")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_request_consent_bases")).rows.length,
    0,
  );
  assert.deepEqual(await f.balance(), before);
  const answer = await f.send(
    "balanced",
    "Последний вопрос старому получателю",
    randomUUID(),
    { aiModeCatalogId: f.board.aiAccess.modes!.catalogId },
  );
  assert.match(answer.body, /"type":"done"/);
  assert.equal(f.calls[0]!.held, "5000000");
  assert.equal((await f.balance()).spentMicros, 1_000_000);
  const frozen = (
    await f.db.query<{
      policy_id: string;
      execution_key: string;
      consent_policy_id: string;
    }>("select policy_id,execution_key,consent_policy_id from ai_request_modes")
  ).rows[0]!;
  assert.equal(
    frozen.policy_id,
    f.modes.legacyBalancedCompatibility!.policy.id,
  );
  assert.equal(
    frozen.execution_key,
    f.modes.legacyBalancedCompatibility!.execution.key,
  );
  assert.equal(frozen.consent_policy_id, f.modes.policy.id);
  assert.deepEqual(
    (await f.db.query("select * from service_consent_events order by id")).rows,
    consentBefore,
  );
  assert.deepEqual(
    (await f.db.query("select * from ai_consents")).rows,
    aiBefore,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_request_consent_bases")).rows.length,
    1,
  );
});

test("HTTP first-mode consent is explicit, account-bound, preserves marketing and invalidates a stale legacy tab", async (t) => {
  const f = await fixture(t, { legacy: true, minimum: "fixed" });
  const before = (
    await f.db.query("select * from service_consent_events order by id")
  ).rows;
  const state = (await f.call("GET", "/v1/account/consents", f.token)).json();
  assert.equal(state.currentAiConsentRequired, true);
  const input = {
    policyVersion: state.policy.version,
    policyId: f.modes.policy.id,
    personalData: true,
    expectedUserId: f.board.user.id,
  };
  assert.equal(
    (await f.call("POST", "/v1/account/ai-modes-consent", "", input))
      .statusCode,
    401,
  );
  for (const [patch, code] of [
    [{ personalData: false }, 400],
    [{ policyId: "0".repeat(64) }, 409],
    [{ policyVersion: "stale" }, 409],
    [{ expectedUserId: f.board.user.id === "1" ? "2" : "1" }, 409],
    [{ marketing: false }, 400],
  ] as const) {
    const rejected = await f.call(
      "POST",
      "/v1/account/ai-modes-consent",
      f.token,
      { ...input, ...patch },
    );
    assert.equal(rejected.statusCode, code, rejected.body);
  }
  assert.deepEqual(
    (await f.db.query("select * from service_consent_events order by id")).rows,
    before,
  );
  const accepted = await f.call(
    "POST",
    "/v1/account/ai-modes-consent",
    f.token,
    input,
  );
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().currentAiConsentRequired, false);
  assert.equal(accepted.json().serviceConsentRequired, false);
  assert.equal(accepted.json().marketingGranted, true);
  const marketing = (
    await f.db.query(
      "select * from service_consent_events where purpose='marketing' order by id",
    )
  ).rows;
  assert.deepEqual(
    marketing,
    before.filter((event) => event.purpose === "marketing"),
  );
  const repeat = await f.call(
    "POST",
    "/v1/account/ai-modes-consent",
    f.token,
    input,
  );
  assert.equal(repeat.statusCode, 200, repeat.body);
  const stale = await f.send(
    "balanced",
    "Старый выбор нельзя переосмысливать",
    randomUUID(),
    { aiModeCatalogId: f.board.aiAccess.modes!.catalogId },
  );
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().code, "AI_MODE_CHANGED");
  assert.equal(f.calls.length, 0);
  const refreshed = dashboardResponseSchema.parse(
    (await f.call("GET", "/v1/dashboard", f.token)).json(),
  );
  assert.equal(refreshed.aiAccess.modes!.catalogId, f.modes.catalogId);
  assert.ok(
    refreshed.aiAccess.modes!.options.every(
      (option) => !option.consentRequired,
    ),
  );
  assert.match(
    (await f.send("maximum", "Новый вопрос после явного согласия")).body,
    /"type":"done"/,
  );
  assert.equal((await f.balance()).spentMicros, 2_000_000);
});

test("HTTP legacy catalog checks the actual old execution budget, not the new Balanced rule", async (t) => {
  const f = await fixture(t, { legacy: true });
  const currentRules = f.modes.routes
    .filter((route) => route.provider && !route.fixedFee)
    .map((route) => ({ ...route.execution, attemptCeilingMicros: 6000000 }));
  await f.db.query("update ai_budget set rules=$1 where id=1", [
    JSON.stringify(currentRules),
  ]);
  const board = dashboardResponseSchema.parse(
    (await f.call("GET", "/v1/dashboard", f.token)).json(),
  );
  assert.equal(
    board.aiAccess.modes!.options.find((option) => option.id === "balanced")!
      .available,
    false,
  );
  assert.equal(
    board.aiAccess.modes!.options.find((option) => option.id === "maximum")!
      .available,
    true,
  );
});

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
  const f = await fixture(t, { minimum: "free" });
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

test("HTTP fixed Minimum keeps all three modes in one history and charges three only after success while RouterAI stays times ten", async (t) => {
  const f = await fixture(t, { minimum: "fixed" });
  assert.deepEqual(f.board.aiAccess.modes!.options[2], {
    id: "minimum",
    label: "Минимум",
    available: true,
    price: { kind: "fixed", currency: "RUB", amountMicros: 3_000_000 },
  });
  assert.match(
    (await f.send("balanced", "Первый вопрос о переезде")).body,
    /"type":"done"/,
  );
  const beforeMinimumOperator = (
    await f.db.query("select * from ai_budget_daily")
  ).rows;
  assert.match(
    (await f.send("minimum", "Второй вопрос: с чего начать?")).body,
    /"type":"done"/,
  );
  assert.deepEqual(
    (await f.db.query("select * from ai_budget_daily")).rows,
    beforeMinimumOperator,
    "the product fee must not fabricate operator expense",
  );
  assert.match(
    (await f.send("maximum", "Последний вопрос: что сделать сегодня?")).body,
    /"type":"done"/,
  );
  assert.deepEqual(
    f.calls.map((call) => [call.mode, call.held]),
    [
      ["balanced", "5000000"],
      ["minimum", "5000000"],
      ["maximum", "5000000"],
    ],
  );
  assert.deepEqual(f.calls[2]!.messages.slice(1), [
    { role: "user", content: "Первый вопрос о переезде" },
    { role: "assistant", content: "Синтетический ответ balanced" },
    { role: "user", content: "Второй вопрос: с чего начать?" },
    { role: "assistant", content: "Синтетический ответ minimum" },
    { role: "user", content: "Последний вопрос: что сделать сегодня?" },
  ]);
  assert.deepEqual(f.reads, ["balanced", "maximum"]);
  const balance = await f.balance();
  assert.equal(balance.spentMicros, 6_000_000);
  assert.equal(balance.availableMicros, 94_000_000);
  assert.equal(balance.heldMicros, 0);
  const fee = (
    await f.db.query<{
      state: string;
      response_message_id: string;
      snapshot: Record<string, unknown>;
    }>("select state,response_message_id,snapshot from gigachat_request_fees")
  ).rows;
  assert.equal(fee.length, 1);
  assert.equal(fee[0]!.state, "succeeded");
  assert.ok(fee[0]!.response_message_id);
  assert.equal(fee[0]!.snapshot.feeCitygoMicros, 3_000_000);
  assert.equal(fee[0]!.snapshot.operatorCostRubMicros, 0);
  assert.deepEqual(
    (
      await f.db.query(
        "select money_currency,money_reserved_micros,money_rule_key from ai_model_attempts where provider='gigachat'",
      )
    ).rows,
    [
      {
        money_currency: null,
        money_reserved_micros: null,
        money_rule_key: null,
      },
    ],
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_charges")).rows.length,
    2,
  );
  const reloaded = await f.call(
    "GET",
    `/v1/conversations/${f.threadId}`,
    f.token,
  );
  assert.equal(reloaded.statusCode, 200, reloaded.body);
  assert.deepEqual(
    reloaded
      .json<{ thread: { messages: { content: string }[] } }>()
      .thread.messages.map((message) => message.content),
    [
      "Первый вопрос о переезде",
      "Синтетический ответ balanced",
      "Второй вопрос: с чего начать?",
      "Синтетический ответ minimum",
      "Последний вопрос: что сделать сегодня?",
      "Синтетический ответ maximum",
    ],
  );
});

test("HTTP interrupted fixed Minimum returns the five-ruble hold and rejects duplicate dispatch without a fabricated charge", async (t) => {
  const f = await fixture(t, { minimum: "fixed" });
  f.failures.add("minimum");
  const id = randomUUID();
  const failed = await f.send("minimum", "Один прерванный ответ", id);
  assert.match(failed.body, /"code":"STREAM_INTERRUPTED"/);
  assert.doesNotMatch(failed.body, /"type":"done"/);
  const balance = await f.balance();
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.spentMicros, 0);
  assert.equal(balance.availableMicros, 100_000_000);
  assert.deepEqual(
    (await f.db.query("select state from gigachat_request_fees")).rows,
    [{ state: "failed" }],
  );
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.send("minimum", "Один прерванный ответ", id)).statusCode,
    409,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.reads.length, 0);
  assert.equal(
    (await f.db.query("select 1 from ai_model_attempts")).rows.length,
    1,
  );
  assert.equal(
    (await f.db.query("select 1 from gigachat_request_fees")).rows.length,
    1,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_charges")).rows.length,
    0,
  );
});

test("HTTP fixed Minimum obeys the global administrative stop before provider transport and money hold", async (t) => {
  const f = await fixture(t, { minimum: "fixed" });
  await f.db.query("update ai_budget set enabled=false where id=1");
  const board = dashboardResponseSchema.parse(
    (await f.call("GET", "/v1/dashboard", f.token)).json(),
  );
  assert.equal(board.aiAccess.modes!.options[2]!.available, false);
  const stopped = await f.send("minimum", "Не отправлять провайдеру");
  assert.match(stopped.body, /"code":"AI_BUDGET_UNAVAILABLE"/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.reads.length, 0);
  assert.equal((await f.balance()).availableMicros, 100_000_000);
  for (const table of [
    "ai_model_attempts",
    "gigachat_request_fees",
    "ai_credit_charges",
  ])
    assert.equal((await f.db.query(`select 1 from ${table}`)).rows.length, 0);
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries where kind='hold'")).rows
      .length,
    0,
  );
});

test(
  "HTTP fixed Minimum account capacity refuses a concurrent different user without charging and releases the slot after completion",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, { minimum: "fixed" });
    const second = await f.call("POST", "/v1/auth/register", "", {
      email: randomUUID() + "@example.test",
      password: "123456",
      consents: await syntheticConsentsFor(f.app),
    });
    assert.equal(second.statusCode, 200, second.body);
    const token = second.cookies[0]!.value;
    const board = dashboardResponseSchema.parse(
      (await f.call("GET", "/v1/dashboard", token)).json(),
    );
    const ledger = new AiCreditLedger(
      f.db,
      "routerai_citygo_10x",
      false,
      "fixed5_overdraft",
    );
    await ledger.topUpConfirmed(board.user.id, randomUUID(), {
      providerPaymentId: "synthetic-concurrent-payment-" + randomUUID(),
      merchantId: "synthetic-shop",
      paidKopeks: 10000,
      currency: "RUB",
      test: false,
      verifiedAt: new Date().toISOString(),
      verification: "server_get_succeeded",
    });
    const conversation = await f.call(
      "POST",
      "/v1/conversations/start",
      token,
      { agentKey: "support" },
    );
    assert.equal(conversation.statusCode, 200, conversation.body);
    const thread = conversation.json<{ id: string }>().id;
    const sendSecond = () =>
      f.call("POST", `/v1/threads/${thread}/messages`, token, {
        text: "Второй владелец ждёт свободный режим",
        requestId: randomUUID(),
        aiMode: "minimum",
        aiModeCatalogId: f.modes.catalogId,
        policyId: f.modes.policy.id,
        creditReservationMode: "fixed5_overdraft",
      });
    f.control.blockMinimum = true;
    const pending = f.send("minimum", "Первый владелец занял режим");
    await f.minimumStarted;
    try {
      const active = await f.balance();
      assert.equal(active.heldMicros, 5_000_000);
      assert.equal(active.availableMicros, 95_000_000);
      assert.equal(active.pending!.length, 1);
      assert.equal(active.pending![0]!.amountMicros, 5_000_000);
      assert.equal(active.pending![0]!.responseComplete, false);
      const busy = await sendSecond();
      assert.match(busy.body, /"code":"AI_MODE_UNAVAILABLE"/);
      assert.equal(f.calls.length, 1);
      const balance = await ledger.status(board.user.id);
      assert.equal(balance.heldMicros, 0);
      assert.equal(balance.spentMicros, 0);
      assert.equal(balance.availableMicros, 100_000_000);
      assert.equal(
        (await f.db.query("select 1 from gigachat_request_fees")).rows.length,
        1,
      );
    } finally {
      f.releaseMinimum();
    }
    assert.match((await pending).body, /"type":"done"/);
    f.control.blockMinimum = false;
    assert.match((await sendSecond()).body, /"type":"done"/);
    assert.equal(f.calls.length, 2);
    assert.equal((await ledger.status(board.user.id)).spentMicros, 3_000_000);
    assert.equal(f.reads.length, 0);
  },
);
