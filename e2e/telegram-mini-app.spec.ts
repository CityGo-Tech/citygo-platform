import { expect, test, type Page } from "@playwright/test";
import {
  submitRegistration,
  syntheticProduct,
} from "./marketing-landing-fixture";

const telegramSdk = /^https:\/\/telegram\.org\/js\/telegram-web-app\.js\?65$/;
const launchCanary = "mini-launch-private-canary";

async function installPreviewRoutes(
  page: Page,
  startParam?: string,
  brokenBack = false,
) {
  const calls = { external: [] as string[], api: [] as string[], sdk: 0 };
  await page.context().route("https://**", (route) => {
    calls.external.push(route.request().url());
    return route.abort();
  });
  await page.context().route("**/api/**", (route) => {
    calls.api.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort();
  });
  await page.context().route(telegramSdk, (route) => {
    calls.sdk++;
    if (startParam === undefined) return route.abort();
    return route.fulfill({
      contentType: "application/javascript",
      body: `
        window.telegramFixture = { events: [], links: [], goBack: null };
        const state = window.telegramFixture;
        window.Telegram = { WebApp: {
          initData: ${JSON.stringify(launchCanary)},
          initDataUnsafe: {
            start_param: ${JSON.stringify(startParam)},
            user: { first_name: ${JSON.stringify(launchCanary)} },
          },
          ready() { state.events.push('ready'); },
          BackButton: {
            show() {
              state.events.push('show');
              if (${brokenBack}) throw new Error('Back unavailable');
            },
            hide() { state.events.push('hide'); },
            onClick(handler) {
              state.events.push('onClick');
              state.goBack = handler;
            },
            offClick(handler) {
              state.events.push('offClick');
              if (state.goBack === handler) state.goBack = null;
            },
          },
          openLink(url) { state.links.push(url); },
        } };
      `,
    });
  });
  return calls;
}

type TelegramFixture = {
  events: string[];
  links: string[];
  goBack: (() => void) | null;
};

async function fixtureCalls(page: Page) {
  return page.evaluate(() => {
    const { events, links, goBack } = (
      window as Window & { telegramFixture: TelegramFixture }
    ).telegramFixture;
    return { events, links, hasBackListener: typeof goBack === "function" };
  });
}

function expectCityGoHandoff(href: string, task: "housing" | "coordinator") {
  const url = new URL(href, "http://localhost:3000");
  expect(url.origin).toBe("http://localhost:3000");
  expect(url.pathname).toBe("/landing/start");
  expect([...url.searchParams].sort()).toEqual([
    ["intent", "register"],
    ["task", task],
  ]);
  expect(url.hash).toBe("");
  expect(url.href).not.toContain(launchCanary);
}

test("Telegram browser preview builds a housing plan and hands off only the selected task", async ({
  page,
}) => {
  const calls = await installPreviewRoutes(page);
  await page.goto(`/mini/telegram?user=${launchCanary}&task=coordinator`);
  await expect(
    page.getByRole("heading", { level: 1, name: "С чего начнём?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Найти жильё/ }).click();
  await page.getByLabel("Куда ездить").fill("Кутузовский проспект");
  await page.getByLabel("Бюджет в месяц, ₽").fill("70000");
  await page.getByRole("button", { name: "Собрать стартовый план" }).click();

  await expect(
    page.getByRole("heading", { name: "Стартовый план" }),
  ).toBeVisible();
  await expect(page.getByText(/Кутузовский проспект/).first()).toBeVisible();
  await expect(page.getByText(/70\s?000/).first()).toBeVisible();
  const next = page.getByRole("button", { name: "Продолжить в CityGo" });
  await page.route("**/landing/start?**", (route) =>
    route.fulfill({ contentType: "text/html", body: "CityGo" }),
  );
  await next.click();
  await expect(page).toHaveURL(/\/landing\/start\?/);
  expectCityGoHandoff(page.url(), "housing");
  expect(calls).toEqual({ external: [], api: [], sdk: 0 });
});

test("Telegram housing handoff uses the real redirect and resumes the task after email confirmation", async ({
  page,
}) => {
  const state = await syntheticProduct(page);
  await page.addInitScript(() =>
    localStorage.setItem("citygo.analytics.optout", "1"),
  );
  await page.goto("/mini/telegram");
  await page.getByRole("button", { name: /Найти жильё/ }).click();
  await page.getByLabel("Куда ездить").fill(launchCanary);
  await page.getByRole("button", { name: "Собрать стартовый план" }).click();
  expect(state.dashboardReads).toBe(0);

  const redirect = page.waitForResponse(
    (response) =>
      response.request().isNavigationRequest() &&
      new URL(response.url()).pathname === "/landing/start",
  );
  await page.getByRole("button", { name: "Продолжить в CityGo" }).click();
  const response = await redirect;
  expectCityGoHandoff(response.url(), "housing");
  expect(response.status()).toBe(303);
  expect(await response.headerValue("location")).toBe("/#citygo-start-housing");
  expect(await response.headerValue("referrer-policy")).toBe("no-referrer");
  await expect(page).toHaveURL("http://localhost:3000/");

  await submitRegistration(page);
  expect(state.begin).toHaveLength(1);
  expect(state.begin[0]).not.toHaveProperty("task");
  expect(state.begin[0]).not.toHaveProperty("landingAttribution");
  expect(JSON.stringify(state.begin[0])).not.toContain(launchCanary);
  expect(state.starts).toEqual([]);

  await page.getByLabel("Код из письма", { exact: true }).fill("654321");
  await page
    .getByRole("button", { name: "Подтвердить email", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Помощник по жилью" }),
  ).toBeVisible();
  expect(state.confirm).toBe(1);
  expect(state.starts).toEqual(["housing"]);
  expect(state.chatPosts).toBe(0);
  expect(state.outside).toEqual([]);
});

test("Telegram can start a housing plan without criteria and fits a narrow viewport", async ({
  page,
}) => {
  const calls = await installPreviewRoutes(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/mini/telegram");
  await page.getByRole("button", { name: /Найти жильё/ }).click();
  await page.getByRole("button", { name: "Собрать стартовый план" }).click();
  await expect(
    page.getByRole("heading", { name: "Стартовый план" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Продолжить в CityGo" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  expect(calls).toEqual({ external: [], api: [], sdk: 0 });
});

test("Telegram native launch uses only its task, responds to Back and opens the handoff explicitly", async ({
  page,
}) => {
  const calls = await installPreviewRoutes(page, "housing");
  await page.goto(
    `/mini/telegram?user=${launchCanary}#tgWebAppData=${encodeURIComponent(launchCanary)}`,
  );
  await expect(page.getByLabel("Куда ездить")).toBeVisible();
  await expect
    .poll(async () => (await fixtureCalls(page)).events)
    .toContain("ready");
  await expect
    .poll(async () => (await fixtureCalls(page)).events)
    .toContain("show");
  expect((await fixtureCalls(page)).links).toEqual([]);
  await page.evaluate(() => {
    (
      window as Window & { telegramFixture: TelegramFixture }
    ).telegramFixture.goBack?.();
  });
  await expect(
    page.getByRole("heading", { level: 1, name: "С чего начнём?" }),
  ).toBeVisible();
  await expect
    .poll(async () => fixtureCalls(page))
    .toMatchObject({
      events: expect.arrayContaining(["offClick", "hide"]),
      hasBackListener: false,
    });
  await page.getByRole("button", { name: /Оценить переезд/ }).click();
  await expect(
    page.getByRole("heading", { name: "Оценить переезд" }),
  ).toBeVisible();
  await page.getByText("Продолжить в CityGo", { exact: true }).click();
  const { links } = await fixtureCalls(page);
  expect(links).toHaveLength(1);
  expectCityGoHandoff(links[0]!, "coordinator");
  await expect(page).toHaveURL(/\/mini\/telegram/);
  expect(calls).toEqual({ external: [], api: [], sdk: 1 });
});

test("Telegram keeps in-page Back available when the native SDK throws", async ({
  page,
}) => {
  await installPreviewRoutes(page, "housing", true);
  await page.goto(`/mini/telegram#tgWebAppData=${launchCanary}`);
  await expect(page.getByLabel("Куда ездить")).toBeVisible();
  await expect
    .poll(async () => fixtureCalls(page))
    .toMatchObject({
      events: expect.arrayContaining(["show", "offClick", "hide"]),
      hasBackListener: false,
    });
  await page.getByRole("button", { name: "Назад", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "С чего начнём?" }),
  ).toBeVisible();
});

test("Telegram rejects an empty or repeated launch marker before loading SDK", async ({
  page,
}) => {
  const calls = await installPreviewRoutes(page, "housing");
  for (const fragment of ["#tgWebAppData=", "#tgWebAppData=a&tgWebAppData=b"]) {
    await page.goto("/mini/telegram" + fragment);
    await expect(page.getByRole("status")).toContainText(
      "Откройте CityGo из бота ещё раз",
    );
    await page.getByRole("button", { name: "Войти в CityGo" }).click();
    await expect(page).toHaveURL(/\/mini\/telegram#/);
    expect(calls).toEqual({ external: [], api: [], sdk: 0 });
    await page.goto("about:blank");
  }
});

test("Telegram ignores any native start parameter outside the task allowlist", async ({
  page,
}) => {
  const calls = await installPreviewRoutes(
    page,
    `https://invalid.example/${launchCanary}`,
  );
  await page.goto(`/mini/telegram#tgWebAppData=${launchCanary}`);
  await expect
    .poll(async () => (await fixtureCalls(page)).events)
    .toContain("ready");
  await expect(
    page.getByRole("heading", { level: 1, name: "С чего начнём?" }),
  ).toBeVisible();
  expect((await fixtureCalls(page)).links).toEqual([]);
  expect(await page.locator("main").textContent()).not.toContain(launchCanary);
  expect(calls).toEqual({ external: [], api: [], sdk: 1 });
});
