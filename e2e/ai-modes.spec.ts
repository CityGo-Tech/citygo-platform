import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type {
  Dashboard,
  Message,
  ServiceConsentState,
} from "@citygo/contracts";
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
  page.getByLabel("Режим работы", { exact: true });
const composer = (page: Page) =>
  page.getByLabel("Сообщение помощнику", { exact: true });

/** Only synthetic HTTP/SSE responses; every provider destination is blocked. */
async function fixture(
  context: BrowserContext,
  options: {
    legacy?: boolean;
    minimumAvailable?: boolean;
    minimumPrice?: boolean;
    firstChoiceConsent?: boolean;
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
    consentReads: 0,
    consentSaves: [] as unknown[],
    consentOwners: new Set<string>(),
    failConsentRead: false,
    holdConsentRead: false,
    holdConsentSave: false,
    holdConsentRefresh: false,
    releaseConsentRead: () => {},
    releaseConsentSave: () => {},
  };
  const streamGate = new Promise<void>((resolve) => {
    state.releaseStream = resolve;
  });
  const refreshGate = new Promise<void>((resolve) => {
    state.releaseRefresh = resolve;
  });
  const consentReadGate = new Promise<void>((resolve) => {
    state.releaseConsentRead = resolve;
  });
  const consentSaveGate = new Promise<void>((resolve) => {
    state.releaseConsentSave = resolve;
  });
  const consentRequired = () =>
    Boolean(
      options.firstChoiceConsent && !state.consentOwners.has(state.owner),
    );
  const consentState = (required = consentRequired()): ServiceConsentState => ({
    policy: {
      ...syntheticConsentPolicy,
      aiProcessing: {
        id: policyId,
        version: "synthetic-modes",
        provider: "routerai",
        model: "synthetic/modes",
        recipient: "SYNTHETIC_FULL_RECIPIENTS",
        routing: "SYNTHETIC_FULL_ROUTES",
        data: "Synthetic selected-dialog context",
      },
      personalData: {
        ...syntheticConsentPolicy.personalData,
        text: "Полные условия новых режимов: SYNTHETIC_FULL_RECIPIENTS и SYNTHETIC_FULL_ROUTES. Передаётся контекст выбранного диалога.",
      },
    },
    personalDataGranted: true,
    marketingGranted: true,
    serviceConsentRequired: false,
    currentAiConsentRequired: required,
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
                {
                  id: "maximum" as const,
                  label: "Максимум",
                  available: true,
                  consentRequired: consentRequired(),
                },
                {
                  id: "balanced" as const,
                  label: "Баланс",
                  available: true,
                  consentRequired: false,
                },
                {
                  id: "minimum" as const,
                  label: "Минимум",
                  available: options.minimumAvailable ?? true,
                  consentRequired: consentRequired(),
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
    if (await fulfillProductAnalytics(route)) return;
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
      if (state.holdConsentRefresh && state.consentSaves.length) {
        state.holdConsentRefresh = false;
        await refreshGate;
      }
      if (state.holdRefresh && state.sends.length) {
        state.holdRefresh = false;
        await refreshGate;
      }
      return route.fulfill({ json: board() });
    }
    if (path === "/api/v1/account/consents" && method === "GET") {
      state.consentReads++;
      const result = consentState();
      if (state.holdConsentRead) {
        state.holdConsentRead = false;
        await consentReadGate;
      }
      if (state.failConsentRead) {
        state.failConsentRead = false;
        return route.fulfill({
          status: 503,
          json: { error: "Synthetic consent read failure" },
        });
      }
      return route.fulfill({ json: result });
    }
    if (path === "/api/v1/account/ai-modes-consent" && method === "POST") {
      const input = request.postDataJSON();
      state.consentSaves.push(input);
      const owner = state.owner;
      expect(input).toEqual({
        expectedUserId: owner,
        policyVersion: syntheticConsentPolicy.version,
        policyId,
        personalData: true,
      });
      if (state.holdConsentSave) {
        state.holdConsentSave = false;
        await consentSaveGate;
      }
      state.consentOwners.add(owner);
      return route.fulfill({ json: consentState(false) });
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
    "Минимум",
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

test("legacy Balance keeps the chat; a cancelled first new-mode choice preserves draft, history and balance", async ({
  page,
  context,
}, testInfo) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  await page.goto("/");
  await expect(selector(page)).toHaveValue("balanced");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.consentReads).toBe(0);
  await composer(page).fill("ЧЕРНОВИК_БЕЗ_ОТПРАВКИ");
  await selector(page).selectOption("maximum");
  const dialog = page.getByRole("dialog", { name: "Новые режимы ответа" });
  await expect(dialog).toBeVisible();
  const checkbox = dialog.getByRole("checkbox");
  await expect(checkbox).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Подтвердить и выбрать" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("link", { name: "Условия обработки персональных данных" }),
  ).toHaveAttribute("href", "/legal/personal-data-consent");
  await expect(
    dialog.getByText(/Полные условия новых режимов/),
  ).not.toBeVisible();
  await dialog.screenshot({
    path: testInfo.outputPath("new-mode-consent.png"),
  });
  await dialog.getByText("Прочитать условия здесь", { exact: true }).click();
  await expect(dialog.getByText(/Полные условия новых режимов/)).toBeVisible();
  await expect(dialog).not.toContainText("рекламу");
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(selector(page)).toHaveValue("balanced");
  await expect(composer(page)).toHaveValue("ЧЕРНОВИК_БЕЗ_ОТПРАВКИ");
  await expect(
    page.getByLabel("Баланс и телефон", { exact: true }),
  ).toContainText("100 ₽ CityGo");
  await expect(
    page.getByRole("log", { name: "История диалога" }),
  ).toContainText("СОХРАНЁННЫЙ_ОТВЕТ");
  expect(state.sends).toEqual([]);
  expect(state.consentSaves).toEqual([]);
  expect(state.consentOwners.size).toBe(0);
  noOtherTraffic(state);
});

test("current registration consent allows every mode without an extra dialog", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  state.consentOwners.add("101");
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  await selector(page).selectOption("maximum");
  await expect(selector(page)).toHaveValue("maximum");
  await selector(page).selectOption("minimum");
  await expect(selector(page)).toHaveValue("minimum");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.consentReads).toBe(0);
  expect(state.consentSaves).toEqual([]);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});

test("first explicit new-mode consent selects only after persistence and dashboard refresh; later choices need no extra checkbox", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  await page.goto("/");
  await composer(page).fill("СОХРАНИТЬ_ЧЕРНОВИК");
  await selector(page).selectOption("maximum");
  const dialog = page.getByRole("dialog", { name: "Новые режимы ответа" });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Подтвердить и выбрать" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(selector(page)).toHaveValue("maximum");
  await expect(composer(page)).toHaveValue("СОХРАНИТЬ_ЧЕРНОВИК");
  expect(state.consentSaves).toHaveLength(1);
  expect(state.consentOwners.has("101")).toBe(true);
  expect(state.dashboardReads).toBeGreaterThanOrEqual(3);
  await selector(page).selectOption("minimum");
  await expect(selector(page)).toHaveValue("minimum");
  await expect(dialog).toHaveCount(0);
  expect(state.consentReads).toBe(1);
  expect(state.consentSaves).toHaveLength(1);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});

test("a failed consent fetch leaves the old mode and draft intact; retry starts with an unchecked choice", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  state.failConsentRead = true;
  await page.goto("/");
  await composer(page).fill("НЕ_ТЕРЯТЬ_ТЕКСТ");
  await selector(page).selectOption("minimum");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(state.consentSaves).toEqual([]);
  await dialog.getByRole("button", { name: "Загрузить условия" }).click();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(selector(page)).toHaveValue("balanced");
  await expect(composer(page)).toHaveValue("НЕ_ТЕРЯТЬ_ТЕКСТ");
  expect(state.consentReads).toBe(2);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});

test("cancelled late loads cannot reopen or replace a later mode choice", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  state.holdConsentRead = true;
  await page.goto("/");
  await selector(page).selectOption("maximum");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toBeVisible();
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await selector(page).selectOption("minimum");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  state.releaseConsentRead();
  await expect(dialog).toContainText("«Минимум»");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(selector(page)).toHaveValue("balanced");
  expect(state.consentSaves).toEqual([]);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});

test("an account switch during consent persistence cannot select a mode for the new account", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  state.holdConsentSave = true;
  await page.goto("/");
  await selector(page).selectOption("maximum");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Подтвердить и выбрать" }).click();
  await expect.poll(() => state.consentSaves.length).toBe(1);
  state.owner = "202";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog).toHaveCount(0);
  await expect(selector(page)).toHaveValue("balanced");
  state.releaseConsentSave();
  await expect(composer(page)).toHaveValue("");
  await expect(selector(page)).toHaveValue("balanced");
  expect(state.consentOwners.has("202")).toBe(false);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});

test("cancelling after persistence but before dashboard refresh never selects the pending mode", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  state.holdConsentRefresh = true;
  await page.goto("/");
  await composer(page).fill("ОСТАВИТЬ_ЧЕРНОВИК");
  await selector(page).selectOption("maximum");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Подтвердить и выбрать" }).click();
  await expect.poll(() => state.dashboardReads).toBeGreaterThanOrEqual(3);
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  state.releaseRefresh();
  await expect(dialog).toHaveCount(0);
  await expect(selector(page)).toHaveValue("balanced");
  await expect(composer(page)).toHaveValue("ОСТАВИТЬ_ЧЕРНОВИК");
  expect(state.consentSaves).toHaveLength(1);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});
