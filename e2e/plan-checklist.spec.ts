import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type {
  Dashboard,
  PersonalPlanItem,
  PlanChecklistEntry,
  SavePlanChecklist,
} from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
async function fixture(context: BrowserContext) {
  const item: PersonalPlanItem = {
    id: "9007199254741030",
    title: "Подготовка к просмотру",
    details: "Проверить важное заранее",
    status: "pending",
    revision: 1,
    source: null,
    createdAt: "2026-10-30T10:00:00Z",
    updatedAt: "2026-10-30T10:00:00Z",
  };
  const state = {
    owner: "101",
    entries: [] as PlanChecklistEntry[],
    writes: [] as SavePlanChecklist[],
    unexpected: [] as string[],
    external: 0,
    lostReceipt: false,
    planReads: 0,
    checklistReads: 0,
    missingParent: false,
  };
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: "synthetic@example.test",
      role: "user",
      mustChangePassword: false,
    },
    profile: null,
    xp: 0,
    quests: [],
    thread: null,
    provider: "unconfigured",
    aiAccess: { policy: null, granted: false, dailyLimit: 100 },
  });
  await context.route("https://**", (route) => {
    state.external++;
    return route.abort();
  });
  await context.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/dashboard") return route.fulfill({ json: board() });
    if (path === "/api/v1/account/consents")
      return route.fulfill({
        json: {
          policy: syntheticConsentPolicy,
          personalDataGranted: true,
          marketingGranted: false,
          serviceConsentRequired: false,
          currentAiConsentRequired: false,
        },
      });
    if (path === "/api/v1/personal-plan") {
      state.planReads++;
      return route.fulfill({
        json: {
          userId: state.owner,
          items: state.owner === "101" && !state.missingParent ? [item] : [],
          nextBefore: null,
        },
      });
    }
    if (path === "/api/v1/personal-plan/summary")
      return route.fulfill({
        json: {
          userId: state.owner,
          total: state.owner === "101" && !state.missingParent ? 1 : 0,
          pending: state.owner === "101" && !state.missingParent ? 1 : 0,
          completed: 0,
        },
      });
    if (path === "/api/v1/personal-plan/" + item.id + "/checklist") {
      if (method === "PUT") {
        const input = route.request().postDataJSON() as SavePlanChecklist;
        state.writes.push(input);
        if (state.missingParent)
          return route.fulfill({
            status: 404,
            json: { error: "Parent removed" },
          });
        if (input.expectedRevision !== item.revision)
          return route.fulfill({ status: 409, json: { error: "Conflict" } });
        state.entries = structuredClone(input.entries);
        item.revision++;
        if (state.lostReceipt) {
          state.lostReceipt = false;
          return route.fulfill({
            status: 503,
            json: { error: "Uncertain result" },
          });
        }
      }
      if (method === "GET") state.checklistReads++;
      if (state.missingParent)
        return route.fulfill({
          status: 404,
          json: { error: "Parent removed" },
        });
      return route.fulfill({
        json: {
          userId: state.owner,
          itemId: item.id,
          revision: item.revision,
          entries: state.entries,
        },
      });
    }
    state.unexpected.push(method + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  return { state, item };
}
const panel = (page: Page) =>
  page.getByRole("region", { name: "Чек-лист шага", exact: true });
async function open(page: Page) {
  await page.getByRole("button", { name: "Мой план", exact: true }).click();
  await page.getByRole("button", { name: "Чек-лист", exact: true }).click();
  await expect(
    panel(page).getByText("Пунктов пока нет. Добавьте первое действие."),
  ).toBeVisible();
}
test("owner authors, edits, completes and removes checklist points explicitly; reload preserves it without completing the parent or sending AI", async ({
  page,
  context,
}, info) => {
  const { state, item } = await fixture(context);
  await page.goto("/");
  await open(page);
  await panel(page)
    .getByRole("button", { name: "Добавить пункт", exact: true })
    .click();
  await panel(page)
    .getByLabel("Название пункта", { exact: true })
    .fill("Платежи");
  await panel(page)
    .getByLabel("Подробности пункта", { exact: true })
    .fill("Что входит в сумму");
  await expect(
    panel(page).getByLabel("Название пункта", { exact: true }),
  ).toHaveClass(/ym-disable-keys/);
  expect(state.writes).toHaveLength(0);
  await panel(page)
    .getByRole("button", { name: "Сохранить пункт", exact: true })
    .click();
  await expect(
    panel(page).getByText("Что входит в сумму", { exact: true }),
  ).toBeVisible();
  await panel(page)
    .getByRole("checkbox", { name: "Платежи", exact: true })
    .click();
  await expect(
    panel(page).getByText("Готово 1 из 1", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Мой план", exact: true }).click();
  await page.getByRole("button", { name: "Чек-лист", exact: true }).click();
  await expect(
    panel(page).getByRole("checkbox", { name: "Платежи", exact: true }),
  ).toBeChecked();
  await page.screenshot({
    path: info.outputPath("plan-checklist.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await panel(page)
    .getByRole("button", { name: "Изменить пункт", exact: true })
    .click();
  await panel(page)
    .getByLabel("Название пункта", { exact: true })
    .fill("Уточнить все платежи");
  await panel(page)
    .getByRole("button", { name: "Сохранить пункт", exact: true })
    .click();
  await expect(
    panel(page).getByRole("checkbox", {
      name: "Уточнить все платежи",
      exact: true,
    }),
  ).toBeChecked();
  await panel(page)
    .getByRole("button", { name: "Удалить пункт", exact: true })
    .click();
  expect(state.writes).toHaveLength(3);
  await panel(page)
    .getByRole("button", { name: "Подтвердить удаление пункта", exact: true })
    .click();
  await expect(
    panel(page).getByText("Пунктов пока нет. Добавьте первое действие."),
  ).toBeVisible();
  expect(state.writes).toHaveLength(4);
  expect(item.status).toBe("pending");
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});
test("uncertain checklist save requires an explicit refresh and cannot silently repeat the write", async ({
  page,
  context,
}) => {
  const { state } = await fixture(context);
  await page.goto("/");
  await open(page);
  await panel(page)
    .getByRole("button", { name: "Добавить пункт", exact: true })
    .click();
  await panel(page)
    .getByLabel("Название пункта", { exact: true })
    .fill("Сохранённый пункт");
  state.lostReceipt = true;
  await panel(page)
    .getByRole("button", { name: "Сохранить пункт", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "уже могло сохраниться",
  );
  await expect(
    panel(page).getByRole("button", { name: "Сохранить пункт", exact: true }),
  ).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  await panel(page)
    .getByRole("button", { name: "Обновить чек-лист", exact: true })
    .click();
  await expect(
    panel(page).getByRole("checkbox", {
      name: "Сохранённый пункт",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
});

test("unfinished checklist editors and removal decisions block unrelated row writes without losing the draft", async ({
  page,
  context,
}, info) => {
  const { state, item } = await fixture(context);
  await page.goto("/");
  await open(page);
  const list = panel(page);
  await list
    .getByRole("button", { name: "Добавить пункт", exact: true })
    .click();
  await list.getByLabel("Название пункта", { exact: true }).fill("Платежи");
  await list
    .getByLabel("Подробности пункта", { exact: true })
    .fill("Исходные подробности");
  await list
    .getByRole("button", { name: "Сохранить пункт", exact: true })
    .click();
  await expect(
    list.getByRole("checkbox", { name: "Платежи", exact: true }),
  ).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  await list
    .getByRole("button", { name: "Изменить пункт", exact: true })
    .click();
  const title = list.getByLabel("Название пункта", { exact: true }),
    details = list.getByRole("textbox", {
      name: "Подробности пункта",
      exact: true,
    });
  await title.fill("Мой несохранённый заголовок");
  await details.fill("Мои несохранённые подробности 🧳");
  await expect(
    list.getByRole("checkbox", { name: "Платежи", exact: true }),
  ).toBeDisabled();
  await expect(
    list.getByRole("button", { name: "Изменить пункт", exact: true }),
  ).toBeDisabled();
  await expect(
    list.getByRole("button", { name: "Удалить пункт", exact: true }),
  ).toBeDisabled();
  await expect(title).toHaveValue("Мой несохранённый заголовок");
  await expect(details).toHaveValue("Мои несохранённые подробности 🧳");
  expect(state.writes).toHaveLength(1);
  await expect(
    list.getByRole("button", { name: "Сохранить пункт", exact: true }),
  ).toBeEnabled();
  await expect(
    list.getByRole("button", { name: "Отмена пункта", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("checklist-editor-draft-guard.png"),
    fullPage: true,
  });
  await list
    .getByRole("button", { name: "Сохранить пункт", exact: true })
    .click();
  await expect(
    list.getByRole("checkbox", {
      name: "Мой несохранённый заголовок",
      exact: true,
    }),
  ).toBeEnabled();
  expect(state.writes).toHaveLength(2);
  expect(state.entries[0]).toMatchObject({
    title: "Мой несохранённый заголовок",
    details: "Мои несохранённые подробности 🧳",
    completed: false,
  });
  await list
    .getByRole("button", { name: "Добавить пункт", exact: true })
    .click();
  await title.fill("Новый несохранённый пункт");
  await details.fill("Останется до отмены");
  await expect(
    list.getByRole("checkbox", {
      name: "Мой несохранённый заголовок",
      exact: true,
    }),
  ).toBeDisabled();
  expect(state.writes).toHaveLength(2);
  await list
    .getByRole("button", { name: "Отмена пункта", exact: true })
    .click();
  await list
    .getByRole("checkbox", { name: "Мой несохранённый заголовок", exact: true })
    .click();
  await expect(
    list.getByRole("checkbox", {
      name: "Мой несохранённый заголовок",
      exact: true,
    }),
  ).toBeChecked();
  expect(state.writes).toHaveLength(3);
  await list
    .getByRole("button", { name: "Удалить пункт", exact: true })
    .click();
  await expect(
    list.getByRole("checkbox", {
      name: "Мой несохранённый заголовок",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    list.getByRole("button", { name: "Изменить пункт", exact: true }),
  ).toBeDisabled();
  await expect(
    list.getByRole("button", { name: "Удалить пункт", exact: true }),
  ).toBeDisabled();
  await expect(
    list.getByRole("button", { name: "Добавить пункт", exact: true }),
  ).toBeDisabled();
  await expect(
    list.getByRole("button", {
      name: "Подтвердить удаление пункта",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    list.getByRole("button", { name: "Оставить пункт", exact: true }),
  ).toBeEnabled();
  expect(state.writes).toHaveLength(3);
  await page.screenshot({
    path: info.outputPath("checklist-removal-decision-guard.png"),
    fullPage: true,
  });
  await list
    .getByRole("button", { name: "Оставить пункт", exact: true })
    .click();
  await expect(
    list.getByRole("checkbox", {
      name: "Мой несохранённый заголовок",
      exact: true,
    }),
  ).toBeEnabled();
  expect(item.status).toBe("pending");
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("checklist interaction blocks parent search reset and filters without losing drafts or removal choices", async ({
  page,
  context,
}) => {
  const { state } = await fixture(context);
  await page.goto("/");
  await open(page);
  const list = panel(page),
    search = page.getByRole("search", { name: "Поиск в моём плане" });
  await search.getByLabel("Найти шаг", { exact: true }).fill("Подготовка");
  await list
    .getByRole("button", { name: "Добавить пункт", exact: true })
    .click();
  await list
    .getByLabel("Название пункта", { exact: true })
    .fill("Несохранённый пункт");
  await list
    .getByLabel("Подробности пункта", { exact: true })
    .fill("Не терять мои подробности");
  const before = state.planReads;
  await expect(
    search.getByRole("button", { name: "Найти", exact: true }),
  ).toBeDisabled();
  await expect(
    search.getByRole("button", { name: "Сбросить", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: /^В работе / })).toBeDisabled();
  await search.evaluate((form) =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  await search
    .getByRole("button", { name: "Сбросить", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(list.getByLabel("Название пункта", { exact: true })).toHaveValue(
    "Несохранённый пункт",
  );
  await expect(
    list.getByRole("textbox", { name: "Подробности пункта", exact: true }),
  ).toHaveValue("Не терять мои подробности");
  expect(state.planReads).toBe(before);
  expect(state.writes).toHaveLength(0);
  await list
    .getByRole("button", { name: "Отмена пункта", exact: true })
    .click();
  await expect(
    search.getByRole("button", { name: "Найти", exact: true }),
  ).toBeEnabled();
  await list
    .getByRole("button", { name: "Добавить пункт", exact: true })
    .click();
  await list
    .getByLabel("Название пункта", { exact: true })
    .fill("Сохранённый пункт");
  await list
    .getByRole("button", { name: "Сохранить пункт", exact: true })
    .click();
  await expect(
    list.getByRole("checkbox", { name: "Сохранённый пункт", exact: true }),
  ).toBeVisible();
  await list
    .getByRole("button", { name: "Удалить пункт", exact: true })
    .click();
  const savedReads = state.planReads;
  await expect(
    search.getByRole("button", { name: "Сбросить", exact: true }),
  ).toBeDisabled();
  await search.evaluate((form) =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  await expect(
    list.getByRole("button", {
      name: "Подтвердить удаление пункта",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.planReads).toBe(savedReads);
  expect(state.writes).toHaveLength(1);
  await list
    .getByRole("button", { name: "Оставить пункт", exact: true })
    .click();
  await expect(
    search.getByRole("button", { name: "Найти", exact: true }),
  ).toBeEnabled();
  await search.getByRole("button", { name: "Найти", exact: true }).click();
  await expect.poll(() => state.planReads).toBeGreaterThan(savedReads);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});
test("uncertain checklist result blocks parent search even after editor cancellation until explicit readback", async ({
  page,
  context,
}) => {
  const { state } = await fixture(context);
  await page.goto("/");
  await open(page);
  const list = panel(page),
    search = page.getByRole("search", { name: "Поиск в моём плане" });
  await search.getByLabel("Найти шаг", { exact: true }).fill("Подготовка");
  await list
    .getByRole("button", { name: "Добавить пункт", exact: true })
    .click();
  await list
    .getByLabel("Название пункта", { exact: true })
    .fill("Неопределённый результат");
  state.lostReceipt = true;
  await list
    .getByRole("button", { name: "Сохранить пункт", exact: true })
    .click();
  await expect(list.getByRole("alert")).toContainText("уже могло сохраниться");
  await list
    .getByRole("button", { name: "Отмена пункта", exact: true })
    .click();
  await expect(
    search.getByRole("button", { name: "Найти", exact: true }),
  ).toBeDisabled();
  await expect(
    search.getByRole("button", { name: "Сбросить", exact: true }),
  ).toBeDisabled();
  const before = state.planReads;
  await search.evaluate((form) =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(state.planReads).toBe(before);
  expect(state.writes).toHaveLength(1);
  await list
    .getByRole("button", { name: "Обновить чек-лист", exact: true })
    .click();
  await expect(
    list.getByRole("checkbox", {
      name: "Неопределённый результат",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    search.getByRole("button", { name: "Найти", exact: true }),
  ).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("missing checklist parent releases plan refresh and search without leaving the plan", async ({
  page,
  context,
}) => {
  const { state, item } = await fixture(context);
  await page.goto("/");
  await page.getByRole("button", { name: "Мой план", exact: true }).click();
  state.missingParent = true;
  await page.getByRole("button", { name: "Чек-лист", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "Шаг больше недоступен",
  );
  await expect(
    panel(page).getByRole("button", { name: "Скрыть чек-лист", exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .getByRole("search", { name: "Поиск в моём плане" })
      .getByRole("button", { name: "Найти", exact: true }),
  ).toBeEnabled();
  const before = state.planReads;
  await page
    .getByRole("button", { name: "Обновить план", exact: true })
    .click();
  await expect.poll(() => state.planReads).toBeGreaterThan(before);
  await expect(page.locator(`[data-plan-id="${item.id}"]`)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Начнём с того, что важно вам" }),
  ).toBeVisible();
  expect(state.checklistReads).toBe(1);
  expect(state.writes).toHaveLength(0);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("checklist save 404 preserves the visible draft until explicit cancellation then allows parent refresh", async ({
  page,
  context,
}) => {
  const { state, item } = await fixture(context);
  await page.goto("/");
  await open(page);
  const list = panel(page);
  await list
    .getByRole("button", { name: "Добавить пункт", exact: true })
    .click();
  await list
    .getByLabel("Название пункта", { exact: true })
    .fill("Несохранённый пункт 🧳");
  await list
    .getByLabel("Подробности пункта", { exact: true })
    .fill("Скопировать перед отменой");
  state.missingParent = true;
  const before = state.planReads;
  await list
    .getByRole("button", { name: "Сохранить пункт", exact: true })
    .click();
  await expect(list.getByRole("alert")).toContainText("Шаг больше недоступен");
  await expect(list.getByLabel("Название пункта", { exact: true })).toHaveValue(
    "Несохранённый пункт 🧳",
  );
  await expect(
    list.getByLabel("Подробности пункта", { exact: true }),
  ).toHaveValue("Скопировать перед отменой");
  await expect(
    list.getByLabel("Название пункта", { exact: true }),
  ).toHaveAttribute("readonly", "");
  await expect(
    list.getByRole("button", { name: "Сохранить пункт", exact: true }),
  ).toBeDisabled();
  await expect(
    list.getByRole("button", { name: "Скрыть чек-лист", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Обновить план", exact: true }),
  ).toBeDisabled();
  expect(state.planReads).toBe(before);
  expect(state.writes).toHaveLength(1);
  await list
    .getByRole("button", { name: "Отмена пункта", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Обновить план", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Обновить план", exact: true })
    .click();
  await expect(page.locator(`[data-plan-id="${item.id}"]`)).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.entries).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("authorized missing readback releases an uncertain checklist lock without repeating its write", async ({
  page,
  context,
}) => {
  const { state, item } = await fixture(context);
  await page.goto("/");
  await open(page);
  const list = panel(page);
  await list
    .getByRole("button", { name: "Добавить пункт", exact: true })
    .click();
  await list
    .getByLabel("Название пункта", { exact: true })
    .fill("Возможно сохранённый пункт");
  state.lostReceipt = true;
  await list
    .getByRole("button", { name: "Сохранить пункт", exact: true })
    .click();
  await expect(list.getByRole("alert")).toContainText("уже могло сохраниться");
  await list
    .getByRole("button", { name: "Отмена пункта", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Обновить план", exact: true }),
  ).toBeDisabled();
  state.missingParent = true;
  await list
    .getByRole("button", { name: "Обновить чек-лист", exact: true })
    .click();
  await expect(list.getByRole("alert")).toContainText("Шаг больше недоступен");
  await expect(
    page.getByRole("button", { name: "Обновить план", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Обновить план", exact: true })
    .click();
  await expect(page.locator(`[data-plan-id="${item.id}"]`)).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.checklistReads).toBe(2);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("missing parent keeps the checklist removal decision cancellable before refreshing the plan", async ({
  page,
  context,
}) => {
  const { state, item } = await fixture(context);
  state.entries = [
    {
      id: "726b704a-3ce0-40c0-b935-edff98b63dad",
      title: "Существующий пункт",
      details: "",
      completed: false,
    },
  ];
  await page.goto("/");
  await page.getByRole("button", { name: "Мой план", exact: true }).click();
  await page.getByRole("button", { name: "Чек-лист", exact: true }).click();
  const list = panel(page);
  await expect(
    list.getByRole("checkbox", { name: "Существующий пункт", exact: true }),
  ).toBeVisible();
  await list
    .getByRole("button", { name: "Удалить пункт", exact: true })
    .click();
  state.missingParent = true;
  await list
    .getByRole("button", { name: "Подтвердить удаление пункта", exact: true })
    .click();
  await expect(list.getByRole("alert")).toContainText("Шаг больше недоступен");
  await expect(
    list.getByRole("button", { name: "Оставить пункт", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Обновить план", exact: true }),
  ).toBeDisabled();
  await list
    .getByRole("button", { name: "Оставить пункт", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Обновить план", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Обновить план", exact: true })
    .click();
  await expect(page.locator(`[data-plan-id="${item.id}"]`)).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.entries).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});
