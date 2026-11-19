import { expect, test, type Page } from "@playwright/test";
import { syntheticProduct } from "./marketing-landing-fixture";

const maxSdk = "https://st.max.ru/js/max-web-app.js";
const privateLaunchValue = "synthetic-max-identity-canary";

type BridgeFixture = {
  events: string[];
  external: string[];
  goBack: (() => void) | null;
};

async function configureMaxPage(
  page: Page,
  sdk: "coordinator" | "unavailable" | "broken",
) {
  const calls = {
    sdk: 0,
    unexpectedExternal: [] as string[],
    api: [] as string[],
    handoffs: [] as string[],
  };
  await page.context().route("https://**", (route) => {
    calls.unexpectedExternal.push(route.request().url());
    return route.abort();
  });
  await page.context().route("**/api/**", (route) => {
    calls.api.push(route.request().url());
    return route.abort();
  });
  await page.context().route("**/landing/start?**", (route) => {
    calls.handoffs.push(route.request().url());
    return route.fulfill({ body: "CityGo", contentType: "text/html" });
  });
  await page.context().route(maxSdk, (route) => {
    calls.sdk++;
    if (sdk === "unavailable") return route.abort();
    return route.fulfill({
      contentType: "application/javascript",
      body: `
        window.maxFixture = { events: [], external: [], goBack: null };
        const state = window.maxFixture;
        window.WebApp = {
          get initDataUnsafe() {
            if (${sdk === "broken"}) throw new Error('Bridge data unavailable');
            return {
              start_param: "coordinator",
              user: { first_name: ${JSON.stringify(privateLaunchValue)} },
            };
          },
          BackButton: {
            show() { state.events.push('show'); },
            hide() { state.events.push('hide'); },
            onClick(listener) { state.goBack = listener; },
            offClick(listener) {
              state.events.push('offClick');
              if (state.goBack === listener) state.goBack = null;
            },
          },
          openLink(url) { state.external.push(url); },
        };
      `,
    });
  });
  return calls;
}

async function bridgeCalls(page: Page) {
  return page.evaluate(() => {
    const { events, external, goBack } = (
      window as Window & { maxFixture: BridgeFixture }
    ).maxFixture;
    return { events, external, hasBackListener: typeof goBack === "function" };
  });
}

function expectHandoff(href: string, task?: "coordinator" | "housing") {
  const url = new URL(href);
  expect(url.origin).toBe("http://localhost:3000");
  expect(url.pathname).toBe("/landing/start");
  expect(url.hash).toBe("");
  expect([...url.searchParams].sort()).toEqual(
    task
      ? [
          ["intent", "register"],
          ["task", task],
        ]
      : [["intent", "login"]],
  );
  expect(url.href).not.toContain(privateLaunchValue);
}

test("MAX browser preview skips the bridge and continues to ordinary CityGo login", async ({
  page,
}) => {
  const calls = await configureMaxPage(page, "unavailable");
  await page.goto(`/mini/max?WebAppData=${privateLaunchValue}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "С чего начнём?" }),
  ).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("MAX");
  await page.getByRole("button", { name: "Войти в CityGo" }).click();
  await expect(page).toHaveURL(/\/landing\/start\?intent=login$/);
  expectCityGoRequests(calls, { sdk: 0, handoffs: 1 });
  expectHandoff(calls.handoffs[0]!);
});

test("MAX browser uses the real housing handoff without guest side effects", async ({
  page,
}) => {
  const state = await syntheticProduct(page);
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/"))
      apiRequests.push(`${request.method()} ${path}`);
  });
  await page.addInitScript(() =>
    localStorage.setItem("citygo.analytics.optout", "1"),
  );
  const preview = await page.goto(`/mini/max?user=${privateLaunchValue}`);
  expect(await preview?.headerValue("referrer-policy")).toBe("no-referrer");
  await page.getByRole("button", { name: /Найти жильё/ }).click();
  await page.getByLabel("Куда ездить").fill(privateLaunchValue);
  await page.getByLabel("Бюджет в месяц, ₽").fill("75000");
  await page.getByRole("button", { name: "Собрать стартовый план" }).click();
  await expect(
    page.getByRole("heading", { name: "Стартовый план", exact: true }),
  ).toBeVisible();
  expect(apiRequests).toEqual([]);
  expect(state.outside).toEqual([]);

  const redirect = page.waitForResponse(
    (response) =>
      response.request().isNavigationRequest() &&
      new URL(response.url()).pathname === "/landing/start",
  );
  await page.getByRole("button", { name: "Продолжить в CityGo" }).click();
  const response = await redirect;
  expectHandoff(response.url(), "housing");
  expect(response.status()).toBe(303);
  expect(await response.headerValue("location")).toBe("/#citygo-start-housing");
  expect(await response.headerValue("referrer-policy")).toBe("no-referrer");
  expect(await response.request().headerValue("referer")).toBeNull();
  await expect(page).toHaveURL("http://localhost:3000/");
  await expect(page.locator("input[name=personalDataConsent]")).toBeVisible();
  const signedOutReads = new Set([
    "GET /api/v1/dashboard",
    "GET /api/v1/auth/registration-policy",
  ]);
  expect(apiRequests.filter((request) => !signedOutReads.has(request))).toEqual(
    [],
  );
  expect(state.outside).toEqual([]);
});

test("MAX launch preselects only the task, handles native Back and hands off upon explicit action", async ({
  page,
}) => {
  const calls = await configureMaxPage(page, "coordinator");
  await page.goto(`/mini/max#WebAppData=${privateLaunchValue}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Оценить переезд" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(privateLaunchValue);
  await expect
    .poll(async () => bridgeCalls(page))
    .toMatchObject({
      events: expect.arrayContaining(["show"]),
      hasBackListener: true,
      external: [],
    });

  await page.evaluate(() => {
    (window as Window & { maxFixture: BridgeFixture }).maxFixture.goBack?.();
  });
  await expect(
    page.getByRole("heading", { level: 1, name: "С чего начнём?" }),
  ).toBeVisible();
  await expect
    .poll(async () => bridgeCalls(page))
    .toMatchObject({
      events: expect.arrayContaining(["offClick", "hide"]),
      hasBackListener: false,
      external: [],
    });

  await page.getByRole("button", { name: /Оценить переезд/ }).click();
  await page.getByRole("button", { name: "Продолжить в CityGo" }).click();
  const { external } = await bridgeCalls(page);
  expect(external).toHaveLength(1);
  expectHandoff(external[0]!, "coordinator");
  await expect(page).toHaveURL(/\/mini\/max/);
  expectCityGoRequests(calls, { sdk: 1, handoffs: 0 });
});

test("MAX bridge failure keeps the mini-app usable and prevents silent handoff", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  const calls = await configureMaxPage(page, "unavailable");
  await checkFailedBridge(page);
  expect(pageErrors).toEqual([]);
  expectCityGoRequests(calls, { sdk: 1, handoffs: 0 });
});

test("MAX handles a loaded bridge that fails during initialization", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  const calls = await configureMaxPage(page, "broken");
  await checkFailedBridge(page);
  expect(await bridgeCalls(page)).toEqual({
    events: [],
    external: [],
    hasBackListener: false,
  });
  expect(pageErrors).toEqual([]);
  expectCityGoRequests(calls, { sdk: 1, handoffs: 0 });
});

async function checkFailedBridge(page: Page) {
  await page.goto(`/mini/max#WebAppData=${privateLaunchValue}`);
  const status = page.getByRole("status");
  await expect(status).toContainText("Откройте CityGo из бота ещё раз");
  await page.getByRole("button", { name: /Оценить переезд/ }).click();
  await expect(
    page.getByRole("heading", { name: "Оценить переезд" }),
  ).toBeVisible();
  await expect(status).toContainText("Откройте CityGo из бота ещё раз");
  await page.getByRole("button", { name: "Продолжить в CityGo" }).click();
  await expect(page).toHaveURL(/\/mini\/max/);
}

function expectCityGoRequests(
  calls: Awaited<ReturnType<typeof configureMaxPage>>,
  expected: { sdk: number; handoffs: number },
) {
  expect(calls.unexpectedExternal).toEqual([]);
  expect(calls.api).toEqual([]);
  expect(calls.sdk).toBe(expected.sdk);
  expect(calls.handoffs).toHaveLength(expected.handoffs);
}
