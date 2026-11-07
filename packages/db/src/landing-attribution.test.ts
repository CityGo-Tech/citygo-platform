import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import {
  connectDatabase,
  migrate,
  EmailRegistration,
  ServiceConsents,
  Repository,
  type Database,
} from "./index.js";
import { recordUserAcquisition } from "./landing-attribution.js";
import {
  consentPolicyHash,
  readServiceConsentContext,
} from "./service-consent-context.js";
import { syntheticServiceConsents } from "./test-service-consents.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const attribution = {
  landingVersion: "v8" as const,
  source: "vk",
  medium: "cpc",
  campaignId: "synthetic-launch",
  content: "decision",
};
function input(email = "synthetic-attribution@example.test") {
  return {
    id: randomUUID(),
    email,
    passwordHash: "synthetic-hash",
    proofHash: hash("proof"),
    codeHash: hash("code"),
    recipientKey: hash(email),
    ipKey: hash("synthetic-ip"),
    consents: syntheticServiceConsents,
  };
}
function proof(value: ReturnType<typeof input>, codeHash = value.codeHash) {
  return {
    id: value.id,
    proofHash: value.proofHash,
    codeHash,
    sessionHash: hash(value.id),
  };
}
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  return { db, store: new EmailRegistration(db) };
}
async function acquired(db: Database, userId?: string) {
  return (
    await db.query<{ user_id: string; landing_attribution: unknown }>(
      "select user_id::text,landing_attribution from user_acquisition" +
        (userId ? " where user_id=$1" : "") +
        " order by user_id",
      userId ? [userId] : [],
    )
  ).rows;
}

test("OTP binds the immutable pending snapshot once, with no account or acquisition before confirmation", async (t) => {
  const { db, store } = await fixture(t);
  const value = { ...input(), landingAttribution: { ...attribution } };
  await store.begin(value);
  value.landingAttribution.content = "changed-after-begin";
  assert.deepEqual(await acquired(db), []);
  await assert.rejects(store.confirm(proof(value)));
  await assert.rejects(
    db.query("update email_registrations set landing_attribution=$1::jsonb", [
      JSON.stringify({ landingVersion: "v1" }),
    ]),
  );
  await store.markSent(value.id, value.codeHash);
  const user = await store.confirm(proof(value));
  assert.equal(user.role, "user");
  assert.deepEqual(await acquired(db), [
    { user_id: user.id, landing_attribution: attribution },
  ]);
  await assert.rejects(store.confirm(proof(value)));
  await assert.rejects(
    db.query("update user_acquisition set landing_attribution=null"),
  );
  await assert.rejects(db.query("update user_acquisition set user_id=999"));
  await assert.rejects(
    recordUserAcquisition(db, user.id, { landingVersion: "v1" }),
  );
  assert.deepEqual(await acquired(db), [
    { user_id: user.id, landing_attribution: attribution },
  ]);
  const columns = (
    await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='user_acquisition' order by ordinal_position",
    )
  ).rows.map((r) => r.column_name);
  assert.deepEqual(columns, ["user_id", "landing_attribution", "created_at"]);
});

test("resending only replaces the OTP; a second pending challenge cannot relabel the winner", async (t) => {
  const { db, store } = await fixture(t);
  const first = { ...input(), landingAttribution: attribution };
  await store.begin(first);
  await db.query(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 minutes'",
  );
  const nextCode = hash("replacement-code");
  await store.resend({
    id: first.id,
    proofHash: first.proofHash,
    codeHash: nextCode,
    ipKey: first.ipKey,
  });
  await store.markSent(first.id, nextCode);
  await assert.rejects(store.confirm(proof(first)));
  const second = {
    ...input(first.email),
    landingAttribution: { landingVersion: "v1" as const },
  };
  await db.query(
    "update email_registration_rate_events set created_at=clock_timestamp()-interval '2 minutes'",
  );
  await store.begin(second);
  await store.markSent(second.id, second.codeHash);
  const results = await Promise.allSettled([
    store.confirm(proof(first, nextCode)),
    store.confirm(proof(second)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await acquired(db)).length, 1);
  const winningUser = results[0];
  assert.equal(winningUser.status, "fulfilled");
  assert.deepEqual((await acquired(db))[0]?.landing_attribution, attribution);
});

test("legacy creation fixes attributed and unattributed first touch; old accounts cannot be labelled later", async (t) => {
  const { db } = await fixture(t);
  const store = new ServiceConsents(db);
  const without = await store.register(
    "synthetic-no-source@example.test",
    "hash",
    hash("one"),
    syntheticServiceConsents,
  );
  const withSource = await store.register(
    "synthetic-source@example.test",
    "hash",
    hash("two"),
    syntheticServiceConsents,
    attribution,
  );
  assert.deepEqual(await acquired(db), [
    { user_id: without.id, landing_attribution: null },
    { user_id: withSource.id, landing_attribution: attribution },
  ]);
  await assert.rejects(
    store.register(
      withSource.email!,
      "different-hash",
      hash("three"),
      syntheticServiceConsents,
      { landingVersion: "v1" },
    ),
  );
  const oldId = await new Repository(db).register(
    "synthetic-historical@example.test",
    "hash",
  );
  await assert.rejects(recordUserAcquisition(db, oldId, attribution));
  assert.deepEqual(await acquired(db, oldId), []);
});

test("creation failure rolls back acquisition with user/session/consumption, and a retry binds the original snapshot", async (t) => {
  const { db, store } = await fixture(t);
  const value = { ...input(), landingAttribution: attribution };
  await store.begin(value);
  await store.markSent(value.id, value.codeHash);
  const broken: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          exec: (sql) => tx.exec(sql),
          query: (sql, params) => {
            if (sql.startsWith("insert into sessions"))
              throw new Error("synthetic commit failure");
            return tx.query(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    new EmailRegistration(broken).confirm(proof(value)),
    /synthetic commit failure/,
  );
  assert.deepEqual(await acquired(db), []);
  assert.equal((await db.query("select 1 from users")).rows.length, 0);
  assert.equal(
    (
      await db.query<{ consumed_user_id: string | null }>(
        "select consumed_user_id from email_registrations",
      )
    ).rows[0]?.consumed_user_id,
    null,
  );
  await store.confirm(proof(value));
  assert.deepEqual((await acquired(db))[0]?.landing_attribution, attribution);
  const legacyBroken: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          exec: (sql) => tx.exec(sql),
          query: (sql, params) => {
            if (sql.startsWith("insert into sessions"))
              throw new Error("synthetic legacy failure");
            return tx.query(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    new ServiceConsents(legacyBroken).register(
      "synthetic-rollback@example.test",
      "hash",
      hash("legacy"),
      syntheticServiceConsents,
      { landingVersion: "v1" },
    ),
    /synthetic legacy failure/,
  );
  assert.equal((await acquired(db)).length, 1);
  assert.equal((await db.query("select 1 from users")).rows.length, 1);
});

test("database independently rejects arbitrary metadata and API grants permit no relabel/delete/Worker access", async (t) => {
  const { db } = await fixture(t);
  for (const value of [
    { landingVersion: "v1", url: "https://example.test/private" },
    { landingVersion: "v8", source: "email@example.test" },
    { landingVersion: "v8", content: "safe\n" },
    { source: "vk" },
    [],
  ])
    await assert.rejects(
      db.transaction(async (tx) => {
        const user = (
          await tx.query<{ id: string }>(
            "insert into users(auth_subject)values($1)returning id::text",
            [randomUUID()],
          )
        ).rows[0]!;
        await tx.query(
          "insert into user_acquisition(user_id,landing_attribution)values($1,$2::jsonb)",
          [user.id, JSON.stringify(value)],
        );
      }),
    );
  assert.equal((await db.query("select 1 from users")).rows.length, 0);
  const grants = await readFile(
    new URL("../../../deploy/postgres/grants.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    grants,
    /grant select, insert on user_acquisition to citygo_api;/,
  );
  assert.doesNotMatch(
    grants,
    /grant[^;]*(?:update|delete|truncate)[^;]*user_acquisition/i,
  );
  assert.doesNotMatch(
    grants,
    /grant[^;]*user_acquisition[^;]*to citygo_worker/i,
  );
  assert.doesNotMatch(grants, /grant update[^;]*landing_attribution/i);
});

test("49→50 preserves existing rows; an old pending challenge confirms with null attribution", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/", import.meta.url);
  await db.exec(
    "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir(directory))
    .filter(
      (name) => name.endsWith(".sql") && name < "0050_landing_attribution.sql",
    )
    .sort()) {
    const sql = await readFile(new URL(name, directory), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""));
      await tx.query(
        "insert into citygo_migrations(name,checksum)values($1,$2)",
        [name, hash(sql.replaceAll("\r\n", "\n"))],
      );
    });
  }
  await new Repository(db).register(
    "synthetic-before50@example.test",
    "synthetic-hash",
  );
  const oldUsers = (await db.query("select * from users order by id")).rows;
  const value = input("synthetic-old-pending@example.test");
  const context = await readServiceConsentContext(db);
  await db.query(
    "insert into email_registrations(id,email,password_hash,proof_hash,code_hash,recipient_key,delivery,expires_at,consent_choice,consent_policy,consent_policy_hash,consent_recorded_at)values($1,$2,$3,$4,$5,$6,'sent',clock_timestamp()+interval '10 minutes',$7::jsonb,$8::jsonb,$9,clock_timestamp())",
    [
      value.id,
      value.email,
      value.passwordHash,
      value.proofHash,
      value.codeHash,
      value.recipientKey,
      JSON.stringify({
        policyVersion: context.policy.version,
        personalData: true,
        marketing: false,
      }),
      JSON.stringify(context.policy),
      consentPolicyHash(context.policy),
    ],
  );
  const beforePending = (await db.query("select * from email_registrations"))
    .rows[0];
  const oldChecksums = (
    await db.query("select name,checksum from citygo_migrations order by name")
  ).rows;
  await migrate(db);
  assert.deepEqual(
    (await db.query("select * from users order by id")).rows,
    oldUsers,
  );
  const afterPending = (
    await db.query<Record<string, unknown>>("select * from email_registrations")
  ).rows[0]!;
  const { landing_attribution, ...preserved } = afterPending;
  assert.equal(landing_attribution, null);
  assert.deepEqual(preserved, beforePending);
  assert.deepEqual(
    (
      await db.query(
        "select name,checksum from citygo_migrations where name<'0050' order by name",
      )
    ).rows,
    oldChecksums,
  );
  assert.deepEqual(await acquired(db), []);
  const user = await new EmailRegistration(db).confirm(proof(value));
  assert.deepEqual(await acquired(db), [
    { user_id: user.id, landing_attribution: null },
  ]);
});

test("deployed ACLs allow creation/read but prevent API relabel/erase and Worker reads; owner purge removes metadata", async (t) => {
  const { db } = await fixture(t);
  await db.exec(
    "create role citygo_api nologin;create role citygo_worker nologin;create role citygo_backup nologin;grant usage on schema public to citygo_api,citygo_worker,citygo_backup",
  );
  const grants = await readFile(
    new URL("../../../deploy/postgres/grants.sql", import.meta.url),
    "utf8",
  );
  await db.exec(grants.replace(/^\\set[^\n]*\n/gm, ""));
  await db.exec("set role citygo_api");
  const user = await new ServiceConsents(db).register(
    "synthetic-runtime-source@example.test",
    "synthetic-hash",
    hash("runtime-session"),
    syntheticServiceConsents,
    attribution,
  );
  assert.deepEqual(await acquired(db), [
    { user_id: user.id, landing_attribution: attribution },
  ]);
  for (const command of [
    "update user_acquisition set landing_attribution=null",
    "delete from user_acquisition",
    "truncate user_acquisition",
    "update email_registrations set landing_attribution=null",
  ])
    await assert.rejects(db.exec(command), /permission denied/);
  await db.exec("reset role;set role citygo_worker");
  await assert.rejects(
    db.exec("select * from user_acquisition"),
    /permission denied/,
  );
  await db.exec("reset role");
  // Explicit owner maintenance can erase the metadata; runtime cannot.
  await db.query("delete from user_acquisition where user_id=$1", [user.id]);
  assert.deepEqual(await acquired(db), []);
});
