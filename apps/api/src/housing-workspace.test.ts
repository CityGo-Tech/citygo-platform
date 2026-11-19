import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  housingWorkspaceSchema,
} from "@citygo/contracts";
import {
  connectDatabase,
  ensureConversation,
  migrate,
  Repository,
  type Database,
} from "@citygo/db";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";

async function verifyHousingWorkspace(t: TestContext, db: Database) {
  await migrate(db);
  const app = await buildApp({
    db,
    testing: true,
    config: readConfig({
      NODE_ENV: "test",
      DATABASE_URL: "pglite://:memory:",
      WEB_ORIGIN: "http://localhost:3000",
      LLM_PROVIDER: "disabled",
    }),
  });
  t.after(() => app.close());

  const owner = await registerSyntheticConsentingUser(
    db,
    "housing-owner@example.test",
    "synthetic",
    app,
  );
  const other = await registerSyntheticConsentingUser(
    db,
    "housing-other@example.test",
    "synthetic",
    app,
  );
  const repository = new Repository(db);
  const token = randomUUID();
  const otherToken = randomUUID();
  await repository.createSession(owner, tokenHash(token));
  await repository.createSession(other, tokenHash(otherToken));
  const thread = await ensureConversation(db, owner, "housing");
  const foreign = await ensureConversation(db, other, "housing");
  const nonHousing = await ensureConversation(db, owner, "support");
  const request = (
    action: "" | "/plan" | "/checklist",
    body?: object,
    credential: string = token,
    origin?: string,
  ) =>
    app.inject({
      method: action ? "PUT" : "GET",
      url: "/v1/housing/workspace" + action,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        ...(origin
          ? { cookie: "citygo=" + credential, origin }
          : {
              "x-citygo-client": "native",
              ...(credential ? { authorization: "Bearer " + credential } : {}),
            }),
      },
      ...(body ? { payload: body } : {}),
    });

  const initial = {
    expectedRevision: 0,
    threadId: thread.id,
    requestId: randomUUID(),
    criteria: {
      situation: "oriented",
      city: "",
      commute: "Кутузовский проспект",
      budgetRub: null,
    },
  };
  assert.equal((await request("", undefined, "")).statusCode, 401);
  assert.equal(
    (await request("/plan", initial, token, "https://other.example.test"))
      .statusCode,
    403,
  );
  assert.equal(
    (await request("/plan", { ...initial, threadId: foreign.id })).statusCode,
    404,
  );
  assert.equal(
    (await request("/plan", { ...initial, threadId: nonHousing.id }))
      .statusCode,
    404,
  );
  assert.equal(
    (await request("/plan", { ...initial, userId: other })).statusCode,
    400,
  );
  assert.deepEqual((await request("")).json(), {
    userId: owner,
    plan: null,
    checklist: null,
  });

  const first = await request("/plan", initial);
  assert.equal(first.statusCode, 200, first.body);
  const firstPlan = housingWorkspaceSchema.parse(first.json()).plan!;
  assert.equal(firstPlan.revision, 1);
  assert.deepEqual(firstPlan.criteria, initial.criteria);
  assert.deepEqual((await request("")).json(), first.json());
  assert.deepEqual((await request("/plan", initial)).json(), first.json());
  assert.equal(
    (
      await request("/plan", {
        ...initial,
        criteria: { ...initial.criteria, city: "Тула" },
      })
    ).statusCode,
    409,
  );
  assert.deepEqual((await request("", undefined, otherToken)).json(), {
    userId: other,
    plan: null,
    checklist: null,
  });

  const checklist = {
    expectedRevision: 0,
    planRevision: 1,
    selected: ["payment", "inspection"],
    paymentChecked: true,
    requestId: randomUUID(),
  };
  const saved = await request("/checklist", checklist);
  assert.equal(saved.statusCode, 200, saved.body);
  const checklistOne = housingWorkspaceSchema.parse(saved.json()).checklist!;
  assert.equal(checklistOne.revision, 1);
  assert.deepEqual(checklistOne.selected, checklist.selected);
  assert.equal(checklistOne.paymentChecked, true);
  assert.deepEqual(
    (await request("/checklist", checklist)).json(),
    saved.json(),
  );
  assert.equal(
    (await request("/checklist", { ...checklist, paymentChecked: false }))
      .statusCode,
    409,
  );

  // An ordinary new tab can save a new version, but the losing save cannot overwrite it.
  await db.query("update agent_threads set status='closed' where id=$1", [
    thread.id,
  ]);
  const changed = {
    ...initial,
    expectedRevision: 1,
    requestId: randomUUID(),
    criteria: { ...initial.criteria, city: "Москва" },
  };
  const parallel = await Promise.all([
    request("/plan", changed),
    request("/plan", { ...changed, requestId: randomUUID() }),
  ]);
  assert.deepEqual(
    parallel.map((response) => response.statusCode).sort(),
    [200, 409],
  );
  const latest = housingWorkspaceSchema.parse((await request("")).json());
  assert.equal(latest.plan?.revision, 2);
  assert.equal(latest.plan?.threadId, thread.id);
  assert.equal(latest.checklist?.planRevision, 1);
  assert.deepEqual((await request("/plan", initial)).json(), latest);
  assert.deepEqual((await request("/checklist", checklist)).json(), latest);
  const stale = await request("/checklist", {
    ...checklist,
    expectedRevision: 1,
    requestId: randomUUID(),
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, "PLAN_STALE");

  const resaved = await request("/checklist", {
    ...checklist,
    planRevision: 2,
    expectedRevision: 1,
    selected: ["contract"],
    paymentChecked: false,
    requestId: randomUUID(),
  });
  assert.equal(resaved.statusCode, 200, resaved.body);
  assert.equal(resaved.json().checklist.revision, 2);
  assert.equal(resaved.json().checklist.planRevision, 2);
  assert.deepEqual(
    (
      await db.query(
        "select revision from housing_workspace_plans order by revision",
      )
    ).rows,
    [{ revision: 1 }, { revision: 2 }],
  );
  assert.deepEqual(
    (
      await db.query(
        "select revision,plan_revision from housing_workspace_checklists order by revision",
      )
    ).rows,
    [
      { revision: 1, plan_revision: 1 },
      { revision: 2, plan_revision: 2 },
    ],
  );
  assert.equal((await db.query("select 1 from xp_events")).rows.length, 0);
  assert.equal(
    (await db.query("select 1 from ai_model_attempts")).rows.length,
    0,
  );
  assert.equal(
    (await db.query("select 1 from payment_topup_orders")).rows.length,
    0,
  );
}

test("housing recovery, owner isolation and concurrent explicit result saves", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await verifyHousingWorkspace(t, db);
});

test(
  "PostgreSQL serializes housing writes across concurrent requests",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const target = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
    assert.ok(
      ((target.port || "5432") === "5432" &&
        target.pathname === "/citygo_test") ||
        (target.port === "55438" && target.pathname === "/citygo_synthetic"),
    );
    assert.equal(target.search + target.hash, "");
    const admin = await connectDatabase(target.toString());
    const name = "housing_workspace_" + randomUUID().replaceAll("-", "");
    const resource: { database?: Database } = {};
    let created = false;
    t.after(async () => {
      try {
        await resource.database?.close();
        if (created) await admin.query(`drop database "${name}"`);
      } finally {
        await admin.close();
      }
    });
    await admin.query(`create database "${name}" template template0`);
    created = true;
    target.pathname = "/" + name;
    resource.database = await connectDatabase(target.toString());
    await verifyHousingWorkspace(t, resource.database);
  },
);
