import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  connectDatabase,
  migrate,
  Repository,
  PersonalPlan,
  PlanChecklists,
  readResultDiscussionSource,
  DomainError,
} from "./index.js";
test("discussion reads exact owner source, live revision and complete checklist without money or chat writes", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const owner = await new Repository(db).register(
    "discussion-owner@example.test",
    "synthetic",
  );
  const other = await new Repository(db).register(
    "discussion-other@example.test",
    "synthetic",
  );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
      [owner],
    )
  ).rows[0]!.id;
  const message = (
    await db.query<{ id: string }>(
      "insert into messages(thread_id,role,content,metadata) values($1,'assistant',$2,$3::jsonb) returning id::text",
      [
        thread,
        "ТОЧНЫЙ_ТЕКСТ 🧳",
        JSON.stringify({
          citygoFavorite: true,
          status: "interrupted",
          agentKey: "support",
        }),
      ],
    )
  ).rows[0]!.id;
  const plan = new PersonalPlan(db);
  const item = (
    await plan.create(owner, {
      operationId: randomUUID(),
      sourceMessageId: message,
      title: "План",
      details: "Полные подробности",
    })
  ).item;
  await new PlanChecklists(db).save(owner, item.id, {
    expectedRevision: item.revision,
    entries: [
      {
        id: randomUUID(),
        title: "Пункт",
        details: "Точные детали",
        completed: true,
      },
    ],
  });
  const before = (
    await db.query(
      "select (select count(*) from messages) as messages,(select count(*) from ai_credit_entries) as money",
    )
  ).rows;
  const saved = await readResultDiscussionSource(db, owner, {
    kind: "plan",
    id: item.id,
  });
  assert.equal(saved.revision, 2);
  assert.equal(
    saved.text,
    "План\n\nПолные подробности\n\nЧеклист:\n[x] Пункт\nТочные детали",
  );
  const favorite = await readResultDiscussionSource(db, owner, {
    kind: "favorites",
    id: message,
  });
  assert.equal(favorite.text, "ТОЧНЫЙ_ТЕКСТ 🧳");
  assert.equal(favorite.interrupted, true);
  for (const kind of ["plan", "favorites"] as const)
    await assert.rejects(
      readResultDiscussionSource(db, other, {
        kind,
        id: kind === "plan" ? item.id : message,
      }),
      (e) => e instanceof DomainError && e.statusCode === 404,
    );
  assert.deepEqual(
    (
      await db.query(
        "select (select count(*) from messages) as messages,(select count(*) from ai_credit_entries) as money",
      )
    ).rows,
    before,
  );
  await db.query(
    "update messages set metadata=metadata-'citygoFavorite' where id=$1",
    [message],
  );
  await assert.rejects(
    readResultDiscussionSource(db, owner, { kind: "favorites", id: message }),
    (e) => e instanceof DomainError && e.statusCode === 404,
  );
  await plan.remove(owner, item.id, 2);
  await assert.rejects(
    readResultDiscussionSource(db, owner, { kind: "plan", id: item.id }),
    (e) => e instanceof DomainError && e.statusCode === 404,
  );
  await db.query("update users set status='blocked' where id=$1", [owner]);
  await assert.rejects(
    readResultDiscussionSource(db, owner, { kind: "favorites", id: message }),
    (e) => e instanceof DomainError && e.statusCode === 403,
  );
});
