import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
import { test, expect, type Page } from "@playwright/test";
import type {
  AccountUser,
  AiControlStatus,
  Dashboard,
  PaymentAdmissionStatus,
} from "@citygo/contracts";

const owner: AccountUser = {
  id: "1",
  email: "owner@example.test",
  username: "admin",
  role: "super_admin",
  mustChangePassword: false,
};
const ai: AiControlStatus = {
  current: { provider: "disabled", policyId: null, revision: 1 },
  effectiveProvider: "unconfigured",
  environmentDisabled: false,
  automaticFallback: false,
  options: [],
  audit: [],
};
const base = "/api/v1/admin/payments/admission";
const webOrigin = "http://localhost:3000";
async function fixture(page: Page, viewer: AccountUser = owner) {
  const state = {
    reads: 0,
    writes: [] as Record<string, unknown>[],
    unexpected: [] as string[],
    conflict: false,
    hold: false,
    release: () => {},
    delivered: Promise.resolve(),
    status: {
      revision: 7,
      acceptingNewCheckouts: false,
      reconciliationEnabled: true,
      mode: "closed",
      ownerUserId: null,
      leaseUntil: null,
      manualNpdResponsibilityAccepted: false,
      reconciliationCheckedAt: "2026-10-19T00:00:00.000Z",
      reconciliationOk: true,
      runtimeBindingMatches: true,
      available: false,
      reason: "closed",
      npdBacklog: {
        pendingRegistration: 1,
        pendingDelivery: 1,
        requiredCorrection: 0,
        review: 0,
        total: 1,
        oldestObservedAt: "2026-10-18T00:00:00.000Z",
      },
    } as PaymentAdmissionStatus,
  };
  const delayed = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  let delivered: () => void = () => {};
  state.delivered = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  // No provider/external network is reachable; all application API requests are
  // fulfilled locally, including unexpected requests (which fail the test).
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
    const path = url.pathname;
    if (path === "/api/v1/dashboard") {
      const dashboard: Dashboard = {
        user: viewer,
        profile: null,
        quests: [],
        xp: 0,
        thread: null,
        provider: "unconfigured",
        aiAccess: { policy: null, granted: false, dailyLimit: 0 },
      };
      return route.fulfill({ json: dashboard });
    }
    if (path === "/api/v1/admin/overview")
      return route.fulfill({
        json: { counts: { users: 1, completed: 0, xp: 0 }, pendingHuman: [] },
      });
    if (path === "/api/v1/admin/ai") return route.fulfill({ json: ai });
    if (path === "/api/v1/admin/accounts")
      return route.fulfill({ json: { users: [viewer] } });
    if (path === base && route.request().method() === "GET") {
      state.reads++;
      return route.fulfill({ json: state.status });
    }
    if (path === `${base}/commands` && route.request().method() === "POST") {
      const command = route.request().postDataJSON() as Record<string, unknown>;
      state.writes.push(command);
      if (state.hold) await delayed;
      if (state.conflict) {
        state.status = { ...state.status, revision: state.status.revision + 1 };
        return route.fulfill({
          status: 409,
          json: { error: "Synthetic revision conflict" },
        });
      }
      state.status = { ...state.status, revision: state.status.revision + 1 };
      if (command.action === "open")
        state.status = {
          ...state.status,
          acceptingNewCheckouts: true,
          mode: "continuous",
          ownerUserId: viewer.id,
          manualNpdResponsibilityAccepted: true,
          available: true,
          reason: null,
        };
      if (command.action === "close")
        state.status = {
          ...state.status,
          acceptingNewCheckouts: false,
          mode: "closed",
          available: false,
          reason: "closed",
        };
      if (command.action === "set_reconciliation")
        state.status = {
          ...state.status,
          reconciliationEnabled: command.enabled === true,
          reconciliationOk: false,
          reconciliationCheckedAt: null,
          available: false,
        };
      try {
        await route.fulfill({ json: state.status });
      } catch {
        /* Session invalidation may cancel the old response. */
      } finally {
        delivered();
      }
      return;
    }
    state.unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  await page.goto("/admin");
  await page
    .getByRole("button", { name: "Обновить сводку", exact: true })
    .click();
  return state;
}
const details = (page: Page) =>
  page.getByRole("region", { name: "Состояние допуска оплаты", exact: true });
const load = (page: Page) =>
  page.getByRole("button", { name: "Обновить допуск оплаты", exact: true });
const open = (page: Page) =>
  page.getByRole("button", {
    name: "Подтвердить непрерывный приём",
    exact: true,
  });
const close = (page: Page) =>
  page.getByRole("button", { name: "Закрыть новые пополнения", exact: true });
const acceptanceNotice =
  "Серверный допуск и исправная сверка не подтверждают, что ЮKassa примет платёж или что данные чека совместимы с настройками магазина. Отдельная приёмка запуска включает реальную оплату, полный возврат и проверку чекового пути.";
const fiscalNotice =
  "Принятие ответственности за ручные НПД-чеки не настраивает фискальные параметры магазина ЮKassa.";

test("super admin explicitly loads admission, acknowledges manual NPD, and sends exact CAS commands without runtime bindings", async ({
  page,
}) => {
  const state = await fixture(page);
  await expect(load(page)).toBeVisible();
  await expect(page.getByText(acceptanceNotice, { exact: true })).toBeVisible();
  await expect(page.getByText(fiscalNotice, { exact: true })).toBeVisible();
  expect(state.reads).toBe(0);
  await expect(details(page)).toHaveCount(0);
  expect(state.writes).toEqual([]);
  await load(page).click();
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByRole("status")).toContainText(
    "новые пополнения недоступны",
  );
  await expect(page.getByText(acceptanceNotice, { exact: true })).toBeVisible();
  await expect(page.getByText(fiscalNotice, { exact: true })).toBeVisible();
  await expect(details(page)).toContainText(
    "Одна задача может входить в несколько категорий",
  );
  await expect(open(page)).toBeDisabled();
  await details(page)
    .getByRole("checkbox", { name: /Я лично принимаю ответственность/ })
    .check();
  await open(page).click();
  await expect(
    details(page).getByText("Принята ответственным", { exact: true }),
  ).toBeVisible();
  await expect(details(page).getByRole("status")).toContainText(
    "серверный допуск новых пополнений открыт",
  );
  await expect(page.getByText(acceptanceNotice, { exact: true })).toBeVisible();
  await expect(page.getByText(fiscalNotice, { exact: true })).toBeVisible();
  expect(state.writes[0]).toEqual({
    requestId: expect.any(String),
    expectedRevision: 7,
    action: "open",
    mode: "continuous",
    manualNpdResponsibilityAccepted: true,
  });
  await expect(details(page).getByRole("checkbox")).not.toBeChecked();
  await close(page).click();
  await expect(details(page).getByRole("status")).toContainText(
    "новые пополнения недоступны",
  );
  await expect(page.getByText(acceptanceNotice, { exact: true })).toBeVisible();
  await expect(page.getByText(fiscalNotice, { exact: true })).toBeVisible();
  await page
    .getByRole("button", {
      name: "Приостановить серверную сверку",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Включить серверную сверку", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Приостановить серверную сверку",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.writes.slice(1)).toEqual([
    { requestId: expect.any(String), expectedRevision: 8, action: "close" },
    {
      requestId: expect.any(String),
      expectedRevision: 9,
      action: "set_reconciliation",
      enabled: false,
    },
    {
      requestId: expect.any(String),
      expectedRevision: 10,
      action: "set_reconciliation",
      enabled: true,
    },
  ]);
  for (const command of state.writes)
    expect(command.requestId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  expect(new Set(state.writes.map((command) => command.requestId)).size).toBe(
    4,
  );
  expect(state.unexpected).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("409 discards stale actions and never automatically retries POST or refreshes admission", async ({
  page,
}) => {
  const state = await fixture(page);
  await load(page).click();
  await expect(details(page)).toBeVisible();
  state.conflict = true;
  await close(page).click();
  await expect(page.locator(".admin-error[role=alert]")).toContainText(
    "старая форма скрыта",
  );
  await expect(details(page)).toHaveCount(0);
  await expect(close(page)).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.reads).toBe(1);
  state.conflict = false;
  await load(page).click();
  await expect(details(page)).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.reads).toBe(2);
  await close(page).click();
  await expect.poll(() => state.writes.length).toBe(2);
  await expect(details(page)).toBeVisible();
  expect(state.writes[1]).toEqual({
    requestId: expect.any(String),
    expectedRevision: 8,
    action: "close",
  });
  expect(state.unexpected).toEqual([]);
});

test("session invalidation hides controls and a delayed old POST cannot republish status or issue follow-up requests", async ({
  page,
}) => {
  const state = await fixture(page);
  await load(page).click();
  await expect(details(page)).toBeVisible();
  state.hold = true;
  await close(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "citygo-session-changed",
        newValue: "synthetic-payment-admission-logout",
      }),
    ),
  );
  await expect(load(page)).toHaveCount(0);
  const reads = state.reads;
  state.release();
  await state.delivered;
  await expect(details(page)).toHaveCount(0);
  await expect(load(page)).toHaveCount(0);
  await expect(
    page.getByText("Сервер сохранил настройку допуска.", { exact: false }),
  ).toHaveCount(0);
  expect(state.reads).toBe(reads);
  expect(state.writes).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
});

test("ordinary admin never requests or renders payment-admission controls", async ({
  page,
}) => {
  const state = await fixture(page, {
    ...owner,
    id: "3",
    role: "admin",
    username: "ordinary-admin",
  });
  await expect(
    page.getByText("Пользователей: 1", { exact: false }),
  ).toBeVisible();
  await expect(load(page)).toHaveCount(0);
  await expect(details(page)).toHaveCount(0);
  expect(state.reads).toBe(0);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
