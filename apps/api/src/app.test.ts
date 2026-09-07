import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate, Repository } from "@citygo/db";
import { testProfile, TestProvider } from "@citygo/testkit";
import {
  aiProviderIds,
  type AiProviderId,
  type Dashboard,
  type AiControlStatus,
} from "@citygo/contracts";
import {
  RouterAIProvider,
  OpenAIProvider,
  GigaChatProvider,
  type StreamingProvider,
} from "@citygo/llm";
import { buildApp } from "./app.js";
import { readConfig } from "@citygo/config";
import type { ProviderMap } from "./provider.js";

async function fixture(
  provider: boolean | StreamingProvider = true,
  env: NodeJS.ProcessEnv = {},
  providers: ProviderMap = {},
) {
  const base = process.env.TEST_DATABASE_URL;
  const schema = "test_" + randomUUID().replaceAll("-", "");
  const admin = base ? await connectDatabase(base) : null;
  let url = "pglite://:memory:";
  if (admin && base) {
    await admin.query('create schema "' + schema + '"');
    const scoped = new URL(base);
    scoped.searchParams.set("options", "-c search_path=" + schema);
    url = scoped.toString();
  }
  const db = await connectDatabase(url);
  await migrate(db);
  await migrate(db);
  const app = await buildApp({
    db,
    provider: provider === true ? new TestProvider() : provider || undefined,
    providers,
    testing: true,
    config: readConfig({ NODE_ENV: "test", ...env }),
  });
  async function close() {
    await app.close();
    await db.close();
    if (admin) {
      await admin.query('drop schema "' + schema + '" cascade');
      await admin.close();
    }
  }
  const origin = "http://localhost:3000";
  const call = async (
    method: "GET" | "POST",
    path: string,
    token = "",
    body?: object,
  ) => {
    // Model the updated client's dashboard snapshot, never auto-grant consent.
    if (path.endsWith("/messages") && token && body && !("policyId" in body)) {
      const board = (
        await app.inject({
          method: "GET",
          url: "/v1/dashboard",
          headers: { cookie: "citygo=" + token },
        })
      ).json<Dashboard>();
      body = { ...body, policyId: board.aiAccess?.policy?.id };
    }
    return app.inject({
      method,
      url: path,
      headers: { origin, ...(token ? { cookie: "citygo=" + token } : {}) },
      ...(body ? { payload: body } : {}),
    });
  };
  async function consent(token: string, target = app) {
    const headers = { origin, cookie: "citygo=" + token };
    const board = (
      await target.inject({ method: "GET", url: "/v1/dashboard", headers })
    ).json<Dashboard>();
    const policyId = board.aiAccess.policy!.id;
    const result = await target.inject({
      method: "POST",
      url: "/v1/ai/consent",
      headers,
      payload: { action: "granted", policyId },
    });
    assert.equal(result.statusCode, 200, result.body);
    return policyId;
  }
  async function activate(
    token: string,
    target = app,
    selected?: AiProviderId | "disabled",
  ) {
    const headers = { origin, cookie: "citygo=" + token };
    const response = await target.inject({
      method: "GET",
      url: "/v1/admin/ai",
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    const status = response.json<AiControlStatus>();
    const option = status.options.find(
      (entry) => entry.policy && (!selected || entry.provider === selected),
    );
    if (selected !== "disabled") assert.ok(option?.policy);
    const changed = await target.inject({
      method: "POST",
      url: "/v1/admin/ai",
      headers,
      payload: {
        provider: selected === "disabled" ? "disabled" : option!.provider,
        policyId: selected === "disabled" ? null : option!.policy!.id,
        expectedRevision: status.current.revision,
      },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    return changed.json<AiControlStatus["current"]>();
  }
  async function register() {
    const email = randomUUID() + "@example.test";
    const result = await call("POST", "/v1/auth/register", "", {
      email,
      password: "CityGo-test-password",
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.match(String(result.headers["set-cookie"]), /HttpOnly/);
    return { email, token: result.cookies[0]!.value };
  }
  return { app, db, call, consent, activate, register, close };
}

async function chatUser(f: Awaited<ReturnType<typeof fixture>>, grant = true) {
  const user = await f.register();
  await f.call("POST", "/v1/questionnaire", user.token, testProfile);
  const board = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  const thread = (
    await f.call(
      "POST",
      `/v1/quests/${board.quests[0]!.id}/start`,
      user.token,
      {},
    )
  ).json().id as string;
  if (grant) await f.consent(user.token);
  return {
    ...user,
    userId: board.user.id,
    thread,
    policyId: board.aiAccess.policy!.id,
  };
}

test("model attempts share an atomic global cap across users, replicas and provider switches", async (t) => {
  let calls = 0;
  const counted: StreamingProvider = {
    name: "openai",
    model: "test-model",
    async *stream() {
      calls++;
      yield { type: "delta", text: "Один ответ" };
      yield { type: "complete", model: "test-model" };
    },
  };
  const providers = { openai: counted, gigachat: new TestProvider("gigachat") };
  const env = {
    ADMIN_USER_IDS: "1",
    LLM_USER_DAILY_ATTEMPT_LIMIT: "5",
    LLM_GLOBAL_DAILY_ATTEMPT_LIMIT: "1",
  };
  const f = await fixture(counted, env, providers);
  t.after(f.close);
  const users = [await chatUser(f), await chatUser(f)];
  const replica = await buildApp({
    db: f.db,
    provider: counted,
    providers,
    testing: true,
    config: readConfig({ NODE_ENV: "test", ...env }),
  });
  t.after(() => replica.close());
  const replies = await Promise.all(
    users.map((user, index) =>
      (index ? replica : f.app).inject({
        method: "POST",
        url: `/v1/threads/${user.thread}/messages`,
        headers: {
          origin: "http://localhost:3000",
          cookie: "citygo=" + user.token,
        },
        payload: {
          text: "quota-test-input",
          requestId: randomUUID(),
          policyId: user.policyId,
        },
      }),
    ),
  );
  assert.equal(
    replies.filter((r) => r.body.includes('"type":"done"')).length,
    1,
  );
  assert.equal(
    replies.filter((r) => r.body.includes("Суточный лимит обращений")).length,
    1,
  );
  assert.equal(calls, 1);
  let status = (
    await f.call("GET", "/v1/admin/ai", users[0]!.token)
  ).json<AiControlStatus>();
  assert.equal(status.attempts!.reservedToday, 1);
  assert.equal(status.attempts!.recent.length, 1);
  assert.equal(status.attempts!.configurationMatches, true);
  assert.doesNotMatch(JSON.stringify(status), /quota-test-input/);
  await f.activate(users[0]!.token, f.app, "gigachat");
  await f.consent(users[0]!.token);
  const denied = await f.call(
    "POST",
    `/v1/threads/${users[0]!.thread}/messages`,
    users[0]!.token,
    {
      text: "Новый вопрос",
      requestId: randomUUID(),
    },
  );
  assert.match(denied.body, /Суточный лимит обращений/);
  status = (
    await f.call("GET", "/v1/admin/ai", users[0]!.token)
  ).json<AiControlStatus>();
  assert.equal(status.attempts!.reservedToday, 1);
  assert.equal(status.attempts!.recent[0]!.provider, "openai");
  assert.equal(status.attempts!.recent[0]!.requestStatus, "complete");
});

test("model attempt exhaustion blocks an actual OpenAI SDK retry and survives restart", async (t) => {
  let calls = 0;
  const provider = new OpenAIProvider("test-not-live", "test-model", {
    fetch: async () => {
      calls++;
      return new Response("{}", {
        status: 500,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      });
    },
  });
  const env = {
    ADMIN_USER_IDS: "1",
    LLM_USER_DAILY_ATTEMPT_LIMIT: "1",
    LLM_GLOBAL_DAILY_ATTEMPT_LIMIT: "10",
  };
  const f = await fixture(provider, env);
  t.after(f.close);
  const user = await chatUser(f);
  const path = `/v1/threads/${user.thread}/messages`;
  const first = await f.call("POST", path, user.token, {
    text: "Квартира",
    requestId: randomUUID(),
  });
  assert.match(first.body, /Суточный лимит обращений/);
  assert.doesNotMatch(first.body, /"type":"done"/);
  assert.equal(calls, 1);
  const restarted = await buildApp({
    db: f.db,
    provider,
    testing: true,
    config: readConfig({ NODE_ENV: "test", ...env }),
  });
  t.after(() => restarted.close());
  const result = await restarted.inject({
    method: "POST",
    url: path,
    headers: {
      origin: "http://localhost:3000",
      cookie: "citygo=" + user.token,
    },
    payload: {
      text: "Квартира",
      requestId: randomUUID(),
      policyId: user.policyId,
    },
  });
  assert.match(result.body, /Суточный лимит обращений/);
  assert.equal(calls, 1);
  const rows = (await f.db.query("select * from ai_model_attempts")).rows;
  assert.equal(rows.length, 1);
  const board = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  assert.equal(board.xp, 0);
  assert.equal(board.thread!.messages.at(-1)!.status, "interrupted");
  // Chat admissions are a separate counter; a denied model attempt is not retried/refunded.
  assert.equal(
    (
      await f.db.query<{ accepted_requests: number }>(
        "select accepted_requests from ai_usage_daily",
      )
    ).rows[0]!.accepted_requests,
    2,
  );
});

test("model attempt zero and changed daily configuration fail closed without model I/O", async (t) => {
  let calls = 0;
  const provider: StreamingProvider = {
    name: "openai",
    model: "test-model",
    async *stream() {
      calls++;
      yield { type: "delta", text: "Ответ" };
      yield { type: "complete", model: "test-model" };
    },
  };
  const f = await fixture(provider, {
    ADMIN_USER_IDS: "1",
    LLM_USER_DAILY_ATTEMPT_LIMIT: "2",
  });
  t.after(f.close);
  const user = await chatUser(f);
  await f.call("POST", `/v1/threads/${user.thread}/messages`, user.token, {
    text: "Квартира",
    requestId: randomUUID(),
  });
  for (const limit of ["0", "3"]) {
    const replica = await buildApp({
      db: f.db,
      provider,
      testing: true,
      config: readConfig({
        NODE_ENV: "test",
        ADMIN_USER_IDS: "1",
        LLM_USER_DAILY_ATTEMPT_LIMIT: limit,
      }),
    });
    t.after(() => replica.close());
    const headers = {
      origin: "http://localhost:3000",
      cookie: "citygo=" + user.token,
    };
    const result = await replica.inject({
      method: "POST",
      url: `/v1/threads/${user.thread}/messages`,
      headers,
      payload: {
        text: "Квартира",
        requestId: randomUUID(),
        policyId: user.policyId,
      },
    });
    assert.match(
      result.body,
      limit === "0" ? /временно отключены/ : /не согласованы/,
    );
    const status = (
      await replica.inject({ method: "GET", url: "/v1/admin/ai", headers })
    ).json<AiControlStatus>();
    assert.equal(status.attempts!.configurationMatches, false);
    assert.deepEqual(status.attempts!.pinnedLimits, {
      userDailyLimit: 2,
      globalDailyLimit: 200,
    });
    assert.equal(status.attempts!.reservedToday, 1);
  }
  assert.equal(calls, 1);
});

test("model attempts count GigaChat 401 resubmission separately from OAuth", async (t) => {
  let chats = 0,
    auth = 0;
  const provider = new GigaChatProvider("dGVzdA==", "test-model", {
    scope: "GIGACHAT_API_PERS",
    post: async (url) => {
      if (url.includes("oauth")) {
        auth++;
        return Response.json({
          access_token: "test-token-" + auth,
          expires_at: Date.now() + 1800000,
        });
      }
      chats++;
      if (chats === 1) return new Response("", { status: 401 });
      return new Response(
        [
          {
            model: "test-model",
            choices: [{ index: 0, delta: { content: "Ответ" } }],
          },
          {
            model: "test-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]
          .map((event) => "data: " + JSON.stringify(event) + "\n\n")
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const f = await fixture(provider, {
    ADMIN_USER_IDS: "1",
    LLM_USER_DAILY_ATTEMPT_LIMIT: "2",
  });
  t.after(f.close);
  const user = await chatUser(f);
  const response = await f.call(
    "POST",
    `/v1/threads/${user.thread}/messages`,
    user.token,
    { text: "Квартира", requestId: randomUUID() },
  );
  assert.match(response.body, /"type":"done"/);
  assert.equal(chats, 2);
  assert.equal(auth, 2);
  const status = (
    await f.call("GET", "/v1/admin/ai", user.token)
  ).json<AiControlStatus>();
  assert.equal(status.attempts!.reservedToday, 2);
  assert.deepEqual(
    status.attempts!.recent.map((entry) => entry.attemptNumber),
    [2, 1],
  );
  assert.ok(
    status.attempts!.recent.every(
      (entry) => entry.provider === "gigachat" && entry.routingRevision === 1,
    ),
  );
  assert.doesNotMatch(JSON.stringify(status), /test-token|dGVzdA/);
});

test("model attempt reservations reject duplicates, mismatched requests and expired leases atomically", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const user = await chatUser(f);
  const repo = new Repository(f.db);
  const requestId = randomUUID();
  const reservation = await repo.reserveChat(
    user.userId,
    user.thread,
    requestId,
    "Квартира",
    {
      policyId: user.policyId,
      revision: 1,
      userDailyLimit: 20,
      globalDailyLimit: 200,
    },
  );
  const input = {
    userId: user.userId,
    threadId: user.thread,
    requestId,
    lease: reservation.lease,
    attemptNumber: 1,
    provider: "openai" as const,
    model: "test-model",
    policyId: user.policyId,
    routingRevision: 1,
    userDailyLimit: 20,
    globalDailyLimit: 200,
  };
  const results = await Promise.allSettled([
    repo.reserveAiAttempt(input),
    repo.reserveAiAttempt(input),
  ]);
  assert.equal(
    results.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  for (const changed of [
    { attemptNumber: 2, model: "other-model" },
    { attemptNumber: 2, provider: "gigachat" as const },
    { attemptNumber: 2, policyId: "a".repeat(64) },
    { attemptNumber: 2, routingRevision: 2 },
    { attemptNumber: 2, lease: randomUUID() },
    { attemptNumber: 3 },
  ])
    await assert.rejects(repo.reserveAiAttempt({ ...input, ...changed }));
  await f.db.query(
    "update agent_threads set busy_until=now()-interval '1 second' where id=$1",
    [user.thread],
  );
  await assert.rejects(repo.reserveAiAttempt({ ...input, attemptNumber: 2 }));
  assert.equal((await repo.aiAttemptOverview(20, 200)).reservedToday, 1);
  assert.equal(
    (await f.db.query("select * from ai_model_attempts")).rows.length,
    1,
  );
});

test("model attempt UTC rollover and human handoff do not reuse or invent reservations", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const user = await chatUser(f);
  await f.db.query(
    "insert into ai_model_attempt_daily values ((now() at time zone 'UTC')::date-1,200,20,200)",
  );
  await f.db.query(
    "insert into ai_user_model_attempt_daily values ($1,(now() at time zone 'UTC')::date-1,20)",
    [user.userId],
  );
  const path = `/v1/threads/${user.thread}/messages`;
  const handoff = await f.call("POST", path, user.token, {
    text: "Нужен живой риелтор",
    requestId: randomUUID(),
  });
  assert.match(handoff.body, /"type":"done"/);
  assert.equal(
    (await f.db.query("select * from ai_model_attempts")).rows.length,
    0,
  );
  const response = await f.call("POST", path, user.token, {
    text: "Как искать квартиру?",
    requestId: randomUUID(),
  });
  assert.match(response.body, /"type":"done"/);
  const today = await new Repository(f.db).aiAttemptOverview(20, 200);
  assert.equal(today.reservedToday, 1);
  assert.equal(
    (await f.db.query("select * from ai_model_attempt_daily")).rows.length,
    2,
  );
});

test("model attempt guard refuses a third attempt or a retry after visible output", async (t) => {
  for (const visible of [false, true]) {
    let dispatches = 0;
    const provider: StreamingProvider = {
      name: "openai",
      model: "test-model",
      async *stream(_instructions, _messages, _signal, guard) {
        dispatches++;
        if (visible) yield { type: "delta", text: "Начало ответа" };
        await guard!.beforeRetry();
        dispatches++;
        await guard!.beforeRetry();
        dispatches++;
        yield { type: "complete", model: "test-model" };
      },
    };
    const f = await fixture(provider);
    t.after(f.close);
    const user = await chatUser(f);
    const response = await f.call(
      "POST",
      `/v1/threads/${user.thread}/messages`,
      user.token,
      { text: "Квартира", requestId: randomUUID() },
    );
    assert.match(response.body, /"type":"error"/);
    assert.doesNotMatch(response.body, /"type":"done"/);
    assert.equal(dispatches, visible ? 1 : 2);
    assert.equal(
      (await new Repository(f.db).aiAttemptOverview(20, 200)).reservedToday,
      dispatches,
    );
    assert.equal(
      (await f.call("GET", "/v1/dashboard", user.token)).json<Dashboard>().xp,
      0,
    );
  }
});

test("admin switching is authorized, audited, persistent and never grants user consent", async (t) => {
  const providers = {
    openai: new TestProvider(),
    routerai: new TestProvider("routerai"),
    gigachat: new TestProvider("gigachat"),
  };
  const f = await fixture(
    providers.openai,
    { ADMIN_USER_IDS: "1", OPENAI_API_KEY: "never-publish-this-secret" },
    providers,
  );
  t.after(f.close);
  const admin = await chatUser(f);
  const other = await f.register();
  const get = async () =>
    (await f.call("GET", "/v1/admin/ai", admin.token)).json<AiControlStatus>();
  const initial = await get();
  assert.equal(initial.current.provider, "openai");
  assert.equal(initial.current.revision, 1);
  assert.equal(initial.automaticFallback, false);
  assert.doesNotMatch(JSON.stringify(initial), /never-publish-this-secret/);
  const giga = initial.options.find(
    (entry) => entry.provider === "gigachat",
  )!.policy!;
  const input = {
    provider: "gigachat",
    policyId: giga.id,
    expectedRevision: 1,
  };
  for (const method of ["GET", "POST"] as const) {
    assert.equal(
      (
        await f.call(
          method,
          "/v1/admin/ai",
          "",
          method === "POST" ? input : undefined,
        )
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.call(
          method,
          "/v1/admin/ai",
          other.token,
          method === "POST" ? input : undefined,
        )
      ).statusCode,
      403,
    );
  }
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/admin/ai",
        headers: {
          origin: "https://evil.test",
          cookie: "citygo=" + admin.token,
        },
        payload: input,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/admin/ai", admin.token, {
        ...input,
        provider: "other",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/admin/ai", admin.token, {
        ...input,
        policyId: admin.policyId,
      })
    ).statusCode,
    409,
  );
  assert.equal((await get()).audit.length, 1);
  for (const field of ["model", "apiKey", "baseURL"]) {
    assert.equal(
      (
        await f.call("POST", "/v1/admin/ai", admin.token, {
          ...input,
          [field]: "not-accepted",
        })
      ).statusCode,
      400,
    );
  }
  assert.equal(
    (await f.call("POST", "/v1/admin/ai", admin.token, input)).json().revision,
    2,
  );
  assert.equal(
    (await f.call("POST", "/v1/admin/ai", admin.token, input)).statusCode,
    409,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/admin/ai", admin.token, {
        ...input,
        expectedRevision: 2,
      })
    ).json().revision,
    2,
  );
  assert.equal((await get()).audit.length, 2);
  const path = `/v1/threads/${admin.thread}/messages`;
  assert.equal(
    (
      await f.call("POST", path, admin.token, {
        text: "Квартира",
        requestId: randomUUID(),
        policyId: admin.policyId,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.call("POST", path, admin.token, {
        text: "Квартира",
        requestId: randomUUID(),
        policyId: giga.id,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.db.query("select * from chat_requests")).rows.length,
    0,
  );
  await f.consent(admin.token);
  assert.match(
    (
      await f.call("POST", path, admin.token, {
        text: "Квартира",
        requestId: randomUUID(),
      })
    ).body,
    /"type":"done"/,
  );
  await f.activate(admin.token, f.app, "disabled");
  assert.equal(
    (
      await f.call("POST", path, admin.token, {
        text: "Квартира",
        requestId: randomUUID(),
        policyId: giga.id,
      })
    ).statusCode,
    503,
  );
  assert.equal(
    (await f.call("POST", "/v1/ai/consent", admin.token, { action: "revoked" }))
      .statusCode,
    200,
  );
  await f.activate(admin.token, f.app, "openai");
  const board = (
    await f.call("GET", "/v1/dashboard", admin.token)
  ).json<Dashboard>();
  assert.equal(board.aiAccess.granted, false);
  assert.equal(board.thread!.messages.at(-1)!.generation?.provider, "gigachat");
  assert.equal(
    (
      await f.db.query<{ accepted_requests: number }>(
        "select accepted_requests from ai_usage_daily",
      )
    ).rows[0]!.accepted_requests,
    1,
  );
  const restarted = await buildApp({
    db: f.db,
    testing: true,
    provider: providers.routerai,
    providers,
    config: readConfig({ NODE_ENV: "test", ADMIN_USER_IDS: "1" }),
  });
  t.after(() => restarted.close());
  const response = await restarted.inject({
    method: "GET",
    url: "/v1/admin/ai",
    headers: { cookie: "citygo=" + admin.token },
  });
  const after = response.json<AiControlStatus>();
  assert.equal(after.current.provider, "openai");
  assert.equal(after.effectiveProvider, "openai");
  assert.deepEqual(
    after.audit.map((entry) => entry.payload.to.revision),
    [4, 3, 2, 1],
  );
  assert.deepEqual(
    after.audit.map((entry) => entry.actorUserId),
    [admin.userId, admin.userId, admin.userId, null],
  );
  assert.deepEqual(after.audit[2]!.payload.policy, giga);
  assert.equal(after.audit[1]!.payload.policy, null);
});

test("concurrent admins on two API instances cannot overwrite a newer routing revision", async (t) => {
  const providers = {
    openai: new TestProvider(),
    routerai: new TestProvider("routerai"),
    gigachat: new TestProvider("gigachat"),
  };
  const config = readConfig({ NODE_ENV: "test", ADMIN_USER_IDS: "1,2" });
  const f = await fixture(
    providers.openai,
    { ADMIN_USER_IDS: "1,2" },
    providers,
  );
  t.after(f.close);
  const second = await buildApp({
    db: f.db,
    provider: providers.openai,
    providers,
    testing: true,
    config,
  });
  t.after(() => second.close());
  const admins = [await f.register(), await f.register()];
  const initial = (
    await f.call("GET", "/v1/admin/ai", admins[0]!.token)
  ).json<AiControlStatus>();
  const options = initial.options.filter(
    (entry) => entry.provider !== "openai",
  );
  const results = await Promise.all(
    options.map((option, index) =>
      (index ? second : f.app).inject({
        method: "POST",
        url: "/v1/admin/ai",
        headers: {
          origin: "http://localhost:3000",
          cookie: "citygo=" + admins[index]!.token,
        },
        payload: {
          provider: option.provider,
          policyId: option.policy!.id,
          expectedRevision: initial.current.revision,
        },
      }),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.statusCode).sort(),
    [200, 409],
  );
  const winner = results.findIndex((result) => result.statusCode === 200);
  const final = (
    await f.call("GET", "/v1/admin/ai", admins[0]!.token)
  ).json<AiControlStatus>();
  assert.equal(final.current.provider, options[winner]!.provider);
  assert.equal(final.current.revision, 2);
  assert.equal(final.audit.length, 2);
  assert.equal(
    (await f.db.query("select * from ai_usage_daily")).rows.length,
    0,
  );
});

test("admin API cannot bypass server disable or production recipient blocks", async (t) => {
  const providers = {
    openai: new TestProvider(),
    gigachat: new TestProvider("gigachat"),
  };
  const f = await fixture(providers.openai, { ADMIN_USER_IDS: "1" }, providers);
  t.after(f.close);
  const admin = await f.register();
  const initial = (
    await f.call("GET", "/v1/admin/ai", admin.token)
  ).json<AiControlStatus>();
  for (const production of [false, true]) {
    const config = readConfig(
      production
        ? {
            NODE_ENV: "production",
            DATABASE_URL: "postgresql://localhost/citygo",
            WEB_ORIGIN: "https://citygo.example",
            TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
            ADMIN_USER_IDS: "1",
          }
        : { NODE_ENV: "test", LLM_PROVIDER: "disabled", ADMIN_USER_IDS: "1" },
    );
    const guarded = await buildApp({
      db: f.db,
      provider: providers.openai,
      providers,
      config,
      testing: true,
    });
    t.after(() => guarded.close());
    const headers = {
      origin: config.WEB_ORIGIN,
      cookie: (production ? "__Host-citygo=" : "citygo=") + admin.token,
    };
    const status = (
      await guarded.inject({ method: "GET", url: "/v1/admin/ai", headers })
    ).json<AiControlStatus>();
    assert.equal(status.current.provider, "openai");
    assert.equal(
      status.effectiveProvider,
      production ? "openai" : "unconfigured",
    );
    const option = initial.options.find(
      (entry) => entry.provider === (production ? "gigachat" : "openai"),
    )!;
    assert.equal(
      (
        await guarded.inject({
          method: "POST",
          url: "/v1/admin/ai",
          headers,
          payload: {
            provider: option.provider,
            policyId: option.policy!.id,
            expectedRevision: status.current.revision,
          },
        })
      ).statusCode,
      409,
    );
  }
  assert.equal(
    (await f.call("GET", "/v1/admin/ai", admin.token)).json<AiControlStatus>()
      .audit.length,
    1,
  );
});

test("switch during model I/O pins the old answer and requires consent for the next provider", async (t) => {
  let enter!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gigaCalls = 0;
  const openai: StreamingProvider = {
    name: "openai",
    model: "test-held",
    async *stream() {
      yield { type: "delta", text: "Ответ OpenAI: " };
      enter();
      await held;
      yield { type: "delta", text: "завершён" };
      yield { type: "complete", model: "test-held" };
    },
  };
  const gigachat: StreamingProvider = {
    name: "gigachat",
    model: "test-giga",
    async *stream() {
      gigaCalls++;
      yield { type: "delta", text: "Отдельный ответ GigaChat" };
      yield { type: "complete", model: "test-giga" };
    },
  };
  const f = await fixture(
    openai,
    { ADMIN_USER_IDS: "1" },
    { openai, gigachat },
  );
  t.after(() => {
    release();
  });
  t.after(f.close);
  const admin = await chatUser(f);
  const path = `/v1/threads/${admin.thread}/messages`;
  const pending = f.call("POST", path, admin.token, {
    text: "Квартира",
    requestId: randomUUID(),
  });
  await Promise.race([
    started,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Provider not started")),
        5000,
      );
      timer.unref();
    }),
  ]);
  try {
    await Promise.race([
      f.activate(admin.token, f.app, "gigachat"),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Switch blocked by model I/O")),
          5000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(gigaCalls, 0);
  } finally {
    release();
  }
  const original = await pending;
  assert.match(original.body, /Ответ OpenAI/);
  assert.doesNotMatch(original.body, /Отдельный ответ GigaChat/);
  assert.match(original.body, /"type":"done"/);
  assert.equal(
    (
      await f.call("POST", path, admin.token, {
        text: "Квартира",
        requestId: randomUUID(),
      })
    ).statusCode,
    403,
  );
  await f.consent(admin.token);
  assert.match(
    (
      await f.call("POST", path, admin.token, {
        text: "Квартира",
        requestId: randomUUID(),
      })
    ).body,
    /Отдельный ответ GigaChat/,
  );
  const history = (
    await f.call("GET", "/v1/dashboard", admin.token)
  ).json<Dashboard>().thread!.messages;
  assert.deepEqual(
    history
      .filter((message) => message.role === "assistant")
      .map((message) => message.generation?.provider),
    ["openai", "gigachat"],
  );
  assert.deepEqual(
    (
      await f.db.query<{ ai_routing_revision: number }>(
        "select ai_routing_revision from chat_requests order by ai_routing_revision",
      )
    ).rows.map((row) => row.ai_routing_revision),
    [1, 2],
  );
  assert.equal(gigaCalls, 1);
});

test("configuration drift fails closed until admin explicitly accepts the new model", async (t) => {
  const f = await fixture(true, { ADMIN_USER_IDS: "1" });
  t.after(f.close);
  const admin = await chatUser(f);
  const path = `/v1/threads/${admin.thread}/messages`;
  let calls = 0;
  const changed: StreamingProvider = {
    name: "openai",
    model: "test-updated-model",
    async *stream() {
      calls++;
      yield { type: "delta", text: "Новая модель" };
      yield { type: "complete", model: "test-updated-model" };
    },
  };
  const replica = await buildApp({
    db: f.db,
    provider: changed,
    providers: { gigachat: new TestProvider("gigachat") },
    config: readConfig({ NODE_ENV: "test", ADMIN_USER_IDS: "1" }),
    testing: true,
  });
  t.after(() => replica.close());
  const headers = {
    origin: "http://localhost:3000",
    cookie: "citygo=" + admin.token,
  };
  const current = (
    await replica.inject({ method: "GET", url: "/v1/dashboard", headers })
  ).json<Dashboard>();
  assert.equal(current.provider, "unconfigured");
  assert.equal(current.aiAccess.policy, null);
  const payload = {
    text: "Квартира",
    requestId: randomUUID(),
    policyId: admin.policyId,
  };
  assert.equal(
    (await replica.inject({ method: "POST", url: path, headers, payload }))
      .statusCode,
    503,
  );
  assert.equal(calls, 0);
  await f.activate(admin.token, replica, "openai");
  assert.equal(
    (await f.call("POST", path, admin.token, payload)).statusCode,
    503,
  );
  const policyId = await f.consent(admin.token, replica);
  assert.match(
    (
      await replica.inject({
        method: "POST",
        url: path,
        headers,
        payload: { ...payload, policyId },
      })
    ).body,
    /"type":"done"/,
  );
  assert.equal(calls, 1);
});

test("routing changes between lookup and admission reject stale grants and messages atomically", async (t) => {
  const providers = {
    openai: new TestProvider(),
    gigachat: new TestProvider("gigachat"),
  };
  const f = await fixture(providers.openai, { ADMIN_USER_IDS: "1" }, providers);
  t.after(f.close);
  const admin = await chatUser(f);
  let intercept = false;
  const raced = await buildApp({
    db: {
      ...f.db,
      query: async <T>(sql: string, params?: unknown[]) => {
        const result = await f.db.query<T>(sql, params);
        if (intercept && sql.endsWith("from ai_routing where id=1")) {
          intercept = false;
          await f.activate(admin.token, f.app, "gigachat");
        }
        return result;
      },
    },
    provider: providers.openai,
    providers,
    testing: true,
    config: readConfig({ NODE_ENV: "test", ADMIN_USER_IDS: "1" }),
  });
  t.after(() => raced.close());
  const headers = {
    origin: "http://localhost:3000",
    cookie: "citygo=" + admin.token,
  };
  intercept = true;
  assert.equal(
    (
      await raced.inject({
        method: "POST",
        url: "/v1/ai/consent",
        headers,
        payload: { action: "granted", policyId: admin.policyId },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.db.query(
        "select * from consent_events where consent_key='ai-recipient'",
      )
    ).rows.length,
    1,
  );
  await f.activate(admin.token, f.app, "openai");
  intercept = true;
  assert.equal(
    (
      await raced.inject({
        method: "POST",
        url: `/v1/threads/${admin.thread}/messages`,
        headers,
        payload: {
          text: "Квартира",
          requestId: randomUUID(),
          policyId: admin.policyId,
        },
      })
    ).statusCode,
    409,
  );
  assert.equal((await f.db.query("select * from messages")).rows.length, 0);
  assert.equal(
    (await f.db.query("select * from ai_usage_daily")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select * from chat_requests")).rows.length,
    0,
  );
});

test("AI admission requires explicit current-recipient consent; revoke preserves history and isolates users", async (t) => {
  let calls = 0;
  const f = await fixture({
    name: "openai",
    model: "test-model",
    async *stream() {
      calls++;
      yield { type: "delta", text: "Ответ" };
      yield { type: "complete", model: "test-model" };
    },
  });
  t.after(f.close);
  const user = await chatUser(f, false);
  const path = `/v1/threads/${user.thread}/messages`;
  const body = {
    text: "Квартира",
    requestId: randomUUID(),
    policyId: user.policyId,
  };
  const grant = { action: "granted", policyId: user.policyId };
  assert.equal(
    (await f.call("POST", "/v1/ai/consent", "", grant)).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/ai/consent",
        headers: {
          origin: "https://evil.test",
          cookie: "citygo=" + user.token,
        },
        payload: grant,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/ai/consent", user.token, {
        ...grant,
        policyId: "a".repeat(64),
      })
    ).statusCode,
    409,
  );
  assert.equal((await f.call("POST", path, user.token, body)).statusCode, 403);
  assert.equal(
    (await f.call("POST", path, user.token, { ...body, policyId: undefined }))
      .statusCode,
    409,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await f.db.query("select * from chat_requests")).rows.length,
    0,
  );
  assert.equal((await f.db.query("select * from messages")).rows.length, 0);
  assert.equal(
    (await f.db.query("select * from ai_usage_daily")).rows.length,
    0,
  );
  await f.consent(user.token);
  assert.match(
    (await f.call("POST", path, user.token, body)).body,
    /"type":"done"/,
  );
  assert.equal((await f.call("POST", path, user.token, body)).statusCode, 409);
  const other = await chatUser(f, false);
  assert.equal(
    (
      await f.call(
        "POST",
        `/v1/threads/${other.thread}/messages`,
        other.token,
        { ...body, requestId: randomUUID() },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.call("POST", path, other.token, {
        ...body,
        requestId: randomUUID(),
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await f.call("POST", "/v1/ai/consent", user.token, { action: "revoked" }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await f.call("POST", path, user.token, {
        ...body,
        requestId: randomUUID(),
      })
    ).statusCode,
    403,
  );
  const board = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  assert.equal(board.aiAccess.granted, false);
  assert.equal(board.thread!.messages.length, 2);
  assert.equal(calls, 1);
  const events = (
    await f.db.query<{ action: string; details: { id?: string } }>(
      "select action,details from consent_events where user_id=$1 and consent_key='ai-recipient' order by id",
      [user.userId],
    )
  ).rows;
  assert.deepEqual(
    events.map((event) => event.action),
    ["granted", "revoked"],
  );
  assert.equal(events[0]!.details.id, user.policyId);
  assert.equal(
    (
      await f.db.query<{ ai_policy_id: string }>(
        "select ai_policy_id from chat_requests",
      )
    ).rows[0]!.ai_policy_id,
    user.policyId,
  );
  assert.equal(
    (
      await f.db.query<{ accepted_requests: number }>(
        "select accepted_requests from ai_usage_daily",
      )
    ).rows[0]!.accepted_requests,
    1,
  );
});

test("daily global admission is atomic across simultaneous users and API instances", async (t) => {
  const config = readConfig({
    NODE_ENV: "test",
    LLM_GLOBAL_DAILY_REQUEST_LIMIT: "1",
  });
  const f = await fixture(true, { LLM_GLOBAL_DAILY_REQUEST_LIMIT: "1" });
  t.after(f.close);
  const second = await buildApp({
    db: f.db,
    provider: new TestProvider(),
    config,
    testing: true,
  });
  t.after(() => second.close());
  const users = [await chatUser(f), await chatUser(f)];
  const results = await Promise.all(
    users.map((user, i) =>
      (i ? second : f.app).inject({
        method: "POST",
        url: `/v1/threads/${user.thread}/messages`,
        headers: {
          origin: "http://localhost:3000",
          cookie: "citygo=" + user.token,
        },
        payload: {
          text: "Квартира",
          requestId: randomUUID(),
          policyId: user.policyId,
        },
      }),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.statusCode).sort(),
    [200, 429],
  );
  assert.equal(
    (await f.db.query("select * from chat_requests")).rows.length,
    1,
  );
  assert.equal((await f.db.query("select * from messages")).rows.length, 2);
  assert.equal(
    (
      await f.db.query<{ accepted_requests: number }>(
        "select accepted_requests from ai_usage_daily",
      )
    ).rows[0]!.accepted_requests,
    1,
  );
});

test("failed requests consume personal quota across restarts and provider changes; zero disables new admissions", async (t) => {
  let calls = 0;
  const provider: StreamingProvider = {
    name: "openai",
    model: "test-error",
    async *stream() {
      calls++;
      yield { type: "delta", text: "Часть" };
      throw new Error("test failure");
    },
  };
  const switched: StreamingProvider = { ...provider, name: "gigachat" };
  const f = await fixture(
    provider,
    { LLM_USER_DAILY_REQUEST_LIMIT: "1" },
    { gigachat: switched },
  );
  t.after(f.close);
  const user = await chatUser(f);
  const path = `/v1/threads/${user.thread}/messages`;
  assert.match(
    (
      await f.call("POST", path, user.token, {
        text: "Квартира",
        requestId: randomUUID(),
      })
    ).body,
    /"type":"error"/,
  );
  const restarted = await buildApp({
    db: f.db,
    provider: switched,
    config: readConfig({
      NODE_ENV: "test",
      LLM_USER_DAILY_REQUEST_LIMIT: "1",
      ADMIN_USER_IDS: "1",
    }),
    testing: true,
  });
  t.after(() => restarted.close());
  await f.activate(user.token, restarted);
  const switchedPolicyId = await f.consent(user.token, restarted);
  const headers = {
    origin: "http://localhost:3000",
    cookie: "citygo=" + user.token,
  };
  assert.equal(
    (
      await restarted.inject({
        method: "POST",
        url: path,
        headers,
        payload: {
          text: "Квартира",
          requestId: randomUUID(),
          policyId: switchedPolicyId,
        },
      })
    ).statusCode,
    429,
  );
  const other = await chatUser(f);
  assert.equal(
    (
      await f.call(
        "POST",
        `/v1/threads/${other.thread}/messages`,
        other.token,
        { text: "Квартира", requestId: randomUUID() },
      )
    ).statusCode,
    200,
  );
  const disabled = await buildApp({
    db: f.db,
    provider: switched,
    config: readConfig({
      NODE_ENV: "test",
      LLM_GLOBAL_DAILY_REQUEST_LIMIT: "0",
    }),
    testing: true,
  });
  t.after(() => disabled.close());
  assert.equal(
    (
      await disabled.inject({
        method: "POST",
        url: path,
        headers,
        payload: {
          text: "Квартира",
          requestId: randomUUID(),
          policyId: switchedPolicyId,
        },
      })
    ).statusCode,
    503,
  );
  assert.equal(calls, 2);
  assert.equal(
    (await f.db.query("select * from chat_requests")).rows.length,
    2,
  );
});

test("revocation does not wait on model I/O and blocks admissions after the in-flight request", async (t) => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    name: "openai",
    model: "test-held",
    async *stream() {
      entered();
      await hold;
      yield { type: "delta", text: "Уже принятый ответ" };
      yield { type: "complete", model: "test-held" };
    },
  });
  t.after(() => {
    release();
  });
  t.after(f.close);
  const user = await chatUser(f);
  const path = `/v1/threads/${user.thread}/messages`;
  const pending = f.call("POST", path, user.token, {
    text: "Квартира",
    requestId: randomUUID(),
  });
  // Bound the assertion so an accidental network-inside-transaction regression fails.
  await Promise.race([
    started,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Provider not started")),
        5000,
      );
      timer.unref();
    }),
  ]);
  try {
    const revoke = await Promise.race([
      f.call("POST", "/v1/ai/consent", user.token, { action: "revoked" }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Revocation blocked on network")),
          5000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(revoke.statusCode, 200);
  } finally {
    release();
  }
  assert.match((await pending).body, /"type":"done"/);
  assert.equal(
    (
      await f.call("POST", path, user.token, {
        text: "Квартира",
        requestId: randomUUID(),
      })
    ).statusCode,
    403,
  );
});

test("readiness requires the AI attempt migration", async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  assert.equal((await f.call("GET", "/ready")).statusCode, 200);
  await f.db.query(
    "delete from citygo_migrations where name='0005_ai_attempts.sql'",
  );
  assert.equal((await f.call("GET", "/ready")).statusCode, 503);
});

test("trusted proxy clients have independent global, auth and chat rate limits", async (t) => {
  const f = await fixture(false, {
    TRUSTED_PROXY_CIDRS: "10.0.0.8/32,::1/128",
  });
  t.after(f.close);
  const request = (path: string, client: string, remoteAddress = "10.0.0.8") =>
    f.app.inject({
      method: path === "/health" ? "GET" : "POST",
      url: path,
      remoteAddress,
      headers: { origin: "http://localhost:3000", "x-forwarded-for": client },
      ...(path === "/health" ? {} : { payload: {} }),
    });
  for (let i = 0; i < 120; i++)
    assert.equal((await request("/health", "198.51.100.1")).statusCode, 200);
  assert.equal((await request("/health", "198.51.100.1")).statusCode, 429);
  assert.equal((await request("/health", "198.51.100.2")).statusCode, 200);
  // The closest untrusted address wins, not a forged entry on the left.
  assert.equal(
    (await request("/health", "203.0.113.99, 198.51.100.1")).statusCode,
    429,
  );
  // IPv4-mapped socket addresses and IPv6 proxy/client paths are supported.
  assert.equal(
    (await request("/health", "198.51.100.1", "::ffff:10.0.0.8")).statusCode,
    429,
  );
  assert.equal(
    (await request("/health", "2001:db8::2", "::1")).statusCode,
    200,
  );
  for (const action of ["login", "register"]) {
    const path = "/v1/auth/" + action;
    for (let i = 0; i < 10; i++)
      assert.equal((await request(path, "198.51.100.3")).statusCode, 400);
    assert.equal((await request(path, "198.51.100.3")).statusCode, 429);
    assert.equal((await request(path, "198.51.100.4")).statusCode, 400);
  }
  const chat = "/v1/threads/1/messages";
  for (let i = 0; i < 20; i++)
    assert.equal((await request(chat, "198.51.100.5")).statusCode, 401);
  assert.equal((await request(chat, "198.51.100.5")).statusCode, 429);
  assert.equal((await request(chat, "198.51.100.6")).statusCode, 401);
});

test("untrusted direct clients cannot evade rate limits with forwarded headers", async (t) => {
  const f = await fixture(false, { TRUSTED_PROXY_CIDRS: "10.0.0.8/32" });
  t.after(f.close);
  for (let i = 0; i < 11; i++) {
    const reply = await f.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.9",
      headers: {
        origin: "http://localhost:3000",
        "x-forwarded-for": "203.0.113." + i,
      },
      payload: {},
    });
    assert.equal(reply.statusCode, i < 10 ? 400 : 429);
  }
});

test("production sessions use secure host-only cookies for signup, login and logout", async (t) => {
  const f = await fixture(false, {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://localhost/citygo",
    WEB_ORIGIN: "https://citygo.example",
    TRUSTED_PROXY_CIDRS: "10.0.0.8/32",
  });
  t.after(f.close);
  const credentials = {
    email: randomUUID() + "@example.test",
    password: "CityGo-test-password",
  };
  for (const action of ["register", "login"]) {
    const reply = await f.app.inject({
      method: "POST",
      url: "/v1/auth/" + action,
      headers: { origin: "https://citygo.example" },
      payload: credentials,
    });
    assert.equal(reply.statusCode, 200, reply.body);
    const cookie = String(reply.headers["set-cookie"]);
    assert.match(cookie, /^__Host-citygo=/);
    assert.match(cookie, /; Secure(?:;|$)/);
    assert.match(cookie, /; HttpOnly(?:;|$)/);
    assert.match(cookie, /; SameSite=Lax(?:;|$)/i);
    assert.match(cookie, /; Path=\/(?:;|$)/);
    assert.doesNotMatch(cookie, /; Domain=/i);
    const logout = await f.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: {
        origin: "https://citygo.example",
        cookie: "__Host-citygo=" + reply.cookies[0]!.value,
      },
    });
    assert.equal(logout.statusCode, 200);
    assert.match(
      String(logout.headers["set-cookie"]),
      /^__Host-citygo=.*; Secure/,
    );
  }
});

async function verticalSlice(
  t: TestContext,
  providerId: AiProviderId,
  provider: StreamingProvider = new TestProvider(providerId),
) {
  const f = await fixture(provider);
  t.after(f.close);
  const user = await f.register();
  const other = await f.register();
  await f.consent(user.token);
  assert.equal((await f.call("GET", "/v1/dashboard")).statusCode, 401);
  assert.equal(
    (
      await f.call("POST", "/v1/questionnaire", user.token, {
        ...testProfile,
        aiConsent: false,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await f.call("POST", "/v1/questionnaire", user.token, testProfile))
      .statusCode,
    200,
  );
  assert.equal(
    (await f.call("POST", "/v1/questionnaire", user.token, testProfile))
      .statusCode,
    409,
  );
  const dashboard = async () =>
    (await f.call("GET", "/v1/dashboard", user.token)).json<Dashboard>();
  let board = await dashboard();
  assert.equal(board.provider, providerId);
  assert.equal(board.profile?.targetCity, "Москва");
  assert.equal(board.xp, 0);
  const first = board.quests[0]!;
  const next = board.quests[1]!;
  assert.equal(next.state, "locked");
  assert.equal(
    (await f.call("POST", "/v1/quests/" + next.id + "/start", user.token, {}))
      .statusCode,
    409,
  );
  assert.equal(
    (await f.call("POST", "/v1/quests/" + first.id + "/start", other.token, {}))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.call("POST", "/v1/quests/" + first.id + "/start", user.token, {}))
      .statusCode,
    200,
  );
  board = await dashboard();
  const thread = board.thread!.id;
  assert.equal(
    (
      await f.call("POST", "/v1/quests/" + first.id + "/complete", user.token, {
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  const human = await f.call(
    "POST",
    "/v1/threads/" + thread + "/messages",
    user.token,
    { text: "Нужен живой риелтор", requestId: randomUUID() },
  );
  assert.match(human.body, /"type":"done"/);
  assert.equal((await dashboard()).thread!.messages.at(-1)!.status, "complete");
  assert.equal((await dashboard()).thread!.messages.at(-1)!.generation, null);
  assert.equal(
    (
      await f.call("POST", "/v1/quests/" + first.id + "/complete", user.token, {
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  const body = { text: "Помоги выбрать квартиру", requestId: randomUUID() };
  assert.equal(
    (
      await f.call(
        "POST",
        "/v1/threads/" + thread + "/messages",
        other.token,
        body,
      )
    ).statusCode,
    404,
  );
  const stream = await f.call(
    "POST",
    "/v1/threads/" + thread + "/messages",
    user.token,
    body,
  );
  assert.equal(stream.statusCode, 200, stream.body);
  assert.match(stream.body, /"type":"delta"/);
  assert.match(stream.body, /"type":"done"/);
  assert.equal(
    (
      await f.call(
        "POST",
        "/v1/threads/" + thread + "/messages",
        user.token,
        body,
      )
    ).statusCode,
    409,
  );
  board = await dashboard();
  assert.equal(board.thread!.messages.length, 4);
  assert.deepEqual(board.thread!.messages.at(-1)!.generation, {
    provider: providerId,
    requestedModel: provider.model,
    model: "test-model-v1",
    usage: { inputTokens: 32, outputTokens: 16 },
  });
  assert.equal(board.thread!.messages.at(-2)!.generation, null);
  const completions = await Promise.all(
    [1, 2].map(() =>
      f.call("POST", "/v1/quests/" + first.id + "/complete", user.token, {
        confirmed: true,
      }),
    ),
  );
  assert.deepEqual(
    completions.map((r) => r.json().awarded).sort((a, b) => a - b),
    [0, 60],
  );
  board = await dashboard();
  assert.equal(board.xp, 60);
  assert.equal(board.quests[1]!.state, "available");
  const handoff = await f.call(
    "POST",
    "/v1/threads/" + thread + "/messages",
    user.token,
    { text: "Помоги написать резюме", requestId: randomUUID() },
  );
  assert.match(handoff.body, /"type":"handoff"/);
  assert.equal((await dashboard()).thread!.agentKey, "resume-builder");
  await f.call("POST", "/v1/quests/" + next.id + "/start", user.token, {});
  assert.equal((await dashboard()).thread!.agentKey, "housing");
  assert.equal(
    (
      await f.call("POST", "/v1/quests/" + next.id + "/complete", user.token, {
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.call("GET", "/v1/admin/overview", user.token)).statusCode,
    403,
  );
  assert.equal(
    (await f.call("GET", "/v1/dashboard", other.token)).json<Dashboard>()
      .thread,
    null,
  );
  assert.equal(
    (await f.call("POST", "/v1/auth/logout", user.token, {})).statusCode,
    200,
  );
  assert.equal(
    (await f.call("GET", "/v1/dashboard", user.token)).statusCode,
    401,
  );
  const login = await f.call("POST", "/v1/auth/login", "", {
    email: user.email,
    password: "CityGo-test-password",
  });
  assert.equal(login.statusCode, 200);
  assert.equal(
    (
      await f.call("GET", "/v1/dashboard", login.cookies[0]!.value)
    ).json<Dashboard>().xp,
    60,
  );
  const ledger = await f.db.query<{ n: number }>(
    "select count(*)::integer n from xp_events",
  );
  assert.equal(ledger.rows[0]!.n, 1);
}

for (const providerId of aiProviderIds)
  test(`vertical slice, ownership, streaming, handoff and exactly-once XP (${providerId} test double)`, (t) =>
    verticalSlice(t, providerId));

function routerResponse(complete: boolean) {
  const chunks = [
    {
      model: "test-model-v1",
      choices: [
        {
          index: 0,
          delta: { content: "Сравните районы и бюджет аренды." },
          finish_reason: null,
        },
      ],
    },
    ...(complete
      ? [
          {
            model: "test-model-v1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
          {
            model: "test-model-v1",
            choices: [],
            usage: { prompt_tokens: 32, completion_tokens: 16 },
          },
        ]
      : []),
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      (complete ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("GigaChat adapter mocked HTTP: full vertical slice, cached OAuth, history and exactly-once XP", async (t) => {
  let auth = 0,
    chat = 0;
  const provider = new GigaChatProvider(
    Buffer.from("test-client:test-key").toString("base64"),
    "GigaChat-test",
    {
      scope: "GIGACHAT_API_PERS",
      post: async (url, init) => {
        if (url === "https://ngw.devices.sberbank.ru:9443/api/v2/oauth") {
          auth++;
          return Response.json({
            access_token: "test-access-token",
            expires_at: Date.now() + 1800000,
          });
        }
        chat++;
        assert.equal(url, "https://api.giga.chat/v1/chat/completions");
        const request = JSON.parse(init.body);
        assert.equal(request.messages[0].role, "system");
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /@example.test|CityGo-test-password/,
        );
        if (chat === 2)
          assert.ok(
            request.messages.some(
              (message: { role: string; content: string }) =>
                message.role === "assistant" &&
                message.content.includes("бюджет аренды"),
            ),
          );
        return routerResponse(true);
      },
    },
  );
  await verticalSlice(t, "gigachat", provider);
  assert.equal(auth, 1);
  assert.equal(chat, 2);
});

test("GigaChat adapter mocked HTTP: interruption blocks XP without token refresh or hidden retry", async (t) => {
  let auth = 0,
    chat = 0;
  const f = await fixture(
    new GigaChatProvider(
      Buffer.from("test-client:test-key").toString("base64"),
      "GigaChat-test",
      {
        scope: "GIGACHAT_API_PERS",
        post: async (url) => {
          if (url === "https://ngw.devices.sberbank.ru:9443/api/v2/oauth") {
            auth++;
            return Response.json({
              access_token: "test-access-token",
              expires_at: Date.now() + 1800000,
            });
          }
          return routerResponse(++chat > 1);
        },
      },
    ),
  );
  t.after(f.close);
  const { token } = await f.register();
  await f.consent(token);
  await f.call("POST", "/v1/questionnaire", token, testProfile);
  const dashboard = async () =>
    (await f.call("GET", "/v1/dashboard", token)).json<Dashboard>();
  const quest = (await dashboard()).quests[0]!.id;
  const thread = (
    await f.call("POST", `/v1/quests/${quest}/start`, token, {})
  ).json().id;
  const send = () =>
    f.call("POST", `/v1/threads/${thread}/messages`, token, {
      text: "Помоги выбрать квартиру",
      requestId: randomUUID(),
    });
  const response = await send();
  assert.match(response.body, /"type":"error"/);
  assert.doesNotMatch(response.body, /"type":"done"|test-access-token/);
  const board = await dashboard();
  assert.equal(board.thread!.messages.at(-1)!.status, "interrupted");
  assert.deepEqual(board.thread!.messages.at(-1)!.generation, {
    provider: "gigachat",
    requestedModel: "GigaChat-test",
  });
  assert.equal(
    (
      await f.call("POST", `/v1/quests/${quest}/complete`, token, {
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(chat, 1);
  assert.equal((await dashboard()).xp, 0);
  assert.match((await send()).body, /"type":"done"/);
  assert.equal(chat, 2);
  assert.equal(auth, 1);
});

test("RouterAI adapter mocked HTTP: full vertical slice with history, handoff and exactly-once XP", async (t) => {
  let calls = 0;
  const provider = new RouterAIProvider("test-key", "test/model", {
    upstream: "test-upstream",
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://routerai.ru/api/v1/chat/completions");
      const request = JSON.parse(String(init?.body));
      assert.equal(request.messages[0].role, "system");
      assert.match(request.messages[0].content, /CityGo/);
      assert.doesNotMatch(
        JSON.stringify(request.messages),
        /@example.test|CityGo-test-password/,
      );
      if (calls === 2)
        assert.ok(
          request.messages.some(
            (message: { role: string; content: string }) =>
              message.role === "assistant" &&
              message.content.includes("бюджет аренды"),
          ),
        );
      return routerResponse(true);
    },
  });
  await verticalSlice(t, "routerai", provider);
  // Human escalation, unauthorized access and duplicate request IDs do not call AI.
  assert.equal(calls, 2);
});

test("RouterAI adapter mocked HTTP: interrupted stream persists, blocks XP and permits a new attempt", async (t) => {
  let calls = 0;
  const f = await fixture(
    new RouterAIProvider("test-key", "test/model", {
      upstream: "test-upstream",
      fetch: async () => routerResponse(++calls > 1),
    }),
  );
  t.after(f.close);
  const { token } = await f.register();
  await f.consent(token);
  await f.call("POST", "/v1/questionnaire", token, testProfile);
  const dashboard = async () =>
    (await f.call("GET", "/v1/dashboard", token)).json<Dashboard>();
  const quest = (await dashboard()).quests[0]!.id;
  const thread = (
    await f.call("POST", `/v1/quests/${quest}/start`, token, {})
  ).json().id;
  const send = () =>
    f.call("POST", `/v1/threads/${thread}/messages`, token, {
      text: "Помоги выбрать квартиру",
      requestId: randomUUID(),
    });
  const interrupted = await send();
  assert.match(interrupted.body, /"type":"delta"/);
  assert.match(interrupted.body, /"type":"error"/);
  assert.doesNotMatch(interrupted.body, /"type":"done"|test-key/);
  const saved = await dashboard();
  assert.equal(saved.thread!.messages.at(-1)!.status, "interrupted");
  assert.deepEqual(saved.thread!.messages.at(-1)!.generation, {
    provider: "routerai",
    requestedModel: "test/model",
  });
  assert.equal(
    (
      await f.call("POST", `/v1/quests/${quest}/complete`, token, {
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.equal((await dashboard()).xp, 0);
  assert.equal(calls, 1);
  assert.match((await send()).body, /"type":"done"/);
  assert.equal(calls, 2);
  assert.equal((await dashboard()).thread!.messages.at(-1)!.status, "complete");
});

test("bad credentials, origin guard, validation and unavailable AI", async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  const user = await f.register();
  const bad = await f.call("POST", "/v1/auth/login", "", {
    email: user.email,
    password: "wrong-password-value",
  });
  assert.equal(bad.statusCode, 401);
  const csrf = await f.app.inject({
    method: "POST",
    url: "/v1/questionnaire",
    headers: { origin: "https://evil.example", cookie: "citygo=" + user.token },
    payload: testProfile,
  });
  assert.equal(csrf.statusCode, 403);
  assert.equal(
    (
      await f.call("POST", "/v1/questionnaire", user.token, {
        ...testProfile,
        monthlyBudget: -1,
      })
    ).statusCode,
    400,
  );
  await f.call("POST", "/v1/questionnaire", user.token, testProfile);
  const board = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  assert.equal(board.provider, "unconfigured");
  const start = await f.call(
    "POST",
    "/v1/quests/" + board.quests[0]!.id + "/start",
    user.token,
    {},
  );
  const stream = await f.call(
    "POST",
    "/v1/threads/" + start.json().id + "/messages",
    user.token,
    { text: "Привет", requestId: randomUUID() },
  );
  assert.equal(stream.statusCode, 503);
  assert.equal(
    (
      await f.db.query<{ n: number }>(
        "select count(*)::integer n from messages",
      )
    ).rows[0]!.n,
    0,
  );
});

test("interrupted replies are persisted but do not qualify for XP", async (t) => {
  const f = await fixture(true, { ADMIN_USER_IDS: "1" });
  t.after(f.close);
  const user = await f.register();
  await f.call("POST", "/v1/questionnaire", user.token, testProfile);
  const board = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  const id = board.quests[0]!.id;
  const thread = (
    await f.call("POST", "/v1/quests/" + id + "/start", user.token, {})
  ).json().id;
  const broken = await buildApp({
    db: f.db,
    testing: true,
    config: readConfig({ NODE_ENV: "test", ADMIN_USER_IDS: "1" }),
    provider: {
      name: "openai",
      model: "test-interrupted",
      async *stream() {
        yield { type: "delta", text: "Частичный ответ" };
        throw new Error("test disconnect");
      },
    },
  });
  t.after(() => broken.close());
  await f.activate(user.token, broken);
  const brokenPolicyId = await f.consent(user.token, broken);
  const response = await broken.inject({
    method: "POST",
    url: "/v1/threads/" + thread + "/messages",
    headers: {
      origin: "http://localhost:3000",
      cookie: "citygo=" + user.token,
    },
    payload: {
      text: "Квартира",
      requestId: randomUUID(),
      policyId: brokenPolicyId,
    },
  });
  assert.match(response.body, /"type":"error"/);
  const saved = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  assert.equal(saved.thread!.messages.at(-1)!.status, "interrupted");
  assert.deepEqual(saved.thread!.messages.at(-1)!.generation, {
    provider: "openai",
    requestedModel: "test-interrupted",
  });
  assert.equal(
    (
      await f.call("POST", "/v1/quests/" + id + "/complete", user.token, {
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  await f.activate(user.token);
  await f.consent(user.token);
  const recovered = await f.call(
    "POST",
    "/v1/threads/" + thread + "/messages",
    user.token,
    { text: "Квартира", requestId: randomUUID() },
  );
  assert.match(recovered.body, /"type":"done"/);
});

for (const failure of [
  "missing-terminal",
  "after-terminal",
  "empty-response",
] as const) {
  test(`provider protocol failure ${failure} cannot complete a quest`, async (t) => {
    const f = await fixture({
      name: "routerai",
      model: "test-protocol-model",
      async *stream() {
        if (failure !== "empty-response")
          yield { type: "delta", text: "Неполный ответ" };
        if (failure !== "missing-terminal")
          yield { type: "complete", model: "test-protocol-model" };
        if (failure === "after-terminal")
          yield { type: "delta", text: "Лишний текст" };
      },
    });
    t.after(f.close);
    const user = await f.register();
    await f.consent(user.token);
    await f.call("POST", "/v1/questionnaire", user.token, testProfile);
    const board = (
      await f.call("GET", "/v1/dashboard", user.token)
    ).json<Dashboard>();
    const quest = board.quests[0]!.id;
    const thread = (
      await f.call("POST", `/v1/quests/${quest}/start`, user.token, {})
    ).json().id;
    const response = await f.call(
      "POST",
      `/v1/threads/${thread}/messages`,
      user.token,
      {
        text: "Помоги выбрать квартиру",
        requestId: randomUUID(),
      },
    );
    assert.match(response.body, /"type":"error"/);
    assert.doesNotMatch(response.body, /"type":"done"/);
    const saved = (
      await f.call("GET", "/v1/dashboard", user.token)
    ).json<Dashboard>();
    assert.equal(saved.thread!.messages.at(-1)!.status, "interrupted");
    assert.equal(
      (
        await f.call("POST", `/v1/quests/${quest}/complete`, user.token, {
          confirmed: true,
        })
      ).statusCode,
      409,
    );
    assert.equal(saved.xp, 0);
  });
}

test("changing injected providers between API instances preserves history and records each answer's source", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const user = await f.register();
  await f.consent(user.token);
  await f.call("POST", "/v1/questionnaire", user.token, testProfile);
  const initial = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  const thread = (
    await f.call(
      "POST",
      `/v1/quests/${initial.quests[0]!.id}/start`,
      user.token,
      {},
    )
  ).json().id;
  await f.call("POST", `/v1/threads/${thread}/messages`, user.token, {
    text: "Первый вопрос о квартире",
    requestId: randomUUID(),
  });
  const before = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  let receivedHistory: unknown;
  const replacement = await buildApp({
    db: f.db,
    testing: true,
    config: readConfig({ NODE_ENV: "test", ADMIN_USER_IDS: "1" }),
    provider: {
      name: "gigachat",
      model: "test-gigachat",
      async *stream(_instructions, messages) {
        receivedHistory = messages;
        yield { type: "delta", text: "Новый ответ" };
        yield { type: "complete", model: "test-gigachat-v1" };
      },
    },
  });
  t.after(() => replacement.close());
  await f.activate(user.token, replacement);
  const headers = {
    origin: "http://localhost:3000",
    cookie: "citygo=" + user.token,
  };
  const changed = (
    await replacement.inject({ method: "GET", url: "/v1/dashboard", headers })
  ).json<Dashboard>();
  assert.equal(changed.aiAccess.granted, false);
  assert.deepEqual(changed.thread!.messages, before.thread!.messages);
  const rejected = await replacement.inject({
    method: "POST",
    url: `/v1/threads/${thread}/messages`,
    headers,
    payload: {
      text: "Нельзя передавать без нового согласия",
      requestId: randomUUID(),
      policyId: changed.aiAccess.policy!.id,
    },
  });
  assert.equal(rejected.statusCode, 403);
  assert.deepEqual({ receivedHistory }, { receivedHistory: undefined });
  const replacementPolicyId = await f.consent(user.token, replacement);
  const response = await replacement.inject({
    method: "POST",
    url: `/v1/threads/${thread}/messages`,
    headers,
    payload: {
      text: "Второй вопрос о квартире",
      requestId: randomUUID(),
      policyId: replacementPolicyId,
    },
  });
  assert.match(response.body, /"type":"done"/);
  assert.ok(Array.isArray(receivedHistory));
  assert.deepEqual(
    receivedHistory.slice(1, 3),
    before.thread!.messages.map(({ role, content }) => ({ role, content })),
  );
  const after = (
    await replacement.inject({ method: "GET", url: "/v1/dashboard", headers })
  ).json<Dashboard>();
  assert.equal(after.provider, "gigachat");
  assert.deepEqual(after.thread!.messages.slice(0, 2), before.thread!.messages);
  assert.equal(after.thread!.messages.at(-1)!.generation?.provider, "gigachat");
  assert.equal(
    after.thread!.messages.at(-1)!.generation?.model,
    "test-gigachat-v1",
  );
  assert.equal(after.xp, 0);
});
