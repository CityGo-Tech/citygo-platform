import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { serviceAiProcessingSchema } from "@citygo/contracts";
import { createAssistantModes } from "./ai-modes.js";

const goldenSettings = {
  NODE_ENV: "test",
  LLM_PROVIDER: "routerai",
  AI_ASSISTANT_MODES: "enabled",
  AI_CREDIT_MODE: "routerai_citygo_10x",
  AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
  AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
  AI_MODES_DATA_NOTICE:
    "Synthetic mode recipients, not an approved production notice.",
  AI_MINIMUM_FIXED_FEE: "enabled",
  GIGACHAT_MODEL: "GigaChat-3-Ultra",
  GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
  GIGACHAT_CREDENTIALS: Buffer.from(
    "synthetic-client:synthetic-secret",
  ).toString("base64"),
  ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
};

test("disabled search preserves recorded pre-change paid policy/catalog/execution identities", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw Error("Network forbidden");
  });
  const golden = [
    {
      strategy: "legacy",
      maxInput: "65536",
      policy:
        "c5e9ae1dd12f351cd430001e97eea224ef4ca2dcebc0b2aa41bce04d962ef877",
      catalog:
        "3dd599864810796349fdbd386c656685fbcaf79c2ba83a0824dd697089ecd02a",
      executions: [
        "9f7fd06e0c1ba672518778f61b6a5bd2e3a7eadb776b1183889c8980623fad7d",
        "24c7ebf78eb87228d4af9d6d4db6ed7a05e4cc6aef63157cf7c3c4c31472663f",
        "2dc318545647a0c77519e9f2c17e1b14f40d655c4b21341c489ee0cfed2e663d",
      ],
    },
    {
      strategy: "model_window_memory_v1",
      maxInput: "8388608",
      policy:
        "034d6ae06816ed8cfab295b07a5b6460af8e937d7d9c24a8c8ddc2806ac7df31",
      catalog:
        "5a5de39a2030360a4179db4922217e4d776ab0019cde7c376f44a8a92fc4c385",
      executions: [
        "b6ec06b7b87b016abbe11f50ad31f40f284966ce66233c656365766463d732cb",
        "481ad1f3099f60c36c634b5564b028f5e3370496d2dd8a034730337f59ba279e",
        "a2659291d2ca70ababf8db0730bd38ffa7cc18410f8be50d4d740cc7cba99a0c",
      ],
    },
  ];
  for (const fixture of golden) {
    for (const flag of [undefined, "disabled"]) {
      const modes = createAssistantModes(
        readConfig({
          ...goldenSettings,
          AI_CONTEXT_STRATEGY: fixture.strategy,
          LLM_MAX_INPUT_BYTES: fixture.maxInput,
          AI_MAXIMUM_WEB_SEARCH: flag,
        }),
      )!;
      assert.equal(modes.policy.id, fixture.policy);
      assert.equal(modes.catalogId, fixture.catalog);
      assert.deepEqual(
        modes.routes.map(({ execution }) => execution.key),
        fixture.executions,
      );
      assert.deepEqual(
        modes.routes.map(({ protocol }) => protocol),
        ["responses", "chat/completions", "gigachat"],
      );
    }
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("candidate changes only Maximum route identity and advertises disclosure without making a fee claim or network call", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw Error("Network forbidden");
  });
  const env = {
    NODE_ENV: "test",
    LLM_PROVIDER: "routerai",
    ROUTERAI_API_KEY: "synthetic-router-key",
    AI_ASSISTANT_MODES: "enabled",
    AI_MODES_DATA_NOTICE: "Synthetic notice.",
    ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
    AI_MAXIMUM_REASONING_EFFORT: "high",
  };
  const before = createAssistantModes(readConfig(env))!;
  const candidate = createAssistantModes(
    readConfig({
      ...env,
      AI_MAXIMUM_WEB_SEARCH: "routerai_native_candidate_v1",
    }),
  )!;
  assert.notEqual(candidate.policy.id, before.policy.id);
  assert.notEqual(candidate.catalogId, before.catalogId);
  assert.equal(
    candidate.policy.version,
    "ai-assistant-modes-web-search-candidate-v1",
  );
  serviceAiProcessingSchema.parse(candidate.policy);
  assert.match(
    candidate.policy.data,
    /поисковые запросы.*внешней поисковой системе/,
  );
  assert.match(candidate.policy.data, /списание пользователю запрещено/);
  for (const route of candidate.routes) {
    const old = before.routes.find(({ id }) => id === route.id)!;
    assert.equal(route.config.AI_CREDIT_MODE, "disabled");
    assert.equal(route.fixedFee, undefined);
    assert.equal(route.model, old.model);
    assert.equal(route.country, old.country);
    assert.equal(route.upstream, old.upstream);
    assert.equal(
      route.execution.maxOutputTokens,
      old.execution.maxOutputTokens,
    );
    if (route.id === "maximum") {
      assert.equal(route.protocol, "chat/completions");
      assert.equal(old.protocol, "responses");
      assert.notEqual(route.policy.id, old.policy.id);
      assert.notEqual(route.execution.key, old.execution.key);
      assert.match(route.policy.routing, /пяти результатов.*не потоковый/);
      assert.equal(route.config.ROUTERAI_REASONING_EFFORT, "high");
    } else {
      assert.equal(route.protocol, old.protocol);
      assert.deepEqual(route.policy, old.policy);
      assert.deepEqual(route.execution, old.execution);
    }
  }
  assert.equal(candidate.legacyBalancedCompatibility, undefined);
  assert.equal(fetch.mock.callCount(), 0);
});

test("injected candidate configuration cannot bypass production or customer-charging rejection", () => {
  const config = readConfig({
    NODE_ENV: "test",
    AI_ASSISTANT_MODES: "enabled",
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_candidate_v1",
  });
  for (const changed of [
    { NODE_ENV: "production" as const },
    { AI_CREDIT_MODE: "routerai_citygo_10x" as const },
  ])
    assert.throws(
      () => createAssistantModes({ ...config, ...changed }),
      /unbillable non-production candidate/,
    );
});

test("retained bootstrap Balanced route keeps its own Chat protocol and execution", () => {
  const modes = createAssistantModes(
    readConfig({
      ...goldenSettings,
      AI_CUSTOMER_BILLING_MODE: "legacy",
      ROUTERAI_API_KEY: "synthetic-router-key",
      ROUTERAI_MODEL: "deepseek/deepseek-v4-pro-0813",
      ROUTERAI_UPSTREAM: "deepseek",
      ROUTERAI_COUNTRY: "cn",
      ROUTERAI_DATA_NOTICE: "Synthetic original recipient notice.",
      LLM_MAX_INPUT_BYTES: "8192",
    }),
  )!;
  const legacy = modes.catalogRoute("balanced", {
    currentAiConsentRequired: true,
  });
  assert.ok(legacy);
  assert.equal(legacy.protocol, "chat/completions");
  assert.deepEqual(
    legacy.execution,
    modes.legacyBalancedCompatibility!.execution,
  );
});

// This fixture exercises the real mode constructor through an intercepted
// transport; it never contacts RouterAI or accepts a search charge.
test("Maximum candidate mode actually selects the pinned native non-streaming transport", async (t) => {
  const bodies: unknown[] = [];
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, "https://routerai.ru/api/v1/chat/completions");
      assert.equal(init?.method, "POST");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: "gen-mode-search-synthetic",
          object: "chat.completion",
          model: "openai/gpt-6.1-sol",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Сведения из официального источника.",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      url: "https://www.mos.ru/",
                      title: "Москва",
                      start_index: 0,
                      end_index: 8,
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  const modes = createAssistantModes(
    readConfig({
      NODE_ENV: "test",
      LLM_PROVIDER: "routerai",
      ROUTERAI_API_KEY: "synthetic-router-key",
      AI_ASSISTANT_MODES: "enabled",
      AI_MAXIMUM_WEB_SEARCH: "routerai_native_candidate_v1",
      AI_MAXIMUM_REASONING_EFFORT: "high",
      ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
    }),
  )!;
  assert.equal(fetch.mock.callCount(), 0);
  const provider = modes.routes.find(({ id }) => id === "maximum")!.provider!;
  const events = [];
  for await (const event of provider.stream(
    "Instructions",
    [{ role: "user", content: "Latest question" }],
    new AbortController().signal,
  ))
    events.push(event);
  assert.equal(fetch.mock.callCount(), 1);
  const body = bodies[0] as Record<string, unknown>;
  assert.equal(body.model, "openai/gpt-6.1-sol");
  assert.equal(body.stream, false);
  assert.deepEqual(body.plugins, [
    { id: "web", engine: "native", max_results: 5 },
  ]);
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.provider, {
    only: ["openai"],
    allow_fallbacks: false,
    country: "us",
  });
  assert.equal(events.at(-1)?.type, "complete");
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.ok(provider.readCharge);
  await assert.rejects(
    provider.readCharge(
      "gen-mode-search-synthetic",
      "synthetic-reference",
      new AbortController().signal,
    ),
    /cost could not be confirmed/,
  );
  assert.equal(fetch.mock.callCount(), 1);
});
