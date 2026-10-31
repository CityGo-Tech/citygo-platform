import { test, expect, type Page } from "@playwright/test";
import type { Dashboard } from "@citygo/contracts";

async function register(page: Page, password = "123456") {
  const email = "e2e-" + crypto.randomUUID() + "@example.test";
  await page.goto("/");
  await page.getByLabel("Электронная почта", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.locator("input[name=personalDataConsent]").check();
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
  await page
    .getByRole("region", { name: "Баланс и телефон", exact: true })
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  const credit = page.getByRole("region", { name: "Бесплатный баланс AI" });
  await expect(
    credit.getByRole("button", { name: "Получить подарок 500 ₽" }),
  ).toBeVisible();
  await expect(credit.locator(".balance-amount")).toHaveText("0 ₽");
  const initialDashboard = await page.request.get("/api/v1/dashboard");
  expect(initialDashboard.ok()).toBeTruthy();
  expect((await initialDashboard.json()).aiAccess.credit).toMatchObject({
    bonusGranted: false,
    grantedMicros: 0,
    availableMicros: 0,
  });
  await page
    .getByRole("button", { name: "Вернуться в приложение", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Отправить", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".conversation-main > .ai-access")).toHaveCount(0);
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
  await expect(
    page.getByRole("button", { name: "Согласия", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("log")).toContainText(
    "Тестовый ответ. Уточните район",
  );
  await expect(page.getByRole("log")).toContainText(message);
  await expect(page.getByLabel("Сообщение помощнику")).toBeEnabled();
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

test("six consecutive synthetic replies preserve numeric chat order and the last question after reload", async ({
  page,
}, testInfo) => {
  await register(page);
  await page
    .getByRole("button", { name: "Начать диалог", exact: true })
    .click();
  const questions: string[] = [];
  for (let turn = 1; turn <= 6; turn++) {
    const question = `Вымышленный вопрос ${turn}: помоги подготовить переезд`;
    questions.push(question);
    await page.getByLabel("Сообщение помощнику").fill(question);
    await page.getByRole("button", { name: "Отправить", exact: true }).click();
    await expect(page.getByLabel("Сообщение помощнику")).toBeEnabled();
    await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("");
    await expect(page.getByRole("log").locator("article")).toHaveCount(
      turn * 2,
    );
  }
  const read = async () => {
    const response = await page.request.get("/api/v1/dashboard");
    expect(response.ok()).toBeTruthy();
    return response.json() as Promise<Dashboard>;
  };
  const before = (await read()).thread!.messages;
  expect(before).toHaveLength(12);
  expect(before.map((m) => BigInt(m.id))).toEqual(
    before
      .map((m) => BigInt(m.id))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  expect(before.filter((m) => m.role === "user").map((m) => m.content)).toEqual(
    questions,
  );
  expect(before.at(-2)?.content).toBe(questions.at(-1));
  expect(before.at(-1)?.role).toBe("assistant");
  expect(before.at(-1)?.status).toBe("complete");
  await page.reload();
  await expect(page.getByRole("log").locator("article")).toHaveCount(12);
  const rendered = await page
    .getByRole("log")
    .locator("article")
    .allTextContents();
  for (let i = 0; i < questions.length; i++)
    expect(rendered[i * 2]).toContain(questions[i]);
  expect((await read()).thread!.messages).toEqual(before);
  await page.screenshot({
    path: testInfo.outputPath("numeric-history-after-reload.png"),
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
    .getByRole("dialog", { name: "Выйти из аккаунта?", exact: true })
    .getByRole("button", { name: "Выйти", exact: true })
    .click();
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
