import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { testProfile, TestProvider } from "@citygo/testkit";
import type { Dashboard } from "@citygo/contracts";
import type { StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { ApiDrain, createShutdown } from "./shutdown.js";
import { seedTestBudget } from "./test-budget.js";

// A separate test process bounds WASM resource usage for fault-injection fixtures.
// CI uses an isolated disposable PostgreSQL database with the public schema.
async function fixture(provider: StreamingProvider = new TestProvider()) {
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
  const databaseName = "settlement_test_" + randomUUID().replaceAll("-", "");
  assert.match(databaseName, /^settlement_test_[a-f0-9]{32}$/);
  let admin: Database | undefined, database: Database | undefined;
  let application: Awaited<ReturnType<typeof buildApp>> | undefined;
  let created = false,
    closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await application?.close();
    } finally {
      try {
        await database?.close();
      } finally {
        if (admin) {
          try {
            if (created) await admin.query(`drop database "${databaseName}"`);
          } finally {
            await admin.close();
          }
        }
      }
    }
  }
  try {
    let url = "pglite://:memory:";
    if (scoped && base) {
      admin = await connectDatabase(base);
      await admin.query(`create database "${databaseName}" template template0`);
      created = true;
      scoped.pathname = "/" + databaseName;
      url = scoped.toString();
    }
    const db = await connectDatabase(url);
    database = db;
    await migrate(db);
    const config = readConfig({ NODE_ENV: "test" });
    await seedTestBudget(db, config, { [provider.name]: provider });
    const drain = new ApiDrain();
    const app = await buildApp({ db, provider, drain, config, testing: true });
    application = app;
    const call = (
      method: "GET" | "POST",
      path: string,
      token = "",
      body?: object,
    ) =>
      app.inject({
        method,
        url: path,
        headers: { origin: "http://localhost:3000", cookie: "citygo=" + token },
        ...(body ? { payload: body } : {}),
      });
    return { app, db, drain, call, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Synthetic chat fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}

async function chatUser(f: Awaited<ReturnType<typeof fixture>>) {
  const auth = await f.call("POST", "/v1/auth/register", "", {
    email: randomUUID() + "@example.test",
    password: "CityGo-test-password",
  });
  assert.equal(auth.statusCode, 200);
  const token = auth.cookies[0]!.value;
  assert.equal(
    (await f.call("POST", "/v1/questionnaire", token, testProfile)).statusCode,
    200,
  );
  const board = (await f.call("GET", "/v1/dashboard", token)).json<Dashboard>();
  const thread = await f.call(
    "POST",
    `/v1/quests/${board.quests[0]!.id}/start`,
    token,
    {},
  );
  assert.equal(thread.statusCode, 200);
  const policyId = board.aiAccess.policy!.id;
  assert.equal(
    (
      await f.call("POST", "/v1/ai/consent", token, {
        action: "granted",
        policyId,
      })
    ).statusCode,
    200,
  );
  return {
    userId: board.user.id,
    token,
    thread: thread.json().id as string,
    policyId,
  };
}

for (const duringDrain of [true, false]) {
  test(
    `failed chat settlement prevents a clean shutdown (${duringDrain ? "during" : "before"} drain)`,
    { timeout: 15000 },
    async (t) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let providerCalls = 0;
      const f = await fixture({
        name: "openai",
        model: "test-settlement-failure",
        async *stream(_instructions, _messages, signal) {
          providerCalls++;
          signal.addEventListener("abort", release, { once: true });
          yield { type: "delta", text: "Незавершённый ответ" };
          entered();
          await hold;
          throw new Error("Synthetic interrupted stream");
        },
      });
      t.after(async () => {
        release();
        await f.close();
      });
      const user = await chatUser(f);
      const pending = f.call(
        "POST",
        `/v1/threads/${user.thread}/messages`,
        user.token,
        {
          text: "Квартира",
          requestId: randomUUID(),
          policyId: user.policyId,
        },
      );
      await started;
      const budgetBefore = (
        await f.db.query("select total_reserved_micros from ai_budget")
      ).rows;
      const settlement = t.mock.method(
        Repository.prototype,
        "finishChat",
        async () => {
          throw new Error("synthetic-private-database-error");
        },
      );
      t.after(() => {
        // Mock call records retain `this` (Repository + the WASM database).
        settlement.mock.resetCalls();
        settlement.mock.restore();
      });
      let closed = false;
      const shutdown = createShutdown(
        f.drain,
        async () => {
          closed = true;
        },
        { graceMs: 10, cleanupMs: 5000 },
      );
      let rejected: Promise<void> | undefined;
      if (duringDrain)
        rejected = assert.rejects(shutdown(), /API chat settlement failed/);
      else release();
      const response = await pending;
      await f.drain.whenIdle();
      if (!duringDrain)
        rejected = assert.rejects(shutdown(), /API chat settlement failed/);
      await rejected;
      assert.equal(
        closed,
        true,
        "idle resources must still close before reporting failed drain",
      );
      assert.equal(f.drain.active, 0);
      assert.equal(settlement.mock.callCount(), 1);
      assert.equal(providerCalls, 1);
      assert.match(response.body, /"type":"error"/);
      assert.match(response.body, /"retryable":false/);
      assert.match(response.body, /Не удалось подтвердить сохранение истории/);
      assert.doesNotMatch(
        response.body,
        /"type":"done"|История сохранена|synthetic-private-database-error/,
      );
      const attempts = await f.db.query("select * from ai_model_attempts");
      assert.equal(attempts.rows.length, 1);
      assert.deepEqual(
        (await f.db.query("select total_reserved_micros from ai_budget")).rows,
        budgetBefore,
      );
      const lease = await f.db.query(
        "select busy_until from agent_threads where id=$1",
        [user.thread],
      );
      assert.notEqual(
        lease.rows[0]!.busy_until,
        null,
        "failed settlement is not a released lease",
      );
    },
  );
}

test("failed completion recovered by interrupted persistence still permits a clean shutdown", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const user = await chatUser(f);
  const finishChat = Repository.prototype.finishChat;
  const settlement = t.mock.method(
    Repository.prototype,
    "finishChat",
    async function (this: Repository, ...args: Parameters<typeof finishChat>) {
      if (args[5]) throw new Error("Synthetic complete write failed");
      return finishChat.apply(this, args);
    },
  );
  t.after(() => {
    settlement.mock.resetCalls();
    settlement.mock.restore();
  });
  const response = await f.call(
    "POST",
    `/v1/threads/${user.thread}/messages`,
    user.token,
    {
      text: "Квартира",
      requestId: randomUUID(),
      policyId: user.policyId,
    },
  );
  await f.drain.whenIdle();
  assert.equal(settlement.mock.callCount(), 2);
  assert.match(response.body, /История сохранена/);
  assert.doesNotMatch(response.body, /"type":"done"/);
  const history = (
    await f.call("GET", "/v1/dashboard", user.token)
  ).json<Dashboard>();
  assert.equal(history.thread!.messages.at(-1)!.status, "interrupted");
  let closed = false;
  await createShutdown(f.drain, async () => {
    closed = true;
  })();
  assert.equal(closed, true);
});
