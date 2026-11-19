import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { connectDatabase } from "@citygo/db";
import { registerMiniAppFunnel } from "./mini-app-funnel.js";

test("mini funnel accepts only anonymous gestures and stores bare event names", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await db.exec(
    "create table analytics_events (name text not null, user_id bigint, created_at timestamptz default now())",
  );
  const app = Fastify();
  t.after(() => app.close());
  const record = registerMiniAppFunnel(app, db);
  const url = "/v1/mini-apps/telegram/funnel";
  const post = (
    payload: object,
    target = url,
    headers?: Record<string, string>,
  ) => app.inject({ method: "POST", url: target, payload, headers });

  assert.equal((await post({ event: "launch" })).statusCode, 204);
  assert.equal(
    (await post({ event: "task_selected" }, "/v1/mini-apps/max/funnel"))
      .statusCode,
    204,
  );
  for (const event of [
    "sign_in_confirmed",
    "step_saved",
    "answer_succeeded",
    "payment_confirmed",
    "unknown",
  ])
    assert.equal((await post({ event })).statusCode, 400);
  assert.equal(
    (await post({ event: "launch", initData: "private-canary" })).statusCode,
    400,
  );
  assert.equal(
    (await post({ event: "launch" }, url + "?contact=private-canary"))
      .statusCode,
    400,
  );
  assert.equal(
    (await post({ event: "launch" }, "/v1/mini-apps/web/funnel")).statusCode,
    400,
  );
  assert.equal(
    (await post({ event: "launch" }, url, { "sec-gpc": "1" })).statusCode,
    204,
  );
  await record("telegram", "sign_in_confirmed");
  await record("max", "step_saved");
  await record("telegram", "answer_succeeded");
  await record("max", "payment_confirmed");
  await record(null, "answer_succeeded");
  assert.deepEqual(
    (await db.query("select name,user_id from analytics_events order by name"))
      .rows,
    [
      { name: "mini_max_payment_confirmed", user_id: null },
      { name: "mini_max_step_saved", user_id: null },
      { name: "mini_max_task_selected", user_id: null },
      { name: "mini_telegram_answer_succeeded", user_id: null },
      { name: "mini_telegram_launch", user_id: null },
      { name: "mini_telegram_sign_in_confirmed", user_id: null },
    ],
  );
});
