import { expect, test, type Page } from "@playwright/test";
import type { Dashboard } from "@citygo/contracts";

// Every application request and external destination is intercepted. Navigating
// the cabinet must never contact an SMS, payment or model provider.
async function install(
  page: Page,
  options: { balanceMicros?: number; withThread?: boolean } = {},
) {
  const availableMicros = options.balanceMicros ?? 0;
  const board: Dashboard = {
    user: {
      id: "101",
      email: "navigation@example.test",
      role: "user",
      mustChangePassword: false,
    },
    profile: null,
    quests: [],
    xp: 0,
    thread: options.withThread
      ? { id: "101", agentKey: "support", messages: [] }
      : null,
    provider: "routerai",
    aiAccess: {
      policy: {
        id: "a".repeat(64),
        version: "synthetic-navigation",
        provider: "routerai",
        model: "synthetic-only",
        recipient: "Вымышленный получатель",
        routing: "Внешние запросы заблокированы тестом",
        data: "Только синтетические данные",
      },
      granted: true,
      dailyLimit: 20,
      credit: {
        currency: "RUB",
        bonusGranted: false,
        grantedMicros: 100_000_000,
        availableMicros,
        heldMicros: 5_000_000,
        spentMicros: 95_000_000 - availableMicros,
        reservationMode: "fixed5_overdraft",
        minimumRequestBalanceMicros: 5_000_000,
        outstandingDebtMicros: Math.max(0, -availableMicros),
        chargingStatus: "routerai_citygo_10x",
        topUpAvailable: true,
        history: [],
      },
    },
  };
  const calls = {
    dashboard: 0,
    phonePolicy: 0,
    posts: [] as string[],
    unexpected: [] as string[],
    external: 0,
  };
  await page.context().route("https://**", (route) => {
    calls.external++;
    return route.abort();
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") calls.posts.push(path);
    if (path === "/api/v1/dashboard" && request.method() === "GET") {
      calls.dashboard++;
      return route.fulfill({ json: board });
    }
    if (
      path === "/api/v1/phone-verification/policy" &&
      request.method() === "GET"
    ) {
      calls.phonePolicy++;
      return route.fulfill({
        json: {
          phoneVerification: "required",
          giftAmountMicros: 500_000_000,
          giftStatus: "eligible",
          deliveryProvider: "prosto_sms",
        },
      });
    }
    calls.unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic navigation request" },
    });
  });
  return { board, calls };
}

const toolbar = (page: Page) =>
  page.getByRole("region", { name: "Баланс и телефон", exact: true });
async function openBalance(page: Page) {
  await toolbar(page)
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Баланс и пополнение", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#citygo-balance")).toBeVisible();
}
const back = (page: Page) =>
  page.getByRole("button", { name: "Вернуться в приложение", exact: true });

test("a new account with no dialogue can find zero balance, top up and bind a phone without any automatic operation", async ({
  page,
}, info) => {
  const { calls } = await install(page);
  await page.goto("/");
  await expect(toolbar(page)).toBeVisible();
  await expect(toolbar(page)).toContainText("0 ₽");
  await expect(
    toolbar(page).getByRole("button", {
      name: "Телефон и подарок",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Сообщение помощнику")).toHaveCount(0);
  expect(calls.phonePolicy).toBe(0);
  await openBalance(page);
  await expect(page.locator("#citygo-balance")).toHaveCount(1);
  await expect(page.getByLabel("Сумма пополнения")).toHaveValue("100");
  await expect(page.getByLabel("Email для чека ЮKassa")).toHaveValue("");
  await expect(page.getByText("Подтверждение пока не подключено.")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Создать платёж", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("account-balance-navigation.png"),
    fullPage: true,
  });
  await back(page).click();
  await toolbar(page)
    .getByRole("button", { name: "Телефон и подарок", exact: true })
    .click();
  await expect(page.getByLabel("Российский мобильный номер")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Получить код по SMS", exact: true }),
  ).toBeDisabled();
  expect(calls.phonePolicy).toBe(1);
  expect(calls.posts).toEqual([]);
  expect(calls.unexpected).toEqual([]);
  expect(calls.external).toBe(0);
});

test("the account indicator preserves signed micro-rouble precision and separate reserves after reload", async ({
  page,
}) => {
  const { calls } = await install(page, { balanceMicros: -2_170_001 });
  await page.goto("/");
  await expect(toolbar(page)).toContainText("-2.170001 ₽");
  await openBalance(page);
  await expect(page.locator("#citygo-balance")).toContainText("-2.170001");
  await expect(page.locator("#citygo-balance")).toContainText("В резерве: 5");
  await expect(page.locator("#citygo-balance")).toContainText(
    "резервируется 5 ₽ CityGo",
  );
  await expect(page.locator("#citygo-balance")).toContainText(
    "стоимость модели ×10",
  );
  await page.reload();
  await expect(toolbar(page)).toContainText("-2.170001 ₽");
  expect(calls.posts).toEqual([]);
  expect(calls.unexpected).toEqual([]);
  expect(calls.external).toBe(0);
});

test("missing server credit is unavailable rather than a fabricated zero balance", async ({
  page,
}) => {
  const { board, calls } = await install(page);
  delete board.aiAccess.credit;
  await page.goto("/");
  await expect(toolbar(page)).toContainText("Баланс недоступен");
  await expect(
    toolbar(page).getByText("0 ₽ CityGo", { exact: true }),
  ).toHaveCount(0);
  await toolbar(page)
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Баланс и пополнение", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Не удалось получить баланс",
  );
  await expect(page.getByLabel("Сумма пополнения")).toHaveCount(0);
  expect(calls.posts).toEqual([]);
  expect(calls.unexpected).toEqual([]);
});

test("profile exposes balance and phone entry points and keeps a partially entered topup across navigation", async ({
  page,
}) => {
  const { calls } = await install(page, { balanceMicros: 12_345_678 });
  await page.goto("/");
  await expect(toolbar(page)).toContainText("12.345678 ₽");
  const profile = () =>
    page
      .getByRole("navigation", { name: "Личный кабинет CityGo", exact: true })
      .getByRole("button", { name: "Профиль", exact: true });
  await profile().click();
  await expect(
    page.getByRole("heading", { name: "Личный кабинет", exact: true }),
  ).toBeVisible();
  await page
    .locator(".conversation-home")
    .getByRole("button", { name: "Баланс и пополнение", exact: true })
    .click();
  await page.getByLabel("Сумма пополнения").fill("157");
  await page
    .getByLabel("Email для чека ЮKassa")
    .fill("receipt-navigation@example.test");
  await back(page).click();
  await profile().click();
  await page
    .locator(".conversation-home")
    .getByRole("button", { name: "Телефон и подарок", exact: true })
    .click();
  await expect(page.getByLabel("Российский мобильный номер")).toBeVisible();
  await back(page).click();
  await openBalance(page);
  await expect(page.getByLabel("Сумма пополнения")).toHaveValue("157");
  await expect(page.getByLabel("Email для чека ЮKassa")).toHaveValue(
    "receipt-navigation@example.test",
  );
  await expect(page.locator("#citygo-balance")).toHaveCount(1);
  expect(calls.posts).toEqual([]);
  expect(calls.unexpected).toEqual([]);
  expect(calls.external).toBe(0);
});

test("balance and phone navigation retain an unsent dialogue draft and refresh money only from the server", async ({
  page,
}) => {
  const { board, calls } = await install(page, {
    balanceMicros: 12_345_678,
    withThread: true,
  });
  await page.goto("/");
  const composer = page.getByLabel("Сообщение помощнику", { exact: true });
  await composer.fill("Черновик: хочу понять стоимость переезда.");
  await openBalance(page);
  await back(page).click();
  await expect(composer).toHaveValue(
    "Черновик: хочу понять стоимость переезда.",
  );
  await toolbar(page)
    .getByRole("button", { name: "Телефон и подарок", exact: true })
    .click();
  await expect(page.getByLabel("Российский мобильный номер")).toBeVisible();
  await back(page).click();
  await expect(composer).toHaveValue(
    "Черновик: хочу понять стоимость переезда.",
  );
  board.aiAccess.credit!.availableMicros = 10_210_000;
  board.aiAccess.credit!.spentMicros = 84_790_000;
  const previousReads = calls.dashboard;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => calls.dashboard).toBeGreaterThan(previousReads);
  await expect(toolbar(page)).toContainText("10.21 ₽");
  await expect(composer).toHaveValue(
    "Черновик: хочу понять стоимость переезда.",
  );
  expect(calls.posts).toEqual([]);
  expect(calls.unexpected).toEqual([]);
  expect(calls.external).toBe(0);
});
