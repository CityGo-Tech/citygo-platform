import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { connectDatabase, migrate, Repository, DomainError } from "@citygo/db";
import { registerResultDiscussionApi } from "./result-discussion.js";
test("discussion HTTP validates empty query, repeats authentication and never returns another account source", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const owner = await new Repository(db).register(
    "discussion-api@example.test",
    "synthetic",
  );
  const other = await new Repository(db).register(
    "discussion-api-other@example.test",
    "synthetic",
  );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
      [owner],
    )
  ).rows[0]!.id;
  const id = (
    await db.query<{ id: string }>(
      "insert into messages(thread_id,role,content,metadata) values($1,'assistant','SAVED_SOURCE',$2::jsonb) returning id::text",
      [
        thread,
        JSON.stringify({
          citygoFavorite: true,
          status: "complete",
          agentKey: "support",
        }),
      ],
    )
  ).rows[0]!.id;
  const app = Fastify();
  let calls = 0,
    identity = owner,
    denySecond = false;
  registerResultDiscussionApi(app, db, async () => {
    calls++;
    if (denySecond && calls % 2 === 0) throw new DomainError(401, "Denied");
    return { id: identity };
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const path = "/v1/results/favorites/" + id + "/discussion-source";
  const result = await app.inject(path);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(calls, 2);
  assert.equal(result.json().text, "SAVED_SOURCE");
  assert.equal((await app.inject(path + "?text=secret")).statusCode, 400);
  identity = other;
  assert.equal((await app.inject(path)).statusCode, 404);
  identity = owner;
  calls = 0;
  denySecond = true;
  const denied = await app.inject(path);
  assert.equal(denied.statusCode, 401);
  assert.ok(!denied.body.includes("SAVED_SOURCE"));
});
