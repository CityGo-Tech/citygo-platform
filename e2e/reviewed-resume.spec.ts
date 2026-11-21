import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { PersonalPlanItem } from "@citygo/contracts";
import { openMessageActions, openResults } from "./navigation-helper";

const handoffTitle = "Передача помощнику по резюме";
const careerName = "Помощник по работе";
const resumeName = "Помощник по резюме";
const sourceText =
  "Опыт пока не описал. Из вакансии: АО Макет, должность архитектор, навык Rust.";
const careerChatDraft = "Неотправленный вопрос о поиске работы";
const resumeChatDraft = "Ранее сохранённый текст в диалоге о резюме";
const correctedExperience = "Настраивал еженедельную выгрузку таблиц.";
const reviewedText = "Опыт: Настраивал еженедельную выгрузку сводных таблиц.";
const revisedText = "Опыт: Настраивал ежемесячную выгрузку сводных таблиц.";
const resultTitle = "Резюме для синтетического отклика";
const sourceFields = [
  "Цель резюме",
  "Работодатель",
  "Должность, которую занимали",
  "Что вы делали",
  "Навыки, которыми пользовались",
] as const;
const mutations = {
  start: "/api/v1/conversations/start",
  plan: "/api/v1/personal-plan",
} as const;

const chatComposer = (page: Page) =>
  page.getByLabel("Сообщение помощнику", { exact: true });
const log = (page: Page) =>
  page.getByRole("log", { name: "История диалога", exact: true });
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const resultRegion = (page: Page) =>
  page.getByRole("region", { name: "Полный текст результата", exact: true });

async function openAssistant(page: Page, name: string) {
  await button(page, "Помощники").click();
  await page
    .getByRole("article", { name, exact: true })
    .getByRole("button", { name: "Начать разговор", exact: true })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

async function prepareFixture(
  page: Page,
  context: BrowserContext,
  info: TestInfo,
  scenario: number,
) {
  const origin = new URL(info.project.use.baseURL!).origin;
  const project = info.config.projects.findIndex(
    ({ name }) => name === info.project.name,
  );
  const address = "198.19.224." + (20 * project + 4 * info.retry + scenario);
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": address });
  const external: string[] = [];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  let observe = false;

  await context.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    external.push(url.origin);
    return route.abort();
  });
  context.on("request", (request) => {
    if (!observe || ["GET", "HEAD"].includes(request.method())) return;
    const { pathname } = new URL(request.url());
    if (
      pathname === mutations.start ||
      pathname.startsWith(mutations.plan) ||
      /^\/api\/v1\/threads\/\d+\/messages$/.test(pathname) ||
      /^\/api\/v1\/(?:payments|phone)(?:[/-]|$)/.test(pathname)
    ) {
      writes.push({
        method: request.method(),
        path: pathname,
        body: request.postDataJSON(),
      });
    }
  });

  await page.goto("/");
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill("resume-" + crypto.randomUUID() + "@example.test");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("synthetic-resume-password");
  await page.locator("input[name=personalDataConsent]").check();
  await button(page, "Создать аккаунт").click();
  await expect(button(page, "Мой план")).toBeVisible();

  await openAssistant(page, resumeName);
  await chatComposer(page).fill(resumeChatDraft);
  await openAssistant(page, careerName);

  // Seed an owned, completed user message before observing the handoff. This
  // E2E entrypoint binds a synthetic TestProvider and in-memory PGlite.
  await chatComposer(page).fill(sourceText);
  await button(page, "Отправить").click();
  await expect(log(page)).toContainText(sourceText);
  await expect(log(page)).toContainText("Тестовый ответ.");
  await expect(chatComposer(page)).toBeEditable();
  await chatComposer(page).fill(careerChatDraft);

  observe = true;
  return { writes, external };
}

async function openReviewedHandoff(page: Page) {
  const source = log(page).locator("article").filter({ hasText: sourceText });
  await openMessageActions(source);
  await source
    .getByRole("button", { name: "Подготовить резюме", exact: true })
    .click();
  const modal = page.getByRole("dialog", { name: handoffTitle, exact: true });
  await expect(modal).toBeVisible();
  for (const label of sourceFields) {
    await expect(modal.getByLabel(label, { exact: true })).toHaveValue("");
  }
  const original = modal.getByText(sourceText, { exact: true });
  if (!(await original.isVisible())) {
    await modal.getByText("Исходное сообщение", { exact: true }).click();
  }
  await expect(original).toBeVisible();
  return modal;
}

async function readPlan(page: Page) {
  const response = await page.request.get(mutations.plan);
  expect(response.status()).toBe(200);
  const plan = (await response.json()) as { items: PersonalPlanItem[] };
  return plan.items;
}

async function showResult(page: Page, text: string) {
  const library = page.getByRole("region", {
    name: "Полезное из разговоров",
    exact: true,
  });
  const result = library.getByRole("article", {
    name: "Шаг плана: " + resultTitle,
    exact: true,
  });
  await expect(result).toHaveCount(1);
  await result
    .getByRole("button", { name: "Открыть полностью", exact: true })
    .click();
  await expect(resultRegion(page)).toHaveText(text);
}

async function readChatDrafts(page: Page) {
  return page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith("citygo:chat-draft:v1:"))
      .map(
        (key) =>
          (JSON.parse(sessionStorage.getItem(key)!) as { text: string }).text,
      ),
  );
}

test("reviewed incomplete experience becomes one editable and restorable résumé without generation", async ({
  page,
  context,
}, info) => {
  await page.setViewportSize({ width: 320, height: 780 });
  const traffic = await prepareFixture(page, context, info, 1);
  const assistant = log(page)
    .locator("article")
    .filter({ hasText: "Тестовый ответ." });
  await openMessageActions(assistant);
  await expect(
    assistant.getByRole("button", { name: "Подготовить резюме", exact: true }),
  ).toHaveCount(0);

  const modal = await openReviewedHandoff(page);
  const experience = modal.getByLabel("Что вы делали", { exact: true });
  await experience.fill("Настраивал ежедневную выгрузку таблиц.");
  await experience.fill(correctedExperience);
  expect(traffic.writes).toEqual([]);
  await modal
    .getByRole("button", { name: "Перейти к помощнику по резюме", exact: true })
    .click();

  await expect(modal).toHaveCount(0);
  const title = page.getByLabel("Название результата", { exact: true });
  const text = page.getByLabel("Текст резюме", { exact: true });
  await expect(title).toHaveValue("Черновик резюме");
  await expect(text).toHaveValue("Опыт: " + correctedExperience);
  expect(await text.inputValue()).not.toMatch(
    /АО Макет|архитектор|Rust|ежедневную|Тестовый ответ/,
  );
  expect(traffic.writes).toEqual([
    {
      method: "POST",
      path: mutations.start,
      body: { agentKey: "resume-builder" },
    },
  ]);
  expect(await readChatDrafts(page)).toEqual(
    expect.arrayContaining([careerChatDraft, resumeChatDraft]),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await title.fill(resultTitle);
  await text.fill(reviewedText);

  await button(page, "Мой план").click();
  await expect(
    page.getByRole("region", { name: "Мой план переезда" }),
  ).toBeVisible();
  await button(page, "Диалоги").click();
  await page
    .getByRole("article", { name: "Диалог: " + resumeName, exact: true })
    .getByRole("button", { name: "Открыть разговор", exact: true })
    .click();
  await expect(title).toHaveValue(resultTitle);
  await expect(text).toHaveValue(reviewedText);
  await button(page, "Сохранить резюме").click();
  await showResult(page, reviewedText);

  const original = await readPlan(page);
  expect(original).toHaveLength(1);
  expect(original[0]).toMatchObject({
    title: resultTitle,
    details: reviewedText,
    revision: 1,
  });
  const id = original[0]!.id;
  const planPath = mutations.plan + "/" + id;
  await button(page, "Мой план").click();
  const plan = page.getByRole("region", {
    name: "Мой план переезда",
    exact: true,
  });
  const item = plan.getByRole("article").filter({
    has: page.getByRole("heading", { name: resultTitle, exact: true }),
  });
  await item.getByRole("button", { name: "Изменить", exact: true }).click();
  await item.getByLabel("Описание шага", { exact: true }).fill(revisedText);
  await item
    .getByRole("button", { name: "Сохранить изменения", exact: true })
    .click();
  await expect(item).toContainText(revisedText);
  await item
    .getByRole("button", { name: "Что изменилось", exact: true })
    .click();
  const history = page.getByRole("region", {
    name: "История изменений шага",
    exact: true,
  });
  await expect(
    history.getByRole("region", { name: "Текущая версия", exact: true }),
  ).toContainText(revisedText);
  await history
    .getByRole("button", {
      name: "Восстановить выбранную версию",
      exact: true,
    })
    .click();
  const restore = page.getByRole("dialog", {
    name: "Восстановить версию 1?",
    exact: true,
  });
  await expect(restore).toContainText(reviewedText);
  await restore
    .getByRole("button", { name: "Подтвердить восстановление", exact: true })
    .click();
  await expect(history.getByRole("status")).toContainText(
    "Версия восстановлена",
  );

  await page.reload();
  await openResults(page);
  await showResult(page, reviewedText);
  const restored = await readPlan(page);
  expect(restored).toHaveLength(1);
  expect(restored[0]).toMatchObject({ id, revision: 3, details: reviewedText });
  expect(traffic.writes).toEqual([
    {
      method: "POST",
      path: mutations.start,
      body: { agentKey: "resume-builder" },
    },
    {
      method: "POST",
      path: mutations.plan,
      body: expect.objectContaining({
        title: resultTitle,
        details: reviewedText,
      }),
    },
    {
      method: "PATCH",
      path: planPath,
      body: expect.objectContaining({
        expectedRevision: 1,
        details: revisedText,
      }),
    },
    {
      method: "POST",
      path: planPath + "/history/restore",
      body: { expectedRevision: 2, revision: 1 },
    },
  ]);
  expect(traffic.external).toEqual([]);
});

test("declining the reviewed résumé handoff keeps both chat drafts and saves nothing", async ({
  page,
  context,
}, info) => {
  const traffic = await prepareFixture(page, context, info, 2);
  const modal = await openReviewedHandoff(page);
  await modal
    .getByLabel("Что вы делали", { exact: true })
    .fill(correctedExperience);
  await modal
    .getByRole("button", { name: "Остаться в разговоре", exact: true })
    .click();
  await expect(modal).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: careerName, exact: true }),
  ).toBeVisible();
  await expect(chatComposer(page)).toHaveValue(careerChatDraft);
  await expect(log(page)).toContainText(sourceText);
  await expect(page.getByLabel("Текст резюме", { exact: true })).toHaveCount(0);
  expect(await readPlan(page)).toEqual([]);
  expect(await readChatDrafts(page)).toEqual(
    expect.arrayContaining([careerChatDraft, resumeChatDraft]),
  );
  expect(traffic.writes).toEqual([]);
  expect(traffic.external).toEqual([]);
});
