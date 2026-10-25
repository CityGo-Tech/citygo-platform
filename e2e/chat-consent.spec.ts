import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { AiConsentInput, Dashboard, Message } from "@citygo/contracts";
import { syntheticConsentPolicy } from "./service-consent-fixture";

const consentDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Обработка сообщений", exact: true });
const send = (page: Page) =>
  page.getByRole("button", { name: "Отправить", exact: true });
const confirm = (page: Page) =>
  consentDialog(page).getByRole("button", {
    name: "Разрешить и отправить",
    exact: true,
  });

/** Entirely synthetic transport. No provider, SMS or payment endpoint is allowed. */
async function fixture(context: BrowserContext, granted = false) {
  const state = {
    owner: "101",
    authenticated: true,
    granted,
    policyId: "a".repeat(64),
    consentPosts: [] as AiConsentInput[],
    streamPosts: [] as { text: string; policyId: string; requestId: string }[],
    messages: [] as Message[],
    dashboardReads: 0,
    failDashboardAfterGrant: false,
    failNextDashboard: false,
    consentReplies: 0,
    conflictNext: false,
    holdConsent: false,
    releaseConsent: () => {},
    forbidden: [] as string[],
    external: 0,
  };
  const consentGate = new Promise<void>((resolve) => {
    state.releaseConsent = resolve;
  });
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: "owner-" + state.owner + "@example.test",
      role: "user",
      mustChangePassword: false,
    },
    profile: null,
    quests: [],
    xp: 0,
    provider: "routerai",
    thread: {
      id: state.owner === "101" ? "10" : "30",
      agentKey: "support",
      assistantKey: "support",
      closed: false,
      messages: state.messages,
    },
    aiAccess: {
      granted: state.granted,
      dailyLimit: 100,
      policy: {
        id: state.policyId,
        version: "synthetic-first-send",
        provider: "routerai",
        model: "test/model-never-dispatched",
        recipient:
          state.policyId === "a".repeat(64)
            ? "Первый синтетический получатель"
            : "Новый синтетический получатель",
        routing: "Тестовый маршрут без внешних запросов",
        data: "Вымышленная переписка для проверки интерфейса",
      },
      credit: {
        currency: "RUB",
        bonusGranted: false,
        grantedMicros: 100_000_000,
        availableMicros: 100_000_000,
        heldMicros: 0,
        spentMicros: 0,
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
      path = new URL(request.url()).pathname;
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/auth/logout") {
      state.authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (!state.authenticated)
      return route.fulfill({ status: 401, json: { error: "Signed out" } });
    if (path === "/api/v1/dashboard") {
      state.dashboardReads++;
      if (state.failNextDashboard) {
        state.failNextDashboard = false;
        return route.fulfill({
          status: 503,
          json: { error: "Не удалось загрузить тестовый кабинет" },
        });
      }
      return route.fulfill({ json: board() });
    }
    if (path === "/api/v1/account/consents" && request.method() === "GET")
      return route.fulfill({
        json: {
          policy: syntheticConsentPolicy,
          personalDataGranted: true,
          marketingGranted: false,
          serviceConsentRequired: false,
        },
      });
    if (path === "/api/v1/ai/consent" && request.method() === "POST") {
      const input = request.postDataJSON() as AiConsentInput;
      state.consentPosts.push(input);
      const owner = state.owner;
      if (input.action === "granted") {
        expect(input.policyId).toBe(state.policyId);
        if (state.conflictNext) {
          state.conflictNext = false;
          state.policyId = "b".repeat(64);
          return route.fulfill({
            status: 409,
            json: {
              error: "Условия обработки изменились. Проверьте их ещё раз.",
              code: "AI_POLICY_CHANGED",
            },
          });
        }
        if (state.holdConsent) await consentGate;
      }
      if (owner === state.owner) {
        state.granted = input.action === "granted";
        if (state.granted && state.failDashboardAfterGrant)
          state.failNextDashboard = true;
      }
      try {
        await route.fulfill({ json: { ok: true } });
      } catch {
        /* The old session cancelled its request. */
      } finally {
        state.consentReplies++;
      }
      return;
    }
    if (
      /^\/api\/v1\/threads\/(10|30)\/messages$/.test(path) &&
      request.method() === "POST"
    ) {
      const input = request.postDataJSON() as {
        text: string;
        policyId: string;
        requestId: string;
      };
      state.streamPosts.push(input);
      expect(state.granted).toBe(true);
      expect(input.policyId).toBe(state.policyId);
      const index = state.streamPosts.length;
      const reply = "Синтетический ответ " + index;
      const id = String(20 + index * 2);
      state.messages.push(
        {
          id,
          role: "user",
          agentKey: "support",
          status: "complete",
          content: input.text,
        },
        {
          id: String(BigInt(id) + 1n),
          role: "assistant",
          agentKey: "support",
          status: "complete",
          content: reply,
        },
      );
      return route.fulfill({
        contentType: "text/event-stream; charset=utf-8",
        headers: { "X-CityGo-Contract-Version": "1" },
        body: [
          { type: "delta", text: reply },
          { type: "done", messageId: String(BigInt(id) + 1n) },
        ]
          .map((event) => "data: " + JSON.stringify(event) + "\n\n")
          .join(""),
      });
    }
    state.forbidden.push(request.method() + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  return state;
}

test("chat has no pre-start card; cancel or Escape retain the draft without granting or sending", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  await page.goto("/");
  await expect(page.getByLabel("Сообщение помощнику")).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "Перед началом", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".conversation-main .ai-access")).toHaveCount(0);
  await expect(
    page
      .locator(".conversation-main")
      .getByRole("button", { name: "Баланс и пополнение", exact: true }),
  ).toHaveCount(0);
  const draft = "С чего начать переезд, если бюджет пока неизвестен?";
  await page.getByLabel("Сообщение помощнику").fill(draft);
  await page.screenshot({
    path: info.outputPath("chat-without-prestart-card.png"),
    fullPage: true,
  });
  await send(page).click();
  const dialog = consentDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  expect(await dialog.innerText()).not.toContain(
    "Первый синтетический получатель",
  );
  await dialog.screenshot({
    path: info.outputPath("compact-first-send-consent.png"),
  });
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(draft);
  await send(page).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(draft);
  expect(state.consentPosts).toEqual([]);
  expect(state.streamPosts).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.forbidden).toEqual([]);
});

test("explicit first-send confirmation grants exactly once and sends only the captured question; later questions need no dialog", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.holdConsent = true;
  try {
    await page.goto("/");
    const first = "Мой первый явный вопрос";
    await page.getByLabel("Сообщение помощнику").fill(first);
    await send(page).click();
    await consentDialog(page)
      .getByText("Условия обработки сообщений", { exact: true })
      .click();
    await expect(consentDialog(page)).toContainText(
      "Обработку выполняет Первый синтетический получатель.",
    );
    await confirm(page).evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect.poll(() => state.consentPosts.length).toBe(1);
    await expect(confirm(page)).toBeDisabled();
    expect(state.streamPosts).toEqual([]);
    state.releaseConsent();
    await expect(page.getByRole("log")).toContainText("Синтетический ответ 1");
    await expect(consentDialog(page)).toHaveCount(0);
    expect(state.consentPosts).toEqual([
      { action: "granted", policyId: "a".repeat(64) },
    ]);
    expect(state.streamPosts).toHaveLength(1);
    expect(state.streamPosts[0]?.text).toBe(first);
    const second = "Следующий вопрос в том же диалоге";
    await page.getByLabel("Сообщение помощнику").fill(second);
    await send(page).click();
    await expect(page.getByRole("log")).toContainText("Синтетический ответ 2");
    await expect(consentDialog(page)).toHaveCount(0);
    expect(state.consentPosts).toHaveLength(1);
    expect(state.streamPosts.map((input) => input.text)).toEqual([
      first,
      second,
    ]);
    expect(state.external).toBe(0);
    expect(state.forbidden).toEqual([]);
  } finally {
    state.releaseConsent();
  }
});

for (const method of ["button", "escape"] as const) {
  test(`${method} cancellation during a delayed grant keeps the draft and prevents automatic dispatch after the receipt`, async ({
    page,
    context,
  }) => {
    const state = await fixture(context);
    state.holdConsent = true;
    try {
      await page.goto("/");
      const draft = "Я передумал отправлять этот вопрос";
      await page.getByLabel("Сообщение помощнику").fill(draft);
      await send(page).click();
      await confirm(page).click();
      await expect.poll(() => state.consentPosts.length).toBe(1);
      if (method === "button")
        await consentDialog(page)
          .getByRole("button", { name: "Отмена", exact: true })
          .click();
      else await page.keyboard.press("Escape");
      await expect(consentDialog(page)).toHaveCount(0);
      await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(draft);
      state.releaseConsent();
      await expect.poll(() => state.consentReplies).toBe(1);
      await expect(page.getByLabel("Сообщение помощнику")).toBeEnabled();
      await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(draft);
      // The server may already have recorded consent, but cancelling the send
      // intent must prevent this question from reaching a model afterwards.
      expect(state.granted).toBe(true);
      expect(state.streamPosts).toEqual([]);
      expect(state.consentPosts).toHaveLength(1);
      expect(state.forbidden).toEqual([]);
    } finally {
      state.releaseConsent();
    }
  });
}

test("a policy change discovered on focus invalidates an open dialog without sending or granting", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  const draft = "Вопрос при обновлении условий в другой вкладке";
  await page.getByLabel("Сообщение помощнику").fill(draft);
  await send(page).click();
  await expect(consentDialog(page)).toBeVisible();
  state.policyId = "b".repeat(64);
  const fresh = page.waitForResponse("**/api/v1/dashboard");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await fresh;
  await expect(consentDialog(page)).toHaveCount(0);
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(draft);
  expect(state.consentPosts).toEqual([]);
  expect(state.streamPosts).toEqual([]);
  await send(page).click();
  await consentDialog(page)
    .getByText("Условия обработки сообщений", { exact: true })
    .click();
  await expect(consentDialog(page)).toContainText(
    "Новый синтетический получатель",
  );
  await confirm(page).click();
  await expect(page.getByRole("log")).toContainText("Синтетический ответ 1");
  expect(state.consentPosts).toEqual([
    { action: "granted", policyId: "b".repeat(64) },
  ]);
  expect(state.streamPosts).toHaveLength(1);
  expect(state.forbidden).toEqual([]);
});

test("a successful grant followed by a failed dashboard refresh never dispatches or retries the question", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.failDashboardAfterGrant = true;
  await page.goto("/");
  const draft = "Этот вопрос нельзя отправлять при сбое проверки кабинета";
  await page.getByLabel("Сообщение помощнику").fill(draft);
  await send(page).click();
  await confirm(page).click();
  await expect(consentDialog(page).getByRole("alert")).toContainText(
    "Не удалось загрузить тестовый кабинет",
  );
  await expect(confirm(page)).toBeEnabled();
  expect(state.granted).toBe(true);
  expect(state.consentPosts).toHaveLength(1);
  expect(state.streamPosts).toEqual([]);
  await consentDialog(page)
    .getByRole("button", { name: "Отмена", exact: true })
    .click();
  await expect(consentDialog(page)).toHaveCount(0);
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(draft);
  expect(state.streamPosts).toEqual([]);
  expect(state.forbidden).toEqual([]);
});

test("a policy conflict refreshes terms but never repeats a consent or sends until another explicit confirmation", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.conflictNext = true;
  await page.goto("/");
  const draft = "Вопрос после смены условий";
  await page.getByLabel("Сообщение помощнику").fill(draft);
  await send(page).click();
  await confirm(page).click();
  await expect(page.locator(".alert[role=alert]")).toContainText(
    "Условия обновились",
  );
  await expect(consentDialog(page)).toHaveCount(0);
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(draft);
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(1);
  expect(state.consentPosts).toHaveLength(1);
  expect(state.streamPosts).toEqual([]);
  await send(page).click();
  await consentDialog(page)
    .getByText("Условия обработки сообщений", { exact: true })
    .click();
  await expect(consentDialog(page)).toContainText(
    "Новый синтетический получатель",
  );
  await confirm(page).click();
  await expect(page.getByRole("log")).toContainText("Синтетический ответ 1");
  expect(state.consentPosts).toEqual([
    { action: "granted", policyId: "a".repeat(64) },
    { action: "granted", policyId: "b".repeat(64) },
  ]);
  expect(state.streamPosts).toHaveLength(1);
  expect(state.streamPosts[0]?.text).toBe(draft);
  expect(state.forbidden).toEqual([]);
});

test("cross-tab logout cancels a pending confirmation and its late receipt cannot send the previous owner's question", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.holdConsent = true;
  try {
    await page.goto("/");
    await page
      .getByLabel("Сообщение помощнику")
      .fill("PRIVATE_PENDING_QUESTION_A");
    await send(page).click();
    await confirm(page).click();
    await expect.poll(() => state.consentPosts.length).toBe(1);
    const other = await context.newPage();
    await other.goto("/");
    await other.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Создать аккаунт", exact: true }),
    ).toBeVisible();
    await expect(consentDialog(page)).toHaveCount(0);
    state.owner = "202";
    state.authenticated = true;
    state.granted = false;
    await page.reload();
    await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("");
    state.releaseConsent();
    await expect(page.getByText("PRIVATE_PENDING_QUESTION_A")).toHaveCount(0);
    await expect(consentDialog(page)).toHaveCount(0);
    expect(state.streamPosts).toEqual([]);
    expect(state.consentPosts).toHaveLength(1);
    expect(state.forbidden).toEqual([]);
    await other.close();
  } finally {
    state.releaseConsent();
  }
});

test("processing terms and revocation live in account consents rather than in chat", async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  await page.goto("/");
  await expect(page.locator(".conversation-main .ai-access")).toHaveCount(0);
  await page.getByRole("button", { name: "Согласия", exact: true }).click();
  const settings = page.getByRole("region", {
    name: "Обработка сообщений",
    exact: true,
  });
  await expect(settings).toBeVisible();
  expect(await settings.innerText()).not.toContain(
    "Первый синтетический получатель",
  );
  await settings
    .getByText("Условия обработки сообщений", { exact: true })
    .click();
  await expect(settings).toContainText("Первый синтетический получатель");
  await settings
    .getByRole("button", {
      name: "Отозвать согласие на обработку сообщений",
      exact: true,
    })
    .click();
  await expect(
    settings.getByRole("button", {
      name: "Отозвать согласие на обработку сообщений",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(state.consentPosts).toEqual([{ action: "revoked" }]);
  await page.getByRole("button", { name: "Назад", exact: true }).click();
  await page.getByLabel("Сообщение помощнику").fill("Вопрос после отзыва");
  await send(page).click();
  await expect(consentDialog(page)).toBeVisible();
  await consentDialog(page)
    .getByRole("button", { name: "Отмена", exact: true })
    .click();
  expect(state.consentPosts).toHaveLength(1);
  expect(state.streamPosts).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.forbidden).toEqual([]);
});
