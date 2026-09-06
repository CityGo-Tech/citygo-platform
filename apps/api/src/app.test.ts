import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate } from "@citygo/db";
import { testProfile, TestProvider } from "@citygo/testkit";
import {
  aiProviderIds,
  type AiProviderId,
  type Dashboard,
} from "@citygo/contracts";
import {
  RouterAIProvider,
  GigaChatProvider,
  type StreamingProvider,
} from "@citygo/llm";
import { buildApp } from "./app.js";
import { readConfig } from "@citygo/config";

async function fixture(
  provider: boolean | StreamingProvider = true,
  env: NodeJS.ProcessEnv = {},
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
  return { app, db, call, consent, register, close };
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

test("failed requests consume personal quota across restarts; zero disables new admissions", async (t) => {
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
  const f = await fixture(provider, { LLM_USER_DAILY_REQUEST_LIMIT: "1" });
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
    provider,
    config: readConfig({ NODE_ENV: "test", LLM_USER_DAILY_REQUEST_LIMIT: "1" }),
    testing: true,
  });
  t.after(() => restarted.close());
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
          policyId: user.policyId,
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
    provider,
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
          policyId: user.policyId,
        },
      })
    ).statusCode,
    429,
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

test("readiness requires the AI access migration", async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  assert.equal((await f.call("GET", "/ready")).statusCode, 200);
  await f.db.query(
    "delete from citygo_migrations where name='0003_ai_access.sql'",
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
  const f = await fixture();
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
    config: readConfig({ NODE_ENV: "test" }),
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
