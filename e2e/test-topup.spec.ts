import { test, expect, type Page } from "@playwright/test";
import type { Dashboard, TopupOrder } from "@citygo/contracts";

const order: TopupOrder = {
  orderId: "4a7ecb31-0895-4b81-965b-69f47c6ce9e7",
  amountKopeks: 10000,
  creditMicros: 100000000,
  currency: "RUB",
  test: true,
  status: "pending",
  credited: false,
  confirmationUrl: "https://checkout.example.test/pay",
  createdAt: "2026-10-18T10:00:00.000Z",
  updatedAt: "2026-10-18T10:00:00.000Z",
};

function dashboard(topUpAvailable = true): Dashboard {
  return {
    user: {
      id: "101",
      email: "checkout@example.test",
      role: "user",
      mustChangePassword: false,
    },
    profile: null,
    quests: [],
    xp: 0,
    thread: { id: "101", agentKey: "support", messages: [] },
    provider: "unconfigured",
    aiAccess: {
      policy: null,
      granted: false,
      dailyLimit: 0,
      credit: {
        currency: "RUB",
        bonusGranted: false,
        grantedMicros: 0,
        availableMicros: 0,
        spentMicros: 0,
        heldMicros: 0,
        chargingStatus: "routerai_citygo_10x",
        topUpAvailable,
        history: [],
      },
    },
  };
}

async function fixture(
  page: Page,
  options: {
    available?: boolean;
    failFirst?: boolean;
    unsafeUrl?: boolean;
  } = {},
) {
  const state = {
    creates: [] as { requestId: string; amountKopeks: number }[],
    reconciles: 0,
    unexpected: [] as string[],
  };
  // Entire application API is intercepted. No real payment, account, DB or AI.
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/dashboard")
      return route.fulfill({ json: dashboard(options.available) });
    if (path === "/api/v1/payments/topups" && request.method() === "POST") {
      state.creates.push(request.postDataJSON());
      if (options.failFirst && state.creates.length === 1)
        return route.abort("failed");
      return route.fulfill({
        json: {
          ...order,
          ...(options.unsafeUrl
            ? { confirmationUrl: "http://checkout.example.test/unsafe" }
            : {}),
        },
      });
    }
    if (
      path === `/api/v1/payments/topups/${order.orderId}` &&
      request.method() === "GET"
    )
      return route.fulfill({ json: order });
    if (
      path === `/api/v1/payments/topups/${order.orderId}/reconcile` &&
      request.method() === "POST"
    ) {
      state.reconciles++;
      expect(request.postDataJSON()).toEqual({});
      return route.fulfill({
        json: { ...order, status: "succeeded", credited: true },
      });
    }
    state.unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  return state;
}

test("test checkout is hidden without the server capability; return parameters do not grant money", async ({
  page,
}) => {
  const state = await fixture(page, { available: false });
  await page.goto("/?payment=succeeded&credited=true&amount=10000");
  await expect(
    page.getByRole("heading", { name: "Баланс CityGo", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Тестовое пополнение ЮKassa",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Пополнение пока недоступно.", { exact: false }),
  ).toBeVisible();
  expect(state.creates).toEqual([]);
  expect(state.reconciles).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("ambiguous create survives reload with the same key; only explicit reconciliation confirms credit", async ({
  page,
}) => {
  const state = await fixture(page, { failFirst: true });
  await page.goto("/");
  await expect(page.getByLabel("Сумма тестового пополнения")).toHaveValue(
    "100",
  );
  await expect(
    page.getByRole("button", { name: "Создать тестовый платёж", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Создать тестовый платёж", exact: true })
    .click();
  await expect(page.locator(".ai-access [role=alert]")).toContainText(
    "Не удалось подтвердить результат",
  );
  expect(state.creates).toHaveLength(1);
  await page.reload();
  const retry = page.getByRole("button", {
    name: "Повторить создание с прежним ID",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await expect(page.getByLabel("Сумма тестового пополнения")).toBeDisabled();
  await retry.click();
  const checkout = page.getByRole("link", {
    name: "Открыть тестовую оплату ЮKassa",
    exact: true,
  });
  await expect(checkout).toHaveAttribute("href", order.confirmationUrl!);
  await expect(checkout).toHaveAttribute("rel", "noopener noreferrer");
  await expect(checkout).toHaveAttribute("target", "_blank");
  expect(state.creates).toHaveLength(2);
  expect(state.creates[0]).toEqual(state.creates[1]);
  expect(state.creates[0]?.amountKopeks).toBe(10000);
  expect(state.reconciles).toBe(0);
  await page.goto(`/?payment=succeeded&credited=true&orderId=${order.orderId}`);
  await expect(
    page.getByText("зачисление не подтверждено", { exact: false }),
  ).toBeVisible();
  expect(state.reconciles).toBe(0);
  await page
    .getByRole("button", { name: "Проверить тестовый платёж", exact: true })
    .click();
  await expect(
    page.getByText("тестовое зачисление подтверждено сервером", {
      exact: false,
    }),
  ).toBeVisible();
  expect(state.reconciles).toBe(1);
  await expect(
    page.getByText("настоящие деньги не списываются", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Новый тестовый платёж", exact: true }),
  ).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test("a malformed checkout response never exposes an unsafe payment link or retries automatically", async ({
  page,
}) => {
  const state = await fixture(page, { unsafeUrl: true });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Создать тестовый платёж", exact: true })
    .click();
  await expect(page.locator(".ai-access [role=alert]")).toContainText(
    "Не удалось подтвердить результат",
  );
  await expect(
    page.getByRole("link", {
      name: "Открыть тестовую оплату ЮKassa",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Повторить создание с прежним ID",
      exact: true,
    }),
  ).toBeEnabled();
  expect(state.creates).toHaveLength(1);
  expect(state.reconciles).toBe(0);
  expect(state.unexpected).toEqual([]);
});
