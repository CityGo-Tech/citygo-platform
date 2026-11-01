import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  ConversationTitles,
  DomainError,
  type Database,
} from "./index.js";
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const users = await Promise.all(
    ["owner", "other"].map((x) =>
      db.query<{ id: string }>(
        "insert into users(auth_subject)values($1)returning id::text",
        [x + randomUUID()],
      ),
    ),
  );
  const [owner, other] = users.map((v) => v.rows[0]!.id);
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,conversation_agent_key,context,status)values($1,'support','support',$2::jsonb,'closed')returning id::text",
      [owner, JSON.stringify({ marker: "preserve context" })],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into messages(thread_id,role,content)values($1,'user','Exact original question')",
    [thread],
  );
  return {
    db,
    owner: owner!,
    other: other!,
    thread,
    store: new ConversationTitles(db),
  };
}
const status = (code: number) => (e: unknown) =>
  e instanceof DomainError && e.statusCode === code;
async function stable(db: Database) {
  return (
    await db.query(
      `select jsonb_build_object('threads',(select jsonb_agg(to_jsonb(t)order by id)from agent_threads t),'messages',(select jsonb_agg(to_jsonb(t)order by id)from messages t),'users',(select jsonb_agg(to_jsonb(t)order by id)from users t),'credits',(select jsonb_agg(to_jsonb(t)order by user_id)from ai_credit_accounts t),'charges',(select jsonb_agg(to_jsonb(t)order by request_id)from ai_credit_charges t),'gifts',(select count(*)from phone_welcome_claims),'topups',(select count(*)from payment_topup_orders),'refunds',(select count(*)from payment_refunds)) as value`,
    )
  ).rows[0];
}
test("private display title set/edit/clear preserves every thread/context/message and monetary record; old rows have no fabricated title", async (t) => {
  const f = await fixture(t),
    before = await stable(f.db);
  assert.deepEqual(await f.store.get(f.owner, f.thread), {
    userId: f.owner,
    threadId: f.thread,
    title: null,
    revision: "0",
    updatedAt: null,
  });
  assert.equal(
    (await f.db.query("select * from conversation_titles")).rows.length,
    0,
  );
  const first = await f.store.update(f.owner, f.thread, {
    title: "  План жилья 🏡  ",
    expectedRevision: "0",
  });
  assert.equal(first.title, "План жилья 🏡");
  assert.equal(first.revision, "1");
  const noop = await f.store.update(f.owner, f.thread, {
    title: first.title,
    expectedRevision: "1",
  });
  assert.deepEqual(noop, first);
  const next = await f.store.update(f.owner, f.thread, {
    title: "Работа и жильё",
    expectedRevision: "1",
  });
  assert.equal(next.revision, "2");
  const list = await new Repository(f.db).conversations(f.owner);
  assert.equal(list.conversations[0]!.customTitle, "Работа и жильё");
  assert.equal(list.conversations[0]!.titleRevision, "2");
  const cleared = await f.store.update(f.owner, f.thread, {
    title: null,
    expectedRevision: "2",
  });
  assert.equal(cleared.title, null);
  assert.equal(cleared.revision, "3");
  await assert.rejects(
    f.store.update(f.owner, f.thread, {
      title: "stale",
      expectedRevision: "0",
    }),
    status(409),
  );
  assert.deepEqual(await stable(f.db), before);
  assert.equal(
    (await f.db.query("select count(*)::int as n from conversation_titles"))
      .rows[0]!.n,
    1,
  );
});
test("foreign and absent threads are uniformly missing; blocked/bootstrap owners cannot read or change display titles", async (t) => {
  const f = await fixture(t);
  await f.db.query("update users set role='super_admin'where id=$1", [f.other]);
  for (const id of [f.thread, "9223372036854775807"]) {
    await assert.rejects(f.store.get(f.other, id), status(404));
    await assert.rejects(
      f.store.update(f.other, id, { title: "forged", expectedRevision: "0" }),
      status(404),
    );
  }
  for (const field of [
    "status='blocked'",
    "status='active',must_change_password=true",
  ]) {
    await f.db.query("update users set " + field + " where id=$1", [f.owner]);
    await assert.rejects(f.store.get(f.owner, f.thread), status(403));
    await assert.rejects(
      f.store.update(f.owner, f.thread, {
        title: "forged",
        expectedRevision: "0",
      }),
      status(403),
    );
  }
  assert.equal(
    (await f.db.query("select * from conversation_titles")).rows.length,
    0,
  );
});
test("SQL guards retain title identity/revision and concurrent stale browser writes cannot overwrite", async (t) => {
  const f = await fixture(t);
  await f.store.update(f.owner, f.thread, {
    title: "Начало",
    expectedRevision: "0",
  });
  const results = await Promise.allSettled(
    ["Один", "Два"].map((title) =>
      f.store.update(f.owner, f.thread, { title, expectedRevision: "1" }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter((r) => r.status === "rejected" && status(409)(r.reason))
      .length,
    1,
  );
  for (const sql of [
    "update conversation_titles set user_id=" + f.other,
    "update conversation_titles set revision=revision+2",
    "update conversation_titles set title='forged'",
    "delete from conversation_titles",
  ]) {
    await assert.rejects(f.db.exec(sql));
  }
  const actual = await f.store.get(f.owner, f.thread);
  assert.equal(actual.revision, "2");
  assert.ok(["Один", "Два"].includes(actual.title!));
  await assert.rejects(
    f.db.query(
      "insert into conversation_titles(thread_id,user_id,title) values($1,$2,'forged')",
      [f.thread, f.other],
    ),
  );
});
