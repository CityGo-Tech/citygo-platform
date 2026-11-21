import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { HousingWorkspace } from "@citygo/contracts";

const demoUrl = "/?housingCatalogDemo=1";
const workspaceUrl = "/api/v1/housing/workspace";
const originalsPath = "/housing-catalog-demo/";
const nearMetro = "Квартира у метро";
const cheapEnough = 60_000;
const hiddenTitles = [
  "Снятое объявление",
  "Устаревшее объявление",
  "Квартира в другом городе",
] as const;

function button(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}

async function readWorkspace(page: Page): Promise<HousingWorkspace> {
  const response = await page.request.get(workspaceUrl);
  expect(response.status()).toBe(200);
  return response.json();
}

async function observeBrowser(
  context: BrowserContext,
  info: TestInfo,
  scenario: number,
) {
  const origin = new URL(info.project.use.baseURL!).origin;
  const project = info.config.projects.findIndex(
    (candidate) => candidate.name === info.project.name,
  );
  const ip = "198.19.221." + (20 * project + 4 * info.retry + scenario);
  const headers = {
    Origin: origin,
    "X-Forwarded-For": ip,
    "X-CityGo-Contract-Version": "1",
  };
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": ip });
  const external: string[] = [];
  const originalRequests: string[] = [];
  const sideEffects: string[] = [];
  await context.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    external.push(url.origin);
    return route.abort();
  });
  context.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith(originalsPath)) originalRequests.push(path);
    if (
      request.method() !== "GET" &&
      (path.startsWith(workspaceUrl) ||
        /\/v1\/.*(?:chat|phone|topup|payment)/.test(path))
    )
      sideEffects.push(request.method() + " " + path);
  });
  return { headers, external, originalRequests, sideEffects };
}

async function saveSyntheticCriteria(
  page: Page,
  headers: Record<string, string>,
  budgetRub: number | null,
) {
  await page.goto(demoUrl);
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill("shortlist-" + crypto.randomUUID() + "@example.test");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("synthetic-housing-password");
  await page.locator("input[name=personalDataConsent]").check();
  await button(page, "Создать аккаунт").click();
  await expect(button(page, "Мой план")).toBeVisible();

  const started = await page.request.post("/api/v1/conversations/start", {
    headers,
    data: { agentKey: "housing" },
  });
  expect(started.status()).toBe(200);
  const { id: threadId } = await started.json();
  const criteria = {
    city: "Москва",
    situation: "oriented",
    commute: "Вымышленная точка для поездок",
    budgetRub,
  };
  const response = await page.request.put(workspaceUrl + "/plan", {
    headers,
    data: {
      expectedRevision: 0,
      requestId: crypto.randomUUID(),
      threadId,
      criteria,
    },
  });
  expect(response.status()).toBe(200);
  return { threadId, criteria };
}

async function openSavedPlan(page: Page) {
  await button(page, "Мой план").click();
  await page
    .getByRole("region", { name: "Мой план переезда", exact: true })
    .getByRole("button", { name: "Стартовый план поиска жилья", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Ваш стартовый план поиска",
      exact: true,
    }),
  ).toBeVisible();
}

async function openShortlist(page: Page) {
  await button(page, "Посмотреть короткий список").click();
  await expect(
    page.getByRole("heading", { name: "Короткий список жилья", exact: true }),
  ).toBeVisible();
  return page.getByRole("list", { name: "Варианты жилья", exact: true });
}

test("saved housing criteria yield one current original and a checklist handoff without writes", async ({
  page,
  context,
}, info) => {
  await page.setViewportSize({ width: 320, height: 780 });
  const observed = await observeBrowser(context, info, 1);
  await saveSyntheticCriteria(page, observed.headers, cheapEnough);
  const workspace = await readWorkspace(page);

  await openSavedPlan(page);
  const list = await openShortlist(page);
  const card = list.getByRole("listitem");
  await expect(card).toHaveCount(1);
  await expect(
    card.getByRole("heading", { name: nearMetro, exact: true }),
  ).toBeVisible();
  await expect(card).toContainText("Демонстрационная выгрузка");
  await expect(card).toContainText("Последний раз видели");
  await expect(card.locator("time")).toHaveAttribute(
    "datetime",
    "2026-11-21T08:30:00.000Z",
  );
  await expect(card).toContainText("В пределах бюджета");
  await expect(card).toContainText(/54[\s\u00a0\u202f]?000/u);
  await expect(card).not.toContainText(/маршрут совпал|совпало время поездок/u);
  expect(observed.originalRequests).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);

  const originalLink = card.getByRole("link", {
    name: "Открыть оригинал",
    exact: true,
  });
  const [original] = await Promise.all([
    page.waitForEvent("popup"),
    originalLink.click(),
  ]);
  try {
    await expect(original).toHaveURL(/\/housing-catalog-demo\/metro$/);
    await expect(
      original.getByRole("heading", { name: nearMetro, exact: true }),
    ).toBeVisible();
    await expect(
      original.getByText("Демонстрационный оригинал", { exact: true }),
    ).toBeVisible();
  } finally {
    await original.close();
  }
  expect(observed.originalRequests).toEqual([originalsPath + "metro"]);
  for (const id of ["withdrawn", "stale"]) {
    const retired = await page.request.get(originalsPath + id);
    expect(retired.status()).toBe(404);
  }
  const nonLocal = await page.request.get(originalsPath + "metro", {
    headers: { Host: "ship.example.test" },
  });
  expect(nonLocal.status()).toBe(404);

  await button(page, "Перейти к чек-листу").click();
  await expect(
    page.getByRole("heading", { name: "Чек-лист просмотра", exact: true }),
  ).toBeVisible();
  expect(await readWorkspace(page)).toEqual(workspace);
  expect(observed.sideEffects).toEqual([]);
  expect(observed.external).toEqual([]);
});

test("unknown budget keeps unpriced items explicit and a criteria revision invalidates the visible list", async ({
  page,
  context,
}, info) => {
  const observed = await observeBrowser(context, info, 2);
  const { threadId, criteria } = await saveSyntheticCriteria(
    page,
    observed.headers,
    null,
  );
  const workspace = await readWorkspace(page);

  await openSavedPlan(page);
  const list = await openShortlist(page);
  await expect(
    list.getByRole("heading", { name: nearMetro, exact: true }),
  ).toHaveCount(1);
  await expect(
    list.getByRole("heading", {
      name: "Квартира рядом с парком",
      exact: true,
    }),
  ).toBeVisible();
  const unpriced = list.getByRole("listitem").filter({
    has: page.getByRole("heading", {
      name: "Квартира без указанной цены",
      exact: true,
    }),
  });
  await expect(unpriced).toContainText("Цена не указана");
  await expect(
    list.getByText("В пределах бюджета", { exact: true }),
  ).toHaveCount(0);
  for (const title of hiddenTitles) {
    await expect(list.getByRole("heading", { name: title })).toHaveCount(0);
  }
  expect(observed.originalRequests).toEqual([]);
  expect(await readWorkspace(page)).toEqual(workspace);

  const updated = await page.request.put(workspaceUrl + "/plan", {
    headers: observed.headers,
    data: {
      expectedRevision: workspace.plan?.revision,
      requestId: crypto.randomUUID(),
      threadId,
      criteria: { ...criteria, budgetRub: cheapEnough },
    },
  });
  expect(updated.status()).toBe(200);
  const editedWorkspace = await readWorkspace(page);

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText(
      "План изменился. Вернитесь к плану и откройте список заново.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(list).toHaveCount(0);
  await expect(button(page, "Перейти к чек-листу")).toHaveCount(0);
  await button(page, "Вернуться к плану").click();
  const refreshed = await openShortlist(page);
  await expect(refreshed.getByRole("listitem")).toHaveCount(1);
  await expect(
    refreshed.getByRole("heading", { name: nearMetro, exact: true }),
  ).toBeVisible();

  const savedWorkspaceRoute = "**" + workspaceUrl;
  await page.route(savedWorkspaceRoute, (route) =>
    route.fulfill({ status: 503, json: { error: "Тестовый отказ чтения" } }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText(
      "Не удалось проверить версию. Вернитесь к плану и попробуйте снова.",
    ),
  ).toBeVisible();
  await expect(refreshed).toHaveCount(0);
  await expect(button(page, "Перейти к чек-листу")).toHaveCount(0);
  await page.unroute(savedWorkspaceRoute);
  await button(page, "Вернуться к плану").click();
  const recovered = await openShortlist(page);
  await expect(recovered.getByRole("listitem")).toHaveCount(1);

  await page.goto("/");
  await openSavedPlan(page);
  await expect(button(page, "Посмотреть короткий список")).toHaveCount(0);
  expect(await readWorkspace(page)).toEqual(editedWorkspace);
  expect(observed.sideEffects).toEqual([]);
  expect(observed.external).toEqual([]);
});
