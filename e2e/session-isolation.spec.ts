import { test, expect, type Page } from "@playwright/test";
import type { Dashboard } from "@citygo/contracts";

function fixture(id: string, withProfile = true): Dashboard {
  return {
    user: { id, email: `${id}@example.test` },
    profile: withProfile
      ? {
          originCity: "Казань",
          targetCity: id === "A" ? "Москва" : "Сочи",
          monthlyBudget: 65000,
          moveTargetDate: "2099-01-01",
          household: "solo",
          aiConsent: true,
        }
      : null,
    xp: 0,
    provider: "openai",
    aiAccess: {
      granted: true,
      dailyLimit: 20,
      policy: {
        id: "a".repeat(64),
        version: "synthetic",
        provider: "openai",
        model: "test-model",
        recipient: "Тестовый получатель",
        routing: "Fixture без сети",
        data: "Вымышленные данные",
      },
    },
    quests: withProfile
      ? [
          {
            id: `quest-${id}`,
            slug: "housing-search",
            title: "Составить план поиска жилья",
            state: "in_progress",
            xpReward: 60,
          },
        ]
      : [],
    thread: {
      id: `thread-${id}`,
      agentKey: withProfile ? "housing" : "support",
      messages: [],
    },
  };
}
async function install(page: Page, withProfile = true) {
  const state = { board: fixture("A", withProfile) as Dashboard | null };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/dashboard")) {
      await route.fulfill({
        status: state.board ? 200 : 401,
        json: state.board ?? { error: "Тестовая сессия завершилась" },
      });
    } else if (path.endsWith("/auth/logout")) {
      state.board = null;
      await route.fulfill({ json: { ok: true } });
    } else if (/\/auth\/(login|register)$/.test(path)) {
      state.board = fixture("B", withProfile);
      await route.fulfill({ json: { user: state.board.user } });
    } else {
      await route.fulfill({ json: { ok: true } });
    }
  });
  return state;
}
async function signInB(page: Page) {
  await page.getByLabel("Электронная почта").fill("B@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill("synthetic-password-B");
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
}
async function openChat(page: Page) {
  await page.getByRole("link", { name: "Чат", exact: true }).click();
  await expect(page.getByLabel("Сообщение помощнику")).toBeVisible();
}

test("logout A → login B clears chat drafts and allows a fresh B draft", async ({
  page,
}) => {
  await install(page);
  await page.goto("/#chat");
  await page.getByLabel("Сообщение помощнику").fill("Черновик пользователя A");
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await signInB(page);
  await openChat(page);
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(
    "Черновик пользователя A",
  );
  await page.getByLabel("Сообщение помощнику").fill("Только B");
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("Только B");
});

test("changed user ID clears a no-profile dialog draft and unconfirmed AI permission", async ({
  page,
}) => {
  const state = await install(page, false);
  const questionnaireWrites: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/v1/questionnaire")
    )
      questionnaireWrites.push(request.url());
  });
  await page.goto("/#chat");
  await page
    .getByLabel("Сообщение помощнику")
    .fill("Черновик без анкеты пользователя A");
  state.board!.aiAccess.granted = false;
  const revoked = page.waitForResponse("**/api/v1/dashboard");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await revoked;
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(
    "Черновик без анкеты пользователя A",
  );
  const consent = page.getByRole("checkbox", {
    name: "Разрешаю передачу указанных данных этому получателю для рекомендаций.",
  });
  await consent.check();
  state.board = fixture("B", false);
  state.board.aiAccess.granted = false;
  const changedOwner = page.waitForResponse("**/api/v1/dashboard");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await changedOwner;
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("");
  await expect(consent).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Подтвердить получателя AI" }),
  ).toBeDisabled();
  await expect(page.getByLabel("Откуда переезжаете")).toHaveCount(0);
  await expect(page.locator(".account")).toContainText("0 XP");
  expect(questionnaireWrites).toEqual([]);
});

test("focus refresh preserves the same owner's draft but clears it when the cookie owner changes", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/#chat");
  await page
    .getByLabel("Сообщение помощнику")
    .fill("Черновик A при обновлении");
  const sameOwner = page.waitForResponse("**/api/v1/dashboard");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await sameOwner;
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(
    "Черновик A при обновлении",
  );

  state.board = fixture("B");
  const changedOwner = page.waitForResponse("**/api/v1/dashboard");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await changedOwner;
  await expect(page.locator("body")).toContainText("Сочи");
  await openChat(page);
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(
    "Черновик A при обновлении",
  );
});

test("401 during chat clears the entire session without restoring rejected draft A", async ({
  page,
}) => {
  const state = await install(page);
  await page.route("**/api/v1/threads/*/messages", async (route) => {
    state.board = null;
    await route.fulfill({
      status: 401,
      contentType: "text/html",
      body: "expired",
    });
  });
  await page.goto("/#chat");
  await page.getByLabel("Сообщение помощнику").fill("Секретный черновик A");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Сессия завершилась");
  await signInB(page);
  await openChat(page);
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("Секретный черновик A");
});

test("logout remains available during a delayed response and late A never enters B", async ({
  page,
}) => {
  await install(page);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/threads/*/messages", async (route) => {
    await waiting;
    await route
      .fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"delta","text":"Поздний ответ A"}\n\ndata: {"type":"done","messageId":"A"}\n\n',
      })
      .catch(() => {}); // Browser may have already cancelled the old request.
  });
  await page.goto("/#chat");
  await page.getByLabel("Сообщение помощнику").fill("Вопрос A");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Выйти", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await signInB(page);
  await openChat(page);
  release();
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("Поздний ответ A");
  await expect(page.locator("body")).not.toContainText("Вопрос A");
});

test("failed Web logout clears local data but does not claim server revocation", async ({
  page,
}) => {
  await install(page);
  await page.route("**/api/v1/auth/logout", (route) => route.abort("failed"));
  await page.goto("/#chat");
  await page.getByLabel("Сообщение помощнику").fill("Черновик A");
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page.locator(".alert[role=alert]")).toContainText(
    "Не удалось подтвердить выход на сервере",
  );
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Повторить выход на сервере" }),
  ).toBeEnabled();
  await expect(page.locator("body")).not.toContainText("Черновик A");
});

test("cross-tab invalidation clears a no-profile conversation draft before another account signs in", async ({
  page,
  context,
}) => {
  await install(page, false);
  await page.goto("/#chat");
  await page
    .getByLabel("Сообщение помощнику")
    .fill("Черновик диалога A без профиля");
  const second = await context.newPage();
  await install(second);
  await second.goto("/");
  await second.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(
    page.getByLabel("Электронная почта", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Сообщение помощнику")).toHaveCount(0);
  await expect(
    page.getByLabel("Электронная почта", { exact: true }),
  ).toHaveValue("");
  await signInB(page);
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("");
  await expect(page.getByLabel("Откуда переезжаете")).toHaveCount(0);
  await second.close();
});
