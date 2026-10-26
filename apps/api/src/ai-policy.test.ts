import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readConfig } from "@citygo/config";
import { createAiPolicy } from "./ai-policy.js";
import { createAiControl } from "./ai-control.js";
import { TestProvider } from "@citygo/testkit";

test("recipient snapshot changes for model, provider, upstream, country and account scope", () => {
  const provider = { name: "routerai" as const, model: "test/model" };
  const config = readConfig({
    ROUTERAI_UPSTREAM: "test-upstream",
    ROUTERAI_COUNTRY: "ru",
  });
  const policy = createAiPolicy(config, provider)!;
  assert.match(policy.id, /^[a-f0-9]{64}$/);
  for (const changed of [
    createAiPolicy(config, { ...provider, model: "test/other" }),
    createAiPolicy(config, { ...provider, name: "openai" }),
    createAiPolicy({ ...config, ROUTERAI_UPSTREAM: "other" }, provider),
    createAiPolicy({ ...config, ROUTERAI_COUNTRY: "us" }, provider),
  ])
    assert.notEqual(changed!.id, policy.id);
  const giga = { name: "gigachat" as const, model: "GigaChat-test" };
  assert.notEqual(
    createAiPolicy({ ...config, GIGACHAT_SCOPE: "GIGACHAT_API_PERS" }, giga)!
      .id,
    createAiPolicy({ ...config, GIGACHAT_SCOPE: "GIGACHAT_API_B2B" }, giga)!.id,
  );
  assert.equal(createAiPolicy(config), null);
});

test("recipient snapshot excludes keys, certificate paths and inactive provider settings", () => {
  const provider = { name: "openai" as const, model: "test-model" };
  const original = createAiPolicy(readConfig({}), provider);
  const changed = createAiPolicy(
    readConfig({
      OPENAI_API_KEY: "secret-openai",
      ROUTERAI_API_KEY: "secret-router",
      GIGACHAT_CREDENTIALS: "secret-giga",
      GIGACHAT_CA_BUNDLE_FILE: "secret-path",
      ROUTERAI_UPSTREAM: "other",
    }),
    provider,
  );
  assert.deepEqual(changed, original);
  assert.doesNotMatch(JSON.stringify(changed), /secret/);
});

test("confirmed memory adds a new public fingerprint for every provider without renewing an old technical approval", () => {
  const config = readConfig({
    ROUTERAI_UPSTREAM: "synthetic-upstream",
    ROUTERAI_COUNTRY: "cn",
    ROUTERAI_DATA_NOTICE: "Synthetic operator notice, not approval.",
  });
  const providers = {
    openai: new TestProvider("openai"),
    routerai: new TestProvider("routerai"),
    gigachat: new TestProvider("gigachat"),
  };
  const control = createAiControl(config, providers);
  for (const provider of Object.values(providers)) {
    const current = createAiPolicy(config, provider)!;
    const oldDisclosure = {
      version:
        provider.name === "routerai" ? "ai-recipient-v2" : "ai-recipient-v1",
      provider: current.provider,
      model: current.model,
      recipient: current.recipient,
      routing: current.routing,
      data:
        "Для рекомендаций передаются город назначения, бюджет, дата, состав семьи и до 20 завершённых сообщений диалога, включая ваш новый вопрос. История может содержать ответы прежнего провайдера. Не отправляйте документы, платёжные данные и другие секреты. Условия хранения у получателя требуют отдельной проверки." +
        (provider.name === "routerai"
          ? "\nУведомление оператора: " + config.ROUTERAI_DATA_NOTICE
          : ""),
    };
    const oldId = createHash("sha256")
      .update(JSON.stringify(oldDisclosure))
      .digest("hex");
    assert.equal(current.version, "ai-recipient-v3-confirmed-memory");
    assert.match(
      current.data,
      /до 20 сведений, явно сохранённых вами в памяти разговора/,
    );
    assert.match(
      current.data,
      /Сведения из памяти могут использовать все помощники CityGo/,
    );
    assert.notEqual(current.id, oldId);
    assert.equal(
      control.resolve({ provider: provider.name, policyId: oldId, revision: 1 })
        .provider,
      undefined,
    );
    assert.equal(
      control.resolve({
        provider: provider.name,
        policyId: current.id,
        revision: 2,
      }).provider,
      provider,
    );
    assert.deepEqual(Object.keys(current).sort(), [
      "data",
      "id",
      "model",
      "provider",
      "recipient",
      "routing",
      "version",
    ]);
  }
});
