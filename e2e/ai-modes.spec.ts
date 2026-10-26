import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Dashboard, Message } from "@citygo/contracts";
import { syntheticConsentPolicy } from "./service-consent-fixture";

type ModeId = "maximum" | "balanced" | "minimum";
type Send = {
  text: string;
  requestId: string;
  policyId?: string;
  creditReservationMode?: string;
  aiMode?: ModeId;
  aiModeCatalogId?: string;
};
const catalogId = "b".repeat(64);
const policyId = "a".repeat(64);
const selector = (page: Page) =>
  page.getByLabel("Режим ответа", { exact: true });
const composer = (page: Page) =>
  page.getByLabel("Сообщение помощнику", { exact: true });

/** Only synthetic HTTP/SSE responses; every provider destination is blocked. */
async function fixture(
  context: BrowserContext,
  options: {
    legacy?: boolean;
    minimumAvailable?: boolean;
    minimumPrice?: boolean;
  } = {},
) {
  const messages: Message[] = [
    {
      id: "100",
      role: "user",
      agentKey: "support",
      status: "complete",
      content: "СОХРАНЁННЫЙ_ВОПРОС",
    },
    {
      id: "101",
      role: "assistant",
      agentKey: "support",
      status: "complete",
      content: "СОХРАНЁННЫЙ_ОТВЕТ",
    },
  ];
  const state = {
    owner: "101",
    authenticated: true,
    sends: [] as Send[],
    dashboardReads: 0,
    nextMessage: 200,
    holdStream: false,
    holdRefresh: false,
    failNextSend: false,
    releaseStream: () => {},
    releaseRefresh: () => {},
    external: 0,
    unexpected: [] as string[],
  };
  const streamGate = new Promise<void>((resolve) => {
    state.releaseStream = resolve;
  });
  const refreshGate = new Promise<void>((resolve) => {
    state.releaseRefresh = resolve;
  });
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: `modes-${state.owner}@example.test`,
      role: "user",
      mustChangePassword: false,
    },
    profile: null,
    xp: 0,
    quests: [],
    thread: {
      id: state.owner === "101" ? "20" : "30",
      agentKey: "support",
      assistantKey: "support",
      closed: false,
      messages: state.owner === "101" ? messages : [],
    },
    provider: "routerai",
    aiAccess: {
      policy: {
        id: policyId,
        version: "synthetic-modes",
        provider: "routerai",
        model: "PRIVATE_MODEL_DO_NOT_RENDER",
        recipient: "PRIVATE_RECIPIENT_DO_NOT_RENDER",
        routing: "Synthetic transport only",
        data: "Fictional context only",
      },
      granted: true,
      dailyLimit: 100,
      ...(!options.legacy
        ? {
            modes: {
              catalogId,
              defaultMode: "balanced" as const,
              options: [
                { id: "maximum" as const, label: "Максимум", available: true },
                { id: "balanced" as const, label: "Баланс", available: true },
                {
                  id: "minimum" as const,
                  label: "Минимум",
                  available: options.minimumAvailable ?? true,
                  ...(options.minimumPrice
                    ? {
                        price: {
                          kind: "fixed" as const,
                          currency: "RUB" as const,
                          amountMicros: 3_000_000,
                        },
                      }
                    : {}),
                },
              ],
            },
          }
        : {}),
      credit: {
        currency: "RUB",
        bonusGranted: false,
        grantedMicros: 100_000_000,
        heldMicros: 0,
        spentMicros: 0,
        availableMicros: 100_000_000,
        chargingStatus: "routerai_citygo_10x",
        reservationMode: "fixed5_overdraft",
        minimumRequestBalanceMicros: 5_000_000,
        outstandingDebtMicros: 0,
        topUpAvailable: true,
        history: [],
      },
    },
  });
  await context.route("https://**", (route) => {
    state.external++;
    return route.abort();
  });
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    if (path === "/api/v1/auth/registration-policy" && method === "GET")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/auth/logout" && method === "POST") {
      state.authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/v1/auth/login" && method === "POST") {
      state.authenticated = true;
      state.owner = "202";
      return route.fulfill({ json: { user: board().user } });
    }
    if (!state.authenticated)
      return route.fulfill({
        status: 401,
        json: { error: "Synthetic signed-out session" },
      });
    if (path === "/api/v1/dashboard" && method === "GET") {
      state.dashboardReads++;
      if (state.holdRefresh && state.sends.length) {
        state.holdRefresh = false;
        await refreshGate;
      }
      return route.fulfill({ json: board() });
    }
    if (path === "/api/v1/account/profile" && method === "GET")
      return route.fulfill({
        json: {
          userId: state.owner,
          email: board().user.email,
          emailVerified: true,
          phoneVerified: true,
          giftStatus: "claimed",
          emailConfirmation: "available",
        },
      });
    if (path === "/api/v1/personal-plan" && method === "GET")
      return route.fulfill({
        json: { userId: state.owner, items: [], nextBefore: null },
      });
    const send = path.match(/^\/api\/v1\/threads\/(20|30)\/messages$/);
    if (send && method === "POST") {
      const payload = request.postDataJSON() as Send;
      state.sends.push(payload);
      expect(send[1]).toBe(state.owner === "101" ? "20" : "30");
      if (state.failNextSend) {
        state.failNextSend = false;
        return route.fulfill({
          status: 409,
          json: {
            error: "Режим временно недоступен",
            code: "AI_UNAVAILABLE",
            retryable: false,
          },
        });
      }
      if (state.holdStream) {
        state.holdStream = false;
        await streamGate;
      }
      const answer = "ОТВЕТ_НА_" + payload.text;
      const assistantId = String(state.nextMessage + 1);
      messages.push(
        {
          id: String(state.nextMessage++),
          role: "user",
          agentKey: "support",
          status: "complete",
          content: payload.text,
        },
        {
          id: String(state.nextMessage++),
          role: "assistant",
          agentKey: "support",
          status: "complete",
          content: answer,
        },
      );
      return route.fulfill({
        contentType: "text/event-stream; charset=utf-8",
        body: `data: ${JSON.stringify({ type: "delta", text: answer })}\n\ndata: ${JSON.stringify({ type: "done", messageId: assistantId })}\n\n`,
      });
    }
    state.unexpected.push(method + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic AI-mode request" },
    });
  });
  return state;
}

function noOtherTraffic(state: Awaited<ReturnType<typeof fixture>>) {
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
}

test("mode switches affect only the next explicit question and remain frozen through stream and history refresh", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context, { minimumPrice: true });
  state.holdStream = true;
  state.holdRefresh = true;
  await page.goto("/");
  await expect(selector(page)).toHaveValue("balanced");
  await expect(selector(page).locator('option[value="minimum"]')).toHaveText(
    "Минимум · 3 ₽ за запрос",
  );
  await expect(selector(page).locator('option[value="maximum"]')).toHaveText(
    "Максимум",
  );
  await expect(selector(page).locator('option[value="balanced"]')).toHaveText(
    "Баланс",
  );
  await selector(page).selectOption("maximum");
  expect(state.sends).toEqual([]);
  await composer(page).fill("ПЕРВЫЙ_КОНТРОЛЬНЫЙ_ВОПРОС");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(1);
  await expect(selector(page)).toBeDisabled();
  expect(state.sends[0]).toEqual({
    text: "ПЕРВЫЙ_КОНТРОЛЬНЫЙ_ВОПРОС",
    requestId: expect.any(String),
    policyId,
    creditReservationMode: "fixed5_overdraft",
    aiMode: "maximum",
    aiModeCatalogId: catalogId,
  });
  state.releaseStream();
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(1);
  await expect(selector(page)).toBeDisabled();
  state.releaseRefresh();
  await expect(selector(page)).toBeEnabled();
  await expect(
    page.getByRole("log", { name: "История диалога" }),
  ).toContainText("ОТВЕТ_НА_ПЕРВЫЙ_КОНТРОЛЬНЫЙ_ВОПРОС");
  await selector(page).selectOption("minimum");
  expect(state.sends).toHaveLength(1);
  await composer(page).fill("ПОСЛЕДНИЙ_КОНТРОЛЬНЫЙ_ВОПРОС");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(selector(page)).toBeEnabled();
  await expect.poll(() => state.sends.length).toBe(2);
  expect(state.sends[1]).toEqual({
    text: "ПОСЛЕДНИЙ_КОНТРОЛЬНЫЙ_ВОПРОС",
    requestId: expect.any(String),
    policyId,
    creditReservationMode: "fixed5_overdraft",
    aiMode: "minimum",
    aiModeCatalogId: catalogId,
  });
  expect(state.sends[1]!.requestId).not.toBe(state.sends[0]!.requestId);
  const log = page.getByRole("log", { name: "История диалога" });
  await expect(log).toContainText("СОХРАНЁННЫЙ_ОТВЕТ");
  await expect(log).toContainText("ОТВЕТ_НА_ПОСЛЕДНИЙ_КОНТРОЛЬНЫЙ_ВОПРОС");
  await expect(page.locator("body")).not.toContainText("PRIVATE_");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await selector(page).screenshot({
    path: info.outputPath("ai-mode-selector.png"),
  });
  noOtherTraffic(state);
});

test("unavailable modes and a failed request never fall back, retry or carry selection to another account", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { minimumAvailable: false });
  state.failNextSend = true;
  await page.goto("/");
  await expect(selector(page)).toHaveValue("balanced");
  await expect(
    selector(page).getByRole("option", { name: /^Минимум/ }),
  ).toHaveJSProperty("disabled", true);
  await expect(
    selector(page).locator('option[value="minimum"]'),
  ).not.toContainText("за запрос");
  await selector(page).selectOption("maximum");
  await composer(page).fill("СОХРАНИТЬ_ПРИ_ОШИБКЕ");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(composer(page)).toHaveValue("СОХРАНИТЬ_ПРИ_ОШИБКЕ");
  await expect(selector(page)).toBeEnabled();
  await expect(selector(page)).toHaveValue("maximum");
  expect(state.sends).toHaveLength(1);
  expect(state.sends[0]!.aiMode).toBe("maximum");
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await page
    .getByRole("button", { name: "Уже есть аккаунт? Войти", exact: true })
    .click();
  await page
    .getByLabel("Логин или электронная почта", { exact: true })
    .fill("second@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill("abcdef");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(selector(page)).toHaveValue("balanced");
  await expect(composer(page)).toHaveValue("");
  expect(state.sends).toHaveLength(1);
  noOtherTraffic(state);
});

test("a legacy dashboard does not advertise modes or add an unsupported mode to its stream", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { legacy: true });
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  await expect(selector(page)).toHaveCount(0);
  await composer(page).fill("ВОПРОС_СТАРОМУ_СЕРВЕРУ");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(1);
  await expect(composer(page)).toBeEnabled();
  expect(state.sends[0]).toEqual({
    text: "ВОПРОС_СТАРОМУ_СЕРВЕРУ",
    requestId: expect.any(String),
    policyId,
    creditReservationMode: "fixed5_overdraft",
  });
  await expect(selector(page)).toHaveCount(0);
  noOtherTraffic(state);
});
