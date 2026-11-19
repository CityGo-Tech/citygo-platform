import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import type {
  AiCredit,
  BalanceHistoryPage,
  TopupOrder,
} from "@citygo/contracts";

const topupsPath = "/api/v1/mini-apps/max/payments/topups";
const refundsPath = "/api/v1/admin/payments/refunds";
const testPaymentLabel = "Тестовое пополнение";
const maxSdk = "https://st.max.ru/js/max-web-app.js";
const amountKopeks = 10_000;
const amountMicros = 100_000_000;
const receiptEmail = "buyer@synthetic-citygo-mail.ru";

async function installMaxSdk(context: BrowserContext) {
  await context.route("https://**", (route) => route.abort());
  await context.route(maxSdk, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        window.fixtureCheckoutUrls = [];
        window.WebApp = {
          initData: "synthetic-max-launch",
          openLink(url) { window.fixtureCheckoutUrls.push(url); },
        };
      `,
    }),
  );
}

function openedLinks(page: Page) {
  return page.evaluate(
    () =>
      (window as Window & { fixtureCheckoutUrls: string[] })
        .fixtureCheckoutUrls,
  );
}

async function openTestPayment(page: Page, email: string) {
  await page.goto("/mini/max#WebAppData=synthetic-max-launch");
  await page
    .getByRole("button", { name: "Войти в CityGo", exact: true })
    .click();
  const profileTab = page
    .getByRole("navigation", { name: "Личный кабинет CityGo" })
    .getByRole("button", { name: "Профиль", exact: true });
  const skip = page.getByRole("button", { name: "Не сейчас", exact: true });
  await expect(skip.or(profileTab).first()).toBeVisible();
  if (await skip.isVisible()) await skip.click();
  await profileTab.click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Баланс и история операций", exact: true })
    .click();
  await page
    .getByRole("button", { name: testPaymentLabel, exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: testPaymentLabel,
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: testPaymentLabel }),
  ).toBeVisible();
  return panel;
}

async function createPayment(page: Page): Promise<TopupOrder> {
  const panel = page.getByRole("region", {
    name: testPaymentLabel,
    exact: true,
  });
  await panel.getByLabel("Сумма пополнения").fill(String(amountKopeks / 100));
  await panel.getByLabel("Email для чека").fill(receiptEmail);
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === topupsPath &&
      response.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Создать тестовый платёж" }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  return response.json();
}

async function getOrder(
  actor: APIRequestContext,
  orderId: string,
): Promise<TopupOrder> {
  const response = await actor.get(topupsPath + "/" + orderId);
  expect(response.status()).toBe(200);
  return response.json();
}

async function getCredit(actor: APIRequestContext): Promise<AiCredit> {
  const response = await actor.get("/api/v1/ai/credit");
  expect(response.status()).toBe(200);
  return response.json();
}

async function getHistory(
  actor: APIRequestContext,
): Promise<BalanceHistoryPage> {
  const response = await actor.get("/api/v1/ai/credit/history");
  expect(response.status()).toBe(200);
  return response.json();
}

const notificationPath = "/v1/mini-apps/max/payments/test-notifications";
const localApi = "http://127.0.0.1:4000";
const controlHeaders = {
  Authorization: "Bearer citygo-max-payment-control-fixture-v1",
};

type Actor = "owner" | "visitor" | "admin" | "web";

async function useActor(context: BrowserContext, name: string, actor: Actor) {
  await context.addCookies([
    {
      name: "citygo",
      value: createHash("sha256")
        .update(`citygo-max-payment-test-v1:${name}:${actor}`)
        .digest("hex"),
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

function providerPaymentId(order: TopupOrder) {
  expect(order).toMatchObject({
    test: true,
    currency: "RUB",
    status: "pending",
    credited: false,
    amountKopeks,
  });
  expect(order.confirmationUrl).toBeDefined();
  const url = new URL(order.confirmationUrl!);
  expect(url.origin + url.pathname).toBe(
    "https://yoomoney.ru/checkout/payments/v2/contract",
  );
  const id = url.searchParams.get("orderId");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id!;
}

test("MAX test payment and late receipt reconcile independently of the Mini App and refund only once", async ({
  browser,
  context,
  page,
  request,
}, info) => {
  test.setTimeout(60_000);
  const origin = info.project.use.baseURL!;
  const name = info.project.name + "-" + info.retry;
  const email = "max-payments-" + name + "@example.test";
  const subnet = (info.project.name === "desktop" ? 70 : 71) + info.retry * 2;
  const ip = (slot: number) => `198.19.${subnet}.${slot}`;
  await useActor(context, name, "owner");
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": ip(1) });
  await installMaxSdk(context);

  const extraContexts = await Promise.all([
    browser.newContext({
      baseURL: origin,
      extraHTTPHeaders: { "X-Forwarded-For": ip(2) },
    }),
    browser.newContext({
      baseURL: origin,
      extraHTTPHeaders: { "X-Forwarded-For": ip(3) },
    }),
    browser.newContext({
      baseURL: origin,
      extraHTTPHeaders: { "X-Forwarded-For": ip(4) },
    }),
  ] as const);
  const [admin, visitor, web] = extraContexts;
  try {
    await Promise.all([
      useActor(admin, name, "admin"),
      useActor(visitor, name, "visitor"),
      useActor(web, name, "web"),
    ]);
    const adminPost = async (path: string, data: object) => {
      const response = await admin.request.post(path, {
        headers: { origin, "X-Forwarded-For": ip(2) },
        data,
      });
      expect(response.status()).toBe(200);
      return response.json();
    };
    const setProviderState = async (
      kind: "payment" | "refund",
      data: object,
    ) => {
      const response = await request.post(
        localApi + "/v1/test/max-yookassa/" + kind,
        {
          headers: { ...controlHeaders, "X-Forwarded-For": ip(5) },
          data,
        },
      );
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    };
    const notify = async (
      event: "payment.succeeded" | "refund.succeeded",
      id: string,
    ) => {
      const response = await request.post(localApi + notificationPath, {
        headers: { "X-Forwarded-For": ip(6) },
        data: { type: "notification", event, object: { id } },
      });
      expect(response.status()).toBe(200);
    };

    const panel = await openTestPayment(page, email);
    const orders = panel.getByRole("list", { name: "Тестовые платежи" });
    const orderWithStatus = (status: string) =>
      orders.getByRole("listitem").filter({ hasText: status });
    const paidOrder = orderWithStatus("Оплата подтверждена.");
    const balanceBefore = await getCredit(context.request);
    const historyBefore = await getHistory(context.request);
    expect(historyBefore.entries).toEqual([]);
    expect((await web.request.get(topupsPath)).status()).toBe(403);

    const cancellation = await createPayment(page);
    const canceledPaymentId = providerPaymentId(cancellation);
    const openCheckout = panel.getByRole("button", {
      name: "Перейти к оплате",
    });
    await expect(openCheckout).toBeVisible();
    expect(await openedLinks(page)).toEqual([]);
    await openCheckout.click();
    expect(await openedLinks(page)).toEqual([cancellation.confirmationUrl]);
    // Returning from the native link does not provide payment evidence.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await panel.getByRole("button", { name: "Проверить платёж" }).click();
    await expect(orderWithStatus("Ожидаем оплату.")).toBeVisible();
    expect(await getOrder(context.request, cancellation.orderId)).toMatchObject(
      {
        status: "pending",
        credited: false,
      },
    );
    expect((await getCredit(context.request)).availableMicros).toBe(
      balanceBefore.availableMicros,
    );

    await setProviderState("payment", {
      paymentId: canceledPaymentId,
      status: "canceled",
    });
    await panel.getByRole("button", { name: "Проверить платёж" }).click();
    await expect(orderWithStatus("Платёж отменён.")).toBeVisible();
    expect(await getOrder(context.request, cancellation.orderId)).toMatchObject(
      {
        status: "canceled",
        credited: false,
      },
    );
    expect((await getHistory(context.request)).entries).toEqual([]);

    const order = await createPayment(page);
    const paymentId = providerPaymentId(order);
    expect(order.orderId).not.toBe(cancellation.orderId);
    expect(await openedLinks(page)).toEqual([cancellation.confirmationUrl]);
    await openCheckout.click();
    expect(await openedLinks(page)).toEqual([
      cancellation.confirmationUrl,
      order.confirmationUrl,
    ]);
    expect(
      (await context.request.get(topupsPath + "/" + randomUUID())).status(),
    ).toBe(404);
    expect(
      (await visitor.request.get(topupsPath + "/" + order.orderId)).status(),
    ).toBe(404);
    expect(
      (
        await visitor.request.post(
          topupsPath + "/" + order.orderId + "/reconcile",
          {
            headers: { origin, "X-Forwarded-For": ip(3) },
            data: {},
          },
        )
      ).status(),
    ).toBe(404);
    await page.goto("about:blank");

    // The inbox and reconciliation use the stored order and simulated
    // provider GET while there is no running client page.
    await setProviderState("payment", {
      paymentId,
      status: "succeeded",
      receiptRegistration: "pending",
    });
    await notify("payment.succeeded", paymentId);
    await notify("payment.succeeded", paymentId);
    expect((await getOrder(context.request, order.orderId)).credited).toBe(
      false,
    );
    await adminPost("/api" + notificationPath + "/process", {});
    expect(await getOrder(context.request, order.orderId)).toMatchObject({
      status: "succeeded",
      credited: true,
    });
    expect((await getCredit(context.request)).availableMicros).toBe(
      balanceBefore.availableMicros + amountMicros,
    );

    await openTestPayment(page, email);
    await expect(paidOrder).toBeVisible();
    // Reopening reads the separate provider receipt; settlement already happened.
    const checkPayment = paidOrder.getByRole("button", {
      name: "Проверить платёж",
    });
    await expect(
      paidOrder.getByText("Регистрация чека ожидается", { exact: true }),
    ).toBeVisible();
    await setProviderState("payment", {
      paymentId,
      receiptRegistration: "succeeded",
    });
    await checkPayment.click();
    await expect(
      paidOrder.getByText("Чек зарегистрирован в тестовом контуре", {
        exact: true,
      }),
    ).toBeVisible();
    expect((await getCredit(context.request)).availableMicros).toBe(
      balanceBefore.availableMicros + amountMicros,
    );
    const npd = await context.request.get("/api/v1/payments/receipts");
    expect(npd.status()).toBe(200);
    expect(await npd.json()).toEqual({ tasks: [] });
    const source = await context.request.get("/api/v1/payments/sources");
    expect(source.status()).toBe(200);
    expect(await source.json()).toMatchObject({
      sources: [{ sourceOperationId: order.orderId, test: true }],
    });

    await page.goto("about:blank");
    const refundCommand = {
      requestId: randomUUID(),
      paymentOperationId: order.orderId,
      amountKopeks,
    };
    const { refund } = await adminPost(refundsPath, refundCommand);
    expect(refund).toMatchObject({ status: "reserved" });
    const refundPath = refundsPath + "/" + refund.id;
    expect(await adminPost(refundsPath, refundCommand)).toMatchObject({
      refund: { id: refund.id },
    });
    const submitted = await adminPost(refundPath + "/submit", {});
    expect(submitted).toMatchObject({
      refund: { status: "pending", providerRefundId: expect.any(String) },
    });
    const providerRefundId = submitted.refund.providerRefundId as string;
    await setProviderState("refund", {
      refundId: providerRefundId,
      status: "succeeded",
    });
    await notify("refund.succeeded", providerRefundId);
    await notify("refund.succeeded", providerRefundId);
    await adminPost("/api" + notificationPath + "/process", {});
    expect(await adminPost(refundPath + "/reconcile", {})).toMatchObject({
      refund: { id: refund.id, status: "succeeded" },
    });
    const balanceAfter = await getCredit(context.request);
    expect(balanceAfter.availableMicros).toBe(balanceBefore.availableMicros);
    expect(balanceAfter.heldMicros).toBe(balanceBefore.heldMicros);
    const entries = (await getHistory(context.request)).entries;
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "topup",
          direction: "credit",
          amountMicros,
        }),
        expect.objectContaining({
          kind: "refund",
          direction: "debit",
          amountMicros,
        }),
      ]),
    );

    await openTestPayment(page, email);
    await expect(paidOrder).toBeVisible();
    await expect(
      paidOrder.getByText("Чек зарегистрирован в тестовом контуре", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      panel
        .getByRole("region", { name: "Тестовые возвраты" })
        .getByRole("listitem")
        .filter({ hasText: "Возврат подтверждён" }),
    ).toBeVisible();
  } finally {
    await Promise.all(extraContexts.map((actor) => actor.close()));
  }
});
