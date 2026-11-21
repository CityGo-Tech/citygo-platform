import { expect, test, type Page } from "@playwright/test";
import type { HousingWorkspace } from "@citygo/contracts";

const workspaceUrl = "/api/v1/housing/workspace";
const commute = "Станция Кутузовская";

async function workspace(page: Page): Promise<HousingWorkspace> {
  const response = await page.request.get(workspaceUrl);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function openFromBot(
  page: Page,
  host: "telegram" | "max",
  anchor?: string,
) {
  await page.goto("about:blank");
  const fragment = host === "telegram" ? "tgWebAppData" : "WebAppData";
  await page.goto(`/mini/${host}#${fragment}=synthetic-housing-${host}`);
  await expect(page).toHaveURL(new RegExp(`/mini/${host}$`));
  if (anchor)
    await page.getByLabel("Куда ездить", { exact: true }).fill(anchor);
  await page
    .getByRole("button", { name: "Собрать стартовый план", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Продолжить в CityGo", exact: true })
    .click();
  await page.getByRole("button", { name: "Не сейчас", exact: true }).click();
}

test("housing results keep the chosen task, unknown budget and independent checklist through a lost reply and a bot reopen", async ({
  page,
  context,
}) => {
  const forbidden: string[] = [];
  await context.route("https://**", (route) => route.abort());
  await context.route(
    "https://telegram.org/js/telegram-web-app.js?65",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `window.Telegram={WebApp:{initData:'synthetic-housing-telegram',initDataUnsafe:{start_param:'housing'},openLink(){throw Error('Unexpected external navigation')}}}`,
      }),
  );
  await context.route("https://st.max.ru/js/max-web-app.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.WebApp={initData:'synthetic-housing-max',initDataUnsafe:{start_param:'housing'},openLink(){throw Error('Unexpected external navigation')}}`,
    }),
  );
  context.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      /\/v1\/.*(?:chat|phone|topup|payment)/.test(path)
    )
      forbidden.push(path);
  });

  await page.goto("/");
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill(`housing-${crypto.randomUUID()}@example.test`);
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("synthetic-housing-password");
  await page.locator("input[name=personalDataConsent]").check();
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();

  await openFromBot(page, "telegram", commute);
  await expect(page.getByLabel("Куда ездить", { exact: true })).toHaveValue(
    commute,
  );
  await expect(
    page.getByLabel("Бюджет в месяц, ₽", { exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Собрать стартовый план", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ваш стартовый план поиска" }),
  ).toBeVisible();
  await expect(page.getByText(/Сравните дорогу до ориентира/)).toBeVisible();
  expect((await workspace(page)).plan).toBeNull();

  let committed = 0;
  await page.route(
    `**${workspaceUrl}/plan`,
    async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      committed++;
      await route.abort("connectionreset");
    },
    { times: 1 },
  );
  await page
    .getByRole("button", { name: "Сохранить в мой план", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Проверить сохранение", exact: true })
    .click();
  await expect(
    page.getByText("Версия 1 · Стартовый план", { exact: true }),
  ).toBeVisible();
  expect(committed).toBe(1);
  const saved = await workspace(page);
  expect(saved.plan).toMatchObject({
    revision: 1,
    criteria: { commute, budgetRub: null },
  });

  await page
    .getByRole("button", { name: "Открыть чек-лист просмотра", exact: true })
    .click();
  await page.getByRole("checkbox", { name: /Платежи/ }).check();
  await page.getByRole("checkbox", { name: /Договор и документы/ }).check();
  await page
    .getByRole("checkbox", { name: "Полный первый платёж проверен" })
    .check();
  await page
    .getByRole("button", { name: "Сохранить чек-лист", exact: true })
    .click();
  await expect
    .poll(async () => (await workspace(page)).checklist)
    .toMatchObject({
      revision: 1,
      planRevision: 1,
      selected: ["payment", "contract"],
      paymentChecked: true,
    });

  await page.reload();
  await expect(
    page.getByText("Версия 1 · Стартовый план", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Открыть чек-лист просмотра", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Полный первый платёж проверен" }),
  ).toBeChecked();

  await openFromBot(page, "telegram");
  await expect(
    page.getByText("Версия 1 · Стартовый план", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Открыть чек-лист просмотра", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Полный первый платёж проверен" }),
  ).toBeChecked();

  const other = await context.newPage();
  await openFromBot(other, "max");
  await other
    .getByRole("button", { name: "Уточнить условия", exact: true })
    .click();
  await other
    .getByLabel("Куда ездить", { exact: true })
    .fill("Станция Парк Победы");
  await other
    .getByRole("button", { name: "Собрать стартовый план", exact: true })
    .click();
  await other
    .getByRole("button", { name: "Сохранить в мой план", exact: true })
    .click();
  await expect(
    other.getByText("Версия 2 · Стартовый план", { exact: true }),
  ).toBeVisible();

  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText(
      "Стартовый план обновлён до версии 2. Сохранённые отметки чек-листа действуют.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Перепроверить платёж", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /Платежи/ })).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Полный первый платёж проверен" }),
  ).toBeChecked();
  expect((await workspace(page)).plan?.threadId).toBe(saved.plan?.threadId);
  expect(forbidden).toEqual([]);
});
