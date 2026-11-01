import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";

async function enter(page: Page, context: BrowserContext) {
  await context.addCookies([
    {
      name: "citygo",
      value: createHash("sha256")
        .update("citygo-public-observability-test-session-v1:other")
        .digest("hex"),
      domain: "localhost",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 86400,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await context.route("https://**", (route) => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  await page
    .getByRole("button", { name: "Помощь человека", exact: true })
    .last()
    .click();
  return page.locator("[aria-labelledby=human-support-heading]");
}
async function create(page: Page, context: BrowserContext, question: string) {
  const panel = await enter(page, context);
  await panel.getByRole("textbox", { name: "Ваш вопрос" }).fill(question);
  await panel
    .getByRole("button", { name: "Отправить обращение", exact: true })
    .click();
  await expect(panel.getByRole("heading", { level: 1 })).toHaveText(
    "Обращение сохранено",
  );
  const list = await (
    await context.request.get("/api/v1/support-requests")
  ).json();
  const row = list.requests.find((r: { body: string }) => r.body === question);
  expect(row).toBeTruthy();
  return { panel, id: row.id as string };
}

test("owner closes/reopens own support, filters preserve the draft and persisted status survives reload", async ({
  page,
  context,
}, info) => {
  const forbidden: string[] = [];
  page.on("request", (r) => {
    if (
      r.method() !== "GET" &&
      /\/threads\/\d+\/messages|\/payments\/|\/phone\//.test(r.url())
    )
      forbidden.push(r.url());
  });
  const question =
    "Проверьте, пожалуйста, мой первый шаг переезда. " + randomUUID();
  const { panel, id } = await create(page, context, question);
  await panel
    .getByRole("button", { name: "Новый вопрос", exact: true })
    .click();
  const draft = "Этот черновик остаётся со мной при выборе фильтра.";
  await panel.getByRole("textbox", { name: "Ваш вопрос" }).fill(draft);
  await panel.getByLabel("Показать обращения").selectOption("open");
  const row = panel.locator("#human-support-thread-" + id);
  await expect(row).toContainText(question);
  await row
    .getByRole("button", { name: "Закрыть обращение №" + id, exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "Ваш вопрос" })).toHaveValue(
    draft,
  );
  await panel.getByLabel("Показать обращения").selectOption("closed");
  await expect(row).toContainText("Закрыто");
  const privateHistory = panel.locator(
    'section[aria-labelledby="support-history-heading"][data-citygo-private]',
  );
  await expect(privateHistory).toHaveClass(/ym-hide-content/);
  await expect(
    privateHistory.locator("#human-support-thread-" + id),
  ).toContainText(question);
  await panel.screenshot({ path: info.outputPath("support-owner-closed.png") });
  const fresh = await enter(page, context);
  await fresh.getByLabel("Показать обращения").selectOption("closed");
  const saved = fresh.locator("#human-support-thread-" + id);
  await expect(saved).toContainText(question);
  await saved
    .getByRole("button", {
      name: "Открыть снова обращение №" + id,
      exact: true,
    })
    .click();
  await expect(saved).toHaveCount(0);
  await fresh.getByLabel("Показать обращения").selectOption("open");
  await expect(saved).toContainText("Открыто");
  expect(
    (await (await context.request.get("/api/v1/support-requests/" + id)).json())
      .request.status,
  ).toBe("open");
  expect(forbidden).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await fresh.screenshot({
    path: info.outputPath("support-owner-reopened.png"),
  });
});

test("a lost owner status receipt never silently retries and an explicit read recovers the real state", async ({
  page,
  context,
}, info) => {
  const { panel, id } = await create(
    page,
    context,
    "Нужно разобраться с обращением после изменения статуса. " + randomUUID(),
  );
  let patches = 0;
  await page.route("**/api/v1/support-requests/" + id, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches++;
    if (patches === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    } else await route.continue();
  });
  const row = panel.locator("#human-support-thread-" + id);
  await row
    .getByRole("button", { name: "Закрыть обращение №" + id, exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText(
    "Изменение статуса не подтверждено",
  );
  await expect(
    row.getByRole("button", { name: "Закрыть обращение №" + id, exact: true }),
  ).toBeDisabled();
  expect(patches).toBe(1);
  await panel
    .getByRole("button", { name: "Обновить обращение №" + id, exact: true })
    .click();
  await expect(row).toContainText("Закрыто");
  await expect(
    row.getByRole("button", {
      name: "Открыть снова обращение №" + id,
      exact: true,
    }),
  ).toBeEnabled();
  expect(patches).toBe(1);
  await panel.screenshot({
    path: info.outputPath("support-status-explicit-recovery.png"),
  });
});
