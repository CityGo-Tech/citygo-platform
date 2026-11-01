import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
  HumanSupportRequests,
  DomainError,
} from "./index.js";
import { serviceConsentPolicy } from "@citygo/contracts";

async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    store = new HumanSupportRequests(db);
  const user = async (email: string, role = "user") => {
    const userId = await repo.register(email, "synthetic");
    const sessionTokenHash = createHash("sha256")
      .update(randomUUID())
      .digest("hex");
    await repo.createSession(userId, sessionTokenHash);
    await new ServiceConsents(db).choose(userId, {
      policyVersion: serviceConsentPolicy.version,
      personalData: true,
      marketing: false,
    });
    await db.query("update users set role=$2 where id=$1", [userId, role]);
    return { userId, sessionTokenHash };
  };
  return {
    db,
    store,
    owner: await user("owner@example.test"),
    other: await user("other@example.test"),
    admin: await user("admin@example.test", "admin"),
  };
}
const command = () => ({
  operationId: randomUUID(),
  body: "Помогите выбрать первый шаг для моего переезда.",
});
const status = (n: number) => (e: unknown) =>
  e instanceof DomainError && e.statusCode === n;
test("human replies are append-only, owner-private, exact-replayed and revision-bound without money or model writes", async (t) => {
  const f = await fixture(t),
    request = (await f.store.create(f.owner, command())).request;
  const input = {
    operationId: randomUUID(),
    expectedRevision: request.revision,
    body: "Начните со списка важных для вас районов. 😀",
  };
  await assert.rejects(f.store.reply(f.owner, request.id, input), status(403));
  const reply = await f.store.reply(f.admin, request.id, input);
  assert.equal(reply.request.revision, 2);
  assert.equal(reply.reply.body, input.body);
  assert.deepEqual(await f.store.reply(f.admin, request.id, input), reply);
  await assert.rejects(
    f.store.reply(f.admin, request.id, { ...input, body: "Другой текст" }),
    status(409),
  );
  await assert.rejects(
    f.store.reply(f.admin, request.id, { ...input, operationId: randomUUID() }),
    status(409),
  );
  assert.deepEqual((await f.store.replies(f.owner, request.id)).replies, [
    reply.reply,
  ]);
  await assert.rejects(f.store.replies(f.other, request.id), status(404));
  await f.store.setStatus(f.admin, request.id, {
    expectedRevision: 2,
    status: "closed",
  });
  assert.equal(
    (await f.store.reply(f.admin, request.id, input)).reply.id,
    reply.reply.id,
  );
  await assert.rejects(
    f.store.reply(f.admin, request.id, {
      ...input,
      expectedRevision: 3,
      operationId: randomUUID(),
    }),
    status(409),
  );
  await assert.rejects(
    f.db.query("update human_support_replies set body=body where id=$1", [
      reply.reply.id,
    ]),
  );
  await assert.rejects(
    f.db.query("delete from human_support_replies where id=$1", [
      reply.reply.id,
    ]),
  );
  const audit = JSON.stringify(
    (
      await f.db.query(
        "select payload from audit_log where action='human-support-replied'",
      )
    ).rows,
  );
  assert.doesNotMatch(audit, /Начните|районов/);
  for (const table of [
    "messages",
    "chat_requests",
    "payment_topup_orders",
    "ai_credit_entries",
  ])
    assert.equal((await f.db.query(`select * from ${table}`)).rows.length, 0);
  await f.db.query("update users set role='user' where id=$1", [
    f.admin.userId,
  ]);
  await assert.rejects(f.store.reply(f.admin, request.id, input), status(403));
});
test("astral support text survives storage exactly and invalid point count/NUL is rejected before insert", async (t) => {
  const f = await fixture(t);
  const value = "😀".repeat(20),
    created = await f.store.create(f.owner, { ...command(), body: value });
  assert.equal(created.request.body, value);
  assert.deepEqual(
    (
      await f.db.query(
        "select char_length(body) as points from human_support_requests",
      )
    ).rows,
    [{ points: 20 }],
  );
  for (const body of ["😀".repeat(10), "a".repeat(20) + "\0"])
    await assert.rejects(f.store.create(f.owner, { ...command(), body }));
  assert.equal(
    (await f.db.query("select * from human_support_requests")).rows.length,
    1,
  );
});
test("support accepts the actual extended consent snapshot and refuses an account without personal-data evidence", async (t) => {
  const f = await fixture(t);
  const policy = {
    id: createHash("sha256").update("synthetic-support-policy").digest("hex"),
    version: "synthetic-v1",
    provider: "routerai" as const,
    model: "synthetic/no-network",
    recipient: "Synthetic recipient",
    routing: "Synthetic routing",
    data: "Synthetic context",
  };
  await f.db.query(
    "insert into ai_routing(id,provider,policy_id,revision) values(1,'routerai',$1,1) on conflict(id) do update set provider='routerai',policy_id=$1,revision=ai_routing.revision+1",
    [policy.id],
  );
  const consents = new ServiceConsents(f.db, () => policy),
    current = await consents.policy();
  await consents.choose(f.owner.userId, {
    policyVersion: current.version,
    personalData: true,
    marketing: false,
  });
  await f.store.create(f.owner, command());
  const repo = new Repository(f.db),
    userId = await repo.register("without-proof@example.test", "synthetic"),
    sessionTokenHash = createHash("sha256").update(randomUUID()).digest("hex");
  await repo.createSession(userId, sessionTokenHash);
  await assert.rejects(f.store.list({ userId, sessionTokenHash }), status(403));
});
test("support receipt replays exact body, isolates owners and retains truthful CAS status without model or money writes", async (t) => {
  const f = await fixture(t),
    input = command();
  await f.db.query(
    "select setval('human_support_requests_id_seq',9007199254740992,true)",
  );
  const a = await f.store.create(f.owner, input),
    b = await f.store.create(f.owner, input);
  assert.deepEqual(b, a);
  assert.equal(a.request.id, "9007199254740993");
  await assert.rejects(
    f.store.create(f.owner, { ...input, body: input.body + " Другой вопрос." }),
    status(409),
  );
  assert.equal((await f.store.list(f.other)).requests.length, 0);
  await assert.rejects(f.store.list(f.owner, {}, true), status(403));
  const inbox = await f.store.list(f.admin, {}, true);
  assert.equal(inbox.requests.length, 1);
  const detail = await f.store.detail(f.admin, a.request.id);
  assert.equal(
    (detail.request as { owner?: { userId: string } }).owner?.userId,
    f.owner.userId,
  );
  const closed = await f.store.setStatus(f.admin, a.request.id, {
    expectedRevision: 1,
    status: "closed",
  });
  assert.equal(closed.request.status, "closed");
  assert.equal(closed.request.revision, 2);
  assert.equal(closed.request.closedAt, closed.request.updatedAt);
  await assert.rejects(
    f.store.setStatus(f.admin, a.request.id, {
      expectedRevision: 1,
      status: "open",
    }),
    status(409),
  );
  assert.equal((await f.store.create(f.owner, input)).request.status, "closed");
  assert.equal(
    (await f.store.list(f.owner, { status: "open" })).requests.length,
    0,
  );
  for (const table of [
    "messages",
    "chat_requests",
    "ai_credit_entries",
    "payment_topup_orders",
    "agent_threads",
  ])
    assert.equal(
      (await f.db.query(`select * from ${table}`)).rows.length,
      0,
      table,
    );
  const audit = (
    await f.db.query(
      "select payload from audit_log where action like 'human-support-%'",
    )
  ).rows;
  assert.ok(audit.length >= 4);
  assert.doesNotMatch(
    JSON.stringify(audit),
    /Помогите|example\.test|sessionToken/,
  );
  await assert.rejects(
    f.db.query(
      "update human_support_requests set body='Подмена сохранённого вопроса',revision=revision+1 where id=$1",
      [a.request.id],
    ),
  );
});
test("support rechecks password, active account, latest service consent, session and admin role", async (t) => {
  const f = await fixture(t),
    a = await f.store.create(f.owner, command());
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.owner.userId,
  ]);
  await assert.rejects(f.store.list(f.owner), status(403));
  await f.db.query("update users set must_change_password=false where id=$1", [
    f.owner.userId,
  ]);
  await f.db.query("update users set role='user' where id=$1", [
    f.admin.userId,
  ]);
  await assert.rejects(f.store.detail(f.admin, a.request.id), status(403));
  await f.db.query("delete from sessions where user_id=$1", [f.owner.userId]);
  await assert.rejects(f.store.create(f.owner, command()), status(401));
  await f.db.query("update users set status='blocked' where id=$1", [
    f.other.userId,
  ]);
  await assert.rejects(f.store.list(f.other), status(401));
});
test("support pagination and status filtering apply before exact bigint cursors", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 22; i++) await f.store.create(f.owner, command());
  const first = await f.store.list(f.owner);
  assert.equal(first.requests.length, 20);
  assert.ok(first.nextBefore);
  const next = await f.store.list(f.owner, { before: first.nextBefore! });
  assert.equal(next.requests.length, 2);
  assert.equal(next.nextBefore, null);
  assert.ok(BigInt(next.requests[0]!.id) < BigInt(first.nextBefore!));
});

test("read evidence is explicit, owner/request scoped, monotonic and does not include later replies", async (t) => {
  const f = await fixture(t);
  const one = (await f.store.create(f.owner, command())).request;
  const two = (await f.store.create(f.owner, command())).request;
  const foreign = (await f.store.create(f.other, command())).request;
  const reply = async (id: string, revision: number) =>
    (
      await f.store.reply(f.admin, id, {
        operationId: randomUUID(),
        expectedRevision: revision,
        body: "Ответ владельца без внешней отправки.",
      })
    ).reply;
  const first = await reply(one.id, 1),
    second = await reply(one.id, 2),
    other = await reply(two.id, 1),
    foreignReply = await reply(foreign.id, 1);
  const summary = await f.store.updates(f.owner);
  assert.equal(summary.unreadRequests, 2);
  assert.equal(summary.unreadReplies, 3);
  assert.deepEqual(
    summary.requests.map((r) => r.requestId),
    [two.id, one.id],
  );
  assert.equal((await f.store.updates(f.other)).unreadReplies, 1);
  await f.store.list(f.owner);
  await f.store.replies(f.owner, one.id);
  await f.store.detail(f.owner, one.id, false);
  assert.equal(
    (await f.db.query("select * from human_support_reads")).rows.length,
    0,
  );
  await assert.rejects(f.store.detail(f.other, one.id, false), status(404));
  for (const throughReplyId of [other.id, foreignReply.id, "9007199254740993"])
    await assert.rejects(
      f.store.markRead(f.owner, one.id, { throughReplyId }),
      status(404),
    );
  await assert.rejects(
    f.store.markRead(f.other, one.id, { throughReplyId: first.id }),
    status(404),
  );
  const marked = await f.store.markRead(f.owner, one.id, {
    throughReplyId: second.id,
  });
  assert.equal(marked.unreadReplies, 0);
  const evidence = (
    await f.db.query("select * from human_support_reads where request_id=$1", [
      one.id,
    ])
  ).rows;
  const replay = await f.store.markRead(f.owner, one.id, {
    throughReplyId: first.id,
  });
  assert.equal(replay.throughReplyId, second.id);
  assert.deepEqual(
    (
      await f.db.query(
        "select * from human_support_reads where request_id=$1",
        [one.id],
      )
    ).rows,
    evidence,
  );
  const late = await reply(one.id, 3);
  assert.equal(
    (await f.store.markRead(f.owner, one.id, { throughReplyId: second.id }))
      .unreadReplies,
    1,
  );
  assert.deepEqual(
    (await f.store.updates(f.owner)).requests.find(
      (r) => r.requestId === one.id,
    ),
    { requestId: one.id, lastReplyId: late.id, unreadReplies: 1 },
  );
  for (const [sql, args] of [
    [
      "update human_support_reads set through_reply_id=$2 where request_id=$1",
      [one.id, first.id],
    ],
    [
      "update human_support_reads set user_id=$2 where request_id=$1",
      [one.id, f.other.userId],
    ],
    [
      "update human_support_reads set through_reply_id=$2 where request_id=$1",
      [one.id, other.id],
    ],
    ["delete from human_support_reads where request_id=$1", [one.id]],
  ] as [string, string[]][])
    await assert.rejects(f.db.query(sql, args), { code: "23514" });
  assert.equal(
    (await f.store.updates(f.owner, { before: one.id })).unreadReplies,
    2,
  );
  assert.deepEqual(
    (await f.store.updates(f.owner, { before: one.id })).requests,
    [],
  );
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.owner.userId,
  ]);
  await assert.rejects(
    f.store.markRead(f.owner, one.id, { throughReplyId: late.id }),
    status(403),
  );
  await f.db.query(
    "update users set must_change_password=false,status='blocked' where id=$1",
    [f.owner.userId],
  );
  await assert.rejects(f.store.updates(f.owner), status(401));
  assert.deepEqual(
    (
      await f.db.query(
        "select * from human_support_reads where request_id=$1",
        [one.id],
      )
    ).rows,
    evidence,
  );
});
test("unread totals stay global across bigint keyset pages and seen requests leave only the unread page", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "select setval('human_support_requests_id_seq',9007199254740992,true)",
  );
  const ids: string[] = [];
  for (let i = 0; i < 21; i++) {
    const r = (await f.store.create(f.owner, command())).request;
    const p = await f.store.reply(f.admin, r.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      body: "Ответ поддержки",
    });
    ids.push(r.id);
    if (i === 0)
      assert.equal(
        (await f.store.markRead(f.owner, r.id, { throughReplyId: p.reply.id }))
          .unreadReplies,
        0,
      );
  }
  const page = await f.store.updates(f.owner);
  assert.equal(page.requests.length, 20);
  assert.equal(page.nextBefore, null);
  assert.equal(page.unreadRequests, 20);
  assert.equal(page.unreadReplies, 20);
  const extra = (await f.store.create(f.owner, command())).request;
  await f.store.reply(f.admin, extra.id, {
    operationId: randomUUID(),
    expectedRevision: 1,
    body: "Новый ответ",
  });
  const first = await f.store.updates(f.owner),
    next = await f.store.updates(f.owner, { before: first.nextBefore! });
  assert.equal(first.requests.length, 20);
  assert.equal(next.requests.length, 1);
  assert.equal(next.unreadReplies, 21);
  assert.equal(next.requests[0]!.requestId, ids[1]);
  assert.equal(
    new Set([...first.requests, ...next.requests].map((r) => r.requestId)).size,
    21,
  );
});
