import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  AiCreditLedger,
  connectDatabase,
  migrate,
  type Database,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { aiCreditResponseSchema, type Dashboard } from "@citygo/contracts";
import { buildApp } from "./app.js";

const RUB = 1_000_000;
async function fixture() {
  const base = process.env.TEST_DATABASE_URL;
  const database = "credit_test_" + randomUUID().replaceAll("-", "");
  assert.match(database, /^credit_test_[a-f0-9]{32}$/);
  const scoped = base ? new URL(base) : null;
  if (scoped) {
    assert.ok(["postgres:", "postgresql:"].includes(scoped.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(scoped.hostname));
    assert.ok(["5432", "55438"].includes(scoped.port || "5432"));
    assert.ok(["/citygo_test", "/citygo_synthetic"].includes(scoped.pathname));
    assert.equal(scoped.search, "");
    assert.equal(scoped.hash, "");
  }
  const resources: {
    admin?: Database;
    db?: Database;
    app?: Awaited<ReturnType<typeof buildApp>>;
  } = {};
  let created = false,
    closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      for (const action of [
        async () => resources.app?.close(),
        async () => resources.db?.close(),
        async () => {
          if (created)
            await resources.admin!.query(`drop database "${database}"`);
        },
        async () => resources.admin?.close(),
      ]) {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Synthetic credit fixture cleanup failed",
        );
    })());
  const failed = async (error: unknown): Promise<never> => {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Synthetic credit fixture setup and cleanup failed",
      );
    }
    throw error;
  };
  try {
    let url = "pglite://:memory:";
    if (scoped && base) {
      resources.admin = await connectDatabase(base);
      await resources.admin.query(
        `create database "${database}" template template0`,
      );
      created = true;
      scoped.pathname = "/" + database;
      url = scoped.toString();
    }
    const db = await connectDatabase(url);
    resources.db = db;
    await migrate(db);
    await migrate(db);
    const config = readConfig({
      NODE_ENV: "test",
      ADMIN_USER_IDS: "1",
      LLM_PROVIDER: "disabled",
    });
    const app = await buildApp({ db, config, testing: true });
    resources.app = app;
    const call = (
      method: "GET" | "POST",
      path: string,
      token = "",
      body?: object,
      origin = "http://localhost:3000",
    ) =>
      app.inject({
        method,
        url: path,
        headers: { origin, cookie: "citygo=" + token },
        ...(body ? { payload: body } : {}),
      });
    const signup = async () => {
      const reply = await call("POST", "/v1/auth/register", "", {
        email: randomUUID() + "@example.test",
        password: "Synthetic-credit-password-123",
      });
      assert.equal(reply.statusCode, 200, reply.body);
      const token = reply.cookies[0]!.value;
      const board = (
        await call("GET", "/v1/dashboard", token)
      ).json<Dashboard>();
      return { id: board.user.id, token };
    };
    const admin = await signup(),
      user = await signup(),
      other = await signup();
    // Persist only this test actor's application role. ADMIN_USER_IDS is no
    // longer runtime authority, and the other signups remain ordinary users.
    await db.query("update users set role='admin' where id=$1", [admin.id]);
    const ledger = new AiCreditLedger(db);
    return {
      db,
      config,
      app,
      call,
      admin,
      user,
      other,
      ledger,
      close,
    };
  } catch (error) {
    return failed(error);
  }
}

test("welcome credit is owner-authorized, exactly 500 RUB once and independent of AI activation", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const path = "/v1/admin/ai/credit/welcome",
    body = { userId: f.user.id, confirmOneTime500Rub: true };
  const initial = (await f.call("GET", "/v1/ai/credit", f.user.token)).json();
  assert.equal(initial.availableMicros, 0);
  assert.equal(initial.bonusGranted, false);
  assert.equal((await f.call("POST", path, "", body)).statusCode, 401);
  assert.equal(
    (await f.call("POST", path, f.user.token, body)).statusCode,
    403,
  );
  assert.equal(
    (await f.call("POST", path, f.admin.token, body, "https://other.example"))
      .statusCode,
    403,
  );
  for (const invalid of [
    { userId: f.user.id },
    { ...body, amountMicros: 999 },
    { ...body, userId: "-1" },
    { ...body, confirmOneTime500Rub: false },
  ])
    assert.equal(
      (await f.call("POST", path, f.admin.token, invalid)).statusCode,
      400,
    );
  assert.equal(
    (await f.call("POST", path, f.admin.token, { ...body, userId: "999999" }))
      .statusCode,
    404,
  );
  const replies = await Promise.all([
    f.call("POST", path, f.admin.token, body),
    f.call("POST", path, f.admin.token, body),
  ]);
  for (const reply of replies) {
    assert.equal(reply.statusCode, 200, reply.body);
    const status = aiCreditResponseSchema.parse(reply.json());
    assert.equal(status.grantedMicros, 500 * RUB);
    assert.equal(status.availableMicros, 500 * RUB);
    assert.equal(status.history.length, 1);
    assert.equal(status.chargingStatus, "not_connected");
    assert.equal(status.topUpAvailable, false);
  }
  const attempts = await f.db.query("select * from ai_model_attempts");
  assert.equal(attempts.rows.length, 0);
  const audit = await f.db.query(
    "select * from audit_log where action='ai-credit-welcome-granted'",
  );
  assert.equal(audit.rows.length, 1);
  const control = (await f.call("GET", "/v1/admin/ai", f.admin.token)).json();
  assert.equal(control.environmentDisabled, true);
  assert.equal(control.budget.settings.enabled, false);
  assert.equal(
    (
      await f.call("GET", "/v1/ai/credit?userId=" + f.user.id, f.other.token)
    ).json().availableMicros,
    0,
  );
  assert.equal((await f.call("GET", "/v1/ai/credit")).statusCode, 401);
  const board = (
    await f.call("GET", "/v1/dashboard", f.user.token)
  ).json<Dashboard>();
  assert.equal(board.aiAccess.credit!.availableMicros, 500 * RUB);
  assert.equal(board.provider, "unconfigured");
});

test("credit holds across replicas cannot overspend and settlement/release are idempotent and ownership-bound", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.ledger.grantWelcome(f.user.id, f.admin.id);
  const replica = new AiCreditLedger(f.db),
    ids = [randomUUID(), randomUUID()];
  const results = await Promise.allSettled([
    f.ledger.hold(f.user.id, ids[0]!, 400 * RUB),
    replica.hold(f.user.id, ids[1]!, 400 * RUB),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const heldId = ids[results.findIndex((r) => r.status === "fulfilled")]!;
  await replica.hold(f.user.id, heldId, 400 * RUB);
  assert.equal((await f.ledger.status(f.user.id)).heldMicros, 400 * RUB);
  await assert.rejects(
    replica.hold(f.user.id, heldId, 1),
    /другими параметрами/,
  );
  await assert.rejects(
    replica.hold(f.other.id, randomUUID(), 1),
    /Недостаточно/,
  );
  await assert.rejects(
    replica.resolve(f.other.id, randomUUID(), heldId, {
      kind: "release",
      amountMicros: 0,
    }),
    /не найден/,
  );
  await assert.rejects(
    replica.resolve(f.user.id, randomUUID(), heldId, {
      kind: "settle",
      amountMicros: 401 * RUB,
    }),
    /превышает/,
  );
  const settledId = randomUUID();
  await replica.resolve(f.user.id, settledId, heldId, {
    kind: "settle",
    amountMicros: 100 * RUB,
  });
  await f.ledger.resolve(f.user.id, settledId, heldId, {
    kind: "settle",
    amountMicros: 100 * RUB,
  });
  await assert.rejects(
    f.ledger.resolve(f.user.id, randomUUID(), heldId, {
      kind: "release",
      amountMicros: 0,
    }),
    /уже завершён/,
  );
  const hold2 = randomUUID(),
    released = randomUUID();
  await f.ledger.hold(f.user.id, hold2, 400 * RUB);
  assert.equal((await f.ledger.status(f.user.id)).availableMicros, 0);
  await f.ledger.resolve(f.user.id, released, hold2, {
    kind: "release",
    amountMicros: 0,
  });
  await replica.resolve(f.user.id, released, hold2, {
    kind: "release",
    amountMicros: 0,
  });
  const status = await f.ledger.status(f.user.id);
  assert.equal(status.availableMicros, 400 * RUB);
  assert.equal(status.spentMicros, 100 * RUB);
  assert.equal(status.heldMicros, 0);
  assert.equal(status.history.length, 5);
});

test("the bonus never resets across date changes, migration reruns or reconstructed services", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.ledger.grantWelcome(f.user.id, f.admin.id);
  const hold = randomUUID();
  await f.ledger.hold(f.user.id, hold, 500 * RUB);
  await f.ledger.resolve(f.user.id, randomUUID(), hold, {
    kind: "settle",
    amountMicros: 500 * RUB,
  });
  // Disposable fixture only; API role cannot update these immutable entries.
  await f.db.query(
    "update ai_credit_entries set created_at=created_at-interval '2 days'",
  );
  await migrate(f.db);
  const next = new AiCreditLedger(f.db);
  await next.grantWelcome(f.user.id, f.other.id);
  const status = await next.status(f.user.id);
  assert.equal(status.availableMicros, 0);
  assert.equal(status.grantedMicros, 500 * RUB);
  await assert.rejects(next.hold(f.user.id, randomUUID(), 1), /Недостаточно/);
  assert.equal(
    (
      await f.db.query(
        "select * from audit_log where action='ai-credit-welcome-granted'",
      )
    ).rows.length,
    1,
  );
});

test("failed audit rolls back the bonus and malformed money cannot mutate the ledger", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const broken: Database = {
    ...f.db,
    transaction: (work) =>
      f.db.transaction((tx) =>
        work({
          ...tx,
          query: async (sql, params) => {
            if (sql.startsWith("insert into audit_log"))
              throw new Error("synthetic audit failure");
            return tx.query(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    new AiCreditLedger(broken).grantWelcome(f.user.id, f.admin.id),
    /synthetic audit failure/,
  );
  assert.equal((await f.ledger.status(f.user.id)).bonusGranted, false);
  assert.equal(
    (await f.db.query("select * from ai_credit_entries")).rows.length,
    0,
  );
  for (const amount of [-1, 0, 0.5, NaN, Infinity, 500 * RUB + 1])
    await assert.rejects(f.ledger.hold(f.user.id, randomUUID(), amount));
  await assert.rejects(f.ledger.hold(f.user.id, "not-an-id", 1));
  assert.equal(
    (await f.db.query("select * from ai_credit_accounts")).rows.length,
    0,
  );
});
