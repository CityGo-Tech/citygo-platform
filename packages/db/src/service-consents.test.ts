import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { serviceConsentPolicy } from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
  EmailRegistration,
  FreshAccountReset,
  ClosedAccountRestart,
} from "./index.js";
import { consentPolicyHash } from "./service-consents.js";
import {
  syntheticServiceConsents,
  seedLegacyVerifiedEmail,
  applyFixtureMigration,
} from "./test-service-consents.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  return { db, store: new ServiceConsents(db) };
}
const begin = () => ({
  id: randomUUID(),
  email: "synthetic-consent@example.test",
  passwordHash: "synthetic-hash",
  proofHash: hash("proof"),
  codeHash: hash("code"),
  recipientKey: hash("recipient"),
  ipKey: hash("ip"),
  consents: { ...syntheticServiceConsents },
});

test("explicit false marketing registers; exact separate documents, source, subject and hash are auditable without AI/SMS grants", async (t) => {
  const { db, store } = await fixture(t);
  const user = await store.register(
    "consent@example.test",
    "synthetic-hash",
    hash("session"),
    syntheticServiceConsents,
  );
  assert.equal(user.serviceConsentRequired, false);
  const evidence = (
    await db.query<{
      purpose: string;
      decision: string;
      policy_snapshot: typeof serviceConsentPolicy;
      policy_hash: string;
      subject_email: string;
      source: string;
    }>("select * from service_consent_events order by id")
  ).rows;
  assert.deepEqual(
    evidence.map((row) => [row.purpose, row.decision]),
    [
      ["personal-data", "granted"],
      ["marketing", "declined"],
    ],
  );
  for (const row of evidence) {
    assert.deepEqual(row.policy_snapshot, serviceConsentPolicy);
    assert.equal(row.policy_hash, consentPolicyHash(serviceConsentPolicy));
    assert.equal(row.subject_email, user.email);
    assert.equal(row.source, "signup");
  }
  for (const table of [
    "ai_consents",
    "phone_welcome_claims",
    "ai_credit_entries",
  ])
    assert.deepEqual((await db.query(`select * from ${table}`)).rows, []);
  assert.equal((await store.state(user.id)).marketingGranted, false);
  await assert.rejects(
    store.register(
      user.email,
      "other-hash",
      hash("other-session"),
      syntheticServiceConsents,
    ),
    /уже существует/,
  );
});

test("missing, unchecked, omitted optional choice and stale versions cannot register or create evidence", async (t) => {
  const { db, store } = await fixture(t);
  for (const choice of [
    undefined,
    {},
    { ...syntheticServiceConsents, personalData: false },
    { policyVersion: serviceConsentPolicy.version, personalData: true },
    { ...syntheticServiceConsents, policyVersion: "old" },
  ])
    await assert.rejects(
      store.register(
        "invalid@example.test",
        "synthetic-hash",
        hash("session"),
        choice,
      ),
    );
  for (const table of ["users", "sessions", "service_consent_events"])
    assert.deepEqual((await db.query(`select * from ${table}`)).rows, []);
});

test("old users receive no backfill; explicit acceptance and optional withdrawal append truthfully, retries do not fabricate events", async (t) => {
  const { db, store } = await fixture(t);
  const id = await new Repository(db).register(
    "legacy@example.test",
    "legacy-hash",
  );
  assert.equal((await store.state(id)).serviceConsentRequired, true);
  await store.choose(id, { ...syntheticServiceConsents, marketing: true });
  await store.choose(id, { ...syntheticServiceConsents, marketing: true });
  const withdrawn = await store.choose(id, syntheticServiceConsents);
  await store.choose(id, syntheticServiceConsents);
  assert.equal(withdrawn.serviceConsentRequired, false);
  assert.equal(withdrawn.marketingGranted, false);
  assert.deepEqual(
    (
      await db.query(
        "select purpose,decision,source from service_consent_events order by id",
      )
    ).rows,
    [
      {
        purpose: "personal-data",
        decision: "granted",
        source: "existing-account",
      },
      { purpose: "marketing", decision: "granted", source: "existing-account" },
      {
        purpose: "marketing",
        decision: "withdrawn",
        source: "existing-account",
      },
    ],
  );
  for (const reset of [
    new FreshAccountReset(db),
    new ClosedAccountRestart(db),
  ]) {
    const plan = await reset.plan({
      expectedUserCount: 1,
      maintenanceConfirmed: true,
    });
    assert.ok(
      plan.blockers.some(
        (row) => row.code === "EMAIL_REGISTRATION_HISTORY_REQUIRES_REVIEW",
      ),
    );
  }
});

test("a different document hash with the same version never authorizes current service use", async (t) => {
  const { db, store } = await fixture(t);
  const id = await new Repository(db).register(
    "old-text@example.test",
    "synthetic-hash",
  );
  const oldPolicy = {
    ...serviceConsentPolicy,
    personalData: {
      ...serviceConsentPolicy.personalData,
      text: "Earlier synthetic text with the same version",
    },
  };
  await db.query(
    `insert into service_consent_events(user_id,subject_email,policy_version,policy_snapshot,policy_hash,purpose,decision,source)
    values($1,'old-text@example.test',$2,$3::jsonb,$4,'personal-data','granted','existing-account')`,
    [
      id,
      oldPolicy.version,
      JSON.stringify(oldPolicy),
      consentPolicyHash(oldPolicy),
    ],
  );
  assert.equal((await store.state(id)).serviceConsentRequired, true);
  await store.choose(id, syntheticServiceConsents);
  assert.equal((await store.state(id)).serviceConsentRequired, false);
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from service_consent_events where purpose='personal-data'",
      )
    ).rows[0]!.count,
    2,
  );
});

test("email choices freeze before delivery, survive resend, and commit as OTP-bound evidence with exact original timestamp", async (t) => {
  const { db } = await fixture(t),
    registration = new EmailRegistration(db),
    value = begin();
  await registration.begin(value);
  assert.deepEqual(
    (await db.query("select * from service_consent_events")).rows,
    [],
  );
  const before = (
    await db.query(
      "select consent_choice,consent_policy,consent_policy_hash,consent_recorded_at::text from email_registrations",
    )
  ).rows;
  await db.query(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 minutes'",
  );
  const nextCode = hash("new-code");
  await registration.resend({
    id: value.id,
    proofHash: value.proofHash,
    codeHash: nextCode,
    ipKey: value.ipKey,
  });
  assert.deepEqual(
    (
      await db.query(
        "select consent_choice,consent_policy,consent_policy_hash,consent_recorded_at::text from email_registrations",
      )
    ).rows,
    before,
  );
  await assert.rejects(
    db.query(
      "update email_registrations set consent_choice=jsonb_set(consent_choice,'{marketing}','true')",
    ),
    /immutable/,
  );
  await registration.markSent(value.id, nextCode);
  const user = await registration.confirm({
    id: value.id,
    proofHash: value.proofHash,
    codeHash: nextCode,
    sessionHash: hash("session"),
  });
  const evidence = (
    await db.query<{
      bound: boolean;
      timestamp_equal: boolean;
      source: string;
    }>(`select e.registration_id=r.id and e.user_id=r.consumed_user_id and e.subject_email=r.email as bound,
    e.choice_recorded_at=r.consent_recorded_at as timestamp_equal,e.source from service_consent_events e join email_registrations r on r.id=e.registration_id`)
  ).rows;
  assert.equal(evidence.length, 2);
  for (const row of evidence)
    assert.deepEqual(row, {
      bound: true,
      timestamp_equal: true,
      source: "email-registration",
    });
  assert.equal(
    (await new ServiceConsents(db).state(user.id)).marketingGranted,
    false,
  );
});

test("old pending registration cannot confirm or resend; signup and OTP failures roll back accounts, sessions and all consent evidence", async (t) => {
  const { db, store } = await fixture(t),
    reg = new EmailRegistration(db),
    value = begin();
  await db.query(
    `insert into email_registrations(id,email,password_hash,proof_hash,code_hash,recipient_key,delivery,expires_at)
    values($1,$2,$3,$4,$5,$6,'sent',clock_timestamp()+interval '10 minutes')`,
    [
      value.id,
      value.email,
      value.passwordHash,
      value.proofHash,
      value.codeHash,
      value.recipientKey,
    ],
  );
  await assert.rejects(
    reg.confirm({
      id: value.id,
      proofHash: value.proofHash,
      codeHash: value.codeHash,
      sessionHash: hash("session"),
    }),
  );
  await assert.rejects(
    reg.resend({
      id: value.id,
      proofHash: value.proofHash,
      codeHash: hash("new"),
      ipKey: value.ipKey,
    }),
  );
  await db.exec(`create function fail_consent_session() returns trigger language plpgsql as $$ begin raise exception 'synthetic session failure'; end $$;
    create trigger fail_session before insert on sessions for each row execute function fail_consent_session()`);
  await assert.rejects(
    store.register(
      "failed-signup@example.test",
      "hash",
      hash("session"),
      syntheticServiceConsents,
    ),
    /synthetic session failure/,
  );
  value.id = randomUUID();
  value.email = "failed-email@example.test";
  await reg.begin(value);
  await reg.markSent(value.id, value.codeHash);
  await assert.rejects(
    reg.confirm({
      id: value.id,
      proofHash: value.proofHash,
      codeHash: value.codeHash,
      sessionHash: hash("session"),
    }),
    /synthetic session failure/,
  );
  for (const table of [
    "users",
    "sessions",
    "service_consent_events",
    "account_email_verifications",
  ])
    assert.deepEqual((await db.query(`select * from ${table}`)).rows, []);
  assert.equal(
    (
      await db.query(
        "select consumed_user_id from email_registrations where id=$1",
        [value.id],
      )
    ).rows[0]!.consumed_user_id,
    null,
  );
});

test("resend refuses a stale same-version document before changing the challenge or consuming delivery quota", async (t) => {
  const { db } = await fixture(t),
    reg = new EmailRegistration(db),
    value = begin();
  const oldPolicy = {
    ...serviceConsentPolicy,
    marketing: {
      ...serviceConsentPolicy.marketing,
      text: "Earlier synthetic marketing text",
    },
  };
  await db.query(
    `insert into email_registrations(id,email,password_hash,proof_hash,code_hash,recipient_key,delivery,expires_at,consent_choice,consent_policy,consent_policy_hash,consent_recorded_at)
    values($1,$2,$3,$4,$5,$6,'sent',clock_timestamp()+interval '10 minutes',$7::jsonb,$8::jsonb,$9,clock_timestamp())`,
    [
      value.id,
      value.email,
      value.passwordHash,
      value.proofHash,
      value.codeHash,
      value.recipientKey,
      JSON.stringify(value.consents),
      JSON.stringify(oldPolicy),
      consentPolicyHash(oldPolicy),
    ],
  );
  await assert.rejects(
    reg.resend({
      id: value.id,
      proofHash: value.proofHash,
      codeHash: hash("replacement"),
      ipKey: value.ipKey,
    }),
  );
  assert.deepEqual(
    (await db.query("select * from email_registration_rate_events")).rows,
    [],
  );
  assert.equal(
    (
      await db.query("select code_hash from email_registrations where id=$1", [
        value.id,
      ])
    ).rows[0]!.code_hash,
    value.codeHash,
  );
});

test("SQL rejects incomplete snapshots; API can append but cannot rewrite/delete/truncate evidence or grant Worker access", async (t) => {
  const { db, store } = await fixture(t);
  const value = begin();
  for (const choice of [
    {},
    { personalData: true },
    { personalData: true, marketing: false },
  ])
    await assert.rejects(
      db.query(
        `insert into email_registrations(id,email,password_hash,proof_hash,code_hash,recipient_key,expires_at,consent_choice,consent_policy,consent_policy_hash,consent_recorded_at)
      values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes',$7::jsonb,'{}',repeat('a',64),clock_timestamp())`,
        [
          randomUUID(),
          value.email,
          value.passwordHash,
          value.proofHash,
          value.codeHash,
          value.recipientKey,
          JSON.stringify(choice),
        ],
      ),
      /constraint/,
    );
  await db.exec(
    "create role citygo_api nologin;create role citygo_worker nologin;create role citygo_backup nologin;grant usage on schema public to citygo_api,citygo_worker,citygo_backup",
  );
  await db.exec(
    (
      await readFile(
        new URL("../../../deploy/postgres/grants.sql", import.meta.url),
        "utf8",
      )
    ).replace(/^\\set[^\n]*\n/gm, ""),
  );
  await db.exec("set role citygo_api");
  await store.register(
    "runtime@example.test",
    "hash",
    hash("session"),
    syntheticServiceConsents,
  );
  for (const command of [
    "update service_consent_events set decision='granted'",
    "delete from service_consent_events",
    "truncate service_consent_events",
    "update email_registrations set consent_choice='{}'",
  ])
    await assert.rejects(db.exec(command), /permission denied/);
  await db.exec("reset role;set role citygo_worker");
  await assert.rejects(
    db.exec("select * from service_consent_events"),
    /permission denied/,
  );
  await db.exec("reset role");
  for (const command of [
    "update service_consent_events set decision='granted'",
    "delete from service_consent_events",
    "truncate service_consent_events",
  ])
    await assert.rejects(db.exec(command), /append-only/);
});

test("schema29 to30 changes no existing choice/user/accounting/history and adds no consent grant", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await db.exec(
    "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql") && name < "0030")
    .sort())
    await applyFixtureMigration(db, name);
  const user = await seedLegacyVerifiedEmail(db, "upgrade@example.test");
  const before = (
    await db.query("select to_jsonb(u) as value from users u order by id")
  ).rows;
  const legacy = (
    await db.query("select to_jsonb(r) as value from email_registrations r")
  ).rows;
  await migrate(db);
  assert.deepEqual(
    (await db.query("select to_jsonb(u) as value from users u order by id"))
      .rows,
    before,
  );
  assert.deepEqual(
    (
      await db.query(
        "select to_jsonb(r)-'consent_choice'-'consent_policy'-'consent_policy_hash'-'consent_recorded_at' as value from email_registrations r",
      )
    ).rows,
    legacy,
  );
  assert.deepEqual(
    (await db.query("select * from service_consent_events")).rows,
    [],
  );
  assert.equal(
    (await new ServiceConsents(db).state(user.id)).serviceConsentRequired,
    true,
  );
  await migrate(db);
});
