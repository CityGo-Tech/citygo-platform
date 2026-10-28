import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardResponseSchema,
  aiControlResponseSchema,
  aiBudgetSettingsSchema,
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

test("credit admission failure is additive and only valid for an ungenerated interrupted assistant message", () => {
  const message = {
    id: "2",
    role: "assistant",
    content: "Недостаточно средств. Запрос не отправлен ИИ.",
    agentKey: "housing",
    status: "interrupted",
  };
  const dashboard = (patch: object) => ({
    ...board,
    thread: {
      id: "1",
      agentKey: "housing",
      messages: [{ ...message, ...patch }],
    },
  });
  for (const legacy of [{}, { failureCode: null }]) {
    const result = dashboardResponseSchema.parse(dashboard(legacy));
    assert.ok(!result.thread!.messages[0]!.failureCode);
  }
  for (const generation of [undefined, null]) {
    const result = dashboardResponseSchema.parse(
      dashboard({ failureCode: "AI_CREDIT_EXHAUSTED", generation }),
    );
    assert.equal(
      result.thread!.messages[0]!.failureCode,
      "AI_CREDIT_EXHAUSTED",
    );
  }
  for (const failureCode of [
    "STREAM_INTERRUPTED",
    "AI_CREDIT_UNAVAILABLE",
    "",
    0,
    true,
    {},
  ])
    assert.equal(
      dashboardResponseSchema.safeParse(dashboard({ failureCode })).success,
      false,
    );
  for (const patch of [
    { role: "user" },
    { status: "complete" },
    { generation: { provider: "routerai", requestedModel: "test/model" } },
  ])
    assert.equal(
      dashboardResponseSchema.safeParse(
        dashboard({ failureCode: "AI_CREDIT_EXHAUSTED", ...patch }),
      ).success,
      false,
    );
});

test("quest plan metadata is additive for old servers but validated when present", () => {
  const quest = {
    id: "1",
    slug: "housing-brief",
    title: "Synthetic",
    state: "available",
    xpReward: 60,
  };
  assert.equal(
    dashboardResponseSchema.safeParse({ ...board, quests: [quest] }).success,
    true,
  );
  const plan = { id: "2", version: 3 };
  assert.deepEqual(
    dashboardResponseSchema.parse({ ...board, quests: [{ ...quest, plan }] })
      .quests[0]!.plan,
    plan,
  );
  for (const invalid of [
    null,
    {},
    { id: "2", version: 0 },
    { id: "2", version: "3" },
  ])
    assert.equal(
      dashboardResponseSchema.safeParse({
        ...board,
        quests: [{ ...quest, plan: invalid }],
      }).success,
      false,
    );
});

test("pre-cap budget audit snapshots stay readable without weakening current settings", () => {
  const legacy = {
    revision: 1,
    enabled: false,
    currency: "RUB",
    dailyLimitMicros: 1_000_000_000,
    totalLimitMicros: 1_000_000_000,
    rules: [],
  };
  const settings = {
    ...legacy,
    mode: "fixed",
    revision: 2,
    userDailyLimitMicros: 500_000_000,
  };
  const status = {
    current: { provider: "disabled", policyId: null, revision: 1 },
    effectiveProvider: "unconfigured",
    environmentDisabled: false,
    automaticFallback: false,
    options: [],
    audit: [],
    budget: {
      settings,
      totalReservedMicros: 0,
      reservedTodayMicros: 0,
      day: "2026-09-22",
      availableExecutions: [],
      audit: [
        {
          id: "1",
          actorUserId: "1",
          createdAt: "2026-09-01T00:00:00Z",
          payload: { from: legacy, to: legacy },
        },
      ],
    },
  };
  const result = aiControlResponseSchema.parse(status);
  assert.equal(result.budget?.settings.userDailyLimitMicros, 500_000_000);
  assert.equal(
    Object.hasOwn(result.budget!.audit[0]!.payload.to, "userDailyLimitMicros"),
    false,
  );
  assert.equal(
    Object.hasOwn(result.budget!.audit[0]!.payload.to, "mode"),
    false,
  );
  assert.equal(aiBudgetSettingsSchema.safeParse(legacy).success, false);
  assert.equal(
    aiControlResponseSchema.safeParse({
      ...status,
      budget: { ...status.budget, settings: legacy },
    }).success,
    false,
  );
  for (const side of ["from", "to"] as const) {
    for (const value of [null, 0, 500_000_000, "500", -1]) {
      const changed = structuredClone(status);
      Object.assign(changed.budget.audit[0]!.payload[side], {
        userDailyLimitMicros: value,
      });
      assert.equal(
        aiControlResponseSchema.safeParse(changed).success,
        typeof value !== "string" && value !== -1,
      );
    }
  }
});
test("budget responses distinguish absent operator caps from zero and retain safe lifetime counters", () => {
  const settings = {
    revision: 2,
    enabled: false,
    mode: "routerai_balance",
    currency: "RUB",
    dailyLimitMicros: null,
    totalLimitMicros: null,
    userDailyLimitMicros: null,
    rules: [],
  };
  assert.deepEqual(aiBudgetSettingsSchema.parse(settings), settings);
  for (const patch of [
    { mode: "fixed" },
    { mode: undefined },
    { currency: "USD" },
    { dailyLimitMicros: 0 },
    { totalLimitMicros: 1000000000000 },
  ])
    assert.equal(
      aiBudgetSettingsSchema.safeParse({ ...settings, ...patch }).success,
      false,
    );
  const status = {
    current: { provider: "disabled", policyId: null, revision: 1 },
    effectiveProvider: "unconfigured",
    environmentDisabled: false,
    automaticFallback: false,
    options: [],
    audit: [],
    budget: {
      settings,
      totalReservedMicros: Number.MAX_SAFE_INTEGER,
      day: "2026-10-18",
      reservedTodayMicros: 1000000000001,
      availableExecutions: [],
      audit: [],
    },
  };
  assert.equal(aiControlResponseSchema.safeParse(status).success, true);
  assert.equal(
    aiControlResponseSchema.safeParse({
      ...status,
      budget: {
        ...status.budget,
        totalReservedMicros: Number.MAX_SAFE_INTEGER + 1,
      },
    }).success,
    false,
  );
});
test("admin AI accepts three mode executions plus one retained legacy route without widening other bounds", () => {
  const execution = (key: string, provider: string, model: string) => ({
    key: key.repeat(64),
    policy: {
      id: key.repeat(64),
      version: "synthetic-policy-v1",
      provider,
      model,
      recipient: "Synthetic recipient",
      routing: "Synthetic route",
      data: "Synthetic context only",
    },
    maxInputBytes: 8192,
    maxOutputTokens: 4096,
  });
  const executions = [
    execution("a", "routerai", "openai/gpt-6.1-sol"),
    execution("b", "routerai", "deepseek/deepseek-v4-pro-0813"),
    execution("c", "gigachat", "GigaChat-3-Ultra"),
    execution("d", "routerai", "deepseek/deepseek-v4-pro-0813"),
  ];
  const settings = {
    revision: 1,
    enabled: false,
    mode: "fixed",
    currency: "RUB",
    dailyLimitMicros: 0,
    totalLimitMicros: 0,
    userDailyLimitMicros: null,
    rules: [],
  };
  const response = (availableExecutions: unknown[]) => ({
    current: { provider: "disabled", policyId: null, revision: 1 },
    effectiveProvider: "unconfigured",
    environmentDisabled: false,
    automaticFallback: false,
    options: [],
    audit: [],
    budget: {
      settings,
      totalReservedMicros: 0,
      reservedTodayMicros: 0,
      day: "2026-10-28",
      availableExecutions,
      audit: [],
    },
  });
  for (const count of [3, 4]) {
    const page = executions.slice(0, count);
    assert.deepEqual(
      aiControlResponseSchema.parse(response(page)).budget!.availableExecutions,
      page,
      "all current and retained execution identities must remain visible",
    );
  }
  assert.equal(
    aiControlResponseSchema.safeParse(
      response([...executions, execution("e", "routerai", "synthetic/extra")]),
    ).success,
    false,
    "the read-only catalog is bounded to four executions",
  );
  for (const invalid of [
    { ...executions[3], key: "not-a-policy-id" },
    { ...executions[3], maxInputBytes: "8192" },
    { ...executions[3], maxOutputTokens: -1 },
    {
      ...executions[3],
      policy: { ...executions[3]!.policy, provider: "other" },
    },
    { ...executions[3], policy: { ...executions[3]!.policy, id: "invalid" } },
  ])
    assert.equal(
      aiControlResponseSchema.safeParse(
        response([...executions.slice(0, 3), invalid]),
      ).success,
      false,
      "the fourth entry keeps every existing execution validation",
    );
  assert.equal(
    aiBudgetSettingsSchema.safeParse({
      ...settings,
      rules: executions.map((item) => ({ ...item, attemptCeilingMicros: 1 })),
    }).success,
    false,
    "catalog compatibility must not raise the three-rule budget limit",
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
