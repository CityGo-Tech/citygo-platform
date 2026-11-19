import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";

const starsPath = "/api/v1/mini-apps/telegram/stars";
const webhookPath = "http://127.0.0.1:4000/v1/telegram/stars-test/webhook";
const webhookSecret = "citygo-public-stars-webhook-fixture-v1";
const starsLabel = "Тестовая оплата Stars";
const hosts = {
  telegram: {
    fragment: "tgWebAppData",
    script: "https://telegram.org/js/telegram-web-app.js?65",
    scriptBinding: "window.Telegram = { WebApp: sdk };",
  },
  max: {
    fragment: "WebAppData",
    script: "https://st.max.ru/js/max-web-app.js",
    scriptBinding: "window.WebApp = sdk;",
  },
};

type StarsOrder = {
  id: string;
  status: "pending" | "checkout" | "paid" | "cancelled" | "refunded";
};
type StarsWallet = {
  currency: "XTR";
  testPrice: number;
  balance: number;
  orders: StarsOrder[];
};

// Payment state is the real in-memory API. Only the platform bridge and
// Telegram updates are synthetic, so no Bot API or payment can leave the test.
async function selectActor(
  context: BrowserContext,
  name: string,
  kind: "telegram" | "web",
) {
  await context.addCookies([
    {
      name: "citygo",
      value: createHash("sha256")
        .update("citygo-telegram-stars-test-v1:" + name + ":" + kind)
        .digest("hex"),
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.route("https://**", (route) => route.abort());
}

async function openProfile(
  page: Page,
  email: string,
  host?: keyof typeof hosts,
) {
  const profileTab = page
    .getByRole("navigation", { name: "Личный кабинет CityGo" })
    .getByRole("button", { name: "Профиль", exact: true });
  if (host) {
    const { fragment, script, scriptBinding } = hosts[host];
    await page.route(script, (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `
          window.starsFixture = {};
          const sdk = {
            initData: "test-launch",
            openLink() { throw new Error("Unexpected external navigation"); },
            openInvoice(url, callback) { window.starsFixture = { url, callback }; },
          };
          ${scriptBinding}
        `,
      }),
    );
    await page.goto("/mini/" + host + "#" + fragment + "=test-launch");
    await page
      .getByRole("button", { name: "Войти в CityGo", exact: true })
      .click();
    const skip = page.getByRole("button", { name: "Не сейчас", exact: true });
    await expect(skip.or(profileTab).first()).toBeVisible();
    if (await skip.isVisible()) await skip.click();
  } else {
    await page.goto("/");
  }
  await profileTab.click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
}

function starsButton(page: Page) {
  return page.getByRole("button", { name: starsLabel, exact: true });
}

async function openStars(page: Page) {
  await starsButton(page).click();
  const panel = page.getByRole("region", { name: starsLabel, exact: true });
  await expect(panel.getByRole("heading", { name: starsLabel })).toBeVisible();
  return panel;
}

type InvoiceFixture = { url?: string; callback?: (status: string) => void };

async function startInvoice(page: Page) {
  const previous = await page.evaluate(
    () =>
      (window as Window & { starsFixture: InvoiceFixture }).starsFixture.url,
  );
  await page
    .getByRole("button", { name: "Оплатить 1 Star", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { starsFixture: InvoiceFixture }).starsFixture
            .url,
      ),
    )
    .not.toBe(previous);
  const url = await page.evaluate(
    () =>
      (window as Window & { starsFixture: InvoiceFixture }).starsFixture.url,
  );
  expect(url).toMatch(/^https:\/\/t\.me\/\$citygo-test-[0-9a-f-]{36}$/);
  return url!.split("$citygo-test-")[1]!;
}

async function finishInvoice(page: Page, status: "paid" | "cancelled") {
  await page.evaluate((value) => {
    const { callback } = (window as Window & { starsFixture: InvoiceFixture })
      .starsFixture;
    if (!callback) throw new Error("Invoice callback is missing");
    callback(value);
  }, status);
}

async function readStars(request: APIRequestContext): Promise<StarsWallet> {
  const response = await request.get(starsPath);
  expect(response.status()).toBe(200);
  return response.json();
}

async function readRub(request: APIRequestContext) {
  const responses = await Promise.all([
    request.get("/api/v1/ai/credit"),
    request.get("/api/v1/ai/credit/history"),
  ]);
  for (const response of responses) expect(response.status()).toBe(200);
  return Promise.all(responses.map((response) => response.json()));
}

test("Telegram Stars confirms and refunds through authenticated bot updates independently of the app", async ({
  browser,
  context,
  page,
  request,
}, info) => {
  test.setTimeout(60_000);
  const desktop = info.project.name === "desktop";
  const name = info.project.name + "-" + info.retry;
  const testClient = (slot: number) =>
    `198.19.62.${1 + (desktop ? 0 : 24) + info.retry * 6 + slot}`;
  const telegramUser = {
    id: 1_430_000 + (desktop ? 0 : 2) + info.retry,
    first_name: "Synthetic",
    is_bot: false,
  };
  const email = "telegram-stars-" + name + "@example.test";
  const chat = { id: telegramUser.id, type: "private" };
  const updateId = (sequence: number) => telegramUser.id * 100 + sequence;
  const message = (sequence: number, content: Record<string, unknown>) => ({
    update_id: updateId(sequence),
    message: {
      message_id: sequence,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: telegramUser,
      ...content,
    },
  });
  const sendUpdate = async (data: object) => {
    const response = await request.post(webhookPath, {
      headers: {
        "x-telegram-bot-api-secret-token": webhookSecret,
        "X-Forwarded-For": testClient(2),
      },
      data,
    });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const paymentFor = (orderId: string) => ({
    currency: "XTR",
    total_amount: 1,
    invoice_payload: orderId,
    telegram_payment_charge_id: "synthetic-charge-" + orderId,
    provider_payment_charge_id: "",
  });
  const approveCheckout = async (orderId: string, sequence: number) => {
    const query = {
      id: "synthetic-checkout-" + orderId,
      from: telegramUser,
      currency: "XTR",
      total_amount: 1,
      invoice_payload: orderId,
    };
    expect(
      await sendUpdate({
        update_id: updateId(sequence),
        pre_checkout_query: query,
      }),
    ).toMatchObject({
      method: "answerPreCheckoutQuery",
      pre_checkout_query_id: query.id,
      ok: true,
    });
  };
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": testClient(0) });
  await selectActor(context, name, "telegram");
  const web = await browser.newContext({ baseURL: info.project.use.baseURL });
  try {
    await web.setExtraHTTPHeaders({ "X-Forwarded-For": testClient(1) });
    await selectActor(web, name, "web");
    expect((await web.request.get(starsPath)).status()).toBe(403);
    const rubBefore = await readRub(web.request);
    const browserPage = await web.newPage();
    await openProfile(browserPage, email);
    await expect(starsButton(browserPage)).toHaveCount(0);
    await openProfile(browserPage, email, "max");
    await expect(starsButton(browserPage)).toHaveCount(0);

    await openProfile(page, email, "telegram");
    const panel = await openStars(page);
    expect(await readStars(context.request)).toMatchObject({
      currency: "XTR",
      testPrice: 1,
      balance: 0,
      orders: [],
    });
    const orderId = await startInvoice(page);
    await finishInvoice(page, "paid");
    await panel.getByRole("button", { name: "Обновить статус" }).click();
    await expect(
      panel.getByText("Ожидает оплаты", { exact: true }),
    ).toBeVisible();
    expect(await readStars(context.request)).toMatchObject({
      balance: 0,
      orders: [{ id: orderId, status: "pending" }],
    });

    // Close the document before the provider confirms payment.
    await page.goto("about:blank");
    await approveCheckout(orderId, 1);
    expect(await readStars(context.request)).toMatchObject({
      balance: 0,
      orders: [{ id: orderId, status: "checkout" }],
    });
    const payment = paymentFor(orderId);
    const success = message(2, { successful_payment: payment });
    for (const event of [
      success,
      success,
      message(3, { successful_payment: payment }),
    ]) {
      expect(await sendUpdate(event)).toMatchObject({ ok: true });
    }
    expect(await readStars(context.request)).toMatchObject({
      balance: 1,
      orders: [{ id: orderId, status: "paid" }],
    });
    expect(await readRub(web.request)).toEqual(rubBefore);

    await openProfile(page, email, "telegram");
    await openStars(page);
    await expect(panel.getByText("Оплачен", { exact: true })).toBeVisible();
    const refundPath = starsPath + "/orders/" + orderId + "/refund";
    const savedRefund = page.waitForRequest(
      (incoming) =>
        new URL(incoming.url()).pathname === refundPath &&
        incoming.method() === "POST",
    );
    await page.route(
      "**" + refundPath,
      async (route) => {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        return route.abort();
      },
      { times: 1 },
    );
    await panel
      .getByRole("button", { name: "Запросить тестовый возврат" })
      .click();
    await savedRefund;
    await expect
      .poll(async () => (await readStars(context.request)).orders[0]?.status)
      .toBe("refunded");
    await page.goto("about:blank");
    const refund = message(4, { refunded_payment: payment });
    for (const event of [
      refund,
      refund,
      message(5, { refunded_payment: payment }),
      success,
    ]) {
      expect(await sendUpdate(event)).toMatchObject({ ok: true });
    }
    expect(await readStars(context.request)).toMatchObject({
      balance: 0,
      orders: [{ id: orderId, status: "refunded" }],
    });

    await openProfile(page, email, "telegram");
    await openStars(page);
    await expect(panel.getByText("Возвращён", { exact: true })).toBeVisible();

    // A provider-initiated refund can change a paid order with the app closed.
    const providerRefundId = await startInvoice(page);
    await approveCheckout(providerRefundId, 6);
    const secondPayment = paymentFor(providerRefundId);
    expect(
      await sendUpdate(message(7, { successful_payment: secondPayment })),
    ).toMatchObject({ ok: true });
    expect(await readStars(context.request)).toMatchObject({
      balance: 1,
      orders: [
        { id: providerRefundId, status: "paid" },
        { id: orderId, status: "refunded" },
      ],
    });
    await page.goto("about:blank");
    expect(
      await sendUpdate(message(8, { refunded_payment: secondPayment })),
    ).toMatchObject({ ok: true });
    expect(await readStars(context.request)).toMatchObject({
      balance: 0,
      orders: [
        { id: providerRefundId, status: "refunded" },
        { id: orderId, status: "refunded" },
      ],
    });
    await openProfile(page, email, "telegram");
    await openStars(page);
    await expect(panel.getByText("Возвращён", { exact: true })).toHaveCount(2);
    await expect(
      panel.getByText("Тестовые единицы: 0", { exact: true }),
    ).toBeVisible();

    const cancelledId = await startInvoice(page);
    expect(cancelledId).not.toBe(orderId);
    await finishInvoice(page, "cancelled");
    await expect(panel.getByText("Отменён", { exact: true })).toBeVisible();
    expect(await readStars(context.request)).toMatchObject({
      balance: 0,
      orders: expect.arrayContaining([
        expect.objectContaining({ id: cancelledId, status: "cancelled" }),
        expect.objectContaining({ id: orderId, status: "refunded" }),
        expect.objectContaining({ id: providerRefundId, status: "refunded" }),
      ]),
    });
    expect(await sendUpdate(message(9, { text: "/paysupport" }))).toMatchObject(
      {
        method: "sendMessage",
        chat_id: telegramUser.id,
        text: expect.stringMatching(/помощь человека/i),
      },
    );
    expect(await readRub(web.request)).toEqual(rubBefore);
  } finally {
    await web.close();
  }
});
