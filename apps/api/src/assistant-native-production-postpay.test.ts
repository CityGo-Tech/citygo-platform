import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { readConfig } from "@citygo/config";
import {
  AiCreditLedger,
  ConversationMemory,
  connectDatabase,
  migrate,
  ServiceConsents,
} from "@citygo/db";
import {
  CONTRACT_VERSION_HEADER,
  assistantContextPreviewSchema,
  conversationMessagesResponseSchema,
  dashboardResponseSchema,
  streamEventSchema,
  type AiCredit,
} from "@citygo/contracts";
import { RouterAIProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { createAssistantModes } from "./ai-modes.js";
import { createAiPolicy } from "./ai-policy.js";
import { createProviderRegistry } from "./provider.js";
import { newToken, tokenHash } from "./auth.js";
import { conservativeTextTokens } from "./model-context-budget.js";

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
async function openNativeProductionDatabase(
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
  const databaseName = "native_production_" + randomUUID().replaceAll("-", "");
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
        assert.match(databaseName, /^native_production_[a-f0-9]{32}$/);
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
async function productionConfig(overrides: NodeJS.ProcessEnv = {}) {
  // Public, synthetic deployment fixture. No environment secrets are consulted.
  const publicSettings = JSON.parse(
    await readFile(
      new URL(
        "../../../deploy/fixtures/routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-assistant-modes-gigachat-flat3-profile.fixture.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as NodeJS.ProcessEnv;
  const settings = {
    ...publicSettings,
    NODE_ENV: "production",
    ADMIN_USER_IDS: "999999999",
    LLM_PROVIDER: "routerai",
    WEB_ORIGIN: "https://pilot.example.test",
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
    AI_REQUEST_COST_LIMIT_MODE: "operator_ceiling",
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_v1",
    AI_CONTEXT_STRATEGY: "model_window_memory_v1",
    LLM_MAX_INPUT_BYTES: "8388608",
    // The public fixture deliberately stops chat with zero count allowances.
    // These bounded synthetic test allowances are explicit, never production
    // changes or inferred grants. Routing and monetary budget still boot off.
    LLM_USER_DAILY_REQUEST_LIMIT: "20",
    LLM_GLOBAL_DAILY_REQUEST_LIMIT: "100",
    LLM_USER_DAILY_ATTEMPT_LIMIT: "40",
    LLM_GLOBAL_DAILY_ATTEMPT_LIMIT: "200",
    GIGACHAT_CA_BUNDLE_FILE: fileURLToPath(
      new URL(
        "../../../deploy/certificates/russian-trusted-root.crt",
        import.meta.url,
      ),
    ),
    ...overrides,
  };
  const preview = readConfig(settings);
  const base = createAiPolicy(preview, {
    name: "routerai",
    model: preview.ROUTERAI_MODEL!,
  });
  const modes = createAssistantModes(preview)!;
  assert.ok(base && modes);
  return readConfig({
    ...settings,
    ROUTERAI_PRODUCTION_POLICY_ID: base.id,
    AI_MODES_PRODUCTION_POLICY_ID: modes.policy.id,
  });
}

async function fixture(t: TestContext) {
  // Real production factory and default RouterAI transport: no provider/adapter
  // injection. The global transport is mocked BEFORE provider construction and
  // rejects every endpoint except the exact two synthetic RouterAI endpoints.
  t.mock.method(https, "request", () => {
    throw Error("Unexpected HTTPS transport (including GigaChat)");
  });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const db = await openNativeProductionDatabase(t, async () => {
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
    annotations: "valid" as "valid" | "absent" | "malformed",
    searchUsed: true,
    contextOverflow: false,
    requests: [] as { messages: { role: string; content: string }[] }[],
    heldAtTransport: [] as number[],
    spentAtTransport: [] as number[],
  };
  const references = new Map<string, string>();
  const getIds: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, "error");
    const account = (
      await db.query<{ held: string; spent: string }>(
        "select coalesce(sum(held_micros),0)::text as held,coalesce(sum(spent_micros),0)::text as spent from ai_credit_accounts",
      )
    ).rows[0]!;
    const held = account.held;
    state.heldAtTransport.push(Number(held));
    state.spentAtTransport.push(Number(account.spent));
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
        has_web_search: state.searchUsed,
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
    state.requests.push(payload);
    assert.equal(payload.model, model);
    assert.equal(payload.stream, false);
    // The trusted clock and source-selection policy are already in the system
    // prompt when sent; the shared context builder budgets these exact bytes.
    assert.equal(payload.messages[0].role, "system");
    assert.match(
      payload.messages[0].content,
      /Дата запроса \(UTC\): \d{4}-\d{2}-\d{2}\./,
    );
    assert.match(payload.messages[0].content, /действующую страницу услуги/);
    assert.match(payload.messages[0].content, /продолжи нативный поиск/);
    assert.match(
      payload.messages[0].content,
      /не является доказательством актуальности/,
    );
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
    if (state.contextOverflow)
      return new Response(
        JSON.stringify({
          error: {
            code: "context_length_exceeded",
            message: "synthetic provider window overflow",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    const id = "gen-native-production-synthetic-" + state.posts;
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
              ...(state.annotations === "absent"
                ? {}
                : {
                    annotations:
                      state.annotations === "valid"
                        ? [{ type: "url_citation", url_citation: source }]
                        : [
                            {
                              type: "url_citation",
                              url_citation: {
                                url: "javascript:synthetic",
                                title: "Malformed",
                              },
                            },
                          ],
                  }),
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
  const fetchMock = t.mock.method(globalThis, "fetch", transport);
  const config = await productionConfig();
  const modes = createAssistantModes(config)!;
  assert.equal(config.NODE_ENV, "production");
  assert.equal(modes.productionApproved, true);
  const maximum = modes.routes.find((route) => route.id === "maximum")!;
  assert.ok(
    maximum.provider instanceof RouterAIProvider,
    "production factory, not injected adapter, creates Maximum",
  );
  assert.equal(maximum.protocol, "chat/completions");
  assert.equal(maximum.policy.version, "ai-mode-route-web-search-postpay-v1");
  assert.equal(
    fetchMock.mock.callCount(),
    0,
    "factory construction is offline",
  );
  const timers = new Map<unknown, { callback: () => void; delay: number }>();
  const idleWaiters = new Set<() => void>();
  const isIdle = () =>
    [...timers.values()].some((item) => item.delay === 30000);
  // Production must reject an injected synthetic scheduler. Exercise its real
  // default scheduler and retain its actual timer handles/delays instead. The
  // spy only exposes the idle callback so a test can advance that one wait;
  // every deadline and unrelated timer still uses the unchanged real clock.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", ((
    ...args: Parameters<typeof setTimeout>
  ) => {
    const [callback, delay, ...callbackArgs] = args;
    if (delay !== 30000) return realSetTimeout(...args);
    const handle = realSetTimeout(() => {
      timers.delete(handle);
      callback(...callbackArgs);
    }, delay);
    timers.set(handle, { callback: () => callback(...callbackArgs), delay });
    for (const notify of [...idleWaiters]) notify();
    return handle;
  }) as typeof setTimeout);
  t.mock.method(
    globalThis,
    "clearTimeout",
    (handle: Parameters<typeof clearTimeout>[0]) => {
      timers.delete(handle);
      return realClearTimeout(handle);
    },
  );
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
  const enableBudget = async () =>
    db.query(
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
      ...createProviderRegistry(config),
      testing: true,
    });
    // Fastify starts the background reconciler from onReady, not buildApp.
    await app.ready();
    await idle();
  };
  // Boot cannot grant routing or spend. Only this fixture's explicit synthetic
  // operator writes below enable the exact freshly computed execution IDs.
  await db.query(
    "insert into ai_routing(id,provider,policy_id,revision) values(1,'disabled',null,1)",
  );
  await open();
  assert.equal(
    (await app!.inject({ method: "GET", url: "/ready" })).statusCode,
    200,
  );
  assert.deepEqual(
    (await db.query("select provider,policy_id from ai_routing where id=1"))
      .rows,
    [{ provider: "disabled", policy_id: null }],
  );
  assert.equal(
    (await db.query("select enabled from ai_budget where id=1")).rows[0]!
      .enabled,
    false,
  );
  assert.equal(state.posts, 0);
  assert.equal(state.gets, 0);
  await db.query(
    "update ai_routing set provider='routerai',policy_id=$1,revision=2 where id=1",
    [modes.policy.id],
  );
  await enableBudget();
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
        origin: config.WEB_ORIGIN,
        "x-forwarded-proto": "https",
        cookie: "__Host-citygo=" + token,
        [CONTRACT_VERSION_HEADER]: "1",
      },
      ...(payload ? { payload } : {}),
    });
  const token = newToken(),
    email = randomUUID() + "@example.test";
  const serviceConsents = new ServiceConsents(db, () => modes.policy);
  const consentPolicy = await serviceConsents.policy();
  const user = await serviceConsents.register(
    email,
    "synthetic-not-a-live-password-hash",
    tokenHash(token),
    {
      policyVersion: consentPolicy.version,
      personalData: true,
      marketing: false,
    },
  );
  assert.equal(user.role, "user");
  // Directly seed a consumed synthetic proof; the real provenance trigger still
  // validates the verification. No email, OTP, provider or registration HTTP.
  const confirmation = randomUUID(),
    digest = tokenHash("synthetic-proof-" + randomUUID());
  await db.query(
    `insert into account_email_confirmation_challenges(
    id,user_id,email,credential_digest,session_token_hash,proof_hash,code_hash,recipient_key,
    delivery,expires_at,consumed_at) values($1,$2,$3,$4,$5,$4,$4,$4,'sent',clock_timestamp()+interval '10 minutes',clock_timestamp())`,
    [confirmation, user.id, email, digest, tokenHash(token)],
  );
  await db.query(
    "insert into account_email_verifications(user_id,confirmation_id,email) values($1,$2,$3)",
    [user.id, confirmation, email],
  );
  assert.equal(
    (await serviceConsents.state(user.id)).currentAiConsentRequired,
    false,
  );
  const board = dashboardResponseSchema.parse(
    (await call("GET", "/v1/dashboard", token)).json(),
  );
  assert.equal(board.user.role, "user");
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
    requestId: string = randomUUID(),
    override: Record<string, unknown> = {},
  ) =>
    call("POST", `/v1/threads/${threadId}/messages`, token, {
      text,
      requestId,
      aiMode: "maximum",
      aiModeCatalogId: modes.catalogId,
      policyId: modes.policy.id,
      ...override,
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
    realClearTimeout(waiting[0] as ReturnType<typeof setTimeout>);
    timers.delete(waiting[0]);
    waiting[1].callback();
    await idle();
  };
  return {
    db,
    state,
    config,
    modes,
    user,
    token,
    threadId,
    call,
    enableBudget,
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

async function count(
  f: Awaited<ReturnType<typeof fixture>>,
  table:
    | "ai_postpay_attempts"
    | "ai_model_attempts"
    | "messages"
    | "conversation_memory_fragments",
) {
  return (
    await f.db.query<{ n: number }>(`select count(*)::int as n from ${table}`)
  ).rows[0]!.n;
}

test("production native Maximum is created only by its exact explicit approval and new factory profile; disabled/test/old IDs remain separate", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw Error("Factory must remain offline");
  });
  t.mock.method(https, "request", () => {
    throw Error("Factory HTTPS must remain offline");
  });
  const config = await productionConfig();
  const modes = createAssistantModes(config)!;
  const route = modes.routes.find((item) => item.id === "maximum")!;
  assert.ok(route.provider instanceof RouterAIProvider);
  assert.equal(route.protocol, "chat/completions");
  assert.equal(route.policy.version, "ai-mode-route-web-search-postpay-v1");
  const oldConfig = await productionConfig({
    AI_MAXIMUM_WEB_SEARCH: "disabled",
  });
  const old = createAssistantModes(oldConfig)!;
  // Frozen from dbf6497 before adding the production profile. Computing both
  // sides from the new factory alone would miss an accidental legacy ID drift.
  assert.equal(
    old.policy.id,
    "05842e64e3580975b80886c0f708c2e5c3775ce87459fa0eef15c0b716f796a9",
  );
  assert.equal(
    old.catalogId,
    "cfe28d601e526a3cec09e19e0cbb4b2691cb8194907f3e36d6e766fb986c8b91",
  );
  assert.deepEqual(
    old.routes.map((item) => ({
      id: item.id,
      policy: item.policy.id,
      execution: item.execution.key,
    })),
    [
      {
        id: "maximum",
        policy:
          "bd758d79be81ae732dee7ff2754b079d8cac29aba5334e2bc268582a4d2ec127",
        execution:
          "368666f68b794f1c25e5ea44007e942aa1ab58c04b81756dd9e49446fa8c2f15",
      },
      {
        id: "balanced",
        policy:
          "65b7c552b42d6bb7e4a8f67b9c30350165f80ed291b26671f0ff2bbce8345c30",
        execution:
          "ccf4d8de59407bc7dd1fab098e1703270935edb866e68d5bbedb61522da13a04",
      },
      {
        id: "minimum",
        policy:
          "4ca05a8a79e02c67c2556bc35a4e877eac3a891d5c75572b3c0ab0714679ac66",
        execution:
          "4d4d9f165481787e85a791831f6d2113bbfea81692ba1c30475b54cab3f8d93e",
      },
    ],
  );
  assert.equal(
    old.routes.find((item) => item.id === "maximum")!.protocol,
    "responses",
  );
  assert.notEqual(modes.catalogId, old.catalogId);
  assert.notEqual(modes.policy.id, old.policy.id);
  assert.notEqual(
    route.execution.key,
    old.routes.find((item) => item.id === "maximum")!.execution.key,
  );
  for (const id of ["balanced", "minimum"] as const) {
    assert.deepEqual(
      modes.routes.find((item) => item.id === id)!.execution,
      old.routes.find((item) => item.id === id)!.execution,
    );
  }
  for (const approval of [undefined, "a".repeat(64), old.policy.id]) {
    const denied = createAssistantModes({
      ...config,
      AI_MODES_PRODUCTION_POLICY_ID: approval,
    })!;
    assert.equal(denied.productionApproved, false);
    assert.ok(denied.routes.every((item) => item.provider === undefined));
  }
  for (const overrides of [
    { ROUTERAI_API_KEY: undefined },
    { LLM_PROVIDER: "disabled" as const },
  ]) {
    const unavailable = createAssistantModes({ ...config, ...overrides })!;
    assert.equal(
      unavailable.routes.find((item) => item.id === "maximum")!.provider,
      undefined,
    );
  }
  await assert.rejects(() =>
    productionConfig({
      AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_test_v1",
    }),
  );
  await assert.rejects(() =>
    productionConfig({ AI_CUSTOMER_BILLING_MODE: "legacy" }),
  );
  const isolated = createAssistantModes(
    await productionConfig({
      NODE_ENV: "test",
      AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_test_v1",
    }),
  )!;
  assert.equal(
    isolated.routes.find((item) => item.id === "maximum")!.provider,
    undefined,
    "reserved test-only paid profile still requires explicit adapter injection",
  );
  assert.notEqual(isolated.policy.id, modes.policy.id);
  assert.notEqual(isolated.catalogId, modes.catalogId);
  assert.equal(network.mock.callCount(), 0);
});

test("production factory accepts completed native answers with or without citations for either boolean search observation and bills only full total ×10", async (t) => {
  const f = await fixture(t);
  const requestIds: string[] = [];
  for (const annotations of ["absent", "valid"] as const) {
    for (const searchUsed of [false, true]) {
      f.state.annotations = annotations;
      f.state.searchUsed = searchUsed;
      const requestId = randomUUID();
      requestIds.push(requestId);
      const reply = await f.send(
        "Синтетический контрольный вопрос.",
        requestId,
      );
      assert.equal(reply.statusCode, 200, reply.body);
      assert.equal(events(reply.body).at(-1)?.type, "done", reply.body);
      const last = (await f.history()).at(-1)!;
      assert.equal(last.content, answer);
      assert.deepEqual(
        last.generation?.webSources,
        annotations === "valid" ? expectedSources : undefined,
      );
      const balance = await f.balance();
      assert.equal(balance.heldMicros, 0);
      assert.equal(balance.spentMicros, requestIds.length * 73_918_283);
      assert.equal(
        balance.availableMicros,
        500_000_000 - requestIds.length * 73_918_283,
      );
      const replay = await f.send(
        "Синтетический контрольный вопрос.",
        requestId,
      );
      assert.equal(replay.statusCode, 409);
      assert.equal(f.state.posts, requestIds.length);
    }
  }
  const paid = await f.db.query<{
    state: string;
    receipt: { costRub: string };
    protocol: string;
  }>(
    "select state,receipt,protocol from ai_postpay_attempts order by created_at",
  );
  assert.equal(paid.rows.length, 4);
  for (const row of paid.rows) {
    assert.equal(row.state, "settled");
    assert.equal(row.protocol, "chat/completions");
    assert.equal(
      row.receipt.costRub,
      fullCost,
      "preserve raw total including search, reasoning, cached input and any tool fee",
    );
  }
  assert.deepEqual(f.state.heldAtTransport, Array(8).fill(0));
  assert.deepEqual(
    f.state.spentAtTransport,
    [
      0, 0, 73_918_283, 73_918_283, 147_836_566, 147_836_566, 221_754_849,
      221_754_849,
    ],
    "no new debit before the model answer and its complete exact price evidence",
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries where kind='hold'")).rows
      .length,
    0,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries where kind='settle'"))
      .rows.length,
    4,
  );
  await f.reload();
  await f.tick();
  await f.send("Синтетический контрольный вопрос.", requestIds[0]);
  assert.equal(f.state.posts, 4);
  assert.equal(f.state.gets, 4);
  assert.equal((await f.balance()).spentMicros, 4 * 73_918_283);
  assert.deepEqual(
    (await f.history()).at(-1)?.generation?.webSources,
    expectedSources,
  );
});

test("production native cost outage, wrong identities and zero remain pending without a hold; restart and GET-only repair settle exactly once", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID();
  f.state.costDown = true;
  assert.equal(
    events((await f.send("Синтетическая сверка.", requestId)).body).at(-1)
      ?.type,
    "done",
  );
  assert.equal((await f.attempt()).state, "pending");
  assert.equal((await f.balance()).spentMicros, 0);
  assert.equal((await f.balance()).heldMicros, 0);
  await f.reload();
  f.state.costDown = false;
  for (const patch of [
    { id: "gen-other-synthetic" },
    { session_id: randomUUID() },
    { model: "openai/other" },
    { provider: "deepseek" },
    { api: "responses" },
    { source: "chat" },
    { currency: "USD" },
    { has_web_search: "true" },
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
  f.state.cost = "0";
  await f.tick();
  const zero = await f.attempt();
  assert.equal(zero.state, "pending");
  assert.equal(zero.receipt, null);
  assert.equal(zero.observed_receipt?.costRub, "0");
  f.state.cost = fullCost;
  f.state.searchUsed = false;
  await f.tick();
  await f.tick();
  await f.send("Синтетическая сверка.", requestId);
  assert.equal((await f.attempt()).state, "settled");
  assert.equal((await f.balance()).spentMicros, 73_918_283);
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal(f.state.posts, 1);
  assert.equal(new Set(f.getIds).size, 1);
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

test("production native malformed present citations interrupt and keep positive price as observation only; the next question remains usable", async (t) => {
  const f = await fixture(t);
  f.state.annotations = "malformed";
  const rejected = await f.send();
  assert.equal(events(rejected.body).at(-1)?.type, "error", rejected.body);
  await f.tick();
  const interrupted = await f.attempt();
  assert.equal(interrupted.response_complete, false);
  assert.equal(interrupted.receipt, null);
  assert.equal(interrupted.observed_receipt?.costRub, fullCost);
  assert.equal((await f.balance()).spentMicros, 0);
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal((await f.history()).at(-1)?.generation?.webSources, undefined);
  f.state.annotations = "absent";
  assert.equal(
    events((await f.send("Новый синтетический вопрос.")).body).at(-1)?.type,
    "done",
  );
  assert.equal(f.state.posts, 2);
  assert.equal((await f.balance()).spentMicros, 73_918_283);
});

test("production native admission preserves operator stops, daily caps, stale policy/catalog and old Responses-only grants before any POST", async (t) => {
  const f = await fixture(t);
  const blocked = async (override: Record<string, unknown> = {}) => {
    const reply = await f.send(
      "Синтетическая проверка запрета.",
      randomUUID(),
      override,
    );
    assert.doesNotMatch(reply.body, /"type":"done"/);
    assert.equal(f.state.posts, 0);
    assert.equal(f.state.gets, 0);
    assert.equal(await count(f, "ai_model_attempts"), 0);
    assert.equal(await count(f, "ai_postpay_attempts"), 0);
    assert.equal((await f.balance()).spentMicros, 0);
    assert.equal((await f.balance()).heldMicros, 0);
  };
  await f.db.query("update ai_budget set enabled=false where id=1");
  await blocked();
  await f.enableBudget();
  await f.db.query(
    "update ai_budget set daily_limit_micros=1000000 where id=1",
  );
  await blocked();
  await f.enableBudget();
  await f.db.query(
    "update ai_budget set user_daily_limit_micros=1000000 where id=1",
  );
  await blocked();
  await f.db.query(
    "update ai_budget set user_daily_limit_micros=null where id=1",
  );
  await blocked({ policyId: "a".repeat(64) });
  await blocked({ aiModeCatalogId: "b".repeat(64) });
  const old = createAssistantModes(
    await productionConfig({ AI_MAXIMUM_WEB_SEARCH: "disabled" }),
  )!;
  const oldMaximum = old.routes.find((route) => route.id === "maximum")!;
  assert.equal(oldMaximum.protocol, "responses");
  await f.db.query("update ai_budget set rules=$1 where id=1", [
    JSON.stringify([
      { ...oldMaximum.execution, attemptCeilingMicros: 6000000 },
    ]),
  ]);
  await blocked();
  await f.enableBudget();
  assert.equal(
    events((await f.send("Синтетический разрешённый вопрос.")).body).at(-1)
      ?.type,
    "done",
  );
  assert.equal(f.state.posts, 1);
});

test("production native full actual cost above balance settles into debt once without a hold or disabling the operator budget", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID();
  f.state.cost = "60.000000123";
  const sent = await f.send("Синтетический перерасход.", requestId);
  assert.equal(events(sent.body).at(-1)?.type, "done", sent.body);
  const balance = await f.balance();
  assert.equal(balance.spentMicros, 600_000_001);
  assert.equal(balance.availableMicros, -100_000_001);
  assert.equal(balance.outstandingDebtMicros, 100_000_001);
  assert.equal(balance.heldMicros, 0);
  assert.equal(
    (await f.db.query("select enabled from ai_budget where id=1")).rows[0]!
      .enabled,
    true,
  );
  await f.reload();
  await f.tick();
  await f.send("Синтетический перерасход.", requestId);
  assert.equal((await f.balance()).spentMicros, 600_000_001);
  const blocked = await f.send("Ещё один вопрос при долге.");
  assert.doesNotMatch(blocked.body, /"type":"done"/);
  assert.equal(f.state.posts, 1);
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries where kind='settle'"))
      .rows.length,
    1,
  );
});

test("production native factory sends the full 100000-character latest question and source memory, keeps preview offline and does not retry a provider window rejection", async (t) => {
  const f = await fixture(t);
  const original =
    "Работаю на проспекте Вернадского, 17. У меня двое детей. Доход 180 тысяч.";
  await f.db.query(
    "insert into messages(thread_id,role,content,metadata) values($1,'user',$2,'{\"status\":\"complete\"}'),($1,'assistant','Первый синтетический ответ','{\"status\":\"complete\"}')",
    [f.threadId, original],
  );
  for (let n = 0; n < 55; n++)
    await f.db.query(
      "insert into messages(thread_id,role,content,metadata) values($1,'user',$2,'{\"status\":\"complete\"}'),($1,'assistant','Продолжаем','{\"status\":\"complete\"}')",
      [f.threadId, "Другой вопрос " + n],
    );
  const draft = "Я".repeat(100000);
  // The read-only preview labels an unindexed corpus as incomplete. Warm this
  // synthetic corpus with the real indexer first so preview/send equality is a
  // comparison of the same source snapshot, not a promise to index in preview.
  const memory = new ConversationMemory(f.db);
  let indexed = await memory.snapshot(f.user.id, f.threadId, draft);
  // The real backfill intentionally processes at most 16 source messages per
  // call. Finish this small known fixture in a bounded number of index batches.
  for (let batch = 1; batch < 8 && !indexed.indexComplete; batch++) {
    indexed = await memory.snapshot(f.user.id, f.threadId, draft);
  }
  assert.equal(indexed.indexComplete, true);
  const previewBefore = [
    await count(f, "messages"),
    await count(f, "conversation_memory_fragments"),
    await count(f, "ai_model_attempts"),
  ];
  const preview = await f.call("POST", "/v1/ai/context-preview", f.token, {
    threadId: f.threadId,
    draft,
    aiMode: "maximum",
    aiModeCatalogId: f.modes.catalogId,
    contextVersion: "model_window_memory_v1",
  });
  assert.equal(preview.statusCode, 200, preview.body);
  const parsed = assistantContextPreviewSchema.parse(preview.json());
  assert.equal(parsed.contextBudget!.mode, "maximum");
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
  assert.deepEqual(
    [
      await count(f, "messages"),
      await count(f, "conversation_memory_fragments"),
      await count(f, "ai_model_attempts"),
    ],
    previewBefore,
  );
  assert.equal(events((await f.send(draft)).body).at(-1)?.type, "done");
  const messages = f.state.requests.at(-1)!.messages;
  assert.equal(messages.at(-1)!.content, draft);
  assert.ok(
    messages.some((message) => message.content.includes(original)),
    "retain sourced older facts outside recent 100 stored messages",
  );
  assert.match(messages[0]!.content, /доступен нативный веб-поиск/);
  assert.equal(
    parsed.contextBudget!.inputTextTokens,
    messages.reduce(
      (sum, message) => sum + conservativeTextTokens(message.content),
      0,
    ),
  );
  assert.equal((await f.balance()).heldMicros, 0);
  assert.equal(
    (
      await f.db.query(
        "select 1 from conversation_memory_fragments where thread_id=$1 and content like '%Вернадского%'",
        [f.threadId],
      )
    ).rows.length,
    1,
  );
  const spent = (await f.balance()).spentMicros;
  f.state.contextOverflow = true;
  const rejected = await f.send(
    "Синтетический запрос, отклонённый окном провайдера.",
  );
  assert.equal(events(rejected.body).at(-1)?.type, "error", rejected.body);
  assert.equal(f.state.posts, 2, "no hidden automatic POST retry");
  assert.equal(f.state.gets, 1, "no invented generation/cost lookup");
  assert.equal((await f.balance()).spentMicros, spent);
  assert.equal((await f.balance()).heldMicros, 0);
  f.state.contextOverflow = false;
  assert.equal(
    events((await f.send("После отказа можно продолжить.")).body).at(-1)?.type,
    "done",
  );
  assert.equal(f.state.posts, 3);
  assert.equal((await f.balance()).spentMicros, 2 * 73_918_283);
});
