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
    if (path === "/api/v1/personal-plan")
      return route.fulfill({
        json: {
          userId: state.owner,
          items: state.owner === "101" ? [item] : [],
          nextBefore: null,
        },
      });
    if (path === "/api/v1/personal-plan/summary")
      return route.fulfill({
        json: {
          userId: state.owner,
          total: state.owner === "101" ? 1 : 0,
          pending: state.owner === "101" ? 1 : 0,
          completed: 0,
        },
      });
    if (path === "/api/v1/personal-plan/" + item.id + "/checklist") {
      if (method === "PUT") {
        const input = route.request().postDataJSON() as SavePlanChecklist;
        state.writes.push(input);
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
