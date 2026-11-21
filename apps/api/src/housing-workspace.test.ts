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
  await db.query(
    "insert into messenger_accounts(provider,subject,user_id) values('max',12345,$1)",
    [owner],
  );
  await db.query(
    "insert into sessions(token_hash,user_id,expires_at,messenger_provider) values($1,$2,now()+interval '1 day','max')",
    [tokenHash(token), owner],
  );
  await repository.createSession(other, tokenHash(otherToken));
  const thread = await ensureConversation(db, owner, "housing");
  const foreign = await ensureConversation(db, other, "housing");
  const nonHousing = await ensureConversation(db, owner, "support");
  const request = (
    action: "" | "/plan" | "/checklist" | "/checklist/confirmation",
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
  assert.deepEqual(
    (
      await db.query(
        "select count(*)::integer as total, count(user_id)::integer as identified from analytics_events where name='mini_max_step_saved'",
      )
    ).rows,
    [{ total: 4, identified: 0 }],
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

  // Confirm only a displayed checklist, with an explicit owner action.
  const confirmPath = "/checklist/confirmation";
  const confirmation = {
    expectedRevision: 2,
    planRevision: 3,
    requestId: randomUUID(),
    reviewed: true,
  };
  const commuteOnly = {
    ...changed,
    expectedRevision: 2,
    requestId: randomUUID(),
    criteria: { ...changed.criteria, commute: "Парк Победы" },
  };
  const planThree = await request("/plan", commuteOnly);
  assert.equal(planThree.statusCode, 200, planThree.body);
  assert.equal(planThree.json().checklist.paymentNeedsReview, undefined);
  assert.equal(planThree.json().checklist.confirmedFromRevision, undefined);
  const inaccessible = await request(confirmPath, confirmation, otherToken);
  assert.equal(inaccessible.statusCode, 409);
  assert.equal(inaccessible.json().currentRevision, undefined);
  assert.deepEqual((await request("", undefined, otherToken)).json(), {
    userId: other,
    plan: null,
    checklist: null,
  });
  assert.equal((await request(confirmPath, confirmation, "")).statusCode, 401);
  assert.equal(
    (
      await request(
        confirmPath,
        confirmation,
        token,
        "https://other.example.test",
      )
    ).statusCode,
    403,
  );
  for (const invalid of [
    { ...confirmation, reviewed: false },
    { ...confirmation, userId: other },
    { ...confirmation, expectedRevision: 0 },
  ])
    assert.equal((await request(confirmPath, invalid)).statusCode, 400);

  const staleChecklist = await request(confirmPath, {
    ...confirmation,
    expectedRevision: 1,
  });
  assert.equal(staleChecklist.statusCode, 409);
  assert.equal(staleChecklist.json().code, "REVISION_CONFLICT");
  const stalePlan = await request(confirmPath, {
    ...confirmation,
    planRevision: 2,
  });
  assert.equal(stalePlan.statusCode, 409);
  assert.equal(stalePlan.json().code, "PLAN_STALE");
  for (const usedRequest of [commuteOnly.requestId, checklist.requestId])
    assert.equal(
      (await request(confirmPath, { ...confirmation, requestId: usedRequest }))
        .statusCode,
      409,
    );
  assert.equal(
    (await request("")).json().checklist.confirmedFromRevision,
    undefined,
  );

  // A lost response can be retried with the same immutable intent.
  const [confirmed, replay] = await Promise.all([
    request(confirmPath, confirmation),
    request(confirmPath, confirmation),
  ]);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), confirmed.json());
  const receipt = housingWorkspaceSchema.parse(confirmed.json()).checklist!;
  assert.deepEqual(
    { ...receipt, updatedAt: undefined },
    {
      revision: 3,
      planRevision: 3,
      confirmedFromRevision: 2,
      selected: ["contract"],
      paymentChecked: false,
      requestId: confirmation.requestId,
      updatedAt: undefined,
    },
  );
  assert.deepEqual(
    (
      await request(confirmPath, {
        ...confirmation,
        expectedRevision: 3,
        requestId: randomUUID(),
      })
    ).json(),
    confirmed.json(),
  );
  assert.equal(
    (await request(confirmPath, { ...confirmation, expectedRevision: 3 }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await request("/checklist", {
        expectedRevision: 2,
        planRevision: 3,
        selected: receipt.selected,
        paymentChecked: receipt.paymentChecked,
        requestId: confirmation.requestId,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request("/plan", {
        ...commuteOnly,
        expectedRevision: 3,
        requestId: confirmation.requestId,
      })
    ).statusCode,
    409,
  );

  // The exact old command can be replayed, but a payment change invalidates its effect
  // on the current screen even if the budget later returns to its previous value.
  for (const [expectedRevision, budgetRub] of [
    [3, 70_000],
    [4, null],
  ] as const) {
    const changedBudget = await request("/plan", {
      ...commuteOnly,
      criteria: { ...commuteOnly.criteria, budgetRub },
      expectedRevision,
      requestId: randomUUID(),
    });
    assert.equal(changedBudget.statusCode, 200, changedBudget.body);
    assert.equal(changedBudget.json().checklist.paymentNeedsReview, true);
    assert.deepEqual(
      (await request(confirmPath, confirmation)).json(),
      changedBudget.json(),
    );
    const needsReview = await request(confirmPath, {
      ...confirmation,
      expectedRevision: 3,
      planRevision: expectedRevision + 1,
      requestId: randomUUID(),
    });
    assert.equal(needsReview.statusCode, 409);
    assert.equal(needsReview.json().code, "PLAN_STALE");
  }
  const reviewedAgain = await request("/checklist", {
    expectedRevision: 3,
    planRevision: 5,
    selected: receipt.selected,
    paymentChecked: false,
    requestId: randomUUID(),
  });
  assert.equal(reviewedAgain.statusCode, 200, reviewedAgain.body);
  assert.equal(reviewedAgain.json().checklist.confirmedFromRevision, undefined);
  assert.equal(reviewedAgain.json().checklist.paymentNeedsReview, undefined);
  const confirmedAgain = await request(confirmPath, {
    ...confirmation,
    expectedRevision: 4,
    planRevision: 5,
    requestId: randomUUID(),
  });
  assert.equal(confirmedAgain.statusCode, 200, confirmedAgain.body);
  assert.equal(confirmedAgain.json().checklist.confirmedFromRevision, 4);
  assert.deepEqual(
    (
      await db.query(
        "select revision,confirmed_from_revision from housing_workspace_checklists where confirmed_from_revision is not null order by revision",
      )
    ).rows,
    [
      { revision: 3, confirmed_from_revision: 2 },
      { revision: 5, confirmed_from_revision: 4 },
    ],
  );
  assert.equal((await db.query("select 1 from xp_events")).rows.length, 0);
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
