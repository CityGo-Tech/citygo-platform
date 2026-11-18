import { expect, test, type Page } from "@playwright/test";

const telegramSdk = /^https:\/\/telegram\.org\/js\/telegram-web-app\.js\?65$/;
const launchCanary = "mini-launch-private-canary";

async function installPreviewRoutes(page: Page, startParam?: string) {
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
            show() { state.events.push('show'); },
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
