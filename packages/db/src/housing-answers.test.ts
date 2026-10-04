import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import {
  connectDatabase,
  migrate,
  HousingAnswers,
  DomainError,
  type Database,
  type HousingBriefSnapshot,
} from "./index.js";
import { r1HousingFieldSchema } from "@citygo/contracts";

async function fixture(t: TestContext, legacy = false) {
  const base = process.env.TEST_DATABASE_URL;
  let db: Database;
  if (base) {
    const url = new URL(base);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    const name = "cg012_test_" + randomUUID().replaceAll("-", "");
    const admin = await connectDatabase(base);
    await admin.query('create database "' + name + '" template template0');
    url.pathname = "/" + name;
    db = await connectDatabase(url.toString());
    t.after(async () => {
      try {
        await db.close();
        await admin.query('drop database "' + name + '"');
      } finally {
        await admin.close();
      }
    });
    t.diagnostic("Backend: isolated PostgreSQL database");
  } else {
    db = await connectDatabase("pglite://:memory:");
    t.after(() => db.close());
  }
  if (legacy) {
    await db.exec(
      "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
    );
    const dir = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith(".sql") && n < "0012")
      .sort()) {
      const sql = await readFile(new URL(name, dir), "utf8");
      await db.exec(sql);
      await db.query(
        "insert into citygo_migrations(name,checksum) values ($1,$2)",
        [
          name,
          createHash("sha256")
            .update(sql.replaceAll("\r\n", "\n"))
            .digest("hex"),
        ],
      );
    }
  } else await migrate(db);
  return db;
}
async function owner(db: Database) {
  const user = (
    await db.query<{ id: string }>(
      "insert into users(auth_subject) values ($1) returning id::text",
      [randomUUID()],
    )
  ).rows[0]!.id;
  const plan = (
    await db.query<{ id: string; version: number }>(
      "insert into relocation_plans(user_id,status,plan) values ($1,'active',$2) returning id::text,version",
      [user, JSON.stringify({ stages: ["housing-brief", "housing-viewing"] })],
    )
  ).rows[0]!;
  return { user, plan };
}
async function setup(t: TestContext) {
  const db = await fixture(t);
  const person = await owner(db);
  const store = new HousingAnswers(db);
  const create = { commandId: randomUUID(), plan: person.plan };
  const brief = await store.create(person.user, create);
  return { db, store, brief, create, ...person };
}
function command(
  brief: HousingBriefSnapshot,
  field = "monthlyRentRub",
  answer: unknown = { status: "known", value: { max: 60000 } },
) {
  const commandId: string = randomUUID();
  return {
    commandId,
    plan: brief.plan,
    brief: { id: brief.id, revision: brief.revision },
    change: {
      field,
      expectedFieldRevision:
        brief.content.answers[field as keyof typeof brief.content.answers]
          .revision,
      answer,
    },
  };
}
function status(n: number, code?: string) {
  return (e: unknown) =>
    e instanceof DomainError &&
    e.statusCode === n &&
    (!code || e.code === code);
}
async function counts(db: Database) {
  return (
    await db.query(`select
    (select count(*)::int from r1_housing_briefs) as briefs,
    (select count(*)::int from r1_housing_commands) as commands,
    (select count(*)::int from r1_housing_brief_revisions) as revisions,
    (select count(*)::int from xp_events) as xp`)
  ).rows[0];
}

test("create: empty draft without profile, questionnaire, consent, model or quest; exact replay", async (t) => {
  const { db, store, user, brief, create } = await setup(t);
  assert.equal(brief.content.starterPlan, null);
  assert.deepEqual(brief.content.suggestions, []);
  for (const value of Object.values(brief.content.answers))
    assert.deepEqual(value, { status: "unasked", revision: 1 });
  assert.deepEqual(await store.create(user, create), brief);
  assert.deepEqual(await store.get(user, brief.id), brief);
  assert.deepEqual(await counts(db), {
    briefs: 1,
    commands: 1,
    revisions: 1,
    xp: 0,
  });
});

test("state one partial answer: server event, immutable snapshot and unchanged other fields", async (t) => {
  const { db, store, user, brief } = await setup(t);
  const request = command(brief);
  const next = await store.stateAnswer(user, request);
  assert.equal(next.revision, 2);
  const rent = next.content.answers.monthlyRentRub;
  assert.equal(rent.status, "known");
  if (rent.status !== "known") throw Error("known answer required");
  assert.deepEqual(rent.value, { max: 60000 });
  assert.equal(rent.revision, 2);
  assert.equal(rent.provenance.kind, "user_stated");
  assert.notEqual(rent.provenance.eventId, request.commandId);
  const event = (
    await db.query<{
      event_id: string;
      actor: string;
      source: string;
      field: string;
      before_answer: unknown;
      after_answer: unknown;
    }>(
      "select event_id,actor,source,field,before_answer,after_answer from r1_housing_commands where command_id=$1",
      [request.commandId],
    )
  ).rows[0]!;
  assert.equal(event.event_id, rent.provenance.eventId);
  assert.equal(event.actor, "user");
  assert.equal(event.source, "explicit_command");
  assert.equal(event.field, "monthlyRentRub");
  assert.deepEqual(event.before_answer, brief.content.answers.monthlyRentRub);
  assert.deepEqual(event.after_answer, rent);
  for (const field of r1HousingFieldSchema.options.filter(
    (f) => f !== "monthlyRentRub",
  ))
    assert.deepEqual(next.content.answers[field], brief.content.answers[field]);
  assert.deepEqual(await store.get(user, brief.id, 1), brief);
  assert.deepEqual(await counts(db), {
    briefs: 1,
    commands: 2,
    revisions: 2,
    xp: 0,
  });
});

test("known → undecided → declined; no explanation required, revisions never reset", async (t) => {
  const { store, user, brief } = await setup(t);
  let next = await store.stateAnswer(user, command(brief));
  for (const state of ["undecided", "declined"] as const) {
    const prev = next;
    next = await store.stateAnswer(
      user,
      command(prev, "monthlyRentRub", { status: state }),
    );
    assert.equal(next.content.answers.monthlyRentRub.status, state);
    assert.equal(
      next.content.answers.monthlyRentRub.revision,
      prev.content.answers.monthlyRentRub.revision + 1,
    );
  }
  assert.equal(next.revision, 4);
  assert.ok(!("value" in next.content.answers.monthlyRentRub));
});

test("per-field partial values, unknowns and optional not_applicable are supported", async (t) => {
  const { store, user, brief } = await setup(t);
  let next = brief;
  for (const [field, answer] of [
    ["monthlyRentRub", { status: "known", value: { min: 40000 } }],
    [
      "moveTiming",
      { status: "known", value: { kind: "month", month: "2026-11" } },
    ],
    [
      "niceToHave",
      { status: "known", value: { items: [], completeness: "open" } },
    ],
    ["commuteMaxMinutes", { status: "not_applicable" }],
  ] as const)
    next = await store.stateAnswer(user, command(next, field, answer));
  assert.deepEqual(next.content.answers.household, {
    status: "unasked",
    revision: 1,
  });
  assert.equal(next.content.answers.moveTiming.revision, 2);
});

test("replay returns original revision after further edits, normalized JSON and UUID casing", async (t) => {
  const { db, store, user, brief } = await setup(t);
  const request = command(brief, "priority", {
    status: "undecided",
    note: undefined,
  });
  request.commandId = request.commandId.toUpperCase();
  const first = await store.stateAnswer(user, request);
  await store.stateAnswer(
    user,
    command(first, "priority", { status: "known", value: "prepare_search" }),
  );
  assert.deepEqual(
    await store.stateAnswer(user, {
      ...request,
      commandId: request.commandId.toLowerCase(),
    }),
    first,
  );
  assert.deepEqual(await counts(db), {
    briefs: 1,
    commands: 3,
    revisions: 3,
    xp: 0,
  });
});

test("command reuse for different action/body conflicts and creates no event", async (t) => {
  const { db, store, user, brief, create } = await setup(t);
  const request = command(brief);
  await assert.rejects(
    store.stateAnswer(user, { ...request, commandId: create.commandId }),
    status(409),
  );
  await store.stateAnswer(user, request);
  await assert.rejects(
    store.stateAnswer(user, {
      ...request,
      change: { ...request.change, answer: { status: "declined" } },
    }),
    status(409),
  );
  assert.deepEqual(await counts(db), {
    briefs: 1,
    commands: 2,
    revisions: 2,
    xp: 0,
  });
});

test("stale artifact or field revision conflicts without overwriting history", async (t) => {
  const { db, store, user, brief } = await setup(t);
  const next = await store.stateAnswer(user, command(brief));
  await assert.rejects(
    store.stateAnswer(user, command(brief)),
    status(409, "REVISION_CONFLICT"),
  );
  const wrongField = command(next);
  wrongField.change.expectedFieldRevision = 1;
  await assert.rejects(
    store.stateAnswer(user, wrongField),
    status(409, "REVISION_CONFLICT"),
  );
  assert.deepEqual(await counts(db), {
    briefs: 1,
    commands: 2,
    revisions: 2,
    xp: 0,
  });
});

test("another owner cannot read, change, replay or bind a foreign plan", async (t) => {
  const { db, store, user, brief, create } = await setup(t);
  const stranger = await owner(db);
  await assert.rejects(store.get(stranger.user, brief.id), status(404));
  await assert.rejects(store.create(stranger.user, create), status(404));
  await assert.rejects(
    store.stateAnswer(stranger.user, command(brief)),
    status(404),
  );
  await assert.rejects(
    store.stateAnswer(stranger.user, {
      ...command(brief),
      plan: stranger.plan,
    }),
    status(404),
  );
  assert.deepEqual(await store.get(user, brief.id), brief);
  assert.deepEqual(await counts(db), {
    briefs: 1,
    commands: 1,
    revisions: 1,
    xp: 0,
  });
});

test("plan replacement blocks writes; owned historical read and exact replay remain valid", async (t) => {
  const { db, store, user, brief, plan, create } = await setup(t);
  const request = command(brief);
  const next = await store.stateAnswer(user, request);
  await db.query("update relocation_plans set status='archived' where id=$1", [
    plan.id,
  ]);
  await db.query(
    "insert into relocation_plans(user_id,version,status,plan) values ($1,2,'active','{}')",
    [user],
  );
  await assert.rejects(
    store.stateAnswer(user, command(next)),
    status(409, "PLAN_STALE"),
  );
  await assert.rejects(
    store.create(user, { ...create, commandId: randomUUID() }),
    status(409, "PLAN_STALE"),
  );
  const foreign = await owner(db);
  const foreignBrief = await store.create(foreign.user, {
    commandId: randomUUID(),
    plan: foreign.plan,
  });
  await assert.rejects(
    store.stateAnswer(user, { ...command(foreignBrief), plan }),
    status(404),
    "Foreign ownership is checked before disclosing a stale-plan conflict",
  );
  assert.deepEqual(await store.stateAnswer(user, request), next);
  assert.deepEqual(await store.create(user, create), brief);
  assert.deepEqual(await store.get(user, brief.id), next);
});

test("client provenance, actor, revisions, assumptions and invalid typed values are rejected", async (t) => {
  const { db, store, user, brief } = await setup(t);
  for (const answer of [
    {
      status: "known",
      value: { max: 60000 },
      provenance: { kind: "user_stated", eventId: randomUUID() },
    },
    { status: "known", value: { max: 60000 }, revision: 2 },
    { status: "unasked" },
    { status: "not_applicable" },
    { status: "known", value: { min: 70000, max: 60000 } },
    { status: "known", value: { max: "60000" } },
    { status: "declined", note: "bad\nline" },
  ])
    await assert.rejects(
      store.stateAnswer(user, command(brief, "monthlyRentRub", answer)),
      status(400),
    );
  await assert.rejects(
    store.stateAnswer(user, { ...command(brief), actor: "user" }),
    status(400),
  );
  await assert.rejects(
    store.create(user, {
      commandId: randomUUID(),
      plan: brief.plan,
      answers: brief.content.answers,
    }),
    status(400),
  );
  await assert.rejects(store.get(user, "01"), status(400));
  assert.deepEqual(await counts(db), {
    briefs: 1,
    commands: 1,
    revisions: 1,
    xp: 0,
  });
});

test("parallel writes use CAS: one winner; parallel exact retries have one event", async (t) => {
  const { db, store, user, brief } = await setup(t);
  const results = await Promise.allSettled([
    store.stateAnswer(user, command(brief)),
    store.stateAnswer(
      user,
      command(brief, "household", { status: "known", value: "family" }),
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failure = results.find((r) => r.status === "rejected");
  assert.ok(
    failure?.status === "rejected" &&
      status(409, "REVISION_CONFLICT")(failure.reason),
  );
  const next = await store.get(user, brief.id);
  const request = command(next, "stage", {
    status: "known",
    value: "exploring",
  });
  const retries = await Promise.all([
    store.stateAnswer(user, request),
    store.stateAnswer(user, request),
  ]);
  assert.deepEqual(retries[0], retries[1]);
  assert.deepEqual(await counts(db), {
    briefs: 1,
    commands: 3,
    revisions: 3,
    xp: 0,
  });
});

test("parallel creation retries return one permanent identity and one event", async (t) => {
  const db = await fixture(t);
  const { user, plan } = await owner(db);
  const store = new HousingAnswers(db);
  const request = { commandId: randomUUID(), plan };
  const [first, retry] = await Promise.all([
    store.create(user, request),
    store.create(user, request),
  ]);
  assert.deepEqual(first, retry);
  assert.deepEqual(await counts(db), {
    briefs: 1,
    commands: 1,
    revisions: 1,
    xp: 0,
  });
});

test("INT4 artifact/field revision exhaustion fails closed without wrapping or writing", async (t) => {
  const { db, store, user, plan } = await setup(t);
  for (const [artifactRevision, fieldRevision] of [
    [2147483647, 2],
    [2, 2147483647],
  ] as const) {
    const brief = await store.create(user, { commandId: randomUUID(), plan });
    const eventId = randomUUID();
    const after = {
      status: "undecided",
      revision: fieldRevision,
      provenance: { kind: "user_stated", eventId },
    };
    const content = {
      ...brief.content,
      answers: { ...brief.content.answers, monthlyRentRub: after },
    };
    // Synthetic boundary fixture; history is still appended, never updated.
    await db.transaction(async (tx) => {
      await tx.query(
        `insert into r1_housing_commands(user_id,command_id,event_id,action,actor,source,request,brief_id,result_revision,field,before_answer,after_answer)
        values ($1,$2,$3,'state_answer','user','explicit_command','{}',$4,$5,'monthlyRentRub',$6,$7)`,
        [
          user,
          randomUUID(),
          eventId,
          brief.id,
          artifactRevision,
          JSON.stringify(brief.content.answers.monthlyRentRub),
          JSON.stringify(after),
        ],
      );
      await tx.query(
        "insert into r1_housing_brief_revisions(brief_id,revision,event_id,content) values ($1,$2,$3,$4)",
        [brief.id, artifactRevision, eventId, JSON.stringify(content)],
      );
    });
    const current = await store.get(user, brief.id);
    const before = await counts(db);
    await assert.rejects(
      store.stateAnswer(user, command(current)),
      status(409, "REVISION_CONFLICT"),
    );
    assert.deepEqual(await counts(db), before);
    assert.deepEqual(await store.get(user, brief.id), current);
  }
});

test("a command cannot commit without its own matching event/result snapshot", async (t) => {
  const { db, user, brief } = await setup(t);
  for (const revision of [1, 2]) {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query(
          `insert into r1_housing_commands(user_id,command_id,event_id,action,actor,source,request,brief_id,result_revision,field,before_answer,after_answer)
        values ($1,$2,$3,$4,'user','explicit_command','{}',$5,$6,$7,$8,$9)`,
          [
            user,
            randomUUID(),
            randomUUID(),
            revision === 1 ? "create_brief" : "state_answer",
            brief.id,
            revision,
            revision === 1 ? null : "stage",
            revision === 1 ? null : "{}",
            revision === 1 ? null : "{}",
          ],
        );
      }),
      /foreign key/,
    );
  }
  assert.deepEqual(await counts(db), {
    briefs: 1,
    commands: 1,
    revisions: 1,
    xp: 0,
  });
});

test("failure after journal insert rolls back both event and snapshot; retry succeeds", async (t) => {
  const { db, store, user, brief } = await setup(t);
  await db.exec(`create function cg012_fail_insert() returns trigger language plpgsql as $$
    begin raise exception 'synthetic failure'; end $$;
    create trigger cg012_fail before insert on r1_housing_brief_revisions for each row execute function cg012_fail_insert();`);
  const request = command(brief);
  await assert.rejects(store.stateAnswer(user, request), /synthetic failure/);
  assert.deepEqual(await counts(db), {
    briefs: 1,
    commands: 1,
    revisions: 1,
    xp: 0,
  });
  await db.exec(
    "drop trigger cg012_fail on r1_housing_brief_revisions; drop function cg012_fail_insert()",
  );
  assert.equal((await store.stateAnswer(user, request)).revision, 2);
});

test("SQL prevents changing permanent identity, content or provenance event", async (t) => {
  const { db, brief } = await setup(t);
  for (const sql of [
    "update r1_housing_briefs set plan_version=2",
    "update r1_housing_brief_revisions set content='{}'",
    "update r1_housing_commands set source='explicit_command'",
  ])
    await assert.rejects(db.query(sql), /CG012_IMMUTABLE_HISTORY/);
  const foreign = await owner(db);
  await assert.rejects(
    db.query(
      "insert into r1_housing_briefs(user_id,plan_id,plan_version) values ($1,$2,$3)",
      [foreign.user, brief.plan.id, brief.plan.version],
    ),
    /foreign key/,
  );
});

test("upgrade 0011 → 0012 preserves populated records, is replay-safe and grants no R1 runtime access", async (t) => {
  const db = await fixture(t, true);
  const { user, plan } = await owner(db);
  await db.query(
    "insert into ai_credit_accounts(user_id,granted_micros) values ($1,500000000)",
    [user],
  );
  const before = (
    await db.query(
      "select to_jsonb(p) as row from relocation_plans p where id=$1",
      [plan.id],
    )
  ).rows;
  await migrate(db);
  await migrate(db);
  assert.deepEqual(
    (
      await db.query(
        "select to_jsonb(p) as row from relocation_plans p where id=$1",
        [plan.id],
      )
    ).rows,
    before,
  );
  assert.equal(
    (
      await db.query<{ value: string }>(
        "select granted_micros::text as value from ai_credit_accounts where user_id=$1",
        [user],
      )
    ).rows[0]!.value,
    "500000000",
  );
  assert.deepEqual(await counts(db), {
    briefs: 0,
    commands: 0,
    revisions: 0,
    xp: 0,
  });
  assert.equal(
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from citygo_migrations",
      )
    ).rows[0]!.n,
    12,
  );
  const store = new HousingAnswers(db);
  assert.equal(
    (await store.create(user, { commandId: randomUUID(), plan })).revision,
    1,
  );
  // Match production bootstrap default privileges before running grants.sql.
  await db.exec(
    "create role cg012_api nologin; grant usage on schema public to cg012_api",
  );
  assert.equal(
    (
      await db.query<{ allowed: boolean }>(
        "select has_table_privilege('cg012_api','r1_housing_brief_revisions','INSERT') as allowed",
      )
    ).rows[0]!.allowed,
    false,
  );
});
