import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  DomainError,
  EmailRegistration,
  PhoneContacts,
  PhoneVerification,
  configurePhoneVerification,
  connectDatabase,
  migrate,
  type Database,
  type PhoneVerificationContext,
  type PhoneVerificationPolicy,
} from "./index.js";
import { syntheticServiceConsents } from "./test-service-consents.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const protectedPhone = (marker = "a") =>
  `pc1.${"1".repeat(64)}.${"2".repeat(24)}.${marker.repeat(24)}.${"3".repeat(32)}`;
const policy: PhoneVerificationPolicy = {
  identityKeyFingerprint: hash("synthetic-protected-phone-policy"),
  normalizationVersion: "e164-v1",
  limits: {
    userHourly: 3,
    phoneHourly: 3,
    ipHourly: 10,
    cooldownSeconds: 0,
    globalDaily: null,
    globalTotal: null,
  },
};
const rejected = (code: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === code;
async function user(db: Database): Promise<PhoneVerificationContext> {
  const identity = randomUUID(),
    sessionTokenHash = hash(identity),
    registration = new EmailRegistration(db),
    input = {
      consents: syntheticServiceConsents,
      id: randomUUID(),
      email: identity + "@example.test",
      passwordHash: "synthetic-password-hash",
      proofHash: hash("email-proof"),
      codeHash: hash("email-code"),
      recipientKey: hash("recipient-" + identity),
      ipKey: hash("ip-" + identity),
    };
  await registration.begin(input);
  await registration.markSent(input.id, input.codeHash);
  const account = await registration.confirm({
    id: input.id,
    proofHash: input.proofHash,
    codeHash: input.codeHash,
    sessionHash: sessionTokenHash,
  });
  return { userId: account.id, sessionTokenHash };
}
async function challenge(
  phone: PhoneVerification,
  ctx: PhoneVerificationContext,
) {
  const input = {
    id: randomUUID(),
    phoneKey: hash(randomUUID()),
    proofHash: hash("phone-proof"),
    codeHash: hash("phone-code"),
    ipKey: hash(randomUUID()),
  };
  await phone.begin(ctx, input);
  await phone.markAccepted(input.id, input.codeHash);
  return {
    id: input.id,
    phoneKey: input.phoneKey,
    proofHash: input.proofHash,
    codeHash: input.codeHash,
  };
}
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  await configurePhoneVerification(db, policy);
  return {
    db,
    phone: new PhoneVerification(db, policy),
    contacts: new PhoneContacts(db),
  };
}
async function makeSuperAdmin(db: Database, ctx: PhoneVerificationContext) {
  await db.query("update users set role='super_admin' where id=$1", [
    ctx.userId,
  ]);
}

test("fresh SMS captures one protected envelope, replay never replaces it or backfills a missing value", async (t) => {
  const f = await fixture(t),
    ctx = await user(f.db),
    input = await challenge(f.phone, ctx),
    envelope = protectedPhone();
  const receipt = await f.phone.confirm(ctx, {
    ...input,
    protectedPhone: envelope,
  });
  const before = (await f.db.query("select * from phone_contact_bindings"))
    .rows;
  assert.equal(before[0]!.protected_phone, envelope);
  assert.equal(before[0]!.id, receipt.operationId);
  assert.equal(
    (
      await f.phone.confirm(ctx, {
        ...input,
        protectedPhone: protectedPhone("b"),
      })
    ).alreadyGranted,
    true,
  );
  assert.deepEqual(
    (await f.db.query("select * from phone_contact_bindings")).rows,
    before,
  );
  const legacy = await user(f.db),
    oldInput = await challenge(f.phone, legacy);
  await f.phone.confirm(legacy, oldInput);
  await f.phone.confirm(legacy, { ...oldInput, protectedPhone: envelope });
  assert.equal(
    (
      await f.db.query<{ protected_phone: string | null }>(
        "select protected_phone from phone_contact_bindings where user_id=$1",
        [legacy.userId],
      )
    ).rows[0]!.protected_phone,
    null,
  );
  await assert.rejects(
    f.db.query("update phone_contact_bindings set protected_phone=$1", [
      protectedPhone("c"),
    ]),
    /immutable/,
  );
  await assert.rejects(
    f.db.query(
      `update phone_contact_bindings set protected_phone=$1,
       unlinked_at=clock_timestamp(),unlink_operation_id=$2 where id=$3`,
      [protectedPhone("c"), randomUUID(), receipt.operationId],
    ),
    /Protected phone contact is immutable/,
  );
  await assert.rejects(
    f.db.query(
      `insert into phone_contact_bindings(id,user_id,phone_key,proof_user_id,source_challenge_id,
        source_claim_operation_id,policy_fingerprint,bind_operation_id,protected_phone)
       select id,user_id,phone_key,proof_user_id,source_challenge_id,source_claim_operation_id,
        policy_fingerprint,bind_operation_id,$2 from phone_contact_bindings where id=$1`,
      [receipt.operationId, "+79990000001"],
    ),
    /phone_contact_protected_phone_shape/,
  );
  assert.equal(
    (await f.db.query("select 1 from phone_welcome_claims")).rows.length,
    2,
  );
});

test("failed contact insertion rolls back protected phone, gift, claim and consumed proof together", async (t) => {
  const f = await fixture(t),
    ctx = await user(f.db),
    input = await challenge(f.phone, ctx);
  await f.db
    .exec(`create function reject_synthetic_contact() returns trigger language plpgsql as $$
    begin raise exception 'synthetic contact rejection'; end; $$;
    create trigger reject_synthetic_contact before insert on phone_contact_bindings
      for each row execute function reject_synthetic_contact()`);
  await assert.rejects(
    f.phone.confirm(ctx, { ...input, protectedPhone: protectedPhone() }),
    /synthetic contact rejection/,
  );
  for (const table of [
    "phone_contact_bindings",
    "phone_welcome_claims",
    "ai_credit_entries",
    "credit_source_lots",
  ])
    assert.equal((await f.db.query("select 1 from " + table)).rows.length, 0);
  assert.equal(
    (
      await f.db.query(
        "select 1 from phone_verification_challenges where consumed_at is not null",
      )
    ).rows.length,
    0,
  );
});

test("protected capture rejects invalid envelopes before consuming the SMS", async (t) => {
  const f = await fixture(t),
    ctx = await user(f.db),
    input = await challenge(f.phone, ctx);
  for (const envelope of [
    "+79990000001",
    protectedPhone().replace("pc1", "pc2"),
    protectedPhone().replace("a".repeat(24), "a".repeat(19)),
    protectedPhone("A"),
    "a".repeat(257),
  ])
    await assert.rejects(
      f.phone.confirm(ctx, { ...input, protectedPhone: envelope }),
      rejected(400),
    );
  assert.equal(
    (await f.db.query("select 1 from phone_welcome_claims")).rows.length,
    0,
  );
  await f.phone.confirm(ctx, { ...input, protectedPhone: protectedPhone() });
});

test("only a current super admin and exact current session can view contacts, with metadata-only audits", async (t) => {
  const f = await fixture(t),
    actor = await user(f.db),
    ctx = await user(f.db),
    input = await challenge(f.phone, ctx),
    envelope = protectedPhone();
  await f.phone.confirm(ctx, { ...input, protectedPhone: envelope });
  const legacy = await user(f.db);
  await f.phone.confirm(legacy, await challenge(f.phone, legacy));
  await assert.rejects(f.contacts.listForAdmin(actor.userId), rejected(403));
  await f.db.query("update users set role='admin' where id=$1", [actor.userId]);
  await assert.rejects(f.contacts.listForAdmin(actor.userId), rejected(403));
  await makeSuperAdmin(f.db, actor);
  await f.db.query("update users set must_change_password=true where id=$1", [
    actor.userId,
  ]);
  await assert.rejects(f.contacts.listForAdmin(actor.userId), rejected(403));
  await f.db.query("update users set must_change_password=false where id=$1", [
    actor.userId,
  ]);
  await assert.rejects(
    f.contacts.listForAdmin(actor.userId, undefined, hash("wrong-session")),
    rejected(401),
  );
  await assert.rejects(
    f.contacts.listForAdmin(actor.userId, "0"),
    rejected(400),
  );
  assert.equal(
    (
      await f.db.query(
        "select 1 from audit_log where action='customer-phone-contacts-viewed'",
      )
    ).rows.length,
    0,
  );
  const page = await f.contacts.listForAdmin(
    actor.userId,
    undefined,
    actor.sessionTokenHash,
  );
  assert.equal(page.contacts.length, 1);
  const contact = page.contacts[0]!;
  assert.equal(contact.userId, ctx.userId);
  assert.equal(contact.proofUserId, ctx.userId);
  assert.equal(contact.protectedPhone, envelope);
  assert.equal(contact.phoneKey, input.phoneKey);
  assert.equal(contact.sourceChallengeId, input.id);
  assert.match(contact.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(page.nextAfterUserId, null);
  const audit = (
    await f.db.query<{ actor_user_id: number; payload: unknown }>(
      "select actor_user_id,payload from audit_log where action='customer-phone-contacts-viewed'",
    )
  ).rows[0]!;
  assert.equal(String(audit.actor_user_id), actor.userId);
  assert.deepEqual(audit.payload, {
    rowCount: 1,
    afterUserId: null,
    nextAfterUserId: null,
  });
  assert.equal(JSON.stringify(audit).includes(envelope), false);
  const fingerprint = (
    await f.db.query<{ policy_fingerprint: string }>(
      "select policy_fingerprint from phone_verification_control where id=1",
    )
  ).rows[0]!.policy_fingerprint;
  await f.db.query(
    "update phone_verification_control set policy_fingerprint=$1 where id=1",
    [hash("synthetic-invalid-proof-policy")],
  );
  assert.equal(
    (
      await f.contacts.listForAdmin(
        actor.userId,
        undefined,
        actor.sessionTokenHash,
      )
    ).contacts.length,
    0,
  );
  await f.db.query(
    "update phone_verification_control set policy_fingerprint=$1 where id=1",
    [fingerprint],
  );
  await f.db.query("delete from sessions where user_id=$1", [actor.userId]);
  await assert.rejects(
    f.contacts.listForAdmin(actor.userId, undefined, actor.sessionTokenHash),
    rejected(401),
  );
  await f.db.query("update users set role='user' where id=$1", [actor.userId]);
  await assert.rejects(f.contacts.listForAdmin(actor.userId), rejected(403));
});

test("admin cursor pages contain only active proven contacts; transfers read the original envelope once", async (t) => {
  const f = await fixture(t),
    actor = await user(f.db);
  await makeSuperAdmin(f.db, actor);
  const contexts: PhoneVerificationContext[] = [];
  for (let i = 0; i < 51; i++) {
    const ctx = await user(f.db),
      input = await challenge(f.phone, ctx);
    contexts.push(ctx);
    await f.phone.confirm(ctx, { ...input, protectedPhone: protectedPhone() });
  }
  const first = await f.contacts.listForAdmin(actor.userId);
  assert.deepEqual(
    first.contacts.map((c) => c.userId),
    contexts.slice(0, 50).map((c) => c.userId),
  );
  assert.equal(first.nextAfterUserId, contexts[49]!.userId);
  const second = await f.contacts.listForAdmin(
    actor.userId,
    first.nextAfterUserId!,
  );
  assert.deepEqual(
    second.contacts.map((c) => c.userId),
    [contexts[50]!.userId],
  );
  assert.equal(second.nextAfterUserId, null);
  const from = contexts[0]!,
    to = await user(f.db),
    source = (
      await f.db.query<{
        id: string;
        phone_key: string;
        policy_fingerprint: string;
      }>(
        "select id::text,phone_key,policy_fingerprint from phone_contact_bindings where user_id=$1 and unlinked_at is null",
        [from.userId],
      )
    ).rows[0]!;
  const command = {
    operationId: randomUUID(),
    fromUserId: from.userId,
    toUserId: to.userId,
    expectedSourceBindingId: source.id,
    expectedPhoneKey: source.phone_key,
    expectedPolicyFingerprint: source.policy_fingerprint,
    authoritySha256: hash("owner-request"),
    reason: "owner-request" as const,
  };
  const transfer = await f.contacts.changeByOperator(command);
  assert.equal(
    (
      await f.db.query<{ protected_phone: string | null }>(
        "select protected_phone from phone_contact_bindings where id=$1",
        [transfer.targetBindingId],
      )
    ).rows[0]!.protected_phone,
    null,
  );
  const transferred = await f.contacts.listForAdmin(
    actor.userId,
    contexts[49]!.userId,
  );
  assert.deepEqual(
    transferred.contacts.map((c) => c.userId),
    [contexts[50]!.userId, to.userId],
  );
  assert.equal(transferred.contacts[1]!.proofUserId, from.userId);
  assert.equal(transferred.contacts[1]!.protectedPhone, protectedPhone());
  assert.equal(
    (await f.contacts.listForAdmin(actor.userId)).contacts.some(
      (c) => c.userId === from.userId,
    ),
    false,
  );
  await assert.rejects(
    f.db.query(
      `update phone_contact_bindings set protected_phone=$1,
    unlinked_at=clock_timestamp(),unlink_operation_id=$2 where id=$3`,
      [protectedPhone("c"), randomUUID(), source.id],
    ),
    /immutable/,
  );
  await f.db.query("update users set status='blocked' where id=$1", [
    to.userId,
  ]);
  assert.equal(
    (await f.contacts.listForAdmin(actor.userId, contexts[50]!.userId)).contacts
      .length,
    0,
  );
});

test("schema35 migration leaves old contacts NULL and rejects retroactive protected-phone changes", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/", import.meta.url);
  await db.exec(
    "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith(".sql") && n < "0036_")
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
    phone = new PhoneVerification(db, policy),
    input = await challenge(phone, ctx),
    op = randomUUID();
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
      [input.id, op],
    );
    await tx.query(
      "insert into phone_welcome_claims(user_id,phone_key,challenge_id,operation_id,granted_micros) values($1,$2,$3,$4,500000000)",
      [ctx.userId, input.phoneKey, input.id, op],
    );
    await tx.query(
      `insert into phone_contact_bindings(id,user_id,phone_key,proof_user_id,source_challenge_id,
      source_claim_operation_id,policy_fingerprint,bind_operation_id)
      select $4,$1,$2,$1,$3,$4,c.policy_fingerprint,$4 from phone_verification_challenges c where c.id=$3`,
      [ctx.userId, input.phoneKey, input.id, op],
    );
  });
  const before = (
    await db.query("select id,user_id,phone_key from phone_contact_bindings")
  ).rows;
  await migrate(db);
  assert.deepEqual(
    (await db.query("select id,user_id,phone_key from phone_contact_bindings"))
      .rows,
    before,
  );
  assert.equal(
    (
      await db.query<{ protected_phone: string | null }>(
        "select protected_phone from phone_contact_bindings",
      )
    ).rows[0]!.protected_phone,
    null,
  );
  await phone.confirm(ctx, { ...input, protectedPhone: protectedPhone() });
  assert.equal(
    (
      await db.query<{ protected_phone: string | null }>(
        "select protected_phone from phone_contact_bindings",
      )
    ).rows[0]!.protected_phone,
    null,
  );
  assert.equal(
    (await db.query("select 1 from phone_welcome_claims")).rows.length,
    1,
  );
});
