import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  connectDatabase,
  EmailRegistration,
  migrate,
  PersonalPlan,
} from "./index.js";
import {
  captureRestartRows,
  migrateLegacyRestartFixture,
  seedRestartFixture,
} from "./closed-account-restart-fixture.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
test("schema28 to29 preserves all61 old tables and19 sequences, adds only an empty private plan and receipt, and replays the migration unchanged", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrateLegacyRestartFixture(db);
  await seedRestartFixture(db);
  await db.exec(
    "create table citygo_migration_lock(id integer primary key); insert into citygo_migration_lock values(1)",
  );
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter(
      (name) =>
        name.endsWith(".sql") &&
        name > "0015_yookassa_orders.sql" &&
        name < "0029_personal_plan.sql",
    )
    .sort()) {
    const sql = await readFile(new URL(name, directory), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""));
      await tx.query(
        "insert into citygo_migrations(name,checksum) values($1,$2)",
        [name, hash(sql.replaceAll("\r\n", "\n"))],
      );
    });
  }
  // Exercise preservation of the newer auth tables as well as the fixture's
  // historical paid lots, model attempts, chats, profile, quests and sessions.
  const email = new EmailRegistration(db),
    id = randomUUID();
  await email.begin({
    id,
    email: "plan-upgrade-verified@example.test",
    passwordHash: "synthetic-hash",
    proofHash: hash("proof"),
    codeHash: hash("code"),
    recipientKey: hash("recipient"),
    ipKey: hash("ip"),
  });
  await email.markSent(id, hash("code"));
  const verified = await email.confirm({
    id,
    proofHash: hash("proof"),
    codeHash: hash("code"),
    sessionHash: hash("session"),
  });
  await db.query(
    `insert into password_recovery_challenges(id,proof_hash,code_hash,recipient_key,expires_at)
    values($1,$2,$3,$4,clock_timestamp()+interval '10 minutes')`,
    [
      randomUUID(),
      hash("recovery-proof"),
      hash("recovery-code"),
      hash("recovery-recipient"),
    ],
  );
  const before = await captureRestartRows(db);
  const sequences = (
    await db.query<{ sequencename: string; last_value: string | null }>(
      "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
    )
  ).rows;
  assert.equal(Object.keys(before).length, 61);
  assert.equal(before.citygo_migrations!.length, 28);
  assert.equal(sequences.length, 19);
  await migrate(db);
  const after = await captureRestartRows(db);
  for (const [name, rows] of Object.entries(before))
    assert.deepEqual(
      name === "citygo_migrations" ? after[name]!.slice(0, 28) : after[name],
      rows,
      name,
    );
  assert.deepEqual(
    Object.keys(after).filter((name) => !(name in before)),
    ["personal_plan_items"],
  );
  assert.deepEqual(after.personal_plan_items, []);
  assert.equal(after.citygo_migrations!.length, 29);
  const sql = await readFile(
    new URL("0029_personal_plan.sql", directory),
    "utf8",
  );
  assert.deepEqual(
    (
      await db.query(
        "select name,checksum from citygo_migrations where name='0029_personal_plan.sql'",
      )
    ).rows,
    [
      {
        name: "0029_personal_plan.sql",
        checksum: hash(sql.replaceAll("\r\n", "\n")),
      },
    ],
  );
  const afterSequences = (
    await db.query<{ sequencename: string; last_value: string | null }>(
      "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
    )
  ).rows;
  assert.deepEqual(
    afterSequences.filter(
      (row) => row.sequencename !== "personal_plan_items_id_seq",
    ),
    sequences,
  );
  assert.deepEqual(
    afterSequences.filter(
      (row) => row.sequencename === "personal_plan_items_id_seq",
    ),
    [{ sequencename: "personal_plan_items_id_seq", last_value: null }],
  );
  assert.deepEqual((await new PersonalPlan(db).list(verified.id)).items, []);
  await migrate(db);
  assert.deepEqual(await captureRestartRows(db), after);
  assert.deepEqual(
    (
      await db.query(
        "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
      )
    ).rows,
    afterSequences,
  );
});
