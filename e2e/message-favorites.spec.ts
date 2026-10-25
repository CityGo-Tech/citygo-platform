import { syntheticConsentPolicy } from "./service-consent-fixture";
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
  await page.locator("input[name=personalDataConsent]").check();
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Начать диалог", exact: true })
    .click();
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

test("late valid favorite response cannot reappear after logout", async ({
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
    if (
      route.request().method() === "GET" &&
      new URL(route.request().url()).origin === "http://localhost:3000" &&
      new URL(route.request().url()).pathname ===
        "/api/v1/auth/registration-policy"
    )
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/dashboard") return route.fulfill({ json: dashboard });
    if (path === "/api/v1/messages/favorites") {
      reads++;
      await gate;
      try {
        await route.fulfill({
          json: {
            userId: "1",
            messages: [
              {
                id: "8",
                threadId: "1",
                role: "user",
                agentKey: "support",
                status: "complete",
                content: "LATE PRIVATE MESSAGE",
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
  await expect(page.getByText("LATE PRIVATE MESSAGE")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Избранные сообщения" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeVisible();
});

test("favorites page through exact bigint IDs, remove only a bookmark and reload", async ({
  page,
}) => {
  const firstIds = Array.from({ length: 20 }, (_, index) =>
    (9007199254741030n - BigInt(index)).toString(),
  );
  const secondIds = ["100", "99"];
  const removed = new Set<string>();
  const cursors: (string | null)[] = [];
  await page.route("**/api/v1/**", async (route) => {
    if (
      route.request().method() === "GET" &&
      new URL(route.request().url()).origin === "http://localhost:3000" &&
      new URL(route.request().url()).pathname ===
        "/api/v1/auth/registration-policy"
    )
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/dashboard")
      return route.fulfill({
        json: {
          user: { id: "1", email: "owner@example.test" },
          profile: null,
          quests: [],
          xp: 0,
          thread: null,
          provider: "unconfigured",
          aiAccess: { policy: null, granted: false, dailyLimit: 0 },
        } satisfies Dashboard,
      });
    const mutation = url.pathname.match(
      /^\/api\/v1\/messages\/(\d+)\/favorite$/,
    );
    if (mutation) {
      expect(route.request().postDataJSON()).toEqual({ saved: false });
      removed.add(mutation[1]!);
      return route.fulfill({ json: { messageId: mutation[1], saved: false } });
    }
    if (url.pathname === "/api/v1/messages/favorites") {
      const before = url.searchParams.get("before");
      cursors.push(before);
      const ids = before ? secondIds : firstIds;
      return route.fulfill({
        json: {
          userId: "1",
          messages: ids
            .filter((id) => !removed.has(id))
            .map((id) => ({
              id,
              threadId: "1",
              role: "assistant",
              agentKey: "support",
              status: id === "99" ? "interrupted" : "complete",
              content: "Saved answer " + id,
            })),
          nextBefore: before ? null : firstIds.at(-1),
        },
      });
    }
    throw new Error("Unexpected favorites request: " + url.pathname);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Избранное", exact: true }).click();
  const panel = page.getByRole("region", {
    name: "Избранные сообщения",
    exact: true,
  });
  const entries = panel.getByRole("article");
  await expect(entries).toHaveCount(20);
  await entries
    .first()
    .getByRole("button", { name: "Убрать из избранного", exact: true })
    .click();
  await expect(entries).toHaveCount(19);
  await panel
    .getByRole("button", { name: "Показать ещё", exact: true })
    .click();
  await expect(entries).toHaveCount(21);
  await expect(entries.last()).toContainText("Saved answer 99");
  await expect(entries.last()).toContainText("Ответ прерван");
  await expect(
    panel.getByRole("button", { name: "Показать ещё", exact: true }),
  ).toHaveCount(0);
  expect(cursors).toEqual([null, firstIds.at(-1)]);
  await page.reload();
  await page.getByRole("button", { name: "Избранное", exact: true }).click();
  await expect(entries).toHaveCount(19);
  await expect(
    panel.getByText("Saved answer " + firstIds[0], { exact: true }),
  ).toHaveCount(0);
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
    if (
      route.request().method() === "GET" &&
      new URL(route.request().url()).origin === "http://localhost:3000" &&
      new URL(route.request().url()).pathname ===
        "/api/v1/auth/registration-policy"
    )
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
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
