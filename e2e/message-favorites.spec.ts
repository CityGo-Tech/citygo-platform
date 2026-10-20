import { test, expect } from "@playwright/test";
import type { Dashboard } from "@citygo/contracts";

test("real local API: favorite own and assistant messages survives reload; removing keeps the source", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill("favorites-" + crypto.randomUUID() + "@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill("123456");
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Начать диалог", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Разрешаю передачу указанных данных этому получателю для рекомендаций.",
    })
    .check();
  await page.getByRole("button", { name: "Подтвердить получателя AI" }).click();
  const text = "Сохранить мой вопрос: как начать переезд?";
  await page.getByLabel("Сообщение помощнику").fill(text);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  const log = page.getByRole("log");
  await expect(log).toContainText("Тестовый ответ");
  await log
    .getByRole("button", { name: "В избранное", exact: true })
    .first()
    .click();
  await expect(
    log.getByRole("button", { name: "В избранном", exact: true }),
  ).toHaveCount(1);
  await log.getByRole("button", { name: "В избранное", exact: true }).click();
  await expect(
    log.getByRole("button", { name: "В избранном", exact: true }),
  ).toHaveCount(2);
  await page.reload();
  await expect(
    log.getByRole("button", { name: "В избранном", exact: true }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Избранное", exact: true }).click();
  const panel = page.getByRole("region", {
    name: "Избранные сообщения",
    exact: true,
  });
  await expect(panel).toContainText(text);
  await expect(panel).toContainText("Тестовый ответ");
  await panel.screenshot({ path: testInfo.outputPath("favorites-saved.png") });
  await panel
    .getByRole("button", { name: "Убрать из избранного", exact: true })
    .first()
    .click();
  await expect(
    panel.getByRole("button", { name: "Убрать из избранного", exact: true }),
  ).toHaveCount(1);
  await panel
    .getByRole("button", { name: "Убрать из избранного", exact: true })
    .click();
  await expect(panel.getByText("Пока здесь пусто")).toBeVisible();
  await panel.screenshot({ path: testInfo.outputPath("favorites-empty.png") });
  await panel
    .getByRole("button", { name: "Открыть диалоги", exact: true })
    .click();
  await expect(log).toContainText(text);
  await expect(log).toContainText("Тестовый ответ");
  await expect(
    log.getByRole("button", { name: "В избранное", exact: true }),
  ).toHaveCount(2);
});

test("late favorite response cannot reappear after logout", async ({
  page,
}) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const dashboard: Dashboard = {
    user: { id: "1", email: "owner@example.test" },
    profile: null,
    quests: [],
    xp: 0,
    thread: null,
    provider: "unconfigured",
    aiAccess: { policy: null, granted: false, dailyLimit: 0 },
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/dashboard") return route.fulfill({ json: dashboard });
    if (path === "/api/v1/messages/favorites") {
      reads++;
      await gate;
      try {
        await route.fulfill({
          json: {
            userId: "2",
            messages: [
              {
                id: "8",
                threadId: "1",
                role: "user",
                agentKey: "support",
                status: "complete",
                content: "FOREIGN PRIVATE MESSAGE",
              },
            ],
            nextBefore: null,
          },
        });
      } catch {
        /* aborted by logout */
      }
      return;
    }
    if (path === "/api/v1/auth/logout")
      return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected request" },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Избранное", exact: true }).click();
  await expect.poll(() => reads).toBe(1);
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  release();
  await expect(page.getByText("FOREIGN PRIVATE MESSAGE")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Избранные сообщения" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeVisible();
});

test("an active favorite panel rejects another owner's page without rendering its content", async ({
  page,
}) => {
  let reads = 0;
  const dashboard: Dashboard = {
    user: { id: "1", email: "owner@example.test" },
    profile: null,
    quests: [],
    xp: 0,
    thread: null,
    provider: "unconfigured",
    aiAccess: { policy: null, granted: false, dailyLimit: 0 },
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/dashboard") return route.fulfill({ json: dashboard });
    if (path === "/api/v1/messages/favorites") {
      reads++;
      return route.fulfill({
        json: {
          userId: "2",
          messages: [
            {
              id: "8",
              threadId: "1",
              role: "user",
              agentKey: "support",
              status: "complete",
              content: "FOREIGN PRIVATE MESSAGE",
            },
          ],
          nextBefore: null,
        },
      });
    }
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected request" },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Избранное", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Избранные сообщения", exact: true })
      .getByRole("alert"),
  ).toContainText("Не удалось обновить избранное");
  await expect(page.getByText("FOREIGN PRIVATE MESSAGE")).toHaveCount(0);
  expect(reads).toBe(1);
});
