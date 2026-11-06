import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readConfig } from "@citygo/config";
import { connectDatabase, migrate } from "@citygo/db";
import {
  CONTRACT_VERSION_HEADER,
  assistantContextPreviewSchema,
  conversationMessagesResponseSchema,
  conversationDetailResponseSchema,
  dashboardResponseSchema,
  streamEventSchema,
  type WebSources,
} from "@citygo/contracts";
import type { StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { createAssistantModes, type ModeProviders } from "./ai-modes.js";
import { syntheticConsentsFor } from "./test-service-consents.js";
import { conservativeTextTokens } from "./model-context-budget.js";
import { instructions } from "@citygo/agents";

const model = "openai/gpt-6.1-sol";
const answer =
  "Сравните транспортную доступность по официальному источнику. 🏠";
const source = {
  url: "https://www.mos.ru/transport/",
  title: "Транспорт Москвы",
};
const sources: WebSources = {
  version: "routerai_native_v1",
  citations: [source],
};
const annotation = () => ({
  type: "url_citation",
  url_citation: { ...source, start_index: 0, end_index: 8 },
});

function streamEvents(body: string) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => streamEventSchema.parse(JSON.parse(line.slice(6))));
}

async function fixture(
  t: TestContext,
  injected?: StreamingProvider,
  memory = false,
) {
  // Isolated PGlite, synthetic credentials/consents and intercepted HTTPS only.
  // No environment files, real accounts, TEST_DATABASE_URL or paid transport.
  const db = await connectDatabase("pglite://:memory:");
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    try {
      await app?.close();
    } finally {
      await db.close();
    }
  });
  await migrate(db);
  const response: { text: string; annotations: unknown } = {
    text: answer,
    annotations: [annotation()],
  };
  const requests: Record<string, unknown>[] = [];
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, "https://routerai.ru/api/v1/chat/completions");
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.model, model);
      assert.equal(body.stream, false);
      assert.deepEqual(body.plugins, [
        { id: "web", engine: "native", max_results: 5 },
      ]);
      assert.deepEqual(body.provider, {
        only: ["openai"],
        allow_fallbacks: false,
        country: "us",
      });
      assert.equal(
        body.session_id,
        undefined,
        "the candidate cannot create a charge binding",
      );
      requests.push(body);
      return new Response(
        JSON.stringify({
          id: "gen-api-web-synthetic-" + requests.length,
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: response.text,
                ...(response.annotations === undefined
                  ? {}
                  : { annotations: response.annotations }),
              },
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    LLM_PROVIDER: "routerai",
    ROUTERAI_API_KEY: "synthetic-api-web-key",
    ROUTERAI_MODEL: "deepseek/deepseek-v4-pro-0813",
    ROUTERAI_UPSTREAM: "deepseek",
    ROUTERAI_COUNTRY: "cn",
    AI_ASSISTANT_MODES: "enabled",
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_candidate_v1",
    AI_MODES_DATA_NOTICE: "Synthetic native search recipients only.",
    ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
    ...(memory
      ? {
          AI_CONTEXT_STRATEGY: "model_window_memory_v1",
          LLM_MAX_INPUT_BYTES: "8388608",
          GIGACHAT_MODEL: "GigaChat-3-Ultra",
          GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
        }
      : {}),
  });
  const modeProviders: ModeProviders = injected ? { maximum: injected } : {};
  const modes = createAssistantModes(config, modeProviders)!;
  await db.query(
    "update ai_budget set enabled=true,mode='fixed',currency='RUB',daily_limit_micros=1000000,total_limit_micros=1000000,rules=$1 where id=1",
    [
      JSON.stringify(
        modes.routes
          .filter((route) => route.provider)
          .map((route) => ({ ...route.execution, attemptCeilingMicros: 1 })),
      ),
    ],
  );
  const open = async () => {
    app = await buildApp({ db, config, modeProviders, testing: true });
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
  const register = async () => {
    const reply = await call("POST", "/v1/auth/register", "", {
      email: randomUUID() + "@example.test",
      password: "123456",
      consents: await syntheticConsentsFor(app!),
    });
    assert.equal(reply.statusCode, 200, reply.body);
    return reply.cookies[0]!.value;
  };
  const token = await register();
  const start = await call("POST", "/v1/conversations/start", token, {
    agentKey: "support",
  });
  assert.equal(start.statusCode, 200, start.body);
  const threadId = start.json<{ id: string }>().id;
  const send = (
    text = "Сравните транспортную доступность районов.",
    using = token,
  ) =>
    call("POST", `/v1/threads/${threadId}/messages`, using, {
      text,
      requestId: randomUUID(),
      aiMode: "maximum",
      aiModeCatalogId: modes.catalogId,
      policyId: modes.policy.id,
    });
  const history = async () => {
    const reply = await call(
      "GET",
      `/v1/conversations/${threadId}/messages`,
      token,
    );
    assert.equal(reply.statusCode, 200, reply.body);
    return conversationMessagesResponseSchema.parse(reply.json()).messages;
  };
  const noCustomerMoney = async () => {
    for (const table of [
      "ai_credit_entries",
      "ai_credit_charges",
      "ai_postpay_attempts",
      "gigachat_request_fees",
    ]) {
      const count = (
        await db.query<{ count: string }>(
          `select count(*)::text as count from ${table}`,
        )
      ).rows[0]!.count;
      assert.equal(count, "0", table);
    }
  };
  return {
    db,
    modes,
    response,
    requests,
    fetch,
    call,
    register,
    token,
    threadId,
    send,
    history,
    noCustomerMoney,
    async reload() {
      await app!.close();
      await open();
    },
  };
}

test("native search answer and server-owned citations survive history and app reload, with owner isolation and no customer money", async (t) => {
  const f = await fixture(t);
  assert.equal(
    f.fetch.mock.callCount(),
    0,
    "construction and registration are offline",
  );
  const sent = await f.send();
  assert.equal(sent.statusCode, 200, sent.body);
  const events = streamEvents(sent.body);
  assert.equal(events.at(-1)?.type, "done", sent.body);
  assert.equal(
    events
      .filter((event) => event.type === "delta")
      .map((event) => event.text)
      .join(""),
    answer,
  );
  assert.equal(f.fetch.mock.callCount(), 1);
  const system = (
    f.requests[0]!.messages as { role: string; content: string }[]
  )[0]!;
  assert.equal(system.role, "system");
  assert.match(system.content, /доступен нативный веб-поиск/);
  assert.doesNotMatch(system.content, /нет веб-поиска/);
  const before = await f.history();
  const saved = before.at(-1)!;
  assert.equal(saved.role, "assistant");
  assert.equal(saved.status, "complete");
  assert.equal(saved.content, answer);
  assert.deepEqual(saved.generation?.webSources, sources);
  assert.equal(saved.generation?.requestedModel, model);
  assert.equal(saved.generation?.model, model);
  const raw = (
    await f.db.query<{ metadata: { generation?: { webSources?: unknown } } }>(
      "select metadata from messages where id=$1",
      [saved.id],
    )
  ).rows[0]!;
  assert.deepEqual(raw.metadata.generation?.webSources, sources);
  const other = await f.register();
  const foreignRead = await f.call(
    "GET",
    `/v1/conversations/${f.threadId}/messages`,
    other,
  );
  assert.equal(foreignRead.statusCode, 404);
  assert.doesNotMatch(foreignRead.body, /mos\.ru|Транспорт Москвы/);
  const foreignSend = await f.send(
    "Foreign owner must not reach the provider",
    other,
  );
  assert.ok([403, 404].includes(foreignSend.statusCode), foreignSend.body);
  assert.equal(f.fetch.mock.callCount(), 1);
  await f.reload();
  assert.deepEqual(await f.history(), before);
  const dashboard = await f.call("GET", "/v1/dashboard", f.token);
  assert.equal(dashboard.statusCode, 200, dashboard.body);
  dashboardResponseSchema.parse(dashboard.json());
  const detail = await f.call(
    "GET",
    `/v1/conversations/${f.threadId}`,
    f.token,
  );
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(
    conversationDetailResponseSchema.parse(detail.json()).thread.messages.at(-1)
      ?.generation?.webSources,
    sources,
  );
  assert.equal(
    f.fetch.mock.callCount(),
    1,
    "reloading must not repeat the model POST",
  );
  await f.noCustomerMoney();
});

test("missing or malformed upstream annotations interrupt safely and do not block a later valid answer", async (t) => {
  const f = await fixture(t);
  for (const bad of [
    undefined,
    [],
    [
      {
        type: "url_citation",
        url_citation: { url: "javascript:alert(1)", title: "Unsafe" },
      },
    ],
  ]) {
    f.response.annotations = bad;
    const sent = await f.send();
    assert.equal(sent.statusCode, 200, sent.body);
    const events = streamEvents(sent.body);
    assert.equal(events.at(-1)?.type, "error", sent.body);
    assert.ok(!events.some((event) => event.type === "done"));
    const saved = (await f.history()).at(-1)!;
    assert.equal(saved.status, "interrupted");
    assert.equal(saved.generation?.webSources, undefined);
    assert.doesNotMatch(sent.body, /javascript:|synthetic-api-web-key/);
  }
  f.response.annotations = [annotation()];
  const continued = await f.send("Следующий вопрос после прерванного ответа.");
  assert.equal(
    streamEvents(continued.body).at(-1)?.type,
    "done",
    continued.body,
  );
  assert.deepEqual((await f.history()).at(-1)?.generation?.webSources, sources);
  assert.equal(
    f.fetch.mock.callCount(),
    4,
    "there are no automatic duplicate POSTs",
  );
  await f.noCustomerMoney();
});

test("the API independently rejects missing or invalid completed source metadata from an injected candidate adapter", async (t) => {
  let webSources: unknown;
  const provider: StreamingProvider = {
    name: "routerai",
    model,
    async *stream() {
      yield { type: "delta", text: answer };
      yield {
        type: "complete",
        model,
        ...(webSources === undefined
          ? {}
          : { webSources: webSources as WebSources }),
      };
    },
  };
  const f = await fixture(t, provider);
  for (const value of [
    undefined,
    {
      version: "routerai_native_v1",
      citations: [{ url: "https://127.0.0.1/private", title: "Private" }],
    },
  ]) {
    webSources = value;
    const sent = await f.send();
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(streamEvents(sent.body).at(-1)?.type, "error", sent.body);
    const saved = (await f.history()).at(-1)!;
    assert.equal(saved.status, "interrupted");
    assert.equal(
      saved.content,
      answer,
      "partial text remains available without a trusted sources claim",
    );
    assert.equal(saved.generation?.webSources, undefined);
  }
  assert.equal(f.fetch.mock.callCount(), 0);
  await f.noCustomerMoney();
});

test("one large native answer is split into bounded Unicode-safe downstream frames and persisted exactly once with sources", async (t) => {
  const f = await fixture(t);
  // A single UTF-8 delta larger than the clients' 256 KiB event limit.
  f.response.text = "界".repeat(16383) + "🏠" + "界".repeat(93616);
  const sent = await f.send();
  assert.equal(sent.statusCode, 200, sent.body.slice(0, 500));
  const frames = sent.body
    .split("\n")
    .filter((line) => line.startsWith("data: "));
  for (const frame of frames)
    assert.ok(Buffer.byteLength(frame, "utf8") < 256 * 1024);
  const events = streamEvents(sent.body);
  const deltas = events.filter((event) => event.type === "delta");
  assert.ok(deltas.length > 1);
  for (const delta of deltas) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(delta.text));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(delta.text));
  }
  assert.equal(deltas.map((event) => event.text).join(""), f.response.text);
  assert.equal(events.at(-1)?.type, "done");
  const saved = (await f.history()).at(-1)!;
  assert.equal(saved.status, "complete");
  assert.equal(saved.content, f.response.text);
  assert.deepEqual(saved.generation?.webSources, sources);
  assert.equal(f.fetch.mock.callCount(), 1);
  assert.equal(
    (
      await f.db.query<{ count: string }>(
        "select count(*)::text as count from messages where thread_id=$1 and role='assistant' and metadata->'generation'->>'requestedModel'=$2",
        [f.threadId, model],
      )
    ).rows[0]!.count,
    "1",
  );
  await f.noCustomerMoney();
});

test("native search preview uses the same candidate instructions and conservative count as its single real intercepted send", async (t) => {
  const f = await fixture(t, undefined, true);
  const draft = "Проверьте актуальные условия городского транспорта.";
  const previews = [];
  for (const mode of ["maximum", "balanced"] as const) {
    const reply = await f.call("POST", "/v1/ai/context-preview", f.token, {
      threadId: f.threadId,
      draft,
      aiMode: mode,
      aiModeCatalogId: f.modes.catalogId,
      contextVersion: "model_window_memory_v1",
    });
    assert.equal(reply.statusCode, 200, reply.body);
    previews.push(assistantContextPreviewSchema.parse(reply.json()));
  }
  assert.equal(f.fetch.mock.callCount(), 0, "both previews are fully offline");
  assert.equal(previews[0]!.contextBudget!.mode, "maximum");
  assert.equal(previews[1]!.contextBudget!.mode, "balanced");
  const sent = await f.send(draft);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(streamEvents(sent.body).at(-1)?.type, "done", sent.body);
  const messages = f.requests[0]!.messages as {
    role: string;
    content: string;
  }[];
  assert.match(messages[0]!.content, /доступен нативный веб-поиск/);
  const exactConservativeInput = messages.reduce(
    (sum, row) => sum + conservativeTextTokens(row.content),
    0,
  );
  assert.equal(
    previews[0]!.contextBudget!.inputTextTokens,
    exactConservativeInput,
  );
  // Compare the preview against the exact server-owned prompt that was sent,
  // including its request date. A capability-only prompt has no clock date.
  assert.match(
    messages[0]!.content,
    /Дата запроса \(UTC\): \d{4}-\d{2}-\d{2}\./,
  );
  const promptDifference =
    conservativeTextTokens(messages[0]!.content) -
    conservativeTextTokens(instructions("support"));
  assert.equal(
    previews[0]!.contextBudget!.inputTextTokens -
      previews[1]!.contextBudget!.inputTextTokens,
    promptDifference,
  );
  assert.equal(f.fetch.mock.callCount(), 1);
  await f.noCustomerMoney();
});
