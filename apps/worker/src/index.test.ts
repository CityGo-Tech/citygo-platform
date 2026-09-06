import test from "node:test";
import assert from "node:assert/strict";
import { connectDatabase, migrate } from "@citygo/db";
import { maintain } from "./index.js";
test("maintenance is idempotent and keeps live sessions", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const user = (
    await db.query<{ id: string }>(
      "insert into users(auth_subject) values ('worker-test') returning id::text",
    )
  ).rows[0]!;
  await db.query(
    "insert into sessions(token_hash,user_id,expires_at) values ('expired',$1,now()-interval '1 day'),('active',$1,now()+interval '1 day')",
    [user.id],
  );
  await maintain(db);
  await maintain(db);
  assert.deepEqual((await db.query("select token_hash from sessions")).rows, [
    { token_hash: "active" },
  ]);
});
