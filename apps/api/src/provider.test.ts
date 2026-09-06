import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { createProvider } from "./provider.js";

const credentials = {
  OPENAI_API_KEY: "test-secret-not-live",
  OPENAI_MODEL: "test-model",
};

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
