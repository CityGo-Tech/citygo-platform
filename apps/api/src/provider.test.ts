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

test("reserved adapters fail closed, even with valid OpenAI settings present", () => {
  for (const LLM_PROVIDER of ["routerai", "gigachat"]) {
    assert.throws(
      () => createProvider(readConfig({ ...credentials, LLM_PROVIDER })),
      /adapter is not installed/,
    );
  }
});
