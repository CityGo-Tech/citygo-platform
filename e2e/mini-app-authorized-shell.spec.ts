import { expect, test, type Page } from "@playwright/test";
import type { Dashboard, Message, PersonalPlanItem } from "@citygo/contracts";
import { syntheticProduct } from "./marketing-landing-fixture";

const hosts = [
  {
    provider: "telegram",
    name: "Telegram",
    fragment: "tgWebAppData",
    script: "https://telegram.org/js/telegram-web-app.js?65",
  },
  {
    provider: "max",
    name: "MAX",
    fragment: "WebAppData",
    script: "https://st.max.ru/js/max-web-app.js",
  },
] as const;
type Host = (typeof hosts)[number];

const user = {
  id: "101",
  email: "workspace@example.test",
  role: "user",
} as const;
const timestamp = "2026-11-01T09:00:00Z";
const step: PersonalPlanItem = {
  id: "301",
  title: "Уточнить маршрут до офиса",
  details: "Сохранённый шаг из плана пользователя.",
  status: "pending",
  revision: 1,
  source: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const savedReply: Message = {
  id: "303",
  role: "assistant",
  agentKey: "housing",
  status: "complete",
  content: "Сохранённый ответ о дороге из района до офиса.",
};
const savedThread = {
  id: "21",
  agentKey: "housing",
  assistantKey: "housing",
  closed: false,
} as const;

const nav = (page: Page) =>
  page.getByRole("navigation", { name: "Личный кабинет CityGo" });
const tab = (page: Page, name: string) =>
  nav(page).getByRole("button", { name, exact: true });
const heading = (page: Page, name: string) =>
  page.getByRole("heading", { level: 1, name, exact: true });

type HostState = { back: (() => void) | null; closed: number };

async function hostState(page: Page) {
  return page.evaluate(() => {
    const { back, closed } = (window as Window & { hostFixture: HostState })
      .hostFixture;
    return { backActive: typeof back === "function", closed };
  });
}

async function pressNativeBack(page: Page) {
  await expect.poll(async () => (await hostState(page)).backActive).toBe(true);
  await page.evaluate(() => {
    (window as Window & { hostFixture: HostState }).hostFixture.back!();
  });
}

async function signIn(page: Page, host: Host, task?: "coordinator") {
  const state = await syntheticProduct(page);
  const initData = `synthetic-${host.provider}-workspace-proof`;
  const writes: string[] = [];
  const dashboard: Dashboard = {
    user,
    profile: {
      originCity: "Казань",
      targetCity: "Тула",
      monthlyBudget: 45_000,
      moveTargetDate: "2099-01-01",
      household: "solo",
      aiConsent: true,
    },
    quests: [],
    xp: 27,
    thread: null,
    provider: "routerai",
    aiAccess: {
      policy: null,
      granted: true,
      dailyLimit: 10,
      credit: {
        currency: "RUB",
        bonusGranted: true,
        grantedMicros: 500_000_000,
        availableMicros: 123_000_000,
        heldMicros: 0,
        spentMicros: 377_000_000,
        billingPolicy: "postpay_actual_v1",
        chargingStatus: "routerai_citygo_10x",
        topUpAvailable: true,
        history: [],
      },
    },
  };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path.startsWith("/api/v1/"))
      writes.push(path);
  });
  await page.route("**/api/v1/dashboard", (route) =>
    state.authenticated ? route.fulfill({ json: dashboard }) : route.fallback(),
  );
  const reads = {
    "account/profile": {
      userId: user.id,
      email: user.email,
      emailVerified: true,
      phoneVerified: true,
      giftStatus: "claimed",
      emailConfirmation: "available",
    },
    "account/messenger-links": { providers: [host.provider] },
    "personal-plan/summary": {
      userId: user.id,
      total: 1,
      pending: 1,
      completed: 0,
    },
    "personal-plan": { userId: user.id, items: [step], nextBefore: null },
    "messages/favorites": { userId: user.id, messages: [], nextBefore: null },
    conversations: {
      userId: user.id,
      conversations: [
        { ...savedThread, preview: savedReply.content, updatedAt: timestamp },
      ],
      nextCursor: null,
    },
    [`conversations/${savedThread.id}`]: {
      userId: user.id,
      thread: { ...savedThread, messages: [savedReply] },
    },
  };
  for (const [path, json] of Object.entries(reads)) {
    await page.route(new RegExp(`/api/v1/${path}(?:\\?|$)`), (route) =>
      state.authenticated && route.request().method() === "GET"
        ? route.fulfill({ json })
        : route.fallback(),
    );
  }
  const signInPath = `/api/v1/mini-apps/${host.provider}/sign-in`;
  await page.route(`**${signInPath}`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ initData });
    state.authenticated = true;
    return route.fulfill({
      json: {
        user: { id: user.id, email: user.email },
        purpose: task ?? "guest",
      },
    });
  });
  await page.route(host.script, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        window.hostFixture = { back: null, closed: 0 };
        const fixture = window.hostFixture;
        const sdk = {
          initData: ${JSON.stringify(initData)},
          initDataUnsafe: { start_param: ${JSON.stringify(task ?? "")} },
          BackButton: {
            show() {},
            hide() {},
            onClick(listener) { fixture.back = listener; },
            offClick(listener) { if (fixture.back === listener) fixture.back = null; },
          },
          close() { fixture.closed++; },
          openLink() { throw new Error("Unexpected external handoff"); },
        };
        ${host.provider === "telegram" ? "window.Telegram = { WebApp: sdk };" : "window.WebApp = sdk;"}
      `,
    }),
  );
  await page.goto(`/mini/${host.provider}#${host.fragment}=${initData}`);
  await expect(page).toHaveURL(new RegExp(`/mini/${host.provider}$`));
  await page
    .getByRole("button", {
      name: task ? "Продолжить в CityGo" : "Войти в CityGo",
    })
    .click();
  await page.getByRole("button", { name: `Войти через ${host.name}` }).click();
  await expect(nav(page)).toBeVisible();
  return { state, writes, signInPath };
}

for (const host of hosts) {
  test(`${host.name} signed-in navigation shows the account plan, results, dialogs, catalog and profile`, async ({
    page,
  }) => {
    const { state, writes, signInPath } = await signIn(page, host);
    await expect(nav(page).getByRole("button")).toHaveText([
      "План",
      "Диалоги",
      "Помощники",
      "Профиль",
    ]);
    await expect(tab(page, "План")).toHaveAttribute("aria-pressed", "true");
    await expect(heading(page, "Мой план")).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Мой план переезда" })
        .getByText("Ваш переезд: Тула"),
    ).toBeVisible();
    await expect(page.getByText(step.title, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /^Результаты/ }).click();
    await expect(heading(page, "Полезное из разговоров")).toBeVisible();
    await expect(page.getByText(step.title, { exact: true })).toBeVisible();
    await expect(tab(page, "План")).toHaveAttribute("aria-pressed", "true");
    await pressNativeBack(page);
    await expect(heading(page, "Мой план")).toBeVisible();

    await tab(page, "Диалоги").click();
    await expect(heading(page, "Диалоги")).toBeVisible();
    await page
      .getByRole("button", { name: "Открыть разговор: Помощник по жилью" })
      .click();
    await expect(heading(page, "Помощник по жилью")).toBeVisible();
    await expect(
      page.getByText(savedReply.content, { exact: true }),
    ).toBeVisible();
    await pressNativeBack(page);
    await expect(heading(page, "Диалоги")).toBeVisible();

    await tab(page, "Помощники").click();
    await expect(heading(page, "Помощники")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Помощник по жилью", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Помощник по работе", exact: true }),
    ).toBeVisible();
    await expect(heading(page, "Диалоги")).toHaveCount(0);

    await tab(page, "Профиль").click();
    await expect(heading(page, "Профиль")).toBeVisible();
    await expect(page.getByText(user.email, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "123 ₽", exact: true }),
    ).toBeVisible();
    const giftStatus = page.getByText("Подарок 500 ₽ CityGo уже начислен.");
    if (host.provider === "telegram") {
      await expect(giftStatus).toBeVisible();
    } else {
      await expect(giftStatus).toHaveCount(0);
    }
    await expect(
      page.getByRole("button", { name: "Чеки", exact: true }),
    ).toBeVisible();

    const close = page.getByRole("button", { name: `Закрыть в ${host.name}` });
    if (host.provider === "telegram") {
      await close.click();
      expect((await hostState(page)).closed).toBe(1);
    } else {
      await expect(close).toHaveCount(0);
    }
    expect(writes).toEqual([signInPath]);
    expect(state.outside).toEqual([]);
  });
}

test("Telegram honors safe insets and keeps the composer usable at 320px with large text and a reduced keyboard viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 680 });
  const { state, writes, signInPath } = await signIn(
    page,
    hosts[0],
    "coordinator",
  );
  await expect(heading(page, "Координатор переезда")).toBeVisible();
  expect(state.starts).toEqual(["support"]);
  await page.addStyleTag({
    content: `html {
      font-size: 200%;
      --tg-safe-area-inset-top: 25px;
      --tg-content-safe-area-inset-top: 36px;
      --tg-content-safe-area-inset-bottom: 32px;
      --tg-content-safe-area-inset-left: 18px;
      --tg-content-safe-area-inset-right: 14px;
    }`,
  });
  const bar = page.getByRole("banner", { name: "CityGo в Telegram" });
  await expect(bar).toHaveCSS("padding-top", "36px");
  await expect(nav(page)).toHaveCSS("padding-bottom", "32px");

  const composer = page.getByRole("textbox", { name: "Сообщение помощнику" });
  await composer.fill("Черновик для проверки клавиатуры");
  await page.setViewportSize({ width: 320, height: 375 });
  await expect(page.locator('[data-host="Telegram"]')).toHaveAttribute(
    "data-mini-keyboard",
    "open",
  );
  await expect(nav(page)).toBeHidden();
  await expect(composer).toBeFocused();
  await expect(composer).toBeInViewport({ ratio: 0.9 });
  await expect(composer).toHaveValue("Черновик для проверки клавиатуры");

  await page.setViewportSize({ width: 320, height: 680 });
  await expect(nav(page)).toBeVisible();
  await tab(page, "Профиль").click();
  await expect(heading(page, "Профиль")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Выйти", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  expect(writes).toEqual([signInPath, "/api/v1/conversations/start"]);
  expect(state.outside).toEqual([]);
});

test("an ordinary browser keeps CityGo's web navigation when opening from a mini-app URL", async ({
  page,
}) => {
  const state = await syntheticProduct(page);
  state.authenticated = true;
  await page.goto("/mini/telegram");
  await expect(heading(page, "С чего начнём?")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Закрыть в Telegram" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Войти в CityGo" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(nav(page)).toBeVisible();
  await expect(tab(page, "Мой план")).toBeVisible();
  await expect(tab(page, "Мой план")).toBeVisible();
  await tab(page, "Помощники").click();
  await expect(heading(page, "Ваша команда AI-помощников")).toBeVisible();
  await expect(page.locator(".mini-app-tabs")).toHaveCount(0);
  expect(state.outside).toEqual([]);
});
