import { openAccountMenu } from "./navigation-helper";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
import { test, expect, type Page } from "@playwright/test";
import type { Dashboard, OwnerNpdReceiptTask } from "@citygo/contracts";

const webOrigin = "http://localhost:3000";
const documentUrl =
  "https://lknpd.nalog.ru/api/v1/receipt/SYNTHETIC/receipt-owner-1/print";
const receipt: OwnerNpdReceiptTask = {
  id: "871802b8-deb3-4235-8f61-9e28a7889a52",
  userId: "1",
  paymentId: "synthetic-owner-payment-1",
  paymentProvider: "yookassa",
  amountKopeks: 10_000,
  cumulativeRefundedKopeks: 0,
  remainingIncomeKopeks: 10_000,
  revision: 2,
  registrationStatus: "operator_reported",
  deliveryStatus: "pending",
  correctionStatus: "not_required",
  activeEvidenceId: "c2529a6e-c322-4b84-a4fd-6056e0ab5e28",
  activeReceiptId: "receipt-owner-1",
  activeReceiptUrl: documentUrl,
  reviewReason: null,
  observedAt: "2026-10-18T10:00:00.000Z",
  createdAt: "2026-10-18T10:00:00.000Z",
  updatedAt: "2026-10-18T10:01:00.000Z",
};
async function fixture(page: Page, userId = "1") {
  const state = {
    reads: 0,
    dashboardReads: 0,
    tasks: [{ ...receipt }],
    delay: false,
    release: () => {},
    delivered: Promise.resolve(),
    unexpected: [] as string[],
    errors: [] as string[],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  let deliver = () => {};
  const gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  state.delivered = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  // Local static assets are allowed; ALL API calls are mocked. No external
  // FNS/payment/provider endpoint, or even a local API server, can be reached.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin !== webOrigin
    ) {
      state.unexpected.push(url.href);
      return route.abort();
    }
    return route.fallback();
  });
  await page.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
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
    if (url.origin !== webOrigin) {
      state.unexpected.push(url.href);
      return route.abort();
    }
    if (
      url.pathname === "/api/v1/dashboard" &&
      route.request().method() === "GET"
    ) {
      state.dashboardReads++;
      const dashboard: Dashboard = {
        user: {
          id: userId,
          email: "owner@example.test",
          username: null,
          role: "user",
          mustChangePassword: false,
        },
        profile: null,
        quests: [],
        xp: 0,
        thread: null,
        provider: "unconfigured",
        aiAccess: { policy: null, granted: false, dailyLimit: 0 },
      };
      return route.fulfill({ json: dashboard });
    }
    if (
      url.pathname === "/api/v1/payments/receipts" &&
      route.request().method() === "GET"
    ) {
      state.reads++;
      if (!state.delay) return route.fulfill({ json: { tasks: state.tasks } });
      await gate;
      try {
        await route.fulfill({ json: { tasks: state.tasks } });
      } catch {
        /* A logged-out UI may abort the old request. */
      } finally {
        deliver();
      }
      return;
    }
    state.unexpected.push(url.pathname);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Давайте начнём с того, что волнует",
      exact: true,
    }),
  ).toBeVisible();
  return state;
}
const panel = (page: Page) =>
  page.getByRole("region", { name: "Мои чеки", exact: true });
const open = (page: Page) =>
  page.getByRole("button", { name: "Мои чеки", exact: true });

test("receipts are requested only after explicit open, show the owner's actual100RUB with safe FNS link, and return to the app", async ({
  page,
}) => {
  const state = await fixture(page);
  expect(state.reads).toBe(0);
  await expect(panel(page)).toHaveCount(0);
  await openAccountMenu(page);
  await open(page).click();
  await expect(
    panel(page).getByText(`Номер оплаты: ${receipt.paymentId}`, {
      exact: true,
    }),
  ).not.toBeVisible();
  await panel(page).getByText("Данные для поддержки", { exact: true }).click();
  await expect(
    panel(page).getByText(`Номер оплаты: ${receipt.paymentId}`, {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.reads).toBe(1);
  await expect(panel(page).locator("dl > dd").first()).toHaveText("100,00 ₽");
  await expect(panel(page).locator("dl > dd").nth(1)).toHaveText("0,00 ₽");
  await expect(panel(page).locator("dl > dd").nth(2)).toHaveText("100,00 ₽");
  await expect(panel(page)).toContainText("Дата подтверждения оплаты");
  await expect(panel(page)).toContainText("Оформление чека отмечено");
  await expect(panel(page)).toContainText("Отправка чека не подтверждена");
  expect(await panel(page).innerText()).not.toMatch(
    /ЮKassa|НПД|×10|умножения|стоимость модели/i,
  );
  const link = panel(page).getByRole("link", {
    name: "Открыть чек ФНС",
    exact: true,
  });
  await expect(link).toHaveAttribute("href", documentUrl);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  await page
    .getByRole("button", { name: "Вернуться в приложение", exact: true })
    .click();
  await expect(panel(page)).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Давайте начнём с того, что волнует",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.reads).toBe(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("cross-tab logout clears a loaded receipt and a delayed refresh cannot republish it or restore the session", async ({
  page,
}) => {
  const state = await fixture(page);
  await openAccountMenu(page);
  await open(page).click();
  await expect(
    panel(page).getByRole("link", { name: "Открыть чек ФНС", exact: true }),
  ).toBeVisible();
  state.delay = true;
  try {
    await panel(page)
      .getByRole("button", { name: "Обновить чеки", exact: true })
      .click();
    await expect.poll(() => state.reads).toBe(2);
    await expect(
      page.getByText(`Номер оплаты: ${receipt.paymentId}`, { exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "citygo-session-changed",
          newValue: "synthetic-receipt-logout",
        }),
      ),
    );
    await expect(open(page)).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Сохраните свой путь", exact: true }),
    ).toBeVisible();
  } finally {
    state.release();
  }
  await state.delivered;
  await expect(panel(page)).toHaveCount(0);
  await expect(open(page)).toHaveCount(0);
  await expect(
    page.getByText(`Номер оплаты: ${receipt.paymentId}`, { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('a[href^="https://lknpd.nalog.ru/"]')).toHaveCount(
    0,
  );
  expect(state.reads).toBe(2);
  expect(state.dashboardReads).toBe(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a legacy nonnumeric dashboard ID fails only the receipt panel with a generic error and makes no receipt request", async ({
  page,
}) => {
  const state = await fixture(page, "legacy-compatible-user");
  expect(state.reads).toBe(0);
  await openAccountMenu(page);
  await open(page).click();
  await expect(panel(page).getByRole("alert")).toHaveText(
    "Не удалось загрузить чеки. Попробуйте позже.",
  );
  await expect(panel(page).getByRole("link")).toHaveCount(0);
  await expect(panel(page)).not.toContainText(receipt.paymentId);
  await page
    .getByRole("button", { name: "Вернуться в приложение", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Давайте начнём с того, что волнует",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.reads).toBe(0);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a receipt belonging to another account is rejected without exposing its payment ID or FNS URL", async ({
  page,
}) => {
  const state = await fixture(page);
  state.tasks = [{ ...receipt, userId: "2" }];
  await openAccountMenu(page);
  await open(page).click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "Не удалось загрузить чеки",
  );
  await expect(panel(page)).not.toContainText(receipt.paymentId);
  await expect(panel(page).getByRole("link")).toHaveCount(0);
  expect(state.reads).toBe(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
