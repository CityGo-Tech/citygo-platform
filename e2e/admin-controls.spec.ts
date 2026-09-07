import { test, expect } from "@playwright/test";
import type { AiControlStatus } from "@citygo/contracts";

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
  await expect(attempts).toContainText("Денежный бюджет пока не настроен");
  await expect(attempts.locator("input, select, button")).toHaveCount(0);
  expect(writes).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
