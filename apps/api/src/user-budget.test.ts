import { syntheticServiceConsents } from "./test-service-consents.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { testProfile } from "@citygo/testkit";
import type {
  AiBudgetInput,
  AiControlStatus,
  Dashboard,
} from "@citygo/contracts";
import type { StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";

const RUB = 1_000_000;
const password = "CityGo-user-budget-test-password";
type Api = Awaited<ReturnType<typeof buildApp>>;
type ChatUser = {
  id: string;
  email: string;
  token: string;
  thread: string;
  policyId: string;
};

// Default: memory-only PGlite. CI's TEST_DATABASE_URL uses a unique PostgreSQL
// disposable database/public schema per fixture to exercise real row locks.
// Prices are artificial reservation amounts, never model tariffs or live budgets.
async function fixture({
  cost = 250 * RUB,
  cap = 500 * RUB,
  retry = false,
}: {
  cost?: number;
  cap?: number | null;
  retry?: boolean;
} = {}) {
  const base = process.env.TEST_DATABASE_URL;
  let scoped: URL | undefined;
  if (base) {
    try {
      scoped = new URL(base);
      assert.ok(["postgres:", "postgresql:"].includes(scoped.protocol));
      assert.ok(["127.0.0.1", "localhost"].includes(scoped.hostname));
      assert.ok(["5432", "55438"].includes(scoped.port || "5432"));
      assert.ok(
        ["/citygo_test", "/citygo_synthetic"].includes(scoped.pathname),
      );
      assert.equal(scoped.search, "");
      assert.equal(scoped.hash, "");
    } catch {
      throw new Error(
        "TEST_DATABASE_URL must point to the isolated localhost PostgreSQL test service",
      );
    }
  }
  const databaseName = "user_budget_test_" + randomUUID().replaceAll("-", "");
  assert.match(databaseName, /^user_budget_test_[a-f0-9]{32}$/);
  let adminDb: Database | undefined, database: Database | undefined;
  const apps: Api[] = [];
  let created = false,
    closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      const results = await Promise.allSettled(
        apps.map(async (target) => target.close()),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally {
      try {
        await database?.close();
      } finally {
        if (adminDb) {
          try {
            if (created) await adminDb.query(`drop database "${databaseName}"`);
          } finally {
            await adminDb.close();
          }
        }
      }
    }
  };
  try {
    let url = "pglite://:memory:";
    if (scoped && base) {
      adminDb = await connectDatabase(base);
      await adminDb.query(
        `create database "${databaseName}" template template0`,
      );
      created = true;
      scoped.pathname = "/" + databaseName;
      url = scoped.toString();
    }
    const db = await connectDatabase(url);
    database = db;
    await migrate(db);
    await migrate(db);
    const config = readConfig({
      NODE_ENV: "test",
      ADMIN_USER_IDS: "1",
      LLM_USER_DAILY_REQUEST_LIMIT: "100",
      LLM_GLOBAL_DAILY_REQUEST_LIMIT: "1000",
      LLM_USER_DAILY_ATTEMPT_LIMIT: "100",
      LLM_GLOBAL_DAILY_ATTEMPT_LIMIT: "1000",
    });
    let dispatches = 0;
    const provider: StreamingProvider = {
      name: "routerai",
      model: "test/user-budget",
      async *stream(_instructions, _messages, _signal, retryGuard) {
        dispatches++;
        if (retry) {
          await retryGuard!.beforeRetry();
          dispatches++;
        }
        yield { type: "delta", text: "Синтетический ответ о квартире" };
        yield { type: "complete", model: "test/user-budget" };
      },
    };
    const replica = async () => {
      const app = await buildApp({ db, config, provider, testing: true });
      apps.push(app);
      return app;
    };
    const app = await replica();
    const call = (
      target: Api,
      method: "GET" | "POST",
      url: string,
      token = "",
      payload?: object,
    ) =>
      target.inject({
        method,
        url,
        headers: {
          origin: "http://localhost:3000",
          ...(token ? { cookie: "citygo=" + token } : {}),
        },
        ...(payload ? { payload } : {}),
      });
    const board = async (user: Pick<ChatUser, "token">, target = app) => {
      const response = await call(target, "GET", "/v1/dashboard", user.token);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Dashboard>();
    };
    const chatUser = async (): Promise<ChatUser> => {
      const email = randomUUID() + "@example.test";
      const registered = await call(app, "POST", "/v1/auth/register", "", {
        consents: syntheticServiceConsents,
        email,
        password,
      });
      assert.equal(registered.statusCode, 200, registered.body);
      const token = registered.cookies[0]!.value;
      const id = registered.json().user.id as string;
      assert.equal(
        (await call(app, "POST", "/v1/questionnaire", token, testProfile))
          .statusCode,
        200,
      );
      const dashboard = await board({ token });
      const policyId = dashboard.aiAccess.policy!.id;
      const started = await call(
        app,
        "POST",
        `/v1/quests/${dashboard.quests[0]!.id}/start`,
        token,
        {},
      );
      assert.equal(started.statusCode, 200, started.body);
      const thread = started.json().id as string;
      assert.equal(
        (
          await call(app, "POST", "/v1/ai/consent", token, {
            action: "granted",
            policyId,
          })
        ).statusCode,
        200,
      );
      return { id, email, token, thread, policyId };
    };
    const admin = await chatUser();
    // Explicit test fixture setup, not runtime ADMIN_USER_IDS authorization.
    await db.query("update users set role='admin' where id=$1", [admin.id]);
    const status = async (target = app) => {
      const response = await call(target, "GET", "/v1/admin/ai", admin.token);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<AiControlStatus>();
    };
    const save = async (changes: Partial<AiBudgetInput> = {}, target = app) => {
      const budget = (await status(target)).budget!;
      const input = {
        expectedRevision: budget.settings.revision,
        enabled: true,
        currency: "RUB",
        dailyLimitMicros: 10000 * RUB,
        totalLimitMicros: 100000 * RUB,
        rules: budget.availableExecutions.map((item) => ({
          key: item.key,
          attemptCeilingMicros: cost,
        })),
        ...changes,
      };
      const response = await call(
        target,
        "POST",
        "/v1/admin/ai/budget",
        admin.token,
        input,
      );
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const before = (await status()).budget!;
    assert.equal(before.settings.userDailyLimitMicros, null);
    await save({ userDailyLimitMicros: cap });
    const send = (user: ChatUser, target = app, extra: object = {}) =>
      call(target, "POST", `/v1/threads/${user.thread}/messages`, user.token, {
        text: "Помоги выбрать квартиру",
        requestId: randomUUID(),
        policyId: user.policyId,
        ...extra,
      });
    return {
      app,
      db,
      admin,
      board,
      chatUser,
      status,
      save,
      send,
      replica,
      call,
      close,
      dispatches: () => dispatches,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Synthetic user-budget fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}

const completed = (response: { body: string }) =>
  response.body.includes('"type":"done"');

test("500 RUB daily allowance is per authenticated user, not a shared 500 RUB pool", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const users = [f.admin, await f.chatUser()];
  for (let round = 0; round < 2; round++)
    for (const response of await Promise.all(users.map((user) => f.send(user))))
      assert.ok(completed(response), response.body);
  assert.equal(f.dispatches(), 4);
  for (const user of users) {
    const personal = (await f.board(user)).aiAccess.budget!;
    assert.equal(personal.currency, "RUB");
    assert.equal(personal.limitMicros, 500 * RUB);
    assert.equal(personal.reservedTodayMicros, 500 * RUB);
    assert.equal(personal.remainingMicros, 0);
    assert.equal(completed(await f.send(user)), false);
  }
  assert.equal(f.dispatches(), 4);
  assert.equal((await f.status()).budget!.totalReservedMicros, 1000 * RUB);
});

test("two sessions and replicas share one account's allowance, including concurrent and restarted requests", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const replica = await f.replica();
  const login = await f.call(replica, "POST", "/v1/auth/login", "", {
    consents: syntheticServiceConsents,
    email: f.admin.email,
    password,
  });
  assert.equal(login.statusCode, 200, login.body);
  const otherSession = { ...f.admin, token: login.cookies[0]!.value };
  assert.notEqual(otherSession.token, f.admin.token);
  assert.ok(completed(await f.send(f.admin)));
  const responses = await Promise.all([
    f.send(f.admin),
    f.send(otherSession, replica),
  ]);
  assert.equal(responses.filter(completed).length, 1);
  assert.equal(f.dispatches(), 2);
  const restarted = await f.replica();
  for (const user of [f.admin, otherSession]) {
    assert.equal(completed(await f.send(user, restarted)), false);
    assert.equal(
      (await f.board(user, restarted)).aiAccess.budget!.reservedTodayMicros,
      500 * RUB,
    );
  }
  assert.equal(f.dispatches(), 2);
});

test("500 RUB exact boundary admits the final micro-unit and never one micro-unit above it", async (t) => {
  const f = await fixture({ cost: 500 * RUB - 1 });
  t.after(f.close);
  assert.ok(completed(await f.send(f.admin)));
  assert.equal((await f.board(f.admin)).aiAccess.budget!.remainingMicros, 1);
  const budget = (await f.status()).budget!;
  await f.save({
    rules: [
      { key: budget.availableExecutions[0]!.key, attemptCeilingMicros: 1 },
    ],
  });
  assert.ok(completed(await f.send(f.admin)));
  assert.equal((await f.board(f.admin)).aiAccess.budget!.remainingMicros, 0);
  assert.equal(completed(await f.send(f.admin)), false);
  assert.equal(f.dispatches(), 2);
  assert.equal((await f.status()).budget!.totalReservedMicros, 500 * RUB);
});

test("an automatic retry reserves another complete per-user amount within the same message", async (t) => {
  const f = await fixture({ retry: true });
  t.after(f.close);
  assert.ok(completed(await f.send(f.admin)));
  assert.equal(f.dispatches(), 2);
  const rows = (
    await f.db.query<{ attempt_number: number; money_reserved_micros: string }>(
      "select attempt_number,money_reserved_micros::text from ai_model_attempts order by attempt_number",
    )
  ).rows;
  assert.deepEqual(
    rows.map((row) => row.attempt_number),
    [1, 2],
  );
  assert.deepEqual(
    rows.map((row) => Number(row.money_reserved_micros)),
    [250 * RUB, 250 * RUB],
  );
  assert.equal(
    (await f.board(f.admin)).aiAccess.budget!.reservedTodayMicros,
    500 * RUB,
  );
  assert.equal(completed(await f.send(f.admin)), false);
  assert.equal(f.dispatches(), 2);
});

test("a retry that cannot fit the remaining personal allowance stops before dispatch and never refunds its first attempt", async (t) => {
  const f = await fixture({ retry: true, cost: 300 * RUB });
  t.after(f.close);
  assert.equal(completed(await f.send(f.admin)), false);
  assert.equal(f.dispatches(), 1);
  const status = await f.status();
  assert.equal(status.attempts!.reservedToday, 1);
  assert.equal(status.attempts!.recent.length, 1);
  assert.equal(status.attempts!.recent[0]!.attemptNumber, 1);
  assert.equal(status.attempts!.recent[0]!.requestStatus, "interrupted");
  assert.equal(status.budget!.totalReservedMicros, 300 * RUB);
  assert.equal(
    (await f.board(f.admin)).aiAccess.budget!.remainingMicros,
    200 * RUB,
  );
  assert.equal(completed(await f.send(f.admin)), false);
  assert.equal(f.dispatches(), 1);
  assert.equal((await f.status()).attempts!.reservedToday, 1);
});

test("enabling a personal cap counts existing priced ledger entries and preserves legacy NULL money as unknown", async (t) => {
  const f = await fixture({ cap: null });
  t.after(f.close);
  assert.ok(completed(await f.send(f.admin)));
  const repo = new Repository(f.db);
  const requestId = randomUUID();
  const reservation = await repo.reserveChat(
    f.admin.id,
    f.admin.thread,
    requestId,
    "Историческая запись",
    {
      policyId: f.admin.policyId,
      revision: 1,
      userDailyLimit: 100,
      globalDailyLimit: 1000,
    },
  );
  await f.db.query(
    "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision) values ($1,$2,1,$3,'routerai','test/user-budget',$4,1)",
    [f.admin.thread, requestId, f.admin.id, f.admin.policyId],
  );
  await repo.finishChat(
    f.admin.thread,
    requestId,
    reservation.lease,
    "housing",
    "Исторический прерванный ответ",
    false,
    true,
  );
  await f.save({ userDailyLimitMicros: 250 * RUB });
  const personal = (await f.board(f.admin)).aiAccess.budget!;
  assert.equal(personal.reservedTodayMicros, 250 * RUB);
  assert.equal(personal.remainingMicros, 0);
  const unknown = (await f.status()).attempts!.recent.find(
    (item) => item.requestId === requestId,
  )!;
  assert.equal(unknown.money, null);
  assert.equal(completed(await f.send(f.admin)), false);
  assert.equal(f.dispatches(), 1);
});

test("personal allowance rolls over by ledger UTC date without resetting history or lifetime reserves", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.ok(completed(await f.send(f.admin)));
  assert.ok(completed(await f.send(f.admin)));
  const prior = await f.status();
  await f.db.query(
    "update ai_model_attempts set reserved_at=reserved_at-interval '1 day'",
  );
  await f.db.query("update ai_budget_daily set usage_day=usage_day-1");
  const personal = (await f.board(f.admin)).aiAccess.budget!;
  assert.equal(personal.day, prior.budget!.day);
  assert.equal(personal.reservedTodayMicros, 0);
  assert.equal(personal.remainingMicros, 500 * RUB);
  const expectedReset = new Date(personal.day + "T00:00:00.000Z");
  expectedReset.setUTCDate(expectedReset.getUTCDate() + 1);
  assert.equal(
    new Date(personal.resetAt).toISOString(),
    expectedReset.toISOString(),
  );
  assert.equal((await f.status()).budget!.totalReservedMicros, 500 * RUB);
  assert.ok(completed(await f.send(f.admin)));
  assert.equal(
    (await f.board(f.admin)).aiAccess.budget!.reservedTodayMicros,
    250 * RUB,
  );
  assert.equal((await f.status()).budget!.totalReservedMicros, 750 * RUB);
  assert.equal(
    Number(
      (
        await f.db.query<{ count: string }>(
          "select count(*)::text as count from ai_model_attempts",
        )
      ).rows[0]!.count,
    ),
    3,
  );
});

test("omitted cap preserves it, lowering below reservations clamps remaining, zero stops and explicit null clears without refunds", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.ok(completed(await f.send(f.admin)));
  await f.save();
  assert.equal(
    (await f.status()).budget!.settings.userDailyLimitMicros,
    500 * RUB,
  );
  await f.save({ userDailyLimitMicros: 100 * RUB });
  assert.equal((await f.board(f.admin)).aiAccess.budget!.remainingMicros, 0);
  assert.equal(completed(await f.send(f.admin)), false);
  await f.save({ userDailyLimitMicros: 0 });
  assert.equal(completed(await f.send(f.admin)), false);
  assert.equal((await f.status()).budget!.totalReservedMicros, 250 * RUB);
  await f.save({ userDailyLimitMicros: null });
  assert.equal((await f.board(f.admin)).aiAccess.budget!.limitMicros, null);
  assert.ok(completed(await f.send(f.admin)));
  await f.save({ userDailyLimitMicros: 500 * RUB });
  const restarted = await f.replica();
  await f.save({}, restarted);
  assert.equal(
    (await f.status(restarted)).budget!.settings.userDailyLimitMicros,
    500 * RUB,
  );
  assert.equal(
    (await f.board(f.admin, restarted)).aiAccess.budget!.remainingMicros,
    0,
  );
  assert.equal(
    (await f.status(restarted)).budget!.totalReservedMicros,
    500 * RUB,
  );
  assert.equal(f.dispatches(), 2);
});

test("forged identity cannot borrow another user's allowance and rejected reserves roll back attempt counters before dispatch", async (t) => {
  const f = await fixture({ cost: 500 * RUB });
  t.after(f.close);
  const other = await f.chatUser();
  const budget = (await f.status()).budget!;
  const change = {
    expectedRevision: budget.settings.revision,
    enabled: true,
    currency: "RUB",
    dailyLimitMicros: 10000 * RUB,
    totalLimitMicros: 100000 * RUB,
    userDailyLimitMicros: null,
    rules: [
      {
        key: budget.availableExecutions[0]!.key,
        attemptCeilingMicros: 500 * RUB,
      },
    ],
  };
  assert.equal(
    (await f.call(f.app, "POST", "/v1/admin/ai/budget", "", change)).statusCode,
    401,
  );
  assert.equal(
    (await f.call(f.app, "POST", "/v1/admin/ai/budget", other.token, change))
      .statusCode,
    403,
  );
  assert.ok(completed(await f.send(f.admin)));
  assert.equal(
    completed(await f.send(f.admin, f.app, { userId: other.id })),
    false,
  );
  assert.equal(
    (
      await f.call(
        f.app,
        "POST",
        `/v1/threads/${other.thread}/messages`,
        f.admin.token,
        {
          text: "Квартира",
          requestId: randomUUID(),
          policyId: f.admin.policyId,
          userId: other.id,
        },
      )
    ).statusCode,
    404,
  );
  assert.equal(f.dispatches(), 1);
  const overview = await f.status();
  assert.equal(overview.attempts!.reservedToday, 1);
  assert.equal(overview.budget!.totalReservedMicros, 500 * RUB);
  assert.equal((await f.board(other)).aiAccess.budget!.reservedTodayMicros, 0);
  const ledger = (await f.db.query("select user_id from ai_model_attempts"))
    .rows;
  assert.equal(ledger.length, 1);
  const personalCounter = (
    await f.db.query<{ reserved_attempts: number }>(
      "select reserved_attempts from ai_user_model_attempt_daily where user_id=$1",
      [f.admin.id],
    )
  ).rows[0]!;
  assert.equal(personalCounter.reserved_attempts, 1);
});
