import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readConfig } from "@citygo/config";
import {
  AiCreditLedger,
  AiCreditCharges,
  PostpayCharges,
  ClosedAccountRestart,
  FreshAccountReset,
  reservePaidRefund,
  releasePaidRefund,
  listPaidSourceLots,
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
} from "@citygo/db";
import {
  CITYGO_10X_TARIFF,
  aiControlResponseSchema,
  routerAiCostMicros,
  dashboardResponseSchema,
  conversationDetailResponseSchema,
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
import { hashPassword, tokenHash } from "./auth.js";

async function fixture(
  t: TestContext,
  options: {
    minimum?: "free" | "fixed";
    legacy?: boolean;
    balanceLimit?: boolean;
    postpay?: boolean;
    postgres?: boolean;
    initialKopeks?: number;
    memory?: boolean;
  } = {},
) {
  const minimum = options.minimum !== undefined;
  const freeMinimum = options.minimum === "free";
  const fixedMinimum = options.minimum === "fixed";
  let bootstrap: Awaited<ReturnType<typeof connectDatabase>> | undefined;
  let databaseUrl = "pglite://:memory:";
  const namespace = randomUUID().replaceAll("-", "");
  const databaseName = "postpay_test_" + namespace;
  const roles = {
    citygo_api: "cgpost_api_" + namespace,
    citygo_worker: "cgpost_worker_" + namespace,
    citygo_backup: "cgpost_backup_" + namespace,
    citygo_migrator: "cgpost_migrator_" + namespace,
  };
  const createdRoles: string[] = [];
  if (options.postgres) {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(
      (url.hostname === "127.0.0.1" &&
        ["55438", "55439"].includes(url.port) &&
        url.pathname === "/citygo_synthetic") ||
        (["localhost", "127.0.0.1"].includes(url.hostname) &&
          (url.port || "5432") === "5432" &&
          url.pathname === "/citygo_test"),
    );
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    // The trusted standard CI target is loopback too; use its IPv4 endpoint.
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    bootstrap = await connectDatabase(url.toString());
    await bootstrap.query(
      `create database "${databaseName}" template template0`,
    );
    url.pathname = "/" + databaseName;
    databaseUrl = url.toString();
  }
  const ownerDb = await connectDatabase(databaseUrl);
  let db = ownerDb;
  const peers: Awaited<ReturnType<typeof connectDatabase>>[] = [];
  const cleanup: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  let markMinimumStarted!: () => void;
  let releaseMinimum!: () => void;
  const minimumStarted = new Promise<void>((resolve) => {
    markMinimumStarted = resolve;
  });
  const minimumGate = new Promise<void>((resolve) => {
    releaseMinimum = resolve;
  });
  let markCounterStarted!: () => void;
  let releaseCounter!: () => void;
  const counterStarted = new Promise<void>((resolve) => {
    markCounterStarted = resolve;
  });
  const counterGate = new Promise<void>((resolve) => {
    releaseCounter = resolve;
  });
  const control = {
    blockMinimum: false,
    blockCounter: false,
    failCounter: false,
    overCounter: false,
    counterCalls: 0,
  };
  t.after(async () => {
    releaseMinimum();
    releaseCounter();
    await cleanup.app?.close();
    for (const peer of peers) await peer.close();
    await ownerDb.close();
    if (bootstrap) {
      await bootstrap.query(`drop database "${databaseName}"`);
      for (const role of createdRoles)
        await bootstrap.query(`drop role "${role}"`);
      await bootstrap.close();
    }
  });
  if (options.postgres) {
    assert.equal(
      (
        await ownerDb.query(
          "select rolname from pg_roles where rolname=any($1::text[])",
          [Object.values(roles)],
        )
      ).rows.length,
      0,
    );
    for (const role of Object.values(roles)) {
      assert.match(role, /^cgpost_(api|worker|backup|migrator)_[a-f0-9]{32}$/);
      await ownerDb.exec(
        `create role "${role}" ${role === roles.citygo_api ? "login password 'synthetic-postpay-password'" : "nologin"} nosuperuser nocreatedb nocreaterole`,
      );
      createdRoles.push(role);
    }
    await ownerDb.exec(
      `revoke all on schema public from public;grant usage,create on schema public to ${roles.citygo_migrator};grant create on database "${databaseName}" to ${roles.citygo_migrator};grant usage on schema public to ${roles.citygo_api},${roles.citygo_worker},${roles.citygo_backup};alter default privileges for role ${roles.citygo_migrator} revoke execute on functions from public;set role ${roles.citygo_migrator}`,
    );
  }
  await migrate(ownerDb);
  if (options.postgres) {
    const grants = (
      await readFile(
        new URL("../../../deploy/postgres/grants.sql", import.meta.url),
        "utf8",
      )
    )
      .replace(/^\\set[^\n]*\n/gm, "")
      .replace(
        /\bcitygo_(api|worker|backup|migrator)\b/g,
        (role) => roles[role as keyof typeof roles],
      );
    assert.doesNotMatch(grants, /\bcitygo_(api|worker|backup|migrator)\b/);
    await ownerDb.exec(grants);
    await ownerDb.exec("reset role");
    const u = new URL(databaseUrl);
    u.username = roles.citygo_api;
    u.password = "synthetic-postpay-password";
    db = await connectDatabase(u.toString());
    peers.push(db);
  }
  const peer = async () => {
    assert.ok(options.postgres);
    const u = new URL(databaseUrl);
    u.username = roles.citygo_api;
    u.password = "synthetic-postpay-password";
    const p = await connectDatabase(u.toString());
    peers.push(p);
    return p;
  };
  const calls: { mode: AiModeId; messages: ModelMessage[]; held: string }[] =
    [];
  const references = new Map<string, string>();
  const reads: AiModeId[] = [];
  const failures = new Set<AiModeId>();
  const interruptions = new Set<AiModeId>();
  const prices = new Map<AiModeId, string>([
    ["maximum", "0.2"],
    ["balanced", "0.1"],
  ]);
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerSequence = 0;
  const scheduler = {
    schedule(callback: () => void, delay: number) {
      const id = ++timerSequence;
      timers.set(id, { callback, delay });
      return id;
    },
    cancel(handle: unknown) {
      timers.delete(Number(handle));
    },
  };
  const tickReconciler = async () => {
    for (let n = 0; n < 200; n++) {
      const waiting = [...timers.entries()].find(
        ([, item]) => item.delay === 30000,
      );
      if (waiting) {
        timers.delete(waiting[0]);
        waiting[1].callback();
        break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (n === 199) throw Error("Synthetic reconciler did not become idle");
    }
    for (let n = 0; n < 500; n++) {
      if ([...timers.values()].some((item) => item.delay === 30000)) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw Error("Synthetic reconciler did not drain");
  };
  const modeProviders: ModeProviders = {};
  if (minimum) {
    modeProviders.minimum = {
      name: "gigachat",
      model: "GigaChat-3-Ultra",
      ...(options.memory
        ? {
            async countInputTokens(
              _instructions: string,
              messages: ModelMessage[],
            ) {
              control.counterCalls++;
              markCounterStarted();
              if (control.blockCounter) await counterGate;
              if (control.failCounter)
                throw new Error("synthetic-private-counter-detail");
              return {
                instructions: 1000,
                messages: messages.map((message, index) =>
                  control.overCounter && index === messages.length - 1
                    ? 128000
                    : [...message.content].length,
                ),
              };
            },
          }
        : {}),
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
 from gigachat_request_fees f join ai_credit_entries e on e.operation_id=f.hold_id and e.kind=$1
 where f.state='dispatched'`,
              [options.postpay ? "postpay_open" : "hold"],
            )
          ).rows;
          assert.equal(fees.length, 1);
          assert.equal(fees[0]!.held, options.postpay ? "0" : "5000000");
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
        yield { type: "delta", text: "Синтетический ответ minimum" };
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
  for (const [mode, model, upstream] of [
    ["maximum", "openai/gpt-6.1-sol", "openai"],
    ["balanced", "deepseek/deepseek-v4-pro-0813", "deepseek"],
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
            "select amount_micros::text as held from ai_credit_entries where operation_id=$1 and kind=$2",
            [
              guard.billing.reference,
              options.postpay ? "postpay_open" : "hold",
            ],
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
        if (interruptions.has(mode))
          throw Error("Synthetic interrupted response");
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
          costRub: prices.get(mode)!,
          amountMicros: routerAiCostMicros(prices.get(mode)!),
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
    AI_CUSTOMER_BILLING_MODE: options.postpay ? "postpay_actual_v1" : "legacy",
    AI_REQUEST_COST_LIMIT_MODE: options.balanceLimit
      ? "user_balance"
      : "operator_ceiling",
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
    ...(options.memory
      ? {
          AI_CONTEXT_STRATEGY: "model_window_memory_v1",
          LLM_MAX_INPUT_BYTES: "8388608",
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
  const app = await buildApp({
    db,
    config,
    modeProviders,
    testing: true,
    ...(options.postpay ? { postpayReconcileScheduler: scheduler } : {}),
  });
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
      paidKopeks: options.initialKopeks ?? 10000,
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
  // A response completed by the OLD instance before postpay cutover. No model
  // transport participates; only its retained accounting evidence is seeded.
  async function seedLegacyCharge(
    input: { complete?: boolean; model?: string } = {},
  ) {
    const using = new AiCreditCharges(
      db,
      CITYGO_10X_TARIFF,
      "fixed5_overdraft",
    );
    const requestId = randomUUID(),
      policy = modes.routes.find((route) => route.id === "balanced")!.policy.id;
    const model = input.model ?? "deepseek/deepseek-v4-pro-0813";
    await db.query(
      "insert into chat_requests(thread_id,request_id,status,ai_policy_id,ai_routing_revision) values($1,$2,'complete',$3,1)",
      [threadId, requestId, policy],
    );
    await db.query(
      "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,money_currency,money_reserved_micros,money_budget_revision,money_rule_key) values($1,$2,1,$3,'routerai',$4,$5,1,'RUB',6000000,1,$5)",
      [threadId, requestId, board.user.id, model, policy],
    );
    const hold = await db.transaction((tx) =>
      using.reserve(
        tx,
        {
          userId: board.user.id,
          threadId,
          requestId,
          model,
          upstream: "deepseek",
        },
        6000000,
      ),
    );
    const generation = "legacy-synthetic-" + randomUUID();
    await using.dispatch(board.user.id, hold);
    await using.identify(board.user.id, hold, generation);
    references.set(generation, hold);
    if (input.complete !== false)
      await db.query(
        "update ai_credit_charges set response_complete=true where hold_id=$1",
        [hold],
      );
    return hold;
  }

  return {
    db,
    ownerDb,
    peer,
    roles,
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
    interruptions,
    prices,
    ledger,
    tickReconciler,
    seedLegacyCharge,
    balance,
    control,
    minimumStarted,
    releaseMinimum,
    counterStarted,
    releaseCounter,
  };
}

for (const postgres of [false, true])
  test(
    `long messages and source memory retain three-mode postpay without holds (${postgres ? "PostgreSQL" : "PGlite"})`,
    { skip: postgres && !process.env.TEST_DATABASE_URL },
    async (t) => {
      const f = await fixture(t, {
        minimum: "fixed",
        postpay: true,
        memory: true,
        postgres,
      });
      const original =
        "Работаю на проспекте Вернадского, 17. У меня двое детей. Доход 180 тысяч.";
      await f.db.query(
        "insert into messages(thread_id,role,content,metadata) values($1,'user',$2,'{\"status\":\"complete\"}')",
        [f.threadId, original],
      );
      await f.db.query(
        "insert into messages(thread_id,role,content,metadata) values($1,'assistant','Первый ответ','{\"status\":\"complete\"}')",
        [f.threadId],
      );
      for (let n = 0; n < 55; n++) {
        await f.db.query(
          "insert into messages(thread_id,role,content,metadata) values($1,'user',$2,'{\"status\":\"complete\"}'),($1,'assistant','Продолжаем','{\"status\":\"complete\"}')",
          [f.threadId, "Другой вопрос " + n],
        );
      }
      const count = async (table: string) =>
        Number(
          (
            await f.db.query<{ n: number }>(
              `select count(*)::int as n from ${table}`,
            )
          ).rows[0]!.n,
        );
      const previewInput = {
        threadId: f.threadId,
        draft: "Где искать жильё с учётом работы и детей?",
        aiMode: "minimum",
        aiModeCatalogId: f.modes.catalogId,
        contextVersion: "model_window_memory_v1",
      };
      const beforePreview = [
        await count("messages"),
        await count("conversation_memory_fragments"),
        await count("ai_model_attempts"),
      ];
      const preview = await f.call(
        "POST",
        "/v1/ai/context-preview",
        f.token,
        previewInput,
      );
      assert.equal(preview.statusCode, 200, preview.body);
      assert.equal(preview.json().contextBudget.mode, "minimum");
      assert.equal(preview.json().contextBudget.needsProviderCheck, true);
      assert.equal(preview.json().memory.indexComplete, false);
      assert.equal(f.control.counterCalls, 0);
      assert.deepEqual(
        [
          await count("messages"),
          await count("conversation_memory_fragments"),
          await count("ai_model_attempts"),
        ],
        beforePreview,
      );
      const invalid = await f.send("maximum", "🙂".repeat(100001));
      assert.equal(invalid.statusCode, 400);
      assert.equal(f.calls.length, 0);
      const requestIds = new Map<AiModeId, ReturnType<typeof randomUUID>>();
      for (const mode of ["maximum", "balanced", "minimum"] as const) {
        const text = "Я".repeat(100000);
        const request = randomUUID();
        requestIds.set(mode, request);
        const response = await f.send(mode, text, request);
        assert.equal(response.statusCode, 200, response.body);
        assert.match(response.body, /"type":"done"/);
        const received = f.calls.at(-1)!;
        assert.equal(received.mode, mode);
        assert.equal(received.held, "0");
        assert.equal(received.messages.at(-1)?.content, text);
        assert.ok(
          received.messages.some((message) =>
            message.content.includes(original),
          ),
          "original facts survive outside the recent 100 stored messages",
        );
        assert.equal((await f.balance()).heldMicros, 0);
      }
      assert.equal(f.control.counterCalls, 1);
      assert.equal((await f.balance()).spentMicros, 6_000_000);
      const replay = await f.send(
        "minimum",
        "Я".repeat(100000),
        requestIds.get("minimum")!,
      );
      assert.equal(replay.statusCode, 409);
      assert.equal(f.calls.length, 3);
      assert.equal(f.control.counterCalls, 1);
      assert.equal((await f.balance()).spentMicros, 6_000_000);
      assert.equal(await count("ai_model_attempts"), 3);
      assert.equal(
        (await f.db.query("select 1 from ai_credit_entries where kind='hold'"))
          .rows.length,
        0,
      );
      const after = await f.call(
        "GET",
        `/v1/conversations/${f.threadId}`,
        f.token,
      );
      assert.equal(after.statusCode, 200, after.body);
      const board = conversationDetailResponseSchema.parse(after.json());
      assert.equal(board.thread!.messages.at(-2)!.content, "Я".repeat(100000));
      const sources = await f.db.query(
        "select 1 from conversation_memory_fragments where thread_id=$1 and content like '%Вернадского%'",
        [f.threadId],
      );
      assert.equal(sources.rows.length, 1);
    },
  );

for (const outcome of ["timeout", "over-window"] as const)
  test(`long-message ${outcome} preflight never generates, debits or blocks other modes; personal capacity expires automatically`, async (t) => {
    const f = await fixture(t, {
      minimum: "fixed",
      postpay: true,
      memory: true,
    });
    const before = await f.balance();
    f.control.failCounter = outcome === "timeout";
    f.control.overCounter = outcome === "over-window";
    const failed = await f.send("minimum", "Я".repeat(100000));
    assert.match(failed.body, /"type":"error"/);
    assert.doesNotMatch(failed.body, /synthetic-private-counter-detail/);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.balance()).availableMicros, before.availableMicros);
    assert.equal(
      (await f.db.query("select 1 from ai_model_attempts")).rows.length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "select 1 from gigachat_account_leases where expires_at>clock_timestamp()",
        )
      ).rows.length,
      1,
    );
    const busy = await f.send("minimum", "Повтор до окончания срока очереди");
    assert.match(busy.body, /"type":"error"/);
    assert.equal(
      f.control.counterCalls,
      1,
      "no second upstream count while personal slot is busy",
    );
    const lease = (
      await f.db.query<{ bounded: boolean }>(
        "select expires_at<=clock_timestamp()+interval '90 seconds' as bounded from gigachat_account_leases",
      )
    ).rows[0]!;
    assert.equal(lease.bounded, true);
    const next = await f.send("balanced", "Продолжаем после проверки размера");
    assert.match(next.body, /"type":"done"/);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.balance()).spentMicros, 1_000_000);
    assert.equal((await f.balance()).heldMicros, 0);
  });

for (const postgres of [false, true])
  test(
    `GigaChat token preflight shares one provider slot across different users without another generation or hold (${postgres ? "PostgreSQL" : "PGlite"})`,
    { skip: postgres && !process.env.TEST_DATABASE_URL },
    async (t) => {
      const f = await fixture(t, {
        minimum: "fixed",
        postpay: true,
        memory: true,
        postgres,
      });
      const registration = await f.call("POST", "/v1/auth/register", "", {
        email: randomUUID() + "@example.test",
        password: "123456",
        consents: await syntheticConsentsFor(f.app),
      });
      assert.equal(registration.statusCode, 200, registration.body);
      const otherToken = registration.cookies[0]!.value;
      const otherBoard = dashboardResponseSchema.parse(
        (await f.call("GET", "/v1/dashboard", otherToken)).json(),
      );
      await f.ledger.topUpConfirmed(otherBoard.user.id, randomUUID(), {
        providerPaymentId: "synthetic-preflight-" + randomUUID(),
        merchantId: "synthetic-shop",
        paidKopeks: 10000,
        currency: "RUB",
        test: false,
        verifiedAt: new Date().toISOString(),
        verification: "server_get_succeeded",
      });
      const start = await f.call(
        "POST",
        "/v1/conversations/start",
        otherToken,
        { agentKey: "housing" },
      );
      assert.equal(start.statusCode, 200, start.body);
      const otherThread = start.json<{ id: string }>().id;
      const sendOther = () =>
        f.call("POST", `/v1/threads/${otherThread}/messages`, otherToken, {
          text: "Вопрос другого владельца",
          requestId: randomUUID(),
          aiMode: "minimum",
          aiModeCatalogId: f.modes.catalogId,
          policyId: f.modes.policy.id,
          creditReservationMode: "fixed5_overdraft",
        });
      f.control.blockCounter = true;
      const first = f.send(
        "minimum",
        "Первый владелец проверяет длинное сообщение",
      );
      await f.counterStarted;
      try {
        const refused = await sendOther();
        assert.match(refused.body, /"type":"error"/);
        assert.equal(f.control.counterCalls, 1);
        assert.equal(f.calls.length, 0);
        assert.equal((await f.balance()).heldMicros, 0);
      } finally {
        f.control.blockCounter = false;
        f.releaseCounter();
      }
      assert.match((await first).body, /"type":"done"/);
      assert.match((await sendOther()).body, /"type":"done"/);
      assert.equal(f.control.counterCalls, 2);
      assert.equal(f.calls.length, 2);
      const otherBalance = (
        await f.call("GET", "/v1/ai/credit", otherToken)
      ).json<AiCredit>();
      assert.equal(otherBalance.spentMicros, 3000000);
      assert.equal(otherBalance.heldMicros, 0);
    },
  );

test("large-body authentication and privacy checks run before parsing; unrelated routes retain their small limits", async (t) => {
  const f = await fixture(t, { minimum: "fixed", postpay: true, memory: true });
  const large = JSON.stringify({
    threadId: f.threadId,
    draft: "🙂".repeat(100000),
    contextVersion: "model_window_memory_v1",
  });
  const response = await f.app.inject({
    method: "POST",
    url: "/v1/ai/context-preview",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    payload: large,
  });
  assert.equal(response.statusCode, 401);
  const allowed = await f.call(
    "POST",
    "/v1/ai/context-preview",
    f.token,
    JSON.parse(large),
  );
  assert.equal(allowed.statusCode, 200, allowed.body);
  const badCatalog = await f.call("POST", "/v1/ai/context-preview", f.token, {
    threadId: f.threadId,
    draft: "Вопрос",
    contextVersion: "model_window_memory_v1",
    aiMode: "maximum",
    aiModeCatalogId: "a".repeat(64),
  });
  assert.equal(badCatalog.statusCode, 409);
  const unrelated = await f.call("POST", "/v1/auth/login", "", {
    email: "nobody@example.test",
    password: "x".repeat(20000),
  });
  assert.equal(unrelated.statusCode, 413);
  assert.equal(f.calls.length, 0);
  assert.equal(f.control.counterCalls, 0);
});

test("HTTP administrative AI catalog accepts three modes plus retained Balanced compatibility without expanding budget rules or charging", async (t) => {
  const f = await fixture(t, { legacy: true, minimum: "fixed" });
  await f.db.query("update users set role='super_admin' where id=$1", [
    f.board.user.id,
  ]);
  const before = await f.balance();
  const response = await f.call("GET", "/v1/admin/ai", f.token);
  assert.equal(response.statusCode, 200, response.body);
  const control = aiControlResponseSchema.parse(response.json());
  const executions = control.budget!.availableExecutions;
  assert.equal(
    executions.length,
    4,
    "three mode executions and a distinct historical Balanced execution are valid",
  );
  assert.equal(new Set(executions.map((execution) => execution.key)).size, 4);
  for (const route of f.modes.routes) {
    assert.ok(route.provider, "all three synthetic modes are configured");
    assert.ok(
      executions.some((execution) => execution.key === route.execution.key),
    );
  }
  assert.ok(
    executions.some(
      (execution) =>
        execution.key === f.modes.legacyBalancedCompatibility!.execution.key,
    ),
  );
  assert.equal(
    control.options.length,
    3,
    "public provider choices remain unchanged",
  );
  assert.equal(
    control.budget!.settings.rules.length,
    3,
    "the stored monetary approval still has its original three-rule bound",
  );
  assert(
    control.budget!.settings.rules.every(
      (rule) => rule.policy.provider === "routerai",
    ),
  );
  assert.equal(f.config.AI_CREDIT_RESERVATION_MODE, "fixed5_overdraft");
  assert.equal(f.config.AI_CREDIT_MODE, "routerai_citygo_10x");
  assert.equal(f.config.AI_MINIMUM_FIXED_FEE, "enabled");
  assert.deepEqual(
    await f.balance(),
    before,
    "reading administrative catalog does not reserve or charge balance",
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.reads, []);
  assert.equal(
    (
      await f.db.query(
        "select 1 from ai_credit_entries where kind in('hold','settle')",
      )
    ).rows.length,
    0,
  );
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
  assert.equal(blocked.statusCode, 409);
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
  assert.deepEqual(f.reads, ["maximum", "maximum", "maximum"]);
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
  assert.equal(f.reads.length, 3);
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

test("an unresolved RouterAI charge also blocks fixed Minimum before new history, request quota or fee reservation", async (t) => {
  const f = await fixture(t, { minimum: "fixed" });
  f.failures.add("maximum");
  assert.match(
    (await f.send("maximum", "Первый вопрос")).body,
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
      "ai_credit_accounts",
      "ai_credit_entries",
      "ai_credit_charges",
      "gigachat_request_fees",
      "gigachat_account_leases",
    ])
      result[table] = (
        await f.db.query(
          `select to_jsonb(t) as value from ${table} t order by to_jsonb(t)::text`,
        )
      ).rows;
    return result;
  };
  const before = await snapshot();
  const response = await f.send("minimum", "Дешёвый режим не обходит сверку");
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, "AI_CREDIT_UNAVAILABLE");
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(
    f.calls.map((call) => call.mode),
    ["maximum"],
  );
  assert.deepEqual(f.reads, ["maximum", "maximum"]);
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

test("HTTP opted-in balance limits snapshot each RouterAI request while fixed Minimum remains exactly three CityGo and all three modes keep five holds", async (t) => {
  const f = await fixture(t, { minimum: "fixed", balanceLimit: true });
  for (const mode of ["maximum", "minimum", "balanced"] as const)
    assert.match(
      (await f.send(mode, `Synthetic balance-mode ${mode}`)).body,
      /"type":"done"/,
    );
  assert.deepEqual(
    f.calls.map((call) => [call.mode, call.held]),
    [
      ["maximum", "5000000"],
      ["minimum", "5000000"],
      ["balanced", "5000000"],
    ],
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select model,cost_limit_mode,balance_before_hold_micros::text as before,real_ceiling_micros::text as ceiling from ai_credit_charges order by balance_before_hold_micros desc",
      )
    ).rows,
    [
      {
        model: "openai/gpt-6.1-sol",
        cost_limit_mode: "user_balance",
        before: "100000000",
        ceiling: "10000000",
      },
      {
        model: "deepseek/deepseek-v4-pro-0813",
        cost_limit_mode: "user_balance",
        before: "95000000",
        ceiling: "9500000",
      },
    ],
  );
  assert.equal((await f.balance()).availableMicros, 94_000_000);
  assert.equal((await f.balance()).heldMicros, 0);
  assert.deepEqual(
    (
      await f.db.query(
        "select state,snapshot->>'feeCitygoMicros' as fee,snapshot->>'operatorCostRubMicros' as provider_cost from gigachat_request_fees",
      )
    ).rows,
    [{ state: "succeeded", fee: "3000000", provider_cost: "0" }],
  );
  assert.deepEqual(f.reads, ["maximum", "balanced"]);
  const before = (await f.db.query("select * from ai_credit_charges")).rows;
  await f.db.query(
    "update ai_budget set enabled=false,revision=revision+1 where id=1",
  );
  const attempts = (await f.db.query("select * from ai_model_attempts")).rows;
  for (const mode of ["maximum", "minimum", "balanced"] as const) {
    const response = await f.send(
      mode,
      `Synthetic stopped balance-mode ${mode}`,
    );
    assert.doesNotMatch(response.body, /"type":"done"/);
  }
  assert.equal(f.calls.length, 3);
  assert.deepEqual(
    (await f.db.query("select * from ai_credit_charges")).rows,
    before,
  );
  assert.deepEqual(
    (await f.db.query("select * from ai_model_attempts")).rows,
    attempts,
  );
  assert.equal((await f.balance()).heldMicros, 0);
});

test("postpay all three modes debit only completed answers without reserving customer funds", async (t) => {
  const f = await fixture(t, { minimum: "fixed", postpay: true });
  for (const mode of ["maximum", "minimum", "balanced"] as const) {
    const r = await f.send(mode, "Синтетический вопрос " + mode);
    assert.equal(r.statusCode, 200, r.body);
    assert.match(r.body, /"type":"done"/);
    assert.doesNotMatch(r.body, /"type":"error"/);
  }
  assert.deepEqual(
    f.calls.map((c) => [c.mode, c.held]),
    [
      ["maximum", "0"],
      ["minimum", "0"],
      ["balanced", "0"],
    ],
  );
  const b = await f.balance();
  assert.equal(b.availableMicros, 94_000_000);
  assert.equal(b.heldMicros, 0);
  assert.equal(b.spentMicros, 6_000_000);
  assert.equal(b.outstandingDebtMicros, 0);
  assert.equal(b.billingPolicy, "postpay_actual_v1");
  assert.equal(b.reservationMode, undefined);
  assert.deepEqual(b.pending, []);
  assert.ok(
    b.history.every((row) =>
      ["bonus", "topup", "hold", "settle", "release"].includes(row.kind),
    ),
  );
  const rows = (
    await f.db.query<{ protocol: string; state: string; receipt: unknown }>(
      "select protocol,state,receipt from ai_postpay_attempts order by created_at",
    )
  ).rows;
  assert.deepEqual(
    rows.map((row) => [row.protocol, row.state]),
    [
      ["responses", "settled"],
      ["gigachat", "settled"],
      ["chat/completions", "settled"],
    ],
  );
  assert.equal(rows[1]!.receipt, null);
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries where kind='hold'")).rows
      .length,
    0,
  );
});

test("postpay exact actual over balance settles once into debt without disabling the operator budget", async (t) => {
  const f = await fixture(t, { postpay: true });
  f.prices.set("maximum", "20.000000123");
  const id = randomUUID(),
    r = await f.send("maximum", "Синтетический перерасход", id);
  assert.match(r.body, /"type":"done"/);
  assert.doesNotMatch(r.body, /"type":"error"/);
  const b = await f.balance();
  assert.equal(b.spentMicros, 200_000_001);
  assert.equal(b.availableMicros, -100_000_001);
  assert.equal(b.outstandingDebtMicros, 100_000_001);
  assert.equal(b.heldMicros, 0);
  assert.equal(
    (await f.db.query<{ enabled: boolean }>("select enabled from ai_budget"))
      .rows[0]!.enabled,
    true,
  );
  const p = (
    await f.db.query<{ id: string; generation_id: string }>(
      "select id::text,generation_id from ai_postpay_attempts",
    )
  ).rows[0]!;
  const charges = new PostpayCharges(f.db);
  const receipt = {
    generationId: p.generation_id,
    reference: p.id,
    model: "openai/gpt-6.1-sol",
    upstream: "openai",
    currency: "RUB" as const,
    costRub: "20.000000123",
    amountMicros: 20_000_000,
  };
  assert.equal(
    await charges.settleRouter(f.board.user.id, p.id, receipt),
    true,
  );
  await f.send("maximum", "Синтетический перерасход", id);
  assert.equal(f.calls.length, 1);
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
  const next = await f.send(
    "balanced",
    "Новый запрос при отрицательном балансе",
  );
  assert.match(next.body, /AI_CREDIT_EXHAUSTED/);
  assert.equal(f.calls.length, 1);
});

test("postpay missing receipt does not block a new reply and bounded automatic GET settles the first answer later", async (t) => {
  const f = await fixture(t, { postpay: true });
  f.failures.add("maximum");
  assert.match(
    (await f.send("maximum", "Первый ответ со стоимостью позже")).body,
    /"type":"done"/,
  );
  assert.equal((await f.balance()).heldMicros, 0);
  assert.match(
    (await f.send("balanced", "Следующий ответ без ожидания сверки")).body,
    /"type":"done"/,
  );
  assert.equal(f.calls.length, 2);
  assert.equal((await f.balance()).availableMicros, 99_000_000);
  f.failures.delete("maximum");
  await f.db.query(
    "update ai_postpay_attempts set next_check_at=clock_timestamp() where model='openai/gpt-6.1-sol'",
  );
  await f.tickReconciler();
  assert.equal((await f.balance()).availableMicros, 97_000_000);
  await f.tickReconciler();
  assert.equal((await f.balance()).availableMicros, 97_000_000);
  assert.equal(f.calls.length, 2);
});

test("postpay terminal zero observation waits for a later positive receipt instead of fabricating a free final cost", async (t) => {
  const f = await fixture(t, { postpay: true });
  f.prices.set("maximum", "0");
  assert.match(
    (await f.send("maximum", "Ответ с ещё не окончательной нулевой стоимостью"))
      .body,
    /"type":"done"/,
  );
  let p = (
    await f.db.query<{
      state: string;
      receipt: unknown;
      observed_receipt: { costRub: string };
    }>("select state,receipt,observed_receipt from ai_postpay_attempts")
  ).rows[0]!;
  assert.equal(p.state, "pending");
  assert.equal(p.receipt, null);
  assert.equal(p.observed_receipt.costRub, "0");
  assert.equal((await f.balance()).availableMicros, 100_000_000);
  f.prices.set("maximum", "0.20000019");
  await f.db.query(
    "update ai_postpay_attempts set next_check_at=clock_timestamp()",
  );
  await f.tickReconciler();
  assert.equal((await f.balance()).spentMicros, 2_000_001);
  p = (
    await f.db.query(
      "select state,receipt,observed_receipt from ai_postpay_attempts",
    )
  ).rows[0] as typeof p;
  assert.equal(p.state, "settled");
  assert.equal(f.calls.length, 1);
});

test("postpay interrupted positive receipt remains an operator observation and never blocks later messages", async (t) => {
  const f = await fixture(t, { postpay: true });
  f.interruptions.add("maximum");
  const r = await f.send("maximum", "Прерванный ответ");
  assert.match(r.body, /"type":"error"/);
  assert.doesNotMatch(r.body, /резерв удерживается|требует сверки/);
  await f.db.query(
    "update ai_postpay_attempts set next_check_at=clock_timestamp()",
  );
  await f.tickReconciler();
  const p = (
    await f.db.query<{
      state: string;
      receipt: unknown;
      response_complete: boolean;
      observed_receipt: { costRub: string };
    }>(
      "select state,receipt,response_complete,observed_receipt from ai_postpay_attempts",
    )
  ).rows[0]!;
  assert.equal(p.state, "pending");
  assert.equal(p.response_complete, false);
  assert.equal(p.receipt, null);
  assert.equal(p.observed_receipt.costRub, "0.2");
  assert.equal((await f.balance()).spentMicros, 0);
  assert.match(
    (await f.send("balanced", "Продолжаем без административной сверки")).body,
    /"type":"done"/,
  );
  assert.equal((await f.balance()).availableMicros, 99_000_000);
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal(f.calls.length, 2);
  await f.db.query(
    "update ai_postpay_attempts set check_count=64,next_check_at=clock_timestamp() where model='openai/gpt-6.1-sol'",
  );
  const readCount = f.reads.length;
  await f.tickReconciler();
  assert.equal(f.reads.length, readCount);
});

test("postpay Minimum failure creates no debit, no hold, and preserves the Ultra uncertain-dispatch lease", async (t) => {
  const f = await fixture(t, { minimum: "fixed", postpay: true });
  f.failures.add("minimum");
  const r = await f.send("minimum", "Синтетическая ошибка Минимума");
  assert.match(r.body, /"type":"error"/);
  assert.equal((await f.balance()).availableMicros, 100_000_000);
  assert.equal((await f.balance()).heldMicros, 0);
  const p = (
    await f.db.query<{ state: string }>("select state from ai_postpay_attempts")
  ).rows[0]!;
  assert.equal(p.state, "no_charge");
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries where kind='settle'"))
      .rows.length,
    0,
  );
  assert.equal(
    (
      await f.db.query(
        "select 1 from gigachat_account_leases where expires_at>clock_timestamp()",
      )
    ).rows.length,
    1,
  );
});

test("postpay database rejects review-required admission and mutated request/message identity", async (t) => {
  const f = await fixture(t, { postpay: true });
  f.failures.add("maximum");
  await f.send("maximum", "Первый терминальный ответ");
  const first = (
    await f.db.query<{ id: string; response_message_id: string }>(
      "select id::text,response_message_id::text from ai_postpay_attempts",
    )
  ).rows[0]!;
  f.interruptions.add("maximum");
  await f.send("maximum", "Другой прерванный запрос");
  const second = (
    await f.db.query<{ id: string; request_id: string }>(
      "select id::text,request_id::text from ai_postpay_attempts where not response_complete",
    )
  ).rows[0]!;
  await f.db.query(
    "update chat_requests set status='complete' where request_id=$1",
    [second.request_id],
  );
  await assert.rejects(
    f.db.query(
      "update ai_postpay_attempts set response_complete=true,response_message_id=$2 where id=$1",
      [second.id, first.response_message_id],
    ),
    /persisted terminal model answer/,
  );
  const wrongMessage = (
    await f.db.query<{ id: string }>(
      "insert into messages(thread_id,role,content,metadata) select thread_id,role,content,metadata from messages where id=$1 returning id::text",
      [first.response_message_id],
    )
  ).rows[0]!.id;
  await assert.rejects(
    f.db.query(
      "update ai_postpay_attempts set response_message_id=$2 where id=$1",
      [first.id, wrongMessage],
    ),
    /immutable/,
  );
  await assert.rejects(
    f.db.query("update ai_postpay_attempts set execution_key=$2 where id=$1", [
      first.id,
      "e".repeat(64),
    ]),
    /immutable/,
  );
  await f.db.query(
    "update ai_credit_accounts set billing_review_required=true where user_id=$1",
    [f.board.user.id],
  );
  const before = f.calls.length;
  const response = await f.send(
    "balanced",
    "Не отправлять при проблемах источников",
  );
  assert.match(response.body, /AI_CREDIT_UNAVAILABLE/);
  assert.equal(f.calls.length, before);
  assert.equal((await f.balance()).spentMicros, 0);
});

test("postpay paid-refund reservation is preserved while late actual debit uses free funding and negative balance", async (t) => {
  const f = await fixture(t, { postpay: true });
  f.failures.add("maximum");
  await f.send("maximum", "Стоимость появится позже возврата");
  const paid = (await listPaidSourceLots(f.db, f.board.user.id))[0]!;
  const refund = randomUUID();
  await f.db.transaction((tx) =>
    reservePaidRefund(
      tx,
      f.board.user.id,
      paid.sourceOperationId,
      refund,
      10_000,
    ),
  );
  const p = (
    await f.db.query<{ id: string; generation_id: string }>(
      "select id::text,generation_id from ai_postpay_attempts",
    )
  ).rows[0]!;
  await new PostpayCharges(f.db).settleRouter(f.board.user.id, p.id, {
    generationId: p.generation_id,
    reference: p.id,
    model: "openai/gpt-6.1-sol",
    upstream: "openai",
    currency: "RUB",
    costRub: "0.2",
    amountMicros: 200000,
  });
  let b = await f.balance();
  assert.equal(b.heldMicros, 100_000_000);
  assert.equal(b.spentMicros, 2_000_000);
  assert.equal(b.availableMicros, -2_000_000);
  assert.equal(b.outstandingDebtMicros, 2_000_000);
  const lot = (
    await f.db.query<{ spent: string; reserved: string }>(
      "select spent_micros::text as spent,refund_reserved_micros::text as reserved from credit_source_lots where paid_operation_id=$1",
      [paid.sourceOperationId],
    )
  ).rows[0]!;
  assert.deepEqual(lot, { spent: "0", reserved: "100000000" });
  await f.db.transaction((tx) =>
    releasePaidRefund(tx, f.board.user.id, refund),
  );
  b = await f.balance();
  assert.equal(b.heldMicros, 0);
  assert.equal(b.availableMicros, 98_000_000);
  assert.equal(b.outstandingDebtMicros, 0);
  assert.equal(
    (
      await f.db.query<{ paid: string }>(
        "select sum(amount_micros)::text as paid from credit_postpay_repayments",
      )
    ).rows[0]!.paid,
    "2000000",
  );
});

test(
  "postpay PostgreSQL restricted API settles one late receipt exactly once across independent connections and preserves worker ACL",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45_000 },
  async (t) => {
    const f = await fixture(t, {
      postpay: true,
      minimum: "fixed",
      postgres: true,
    });
    f.failures.add("maximum");
    await f.send("maximum", "Терминальный ответ для гонки сверки");
    assert.equal(f.calls.length, 1);
    const p = (
      await f.db.query<{ id: string; generation_id: string }>(
        "select id::text,generation_id from ai_postpay_attempts",
      )
    ).rows[0]!;
    const second = await f.peer();
    assert.notEqual(
      (await second.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0]!.pid,
      (await f.db.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0]!.pid,
    );
    const receipt = {
      generationId: p.generation_id,
      reference: p.id,
      model: "openai/gpt-6.1-sol",
      upstream: "openai",
      currency: "RUB" as const,
      costRub: "20.000000123",
      amountMicros: 20_000_000,
    };
    const results = await Promise.all([
      new PostpayCharges(f.db).settleRouter(f.board.user.id, p.id, receipt),
      new PostpayCharges(second).settleRouter(f.board.user.id, p.id, receipt),
    ]);
    assert.deepEqual(results, [true, true]);
    assert.equal((await f.balance()).availableMicros, -100_000_001);
    assert.equal((await f.balance()).heldMicros, 0);
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
    await assert.rejects(
      new PostpayCharges(second).settleRouter("999999", p.id, receipt),
      /не найдена/,
    );
    await assert.rejects(
      new PostpayCharges(second).settleRouter(f.board.user.id, p.id, {
        ...receipt,
        costRub: "20.1",
        amountMicros: 20_100_000,
      }),
      /изменилась/,
    );
    const acl = (
      await f.ownerDb.query(
        "select has_table_privilege($1,'ai_postpay_attempts','SELECT') as worker,has_table_privilege($2,'ai_postpay_attempts','DELETE') as api_delete,has_column_privilege($2,'ai_postpay_attempts','execution_key','UPDATE') as api_retarget,has_column_privilege($2,'ai_postpay_attempts','state','UPDATE') as api_state,has_function_privilege($2,'citygo_apply_credit_debt_repayments(bigint)','EXECUTE') as api_repay",
        [f.roles.citygo_worker, f.roles.citygo_api],
      )
    ).rows[0]!;
    assert.deepEqual(acl, {
      worker: false,
      api_delete: false,
      api_retarget: false,
      api_state: true,
      api_repay: true,
    });
  },
);

test(
  "postpay PostgreSQL active generation serializes cross-thread admission before any quota/message writes and expired leases permit recovery",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45_000 },
  async (t) => {
    const f = await fixture(t, {
      postpay: true,
      minimum: "fixed",
      postgres: true,
    });
    f.control.blockMinimum = true;
    const pending = f.send("minimum", "Долгий одиночный ответ");
    await f.minimumStarted;
    const other = (
      await f.call("POST", "/v1/conversations/start", f.token, {
        agentKey: "job-search",
      })
    ).json<{ id: string }>().id;
    const before = (
      await f.db.query(
        "select (select count(*)::int from chat_requests) as requests,(select count(*)::int from messages) as messages,(select sum(accepted_requests)::text from ai_usage_daily) as quota",
      )
    ).rows;
    const payload = {
      text: "Не принимать одновременно",
      requestId: randomUUID(),
      aiMode: "balanced",
      aiModeCatalogId: f.modes.catalogId,
      policyId: f.modes.policy.id,
      creditReservationMode: "fixed5_overdraft",
    };
    const blocked = await f.call(
      "POST",
      `/v1/threads/${other}/messages`,
      f.token,
      payload,
    );
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.match(blocked.body, /Дождитесь текущего ответа/);
    assert.deepEqual(
      (
        await f.db.query(
          "select (select count(*)::int from chat_requests) as requests,(select count(*)::int from messages) as messages,(select sum(accepted_requests)::text from ai_usage_daily) as quota",
        )
      ).rows,
      before,
    );
    const peer = await f.peer();
    await peer.query(
      "update agent_threads set busy_until=clock_timestamp()-interval '1 second' where id=$1",
      [f.threadId],
    );
    const recovered = await f.call(
      "POST",
      `/v1/threads/${other}/messages`,
      f.token,
      {
        ...payload,
        requestId: randomUUID(),
        text: "Новая попытка после истечения lease",
      },
    );
    assert.match(recovered.body, /"type":"done"/);
    assert.equal(f.calls.filter((c) => c.mode === "balanced").length, 1);
    f.releaseMinimum();
    await pending;
    assert.equal((await f.balance()).heldMicros, 0);
  },
);

test("legacy fixed5 budget rejects unsupported caps before CAS/audit writes while postpay accepts its separate authority", async (t) => {
  for (const postpay of [false, true]) {
    const f = await fixture(t, { postpay });
    await f.db.query("update users set role='super_admin' where id=$1", [
      f.board.user.id,
    ]);
    const control = aiControlResponseSchema.parse(
      (await f.call("GET", "/v1/admin/ai", f.token)).json(),
    );
    const b = control.budget!.settings;
    const before = (
      await f.db.query("select row_to_json(b) as value from ai_budget b")
    ).rows;
    const audits = (
      await f.db.query("select * from audit_log where entity_type='ai-budget'")
    ).rows;
    for (const cap of [499999, 30000000]) {
      const r = await f.call("POST", "/v1/admin/ai/budget", f.token, {
        expectedRevision: b.revision,
        enabled: b.enabled,
        mode: b.mode,
        currency: b.currency,
        dailyLimitMicros: b.dailyLimitMicros,
        totalLimitMicros: b.totalLimitMicros,
        userDailyLimitMicros: b.userDailyLimitMicros,
        rules: b.rules.map((rule) => ({
          key: rule.key,
          attemptCeilingMicros: cap,
        })),
      });
      if (postpay) {
        assert.equal(r.statusCode, 200, r.body);
        break;
      }
      assert.equal(r.statusCode, 400, r.body);
      assert.match(r.body, /0,5.*6/);
      assert.deepEqual(
        (await f.db.query("select row_to_json(b) as value from ai_budget b"))
          .rows,
        before,
      );
      assert.deepEqual(
        (
          await f.db.query(
            "select * from audit_log where entity_type='ai-budget'",
          )
        ).rows,
        audits,
      );
    }
  }
});

test("closed maintenance refuses to erase new postpay evidence and returns reviewed current inventories", async (t) => {
  const f = await fixture(t, { postpay: true });
  await f.send("balanced", "Финансовые доказательства сохраняются");
  const before = (
    await f.db.query(
      "select row_to_json(p) as value from ai_postpay_attempts p",
    )
  ).rows;
  const closed = await new ClosedAccountRestart(f.db).plan({
    expectedUserCount: 1,
    maintenanceConfirmed: true,
  });
  assert.ok(
    closed.blockers.some((x) => x.code === "POSTPAY_HISTORY_REQUIRES_REVIEW"),
  );
  const fresh = await new FreshAccountReset(f.db).plan({
    expectedUserCount: 1,
    maintenanceConfirmed: true,
  });
  assert.ok(
    fresh.blockers.some((x) => x.code === "CREDIT_DEBT_HISTORY_PRESENT"),
  );
  assert.equal(fresh.counts.ai_postpay_attempts, 1);
  assert.deepEqual(
    (
      await f.db.query(
        "select row_to_json(p) as value from ai_postpay_attempts p",
      )
    ).rows,
    before,
  );
  const history = await f.call("GET", "/v1/ai/credit/history", f.token);
  assert.equal(history.statusCode, 200, history.body);
  const entries = history.json<{
    entries: { kind: string; amountMicros: number }[];
  }>().entries;
  assert.deepEqual(
    entries.map((e) => [e.kind, e.amountMicros]),
    [
      ["spend", 1000000],
      ["topup", 100000000],
    ],
  );
});

test("postpay Minimum admits exactly three available roubles without touching an existing refund reservation", async (t) => {
  const f = await fixture(t, { postpay: true, minimum: "fixed" });
  const paid = (await listPaidSourceLots(f.db, f.board.user.id))[0]!;
  const refund = randomUUID();
  await f.db.transaction((tx) =>
    reservePaidRefund(
      tx,
      f.board.user.id,
      paid.sourceOperationId,
      refund,
      9700,
    ),
  );
  assert.equal((await f.balance()).availableMicros, 3000000);
  const r = await f.send("minimum", "Три рубля доступны для успешного ответа");
  assert.match(r.body, /"type":"done"/);
  const b = await f.balance();
  assert.equal(b.availableMicros, 0);
  assert.equal(b.spentMicros, 3000000);
  assert.equal(b.heldMicros, 97000000);
  const fail = await f.send("minimum", "Недостаточно свободных средств");
  assert.match(fail.body, /AI_CREDIT_EXHAUSTED/);
  assert.equal(f.calls.length, 1);
});

test("postpay background recovers a completed legacy hold covering the whole balance without a new model POST", async (t) => {
  const f = await fixture(t, {
    postpay: true,
    minimum: "fixed",
    initialKopeks: 500,
  });
  const hold = await f.seedLegacyCharge();
  assert.equal((await f.balance()).availableMicros, 0);
  assert.equal((await f.balance()).heldMicros, 5000000);
  await f.tickReconciler();
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal((await f.balance()).availableMicros, 4000000);
  assert.equal((await f.balance()).spentMicros, 1000000);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.reads, ["balanced"]);
  await f.tickReconciler();
  assert.deepEqual(f.reads, ["balanced"]);
  assert.equal(
    (
      await f.db.query("select 1 from ai_credit_entries where hold_id=$1", [
        hold,
      ])
    ).rows.length,
    1,
  );
});

test("one legacy background slot preserves current postpay reconciliation progress and once-only actual debits", async (t) => {
  const f = await fixture(t, { postpay: true, minimum: "fixed" });
  f.failures.add("maximum");
  assert.equal(
    (await f.send("maximum", "Синтетический завершённый новый ответ"))
      .statusCode,
    200,
  );
  const hold = await f.seedLegacyCharge();
  f.failures.delete("maximum");
  await f.db.query(
    "update ai_postpay_attempts set next_check_at=clock_timestamp()",
  );
  await f.tickReconciler();
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal((await f.balance()).spentMicros, 3000000);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.reads, ["maximum", "balanced", "maximum"]);
  assert.equal(
    (
      await f.db.query("select 1 from ai_credit_entries where hold_id=$1", [
        hold,
      ])
    ).rows.length,
    1,
  );
  assert.equal(
    (
      await f.db.query(
        "select 1 from ai_postpay_attempts where state='settled'",
      )
    ).rows.length,
    1,
  );
});

for (const state of ["zero", "failed", "no-adapter", "interrupted"] as const)
  test(
    "postpay legacy " +
      state +
      " recovery cannot charge, release, block a new reply or retry its model",
    async (t) => {
      const f = await fixture(t, { postpay: true, minimum: "fixed" });
      const hold = await f.seedLegacyCharge({
        complete: state !== "interrupted",
        ...(state === "no-adapter" ? { model: "retired/legacy-model" } : {}),
      });
      if (state === "zero") f.prices.set("balanced", "0");
      if (state === "failed") f.failures.add("balanced");
      await f.tickReconciler();
      assert.equal((await f.balance()).heldMicros, 5000000);
      assert.equal((await f.balance()).spentMicros, 0);
      assert.equal(
        (
          await f.db.query("select 1 from ai_credit_entries where hold_id=$1", [
            hold,
          ])
        ).rows.length,
        0,
      );
      assert.equal(
        (
          await f.send(
            "maximum",
            "Другой синтетический вопрос после старой стоимости",
          )
        ).statusCode,
        200,
      );
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0]!.mode, "maximum");
      assert.equal((await f.balance()).heldMicros, 5000000);
      assert.equal((await f.balance()).spentMicros, 2000000);
      assert.deepEqual(
        f.reads,
        state === "zero" || state === "failed"
          ? ["balanced", "maximum"]
          : ["maximum"],
      );
    },
  );

test(
  "postpay PostgreSQL restricted API recovers one legacy receipt across independent connections without Worker rights",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, {
      postpay: true,
      minimum: "fixed",
      postgres: true,
      initialKopeks: 1000,
    });
    const hold = await f.seedLegacyCharge(),
      peer = await f.peer();
    for (const connection of [f.db, peer])
      assert.equal(
        (await connection.query("select current_user as role")).rows[0]?.role,
        f.roles.citygo_api,
        "candidate audit reads and both settlement transactions use the restricted API role",
      );
    const first = new AiCreditCharges(
      f.db,
      CITYGO_10X_TARIFF,
      "fixed5_overdraft",
    );
    const second = new AiCreditCharges(
      peer,
      CITYGO_10X_TARIFF,
      "fixed5_overdraft",
    );
    assert.deepEqual(await first.completedUnresolvedAfter(), [
      { holdId: hold, userId: f.board.user.id },
    ]);
    const generation = (await first.get(f.board.user.id, hold)).generation_id!;
    const receipt = {
      generationId: generation,
      reference: hold,
      model: "deepseek/deepseek-v4-pro-0813",
      upstream: "deepseek",
      currency: "RUB" as const,
      costRub: "0.1",
      amountMicros: 100000,
    };
    assert.deepEqual(
      await Promise.all([
        first.settleCompletedAutomatically(f.board.user.id, hold, receipt),
        second.settleCompletedAutomatically(f.board.user.id, hold, receipt),
      ]),
      [true, true],
    );
    assert.equal((await f.balance()).heldMicros, 0);
    assert.equal((await f.balance()).spentMicros, 1000000);
    assert.equal(
      (
        await f.db.query("select 1 from ai_credit_entries where hold_id=$1", [
          hold,
        ])
      ).rows.length,
      1,
    );
    // A second old hold is legal only AFTER the first resolution. Preserve
    // the production one-unresolved-legacy-attempt admission invariant.
    const manualHold = await f.seedLegacyCharge();
    const manualGeneration = (await first.get(f.board.user.id, manualHold))
      .generation_id!;
    const manualReceipt = {
      generationId: manualGeneration,
      reference: manualHold,
      model: "deepseek/deepseek-v4-pro-0813",
      upstream: "deepseek",
      currency: "RUB" as const,
      costRub: "7",
      amountMicros: 7000000,
    };
    await assert.rejects(
      first.settle(f.board.user.id, manualHold, manualReceipt),
      /Стоимость превысила резерв/,
    );
    const budgetBefore = await f.db.query(
      "select enabled,revision from ai_budget where id=1",
    );
    assert.equal(budgetBefore.rows[0]?.enabled, false);
    assert.deepEqual(await first.completedUnresolvedAfter(), []);
    const auditBefore = await f.db.query(
      "select * from audit_log where action='ai-credit-cost-overrun' and entity_type='ai-credit' and lower(entity_id)=$1",
      [manualHold],
    );
    assert.equal(
      await second.settleCompletedAutomatically(f.board.user.id, manualHold, {
        ...manualReceipt,
        costRub: "0.1",
        amountMicros: 100000,
      }),
      false,
      "the independent API connection preserves the existing manual overrun",
    );
    assert.deepEqual(
      (await f.db.query("select enabled,revision from ai_budget where id=1"))
        .rows,
      budgetBefore.rows,
    );
    assert.equal(
      (
        await peer.query(
          "select 1 from audit_log where action='ai-credit-cost-overrun' and entity_type='ai-credit' and lower(entity_id)=$1",
          [manualHold],
        )
      ).rows.length,
      1,
    );
    assert.deepEqual(
      (
        await peer.query(
          "select * from audit_log where action='ai-credit-cost-overrun' and entity_type='ai-credit' and lower(entity_id)=$1",
          [manualHold],
        )
      ).rows,
      auditBefore.rows,
    );
    assert.equal((await f.balance()).heldMicros, 5000000);
    assert.equal((await f.balance()).spentMicros, 1000000);
    assert.equal(
      (
        await f.ownerDb.query(
          "select has_table_privilege($1,'ai_credit_charges','SELECT') as allowed",
          [f.roles.citygo_worker],
        )
      ).rows[0]?.allowed,
      false,
    );
  },
);
