import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  DomainError,
  EmailRegistration,
  PhoneContacts,
  PhoneVerification,
  connectDatabase,
  configurePhoneVerification,
  migrate,
  type Database,
  type PhoneVerificationContext,
  type PhoneVerificationPolicy,
} from "./index.js";
import { syntheticServiceConsents } from "./test-service-consents.js";
const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires opt-in disposable PostgreSQL; PGlite is not lock evidence",
  timeout: 60000,
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const status = (code: number) => (e: unknown) =>
  e instanceof DomainError && e.statusCode === code;
const policy: PhoneVerificationPolicy = {
  identityKeyFingerprint: hash("pg-contact-secret"),
  normalizationVersion: "e164-v1",
  limits: {
    userHourly: 10,
    phoneHourly: 10,
    ipHourly: 10,
    cooldownSeconds: 0,
    globalDaily: null,
    globalTotal: null,
  },
};
const input = () => ({
  id: randomUUID(),
  phoneKey: hash("pg-contact-phone"),
  proofHash: hash("proof"),
  codeHash: hash("code"),
  ipKey: hash("ip"),
});
const confirm = (v: ReturnType<typeof input>) => ({
  id: v.id,
  phoneKey: v.phoneKey,
  proofHash: v.proofHash,
  codeHash: v.codeHash,
});
async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert(base);
  const url = new URL(base);
  assert(["postgres:", "postgresql:"].includes(url.protocol));
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert(
    ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
      (url.port === "55438" && url.pathname === "/citygo_synthetic"),
  );
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  const name = "cg_contacts_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_contacts_test_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base);
  let created = false;
  const cleanup: { db?: Database } = {};
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
  await configurePhoneVerification(db, policy);
  async function user(): Promise<PhoneVerificationContext> {
    const id = randomUUID(),
      sessionTokenHash = hash(id),
      r = new EmailRegistration(db!),
      v = {
        consents: syntheticServiceConsents,
        id: randomUUID(),
        email: id + "@example.test",
        passwordHash: "synthetic",
        proofHash: hash("proof"),
        codeHash: hash("code"),
        recipientKey: hash(id),
        ipKey: hash(id + "ip"),
      };
    await r.begin(v);
    await r.markSent(v.id, v.codeHash);
    const u = await r.confirm({
      id: v.id,
      proofHash: v.proofHash,
      codeHash: v.codeHash,
      sessionHash: sessionTokenHash,
    });
    return { userId: u.id, sessionTokenHash };
  }
  const to = await user(),
    from = await user(),
    third = await user(),
    phone = new PhoneVerification(db, policy),
    v = input();
  await phone.begin(from, v);
  await phone.markAccepted(v.id, v.codeHash);
  const gift = await phone.confirm(from, confirm(v));
  const fingerprint = (
    await db.query<{ f: string }>(
      "select policy_fingerprint as f from phone_verification_control where id=1",
    )
  ).rows[0]!.f;
  const command = (target: string | null = to.userId) => ({
    operationId: randomUUID(),
    fromUserId: from.userId,
    toUserId: target,
    expectedSourceBindingId: gift.operationId,
    expectedPhoneKey: v.phoneKey,
    expectedPolicyFingerprint: fingerprint,
    authoritySha256: hash("pg-owner-authority"),
    reason: "owner-request" as const,
  });
  const money = async () =>
    (
      await db!.query(`select jsonb_build_object(
  'accounts',(select jsonb_agg(to_jsonb(t) order by user_id) from ai_credit_accounts t),
  'entries',(select jsonb_agg(to_jsonb(t) order by id) from ai_credit_entries t),
  'lots',(select jsonb_agg(to_jsonb(t) order by id) from credit_source_lots t),
  'claims',(select jsonb_agg(to_jsonb(t) order by user_id) from phone_welcome_claims t),
  'challenges',(select jsonb_agg(to_jsonb(t) order by id) from phone_verification_challenges t),
  'sends',(select jsonb_agg(to_jsonb(t) order by id) from phone_verification_sends t)
 ) as snapshot`)
    ).rows;
  return { db, user, from, to, third, phone, v, gift, command, money };
}
function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function tagged(
  db: Database,
  tag: string,
  gate?: {
    entered: ReturnType<typeof signal>;
    release: ReturnType<typeof signal>;
  },
): Database {
  let held = false;
  return {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('application_name',$1,true)", [tag]);
        return work({
          exec: (s) => tx.exec(s),
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            if (
              gate &&
              !held &&
              sql.startsWith("select id from account_security_state")
            ) {
              held = true;
              gate.entered.open();
              await gate.release.promise;
            }
            return result;
          },
        });
      }),
  };
}
async function within<T>(p: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Real contact lock barrier timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function blocked(db: Database, waiter: string, holder: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const r = (
      await db.query<{ blocked: boolean }>(
        `select exists(select 1 from pg_stat_activity w join pg_stat_activity h
 on h.pid=any(pg_blocking_pids(w.pid)) where w.application_name=$1 and h.application_name=$2
 and w.wait_event_type='Lock' and w.pid<>h.pid) as blocked`,
        [waiter, holder],
      )
    ).rows[0]!;
    if (r.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    "Independent PostgreSQL backend did not actually wait on contact lock",
  );
}
const observed = <T>(p: Promise<T>) => {
  void p.catch(() => {});
  return p;
};
test(
  "PostgreSQL competing operator transfers serialize on real locks and preserve exactly one active phone with no financial change",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      before = await f.money(),
      gate = { entered: signal(), release: signal() },
      tag = "cg_contact_" + randomUUID().replaceAll("-", "");
    const first = observed(
      new PhoneContacts(tagged(f.db, tag + "_first", gate)).changeByOperator(
        f.command(),
      ),
    );
    let second: ReturnType<PhoneContacts["changeByOperator"]> | undefined;
    try {
      await within(gate.entered.promise);
      second = observed(
        new PhoneContacts(tagged(f.db, tag + "_second")).changeByOperator(
          f.command(f.third.userId),
        ),
      );
      await blocked(f.db, tag + "_second", tag + "_first");
    } finally {
      gate.release.open();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    await first;
    assert(second);
    await assert.rejects(second, status(409));
    assert.deepEqual(
      (
        await f.db.query(
          "select user_id::text,proof_user_id::text from phone_contact_bindings where unlinked_at is null",
        )
      ).rows,
      [{ user_id: f.to.userId, proof_user_id: f.from.userId }],
    );
    assert.equal(
      (await f.db.query("select 1 from phone_contact_changes")).rows.length,
      1,
    );
    assert.deepEqual(await f.money(), before);
  },
);
test(
  "PostgreSQL consumed OTP waits behind transfer and cannot recreate the old owner or award a second gift",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      before = await f.money(),
      gate = { entered: signal(), release: signal() },
      tag = "cg_contact_" + randomUUID().replaceAll("-", "");
    const first = observed(
      new PhoneContacts(tagged(f.db, tag + "_operator", gate)).changeByOperator(
        f.command(),
      ),
    );
    let second: Promise<unknown> | undefined;
    try {
      await within(gate.entered.promise);
      second = observed(
        new PhoneVerification(tagged(f.db, tag + "_otp"), policy).confirm(
          f.from,
          confirm(f.v),
        ),
      );
      await blocked(f.db, tag + "_otp", tag + "_operator");
    } finally {
      gate.release.open();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    await first;
    assert(second);
    await assert.rejects(second, status(409));
    await assert.rejects(f.phone.begin(f.third, input()), status(409));
    assert.equal(
      (
        await f.db.query(
          "select 1 from phone_contact_bindings where unlinked_at is null",
        )
      ).rows.length,
      1,
    );
    assert.deepEqual(await f.money(), before);
  },
);
test(
  "PostgreSQL actual API grants attach phone_code only and reject contact unlink, operator evidence and Worker access",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    for (const role of ["citygo_api", "citygo_worker", "citygo_backup"])
      await f.db.exec(
        `do $$ begin create role ${role} nologin nosuperuser nocreatedb nocreaterole; exception when duplicate_object then null; end $$`,
      );
    await f.db.exec(
      "grant usage on schema public to citygo_api,citygo_worker,citygo_backup",
    );
    const grants = (
      await readFile(
        new URL("../../../deploy/postgres/grants.sql", import.meta.url),
        "utf8",
      )
    ).replace(/^\\set[^\n]*\n/gm, "");
    await f.db.exec(grants);
    const ctx = await f.user(),
      v = { ...input(), phoneKey: hash("pg-other-phone") };
    const api: Database = {
      ...f.db,
      query: <T>(sql: string, params?: unknown[]) =>
        f.db.transaction(async (tx) => {
          await tx.exec("set local role citygo_api");
          return tx.query<T>(sql, params);
        }),
      transaction: (work) =>
        f.db.transaction(async (tx) => {
          await tx.exec("set local role citygo_api");
          return work(tx);
        }),
    };
    const phone = new PhoneVerification(api, policy);
    await phone.begin(ctx, v);
    await phone.markAccepted(v.id, v.codeHash);
    await phone.confirm(ctx, confirm(v));
    const before = await f.money();
    await assert.rejects(
      new PhoneContacts(api).changeByOperator(f.command()),
      status(403),
    );
    for (const sql of [
      "update phone_contact_bindings set unlinked_at=clock_timestamp(),unlink_operation_id=gen_random_uuid()",
      "delete from phone_contact_bindings",
      "insert into phone_contact_changes(operation_id) values(gen_random_uuid())",
      "insert into phone_contact_bindings(id,method) values(gen_random_uuid(),'operator_transfer')",
    ])
      await assert.rejects(api.query(sql), /permission denied/);
    for (const table of ["phone_contact_bindings", "phone_contact_changes"])
      await assert.rejects(
        f.db.transaction(async (tx) => {
          await tx.exec("set local role citygo_worker");
          await tx.query("select 1 from " + table);
        }),
        /permission denied/,
      );
    assert.deepEqual(await f.money(), before);
  },
);
