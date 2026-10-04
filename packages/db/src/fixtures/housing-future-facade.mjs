// Isolated process fixture: replace the actual public contract bindings before
// importing the real repository/reader. Do not change v1 or production modules.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { z } from "zod";
import * as original from "@citygo/contracts";

const currentCreate = original.r1HousingBriefCreateCommandSchema.extend({
  protocol: z.literal(2),
});
const currentAnswer = original.r1HousingAnswerCommandSchema.refine(
  (request) => request.change.answer.status === "known",
  "Hypothetical future input requires a known answer",
);
const currentDraft = original.r1HousingBriefDraftSchema.transform(
  (content) => ({
    ...content,
    schemaVersion: 2,
  }),
);
mock.module("@citygo/contracts", {
  namedExports: {
    ...original,
    r1HousingBriefCreateCommandSchema: currentCreate,
    r1HousingAnswerCommandSchema: currentAnswer,
    r1HousingBriefDraftSchema: currentDraft,
    r1HousingIdSchema: z.literal("999999"),
    r1HousingRevisionSchema: z.literal(999999),
    createR1HousingAnswers: () => {
      throw new Error("The current helper must not be used by the v1 writer");
    },
  },
});

const changed = await import("@citygo/contracts");
assert.equal(changed.r1HousingBriefDraftSchema, currentDraft);
assert.equal(changed.r1HousingBriefCreateCommandSchema, currentCreate);
assert.equal(changed.r1HousingAnswerCommandSchema, currentAnswer);
const { connectDatabase, migrate, HousingAnswers, DomainError } =
  await import("../index.ts");
const { readStoredHousingBrief } = await import("../housing-history.ts");

const base = process.env.TEST_DATABASE_URL;
let admin;
let db;
let name;
try {
  if (base) {
    const url = new URL(base);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    name = "cg012_facade_" + randomUUID().replaceAll("-", "");
    admin = await connectDatabase(base);
    await admin.query('create database "' + name + '" template template0');
    url.pathname = "/" + name;
    db = await connectDatabase(url.toString());
  } else db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const user = (
    await db.query(
      "insert into users(auth_subject) values ($1) returning id::text",
      [randomUUID()],
    )
  ).rows[0].id;
  const plan = (
    await db.query(
      "insert into relocation_plans(user_id,status,plan) values ($1,'active','{}') returning id::text,version",
      [user],
    )
  ).rows[0];
  const store = new HousingAnswers(db);
  const create = { commandId: randomUUID(), plan };
  assert.equal(currentCreate.safeParse(create).success, false);
  const brief = await store.create(user, create);
  assert.equal(brief.content.schemaVersion, 1);
  assert.equal(currentDraft.parse(brief.content).schemaVersion, 2);
  assert.deepEqual(readStoredHousingBrief(brief.content), brief.content);

  const request = {
    commandId: randomUUID(),
    plan,
    brief: { id: brief.id, revision: 1 },
    change: {
      field: "priority",
      expectedFieldRevision: 1,
      answer: { status: "undecided", note: "Я пока изучаю варианты" },
    },
  };
  assert.equal(currentAnswer.safeParse(request).success, false);
  const stated = await store.stateAnswer(user, request);
  assert.equal(stated.content.schemaVersion, 1);
  assert.equal(stated.content.answers.priority.status, "undecided");
  const corrected = await store.stateAnswer(user, {
    ...request,
    commandId: randomUUID(),
    brief: { id: brief.id, revision: 2 },
    change: {
      ...request.change,
      expectedFieldRevision: 2,
      answer: { status: "declined" },
    },
  });
  assert.equal(corrected.content.schemaVersion, 1);
  await db.query("update relocation_plans set status='archived' where id=$1", [
    plan.id,
  ]);
  assert.deepEqual(await store.create(user, create), brief);
  assert.deepEqual(await store.stateAnswer(user, request), stated);
  assert.deepEqual(await store.get(user, brief.id), corrected);
  assert.deepEqual(await store.recoverForPlan(user, plan), {
    status: "recovered",
    brief: corrected,
  });
  assert.deepEqual((await store.history(user, brief.id)).items, [
    corrected,
    stated,
    brief,
  ]);
  await assert.rejects(
    store.stateAnswer(user, {
      ...request,
      change: { ...request.change, answer: { status: "declined" } },
    }),
    (error) => error instanceof DomainError && error.statusCode === 409,
  );
  assert.deepEqual(
    (
      await db.query(`select
    (select count(*)::int from r1_housing_briefs) as briefs,
    (select count(*)::int from r1_housing_commands) as commands,
    (select count(*)::int from r1_housing_brief_revisions) as revisions,
    (select count(*)::int from xp_events) as xp`)
    ).rows[0],
    { briefs: 1, commands: 3, revisions: 3, xp: 0 },
  );
  console.log(
    "Facade substitution: v1 read/create/edit/replay PASS; backend=" +
      (base ? "PostgreSQL" : "PGlite"),
  );
} finally {
  try {
    if (db) await db.close();
    if (admin && name) await admin.query('drop database "' + name + '"');
  } finally {
    if (admin) await admin.close();
    mock.restoreAll();
  }
}
