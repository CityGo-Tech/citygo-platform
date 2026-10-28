import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  AccountProfile,
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
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const status = (code: number) => (e: unknown) =>
  e instanceof DomainError && e.statusCode === code;
const policy: PhoneVerificationPolicy = {
  identityKeyFingerprint: hash("contact-secret"),
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
  phoneKey: hash("contact-phone"),
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
async function user(db: Database): Promise<PhoneVerificationContext> {
  const id = randomUUID(),
    sessionTokenHash = hash(id),
    r = new EmailRegistration(db),
    v = {
      consents: syntheticServiceConsents,
      id: randomUUID(),
      email: id + "@example.test",
      passwordHash: "synthetic-hash",
      proofHash: hash("emailproof"),
      codeHash: hash("emailcode"),
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
async function unchanged(db: Database) {
  return (
    await db.query(`select jsonb_build_object(
 'accounts',(select jsonb_agg(to_jsonb(t) order by user_id) from ai_credit_accounts t),
 'entries',(select jsonb_agg(to_jsonb(t) order by id) from ai_credit_entries t),
 'lots',(select jsonb_agg(to_jsonb(t) order by id) from credit_source_lots t),
 'claims',(select jsonb_agg(to_jsonb(t) order by user_id) from phone_welcome_claims t),
 'challenges',(select jsonb_agg(to_jsonb(t) order by id) from phone_verification_challenges t),
 'sends',(select jsonb_agg(to_jsonb(t) order by id) from phone_verification_sends t),
 'control',(select jsonb_agg(to_jsonb(t)) from phone_verification_control t),
 'debts',(select jsonb_agg(to_jsonb(t) order by hold_id) from credit_charge_debts t),
 'repayments',(select jsonb_agg(to_jsonb(t) order by id) from credit_debt_repayments t),
 'topups',(select jsonb_agg(to_jsonb(t) order by operation_id) from ai_credit_topups t),
 'orders',(select jsonb_agg(to_jsonb(t) order by id) from payment_topup_orders t),
 'refunds',(select jsonb_agg(to_jsonb(t) order by id) from payment_refunds t),
 'npd',(select jsonb_agg(to_jsonb(t) order by id) from npd_receipt_tasks t)
 ) as snapshot`)
  ).rows;
}
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  await configurePhoneVerification(db, policy);
  const from = await user(db),
    to = await user(db),
    third = await user(db),
    phone = new PhoneVerification(db, policy),
    v = input();
  await phone.begin(from, v);
  await phone.markAccepted(v.id, v.codeHash);
  const gift = await phone.confirm(from, confirm(v));
  const fingerprint = (
    await db.query<{ value: string }>(
      "select policy_fingerprint as value from phone_verification_control where id=1",
    )
  ).rows[0]!.value;
  const command = (toUserId: string | null = to.userId) => ({
    operationId: randomUUID(),
    fromUserId: from.userId,
    toUserId,
    expectedSourceBindingId: gift.operationId,
    expectedPhoneKey: v.phoneKey,
    expectedPolicyFingerprint: fingerprint,
    authoritySha256: hash("actual-test-authority"),
    reason: "owner-request" as const,
  });
  return {
    db,
    from,
    to,
    third,
    phone,
    v,
    gift,
    command,
    contacts: new PhoneContacts(db),
  };
}
test("operator transfer retains original SMS owner, every gift and financial row, with one audited replay-safe receipt", async (t) => {
  const f = await fixture(t),
    before = await unchanged(f.db),
    cmd = f.command();
  const result = await f.contacts.changeByOperator(cmd);
  assert.equal(result.replayed, false);
  assert(result.targetBindingId);
  const profile = new AccountProfile(f.db);
  assert.equal((await profile.summary(f.from)).phoneVerified, false);
  assert.equal((await profile.summary(f.from)).giftClaimed, true);
  assert.equal((await profile.summary(f.to)).phoneVerified, true);
  assert.equal((await profile.summary(f.to)).giftClaimed, false);
  assert.deepEqual(await f.phone.status(f.to), {
    alreadyGranted: false,
    giftStatus: "phone_bound",
  });
  assert.deepEqual(
    (
      await f.db.query(
        "select user_id::text,proof_user_id::text,method from phone_contact_bindings where unlinked_at is null",
      )
    ).rows,
    [
      {
        user_id: f.to.userId,
        proof_user_id: f.from.userId,
        method: "operator_transfer",
      },
    ],
  );
  assert.deepEqual(await f.contacts.changeByOperator(cmd), {
    ...result,
    replayed: true,
  });
  assert.equal(
    (await f.db.query("select 1 from phone_contact_changes")).rows.length,
    1,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select actor_user_id,action from audit_log where entity_type='phone-contact'",
      )
    ).rows,
    [{ actor_user_id: null, action: "phone-contact-transferred" }],
  );
  await assert.rejects(
    f.contacts.changeByOperator({
      ...cmd,
      authoritySha256: hash("other-authority"),
    }),
    status(409),
  );
  await assert.rejects(f.phone.confirm(f.from, confirm(f.v)), status(409));
  await assert.rejects(
    f.phone.begin(f.third, { ...input(), id: randomUUID() }),
    status(409),
  );
  await assert.rejects(
    f.phone.begin(f.to, { ...input(), phoneKey: hash("another-number") }),
    status(409),
  );
  assert.deepEqual(await unchanged(f.db), before);
});
test("unlink preserves the forever-spent phone tombstone and cannot be undone by an old OTP or repeated command", async (t) => {
  const f = await fixture(t),
    before = await unchanged(f.db),
    cmd = f.command(null);
  const result = await f.contacts.changeByOperator(cmd);
  assert.equal(result.targetBindingId, null);
  assert.equal(
    (
      await f.db.query(
        "select 1 from phone_contact_bindings where unlinked_at is null",
      )
    ).rows.length,
    0,
  );
  assert.deepEqual(await f.contacts.changeByOperator(cmd), {
    ...result,
    replayed: true,
  });
  await assert.rejects(f.phone.confirm(f.from, confirm(f.v)), status(409));
  await assert.rejects(f.phone.begin(f.third, input()), status(409));
  await assert.rejects(
    f.contacts.changeByOperator({ ...cmd, operationId: randomUUID() }),
    status(409),
  );
  assert.deepEqual(await unchanged(f.db), before);
});
test("operator command fails on stale identities, active target, changed proof or policy without partial unlink", async (t) => {
  const f = await fixture(t),
    before = await unchanged(f.db),
    cmd = f.command();
  for (const patch of [
    { expectedSourceBindingId: randomUUID() },
    { expectedPhoneKey: hash("wrong") },
    { expectedPolicyFingerprint: hash("wrong") },
    { fromUserId: f.third.userId },
  ])
    await assert.rejects(
      f.contacts.changeByOperator({ ...cmd, ...patch }),
      status(409),
    );
  await assert.rejects(
    f.contacts.changeByOperator({ ...cmd, toUserId: f.from.userId }),
    status(400),
  );
  const another = { ...input(), phoneKey: hash("second-phone") };
  await f.phone.begin(f.to, another);
  await f.phone.markAccepted(another.id, another.codeHash);
  await f.phone.confirm(f.to, confirm(another));
  const populated = await unchanged(f.db);
  await assert.rejects(f.contacts.changeByOperator(cmd), status(409));
  assert.deepEqual(await unchanged(f.db), populated);
  assert.equal(
    (await f.db.query("select 1 from phone_contact_changes")).rows.length,
    0,
  );
  assert.equal(
    (
      await f.db.query(
        "select 1 from phone_contact_bindings where unlinked_at is null",
      )
    ).rows.length,
    2,
  );
  assert.notDeepEqual(populated, before);
});
test("database guards retain terminal contact/receipt history and require a committed unlink receipt", async (t) => {
  const f = await fixture(t),
    before = await unchanged(f.db);
  await assert.rejects(
    f.db.transaction(async (tx) => {
      await tx.query(
        "update phone_contact_bindings set unlinked_at=clock_timestamp(),unlink_operation_id=$1 where id=$2",
        [randomUUID(), f.gift.operationId],
      );
    }),
    /committed operator receipt/,
  );
  await assert.rejects(
    f.db.query("delete from phone_contact_bindings"),
    /history is retained/,
  );
  await assert.rejects(
    f.db.query("update phone_contact_bindings set phone_key=$1", [
      hash("replacement"),
    ]),
    /immutable/,
  );
  const result = await f.contacts.changeByOperator(f.command(null));
  for (const sql of [
    "delete from phone_contact_changes",
    "update phone_contact_changes set reason=reason",
  ])
    await assert.rejects(f.db.exec(sql), /append-only/);
  await assert.rejects(
    f.db.query(
      "update phone_contact_bindings set unlinked_at=null,unlink_operation_id=null where id=$1",
      [result.sourceBindingId],
    ),
    /immutable/,
  );
  assert.deepEqual(await unchanged(f.db), before);
});
test("actual restricted API attaches a real new claim but cannot transfer, unlink, forge operator receipts or give Worker contact access", async (t) => {
  const f = await fixture(t);
  await f.db.exec(
    "create role citygo_api nologin;create role citygo_worker nologin;create role citygo_backup nologin;grant usage on schema public to citygo_api,citygo_worker,citygo_backup",
  );
  const grants = (
    await readFile(
      new URL("../../../deploy/postgres/grants.sql", import.meta.url),
      "utf8",
    )
  ).replace(/^\\set[^\n]*\n/gm, "");
  await f.db.exec(grants);
  const next = await user(f.db),
    v = { ...input(), phoneKey: hash("API-phone") };
  await f.db.exec("set role citygo_api");
  await f.phone.begin(next, v);
  await f.phone.markAccepted(v.id, v.codeHash);
  const envelope = `pc1.${"1".repeat(64)}.${"2".repeat(24)}.${"a".repeat(24)}.${"3".repeat(32)}`;
  await f.phone.confirm(next, { ...confirm(v), protectedPhone: envelope });
  assert.equal(
    (
      await f.db.query<{ protected_phone: string }>(
        "select protected_phone from phone_contact_bindings where user_id=$1",
        [next.userId],
      )
    ).rows[0]!.protected_phone,
    envelope,
  );
  await assert.rejects(
    f.db.query(
      "update phone_contact_bindings set protected_phone=null where user_id=$1",
      [next.userId],
    ),
    /permission denied/,
  );
  await assert.rejects(f.contacts.changeByOperator(f.command()), status(403));
  await f.db.exec(
    "reset role;grant update(unlinked_at,unlink_operation_id) on phone_contact_bindings to citygo_api;grant insert on phone_contact_changes to citygo_api;set role citygo_api",
  );
  await assert.rejects(
    f.db.query(
      "update phone_contact_bindings set unlinked_at=clock_timestamp(),unlink_operation_id=$1 where id=$2",
      [randomUUID(), f.gift.operationId],
    ),
    /database operator/,
  );
  await assert.rejects(
    f.db.query("insert into phone_contact_changes(operation_id) values($1)", [
      randomUUID(),
    ]),
    /database operator/,
  );
  await f.db.exec(
    "reset role;revoke update(unlinked_at,unlink_operation_id) on phone_contact_bindings from citygo_api;revoke insert on phone_contact_changes from citygo_api;set role citygo_api",
  );

  for (const sql of [
    "update phone_contact_bindings set unlinked_at=clock_timestamp(),unlink_operation_id=gen_random_uuid()",
    "delete from phone_contact_bindings",
    "insert into phone_contact_changes(operation_id) values(gen_random_uuid())",
    "insert into phone_contact_bindings(id,method) values(gen_random_uuid(),'operator_transfer')",
  ])
    await assert.rejects(f.db.exec(sql), /permission denied/);
  await f.db.exec("reset role;set role citygo_worker");
  for (const table of ["phone_contact_bindings", "phone_contact_changes"])
    await assert.rejects(
      f.db.exec("select 1 from " + table),
      /permission denied/,
    );
});
test("schema31 exact proof backfills only a contact, while broken consumed evidence fails the whole migration", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/", import.meta.url);
  await db.exec(
    "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith(".sql") && n < "0032_")
    .sort()) {
    const sql = await readFile(new URL(name, directory), "utf8");
    await db.exec(sql.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""));
    await db.query(
      "insert into citygo_migrations(name,checksum) values($1,$2)",
      [name, hash(sql.replaceAll("\r\n", "\n"))],
    );
  }
  await configurePhoneVerification(db, policy);
  const ctx = await user(db),
    v = input(),
    op = randomUUID();
  const fingerprint = (
    await db.query<{ value: string }>(
      "select policy_fingerprint as value from phone_verification_control where id=1",
    )
  ).rows[0]!.value;
  await db.query(
    `insert into phone_verification_challenges(id,user_id,phone_key,proof_hash,code_hash,policy_fingerprint,delivery,expires_at)
    values($1,$2,$3,$4,$5,$6,'accepted',clock_timestamp()+interval '10 minutes')`,
    [v.id, ctx.userId, v.phoneKey, v.proofHash, v.codeHash, fingerprint],
  );
  await db.query(
    `insert into phone_verification_sends(id,challenge_id,user_id,phone_key,ip_key,policy_fingerprint)
    values($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), v.id, ctx.userId, v.phoneKey, v.ipKey, fingerprint],
  );
  await db.transaction(async (tx) => {
    await tx.query("insert into ai_credit_accounts(user_id) values($1)", [
      ctx.userId,
    ]);
    await tx.query(
      "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,actor_user_id) values($1,$2,'bonus',500000000,$1)",
      [ctx.userId, op],
    );
    await tx.query(
      "update ai_credit_accounts set granted_micros=500000000 where user_id=$1",
      [ctx.userId],
    );
    await tx.query(
      "update phone_verification_challenges set consumed_at=clock_timestamp(),consumed_operation_id=$2 where id=$1",
      [v.id, op],
    );
    await tx.query(
      "insert into phone_welcome_claims(user_id,phone_key,challenge_id,operation_id,granted_micros) values($1,$2,$3,$4,500000000)",
      [ctx.userId, v.phoneKey, v.id, op],
    );
  });
  const before = await unchanged(db);
  await db.query(
    "update phone_verification_control set policy_fingerprint=$1 where id=1",
    [hash("wrong-bound-policy")],
  );
  const broken = await unchanged(db);
  await assert.rejects(
    migrate(db),
    /Existing phone gift evidence requires review/,
  );
  assert.deepEqual(await unchanged(db), broken);
  assert.equal(
    (
      await db.query<{ count: number }>(
        "select count(*)::int as count from citygo_migrations",
      )
    ).rows[0]!.count,
    31,
  );
  assert.equal(
    (
      await db.query<{ relation: string | null }>(
        "select to_regclass('phone_contact_bindings')::text as relation",
      )
    ).rows[0]!.relation,
    null,
  );
  await db.query(
    "update phone_verification_control set policy_fingerprint=$1 where id=1",
    [fingerprint],
  );
  await migrate(db);
  assert.deepEqual(await unchanged(db), before);
  assert.deepEqual(
    (
      await db.query(
        "select id::text,user_id::text,proof_user_id::text,method from phone_contact_bindings",
      )
    ).rows,
    [
      {
        id: op,
        user_id: ctx.userId,
        proof_user_id: ctx.userId,
        method: "phone_code",
      },
    ],
  );
  assert.equal(
    (await db.query("select 1 from phone_contact_changes")).rows.length,
    0,
  );
});
