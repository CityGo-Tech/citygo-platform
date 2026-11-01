import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Dashboard, Message } from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
import { clickWalletAction, openAccountMenu } from "./navigation-helper";

const owner = "101";
const favoriteQuestion = "Какие документы подготовить для переезда?";
const favoriteAnswer = "Составьте свой список документов и проверьте сроки.";
const favoriteMessages: Message[] = [
  {
    id: "201",
    role: "user",
    agentKey: "support",
    status: "complete",
    content: favoriteQuestion,
    favorite: true,
  },
  {
    id: "202",
    role: "assistant",
    agentKey: "support",
    status: "complete",
    content: favoriteAnswer,
  },
];

/** Every account and response is fictional; all external and mutation calls fail. */
async function install(context: BrowserContext) {
  const thread = (id: string): NonNullable<Dashboard["thread"]> => ({
    id,
    agentKey: "support",
    assistantKey: "support",
    closed: false,
    messages:
      id === "21"
        ? favoriteMessages
        : [
            {
              id: "100",
              role: "user",
              agentKey: "support",
              status: "complete",
              content: "С чего начать переезд?",
            },
            {
              id: "101",
              role: "assistant",
              agentKey: "support",
              status: "complete",
              content: "Начните с небольшого плана.",
            },
          ],
  });
  const board: Dashboard = {
    user: {
      id: owner,
      email: "navigation-owner@example.test",
      role: "user",
      mustChangePassword: false,
      serviceConsentRequired: false,
    },
    profile: {
      originCity: "Казань",
      targetCity: "Москва",
      monthlyBudget: 65000,
      moveTargetDate: "2099-01-01",
      household: "couple",
      aiConsent: true,
    },
    quests: [
      {
        id: "housing-first",
        slug: "housing-search",
        title: "Составить план поиска жилья",
        state: "in_progress",
        xpReward: 60,
      },
      {
        id: "housing-next",
        slug: "housing-viewing",
        title: "Подготовиться к просмотру квартиры",
        state: "locked",
        xpReward: 60,
      },
    ],
    xp: 0,
    provider: "routerai",
    thread: thread("20"),
    aiAccess: {
      granted: true,
      dailyLimit: 100,
      policy: {
        id: "a".repeat(64),
        version: "synthetic-navigation-v1",
        provider: "routerai",
        model: "synthetic/no-transport",
        recipient: "Synthetic",
        routing: "No external transport",
        data: "Fictional content",
      },
      modes: {
        catalogId: "b".repeat(64),
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
          },
        ],
      },
      credit: {
        currency: "RUB",
        bonusGranted: true,
        grantedMicros: 500_000_000,
        availableMicros: 477_000_000,
        spentMicros: 23_000_000,
        heldMicros: 0,
        chargingStatus: "routerai_citygo_10x",
        reservationMode: "fixed5_overdraft",
        minimumRequestBalanceMicros: 5_000_000,
        outstandingDebtMicros: 0,
        topUpAvailable: true,
        history: [],
      },
    },
  };
  const state = {
    board,
    writes: [] as string[],
    unexpected: [] as string[],
    external: [] as string[],
  };
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== "http://localhost:3000") {
      state.external.push(url.origin);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (await fulfillProductAnalytics(route)) return;
    const path = url.pathname,
      method = request.method();
    if (method !== "GET") {
      state.writes.push(method + " " + path);
      return route.fulfill({
        status: 405,
        json: { error: "Synthetic navigation is read-only" },
      });
    }
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "required",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/dashboard")
      return route.fulfill({ json: state.board });
    if (path === "/api/v1/account/profile")
      return route.fulfill({
        json: {
          userId: owner,
          email: state.board.user.email,
          emailVerified: true,
          phoneVerified: true,
          giftStatus: "claimed",
          emailConfirmation: "available",
        },
      });
    if (path === "/api/v1/support-requests")
      return route.fulfill({
        json: { userId: owner, requests: [], nextBefore: null },
      });
    if (path === "/api/v1/messages/favorites")
      return route.fulfill({
        json: {
          userId: owner,
          messages: [{ ...favoriteMessages[0]!, threadId: "21" }],
          nextBefore: null,
        },
      });
    if (path === "/api/v1/conversations/21/messages/201/context")
      return route.fulfill({
        json: {
          userId: owner,
          threadId: "21",
          messages: [favoriteMessages[0]!],
          nextCursor: null,
        },
      });
    if (
      path === "/api/v1/conversations/20" ||
      path === "/api/v1/conversations/21"
    )
      return route.fulfill({
        json: {
          userId: owner,
          thread: thread(path.endsWith("21") ? "21" : "20"),
        },
      });
    state.unexpected.push(method + " " + path);
    return route.fulfill({
      status: 501,
      json: { error: "Unexpected synthetic navigation request" },
    });
  });
  return state;
}

function navigation(page: Page) {
  return page.getByRole("navigation", {
    name: "Личный кабинет CityGo",
    exact: true,
  });
}

test("external workspace intents are consumed before a favourite opens a conversation", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await install(context);
  await page.goto("/");
  await expect(
    page.getByRole("textbox", { name: "Сообщение помощнику", exact: true }),
  ).toBeEnabled();
  for (const target of ["Помощники", "Помощь человека"] as const) {
    await clickWalletAction(page, "Пополнить баланс");
    await expect(
      page.getByRole("region", { name: "Баланс и пополнение", exact: true }),
    ).toBeVisible();
    if (target === "Помощники") {
      await page
        .locator(".conversation-context:visible")
        .getByRole("button", { name: "Сменить помощника", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Каталог помощников", exact: true }),
      ).toBeVisible();
    } else {
      await page
        .locator(".conversation-topics:visible")
        .getByRole("button", { name: "Помощь человека", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Можно обратиться к человеку",
          exact: true,
        }),
      ).toBeVisible();
    }
    await navigation(page)
      .getByRole("button", { name: "Профиль", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Личный кабинет", exact: true })
      .getByRole("button", { name: "Избранные сообщения", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Открыть в диалоге", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Открыть весь диалог", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Сообщение помощнику", exact: true }),
    ).toBeEnabled();
    await expect(
      navigation(page).getByRole("button", { name: "Диалоги", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const log = page.getByRole("log", {
      name: "История диалога",
      exact: true,
    });
    await expect(log).toContainText(favoriteQuestion);
    await expect(log).toContainText(favoriteAnswer);
    await expect(
      page.getByRole("region", { name: "Каталог помощников", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: "Можно обратиться к человеку",
        exact: true,
      }),
    ).toHaveCount(0);
  }
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toEqual([]);
});

test("the legacy map is offered only when the selected thread supports it", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await install(context);
  await page.goto("/");
  await expect(navigation(page)).toBeVisible();
  await openAccountMenu(page);
  await expect(
    page
      .locator("details.account-menu")
      .getByRole("button", { name: "Карта пути", exact: true }),
  ).toHaveCount(0);
  delete state.board.thread!.assistantKey;
  state.board.thread!.agentKey = "housing";
  await page.reload();
  await openAccountMenu(page);
  await page
    .locator("details.account-menu")
    .getByRole("button", { name: "Карта пути", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", {
      name: "Навигация по переезду",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ваш план переезда", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toEqual([]);
});
