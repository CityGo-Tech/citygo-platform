import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate } from "@citygo/db";
import { testProfile, TestProvider } from "@citygo/testkit";
import type { Dashboard } from "@citygo/contracts";
import { buildApp } from "./app.js";

async function fixture(provider = true) {
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
  const app = buildApp({
    db,
    provider: provider ? new TestProvider() : undefined,
    testing: true,
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
  assert.equal(board.thread!.messages.length, 2);
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
  assert.equal((await f.call("POST", "/v1/quests/" + next.id + "/complete", user.token, { confirmed: true })).statusCode, 409);
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
  const broken = buildApp({
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
