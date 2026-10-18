import { test, expect, type Page } from "@playwright/test";

async function register(page: Page, password = "123456") {
  const email = "e2e-" + crypto.randomUUID() + "@example.test";
  await page.goto("/");
  await page.getByLabel("Электронная почта", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  return email;
}

async function expectNoInventedPlan(page: Page) {
  const response = await page.request.get("/api/v1/dashboard");
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({
    profile: null,
    quests: [],
    xp: 0,
  });
  await expect(page.locator(".account")).toContainText("0 XP");
  await expect(page.getByLabel("Откуда переезжаете")).toHaveCount(0);
  await expect(page.getByLabel("Бюджет аренды в месяц, ₽")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Завершить квест/ }),
  ).toHaveCount(0);
}

test("six-character registration → conversation without questionnaire → saved test response survives reload", async ({
  page,
}, testInfo) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  const questionnaireWrites: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/v1/questionnaire")
    )
      questionnaireWrites.push(request.url());
  });
  await register(page);
  await expectNoInventedPlan(page);
  await page
    .getByRole("button", { name: "Начать диалог", exact: true })
    .click();
  await expect(
    page.getByRole("log", { name: "История диалога" }),
  ).toBeVisible();
  await expectNoInventedPlan(page);
  const credit = page.getByRole("region", { name: "Бесплатный баланс AI" });
  await expect(credit).toContainText("Разовый бонус 500 ₽ ещё не выдан");
  await expect(credit).toContainText("Доступно: 0 ₽");
  await expect(
    page.getByRole("button", { name: "Отправить", exact: true }),
  ).toBeDisabled();
  const approve = page.getByRole("button", {
    name: "Подтвердить получателя AI",
  });
  await expect(approve).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "Разрешаю передачу указанных данных этому получателю для рекомендаций.",
    })
    .check();
  await approve.click();
  await expect(
    page.getByText("Передача данных разрешена: OpenAI", { exact: false }),
  ).toBeVisible();
  const message =
    "Хочу переехать в Москву, но пока не знаю бюджет и дату. С чего начать?";
  await page.getByLabel("Сообщение помощнику").fill(message);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  // TestProvider is an in-process deterministic fixture, not a paid/live model.
  await expect(page.getByRole("log")).toContainText(
    "Тестовый ответ. Уточните район",
  );
  await expect(page.getByRole("log")).toContainText(message);
  await expectNoInventedPlan(page);
  await page.getByRole("button", { name: "Отозвать разрешение AI" }).click();
  await expect(
    page.getByRole("button", { name: "Подтвердить получателя AI" }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("log")).toContainText(
    "Тестовый ответ. Уточните район",
  );
  await expect(page.getByRole("log")).toContainText(message);
  await expect(
    page.getByRole("button", { name: "Отправить", exact: true }),
  ).toBeDisabled();
  await expectNoInventedPlan(page);
  expect(questionnaireWrites).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("conversation-without-questionnaire.png"),
    fullPage: true,
  });
});

test("profile changes password to six arbitrary characters; old login fails and new login works", async ({
  page,
}) => {
  const oldPassword = "123456";
  const newPassword = " а!б  ";
  const email = await register(page, oldPassword);
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  await page
    .getByRole("button", { name: "Изменить пароль", exact: true })
    .click();
  await page.getByLabel("Текущий пароль", { exact: true }).fill(oldPassword);
  await page.getByLabel("Новый пароль", { exact: true }).fill(newPassword);
  await page
    .getByRole("button", { name: "Сохранить новый пароль", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Пароль изменён");
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await page
    .getByRole("button", { name: "Уже есть аккаунт? Войти", exact: true })
    .click();
  await page
    .getByLabel("Логин или электронная почта", { exact: true })
    .fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(oldPassword);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator(".alert[role=alert]")).toBeVisible();
  // A failed login remounts the credential form rather than retaining secrets.
  await page
    .getByLabel("Логин или электронная почта", { exact: true })
    .fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(newPassword);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  await expectNoInventedPlan(page);
});
