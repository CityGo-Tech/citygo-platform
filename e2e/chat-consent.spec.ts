import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type {
  Dashboard,
  Message,
  ServiceConsentChoice,
} from "@citygo/contracts";
import { syntheticConsentPolicy } from "./service-consent-fixture";

const send = (page: Page) =>
  page.getByRole("button", { name: "Отправить", exact: true });
const accept = (page: Page) =>
  page.getByRole("button", { name: "Принять и продолжить", exact: true });
const mandatory = (page: Page) =>
  page.locator("input[name=personalDataConsent]");
const marketing = (page: Page) => page.locator("input[name=marketingConsent]");
const gate = (page: Page) =>
  page.getByRole("heading", {
    name: "Согласие для работы сервиса",
    exact: true,
  });

/** Server-authorized fixtures only: the browser never creates an AI grant. */
async function fixture(context: BrowserContext, required = false) {
  const state = {
    owner: "101",
    authenticated: true,
    required,
    granted: !required,
    aiPolicyId: "a".repeat(64),
    policyVersion: syntheticConsentPolicy.version,
    messages: [] as Message[],
    choices: [] as ServiceConsentChoice[],
    registrations: [] as { consents: ServiceConsentChoice }[],
    streamPosts: [] as { text: string; policyId: string }[],
    providerDispatches: 0,
    aiConsentPosts: 0,
    external: 0,
    unexpected: [] as string[],
    gateConflict: false,
    rejectStream: null as
      "AI_POLICY_CHANGED" | "SERVICE_CONSENT_REQUIRED" | null,
    holdChoice: false,
    releaseChoice: () => {},
    choiceReplies: 0,
    failDashboardAfterChoice: false,
    failNextDashboard: false,
  };
  const choiceGate = new Promise<void>((resolve) => {
    state.releaseChoice = resolve;
  });
  const policy = () => ({
    ...syntheticConsentPolicy,
    version: state.policyVersion,
    personalData: {
      ...syntheticConsentPolicy.personalData,
      text:
        syntheticConsentPolicy.personalData.text +
        "\n\nEXACT_API_PROCESSING_SNAPSHOT_" +
        state.aiPolicyId,
    },
  });
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: "owner-" + state.owner + "@example.test",
      role: "user",
      mustChangePassword: false,
      serviceConsentRequired: state.required,
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
        id: state.aiPolicyId,
        version: "synthetic-server-binding",
        provider: "routerai",
        model: "synthetic-never-dispatched",
        recipient: "Синтетический получатель",
        routing: "Без внешних запросов",
        data: "Вымышленная переписка",
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
    if (await fulfillProductAnalytics(route)) return;
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: { emailVerification: "disabled", consentPolicy: policy() },
      });
    if (path === "/api/v1/legal/consent-policy")
      return route.fulfill({ json: policy() });
    if (path === "/api/v1/auth/logout") {
      state.authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/v1/auth/register") {
      const input = request.postDataJSON() as {
        consents: ServiceConsentChoice;
      };
      state.registrations.push(input);
      expect(input.consents.personalData).toBe(true);
      expect(input.consents.policyVersion).toBe(state.policyVersion);
      state.authenticated = true;
      state.required = false;
      state.granted = true;
      return route.fulfill({ json: { user: board().user } });
    }
    if (!state.authenticated)
      return route.fulfill({ status: 401, json: { error: "Signed out" } });
    if (path === "/api/v1/dashboard") {
      if (state.failNextDashboard) {
        state.failNextDashboard = false;
        return route.fulfill({
          status: 503,
          json: { error: "Не удалось загрузить тестовый кабинет" },
        });
      }
      return route.fulfill({ json: board() });
    }
    if (path === "/api/v1/ai/consent") {
      state.aiConsentPosts++;
      return route.fulfill({
        status: 500,
        json: { error: "Browser must not grant AI consent" },
      });
    }
    if (path === "/api/v1/account/consents") {
      if (request.method() === "POST") {
        const input = request.postDataJSON() as ServiceConsentChoice;
        const owner = state.owner,
          shown = policy();
        state.choices.push(input);
        expect(input.personalData).toBe(true);
        expect(input.policyVersion).toBe(state.policyVersion);
        if (state.gateConflict) {
          state.gateConflict = false;
          state.aiPolicyId = "b".repeat(64);
          state.policyVersion = "synthetic-new-binding";
          return route.fulfill({
            status: 409,
            json: {
              error: "Условия изменились",
              code: "SERVICE_CONSENT_POLICY_CHANGED",
            },
          });
        }
        if (state.holdChoice) await choiceGate;
        if (owner === state.owner) {
          state.required = false;
          state.granted = true;
          if (state.failDashboardAfterChoice) state.failNextDashboard = true;
        }
        try {
          await route.fulfill({
            json: {
              policy: shown,
              personalDataGranted: true,
              marketingGranted: input.marketing,
              serviceConsentRequired: false,
            },
          });
        } catch {
          /* The old authenticated lifetime has ended. */
        } finally {
          state.choiceReplies++;
        }
        return;
      }
      return route.fulfill({
        json: {
          policy: policy(),
          personalDataGranted: !state.required,
          marketingGranted: false,
          serviceConsentRequired: state.required,
        },
      });
    }
    if (
      /^\/api\/v1\/threads\/(10|30)\/messages$/.test(path) &&
      request.method() === "POST"
    ) {
      const input = request.postDataJSON() as {
        text: string;
        policyId: string;
      };
      state.streamPosts.push(input);
      if (state.rejectStream) {
        const code = state.rejectStream;
        state.rejectStream = null;
        state.required = true;
        state.granted = false;
        state.aiPolicyId = "b".repeat(64);
        state.policyVersion = "synthetic-new-binding";
        return route.fulfill({
          status: code === "AI_POLICY_CHANGED" ? 409 : 403,
          json: { code, error: "Условия обновились" },
        });
      }
      expect(state.granted).toBe(true);
      expect(state.required).toBe(false);
      expect(input.policyId).toBe(state.aiPolicyId);
      state.providerDispatches++;
      const id = String(20 + state.providerDispatches * 2),
        reply = "Синтетический ответ " + state.providerDispatches;
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
    state.unexpected.push(request.method() + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  return state;
}
async function assertNoConsentSurface(page: Page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Согласия", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Перед началом", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Обработка сообщений", exact: true }),
  ).toHaveCount(0);
  const conversation = page.locator(".conversation-home");
  await expect(conversation.locator(".conversation-chat-card")).toHaveCount(1);
  // The sibling wallet remains mounted to preserve an unfinished top-up form.
  // The chat itself must contain no permanent consent or financial access panel.
  await expect(
    conversation.locator(".conversation-main .ai-access"),
  ).toHaveCount(0);
}

test("a server-bound registration allows direct first and later sends without a dialog, consent menu or client AI grant", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  await page.goto("/");
  await assertNoConsentSurface(page);
  const first = "Первый вопрос после регистрации";
  await page.getByLabel("Сообщение помощнику").fill(first);
  await page.screenshot({
    path: info.outputPath("chat-without-consent-ui.png"),
    fullPage: true,
  });
  await send(page).click();
  await expect(page.getByRole("log")).toContainText("Синтетический ответ 1");
  await assertNoConsentSurface(page);
  const second = "Продолжим разговор";
  await page.getByLabel("Сообщение помощнику").fill(second);
  await send(page).click();
  await expect(page.getByRole("log")).toContainText("Синтетический ответ 2");
  expect(state.streamPosts.map((input) => input.text)).toEqual([first, second]);
  expect(state.aiConsentPosts).toBe(0);
  expect(state.choices).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("signup shows exact API terms behind the required checkbox and records optional marketing refusal without a separate AI request", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.authenticated = false;
  await page.goto("/");
  await expect(mandatory(page)).not.toBeChecked();
  await expect(marketing(page)).not.toBeChecked();
  await page
    .getByText("Читать согласие на обработку данных", { exact: true })
    .click();
  await expect(
    page.getByRole("article", {
      name: syntheticConsentPolicy.personalData.label,
      exact: true,
    }),
  ).toContainText("EXACT_API_PROCESSING_SNAPSHOT_" + "a".repeat(64));
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill("registered@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill("123456");
  await mandatory(page).check();
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await page.getByLabel("Сообщение помощнику").fill("Вопрос нового аккаунта");
  await send(page).click();
  await expect(page.getByRole("log")).toContainText("Синтетический ответ 1");
  expect(state.registrations).toHaveLength(1);
  expect(state.registrations[0]?.consents.marketing).toBe(false);
  expect(state.aiConsentPosts).toBe(0);
  expect(state.choices).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("an older unbound account stays gated until an explicit current choice; acceptance never submits a question", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context, true);
  state.messages = [
    {
      id: "11",
      role: "user",
      agentKey: "support",
      status: "complete",
      content: "PRIVATE_BEFORE_ACCEPTANCE",
    },
  ];
  await page.goto("/");
  await expect(gate(page)).toBeVisible();
  await expect(mandatory(page)).not.toBeChecked();
  await expect(page.getByText("PRIVATE_BEFORE_ACCEPTANCE")).toHaveCount(0);
  await expect(page.getByLabel("Сообщение помощнику")).toHaveCount(0);
  await expect(accept(page)).toBeDisabled();
  await mandatory(page).check();
  await accept(page).click();
  await expect(page.getByLabel("Сообщение помощнику")).toBeEnabled();
  await assertNoConsentSurface(page);
  expect(state.streamPosts).toEqual([]);
  expect(state.aiConsentPosts).toBe(0);
  expect(state.choices).toEqual([
    {
      policyVersion: syntheticConsentPolicy.version,
      personalData: true,
      marketing: false,
    },
  ]);
  await page.screenshot({
    path: info.outputPath("accepted-account-no-consent-menu.png"),
    fullPage: true,
  });
});

test("a changed required-policy snapshot clears both choices and needs a new explicit acceptance", async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  state.gateConflict = true;
  await page.goto("/");
  await mandatory(page).check();
  await marketing(page).check();
  await accept(page).click();
  await expect(mandatory(page)).not.toBeChecked();
  await expect(marketing(page)).not.toBeChecked();
  await expect(accept(page)).toBeDisabled();
  await page
    .getByText("Читать согласие на обработку данных", { exact: true })
    .click();
  await expect(
    page.getByRole("article", {
      name: syntheticConsentPolicy.personalData.label,
      exact: true,
    }),
  ).toContainText("EXACT_API_PROCESSING_SNAPSHOT_" + "b".repeat(64));
  expect(state.choices).toHaveLength(1);
  expect(state.streamPosts).toEqual([]);
  await mandatory(page).check();
  await accept(page).click();
  await expect(page.getByLabel("Сообщение помощнику")).toBeEnabled();
  expect(state.choices[1]?.policyVersion).toBe("synthetic-new-binding");
  expect(state.choices[1]?.marketing).toBe(false);
  expect(state.aiConsentPosts).toBe(0);
  expect(state.streamPosts).toEqual([]);
});

for (const code of ["AI_POLICY_CHANGED", "SERVICE_CONSENT_REQUIRED"] as const) {
  test(
    code +
      " refreshes the required gate without granting, replaying or dispatching the rejected question",
    async ({ page, context }) => {
      const state = await fixture(context);
      state.rejectStream = code;
      await page.goto("/");
      await page
        .getByLabel("Сообщение помощнику")
        .fill("Вопрос по прежним условиям");
      await send(page).click();
      await expect(gate(page)).toBeVisible();
      expect(state.providerDispatches).toBe(0);
      expect(state.streamPosts).toHaveLength(1);
      expect(state.aiConsentPosts).toBe(0);
      expect(state.choices).toEqual([]);
      await mandatory(page).check();
      await accept(page).click();
      await expect(page.getByLabel("Сообщение помощнику")).toBeEnabled();
      expect(state.streamPosts).toHaveLength(1);
      await page.getByLabel("Сообщение помощнику").fill("Явный новый вопрос");
      await send(page).click();
      await expect(page.getByRole("log")).toContainText(
        "Синтетический ответ 1",
      );
      expect(state.streamPosts.map((input) => input.text)).toEqual([
        "Вопрос по прежним условиям",
        "Явный новый вопрос",
      ]);
      expect(state.providerDispatches).toBe(1);
      expect(state.aiConsentPosts).toBe(0);
      expect(state.unexpected).toEqual([]);
    },
  );
}

test("a late acceptance cannot enter another account or confirm its unchecked choices", async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  state.holdChoice = true;
  try {
    await page.goto("/");
    await mandatory(page).check();
    await accept(page).click();
    await expect.poll(() => state.choices.length).toBe(1);
    state.owner = "202";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(mandatory(page)).not.toBeChecked();
    state.releaseChoice();
    await expect.poll(() => state.choiceReplies).toBe(1);
    await expect(gate(page)).toBeVisible();
    await expect(accept(page)).toBeDisabled();
    expect(state.required).toBe(true);
    expect(state.granted).toBe(false);
    expect(state.streamPosts).toEqual([]);
    expect(state.aiConsentPosts).toBe(0);
  } finally {
    state.releaseChoice();
  }
});

test("a saved acceptance followed by a failed refresh never sends; later refresh restores the account without replay", async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  state.failDashboardAfterChoice = true;
  await page.goto("/");
  await mandatory(page).check();
  await accept(page).click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Не удалось загрузить тестовый кабинет",
    }),
  ).toHaveText("Не удалось загрузить тестовый кабинет");
  expect(state.granted).toBe(true);
  expect(state.choices).toHaveLength(1);
  expect(state.streamPosts).toEqual([]);
  expect(state.aiConsentPosts).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("Сообщение помощнику")).toBeEnabled();
  await assertNoConsentSurface(page);
  expect(state.streamPosts).toEqual([]);
  expect(state.choices).toHaveLength(1);
});
