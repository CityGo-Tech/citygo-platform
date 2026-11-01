import { openLegacyMap } from "./navigation-helper";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
import { expect, test, type Page } from "@playwright/test";
import type { Dashboard, Message } from "@citygo/contracts";

const explanation =
  "Недостаточно доступного баланса CityGo для резерва ответа. Пополните баланс. Запрос не отправлен ИИ.";
const legacy: Message = {
  id: "synthetic-old-interruption",
  role: "assistant",
  agentKey: "support",
  status: "interrupted",
  content: "Старая частичная рекомендация без сохранённой причины.",
};
function fixtureBoard(withProfile = false): Dashboard {
  return {
    user: {
      id: "101",
      email: "synthetic-chat@example.test",
      role: "user",
      mustChangePassword: false,
    },
    profile: withProfile
      ? {
          originCity: "Казань",
          targetCity: "Москва",
          monthlyBudget: 50000,
          moveTargetDate: "2099-01-01",
          household: "solo",
          aiConsent: true,
        }
      : null,
    quests: withProfile
      ? [
          {
            id: "1",
            slug: "housing-brief",
            title: "Критерии жилья",
            state: "in_progress",
            xpReward: 60,
          },
        ]
      : [],
    xp: 0,
    provider: "routerai",
    thread: { id: "1", agentKey: "support", messages: [legacy] },
    aiAccess: {
      granted: true,
      dailyLimit: 20,
      policy: {
        id: "a".repeat(64),
        version: "synthetic",
        provider: "routerai",
        model: "synthetic-only",
        recipient: "Синтетический получатель",
        routing: "Без внешних запросов",
        data: "Только вымышленные данные",
      },
      credit: {
        currency: "RUB",
        bonusGranted: false,
        grantedMicros: 0,
        availableMicros: 0,
        spentMicros: 0,
        heldMicros: 0,
        chargingStatus: "routerai_citygo_10x",
        topUpAvailable: true,
        history: [],
      },
    },
  };
}
async function install(
  page: Page,
  options: { profile?: boolean; human?: boolean } = {},
) {
  const board = fixtureBoard(options.profile);
  const calls = {
    messages: 0,
    payments: 0,
    external: 0,
    unexpected: [] as string[],
  };
  // No payment page or external provider can be reached by this synthetic test.
  await page.context().route("https://**", (route) => {
    calls.external++;
    return route.abort();
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
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/dashboard" && request.method() === "GET")
      return route.fulfill({ json: board });
    if (path === "/api/v1/threads/1/messages" && request.method() === "POST") {
      calls.messages++;
      const body = request.postDataJSON();
      expect(body.policyId).toBe(board.aiAccess.policy!.id);
      board.thread!.messages.push({
        id: "synthetic-question",
        role: "user",
        agentKey: "support",
        status: "complete",
        content: body.text,
      });
      const content = options.human
        ? "Запрос на помощь человека сохранён. Внешнему специалисту он не отправлялся."
        : explanation;
      board.thread!.messages.push({
        id: "synthetic-result",
        role: "assistant",
        agentKey: "support",
        status: options.human ? "complete" : "interrupted",
        content,
        ...(options.human
          ? {}
          : { failureCode: "AI_CREDIT_EXHAUSTED" as const }),
      });
      const events = options.human
        ? [
            { type: "delta", text: content },
            { type: "done", messageId: "synthetic-result" },
          ]
        : [
            {
              type: "error",
              code: "AI_CREDIT_EXHAUSTED",
              message: explanation,
              requestId: "synthetic-server-request",
              retryable: false,
            },
          ];
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: { "X-CityGo-Contract-Version": "1" },
        body: events
          .map((event) => "data: " + JSON.stringify(event) + "\n\n")
          .join(""),
      });
    }
    if (path.startsWith("/api/v1/payments/") && request.method() === "POST")
      calls.payments++;
    calls.unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  return { board, calls };
}

test("profile-free zero credit shows an explicit topup link and preserves a confirmed no-dispatch explanation after reload without replay or payment", async ({
  page,
}) => {
  const { calls } = await install(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  await expect(page.locator("form .chat-credit-hint")).toContainText(
    "Недостаточно средств для нового ответа.",
  );
  await expect(page.getByLabel("Бюджет аренды в месяц, ₽")).toHaveCount(0);
  const link = page.getByRole("link", {
    name: "Баланс и пополнение",
    exact: true,
  });
  await expect(link).toHaveAttribute("href", "#citygo-balance");
  await link.click();
  await expect(page.locator("#citygo-balance")).toBeFocused();
  await expect(page.locator("#citygo-balance")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  expect(calls.messages).toBe(0);
  await page
    .getByRole("button", { name: "Вернуться в приложение", exact: true })
    .click();
  const question = "Помоги понять, с чего начать переезд";
  await page.getByLabel("Сообщение помощнику").fill(question);
  const send = page.getByRole("button", { name: "Отправить", exact: true });
  // A zero balance is not a global block: service/human-handoff requests remain possible.
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.locator(".alert[role=alert]")).toContainText(
    "Недостаточно доступного баланса",
  );
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(question);
  const log = page.getByRole("log", { name: "История диалога" });
  await expect(
    log.getByText("Запрос не отправлен ИИ", { exact: true }),
  ).toHaveCount(1);
  await expect(log.getByText("Ответ прерван", { exact: true })).toHaveCount(1);
  await expect(log).toContainText(explanation);
  await page.reload();
  await expect(
    log.getByText("Запрос не отправлен ИИ", { exact: true }),
  ).toHaveCount(1);
  await expect(log.getByText("Ответ прерван", { exact: true })).toHaveCount(1);
  await expect(log).toContainText(explanation);
  await page
    .getByRole("link", { name: "Баланс и пополнение", exact: true })
    .click();
  await expect(page.locator("#citygo-balance")).toBeFocused();
  expect(calls.messages).toBe(1);
  expect(calls.payments).toBe(0);
  expect(calls.external).toBe(0);
  expect(calls.unexpected).toEqual([]);
  expect(page.context().pages()).toHaveLength(1);
});

test("zero credit guidance does not disable an explicit free service handoff", async ({
  page,
}) => {
  const { calls } = await install(page, { human: true });
  await page.goto("/");
  await page.getByLabel("Сообщение помощнику").fill("Нужна помощь человека");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.getByRole("log")).toContainText(
    "Запрос на помощь человека сохранён",
  );
  await expect(
    page.getByRole("log").getByText("Запрос не отправлен ИИ", { exact: true }),
  ).toHaveCount(0);
  expect(calls.messages).toBe(1);
  expect(calls.payments).toBe(0);
  expect(calls.external).toBe(0);
  expect(calls.unexpected).toEqual([]);
});

test("fixed-reserve negative balance stays visible after reload without automatic topup or replay", async ({
  page,
}) => {
  const { board, calls } = await install(page, { human: true });
  board.aiAccess.credit = {
    ...board.aiAccess.credit!,
    reservationMode: "fixed5_overdraft",
    minimumRequestBalanceMicros: 5_000_000,
    outstandingDebtMicros: 3_000_000,
    grantedMicros: 5_000_000,
    spentMicros: 8_000_000,
    availableMicros: -3_000_000,
  };
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  const balance = page.locator("#citygo-balance");
  await expect(page.locator("form .chat-credit-hint")).toBeVisible();
  await page
    .getByRole("link", { name: "Баланс и пополнение", exact: true })
    .click();
  await expect(balance).toBeFocused();
  await expect(balance).toBeVisible();
  await expect(balance).toContainText("-3");
  await expect(balance).toContainText("Задолженность: 3 ₽ CityGo");
  expect(await balance.innerText()).not.toMatch(/резерв|×10|стоимость модели/i);
  await page.reload();
  await page
    .getByRole("link", { name: "Баланс и пополнение", exact: true })
    .click();
  await expect(balance).toBeVisible();
  await expect(balance).toContainText("-3");
  await page
    .getByRole("button", { name: "Вернуться в приложение", exact: true })
    .click();
  await page.getByLabel("Сообщение помощнику").fill("Нужна помощь человека");
  await expect(
    page.getByRole("button", { name: "Отправить", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.getByRole("log")).toContainText(
    "Запрос на помощь человека сохранён",
  );
  expect(calls.messages).toBe(1);
  expect(calls.payments).toBe(0);
  expect(calls.external).toBe(0);
  expect(calls.unexpected).toEqual([]);
});

test("legacy journey keeps unknown interruptions generic and focuses balance without leaving the chat route", async ({
  page,
}) => {
  const { board, calls } = await install(page, { profile: true });
  board.thread!.messages.push({
    ...legacy,
    id: "synthetic-confirmed-rejection",
    content: explanation,
    failureCode: "AI_CREDIT_EXHAUSTED",
  });
  await page.goto("/#chat");
  await openLegacyMap(page);
  await expect(
    page.getByRole("log").getByText("Ответ не завершён", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("log").getByText("Запрос не отправлен ИИ", { exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("link", { name: "Баланс и пополнение", exact: true })
    .click();
  await expect(page.locator("#citygo-balance")).toBeFocused();
  await expect(page.locator("#citygo-balance")).toBeVisible();
  await expect(page).toHaveURL(/#chat$/);
  await page
    .getByRole("button", { name: "Вернуться в приложение", exact: true })
    .click();
  await expect(page).toHaveURL(/#chat$/);
  await expect(page.locator(".journey-chat")).toBeVisible();
  expect(calls.messages).toBe(0);
  expect(calls.payments).toBe(0);
  expect(calls.external).toBe(0);
  expect(calls.unexpected).toEqual([]);
});
