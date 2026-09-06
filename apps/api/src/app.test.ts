import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate } from "@citygo/db";
import { testProfile, TestProvider } from "@citygo/testkit";
import type { Dashboard } from "@citygo/contracts";
import { buildApp } from "./app.js";
import { readConfig } from "@citygo/config";

async function fixture(provider = true, env: NodeJS.ProcessEnv = {}) {
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
    provider: provider ? new TestProvider() : undefined,
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
  const call = (
    method: "GET" | "POST",
    path: string,
    token = "",
    body?: object,
  ) =>
    app.inject({
      method,
      url: path,
      headers: { origin, ...(token ? { cookie: "citygo=" + token } : {}) },
      ...(body ? { payload: body } : {}),
    });
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
  return { app, db, call, register, close };
}

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

test("vertical slice, ownership, streaming, handoff and exactly-once XP", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const user = await f.register();
  const other = await f.register();
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
      async *stream() {
        yield "Частичный ответ";
        throw new Error("test disconnect");
      },
    },
  });
  t.after(() => broken.close());
  const response = await broken.inject({
    method: "POST",
    url: "/v1/threads/" + thread + "/messages",
    headers: {
      origin: "http://localhost:3000",
      cookie: "citygo=" + user.token,
    },
    payload: { text: "Квартира", requestId: randomUUID() },
  });
  assert.match(response.body, /"type":"error"/);
  const saved = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  assert.equal(saved.thread!.messages.at(-1)!.status, "interrupted");
  assert.equal(
    (
      await f.call("POST", "/v1/quests/" + id + "/complete", user.token, {
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  const recovered = await f.call(
    "POST",
    "/v1/threads/" + thread + "/messages",
    user.token,
    { text: "Квартира", requestId: randomUUID() },
  );
  assert.match(recovered.body, /"type":"done"/);
});
