import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { connectDatabase, migrate, Repository } from "@citygo/db";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { readConfig } from "@citygo/config";
import { instructions, profileContext } from "@citygo/agents";
import type { StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { createAiPolicy } from "./ai-policy.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";
import { seedTestBudget } from "./test-budget.js";

const oldData =
  "Для рекомендаций передаются город назначения, бюджет, дата, состав семьи и до 20 завершённых сообщений диалога, включая ваш новый вопрос. История может содержать ответы прежнего провайдера. Не отправляйте документы, платёжные данные и другие секреты. Условия хранения у получателя требуют отдельной проверки.";

async function fixture(t: TestContext, maxInputBytes?: number) {
  // Embedded PostgreSQL, synthetic sessions and an in-process provider only.
  // No network adapter, provider key, payment, email or SMS transport exists.
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const calls: string[] = [];
  const provider: StreamingProvider = {
    name: "routerai",
    model: "synthetic/memory-guards",
    async *stream(_instructions, messages) {
      calls.push(JSON.stringify(messages));
      yield { type: "delta", text: "Синтетический ответ" };
      yield { type: "complete", model: this.model };
    },
  };
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    WEB_ORIGIN: "http://localhost:3000",
    EMAIL_REGISTRATION_MODE: "disabled",
    PHONE_VERIFICATION_MODE: "disabled",
    YOOKASSA_MODE: "disabled",
    ROUTERAI_UPSTREAM: "synthetic-upstream",
    ROUTERAI_COUNTRY: "cn",
    ROUTERAI_DATA_NOTICE:
      "Synthetic operator notice; not a deployment approval.",
    ...(maxInputBytes === undefined
      ? {}
      : { LLM_MAX_INPUT_BYTES: String(maxInputBytes) }),
  });
  await seedTestBudget(db, config, { routerai: provider });
  const app = await buildApp({ db, provider, config, testing: true });
  t.after(async () => {
    try {
      await app.close();
    } finally {
      await db.close();
    }
  });
  const userId = await registerSyntheticConsentingUser(
    db,
    "memory-guards@example.test",
    "synthetic-hash",
  );
  await db.query("update users set role='super_admin' where id=$1", [userId]);
  const token = randomUUID();
  await new Repository(db).createSession(userId, tokenHash(token));
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        origin: "http://localhost:3000",
        cookie: "citygo=" + token,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const policy = createAiPolicy(config, provider)!;
  const sourceThread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,status) values($1,'support','closed') returning id::text",
      [userId],
    )
  ).rows[0]!.id;
  const sourceMessage = (
    await db.query<{ id: string }>(
      "insert into messages(thread_id,role,content,metadata) values($1,'user','Synthetic source only','{\"status\":\"complete\"}') returning id::text",
      [sourceThread],
    )
  ).rows[0]!.id;
  const save = (value: string) =>
    call("POST", "/v1/personal-memory", {
      operationId: randomUUID(),
      sourceMessageId: sourceMessage,
      label: "Подтверждённое сведение",
      value,
      confirmed: true,
    });
  const start = async () => {
    const result = await call("POST", "/v1/conversations/start", {
      agentKey: "support",
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.json<{ id: string }>().id;
  };
  const send = (threadId: string, text: string, policyId = policy.id) =>
    call("POST", `/v1/threads/${threadId}/messages`, {
      text,
      requestId: randomUUID(),
      policyId,
    });
  const money = async () =>
    (
      await db.query(
        `select jsonb_build_object(
          'attempts',(select count(*) from ai_model_attempts),
          'holds',(select count(*) from ai_credit_entries where kind='hold'),
          'charges',(select count(*) from ai_credit_charges),
          'reserved',(select total_reserved_micros::text from ai_budget where id=1),
          'accounts',(select coalesce(jsonb_agg(to_jsonb(a) order by user_id),'[]'::jsonb) from ai_credit_accounts a)
        ) as snapshot`,
      )
    ).rows[0]!.snapshot;
  return { db, call, policy, config, userId, calls, save, start, send, money };
}

test("old v2 routing and consent cannot send memory; both routing renewal and fresh user consent are required", async (t) => {
  const f = await fixture(t);
  const legacyDisclosure = {
    version: "ai-recipient-v2",
    provider: f.policy.provider,
    model: f.policy.model,
    recipient: f.policy.recipient,
    routing: f.policy.routing,
    data: oldData + "\nУведомление оператора: " + f.config.ROUTERAI_DATA_NOTICE,
  };
  const oldId = createHash("sha256")
    .update(JSON.stringify(legacyDisclosure))
    .digest("hex");
  assert.notEqual(oldId, f.policy.id);
  await f.db.query(
    "update ai_routing set provider='routerai',policy_id=$1,revision=2 where id=1",
    [oldId],
  );
  await f.db.query(
    "insert into ai_consents(user_id,policy_id,granted) values($1,$2,true)",
    [f.userId, oldId],
  );
  assert.equal(
    (await f.save("PRIVATE_MEMORY_REQUIRES_NEW_CONSENT")).statusCode,
    200,
  );
  const threadId = await f.start();
  const before = await f.money();
  const blocked = await f.send(threadId, "Последний вопрос", oldId);
  assert.equal(blocked.statusCode, 503, blocked.body);
  assert.equal(blocked.json().code, "AI_UNAVAILABLE");
  assert.equal(
    (
      await f.call("POST", "/v1/ai/consent", {
        action: "granted",
        policyId: oldId,
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(await f.money(), before);
  assert.equal(f.calls.length, 0);

  const renewed = await f.call("POST", "/v1/admin/ai", {
    provider: "routerai",
    policyId: f.policy.id,
    expectedRevision: 2,
  });
  assert.equal(renewed.statusCode, 200, renewed.body);
  const noNewConsent = await f.send(threadId, "Последний вопрос после допуска");
  assert.equal(noNewConsent.statusCode, 403, noNewConsent.body);
  assert.equal(noNewConsent.json().code, "AI_CONSENT_REQUIRED");
  assert.deepEqual(await f.money(), before);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(
    (
      await f.db.query(
        "select policy_id,granted from ai_consents where user_id=$1",
        [f.userId],
      )
    ).rows,
    [{ policy_id: oldId, granted: true }],
    "renewing the technical route must not silently update the user's consent",
  );
  const grant = await f.call("POST", "/v1/ai/consent", {
    action: "granted",
    policyId: f.policy.id,
  });
  assert.equal(grant.statusCode, 200, grant.body);
  const answer = await f.send(
    threadId,
    "Последний вопрос после явного согласия",
  );
  assert.match(answer.body, /"type":"done"/, answer.body);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!, /PRIVATE_MEMORY_REQUIRES_NEW_CONSENT/);
});

test("confirmed memory can overflow the mandatory input budget without a model attempt or monetary hold", async (t) => {
  const question = "Какой следующий шаг?";
  const baseBytes = Buffer.byteLength(
    JSON.stringify({
      instructions: instructions("support"),
      messages: [profileContext(null), { role: "user", content: question }],
    }),
    "utf8",
  );
  const maxInputBytes = baseBytes + 64;
  assert.ok(maxInputBytes >= 1024);
  const f = await fixture(t, maxInputBytes);
  const saved = await f.save("я".repeat(800));
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(
    (
      await f.call("POST", "/v1/ai/consent", {
        action: "granted",
        policyId: f.policy.id,
      })
    ).statusCode,
    200,
  );
  const threadId = await f.start();
  const before = await f.money();
  const answer = await f.send(threadId, question);
  assert.match(answer.body, /слишком длинный/, answer.body);
  assert.doesNotMatch(answer.body, /"type":"done"/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.money(), before);
  assert.equal(
    (await f.call("GET", "/v1/personal-memory")).json().items[0].value,
    "я".repeat(800),
  );
  const messages = (
    await f.db.query<{ content: string }>(
      "select content from messages where thread_id=$1 and role='user'",
      [threadId],
    )
  ).rows;
  assert.deepEqual(
    messages,
    [{ content: question }],
    "oversized context does not erase or rewrite the current question",
  );
});

test("corrupted stored memory fails privately before any prompt, attempt or charge instead of becoming a user validation error", async (t) => {
  const f = await fixture(t);
  const created = await f.save("PRIVATE_ORIGINAL_MEMORY");
  assert.equal(created.statusCode, 200, created.body);
  // PostgreSQL btrim without a character set trims ASCII spaces. A trusted
  // out-of-band write can therefore satisfy SQL while violating DTO trim/min.
  // No constraint or trigger is disabled to manufacture this corruption.
  await f.db.query(
    `update personal_memory_items set label='PRIVATE_CORRUPT_LABEL',value=$2,
      revision=revision+1,updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') where id=$1`,
    [created.json().item.id, "\u00a0"],
  );
  const list = await f.call("GET", "/v1/personal-memory");
  assert.equal(list.statusCode, 500, list.body);
  assert.match(list.json().error, /Не удалось прочитать память разговора/);
  assert.doesNotMatch(
    list.body,
    /PRIVATE_|sourceMessageId|create_request_hash|ZodError|issues|fields/,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/ai/consent", {
        action: "granted",
        policyId: f.policy.id,
      })
    ).statusCode,
    200,
  );
  const threadId = await f.start();
  const before = await f.money();
  const answer = await f.send(
    threadId,
    "Последний вопрос с повреждённой памятью",
  );
  assert.match(answer.body, /Не удалось прочитать память разговора/);
  assert.doesNotMatch(
    answer.body,
    /PRIVATE_|sourceMessageId|create_request_hash|"type":"done"/,
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.money(), before);
});
