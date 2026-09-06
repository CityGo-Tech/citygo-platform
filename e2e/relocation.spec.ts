import { test, expect } from "@playwright/test";
test("questionnaire → plan → chat → +60 XP → next quest survives reload", async ({
  page,
}, testInfo) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto("/");
  await page
    .getByLabel("Электронная почта")
    .fill("e2e-" + crypto.randomUUID() + "@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill("CityGo-e2e-password");
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Расскажите о переезде" }),
  ).toBeVisible();
  await page.getByLabel("Откуда переезжаете").fill("Казань");
  await page.getByLabel("Город назначения").fill("Москва");
  await page.getByLabel("Бюджет аренды в месяц, ₽").fill("65000");
  await page.getByLabel("Планируемая дата переезда").fill("2099-01-01");
  await page.getByRole("radio", { name: "С партнёром", exact: true }).check();
  await expect(
    page.getByRole("radio", { name: "Найти работу", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Построить план переезда" }).click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  expect(
    await page
      .getByRole("checkbox")
      .evaluate((element: HTMLInputElement) => element.validity.valueMissing),
  ).toBeTruthy();
  await expect(
    page.getByRole("heading", { name: "Расскажите о переезде" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath("figma-questionnaire.png"),
    fullPage: true,
  });
  await page.getByRole("checkbox").check();
  const submitted = page.waitForRequest(
    (request) =>
      request.url().endsWith("/v1/questionnaire") &&
      request.method() === "POST",
  );
  await page.getByRole("button", { name: "Построить план переезда" }).click();
  expect((await submitted).postDataJSON()).toMatchObject({
    household: "couple",
    aiConsent: true,
    monthlyBudget: 65000,
  });
  await expect(
    page.getByRole("heading", { name: "Составить план поиска жилья" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Начать квест" }).click();
  await page
    .getByLabel("Сообщение помощнику")
    .fill("Нужна квартира рядом с метро, помоги выбрать критерии");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Уточните район");
  const checks = page.locator("#quest").getByRole("checkbox");
  for (let i = 0; i < 3; i++) await checks.nth(i).check();
  await page.getByRole("button", { name: "Завершить квест · +60 XP" }).click();
  await expect(page.getByRole("status")).toContainText("+60 XP");
  await expect(
    page.getByRole("heading", { name: "Подготовиться к просмотру квартиры" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("log")).toContainText("Уточните район");
  await expect(page.locator(".account")).toContainText("60 XP");
  await expect(
    page.getByRole("button", { name: "Начать квест" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("completed-route.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});
