import { syntheticConsentPolicy } from "./service-consent-fixture";
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
      budget: {
        currency: "RUB",
        day: "2026-10-18",
        resetAt: "2026-10-19T00:00:00.000Z",
        limitMicros: 1_000_000,
        reservedTodayMicros: Number.MAX_SAFE_INTEGER,
        remainingMicros: 0,
      },
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
    live?: boolean;
    recoverAttempt?: boolean;
    createGate?: Promise<void>;
    responseStatus?: "creating" | "succeeded";
  } = {},
) {
  const state = {
    available: options.available ?? true,
    userId: "101",
    creates: [] as {
      requestId: string;
      amountKopeks: number;
      receiptEmail?: string;
    }[],
    reconciles: 0,
    reads: 0,
    attemptReads: 0,
    credited: false,
    unexpected: [] as string[],
  };
  // Synthetic popup destination is intercepted for every page in this test's
  // context. No new tab ever reaches YooKassa or any external checkout host.
  await page.context().route("https://checkout.example.test/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<!doctype html><meta charset="utf-8"><title>Synthetic checkout</title><h1>Вымышленная страница оплаты</h1>',
    }),
  );
  // Entire application API is intercepted. No real payment, account, DB or AI.
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
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/dashboard") {
      const board = dashboard(state.available);
      board.user.id = state.userId;
      board.user.email = `checkout-${state.userId}@example.test`;
      if (state.credited && board.aiAccess.credit) {
        board.aiAccess.credit.grantedMicros = order.creditMicros;
        board.aiAccess.credit.availableMicros = order.creditMicros;
      }
      return route.fulfill({ json: board });
    }
    if (path === "/api/v1/payments/topups" && request.method() === "POST") {
      state.creates.push(request.postDataJSON());
      await options.createGate;
      if (options.failFirst && state.creates.length === 1)
        return route.abort("failed");
      return route.fulfill({
        json: {
          ...order,
          test: options.live !== true,
          ...(options.responseStatus
            ? {
                status: options.responseStatus,
                credited: options.responseStatus === "succeeded",
                confirmationUrl: undefined,
              }
            : {}),
          ...(options.unsafeUrl
            ? { confirmationUrl: "http://checkout.example.test/unsafe" }
            : {}),
        },
      });
    }
    if (
      path.startsWith("/api/v1/payments/topup-attempts/") &&
      request.method() === "GET"
    ) {
      state.attemptReads++;
      return options.recoverAttempt
        ? route.fulfill({ json: { ...order, test: options.live !== true } })
        : route.fulfill({ status: 404, json: { error: "Платёж не найден" } });
    }
    if (
      path === `/api/v1/payments/topups/${order.orderId}` &&
      request.method() === "GET"
    ) {
      state.reads++;
      return route.fulfill({ json: { ...order, test: options.live !== true } });
    }
    if (
      path === `/api/v1/payments/topups/${order.orderId}/reconcile` &&
      request.method() === "POST"
    ) {
      state.reconciles++;
      state.credited = true;
      expect(request.postDataJSON()).toEqual({});
      return route.fulfill({
        json: {
          ...order,
          test: options.live !== true,
          status: "succeeded",
          credited: true,
        },
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

const savedAttempt = {
  requestId: "356c6b57-eb44-43c6-af7c-7e392a315aeb",
  amountKopeks: order.amountKopeks,
  orderId: order.orderId,
};

async function saveSyntheticAttempt(
  page: Page,
  attempt: { requestId: string; amountKopeks: number; orderId?: string },
) {
  await page.addInitScript((value) => {
    sessionStorage.setItem("citygo.test-topup.101", JSON.stringify(value));
  }, attempt);
}

async function openBalance(page: Page) {
  await page
    .getByRole("region", { name: "Баланс и телефон", exact: true })
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  await expect(page.locator("#citygo-balance")).toBeVisible();
}

test("checkout is hidden without the server capability; return parameters do not grant money", async ({
  page,
}) => {
  const state = await fixture(page, { available: false });
  await page.goto("/?payment=succeeded&credited=true&amount=10000");
  await openBalance(page);
  await expect(
    page.getByRole("heading", { name: "Баланс и пополнение", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("#citygo-wallet-view")
      .getByText("9007199254.740991", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Пополнение баланса",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Пополнение временно недоступно.", { exact: false }),
  ).toBeVisible();
  expect(state.creates).toEqual([]);
  expect(state.reconciles).toBe(0);
  expect(page.context().pages()).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
});

test("ambiguous create retries the frozen email and key in memory; only explicit reconciliation confirms credit", async ({
  page,
}) => {
  const state = await fixture(page, { failFirst: true });
  await page.goto("/");
  await openBalance(page);
  await expect(page.getByLabel("Сумма пополнения")).toHaveValue("100");
  await expect(page.getByLabel("Email для чека")).toHaveValue("");
  await page
    .getByLabel("Email для чека")
    .fill("receipt-buyer@synthetic-citygo-mail.ru");
  await expect(
    page
      .getByRole("region", { name: "Пополнение баланса", exact: true })
      .getByRole("button", { name: "Пополнить баланс", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("region", { name: "Пополнение баланса", exact: true })
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  await expect(page.locator(".ai-access [role=alert]")).toContainText(
    "Не удалось проверить платёж",
  );
  expect(state.creates).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("citygo.test-topup.101")!),
    ),
  ).toEqual({
    requestId: state.creates[0]!.requestId,
    amountKopeks: order.amountKopeks,
  });
  await expect(page.getByLabel("Email для чека")).toHaveCount(0);
  const retry = page.getByRole("button", {
    name: "Продолжить оплату",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await expect(page.getByLabel("Сумма пополнения")).toBeDisabled();
  await retry.click();
  const checkout = page.getByRole("link", {
    name: "Открыть тестовую оплату",
    exact: true,
  });
  await expect(checkout).toHaveAttribute("href", order.confirmationUrl!);
  await expect(checkout).toHaveAttribute("rel", "noopener noreferrer");
  await expect(checkout).toHaveAttribute("target", "_blank");
  expect(state.creates).toHaveLength(2);
  expect(state.creates[0]).toEqual(state.creates[1]);
  expect(state.creates[0]?.amountKopeks).toBe(10000);
  expect(state.creates[0]?.receiptEmail).toBe(
    "receipt-buyer@synthetic-citygo-mail.ru",
  );
  expect(state.reconciles).toBe(0);
  await page.goto(`/?payment=succeeded&credited=true&orderId=${order.orderId}`);
  await openBalance(page);
  await expect(
    page.getByText("зачисление не подтверждено", { exact: false }),
  ).toBeVisible();
  expect(state.reconciles).toBe(0);
  await page
    .getByRole("button", { name: "Проверить платёж", exact: true })
    .click();
  await expect(
    page.getByText("зачислено на баланс", {
      exact: false,
    }),
  ).toBeVisible();
  expect(state.reconciles).toBe(1);
  await expect(
    page.getByText("Деньги не списываются", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Пополнить ещё", exact: true }),
  ).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test("a malformed checkout response never exposes an unsafe payment link or retries automatically", async ({
  page,
}) => {
  const state = await fixture(page, { unsafeUrl: true });
  await page.goto("/");
  await openBalance(page);
  await page
    .getByLabel("Email для чека")
    .fill("receipt-buyer@synthetic-citygo-mail.ru");
  await page
    .getByRole("region", { name: "Пополнение баланса", exact: true })
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  await expect(page.locator(".ai-access [role=alert]")).toContainText(
    "Не удалось проверить платёж",
  );
  await expect(
    page.getByRole("link", {
      name: "Открыть тестовую оплату",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Продолжить оплату",
      exact: true,
    }),
  ).toBeEnabled();
  expect(state.creates).toHaveLength(1);
  expect(state.reconciles).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("live checkout distinguishes test mode, credits 100 to 100 and never settles from return URL or an automatic GET", async ({
  page,
}) => {
  const state = await fixture(page, { live: true });
  await page.goto("/?payment=succeeded&credited=true&amount=10000");
  await openBalance(page);
  const panel = page.getByRole("region", { name: "Пополнение баланса" });
  await expect(panel).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Баланс CityGo", exact: true }),
  ).toContainText("0 ₽ CityGo");
  await expect(panel.getByLabel("Сумма пополнения")).toHaveValue("100");
  await expect(panel.getByLabel("Email для чека")).toHaveValue("");
  await panel
    .getByLabel("Email для чека")
    .fill("receipt-buyer@synthetic-citygo-mail.ru");
  expect(state.creates).toHaveLength(0);
  expect(state.reconciles).toBe(0);
  await panel
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  await expect(panel).not.toContainText("Тестовая оплата");
  await expect(panel).toContainText("100 ₽ CityGo");
  await expect(panel).not.toContainText(/ЮKassa|×10|стоимость модели|резерв/i);
  const checkout = panel.getByRole("link", {
    name: "Перейти к оплате",
    exact: true,
  });
  await expect(checkout).toHaveAttribute("href", order.confirmationUrl!);
  await expect(checkout).toHaveAttribute("rel", "noopener noreferrer");
  await expect(checkout).toHaveAttribute("target", "_blank");
  await expect(
    panel.getByRole("link", {
      name: "Открыть тестовую оплату",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(state.creates).toHaveLength(1);
  expect(state.creates[0]?.amountKopeks).toBe(10000);
  expect(state.creates[0]?.receiptEmail).toBe(
    "receipt-buyer@synthetic-citygo-mail.ru",
  );
  const stored = await page.evaluate(() =>
    sessionStorage.getItem("citygo.test-topup.101"),
  );
  expect(stored).not.toContain("receipt-buyer");
  expect(stored).not.toContain("receiptEmail");
  expect(state.reconciles).toBe(0);
  await page.goto(`/?payment=succeeded&credited=true&orderId=${order.orderId}`);
  await openBalance(page);
  await expect(panel).toContainText("зачисление не подтверждено");
  await expect.poll(() => state.reads).toBe(1);
  expect(state.creates).toHaveLength(1);
  expect(state.reconciles).toBe(0);
  await expect(
    page.getByRole("region", { name: "Баланс CityGo", exact: true }),
  ).toContainText("0 ₽ CityGo");
  await panel
    .getByRole("button", { name: "Проверить платёж", exact: true })
    .click();
  await expect(panel).toContainText("зачислено на баланс");
  await expect(
    page.getByRole("region", { name: "Баланс CityGo", exact: true }),
  ).toContainText("100 ₽ CityGo");
  expect(state.reconciles).toBe(1);
  expect(state.creates).toHaveLength(1);
  await expect(
    panel.getByRole("button", { name: "Пополнить ещё", exact: true }),
  ).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test("closed checkout keeps a saved pending payment readable and explicitly reconcilable without another create", async ({
  page,
}) => {
  const state = await fixture(page, { available: false, live: true });
  await saveSyntheticAttempt(page, savedAttempt);
  await page.goto("/?payment=succeeded&credited=true");
  await openBalance(page);
  const panel = page.getByRole("region", { name: "Пополнение баланса" });
  await expect(panel).toContainText("Пополнение временно недоступно");
  await panel.getByText("Данные для поддержки", { exact: true }).click();
  await expect(panel).toContainText(savedAttempt.requestId);
  await expect.poll(() => state.reads).toBe(1);
  await expect(panel).toContainText("зачисление не подтверждено");
  await expect(panel).toContainText(
    "Если деньги уже списаны, сначала проверьте платёж",
  );
  await expect(panel.getByLabel("Сумма пополнения")).toHaveCount(0);
  await expect(panel.getByLabel("Email для чека")).toHaveCount(0);
  await expect(
    panel.getByRole("button", {
      name: /Пополнить баланс|Продолжить оплату|Пополнить ещё/i,
    }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("link", { name: "Перейти к оплате", exact: true }),
  ).toHaveAttribute("href", order.confirmationUrl!);
  expect(state.creates).toEqual([]);
  expect(state.reconciles).toBe(0);
  await panel
    .getByRole("button", { name: "Проверить платёж", exact: true })
    .click();
  await expect(panel).toContainText("зачислено на баланс");
  await expect(
    page.getByRole("region", { name: "Баланс CityGo", exact: true }),
  ).toContainText("100 ₽ CityGo");
  await expect(
    panel.getByRole("link", { name: "Перейти к оплате", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Пополнить ещё", exact: true }),
  ).toHaveCount(0);
  expect(state.creates).toEqual([]);
  expect(state.reconciles).toBe(1);
  expect(state.unexpected).toEqual([]);
});

test("closed checkout preserves an ambiguous attempt without POST, automatic retry or a new identity", async ({
  page,
}) => {
  const state = await fixture(page, { available: false });
  const ambiguous = {
    requestId: savedAttempt.requestId,
    amountKopeks: savedAttempt.amountKopeks,
  };
  await saveSyntheticAttempt(page, ambiguous);
  await page.goto("/");
  await openBalance(page);
  const panel = page.getByRole("region", { name: "Пополнение баланса" });
  await panel.getByText("Данные для поддержки", { exact: true }).click();
  await expect(panel).toContainText(ambiguous.requestId);
  await expect(panel).toContainText("Платёж пока не подтверждён");
  await expect(panel).toContainText("Не оплачивайте повторно");
  await expect(
    panel.getByRole("button", {
      name: "Найти платёж",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(panel.getByRole("link")).toHaveCount(0);
  await page.reload();
  await openBalance(page);
  await panel.getByText("Данные для поддержки", { exact: true }).click();
  await expect(panel).toContainText(ambiguous.requestId);
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("citygo.test-topup.101")!),
    ),
  ).toEqual(ambiguous);
  expect(state.creates).toEqual([]);
  expect(state.reads).toBe(0);
  await expect.poll(() => state.attemptReads).toBe(2);
  expect(state.reconciles).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("closing new checkout after creation preserves the existing payment and does not leak it to another account", async ({
  page,
}) => {
  const state = await fixture(page, { live: true });
  await page.goto("/");
  await openBalance(page);
  await page
    .getByLabel("Email для чека")
    .fill("receipt-buyer@synthetic-citygo-mail.ru");
  await page
    .getByRole("region", { name: "Пополнение баланса", exact: true })
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Пополнение баланса" });
  await expect(
    panel.getByRole("link", { name: "Перейти к оплате", exact: true }),
  ).toBeVisible();
  const firstRequest = state.creates[0]!;
  state.available = false;
  await page.reload();
  await openBalance(page);
  await expect(panel).toContainText("Пополнение временно недоступно");
  await panel.getByText("Данные для поддержки", { exact: true }).click();
  await expect(panel).toContainText(firstRequest.requestId);
  await expect.poll(() => state.reads).toBe(1);
  await expect(
    panel.getByRole("button", { name: "Проверить платёж", exact: true }),
  ).toBeEnabled();
  state.userId = "102";
  await page.reload();
  await page
    .getByRole("navigation", { name: "Личный кабинет CityGo", exact: true })
    .getByRole("button", { name: "Профиль", exact: true })
    .click();
  await expect(
    page.getByText("checkout-102@example.test", { exact: true }),
  ).toBeVisible();
  await openBalance(page);
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByText(firstRequest.requestId, { exact: false }),
  ).toHaveCount(0);
  expect(state.creates).toHaveLength(1);
  expect(state.reads).toBe(1);
  expect(state.reconciles).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("new checkout requires an explicit buyer email without using the account email", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/");
  await openBalance(page);
  const email = page.getByLabel("Email для чека");
  const create = page
    .getByRole("region", { name: "Пополнение баланса", exact: true })
    .getByRole("button", {
      name: "Пополнить баланс",
      exact: true,
    });
  await expect(email).toHaveValue("");
  await expect(create).toBeDisabled();
  await email.fill("not-an-email");
  await expect(create).toBeDisabled();
  expect(state.creates).toEqual([]);
  await email.fill("receipt-buyer@synthetic-citygo-mail.ru");
  await create.click();
  await expect.poll(() => state.creates.length).toBe(1);
  expect(state.creates[0]?.receiptEmail).toBe(
    "receipt-buyer@synthetic-citygo-mail.ru",
  );
  expect(state.creates[0]?.receiptEmail).not.toBe("checkout-101@example.test");
  expect(state.unexpected).toEqual([]);
});

test("reloaded ambiguous checkout never replaces the original buyer email or POSTs again", async ({
  page,
}) => {
  const state = await fixture(page, { failFirst: true });
  await page.goto("/");
  await openBalance(page);
  await page
    .getByLabel("Email для чека")
    .fill("original-buyer@synthetic-citygo-mail.ru");
  await page
    .getByRole("region", { name: "Пополнение баланса", exact: true })
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  await expect(page.locator(".ai-access [role=alert]")).toContainText(
    "Не удалось проверить платёж",
  );
  expect(state.creates).toHaveLength(1);
  const original = state.creates[0]!;
  await page.reload();
  await openBalance(page);
  const panel = page.getByRole("region", { name: "Пополнение баланса" });
  await panel.getByText("Данные для поддержки", { exact: true }).click();
  await expect(panel).toContainText(original.requestId);
  await expect(panel).toContainText("Платёж пока не подтверждён");
  await expect.poll(() => state.attemptReads).toBe(1);
  await expect(panel.getByLabel("Email для чека")).toHaveCount(0);
  await expect(
    panel.getByRole("button", {
      name: /Пополнить баланс|Продолжить оплату|Пополнить ещё/,
    }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("citygo.test-topup.101")!),
    ),
  ).toEqual({
    requestId: original.requestId,
    amountKopeks: original.amountKopeks,
  });
  expect(state.creates).toHaveLength(1);
  expect(state.reconciles).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("an ambiguous attempt recovers through an authenticated read-only lookup with checkout closed", async ({
  page,
}) => {
  const state = await fixture(page, {
    available: false,
    recoverAttempt: true,
  });
  await saveSyntheticAttempt(page, {
    requestId: savedAttempt.requestId,
    amountKopeks: savedAttempt.amountKopeks,
  });
  await page.goto("/");
  await openBalance(page);
  const panel = page.getByRole("region", { name: "Пополнение баланса" });
  await expect(panel).toContainText("Пополнение временно недоступно");
  await expect.poll(() => state.attemptReads).toBe(1);
  await panel.getByText("Данные для поддержки", { exact: true }).click();
  await expect(panel).toContainText(order.orderId);
  await expect(panel.getByLabel("Email для чека")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Проверить платёж", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("citygo.test-topup.101")!),
    ),
  ).toEqual(savedAttempt);
  expect(state.creates).toEqual([]);
  expect(state.reconciles).toBe(0);
  expect(page.context().pages()).toHaveLength(1);
  await panel
    .getByRole("button", { name: "Проверить платёж", exact: true })
    .click();
  await expect(panel).toContainText("зачислено на баланс");
  expect(state.reconciles).toBe(1);
  expect(state.creates).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("an explicit create opens a safe loading tab synchronously, then hands the same pending payment to it", async ({
  page,
}) => {
  let release!: () => void;
  const createGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await fixture(page, { createGate });
  try {
    await page.goto("/");
    await openBalance(page);
    await page
      .getByLabel("Email для чека")
      .fill("receipt-buyer@synthetic-citygo-mail.ru");
    const opened = page.waitForEvent("popup");
    await page
      .getByRole("region", { name: "Пополнение баланса", exact: true })
      .getByRole("button", { name: "Пополнить баланс", exact: true })
      .click();
    const popup = await opened;
    await expect(
      popup.getByRole("heading", { name: "Готовим страницу оплаты" }),
    ).toBeVisible();
    expect(popup.url()).toBe("about:blank");
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await expect(popup.locator('meta[name="referrer"]')).toHaveAttribute(
      "content",
      "no-referrer",
    );
    expect(await popup.content()).not.toContain("receipt-buyer");
    expect(await popup.content()).not.toContain("receiptEmail");
    await expect.poll(() => state.creates.length).toBe(1);
    release();
    await expect(popup).toHaveURL(order.confirmationUrl!);
    await expect(
      popup.getByRole("heading", { name: "Вымышленная страница оплаты" }),
    ).toBeVisible();
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await expect(
      page.getByText("Оплата открыта в новой вкладке.", { exact: false }),
    ).toBeVisible();
    expect(state.creates).toHaveLength(1);
    expect(state.reconciles).toBe(0);
    expect(state.unexpected).toEqual([]);
  } finally {
    release();
  }
});

test("a blocked popup presents a prominent safe fallback without another payment create", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const state = await fixture(page);
  await page.goto("/");
  await openBalance(page);
  await page
    .getByLabel("Email для чека")
    .fill("receipt-buyer@synthetic-citygo-mail.ru");
  await page
    .getByRole("region", { name: "Пополнение баланса", exact: true })
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  const link = page.getByRole("link", {
    name: "Открыть тестовую оплату",
    exact: true,
  });
  await expect(link).toBeVisible();
  await expect(link).toHaveClass(/cg-button-primary/);
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    page.getByText("Нажмите «Перейти к оплате», чтобы продолжить.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(page.context().pages()).toHaveLength(1);
  const opened = page.context().waitForEvent("page");
  await link.click();
  const popup = await opened;
  await expect(popup).toHaveURL(order.confirmationUrl!);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(state.creates).toHaveLength(1);
  expect(state.reconciles).toBe(0);
  expect(state.unexpected).toEqual([]);
});

for (const options of [{ failFirst: true }, { unsafeUrl: true }]) {
  test(`a ${options.failFirst ? "failed create" : "malformed confirmation"} closes its blank tab without navigation or automatic retry`, async ({
    page,
  }) => {
    const state = await fixture(page, options);
    await page.goto("/");
    await openBalance(page);
    await page
      .getByLabel("Email для чека")
      .fill("receipt-buyer@synthetic-citygo-mail.ru");
    const opened = page.waitForEvent("popup");
    await page
      .getByRole("region", { name: "Пополнение баланса", exact: true })
      .getByRole("button", { name: "Пополнить баланс", exact: true })
      .click();
    const popup = await opened;
    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect(page.locator(".ai-access [role=alert]")).toContainText(
      "Не удалось проверить платёж",
    );
    expect(state.creates).toHaveLength(1);
    expect(state.reconciles).toBe(0);
    expect(state.unexpected).toEqual([]);
  });
}

for (const responseStatus of ["creating", "succeeded"] as const) {
  test(`a ${responseStatus} response closes the allocated tab instead of opening a checkout page`, async ({
    page,
  }) => {
    const state = await fixture(page, { responseStatus });
    await page.goto("/");
    await openBalance(page);
    await page
      .getByLabel("Email для чека")
      .fill("receipt-buyer@synthetic-citygo-mail.ru");
    const opened = page.waitForEvent("popup");
    await page
      .getByRole("region", { name: "Пополнение баланса", exact: true })
      .getByRole("button", { name: "Пополнить баланс", exact: true })
      .click();
    const popup = await opened;
    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect(
      page.getByText("Проверьте статус платежа.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: "Открыть тестовую оплату",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(state.creates).toHaveLength(1);
    expect(state.reconciles).toBe(0);
    expect(state.unexpected).toEqual([]);
  });
}

test("closing the loading tab uses fallback when the same request finishes, without reopening", async ({
  page,
}) => {
  let release!: () => void;
  const createGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await fixture(page, { createGate });
  try {
    await page.goto("/");
    await openBalance(page);
    await page
      .getByLabel("Email для чека")
      .fill("receipt-buyer@synthetic-citygo-mail.ru");
    const opened = page.waitForEvent("popup");
    await page
      .getByRole("region", { name: "Пополнение баланса", exact: true })
      .getByRole("button", { name: "Пополнить баланс", exact: true })
      .click();
    const popup = await opened;
    await popup.close();
    release();
    await expect(
      page.getByRole("link", {
        name: "Открыть тестовую оплату",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Нажмите «Перейти к оплате», чтобы продолжить.", {
        exact: false,
      }),
    ).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);
    expect(state.creates).toHaveLength(1);
    expect(state.reconciles).toBe(0);
    expect(state.unexpected).toEqual([]);
  } finally {
    release();
  }
});

for (const destination of ["same-origin", "cross-origin"] as const) {
  test(`a user-navigated ${destination} loading tab is left untouched when payment creation finishes`, async ({
    page,
  }) => {
    let release!: () => void;
    const createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = await fixture(page, { createGate });
    await page.context().route("**/synthetic-payment-detour", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><title>Unrelated synthetic page</title><h1>User navigation</h1>",
      }),
    );
    try {
      await page.goto("/");
      await openBalance(page);
      await page
        .getByLabel("Email для чека")
        .fill("receipt-buyer@synthetic-citygo-mail.ru");
      const opened = page.waitForEvent("popup");
      await page
        .getByRole("region", { name: "Пополнение баланса", exact: true })
        .getByRole("button", { name: "Пополнить баланс", exact: true })
        .click();
      const popup = await opened;
      const detour =
        destination === "same-origin"
          ? new URL("/synthetic-payment-detour", page.url()).href
          : "https://checkout.example.test/synthetic-payment-detour";
      await popup.goto(detour);
      await expect(
        popup.getByRole("heading", { name: "User navigation" }),
      ).toBeVisible();
      release();
      await expect(
        page.getByRole("link", {
          name: "Открыть тестовую оплату",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText("Нажмите «Перейти к оплате», чтобы продолжить.", {
          exact: false,
        }),
      ).toBeVisible();
      expect(popup.isClosed()).toBe(false);
      await expect(popup).toHaveURL(detour);
      await expect(
        popup.getByRole("heading", { name: "User navigation" }),
      ).toBeVisible();
      expect(page.context().pages()).toHaveLength(2);
      expect(state.creates).toHaveLength(1);
      expect(state.reconciles).toBe(0);
      expect(state.unexpected).toEqual([]);
    } finally {
      release();
    }
  });
}
