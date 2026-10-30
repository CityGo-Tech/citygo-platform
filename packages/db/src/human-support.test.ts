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
