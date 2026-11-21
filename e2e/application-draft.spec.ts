import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { PersonalPlanItem } from "@citygo/contracts";
import { openMessageActions } from "./navigation-helper";

const workAssistant = "Помощник по работе";
const sourceQuestion = "В тексте вымышленной вакансии требуется Rust.";
const reviewedExperience = "Настраивал еженедельную выгрузку таблиц.";
const resultTitle = "Подтверждённый опыт для отклика";
const vacancyTitle = "Аналитик отчётности";
const relevantRequirement = "Опыт автоматизации отчётов";
const missingRequirement = "Опыт с Rust";

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const application = (page: Page) =>
  page.getByRole("dialog", {
    name: "Подготовьте один честный отклик",
    exact: true,
  });
const readClipboard = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { applicationCopies: string[] }).applicationCopies,
  );

async function savedResume(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill("application-" + crypto.randomUUID() + "@example.test");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("synthetic-application");
  await page.locator("input[name=personalDataConsent]").check();
  await button(page, "Создать аккаунт").click();
  await expect(button(page, "Мой план")).toBeVisible();

  await button(page, "Помощники").click();
  await page
    .getByRole("article", { name: workAssistant, exact: true })
    .getByRole("button", { name: "Начать разговор", exact: true })
    .click();
  const history = page.getByRole("log", {
    name: "История диалога",
    exact: true,
  });
  await page
    .getByLabel("Сообщение помощнику", { exact: true })
    .fill(sourceQuestion);
  // This local suite uses the synthetic TestProvider and PGlite.
  await button(page, "Отправить").click();
  await expect(history).toContainText("Тестовый ответ.");
  const source = history.locator("article").filter({ hasText: sourceQuestion });
  await openMessageActions(source);
  await source
    .getByRole("button", { name: "Подготовить резюме", exact: true })
    .click();
  const handoff = page.getByRole("dialog", {
    name: "Передача помощнику по резюме",
    exact: true,
  });
  await handoff
    .getByLabel("Что вы делали", { exact: true })
    .fill(reviewedExperience);
  await handoff
    .getByRole("button", { name: "Перейти к помощнику по резюме", exact: true })
    .click();
  await expect(page.getByLabel("Текст резюме", { exact: true })).toHaveValue(
    "Опыт: " + reviewedExperience,
  );
  await page
    .getByLabel("Название результата", { exact: true })
    .fill(resultTitle);
  await button(page, "Сохранить резюме").click();
  const card = page
    .getByRole("region", { name: "Полезное из разговоров", exact: true })
    .getByRole("article", { name: "Шаг плана: " + resultTitle, exact: true });
  await expect(card).toHaveCount(1);
  await card
    .getByRole("button", { name: "Открыть полностью", exact: true })
    .click();
}

async function readPlan(page: Page) {
  const response = await page.request.get("/api/v1/personal-plan");
  expect(response.status()).toBe(200);
  const result = (await response.json()) as { items: PersonalPlanItem[] };
  return result.items;
}

async function prepareFixture(
  page: Page,
  context: BrowserContext,
  info: TestInfo,
  scenario: number,
) {
  const origin = new URL(info.project.use.baseURL!);
  expect(["localhost", "127.0.0.1"]).toContain(origin.hostname);
  const number = info.config.projects.findIndex(
    ({ name }) => name === info.project.name,
  );
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For":
      "198.19.225." + (20 * number + 2 * info.retry + scenario),
  });
  await context.addInitScript(() => {
    const box = window as unknown as { applicationCopies: string[] };
    box.applicationCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          box.applicationCopies.push(text);
        },
      },
    });
  });
  const external: string[] = [];
  const writes: string[] = [];
  let observe = false;
  await context.route(/^https?:\/\//, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) {
      external.push(url.origin);
      return route.abort();
    }
    if (observe && !["GET", "HEAD"].includes(request.method())) {
      writes.push(request.method() + " " + url.pathname);
    }
    return route.continue();
  });
  await savedResume(page);
  const initialPlan = await readPlan(page);
  expect(initialPlan).toHaveLength(1);
  expect(initialPlan[0]).toMatchObject({
    title: resultTitle,
    details: "Опыт: " + reviewedExperience,
    revision: 1,
    source: expect.objectContaining({ role: "user" }),
  });
  observe = true;
  await button(page, "Сравнить с вакансией").click();
  await expect(application(page)).toBeVisible();
  return { external, writes, initialPlan };
}

async function reviewApplication(page: Page) {
  const dialog = application(page);
  await dialog
    .getByLabel("Название вакансии", { exact: true })
    .fill(vacancyTitle);
  await dialog
    .getByLabel("Требования вакансии", { exact: true })
    .fill(relevantRequirement + "\n" + missingRequirement);

  const relevant = dialog.getByLabel(relevantRequirement, { exact: true });
  const missing = dialog.getByLabel(missingRequirement, { exact: true });
  await expect(missing.locator("option:checked")).toHaveText("Нужно уточнить");
  await relevant.selectOption({ label: reviewedExperience });
  expect(await readClipboard(page)).toEqual([]);

  await dialog
    .getByRole("button", { name: "Проверить отклик", exact: true })
    .click();
  const draft = dialog.getByLabel("Текст отклика", { exact: true });
  await expect(draft).toBeEditable();
  return draft;
}

test("a saved reviewed résumé supports an explicit private application draft", async ({
  page,
  context,
}, info) => {
  if (info.project.name === "mobile-web")
    await page.setViewportSize({ width: 320, height: 780 });

  const { external, writes, initialPlan } = await prepareFixture(
    page,
    context,
    info,
    1,
  );
  const dialog = application(page);
  await expect(
    dialog.locator("input[type=email], input[type=tel]"),
  ).toHaveCount(0);
  const draft = await reviewApplication(page);
  const initialDraft = await draft.inputValue();
  expect(initialDraft).toContain(vacancyTitle);
  expect(initialDraft).toContain(reviewedExperience);
  expect(initialDraft).not.toContain(missingRequirement);
  expect(initialDraft).not.toContain("Rust");
  await expect(
    dialog.getByText("Что нужно уточнить", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText(missingRequirement);
  expect(await readClipboard(page)).toEqual([]);

  const editedDraft = initialDraft + "\nГотов обсудить задачи команды.";
  await draft.fill(editedDraft);
  await dialog
    .getByRole("button", { name: "Скопировать отклик", exact: true })
    .click();
  await expect.poll(() => readClipboard(page)).toEqual([editedDraft]);
  expect(await readPlan(page)).toEqual(initialPlan);
  expect(writes).toEqual([]);
  expect(external).toEqual([]);
  expect(
    await dialog.evaluate(
      (element) =>
        document.documentElement.scrollWidth <= innerWidth + 1 &&
        element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
});

test("copy rejects a draft when another edit changed the saved résumé revision", async ({
  page,
  context,
}, info) => {
  const { initialPlan, writes, external } = await prepareFixture(
    page,
    context,
    info,
    2,
  );
  const draft = await reviewApplication(page);
  expect(await draft.inputValue()).toContain(reviewedExperience);
  const old = initialPlan[0]!;
  const response = await page.request.patch("/api/v1/personal-plan/" + old.id, {
    headers: {
      Origin: new URL(info.project.use.baseURL!).origin,
      "X-CityGo-Contract-Version": "1",
    },
    data: {
      title: old.title,
      details: "Опыт: Настраивал ежемесячный экспорт.",
      status: old.status,
      expectedRevision: old.revision,
    },
  });
  expect(response.status()).toBe(200);
  expect(await readPlan(page)).toMatchObject([{ id: old.id, revision: 2 }]);

  const dialog = application(page);
  const copy = dialog.getByRole("button", {
    name: "Скопировать отклик",
    exact: true,
  });
  const revalidation = page.waitForResponse(
    (reply) =>
      reply.request().method() === "GET" &&
      new URL(reply.url()).pathname ===
        "/api/v1/results/plan/" + old.id + "/discussion-source",
  );
  await copy.click();
  expect((await revalidation).status()).toBe(200);
  await expect(dialog).toContainText(
    "Резюме изменилось. Откройте сохранённый результат заново.",
  );
  await expect(draft).toBeHidden();
  await expect(copy).toBeHidden();
  expect(await readClipboard(page)).toEqual([]);
  expect(writes).toEqual([]);
  expect(external).toEqual([]);
});
