import assert from "node:assert/strict";
import test from "node:test";
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

test("owner status CAS retains replies, reads, identity and money; administrator has no owner-route bypass", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    store = new HumanSupportRequests(db);
  async function user(email: string, role = "user") {
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
  }
  const owner = await user("support-owner-change@example.test"),
    admin = await user("support-owner-admin@example.test", "admin");
  const request = (
    await store.create(owner, {
      operationId: randomUUID(),
      body: "Помогите выбрать первый шаг моего переезда.",
    })
  ).request;
  const reply = await store.reply(admin, request.id, {
    operationId: randomUUID(),
    expectedRevision: 1,
    body: "Начните с ваших приоритетов.",
  });
  const count = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "messages",
          "chat_requests",
          "ai_credit_accounts",
          "ai_credit_entries",
          "payment_topup_orders",
          "payment_refunds",
          "phone_welcome_claims",
        ].map(async (table) => [
          table,
          (await db.query(`select * from ${table} order by 1`)).rows,
        ]),
      ),
    );
  const before = await count(),
    replies = await store.replies(owner, request.id),
    updates = await store.updates(owner);
  const status = (n: number) => (e: unknown) =>
    e instanceof DomainError && e.statusCode === n;
  await assert.rejects(
    store.setOwnStatus(admin, request.id, {
      expectedRevision: 2,
      status: "closed",
    }),
    status(404),
  );
  await assert.rejects(
    store.setOwnStatus(owner, "9223372036854775807", {
      expectedRevision: 2,
      status: "closed",
    }),
    status(404),
  );
  await assert.rejects(
    store.setOwnStatus(owner, request.id, {
      expectedRevision: 1,
      status: "closed",
    }),
    status(409),
  );
  const closed = await store.setOwnStatus(owner, request.id, {
    expectedRevision: 2,
    status: "closed",
  });
  assert.equal(closed.userId, owner.userId);
  assert.equal(closed.request.revision, 3);
  assert.equal(closed.request.status, "closed");
  assert.ok(closed.request.closedAt);
  assert.equal(closed.request.body, request.body);
  assert.equal(closed.request.createdAt, request.createdAt);
  assert.equal(closed.request.operationId, request.operationId);
  assert.equal(
    (closed.request as unknown as Record<string, unknown>).owner,
    undefined,
  );
  await assert.rejects(
    store.setOwnStatus(owner, request.id, {
      expectedRevision: 2,
      status: "closed",
    }),
    status(409),
  );
  assert.deepEqual(
    await store.setOwnStatus(owner, request.id, {
      expectedRevision: 3,
      status: "closed",
    }),
    closed,
  );
  assert.deepEqual((await store.list(owner, { status: "closed" })).requests, [
    closed.request,
  ]);
  assert.deepEqual((await store.list(owner, { status: "open" })).requests, []);
  const opened = await store.setOwnStatus(owner, request.id, {
    expectedRevision: 3,
    status: "open",
  });
  assert.equal(opened.request.revision, 4);
  assert.equal(opened.request.closedAt, null);
  assert.deepEqual(await store.replies(owner, request.id), replies);
  assert.deepEqual(await store.updates(owner), updates);
  assert.deepEqual(await count(), before);
  assert.equal(
    (await store.replies(owner, request.id)).replies[0]?.id,
    reply.reply.id,
  );
  const audit = (
    await db.query(
      "select payload from audit_log where action='human-support-owner-status-changed' order by id",
    )
  ).rows;
  assert.equal(audit.length, 2);
  assert.doesNotMatch(JSON.stringify(audit), /Помогите|приоритетов|example/);
  await db.query("update users set must_change_password=true where id=$1", [
    owner.userId,
  ]);
  await assert.rejects(
    store.setOwnStatus(owner, request.id, {
      expectedRevision: 4,
      status: "closed",
    }),
    status(403),
  );
  await db.query(
    "update users set must_change_password=false,status='blocked' where id=$1",
    [owner.userId],
  );
  await assert.rejects(
    store.setOwnStatus(owner, request.id, {
      expectedRevision: 4,
      status: "closed",
    }),
    status(401),
  );
  assert.deepEqual(await count(), before);
});
