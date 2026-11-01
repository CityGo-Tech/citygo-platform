import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
  type Sql,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  conversationExportSchema,
} from "@citygo/contracts";
import type { StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  let providerCalls = 0,
    revokeAfterRead = false,
    exportRead = false;
  let revoke = async () => {};
  const observe = (tx: Sql): Sql => ({
    ...tx,
    query: (sql, values) => {
      if (sql.startsWith("with visible as materialized")) exportRead = true;
      return tx.query(sql, values);
    },
  });
  const observed: Database = {
    ...db,
    transaction: async (work) => {
      const result = await db.transaction((tx) => work(observe(tx)));
      if (exportRead && revokeAfterRead) {
        revokeAfterRead = false;
        await revoke();
      }
      return result;
    },
  };
  const provider: StreamingProvider = {
    name: "routerai",
    model: "synthetic/export",
    async *stream() {
      providerCalls++;
      yield { type: "delta", text: "Not expected" };
    },
  };
  const app = await buildApp({
    db: observed,
    provider,
    testing: true,
    config: readConfig({
      NODE_ENV: "test",
      DATABASE_URL: "pglite://:memory:",
      WEB_ORIGIN: "http://localhost:3000",
      LLM_PROVIDER: "disabled",
      YOOKASSA_MODE: "disabled",
      EMAIL_REGISTRATION_MODE: "disabled",
      PHONE_VERIFICATION_MODE: "disabled",
      AI_CREDIT_MODE: "routerai_citygo_10x",
      AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
    }),
  });
  t.after(async () => {
    try {
      await app.close();
    } finally {
      await db.close();
    }
  });
  const repo = new Repository(db);
  const owner = await registerSyntheticConsentingUser(
      db,
      "export-owner@example.test",
      "synthetic",
      app,
    ),
    other = await registerSyntheticConsentingUser(
      db,
      "export-admin@example.test",
      "synthetic",
      app,
    );
  await db.query("update users set role='super_admin' where id=$1", [other]);
  const token = randomUUID(),
    adminToken = randomUUID();
  await repo.createSession(owner, tokenHash(token));
  await repo.createSession(other, tokenHash(adminToken));
  revoke = async () => {
    await db.query("delete from sessions where token_hash=$1", [
      tokenHash(token),
    ]);
  };
  const id = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,status)values($1,'support','closed')returning id::text",
      [owner],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into messages(id,thread_id,role,content,metadata)overriding system value values(9007199254740993,$1,'user','OLD_PRIVATE_QUESTION',$2::jsonb),(9007199254740994,$1,'assistant','FULL_PRIVATE_ANSWER',$3::jsonb)",
    [
      id,
      JSON.stringify({ agentKey: "support", status: "complete" }),
      JSON.stringify({ agentKey: "support", status: "interrupted" }),
    ],
  );
  const call = (
    path = "/v1/conversations/" + id + "/export",
    credential: string = token,
    cookie = false,
    version = "1",
  ) =>
    app.inject({
      method: "GET",
      url: path,
      headers: {
        [CONTRACT_VERSION_HEADER]: version,
        ...(cookie
          ? { cookie: "citygo=" + credential, origin: "http://localhost:3000" }
          : {
              "x-citygo-client": "native",
              ...(credential ? { authorization: "Bearer " + credential } : {}),
            }),
      },
    });
  return {
    db,
    app,
    id,
    owner,
    other,
    token,
    adminToken,
    call,
    get providerCalls() {
      return providerCalls;
    },
    revokeDuringRead: () => {
      revokeAfterRead = true;
      exportRead = false;
    },
  };
}
test("authenticated cookie/native whole export has no-store, exact saved contents/statuses and no model or financial changes", async (t) => {
  const f = await fixture(t);
  const before = (
    await f.db.query(
      "select to_jsonb(m)::text as row from messages m order by id",
    )
  ).rows;
  for (const cookie of [false, true]) {
    const response = await f.call(undefined, undefined, cookie);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const value = conversationExportSchema.parse(response.json());
    assert.equal(value.userId, f.owner);
    assert.equal(value.thread.id, f.id);
    assert.equal(value.thread.closed, true);
    assert.deepEqual(
      value.messages.map((m) => m.id),
      ["9007199254740993", "9007199254740994"],
    );
    assert.equal(value.messages[1]!.status, "interrupted");
    assert.equal(value.messages[1]!.content, "FULL_PRIVATE_ANSWER");
  }
  assert.deepEqual(
    (
      await f.db.query(
        "select to_jsonb(m)::text as row from messages m order by id",
      )
    ).rows,
    before,
  );
  assert.equal(f.providerCalls, 0);
  for (const table of [
    "ai_credit_entries",
    "payment_topup_orders",
    "payment_refund_events",
    "gigachat_request_fees",
  ])
    assert.equal(
      (
        await f.db.query<{ n: string }>(
          `select count(*)::text as n from ${table}`,
        )
      ).rows[0]!.n,
      "0",
    );
});
test("anonymous, cross-owner super admin, bad query/ID, blocked and bootstrap accounts cannot obtain export text", async (t) => {
  const f = await fixture(t),
    path = "/v1/conversations/" + f.id + "/export";
  assert.equal((await f.call(path, "")).statusCode, 401);
  const denied = await f.call(path, f.adminToken);
  assert.equal(denied.statusCode, 404);
  assert(!denied.body.includes("PRIVATE"));
  for (const suffix of ["?before=1", "?userId=" + f.owner, "?search=PRIVATE"]) {
    const r = await f.call(path + suffix);
    assert.equal(r.statusCode, 400);
    assert(!r.body.includes("PRIVATE"));
  }
  assert.equal((await f.call("/v1/conversations/01/export")).statusCode, 400);
  assert.equal((await f.call(path, f.token, false, "0")).statusCode, 400);
  await f.db.query("update users set status='blocked' where id=$1", [f.owner]);
  assert.equal((await f.call()).statusCode, 401);
  await f.db.query(
    "update users set status='active',must_change_password=true where id=$1",
    [f.owner],
  );
  assert.equal((await f.call()).statusCode, 403);
  assert.equal(f.providerCalls, 0);
});
test("a session revoked after the snapshot is checked again before private text is returned", async (t) => {
  const f = await fixture(t);
  f.revokeDuringRead();
  const response = await f.call();
  assert.equal(response.statusCode, 401);
  assert(!response.body.includes("PRIVATE"));
  assert.equal(f.providerCalls, 0);
});
test("oversized export returns explicit413 without partial text", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "insert into messages(thread_id,role,content)select $1,'user','PRIVATE_LIMIT' from generate_series(1,5001)",
    [f.id],
  );
  const response = await f.call();
  assert.equal(response.statusCode, 413);
  assert.equal(response.headers["cache-control"], "no-store");
  assert(!response.body.includes("PRIVATE_LIMIT"));
  assert(!response.body.includes("messages"));
  assert.equal(f.providerCalls, 0);
});
