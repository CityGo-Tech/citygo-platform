import { test, expect } from "@playwright/test";
import type { AiControlStatus } from "@citygo/contracts";

test("admin confirms one-time credit for the displayed account and never replays a stale response", async ({
  page,
}) => {
  await page.route("**/api/v1/admin/overview", (route) =>
    route.fulfill({
      json: { counts: { users: 2, completed: 0, xp: 0 }, pendingHuman: [] },
    }),
  );
  await page.route("**/api/v1/admin/ai", (route) =>
    route.fulfill({ json: fixture() }),
  );
  let writes = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/admin/ai/credit/welcome", async (route) => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({
      userId: "2",
      confirmOneTime500Rub: true,
    });
    await gate;
    await route.fulfill({
      json: {
        currency: "RUB",
        bonusGranted: true,
        grantedMicros: 500000000,
        availableMicros: 500000000,
        heldMicros: 0,
        spentMicros: 0,
        chargingStatus: "not_connected",
        topUpAvailable: false,
        history: [],
      },
    });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  const grant = page.getByRole("button", { name: "Подтвердить разовый бонус" });
  await expect(grant).toBeDisabled();
  await page.getByLabel("ID аккаунта участника").fill("2");
  const confirm = page.getByRole("checkbox", {
    name: "Подтверждаю выдачу разовых 500 ₽ аккаунту 2",
  });
  await confirm.check();
  await page.getByLabel("ID аккаунта участника").fill("3");
  await expect(grant).toBeDisabled();
  await page.getByLabel("ID аккаунта участника").fill("2");
  await confirm.check();
  await grant.click();
  await expect.poll(() => writes).toBe(1);
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "citygo-session-changed",
        newValue: "credit-test-session",
      }),
    ),
  );
  release();
  await expect(grant).toHaveCount(0);
  await expect(
    page.getByText("Разовый бонус 500 ₽ подтверждён", { exact: false }),
  ).toHaveCount(0);
  expect(writes).toBe(1);
});

function fixture(): AiControlStatus {
  return {
    current: { provider: "openai", policyId: "a".repeat(64), revision: 1 },
    effectiveProvider: "openai",
    environmentDisabled: false,
    automaticFallback: false,
    audit: [],
    attempts: {
      day: "2026-09-07",
      reservedToday: 2,
      userDailyLimit: 20,
      globalDailyLimit: 200,
      configurationMatches: true,
      pinnedLimits: { userDailyLimit: 20, globalDailyLimit: 200 },
      maxPerRequest: 2,
      recent: [
        {
          userId: "1",
          threadId: "1",
          requestId: "test-request",
          attemptNumber: 2,
          provider: "openai",
          model: "test-openai",
          routingRevision: 1,
          reservedAt: "2026-09-07T00:00:00Z",
          requestStatus: "interrupted",
        },
      ],
    },
    options: [
      {
        provider: "openai",
        unavailableReason: null,
        policy: {
          id: "a".repeat(64),
          version: "test",
          provider: "openai",
          model: "test-openai",
          recipient: "OpenAI",
          routing: "Прямое подключение",
          data: "Тестовые данные",
        },
      },
      {
        provider: "routerai",
        unavailableReason: "not_configured",
        policy: null,
      },
      {
        provider: "gigachat",
        unavailableReason: null,
        policy: {
          id: "b".repeat(64),
          version: "test",
          provider: "gigachat",
          model: "test-gigachat",
          recipient: "GigaChat",
          routing: "Тестовый API-аккаунт",
          data: "Тестовые данные",
        },
      },
    ],
  };
}

test("admin clears private overview and editable controls on session invalidation and 401", async ({
  page,
}) => {
  let expired = false;
  await page.route("**/api/v1/admin/overview", (route) =>
    route.fulfill({
      json: {
        counts: { users: 1, completed: 0, xp: 0 },
        pendingHuman: [
          {
            id: "synthetic",
            thread_id: "A",
            reason: "Обращение пользователя A",
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/admin/ai", (route) =>
    route.fulfill({
      status: expired ? 401 : 200,
      json: expired ? { error: "expired" } : fixture(),
    }),
  );
  await page.goto("/admin");
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  await expect(
    page.getByText("Обращение пользователя A", { exact: false }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "citygo-session-changed",
        newValue: "synthetic-invalidation-only",
      }),
    ),
  );
  await expect(
    page.getByText("Обращение пользователя A", { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  await expect(
    page.getByText("Обращение пользователя A", { exact: false }),
  ).toBeVisible();
  expired = true;
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  await expect(
    page.getByText("Обращение пользователя A", { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Обновить сводку" }),
  ).toBeEnabled();
});

test("admin confirms configured provider and refreshes stale state without reapplying", async ({
  page,
}) => {
  const status = fixture();
  let writes = 0;
  await page.route("**/api/v1/admin/overview", (route) =>
    route.fulfill({
      json: { counts: { users: 1, completed: 0, xp: 0 }, pendingHuman: [] },
    }),
  );
  await page.route("**/api/v1/admin/ai", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: status });
    writes++;
    const input = route.request().postDataJSON();
    if (writes === 1) {
      expect(input).toEqual({
        provider: "gigachat",
        policyId: "b".repeat(64),
        expectedRevision: 1,
      });
      const from = status.current;
      status.current = {
        provider: "gigachat",
        policyId: input.policyId,
        revision: 2,
      };
      status.effectiveProvider = "gigachat";
      status.audit = [
        {
          id: "1",
          actorUserId: "1",
          createdAt: "2026-09-07T00:00:00Z",
          payload: {
            from,
            to: status.current,
            policy: status.options[2]!.policy,
          },
        },
      ];
      return route.fulfill({ json: status.current });
    }
    expect(input.expectedRevision).toBe(2);
    status.current = { provider: "disabled", policyId: null, revision: 3 };
    status.effectiveProvider = "unconfigured";
    return route.fulfill({
      status: 409,
      json: { error: "Настройка AI уже изменена" },
    });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  const selection = page.getByLabel("Активный AI-провайдер");
  const confirm = page.getByRole("checkbox", {
    name: "Подтверждаю изменение провайдера для новых сообщений.",
  });
  const save = page.getByRole("button", { name: "Применить настройку AI" });
  await expect(selection).toHaveValue("openai");
  const attempts = page.getByRole("region", { name: "Лимиты попыток AI" });
  await expect(attempts).toContainText("зарезервировано: 2 из 200");
  await expect(attempts).toContainText("состояние сообщения: прервано");
  await expect(attempts).toContainText("не счёт провайдера");
  await expect(save).toBeDisabled();
  // Inspect the native option itself; the actionability matcher can retarget
  // an option to its enabled parent select.
  await expect(selection.locator('option[value="routerai"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await selection.selectOption("gigachat");
  await expect(confirm).not.toBeChecked();
  await expect(save).toBeDisabled();
  await confirm.check();
  await save.click();
  await expect(
    page.getByText("Настройка AI сохранена.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/OpenAI → GigaChat/)).toBeVisible();
  await expect(selection).toHaveValue("gigachat");
  await expect(save).toBeDisabled();
  await selection.selectOption("openai");
  await confirm.check();
  await save.click();
  await expect(page.locator(".admin-error")).toContainText(
    "Настройка AI уже изменена",
  );
  await expect(selection).toHaveValue("disabled");
  await expect(confirm).not.toBeChecked();
  expect(writes).toBe(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("admin authorization failure does not reveal provider controls", async ({
  page,
}) => {
  await page.route("**/api/v1/admin/**", (route) =>
    route.fulfill({
      status: 403,
      json: { error: "Доступ только для администратора" },
    }),
  );
  await page.goto("/admin");
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  await expect(page.locator(".admin-error")).toHaveText(
    "Доступ только для администратора",
  );
  await expect(page.getByLabel("Активный AI-провайдер")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Лимиты попыток AI" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Денежный бюджет AI" }),
  ).toHaveCount(0);
});

test("admin loads immutable pre-cap budget audit without losing the current personal limit", async ({
  page,
}) => {
  const status = fixture();
  const legacy = {
    revision: 1,
    enabled: false,
    currency: "RUB" as const,
    dailyLimitMicros: 1_000_000_000,
    totalLimitMicros: 1_000_000_000,
    rules: [],
  };
  status.budget = {
    settings: { ...legacy, revision: 2, userDailyLimitMicros: 500_000_000 },
    day: "2026-09-22",
    reservedTodayMicros: 0,
    totalReservedMicros: 0,
    availableExecutions: [],
    audit: [
      {
        id: "1",
        actorUserId: "1",
        createdAt: "2026-09-01T00:00:00Z",
        payload: { from: legacy, to: legacy },
      },
    ],
  };
  let writes = 0;
  await page.route("**/api/v1/admin/**", (route) => {
    if (route.request().method() !== "GET") writes++;
    return route.fulfill({
      json: route.request().url().endsWith("/overview")
        ? { counts: { users: 1, completed: 0, xp: 0 }, pendingHuman: [] }
        : status,
    });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  const budget = page.getByRole("region", { name: "Денежный бюджет AI" });
  await expect(budget).toBeVisible();
  await expect(budget).toContainText(
    "Действующий лимит на аккаунт в сутки UTC: 500 RUB",
  );
  await expect(budget.getByRole("listitem")).toContainText(
    "без отдельного лимита на аккаунт",
  );
  await expect(
    budget.getByRole("button", { name: "Сохранить денежный бюджет" }),
  ).toBeDisabled();
  await expect(page.locator(".admin-error")).toHaveCount(0);
  expect(writes).toBe(0);
});

test("admin explicitly confirms money ceilings, refreshes conflicts and cannot silently change currency", async ({
  page,
}) => {
  const status = fixture();
  const execution = {
    key: "c".repeat(64),
    policy: status.options[0]!.policy!,
    maxInputBytes: 64000,
    maxOutputTokens: 1400,
  };
  status.budget = {
    settings: {
      revision: 1,
      enabled: false,
      currency: null,
      dailyLimitMicros: 0,
      totalLimitMicros: 0,
      userDailyLimitMicros: null,
      rules: [],
    },
    day: "2026-09-07",
    reservedTodayMicros: 0,
    totalReservedMicros: 0,
    audit: [],
    availableExecutions: [execution],
  };
  let writes = 0;
  await page.route("**/api/v1/admin/overview", (route) =>
    route.fulfill({
      json: { counts: { users: 1, completed: 0, xp: 0 }, pendingHuman: [] },
    }),
  );
  await page.route("**/api/v1/admin/ai", (route) =>
    route.fulfill({ json: status }),
  );
  await page.route("**/api/v1/admin/ai/budget", (route) => {
    writes++;
    const input = route.request().postDataJSON();
    if (writes === 1) {
      expect(input).toEqual({
        expectedRevision: 1,
        enabled: true,
        currency: "RUB",
        totalLimitMicros: 2000000,
        dailyLimitMicros: 1000000,
        userDailyLimitMicros: null,
        rules: [{ key: execution.key, attemptCeilingMicros: 125000 }],
      });
      const from = status.budget!.settings;
      status.budget!.settings = {
        revision: 2,
        enabled: true,
        currency: "RUB",
        totalLimitMicros: 2000000,
        dailyLimitMicros: 1000000,
        userDailyLimitMicros: null,
        rules: [{ ...execution, attemptCeilingMicros: 125000 }],
      };
      status.budget!.totalReservedMicros = 125000;
      status.budget!.reservedTodayMicros = 125000;
      status.budget!.audit = [
        {
          id: "2",
          actorUserId: "1",
          createdAt: "2026-09-07T01:00:00Z",
          payload: { from, to: status.budget!.settings },
        },
      ];
      return route.fulfill({ json: status.budget!.settings });
    }
    expect(input.expectedRevision).toBe(2);
    status.budget!.settings = {
      ...status.budget!.settings,
      revision: 3,
      enabled: false,
    };
    return route.fulfill({
      status: 409,
      json: { error: "Бюджет AI уже изменён" },
    });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  const budget = page.getByRole("region", { name: "Денежный бюджет AI" });
  const save = budget.getByRole("button", {
    name: "Сохранить денежный бюджет",
  });
  const confirm = budget.getByRole("checkbox", {
    name: "Подтверждаю бюджет, валюту и проверенные потолки для выбранных моделей.",
  });
  await expect(save).toBeDisabled();
  await expect(budget.getByLabel("Валюта бюджета")).toHaveValue("");
  await expect(budget).toContainText("не фактический счёт провайдера");
  await expect(budget).toContainText("64000 байт");
  await budget.getByLabel("Разрешить новые денежные резервы").check();
  await budget.getByLabel("Валюта бюджета").selectOption("RUB");
  await budget.getByLabel("Общий бюджет", { exact: true }).fill("2");
  await budget.getByLabel("Бюджет на сутки UTC").fill("1");
  const ceiling = budget.getByLabel("Потолок на попытку · OpenAI");
  await ceiling.fill("0.0000001");
  await expect(confirm).toBeDisabled();
  await ceiling.fill("0,125");
  await confirm.check();
  await budget.getByLabel("Общий бюджет", { exact: true }).fill("3");
  await expect(confirm).not.toBeChecked();
  await expect(save).toBeDisabled();
  await budget.getByLabel("Общий бюджет", { exact: true }).fill("2");
  await confirm.check();
  await save.click();
  await expect(
    page.getByText("Денежный бюджет AI сохранён.", { exact: true }),
  ).toBeVisible();
  await expect(budget).toContainText("Всего зарезервировано: 0.125 RUB");
  await expect(budget.getByLabel("Валюта бюджета")).toBeDisabled();
  await expect(confirm).not.toBeChecked();
  await budget.getByLabel("Общий бюджет", { exact: true }).fill("3");
  await confirm.check();
  await save.click();
  await expect(page.locator(".admin-error")).toContainText(
    "Бюджет AI уже изменён",
  );
  await expect(budget).toContainText("Версия бюджета: 3");
  await expect(
    budget.getByLabel("Разрешить новые денежные резервы"),
  ).not.toBeChecked();
  await expect(confirm).not.toBeChecked();
  await expect(save).toBeDisabled();
  expect(writes).toBe(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("admin saves a 500 RUB personal cap without changing global allowance or lowering model quality", async ({
  page,
}) => {
  const status = fixture();
  const execution = {
    key: "d".repeat(64),
    policy: status.options[0]!.policy!,
    maxInputBytes: 64000,
    maxOutputTokens: 32768,
  };
  status.budget = {
    settings: {
      revision: 1,
      enabled: false,
      currency: "RUB",
      dailyLimitMicros: 5000000000,
      totalLimitMicros: 10000000000,
      userDailyLimitMicros: null,
      rules: [{ ...execution, attemptCeilingMicros: 1666000000 }],
    },
    day: "2026-09-14",
    reservedTodayMicros: 0,
    totalReservedMicros: 0,
    audit: [],
    availableExecutions: [execution],
  };
  let writes = 0;
  await page.route("**/api/v1/admin/overview", (route) =>
    route.fulfill({
      json: { counts: { users: 1, completed: 0, xp: 0 }, pendingHuman: [] },
    }),
  );
  await page.route("**/api/v1/admin/ai", (route) =>
    route.fulfill({ json: status }),
  );
  await page.route("**/api/v1/admin/ai/budget", (route) => {
    writes++;
    const input = route.request().postDataJSON();
    expect(input).toEqual({
      expectedRevision: writes,
      enabled: false,
      currency: "RUB",
      dailyLimitMicros: 5000000000,
      totalLimitMicros: 10000000000,
      userDailyLimitMicros: writes === 1 ? 500000000 : null,
      rules: [{ key: execution.key, attemptCeilingMicros: 1666000000 }],
    });
    const from = status.budget!.settings;
    status.budget!.settings = {
      ...from,
      revision: from.revision + 1,
      userDailyLimitMicros: input.userDailyLimitMicros,
    };
    status.budget!.audit.push({
      id: String(writes),
      actorUserId: "1",
      createdAt: "2026-09-14T04:00:00Z",
      payload: { from, to: status.budget!.settings },
    });
    return route.fulfill({ json: status.budget!.settings });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  const budget = page.getByRole("region", { name: "Денежный бюджет AI" });
  const personal = budget.getByLabel("Лимит на аккаунт в сутки UTC", {
    exact: true,
  });
  const confirm = budget.getByRole("checkbox", {
    name: "Подтверждаю бюджет, валюту и проверенные потолки для выбранных моделей.",
  });
  const save = budget.getByRole("button", {
    name: "Сохранить денежный бюджет",
  });
  await expect(personal).toHaveValue("");
  await expect(personal).toHaveAttribute("placeholder", "500");
  await expect(
    budget.getByLabel("Разрешить новые денежные резервы"),
  ).not.toBeChecked();
  await expect(budget).toContainText("00:00 UTC (03:00 по Москве)");
  await personal.fill("invalid");
  await expect(confirm).toBeDisabled();
  await expect(save).toBeDisabled();
  await personal.fill("500");
  await expect(budget.getByRole("alert")).toContainText(
    "Потолок на попытку выше лимита на аккаунт",
  );
  await expect(budget.getByRole("alert")).toContainText(
    "автоматически не снижаются",
  );
  await expect(budget.getByLabel("Потолок на попытку · OpenAI")).toHaveValue(
    "1666",
  );
  await expect(budget).toContainText("32768 токенов");
  await confirm.check();
  await save.click();
  await expect(
    page.getByText("Денежный бюджет AI сохранён.", { exact: true }),
  ).toBeVisible();
  await expect(personal).toHaveValue("500");
  await expect(budget).toContainText("500 RUB на аккаунт в сутки UTC");
  await expect(budget.getByLabel("Общий бюджет", { exact: true })).toHaveValue(
    "10000",
  );
  await expect(
    budget.getByLabel("Бюджет на сутки UTC", { exact: true }),
  ).toHaveValue("5000");
  await personal.fill("");
  await expect(budget.getByRole("alert")).toHaveCount(0);
  await confirm.check();
  await save.click();
  await expect(budget).toContainText("Версия бюджета: 3");
  await expect(personal).toHaveValue("");
  expect(writes).toBe(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("admin sees mismatched attempt limits without editable budget or hidden writes", async ({
  page,
}) => {
  const status = fixture();
  status.attempts!.configurationMatches = false;
  let writes = 0;
  await page.route("**/api/v1/admin/overview", (route) =>
    route.fulfill({
      json: { counts: { users: 1, completed: 0, xp: 0 }, pendingHuman: [] },
    }),
  );
  await page.route("**/api/v1/admin/ai", (route) => {
    if (route.request().method() !== "GET") writes++;
    return route.fulfill({ json: status });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  const attempts = page.getByRole("region", { name: "Лимиты попыток AI" });
  await expect(attempts.getByRole("alert")).toContainText(
    "Новые попытки заблокированы",
  );
  await expect(attempts).toContainText("денежный бюджет задаётся отдельно");
  await expect(attempts.locator("input, select, button")).toHaveCount(0);
  expect(writes).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
