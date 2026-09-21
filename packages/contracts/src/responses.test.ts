import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardResponseSchema,
  aiControlResponseSchema,
} from "./responses.js";
import { questionnaireSchema, type Dashboard } from "./platform.js";
const board: Dashboard = {
  user: { id: "1", email: "synthetic@example.test" },
  profile: {
    originCity: "Казань",
    targetCity: "Москва",
    monthlyBudget: 50000,
    moveTargetDate: "2000-01-01",
    household: "solo",
    aiConsent: true,
  },
  xp: 0,
  quests: [],
  thread: null,
  provider: "unconfigured",
  aiAccess: { policy: null, granted: false, dailyLimit: 0 },
};
test("stored past move dates and legacy dashboards without optional money fields stay readable", () => {
  assert.equal(questionnaireSchema.safeParse(board.profile).success, false);
  assert.deepEqual(dashboardResponseSchema.parse(board), board);
  assert.deepEqual(
    dashboardResponseSchema.parse({ ...board, futureField: true }),
    board,
  );
});
test("dashboard validates nested profile, quest, message, policy and budget fields", () => {
  for (const change of [
    { xp: "60" },
    { user: { id: "1", email: 4 } },
    { profile: { ...board.profile, household: "invalid" } },
    {
      quests: [
        {
          id: "1",
          slug: "test",
          title: "Test",
          xpReward: -1,
          state: "available",
        },
      ],
    },
    {
      thread: {
        id: "1",
        agentKey: "housing",
        messages: [
          {
            id: "1",
            role: "system",
            content: "x",
            agentKey: "housing",
            status: "complete",
          },
        ],
      },
    },
    { aiAccess: { ...board.aiAccess, policy: { id: "broken" } } },
    {
      aiAccess: {
        ...board.aiAccess,
        budget: {
          currency: "RUB",
          day: "2026-09-22",
          resetAt: "invalid",
          limitMicros: 500,
          reservedTodayMicros: 0,
          remainingMicros: 500,
        },
      },
    },
  ])
    assert.equal(
      dashboardResponseSchema.safeParse({ ...board, ...change }).success,
      false,
    );
});
test("admin accepts existing PostgreSQL and ISO audit dates but rejects invalid timestamps", () => {
  const current = { provider: "disabled", policyId: null, revision: 1 };
  const status = {
    current,
    effectiveProvider: "unconfigured",
    environmentDisabled: false,
    automaticFallback: false,
    options: [],
    audit: [
      {
        id: "1",
        actorUserId: null,
        createdAt: "2026-09-22 00:12:34.123456+00",
        payload: { from: null, to: current, policy: null },
      },
    ],
  };
  for (const timestamp of [
    "2026-09-22 00:12:34.123456+00",
    "2026-09-22T00:12:34Z",
    "2026-09-22T03:12:34+03:00",
  ])
    assert.equal(
      aiControlResponseSchema.safeParse({
        ...status,
        audit: [{ ...status.audit[0], createdAt: timestamp }],
      }).success,
      true,
    );
  for (const timestamp of [
    "yesterday",
    "2026-02-31 01:12:34+00",
    "",
    "2026-09-22",
  ])
    assert.equal(
      aiControlResponseSchema.safeParse({
        ...status,
        audit: [{ ...status.audit[0], createdAt: timestamp }],
      }).success,
      false,
    );
  assert.equal(
    aiControlResponseSchema.safeParse({ ...status, automaticFallback: true })
      .success,
    false,
  );
});
