import { expect, test, type Page } from "@playwright/test";
import type { BalanceHistoryEntry, Dashboard } from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
const cursor = "eyJ2IjoxfQ." + "a".repeat(43);
const entry = (
  id: number,
  kind: BalanceHistoryEntry["kind"] = "spend",
): BalanceHistoryEntry => ({
  id: (kind === "refund" ? "refund:" : "credit:") + id,
  kind,
  direction: ["topup", "gift"].includes(kind) ? "credit" : "debit",
  amountMicros: 2_170_001,
  createdAt: `2026-10-31T12:00:${String(id % 60).padStart(2, "0")}.000001Z`,
});
async function install(page: Page) {
  const state = {
    reads: [] as URL[],
    mutations: [] as string[],
    fail: false,
    denied: false,
    foreign: false,
    unexpected: [] as string[],
  };
  const dashboard: Dashboard = {
    user: { id: "101", email: "synthetic-history@example.test", role: "user" },
    profile: null,
    quests: [],
    xp: 0,
    thread: null,
    provider: "routerai",
    aiAccess: {
      granted: true,
      dailyLimit: 20,
      policy: {
        id: "a".repeat(64),
        version: "synthetic",
        provider: "routerai",
        model: "synthetic/no-network",
        recipient: "Synthetic",
        routing: "No provider",
        data: "Fictional",
      },
      credit: {
        currency: "RUB",
        bonusGranted: true,
        grantedMicros: 500_000_000,
        heldMicros: 0,
        spentMicros: 2_170_001,
        availableMicros: 497_829_999,
        chargingStatus: "routerai_citygo_10x",
        reservationMode: "fixed5_overdraft",
        minimumRequestBalanceMicros: 5_000_000,
        topUpAvailable: true,
        history: [],
      },
    },
  };
  await page.context().route("https://**", (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (route.request().method() !== "GET") state.mutations.push(path);
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/dashboard") return route.fulfill({ json: dashboard });
    if (path === "/api/v1/ai/credit/history") {
      state.reads.push(url);
      const filter = url.searchParams.get("filter") ?? "all";
      if (state.fail) {
        state.fail = false;
        return route.fulfill({
          status: 503,
          json: { error: "PRIVATE_UPSTREAM_ERROR" },
        });
      }
      if (state.denied)
        return route.fulfill({
          status: 401,
          json: { error: "login required" },
        });
      const more = !!url.searchParams.get("cursor"),
        entries =
          filter === "all"
            ? more
              ? [entry(2, "topup"), entry(1, "gift")]
              : Array.from({ length: 20 }, (_, i) => entry(50 - i))
            : filter === "refund"
              ? [entry(52, "refund")]
              : filter === "topup"
                ? [{ ...entry(53, "topup"), amountMicros: 10_000_000_000_000 }]
                : [];
      return route.fulfill({
        json: {
          userId: state.foreign ? "202" : "101",
          filter,
          entries,
          nextCursor: filter === "all" && !more ? cursor : null,
        },
      });
    }
    state.unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic history request" },
    });
  });
  return state;
}
async function open(page: Page) {
  await page.goto("/");
  await page
    .getByRole("region", { name: "Баланс и телефон", exact: true })
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  await page
    .getByRole("button", { name: "История баланса", exact: true })
    .click();
  return page.getByRole("region", { name: "История баланса", exact: true });
}
test("history has exact signed amounts, filters, bounded pages, accessible back and no money writes or persistent financial data", async ({
  page,
}, info) => {
  const state = await install(page),
    panel = await open(page);
  await expect(panel).toHaveClass(/ym-hide-content/);
  await expect(
    panel.getByRole("heading", { name: "История баланса" }),
  ).toBeFocused();
  await expect(panel.getByRole("listitem")).toHaveCount(20);
  await expect(panel.getByRole("listitem").first()).toContainText(
    "−2.170001 ₽",
  );
  await panel
    .getByRole("button", { name: "Показать ещё", exact: true })
    .click();
  await expect(panel.getByRole("listitem")).toHaveCount(22);
  await expect(panel.getByRole("listitem").last()).toContainText("+2.170001 ₽");
  await expect(panel.getByRole("button", { name: "Показать ещё" })).toHaveCount(
    0,
  );
  await panel.getByRole("button", { name: "Возврат", exact: true }).click();
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByRole("listitem")).toContainText("Возврат");
  await expect(panel.getByRole("listitem")).toContainText("−2.170001 ₽");
  await panel.getByRole("button", { name: "Подарок", exact: true }).click();
  await expect(panel).toContainText("Таких операций пока нет.");
  await panel.getByRole("button", { name: "Пополнение", exact: true }).click();
  await expect(panel.getByRole("listitem")).toContainText("+10000000 ₽");
  state.fail = true;
  await panel.getByRole("button", { name: "Обновить историю" }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "Не удалось загрузить историю",
  );
  await expect(panel).not.toContainText("PRIVATE_UPSTREAM_ERROR");
  await panel.getByRole("button", { name: "Все операции" }).click();
  await expect(panel.getByRole("listitem")).toHaveCount(20);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await panel.screenshot({ path: info.outputPath("balance-history.png") });
  await panel.getByRole("button", { name: "Назад к балансу" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveCount(0);
  await expect(page.locator("#citygo-balance")).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).hash).toBe("");
  expect(
    await page.evaluate(() =>
      JSON.stringify([
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]),
    ),
  ).not.toMatch(/2170001|2\.170001|amountMicros|credit:50|refund:52/);
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(
    state.reads.every(
      (url) =>
        !url.searchParams.has("userId") && !url.searchParams.has("limit"),
    ),
  ).toBe(true);
});
test("a foreign history response clears private contents and returns to login", async ({
  page,
}) => {
  const state = await install(page),
    panel = await open(page);
  await expect(panel.getByRole("listitem")).toHaveCount(20);
  state.foreign = true;
  await panel.getByRole("button", { name: "Обновить историю" }).click();
  await expect(
    page.getByRole("button", { name: "Войти", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "История баланса", exact: true }),
  ).toHaveCount(0);
  expect(state.mutations).toEqual([]);
});
