import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { createProvider, createProviderRegistry } from "./provider.js";

const credentials = {
  OPENAI_API_KEY: "test-secret-not-live",
  OPENAI_MODEL: "test-model",
};

test("RouterAI constructor receives provider-specific caps and reasoning without network", async (t) => {
  const bodies: unknown[] = [];
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        [
          {
            model: "openai/gpt-6-astra",
            choices: [
              { index: 0, delta: { content: "test" }, finish_reason: "stop" },
            ],
          },
          "[DONE]",
        ]
          .map(
            (value) =>
              `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
          )
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  );
  const provider = createProvider(
    readConfig({
      LLM_PROVIDER: "routerai",
      ROUTERAI_API_KEY: "synthetic-not-live",
      ROUTERAI_MODEL: "openai/gpt-6-astra",
      ROUTERAI_UPSTREAM: "openai",
      ROUTERAI_REASONING_EFFORT: "high",
      ROUTERAI_MAX_OUTPUT_TOKENS: "32768",
      ROUTERAI_REQUEST_TIMEOUT_MS: "240000",
    }),
  )!;
  for await (const event of provider.stream(
    "test",
    [],
    new AbortController().signal,
  ))
    assert.ok(event.type === "delta" || event.type === "complete");
  assert.deepEqual(deadlines, [240000]);
  assert.equal(bodies.length, 1);
  assert.equal(
    (bodies[0] as { max_completion_tokens: number }).max_completion_tokens,
    32768,
  );
  assert.equal(
    (bodies[0] as { reasoning_effort: string }).reasoning_effort,
    "high",
  );
});

test("legacy complete OpenAI configuration still works without LLM_PROVIDER", () => {
  for (const LLM_PROVIDER of [undefined, "", "openai"]) {
    const provider = createProvider(
      readConfig({ ...credentials, LLM_PROVIDER }),
    );
    assert.equal(provider?.name, "openai");
    assert.equal(provider?.model, "test-model");
  }
});

test("empty configuration and explicit disabled mode do not construct a provider", () => {
  assert.equal(createProvider(readConfig({})), undefined);
  assert.equal(
    createProvider(readConfig({ OPENAI_API_KEY: " ", OPENAI_MODEL: "" })),
    undefined,
  );
  assert.equal(
    createProvider(readConfig({ ...credentials, LLM_PROVIDER: "disabled" })),
    undefined,
  );
});

test("partial or explicitly selected OpenAI configuration fails without revealing secrets", () => {
  for (const env of [
    { LLM_PROVIDER: "openai" },
    { OPENAI_API_KEY: credentials.OPENAI_API_KEY },
    { OPENAI_MODEL: credentials.OPENAI_MODEL },
    { ...credentials, OPENAI_MODEL: " " },
  ]) {
    assert.throws(
      () => createProvider(readConfig(env)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /requires both OPENAI_API_KEY and OPENAI_MODEL/,
        );
        assert.doesNotMatch(error.message, /test-secret-not-live/);
        return true;
      },
    );
  }
});

test("GigaChat requires its own settings without falling back to OpenAI", () => {
  assert.throws(
    () =>
      createProvider(readConfig({ ...credentials, LLM_PROVIDER: "gigachat" })),
    /GigaChat requires/,
  );
});

const gigaSettings = {
  GIGACHAT_CREDENTIALS: Buffer.from(
    "test-client:test-secret-not-live",
  ).toString("base64"),
  GIGACHAT_MODEL: "GigaChat-test",
  GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
};

test("personal Ultra is an optional configured provider and preserves OpenAI and RouterAI", () => {
  const config = readConfig({
    ...credentials,
    ...routerSettings,
    ...gigaSettings,
    GIGACHAT_MODEL: "GigaChat-3-Ultra",
  });
  const registry = createProviderRegistry(config);
  assert.equal(registry.provider?.name, "openai");
  assert.equal(registry.providers.openai?.model, credentials.OPENAI_MODEL);
  assert.equal(
    registry.providers.routerai?.model,
    routerSettings.ROUTERAI_MODEL,
  );
  assert.equal(registry.providers.gigachat?.model, "GigaChat-3-Ultra");
  assert.equal(
    createProvider({ ...config, LLM_PROVIDER: "gigachat" })?.model,
    "GigaChat-3-Ultra",
  );

  for (const GIGACHAT_SCOPE of ["GIGACHAT_API_B2B", "GIGACHAT_API_CORP"]) {
    const incompatible = { ...config, GIGACHAT_SCOPE };
    const remaining = createProviderRegistry(incompatible);
    assert.equal(remaining.provider?.name, "openai");
    assert.equal(remaining.providers.openai?.model, credentials.OPENAI_MODEL);
    assert.equal(
      remaining.providers.routerai?.model,
      routerSettings.ROUTERAI_MODEL,
    );
    assert.equal(remaining.providers.gigachat, undefined);
    assert.throws(() =>
      createProvider({ ...incompatible, LLM_PROVIDER: "gigachat" }),
    );
  }
  assert.throws(
    () =>
      createProvider({
        ...config,
        NODE_ENV: "production",
        LLM_PROVIDER: "gigachat",
      }),
    /GigaChat production activation is blocked/,
  );
});

test("RouterAI DeepSeek can be primary while OpenAI and GigaChat Ultra remain selectable", () => {
  const config = readConfig({
    ...credentials,
    ...gigaSettings,
    GIGACHAT_MODEL: "GigaChat-3-Ultra",
    LLM_PROVIDER: "routerai",
    ROUTERAI_API_KEY: "test-router-not-live",
    ROUTERAI_MODEL: "deepseek/deepseek-v4-pro-0813",
    ROUTERAI_UPSTREAM: "deepseek",
    ROUTERAI_COUNTRY: "us",
    ROUTERAI_REASONING_EFFORT: "high",
    ROUTERAI_MAX_OUTPUT_TOKENS: "32768",
    ROUTERAI_REQUEST_TIMEOUT_MS: "240000",
  });
  const registry = createProviderRegistry(config);
  assert.equal(registry.provider, registry.providers.routerai);
  assert.equal(registry.provider?.model, config.ROUTERAI_MODEL);
  assert.equal(registry.providers.openai?.model, credentials.OPENAI_MODEL);
  assert.equal(registry.providers.gigachat?.model, "GigaChat-3-Ultra");
  for (const name of ["openai", "gigachat"] as const)
    assert.equal(createProvider({ ...config, LLM_PROVIDER: name })?.name, name);
  assert.equal(
    createProvider({ ...config, LLM_PROVIDER: "disabled" }),
    undefined,
  );
});

test("GigaChat selection is explicit and retains RouterAI, OpenAI and disabled behavior", () => {
  assert.equal(createProvider(readConfig(gigaSettings)), undefined);
  assert.equal(
    createProvider(readConfig({ ...gigaSettings, ...credentials }))?.name,
    "openai",
  );
  assert.equal(
    createProvider(
      readConfig({ ...gigaSettings, ...credentials, LLM_PROVIDER: "disabled" }),
    ),
    undefined,
  );
  assert.equal(
    createProvider(
      readConfig({
        ...gigaSettings,
        ...routerSettings,
        LLM_PROVIDER: "routerai",
      }),
    )?.name,
    "routerai",
  );
  for (const NODE_ENV of ["development", "test"]) {
    const provider = createProvider(
      readConfig({
        ...gigaSettings,
        ...credentials,
        LLM_PROVIDER: "gigachat",
        NODE_ENV,
      }),
    );
    assert.equal(provider?.name, "gigachat");
    assert.equal(provider?.model, "GigaChat-test");
  }
});

test("GigaChat rejects partial credentials, invalid scope and production activation", () => {
  for (const field of Object.keys(gigaSettings))
    assert.throws(
      () =>
        createProvider(
          readConfig({
            ...gigaSettings,
            ...credentials,
            [field]: " ",
            LLM_PROVIDER: "gigachat",
          }),
        ),
      /GigaChat requires/,
    );
  assert.throws(
    () =>
      createProvider(
        readConfig({
          ...gigaSettings,
          LLM_PROVIDER: "gigachat",
          GIGACHAT_SCOPE: "typo",
        }),
      ),
    /GIGACHAT_SCOPE/,
  );
  assert.throws(
    () =>
      createProvider(
        readConfig({
          ...gigaSettings,
          LLM_PROVIDER: "gigachat",
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://localhost/citygo",
          WEB_ORIGIN: "https://citygo.example",
          TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
        }),
      ),
    /GigaChat production activation is blocked/,
  );
  assert.throws(
    () =>
      createProvider(
        readConfig({
          ...gigaSettings,
          LLM_PROVIDER: "gigachat",
          GIGACHAT_CA_BUNDLE_FILE: "missing-test-ca.pem",
        }),
      ),
    /GIGACHAT_CA_BUNDLE_FILE/,
  );
});

const routerSettings = {
  ROUTERAI_API_KEY: "test-router-secret",
  ROUTERAI_MODEL: "test/model",
  ROUTERAI_UPSTREAM: "test-upstream",
};
test("RouterAI is opt-in, retains independent OpenAI configuration and respects disabled", () => {
  assert.equal(createProvider(readConfig(routerSettings)), undefined);
  assert.equal(
    createProvider(readConfig({ ...routerSettings, ...credentials }))?.name,
    "openai",
  );
  assert.equal(
    createProvider(
      readConfig({
        ...routerSettings,
        ...credentials,
        LLM_PROVIDER: "disabled",
      }),
    ),
    undefined,
  );
  for (const NODE_ENV of ["development", "test"]) {
    const provider = createProvider(
      readConfig({
        ...routerSettings,
        ...credentials,
        LLM_PROVIDER: "routerai",
        NODE_ENV,
      }),
    );
    assert.equal(provider?.name, "routerai");
    assert.equal(provider?.model, "test/model");
  }
});

test("RouterAI requires its own complete settings and never borrows OpenAI values", () => {
  for (const field of Object.keys(routerSettings)) {
    assert.throws(
      () =>
        createProvider(
          readConfig({
            ...routerSettings,
            ...credentials,
            [field]: " ",
            LLM_PROVIDER: "routerai",
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /RouterAI requires/);
        assert.doesNotMatch(
          error.message,
          /test-router-secret|test-secret-not-live/,
        );
        return true;
      },
    );
  }
  assert.throws(
    () =>
      createProvider(
        readConfig({
          ...routerSettings,
          LLM_PROVIDER: "routerai",
          ROUTERAI_MODEL: "test/model@provider=other",
        }),
      ),
    /ROUTERAI_MODEL/,
  );
});

test("RouterAI production activation is blocked even with valid settings", () => {
  assert.throws(
    () =>
      createProvider(
        readConfig({
          ...routerSettings,
          ...credentials,
          LLM_PROVIDER: "routerai",
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://localhost/citygo",
          WEB_ORIGIN: "https://citygo.example",
          TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
        }),
      ),
    /production activation is blocked/,
  );
});

test("registry prepares independent configured adapters without changing bootstrap selection", () => {
  const registry = createProviderRegistry(
    readConfig({ ...credentials, ...routerSettings, ...gigaSettings }),
  );
  assert.equal(registry.provider?.name, "openai");
  assert.deepEqual(Object.keys(registry.providers).sort(), [
    "gigachat",
    "openai",
    "routerai",
  ]);
  assert.equal(registry.providers.gigachat?.model, gigaSettings.GIGACHAT_MODEL);
  assert.equal(
    registry.providers.routerai?.model,
    routerSettings.ROUTERAI_MODEL,
  );
});

test("inactive invalid settings do not disable OpenAI; disabled environment constructs no registry", () => {
  const config = readConfig({
    ...credentials,
    ...gigaSettings,
    GIGACHAT_SCOPE: "invalid",
    ROUTERAI_API_KEY: "unused-secret",
  });
  assert.deepEqual(Object.keys(createProviderRegistry(config).providers), [
    "openai",
  ]);
  assert.deepEqual(
    createProviderRegistry({ ...config, LLM_PROVIDER: "disabled" }),
    { provider: undefined, providers: {} },
  );
});

test("production registry cannot offer RouterAI or GigaChat even with complete settings", () => {
  const config = readConfig({
    ...credentials,
    ...routerSettings,
    ...gigaSettings,
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://localhost/citygo",
    WEB_ORIGIN: "https://citygo.example",
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
  });
  assert.deepEqual(Object.keys(createProviderRegistry(config).providers), [
    "openai",
  ]);
  assert.throws(
    () => createProviderRegistry({ ...config, LLM_PROVIDER: "gigachat" }),
    /production activation is blocked/,
  );
});
