import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import {
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
  HumanSupportRequests,
} from "./index.js";
import { serviceConsentPolicy } from "@citygo/contracts";

test("read-cursor upgrade preserves historical support, money and consent without inventing read evidence", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await db.exec(
    "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith(".sql") && n < "0042_")
    .sort()) {
    const source = await readFile(new URL(name, directory), "utf8");
    await db.exec(source);
    await db.query(
      "insert into citygo_migrations(name,checksum) values($1,$2)",
      [
        name,
        createHash("sha256")
          .update(source.replaceAll("\r\n", "\n"))
          .digest("hex"),
      ],
    );
  }
  const repo = new Repository(db),
    store = new HumanSupportRequests(db);
  const make = async (email: string, role: string) => {
    const userId = await repo.register(email, "synthetic"),
      sessionTokenHash = createHash("sha256")
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
  const owner = await make("upgrade-support@example.test", "user"),
    admin = await make("upgrade-support-admin@example.test", "admin");
  const request = await store.create(owner, {
    operationId: randomUUID(),
    body: "Старое обращение до добавления учёта чтения.",
  });
  const reply = await store.reply(admin, request.request.id, {
    operationId: randomUUID(),
    expectedRevision: 1,
    body: "Старый ответ остаётся доступен после обновления.",
  });
  const protectedTables = [
    "human_support_requests",
    "human_support_replies",
    "ai_credit_entries",
    "payment_topup_orders",
    "service_consent_events",
  ];
  const before = await Promise.all(
    protectedTables.map(
      async (table) =>
        (await db.query(`select * from ${table} order by 1`)).rows,
    ),
  );
  await migrate(db);
  await migrate(db);
  for (const [i, table] of protectedTables.entries())
    assert.deepEqual(
      (await db.query(`select * from ${table} order by 1`)).rows,
      before[i],
      table,
    );
  assert.equal(
    (await db.query("select * from human_support_reads")).rows.length,
    0,
  );
  const summary = await store.updates(owner);
  assert.equal(summary.unreadReplies, 1);
  assert.equal(summary.requests[0]!.lastReplyId, reply.reply.id);
  await store.markRead(owner, request.request.id, {
    throughReplyId: reply.reply.id,
  });
  assert.equal((await store.updates(owner)).unreadReplies, 0);
});
