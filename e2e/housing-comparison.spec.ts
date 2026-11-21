import { expect, test, type Page } from "@playwright/test";
import type { HousingWorkspace } from "@citygo/contracts";

const workspaceUrl = "/api/v1/housing/workspace";
const confirmationUrl = workspaceUrl + "/checklist/confirmation";
const firstCommute = "Станция Кутузовская";
const changedCommute = "Станция Парк Победы";

async function readWorkspace(page: Page): Promise<HousingWorkspace> {
  const response = await page.request.get(workspaceUrl);
  expect(response.status()).toBe(200);
  return response.json();
}

function button(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}

async function openSavedPlan(page: Page) {
  await button(page, "Мой план").click();
  await page
    .getByRole("region", { name: "Мой план переезда", exact: true })
    .getByRole("button", { name: "Стартовый план поиска жилья", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ваш стартовый план поиска" }),
  ).toBeVisible();
}

test("regular Web compares a saved plan on a narrow screen and confirms the reviewed checklist once", async ({
  page,
  context,
}, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 320, height: 780 });
  const project = info.config.projects.findIndex(
    (candidate) => candidate.name === info.project.name,
  );
  const headers = {
    Origin: info.project.use.baseURL!,
    "X-Forwarded-For": "198.19.220." + (10 * project + info.retry + 1),
    "X-CityGo-Contract-Version": "1",
  };
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": headers["X-Forwarded-For"],
  });
  const external: string[] = [];
  await context.route("https://**", (route) => {
    external.push(new URL(route.request().url()).hostname);
    return route.abort();
  });
  const providerWrites: string[] = [];
  context.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() !== "GET" &&
      /\/v1\/.*(?:chat|phone|topup|payment)/.test(path)
    )
      providerWrites.push(path);
  });
  const confirmationWrites: unknown[] = [];
  await page.route("**" + confirmationUrl, (route) => {
    confirmationWrites.push(route.request().postDataJSON());
    return route.continue();
  });

  await page.goto("/");
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill("comparison-" + crypto.randomUUID() + "@example.test");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("synthetic-housing-password");
  await page.locator("input[name=personalDataConsent]").check();
  await button(page, "Создать аккаунт").click();
  await expect(button(page, "Мой план")).toBeVisible();

  const started = await context.request.post("/api/v1/conversations/start", {
    headers,
    data: { agentKey: "housing" },
  });
  expect(started.status()).toBe(200);
  const { id: threadId } = await started.json();
  const criteria = {
    city: "Москва",
    situation: "oriented",
    commute: firstCommute,
    budgetRub: null,
  };
  const initialPlan = await context.request.put(workspaceUrl + "/plan", {
    headers,
    data: {
      expectedRevision: 0,
      requestId: crypto.randomUUID(),
      threadId,
      criteria,
    },
  });
  expect(initialPlan.status()).toBe(200);
  const initialChecklist = await context.request.put(
    workspaceUrl + "/checklist",
    {
      headers,
      data: {
        expectedRevision: 0,
        planRevision: 1,
        selected: ["payment", "contract"],
        paymentChecked: true,
        requestId: crypto.randomUUID(),
      },
    },
  );
  expect(initialChecklist.status()).toBe(200);
  const saved = await readWorkspace(page);

  await openSavedPlan(page);
  await button(page, "Показать направления поиска").click();
  await expect(
    page.getByRole("heading", {
      name: "Сравним направления, а не обещания",
      exact: true,
    }),
  ).toBeVisible();
  for (const name of [
    "Ближе к месту работы",
    "Вдоль удобной линии транспорта",
    "Временный старт",
  ]) {
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByText(firstCommute, { exact: false }).first(),
  ).toBeVisible();
  expect(await readWorkspace(page)).toEqual(saved);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);

  const other = await context.newPage();
  try {
    await other.goto("/");
    const response = await other.request.put(workspaceUrl + "/plan", {
      headers,
      data: {
        expectedRevision: 1,
        requestId: crypto.randomUUID(),
        threadId,
        criteria: { ...criteria, commute: changedCommute },
      },
    });
    expect(response.status()).toBe(200);
  } finally {
    await other.close();
  }
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("Изменились условия поездок. Пересмотрите маршруты.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Изменился бюджет. Пересмотрите расходы.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Стартовый план · версия 1", { exact: true }),
  ).toBeVisible();
  await expect(button(page, "Перейти к чек-листу")).toBeDisabled();
  await expect(button(page, "Посмотреть изменения")).toBeVisible();
  await button(page, "Посмотреть изменения").click();
  await expect(
    page.getByText("Стартовый план · версия 2", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(changedCommute, { exact: false }).first(),
  ).toBeVisible();
  expect((await readWorkspace(page)).checklist).toEqual(saved.checklist);

  await button(page, "Перейти к чек-листу").click();
  await expect(
    page.getByRole("heading", { name: "Чек-лист просмотра", exact: true }),
  ).toBeVisible();
  await expect(button(page, "Перепроверить платёж")).toHaveCount(0);
  const payment = page.getByRole("checkbox", {
    name: "Полный первый платёж проверен",
  });
  await expect(payment).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Договор и документы" }),
  ).toBeChecked();
  await page.getByRole("checkbox", { name: "Состояние квартиры" }).check();
  await button(page, "Сохранить чек-лист").click();
  await expect
    .poll(async () => (await readWorkspace(page)).checklist)
    .toMatchObject({
      revision: 2,
      planRevision: 2,
      selected: ["payment", "contract", "inspection"],
      paymentChecked: true,
    });

  expect(confirmationWrites).toEqual([]);
  await button(page, "Подтвердить подготовку").click();
  expect(confirmationWrites).toEqual([]);
  await button(page, "Я подготовился к просмотру").click();
  await expect(
    page.getByText("Подготовка подтверждена", { exact: true }),
  ).toBeVisible();
  expect(confirmationWrites).toEqual([
    {
      expectedRevision: 2,
      planRevision: 2,
      requestId: expect.any(String),
      reviewed: true,
    },
  ]);
  expect((await readWorkspace(page)).checklist).toMatchObject({
    revision: 3,
    planRevision: 2,
    confirmedFromRevision: 2,
  });

  await page.reload();
  await openSavedPlan(page);
  await button(page, "Открыть чек-лист просмотра").click();
  await expect(
    page.getByText("Подготовка подтверждена", { exact: true }),
  ).toBeVisible();
  expect(confirmationWrites).toHaveLength(1);
  const budgetUpdate = await context.request.put(workspaceUrl + "/plan", {
    headers,
    data: {
      expectedRevision: 2,
      requestId: crypto.randomUUID(),
      threadId,
      criteria: { ...criteria, commute: changedCommute, budgetRub: 75_000 },
    },
  });
  expect(budgetUpdate.status()).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText(
      "Изменился бюджет в стартовом плане версии 3. Перепроверьте полный первый платёж.",
      { exact: true },
    ),
  ).toBeVisible();
  const preparation = page.getByText("Подготовка подтверждена", {
    exact: true,
  });
  const contract = page.getByRole("checkbox", { name: "Договор и документы" });
  const inspection = page.getByRole("checkbox", { name: "Состояние квартиры" });
  await expect(preparation).toHaveCount(0);
  await expect(contract).toBeChecked();
  await expect(inspection).toBeChecked();

  await button(page, "Перепроверить платёж").click();
  await expect(payment).not.toBeChecked();
  await expect(contract).toBeChecked();
  await expect(inspection).toBeChecked();
  await expect(preparation).toHaveCount(0);
  await expect(button(page, "Подтвердить подготовку")).toHaveCount(0);
  expect((await readWorkspace(page)).checklist).toMatchObject({
    revision: 3,
    planRevision: 2,
    confirmedFromRevision: 2,
    paymentNeedsReview: true,
  });
  expect(confirmationWrites).toHaveLength(1);

  expect(providerWrites).toEqual([]);
  expect(external).toEqual([]);
});
