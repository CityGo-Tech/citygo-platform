import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import type { AiPolicy } from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
  buildServiceConsentPolicy,
  type Database,
} from "./index.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const a: AiPolicy = {
  id: hash("synthetic-routing-a"),
  version: "synthetic-v1",
  provider: "routerai",
  model: "synthetic/model",
  recipient: "Synthetic recipient",
  routing: "Synthetic routing",
  data: "Synthetic context",
};
const b = {
  ...a,
  id: hash("synthetic-routing-b"),
  data: "Changed synthetic context",
};
const resolver = (routing: { policyId: string | null }) =>
  [a, b].find((policy) => policy.id === routing.policyId) ?? null;
const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires opt-in disposable PostgreSQL; PGlite is not concurrency evidence",
  timeout: 60000,
};
async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base);
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.ok(
    ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
      (url.port === "55438" && url.pathname === "/citygo_synthetic"),
  );
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  const name = "cg_service_ai_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_service_ai_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base);
  const cleanup: { db?: Database } = {};
  let created = false;
  t.after(async () => {
    try {
      await cleanup.db?.close();
      if (created) await admin.query(`drop database "${name}"`);
    } finally {
      await admin.close();
    }
  });
  await admin.query(`create database "${name}" template template0`);
  created = true;
  url.pathname = "/" + name;
  const db = await connectDatabase(url.toString());
  cleanup.db = db;
  await migrate(db);
  await db.query(
    "insert into ai_routing(id,provider,policy_id,revision) values(1,'routerai',$1,1)",
    [a.id],
  );
  return db;
}
function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function tagged(db: Database, tag: string): Database {
  return {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('application_name',$1,true)", [tag]);
        return work(tx);
      }),
  };
}
async function within<T>(value: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic PostgreSQL barrier timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function blocked(db: Database, waiter: string, holder: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = (
      await db.query<{ blocked: boolean }>(
        `select exists(select 1 from pg_stat_activity w join pg_stat_activity h
       on h.pid=any(pg_blocking_pids(w.pid)) where w.application_name=$1 and h.application_name=$2
       and w.wait_event_type='Lock' and w.pid<>h.pid) as blocked`,
        [waiter, holder],
      )
    ).rows[0]!;
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    "Independent PostgreSQL backend did not wait on the routing lock",
  );
}
test(
  "PostgreSQL routing switch wins before an old registration choice: admission really waits then grants nothing",
  pgOnly,
  async (t) => {
    const db = await fixture(t);
    const userId = await new Repository(db).register(
      "synthetic@example.test",
      "synthetic-hash",
    );
    const prefix = "cg_service_" + randomUUID().replaceAll("-", "");
    const held = signal(),
      release = signal();
    const writer = tagged(db, prefix + "_writer").transaction(async (tx) => {
      await tx.query("select id from ai_routing where id=1 for update");
      await tx.query(
        "update ai_routing set policy_id=$1,revision=revision+1 where id=1",
        [b.id],
      );
      held.open();
      await release.promise;
    });
    void writer.catch(() => {});
    let admission: Promise<unknown> | undefined;
    try {
      await within(held.promise);
      admission = new ServiceConsents(
        tagged(db, prefix + "_reader"),
        resolver,
      ).choose(userId, {
        policyVersion: buildServiceConsentPolicy(a).version,
        personalData: true,
        marketing: false,
      });
      void admission.catch(() => {});
      await blocked(db, prefix + "_reader", prefix + "_writer");
    } finally {
      release.open();
      await Promise.allSettled([writer, ...(admission ? [admission] : [])]);
    }
    await writer;
    assert.ok(admission);
    await assert.rejects(
      admission,
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "SERVICE_CONSENT_POLICY_CHANGED",
    );
    for (const table of [
      "ai_consents",
      "consent_events",
      "service_consent_events",
    ])
      assert.deepEqual((await db.query("select * from " + table)).rows, []);
    assert.equal(
      (await new ServiceConsents(db, resolver).state(userId))
        .serviceConsentRequired,
      true,
    );
  },
);
