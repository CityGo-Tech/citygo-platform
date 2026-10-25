import {
  acceptSyntheticServiceConsents,
  chooseSyntheticServiceConsents,
  syntheticConsentsFor,
  syntheticServiceConsents,
} from "./test-service-consents.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  AccountAccess,
  connectDatabase,
  migrate,
  type AccountInfo,
} from "@citygo/db";
import {
  CONTRACT_VERSION_HEADER,
  authResponseSchema,
  dashboardResponseSchema,
  adminUsersResponseSchema,
  accountUserResponseSchema,
  type Dashboard,
} from "@citygo/contracts";
import { readConfig } from "@citygo/config";
import type {
  ModelMessage,
  ModelStreamEvent,
  StreamingProvider,
} from "@citygo/llm";
import { buildApp } from "./app.js";
import { hashPassword, tokenHash, verifyPassword } from "./auth.js";
import { seedTestBudget } from "./test-budget.js";

class SyntheticConversationProvider implements StreamingProvider {
  readonly name = "openai" as const;
  readonly model = "test-model";
  calls: { instructions: string; messages: ModelMessage[] }[] = [];
  async *stream(
    instructions: string,
    messages: ModelMessage[],
  ): AsyncIterable<ModelStreamEvent> {
    this.calls.push({ instructions, messages: structuredClone(messages) });
    yield {
      type: "delta",
      text: "Синтетический ориентир по переезду. Что сейчас важнее всего?",
    };
    yield {
      type: "complete",
      model: "test-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

async function fixture(t: TestContext) {
  // Never inherit a real database, credentials, provider adapters or environment
  // files. Even AI coverage below invokes only this in-process generator.
  const db = await connectDatabase("pglite://:memory:");
  const cleanup: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  t.after(async () => {
    try {
      await cleanup.app?.close();
    } finally {
      await db.close();
    }
  });
  await migrate(db);
  const accounts = new AccountAccess(db);
  const bootstrap = await accounts.bootstrapAdmin(await hashPassword("admin"));
  const provider = new SyntheticConversationProvider();
  const origin = "http://localhost:3000";
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    WEB_ORIGIN: origin,
    // Deliberately include ordinary fixture users: this legacy environment
    // allowlist must no longer confer application privileges.
    ADMIN_USER_IDS: "1,2,3,4,5,6,7,8,9",
  });
  await seedTestBudget(db, config, { openai: provider });
  const currentApp = await buildApp({ db, provider, testing: true, config });
  cleanup.app = currentApp;
  await chooseSyntheticServiceConsents(db, bootstrap.id, currentApp);
  const call = (
    method: "GET" | "POST",
    url: string,
    token = "",
    payload?: object,
    transport: "native" | "cookie" = "native",
  ) =>
    currentApp.inject({
      method,
      url,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        ...(transport === "native"
          ? {
              "x-citygo-client": "native",
              ...(token ? { authorization: "Bearer " + token } : {}),
            }
          : { origin, ...(token ? { cookie: "citygo=" + token } : {}) }),
      },
      ...(payload ? { payload } : {}),
    });
  const login = async (
    identifier: string,
    password: string,
    transport: "native" | "cookie" = "native",
  ) => {
    const reply = await call(
      "POST",
      "/v1/auth/login",
      "",
      { consents: syntheticServiceConsents, email: identifier, password },
      transport,
    );
    assert.equal(reply.statusCode, 200, reply.body);
    const body = authResponseSchema.parse(reply.json());
    const token = transport === "native" ? body.token : reply.cookies[0]?.value;
    assert.ok(token);
    return { token, body, reply };
  };
  const register = async (
    password = "123456",
    extra: Record<string, unknown> = {},
  ) => {
    const email = randomUUID() + "@example.test";
    const reply = await call("POST", "/v1/auth/register", "", {
      consents: await syntheticConsentsFor(currentApp),
      email,
      password,
      ...extra,
    });
    assert.equal(reply.statusCode, 200, reply.body);
    const body = authResponseSchema.parse(reply.json());
    assert.ok(body.token);
    return {
      consents: syntheticServiceConsents,
      email,
      password,
      token: body.token,
      user: body.user,
    };
  };
  const activateBootstrap = async () => {
    const temporary = await login("admin", "admin");
    const reply = await call("POST", "/v1/auth/password", temporary.token, {
      currentPassword: "admin",
      password: "654321",
    });
    assert.equal(reply.statusCode, 200, reply.body);
    const body = authResponseSchema.parse(reply.json());
    assert.ok(body.token);
    return { token: body.token, user: body.user };
  };
  return {
    db,
    accounts,
    bootstrap,
    provider,
    app: currentApp,
    origin,
    call,
    login,
    register,
    activateBootstrap,
  };
}

test("bootstrap admin authenticates by login with cookie or native token but must change its known password", async (t) => {
  const f = await fixture(t);
  const native = await f.login("admin", "admin");
  assert.equal(native.body.user.id, f.bootstrap.id);
  assert.equal(native.body.user.username, "admin");
  assert.equal(native.body.user.role, "super_admin");
  assert.equal(native.body.user.mustChangePassword, true);
  assert.ok(native.reply.cookies[0]?.httpOnly);
  const browser = await f.login("ADMIN", "admin", "cookie");
  assert.equal(
    browser.body.token,
    undefined,
    "browser response must not expose the HttpOnly session token",
  );
  assert.ok(browser.reply.cookies[0]?.httpOnly);
  for (const [token, transport] of [
    [native.token, "native"],
    [browser.token, "cookie"],
  ] as const) {
    const reply = await f.call(
      "GET",
      "/v1/dashboard",
      token,
      undefined,
      transport,
    );
    assert.equal(reply.statusCode, 200, reply.body);
    const board = dashboardResponseSchema.parse(reply.json());
    assert.equal(board.user.mustChangePassword, true);
    assert.equal(board.profile, null);
    assert.equal(board.thread, null);
    assert.deepEqual(board.quests, []);
    assert.equal(board.xp, 0);
    const blocked = [
      await f.call("POST", "/v1/conversations/start", token, {}, transport),
      await f.call("GET", "/v1/admin/accounts", token, undefined, transport),
      await f.call("GET", "/v1/admin/overview", token, undefined, transport),
      await f.call(
        "POST",
        "/v1/ai/consent",
        token,
        { action: "revoked" },
        transport,
      ),
      await f.call(
        "POST",
        "/v1/threads/1/messages",
        token,
        { text: "Вымышленный вопрос", requestId: randomUUID() },
        transport,
      ),
    ];
    assert.deepEqual(
      blocked.map((response) => response.statusCode),
      [403, 403, 403, 403, 403],
    );
  }
  assert.equal(f.provider.calls.length, 0);
  assert.deepEqual(
    (await f.db.query("select count(*)::int as total from agent_threads")).rows,
    [{ total: 0 }],
  );
});

test("wrong or too-short password change preserves account and sessions; valid six-character password rotates all sessions", async (t) => {
  const f = await fixture(t);
  const native = await f.login("admin", "admin");
  const browser = await f.login("admin", "admin", "cookie");
  const before = await f.accounts.credentials("admin");
  assert.ok(before);
  const wrong = await f.call("POST", "/v1/auth/password", native.token, {
    currentPassword: "wrong",
    password: "123456",
  });
  assert.equal(wrong.statusCode, 401, wrong.body);
  const short = await f.call("POST", "/v1/auth/password", native.token, {
    currentPassword: "admin",
    password: "12345",
  });
  assert.equal(short.statusCode, 400, short.body);
  assert.equal(
    (await f.accounts.credentials("admin"))!.password_hash,
    before.password_hash,
  );
  assert.equal(
    (await f.call("GET", "/v1/dashboard", native.token)).statusCode,
    200,
  );
  assert.equal(
    (await f.call("GET", "/v1/dashboard", browser.token, undefined, "cookie"))
      .statusCode,
    200,
  );
  const changed = await f.call("POST", "/v1/auth/password", native.token, {
    currentPassword: "admin",
    password: "123456",
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const result = authResponseSchema.parse(changed.json());
  assert.equal(result.user.mustChangePassword, false);
  assert.equal(result.user.role, "super_admin");
  assert.ok(result.token);
  assert.notEqual(result.token, native.token);
  assert.equal(
    (await f.call("GET", "/v1/dashboard", native.token)).statusCode,
    401,
  );
  assert.equal(
    (await f.call("GET", "/v1/dashboard", browser.token, undefined, "cookie"))
      .statusCode,
    401,
  );
  assert.equal(
    (await f.call("GET", "/v1/admin/accounts", result.token)).statusCode,
    200,
  );
  assert.deepEqual(
    (
      await f.db.query("select token_hash from sessions where user_id=$1", [
        f.bootstrap.id,
      ])
    ).rows,
    [{ token_hash: tokenHash(result.token) }],
  );
  const current = await f.accounts.credentials("admin");
  assert.ok(current && (await verifyPassword("123456", current.password_hash)));
  assert.ok(!(await verifyPassword("admin", current.password_hash)));
  assert.equal(
    (
      await f.call("POST", "/v1/auth/login", "", {
        consents: syntheticServiceConsents,
        email: "admin",
        password: "admin",
      })
    ).statusCode,
    401,
  );
  await f.login("admin", "123456");
  const audit = (
    await f.db.query<{ payload: unknown }>(
      "select payload from audit_log where action='account-password-changed'",
    )
  ).rows;
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0]!.payload, { sessionsRevoked: true });
});

test("registration accepts any six characters without giving submitted admin flags authority", async (t) => {
  const f = await fixture(t);
  for (const password of ["123456", "abcdef", "абвгде", "      "]) {
    const created = await f.register(password, {
      role: "super_admin",
      username: "admin",
      mustChangePassword: false,
      id: f.bootstrap.id,
    });
    assert.equal(created.user.role, "user");
    assert.equal(created.user.username, null);
    assert.equal(created.user.mustChangePassword, false);
    assert.notEqual(created.user.id, f.bootstrap.id);
    const login = await f.login(created.email, password);
    assert.equal(login.body.user.role, "user");
    const reply = await f.call("GET", "/v1/admin/overview", created.token);
    assert.equal(
      reply.statusCode,
      403,
      "legacy ADMIN_USER_IDS must not elevate a freshly registered user",
    );
    assert.equal(
      (await f.call("GET", "/v1/admin/accounts", created.token)).statusCode,
      403,
    );
    assert.equal(
      (
        await f.call("POST", "/v1/admin/accounts/role", created.token, {
          userId: created.user.id,
          role: "super_admin",
        })
      ).statusCode,
      403,
    );
  }
  for (const password of ["", "12345"]) {
    const reply = await f.call("POST", "/v1/auth/register", "", {
      consents: syntheticServiceConsents,
      email: randomUUID() + "@example.test",
      password,
    });
    assert.equal(reply.statusCode, 400, reply.body);
  }
  assert.equal((await f.accounts.info(f.bootstrap.id))!.role, "super_admin");
});

test("only super admins manage roles; privilege changes revoke the target sessions and keep passwords private", async (t) => {
  const f = await fixture(t);
  const superAdmin = await f.activateBootstrap();
  const target = await f.register();
  const secondTargetSession = await f.login(target.email, target.password);
  const other = await f.register();
  assert.equal(
    (await f.call("GET", "/v1/admin/accounts", target.token)).statusCode,
    403,
  );
  const promoted = await f.call(
    "POST",
    "/v1/admin/accounts/role",
    superAdmin.token,
    { userId: target.user.id, role: "admin" },
  );
  assert.equal(promoted.statusCode, 200, promoted.body);
  assert.equal(
    accountUserResponseSchema.parse(promoted.json()).user.role,
    "admin",
  );
  for (const token of [target.token, secondTargetSession.token]) {
    assert.equal((await f.call("GET", "/v1/dashboard", token)).statusCode, 401);
  }
  const admin = await f.login(target.email, target.password);
  assert.equal(admin.body.user.role, "admin");
  assert.equal(
    (await f.call("GET", "/v1/admin/overview", admin.token)).statusCode,
    200,
  );
  assert.equal(
    (await f.call("GET", "/v1/admin/accounts", admin.token)).statusCode,
    403,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/admin/accounts/role", admin.token, {
        userId: other.user.id,
        role: "super_admin",
      })
    ).statusCode,
    403,
  );
  const promotedAgain = await f.call(
    "POST",
    "/v1/admin/accounts/role",
    superAdmin.token,
    { userId: target.user.id, role: "super_admin" },
  );
  assert.equal(promotedAgain.statusCode, 200, promotedAgain.body);
  assert.equal(
    (await f.call("GET", "/v1/dashboard", admin.token)).statusCode,
    401,
  );
  const secondSuper = await f.login(target.email, target.password);
  const listing = await f.call("GET", "/v1/admin/accounts", secondSuper.token);
  assert.equal(listing.statusCode, 200, listing.body);
  const users = adminUsersResponseSchema.parse(listing.json()).users;
  assert.equal(users.length, 3);
  assert.equal(
    users.find((user) => user.id === target.user.id)!.role,
    "super_admin",
  );
  assert.ok(!/password|token_hash|auth_subject/.test(listing.body));
  const demoted = await f.call(
    "POST",
    "/v1/admin/accounts/role",
    secondSuper.token,
    { userId: f.bootstrap.id, role: "user" },
  );
  assert.equal(demoted.statusCode, 200, demoted.body);
  assert.equal(
    (await f.call("GET", "/v1/dashboard", superAdmin.token)).statusCode,
    401,
  );
  const last = await f.call(
    "POST",
    "/v1/admin/accounts/role",
    secondSuper.token,
    { userId: target.user.id, role: "user" },
  );
  assert.equal(last.statusCode, 409, last.body);
  assert.match(last.json().error, /последнего супер-администратора/);
  assert.equal((await f.accounts.info(target.user.id))!.role, "super_admin");
  const log = (
    await f.db.query<{ payload: { previousRole: string; role: string } }>(
      "select payload from audit_log where action='account-role-changed' order by id",
    )
  ).rows;
  assert.deepEqual(
    log.map((event) => event.payload),
    [
      { previousRole: "user", role: "admin" },
      { previousRole: "admin", role: "super_admin" },
      { previousRole: "super_admin", role: "user" },
    ],
  );
});

test("a fresh user's conversation starts without questionnaire and opening it again preserves the specialist and history", async (t) => {
  const f = await fixture(t);
  const user = await f.register();
  assert.equal(
    (await f.call("POST", "/v1/conversations/start", "", {})).statusCode,
    401,
  );
  const before = await f.call("GET", "/v1/dashboard", user.token);
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json<Dashboard>().thread, null);
  const conversationState = async () => {
    const snapshot: Record<string, unknown[]> = {};
    for (const table of [
      "agent_threads",
      "relocation_profiles",
      "questionnaire_answers",
      "relocation_plans",
      "user_quests",
      "xp_events",
      "messages",
      "chat_requests",
      "ai_model_attempts",
      "ai_credit_accounts",
      "ai_credit_entries",
      "ai_credit_charges",
    ])
      snapshot[table] = (await f.db.query("select * from " + table)).rows;
    return snapshot;
  };
  const unchanged = await conversationState();
  const forged = await f.call("POST", "/v1/conversations/start", user.token, {
    userId: f.bootstrap.id,
    agentKey: "housing",
  });
  assert.equal(forged.statusCode, 400, forged.body);
  assert.deepEqual(await conversationState(), unchanged);
  assert.equal(f.provider.calls.length, 0);
  const created = await f.call(
    "POST",
    "/v1/conversations/start",
    user.token,
    {},
  );
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().agentKey, "support");
  const id = created.json<{ id: string }>().id;
  const repeated = await f.call(
    "POST",
    "/v1/conversations/start",
    user.token,
    {},
  );
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.deepEqual(repeated.json(), created.json());
  assert.deepEqual(
    (await f.db.query("select user_id::text,agent_key from agent_threads"))
      .rows,
    [{ user_id: user.user.id, agent_key: "support" }],
  );
  const dashboard = await f.call("GET", "/v1/dashboard", user.token);
  const board = dashboardResponseSchema.parse(dashboard.json());
  assert.equal(board.profile, null);
  assert.deepEqual(board.quests, []);
  assert.equal(board.xp, 0);
  assert.equal(board.thread!.id, id);
  assert.deepEqual(board.thread!.messages, []);
  for (const table of [
    "relocation_profiles",
    "questionnaire_answers",
    "relocation_plans",
    "user_quests",
    "xp_events",
    "messages",
    "chat_requests",
    "ai_model_attempts",
  ]) {
    assert.deepEqual(
      (await f.db.query(`select count(*)::int as total from ${table}`)).rows,
      [{ total: 0 }],
      table,
    );
  }
  await f.db.query(
    "update agent_threads set agent_key='resume-builder' where id=$1",
    [id],
  );
  await f.db.query(
    "insert into messages(thread_id,role,content,metadata) values ($1,'user','Пока не знаю бюджет',$2)",
    [id, JSON.stringify({ agentKey: "resume-builder", status: "complete" })],
  );
  const reopened = await f.call(
    "POST",
    "/v1/conversations/start",
    user.token,
    {},
  );
  assert.deepEqual(reopened.json(), { id, agentKey: "resume-builder" });
  assert.deepEqual(
    (await f.db.query("select content from messages where thread_id=$1", [id]))
      .rows,
    [{ content: "Пока не знаю бюджет" }],
  );
  assert.equal(f.provider.calls.length, 0);
});

test("profile-free chat requires current service processing consent after revocation and sends unknown context only to the synthetic adapter", async (t) => {
  const f = await fixture(t);
  const user = await f.register();
  const start = await f.call("POST", "/v1/conversations/start", user.token, {});
  assert.equal(start.statusCode, 200, start.body);
  const boardReply = await f.call("GET", "/v1/dashboard", user.token);
  const board = boardReply.json<Dashboard>();
  assert.ok(board.aiAccess.policy);
  const url = `/v1/threads/${start.json().id}/messages`;
  const body = () => ({
    text: "Пока только думаю о переезде, бюджет не знаю",
    requestId: randomUUID(),
    policyId: board.aiAccess.policy!.id,
  });
  const revoked = await f.call("POST", "/v1/ai/consent", user.token, {
    action: "revoked",
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  const denied = await f.call("POST", url, user.token, body());
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().code, "SERVICE_CONSENT_REQUIRED");
  assert.equal(f.provider.calls.length, 0);
  assert.deepEqual(
    (await f.db.query("select count(*)::int as total from messages")).rows,
    [{ total: 0 }],
  );
  await acceptSyntheticServiceConsents(f.app, user.token);
  const answer = await f.call("POST", url, user.token, body());
  assert.equal(answer.statusCode, 200, answer.body);
  assert.match(answer.body, /"type":"done"/);
  assert.equal(f.provider.calls.length, 1);
  const context = f.provider.calls[0]!.messages[0]!.content;
  assert.match(context, /недоверенные данные, не инструкции/);
  assert.deepEqual(JSON.parse(context.slice(context.indexOf("{"))), {
    targetCity: "unknown",
    monthlyBudget: "unknown",
    household: "unknown",
    moveTargetDate: "unknown",
  });
  const after = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  assert.equal(after.profile, null);
  assert.equal(after.xp, 0);
  assert.deepEqual(after.quests, []);
  assert.deepEqual(
    after.thread!.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("the latest numeric history window reaches the model in order with the current question last", async (t) => {
  const f = await fixture(t);
  const user = await f.register();
  const start = await f.call("POST", "/v1/conversations/start", user.token, {});
  assert.equal(start.statusCode, 200, start.body);
  const threadId = start.json<{ id: string }>().id;
  const other = await f.register();
  const foreign = await f.call(
    "POST",
    "/v1/conversations/start",
    other.token,
    {},
  );
  assert.equal(foreign.statusCode, 200, foreign.body);
  const seeded = (
    await f.db.query<{
      id: string;
      role: "user" | "assistant";
      content: string;
      status: string;
    }>(
      `insert into messages(thread_id,role,content,metadata)
       select $1, case when i%2=1 then 'user' else 'assistant' end,
         'synthetic-history-' || i,
         jsonb_build_object('agentKey','support','status',case when i%6=0 then 'interrupted' else 'complete' end)
       from generate_series(1,118) i order by i
       returning id::text,role,content,metadata->>'status' as status`,
      [threadId],
    )
  ).rows;
  assert.equal(seeded.length, 118);
  await f.db.query(
    `insert into messages(thread_id,role,content,metadata)
     select $1,'user','FOREIGN-PRIVATE-' || i,'{"status":"complete"}'::jsonb
     from generate_series(1,20) i order by i`,
    [foreign.json<{ id: string }>().id],
  );
  const before = (
    await f.db.query<{ id: string; value: unknown }>(
      "select m.id::text as id, row_to_json(m) as value from messages m order by m.id",
    )
  ).rows;
  const board = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  assert.deepEqual(
    board.thread!.messages.map((m) => m.id),
    seeded.slice(-100).map((m) => m.id),
  );
  const policyId = board.aiAccess.policy!.id;
  const consent = await f.call("POST", "/v1/ai/consent", user.token, {
    action: "granted",
    policyId,
  });
  assert.equal(consent.statusCode, 200, consent.body);
  const currentQuestion = "Последний вопрос: как подготовиться к переезду?";
  const requestId = randomUUID();
  const reply = await f.call(
    "POST",
    `/v1/threads/${threadId}/messages`,
    user.token,
    {
      text: currentQuestion,
      requestId,
      policyId,
    },
  );
  assert.equal(reply.statusCode, 200, reply.body);
  assert.match(reply.body, /"type":"done"/);
  assert.equal(f.provider.calls.length, 1);
  // history() first selects the latest 100 records numerically. Model context
  // keeps the latest nine whole completed rounds, never orphaned failed-turn
  // users, and always ends with this exact new question. Full UI history stays.
  const expected = [
    ...[93, 97, 99, 103, 105, 109, 111, 115, 117].flatMap((number) => [
      { role: "user", content: `synthetic-history-${number}` },
      { role: "assistant", content: `synthetic-history-${number + 1}` },
    ]),
    { role: "user", content: currentQuestion },
  ];
  const sent = f.provider.calls[0]!.messages;
  assert.deepEqual(sent.slice(1), expected);
  assert.deepEqual(sent.at(-1), { role: "user", content: currentQuestion });
  assert.equal(sent.length, 20);
  assert.ok(!JSON.stringify(sent).includes("FOREIGN-PRIVATE-"));
  const after = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  assert.equal(after.thread!.messages.length, 100);
  assert.deepEqual(
    after
      .thread!.messages.slice(-2)
      .map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: currentQuestion },
      {
        role: "assistant",
        content: "Синтетический ориентир по переезду. Что сейчас важнее всего?",
      },
    ],
  );
  // Reading in the corrected order must not rewrite existing content/metadata.
  assert.deepEqual(
    (
      await f.db.query(
        "select m.id::text as id, row_to_json(m) as value from messages m where m.id <= $1::bigint order by m.id",
        [before.at(-1)!.id],
      )
    ).rows,
    before,
  );
  const replay = await f.call(
    "POST",
    `/v1/threads/${threadId}/messages`,
    user.token,
    { text: currentQuestion, requestId, policyId },
  );
  assert.equal(replay.statusCode, 409, replay.body);
  assert.equal(f.provider.calls.length, 1);
});

test("cookie-authenticated password changes remain same-origin and an invalid target role is rejected", async (t) => {
  const f = await fixture(t);
  const browser = await f.login("admin", "admin", "cookie");
  const crossOrigin = await f.app.inject({
    method: "POST",
    url: "/v1/auth/password",
    headers: {
      origin: "https://untrusted.example",
      cookie: "citygo=" + browser.token,
      [CONTRACT_VERSION_HEADER]: "1",
    },
    payload: { currentPassword: "admin", password: "123456" },
  });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(
    (await f.accounts.info(f.bootstrap.id))!.mustChangePassword,
    true,
  );
  const changed = await f.call(
    "POST",
    "/v1/auth/password",
    browser.token,
    { currentPassword: "admin", password: "123456" },
    "cookie",
  );
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().token, undefined);
  const token = changed.cookies[0]!.value;
  assert.ok(token && changed.cookies[0]!.httpOnly);
  const target = await f.register();
  const invalid = await f.call(
    "POST",
    "/v1/admin/accounts/role",
    token,
    { userId: target.user.id, role: "root" },
    "cookie",
  );
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal((await f.accounts.info(target.user.id))!.role, "user");
  const invalidId = await f.call(
    "POST",
    "/v1/admin/accounts/role",
    token,
    { userId: "9223372036854775808", role: "admin" },
    "cookie",
  );
  assert.equal(invalidId.statusCode, 400, invalidId.body);
  const absent = await f.call(
    "POST",
    "/v1/admin/accounts/role",
    token,
    { userId: "9223372036854775807", role: "admin" },
    "cookie",
  );
  assert.equal(absent.statusCode, 404, absent.body);
  const stillValid = await f.call(
    "GET",
    "/v1/dashboard",
    token,
    undefined,
    "cookie",
  );
  assert.equal(stillValid.statusCode, 200, stillValid.body);
  const account = stillValid.json<{ user: AccountInfo }>().user;
  assert.equal(account.role, "super_admin");
  assert.equal(account.mustChangePassword, false);
});
