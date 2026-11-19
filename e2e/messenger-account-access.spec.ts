import { expect, test, type Page } from "@playwright/test";
import {
  submitRegistration,
  syntheticProduct,
} from "./marketing-landing-fixture";

const email = "landing-user@example.test";
const password = "synthetic-password-123";
const confirmation = "3".repeat(64);
const telegram = {
  provider: "telegram",
  name: "Telegram",
  fragment: "tgWebAppData",
  script: "https://telegram.org/js/telegram-web-app.js?65",
} as const;
const max = {
  provider: "max",
  name: "MAX",
  fragment: "WebAppData",
  script: "https://st.max.ru/js/max-web-app.js",
} as const;

async function openMiniApp(
  page: Page,
  host: typeof telegram | typeof max,
  initData: string,
) {
  const app = JSON.stringify({ initData, startParam: "coordinator" });
  await page.route(host.script, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        const synthetic = ${app};
        const sdk = {
          initData: synthetic.initData,
          initDataUnsafe: { start_param: synthetic.startParam },
          openLink() { throw new Error("Unexpected handoff"); },
        };
        ${host.provider === "telegram" ? "window.Telegram = { WebApp: sdk };" : "window.WebApp = sdk;"}
      `,
    }),
  );
  await page.goto(
    `/mini/${host.provider}#${host.fragment}=${encodeURIComponent(initData)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Оценить переезд" }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/mini/${host.provider}$`));
  await page.getByRole("button", { name: "Продолжить в CityGo" }).click();
  await expect(
    page.getByRole("button", { name: `Войти через ${host.name}` }),
  ).toBeVisible();
}

test("MAX email registration keeps the task, and connection requires separate owner confirmation", async ({
  page,
}) => {
  const state = await syntheticProduct(page);
  const initData = "synthetic-max-proof-email";
  let links = 0;
  let attempts = 0;
  await page.route("**/api/v1/account/messenger-links", (route) =>
    route.fulfill({ json: { providers: links ? ["max"] : [] } }),
  );
  await page.route("**/api/v1/mini-apps/max/link/prepare", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ initData, password });
    attempts++;
    await route.fulfill({ json: { id: "101", email, confirmation } });
  });
  await page.route("**/api/v1/mini-apps/max/link", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      initData,
      userId: "101",
      confirmation,
    });
    links++;
    await route.fulfill({ json: { linked: true } });
  });

  await openMiniApp(page, max, initData);
  await page
    .getByRole("button", { name: "Впервые здесь? Создать аккаунт" })
    .click();
  await submitRegistration(page);
  expect(JSON.stringify(state.begin)).not.toContain(initData);
  expect(state.starts).toEqual([]);
  await page.getByLabel("Код из письма", { exact: true }).fill("654321");
  await page
    .getByRole("button", { name: "Подтвердить email", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Подключённые мессенджеры" }),
  ).toBeVisible();
  expect(state.starts).toEqual(["support"]);
  expect(links).toBe(0);
  await expect(page.getByText(email)).toHaveCount(0);

  await page.getByLabel("Пароль CityGo").fill(password);
  await page.getByRole("button", { name: "Проверить пароль" }).click();
  await expect(
    page.getByText(`Подключить MAX к аккаунту ${email}?`),
  ).toBeVisible();
  expect(links).toBe(0);
  await page.getByRole("button", { name: "Не сейчас" }).click();
  expect(links).toBe(0);
  await expect(
    page.getByRole("heading", { name: "Координатор переезда" }),
  ).toBeVisible();

  await page.locator("details.account-menu > summary").click();
  await page.getByRole("button", { name: "Мессенджеры", exact: true }).click();
  await page.getByLabel("Пароль CityGo").fill(password);
  await page.getByRole("button", { name: "Проверить пароль" }).click();
  await page.getByRole("button", { name: "Подключить MAX" }).click();
  await expect(page.getByRole("status")).toContainText("MAX подключён");
  expect(attempts).toBe(2);
  expect(links).toBe(1);
  expect(
    await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
  ).not.toContain(initData);
});

test("expired Telegram entry can reopen, and account switch drops the previous owner’s draft", async ({
  page,
}) => {
  const state = await syntheticProduct(page);
  let signIns = 0;
  await page.route("**/api/v1/account/messenger-links", (route) =>
    route.fulfill({ json: { providers: ["telegram"] } }),
  );
  await page.route("**/api/v1/mini-apps/telegram/sign-in", async (route) => {
    signIns++;
    const initData = route.request().postDataJSON().initData;
    if (initData === "synthetic-telegram-expired")
      return route.fulfill({
        status: 400,
        json: { error: "Данные запуска просрочены." },
      });
    expect(initData).toBe("synthetic-telegram-current");
    state.authenticated = true;
    await route.fulfill({
      json: { user: { id: "101", email }, purpose: "coordinator" },
    });
  });
  await page.route("**/api/v1/auth/logout", (route) => {
    state.authenticated = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/v1/auth/login", (route) => {
    state.authenticated = true;
    state.dashboardOwner = "102";
    return route.fulfill({
      json: {
        user: { id: "102", email: "next-owner@example.test", role: "user" },
      },
    });
  });
  await openMiniApp(page, telegram, "synthetic-telegram-expired");
  await page.getByRole("button", { name: "Войти через Telegram" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "откройте мини-приложение заново" }),
  ).toBeVisible();
  expect(state.authenticated).toBe(false);
  expect(state.starts).toEqual([]);

  await page.goto("about:blank");
  await openMiniApp(page, telegram, "synthetic-telegram-current");
  await page.getByRole("button", { name: "Войти через Telegram" }).click();
  await expect(
    page.getByRole("heading", { name: "Координатор переезда" }),
  ).toBeVisible();
  const previousDraft = "Синтетический черновик первого владельца";
  await page.evaluate((text) => {
    sessionStorage.setItem(
      "citygo:chat-draft:v1:101:20",
      JSON.stringify({ text, savedAt: Date.now() }),
    );
  }, previousDraft);
  await page.locator("details.account-menu > summary").click();
  await page.getByRole("button", { name: "Мессенджеры", exact: true }).click();
  await page.getByRole("button", { name: "Сменить аккаунт" }).click();
  await expect(page.getByText("Вы вышли из аккаунта.")).toBeVisible();
  await page
    .getByLabel("Логин или электронная почта", { exact: true })
    .fill("next-owner@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page
    .locator("form")
    .getByRole("button", { name: "Войти", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Подключённые мессенджеры" }),
  ).toBeVisible();
  expect(state.dashboardOwner).toBe("102");
  expect(
    await page.evaluate(() => JSON.stringify(sessionStorage)),
  ).not.toContain(previousDraft);
  expect(await page.locator("main").textContent()).not.toContain(previousDraft);
  expect(signIns).toBe(2);
  expect(state.starts).toEqual(["support"]);
});
