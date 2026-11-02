import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Dashboard, Message } from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
const catalogId = "b".repeat(64);
const policyId = "a".repeat(64);
const composer = (page: Page) =>
  page.getByLabel("Сообщение помощнику", { exact: true });
async function fixture(context: BrowserContext) {
  const state = {
    owner: "101",
    sends: [] as { threadId: string; input: Record<string, unknown> }[],
    unexpected: [] as string[],
    external: 0,
    hold: false,
    failRefresh: false,
    failStream: false,
    closed: false,
    release: () => {},
  };
  const gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  const messages: Message[] = [];
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: `material-${state.owner}@example.test`,
      role: "user",
      mustChangePassword: false,
    },
    profile: null,
    xp: 0,
    quests: [],
    thread: {
      id: state.owner === "101" ? "20" : "30",
      agentKey: "housing",
      assistantKey: "housing",
      closed: state.closed,
      messages:
        state.owner === "101"
          ? messages
          : [
              {
                id: "301",
                role: "assistant",
                agentKey: "housing",
                status: "complete",
                content: "НОВЫЙ_ВЛАДЕЛЕЦ_МАТЕРИАЛА",
              },
            ],
    },
    provider: "routerai",
    aiAccess: {
      policy: {
        id: policyId,
        version: "synthetic-material",
        provider: "routerai",
        model: "synthetic/model",
        recipient: "Synthetic",
        routing: "Synthetic",
        data: "Synthetic",
      },
      granted: true,
      dailyLimit: 100,
      modes: {
        catalogId,
        defaultMode: "balanced",
        options: [
          {
            id: "maximum",
            label: "Максимум",
            available: true,
            consentRequired: false,
          },
          {
            id: "balanced",
            label: "Баланс",
            available: true,
            consentRequired: false,
          },
          {
            id: "minimum",
            label: "Минимум",
            available: true,
            consentRequired: false,
            price: { kind: "fixed", currency: "RUB", amountMicros: 3_000_000 },
          },
        ],
      },
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
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/dashboard")
      return state.failRefresh && state.sends.length
        ? route.fulfill({
            status: 500,
            json: { error: "Synthetic refresh failure" },
          })
        : route.fulfill({ json: board() });
    if (path === "/api/v1/account/consents")
      return route.fulfill({
        json: {
          policy: syntheticConsentPolicy,
          personalDataGranted: true,
          marketingGranted: true,
          serviceConsentRequired: false,
          currentAiConsentRequired: false,
        },
      });
    if (/^\/api\/v1\/conversations\/(20|30)$/.test(path))
      return route.fulfill({
        json: { userId: state.owner, thread: board().thread },
      });
    const send = path.match(/^\/api\/v1\/threads\/(20|30)\/messages$/);
    if (send && method === "POST") {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      state.sends.push({ threadId: send[1]!, input });
      if (state.failStream)
        return route.fulfill({
          status: 503,
          json: { error: "Synthetic send failure" },
        });
      if (state.hold) await gate;
      messages.push(
        {
          id: "100",
          role: "user",
          agentKey: "housing",
          status: "complete",
          content: String(input.text),
        },
        {
          id: "101",
          role: "assistant",
          agentKey: "housing",
          status: "complete",
          content: "ПРОВЕРОЧНЫЙ_ОТВЕТ",
        },
      );
      return route.fulfill({
        contentType: "text/event-stream; charset=utf-8",
        body: `data: ${JSON.stringify({ type: "delta", text: "ПРОВЕРОЧНЫЙ_ОТВЕТ" })}\n\ndata: ${JSON.stringify({ type: "done", messageId: "101" })}\n\n`,
      });
    }
    state.unexpected.push(method + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic material request" },
    });
  });
  return state;
}

test("unsent chat draft survives reload, remains private and sends only after explicit action", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  await page.goto("/");
  const text = "  Неотправленный вопрос о переезде 🧳";
  await composer(page).fill(text);
  await page.reload();
  await expect(composer(page)).toHaveValue(text);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Восстановлен неотправленный текст" }),
  ).toBeVisible();
  expect(state.sends).toEqual([]);
  await expect(composer(page)).toHaveClass(/ym-disable-keys/);
  await expect(composer(page)).toHaveClass(/ym-hide-content/);
  await composer(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("recovered-draft.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Удалить черновик", exact: true })
    .click();
  await expect(composer(page)).toHaveValue("");
  await page.reload();
  await expect(composer(page)).toHaveValue("");
  expect(state.sends).toEqual([]);
  await composer(page).fill("Теперь отправить");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(
    page.getByText("ПРОВЕРОЧНЫЙ_ОТВЕТ", { exact: true }),
  ).toBeVisible();
  expect(state.sends).toHaveLength(1);
  expect(state.sends[0]?.input).toMatchObject({
    text: "Теперь отправить",
    aiMode: "maximum",
  });
  await page.reload();
  await expect(composer(page)).toHaveValue("");
  expect(state.sends).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("draft restore never crosses authenticated owner after reload", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  await composer(page).fill("ЛИЧНЫЙ_ЧЕРНОВИК_101");
  state.owner = "102";
  await page.reload();
  await expect(composer(page)).toHaveValue("");
  await expect(
    page.getByText("ЛИЧНЫЙ_ЧЕРНОВИК_101", { exact: true }),
  ).toHaveCount(0);
  expect(state.sends).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("a conversation closed during refresh removes its draft even when the selected ID is unchanged", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  await composer(page).fill("Черновик закрытого разговора");
  state.closed = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("Это завершённый разговор.", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("citygo:chat-draft:v1:101:20"),
    ),
  ).toBeNull();
  expect(state.sends).toEqual([]);
});

test("confirmed answer followed by a failed refresh never restores a paid question as unsent", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  state.failRefresh = true;
  await composer(page).fill("Уже подтверждённый вопрос");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Synthetic refresh failure" }),
  ).toBeVisible();
  await expect(composer(page)).toHaveValue("");
  state.failRefresh = false;
  await page.reload();
  await expect(composer(page)).toHaveValue("");
  expect(state.sends).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
});

test("failed send before a response preserves the draft but never retries it after reload", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  state.failStream = true;
  await composer(page).fill("Вопрос при недоступной связи");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Synthetic send failure" }),
  ).toBeVisible();
  await expect(composer(page)).toHaveValue("Вопрос при недоступной связи");
  await page.reload();
  await expect(composer(page)).toHaveValue("Вопрос при недоступной связи");
  expect(state.sends).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
});
