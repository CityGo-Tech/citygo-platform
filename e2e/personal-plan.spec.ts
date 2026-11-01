import { readFile } from "node:fs/promises";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type {
  CreatePersonalPlanItem,
  Dashboard,
  Message,
  PersonalPlanItem,
  UpdatePersonalPlanItem,
} from "@citygo/contracts";

const stamp = "2026-10-24T10:00:00.000Z";
const item = (
  id = "9007199254741030",
  title = "Подготовить список районов",
): PersonalPlanItem => ({
  id,
  title,
  details: "Сравнить дорогу и стоимость жилья",
  status: "pending",
  revision: 1,
  source: { messageId: "11", threadId: "10", role: "assistant" },
  createdAt: stamp,
  updatedAt: stamp,
});

test("saved step history compares exact versions and checklist, pages without writes, restores focus and hides private text", async ({
  page,
  context,
}, info) => {
  const row = { ...item(), source: null, revision: 7 };
  const state = await fixture(context, [row]);
  const reads: (string | null)[] = [];
  await page.route("**/api/v1/personal-plan/*/history*", async (route) => {
    expect(route.request().method()).toBe("GET");
    const before = new URL(route.request().url()).searchParams.get("before");
    reads.push(before);
    const versions = before ? [2, 1] : [7, 6, 5, 4, 3];
    await route.fulfill({
      json: {
        userId: "101",
        itemId: row.id,
        currentRevision: 7,
        entries: versions.map((revision) => ({
          revision,
          title: "ЛИЧНАЯ_ВЕРСИЯ_" + revision,
          details: "ЛИЧНЫЕ_ПОДРОБНОСТИ_" + revision,
          status: revision === 7 ? "completed" : "pending",
          checklist: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              title: "ЛИЧНЫЙ_ПУНКТ_" + revision,
              details: "Сохранённая деталь",
              completed: revision === 7,
            },
          ],
          initialSnapshot: revision === 1,
          recordedAt: stamp,
        })),
        nextBefore: before ? null : 3,
      },
    });
  });
  await page.goto("/");
  await openPlan(page);
  const trigger = page.getByRole("button", {
    name: "Что изменилось",
    exact: true,
  });
  await trigger.click();
  const history = page.getByRole("region", {
    name: "История изменений шага",
    exact: true,
  });
  await expect(
    history.getByRole("heading", { name: "Что изменилось", exact: true }),
  ).toBeFocused();
  const current = history.getByRole("region", {
    name: "Текущая версия",
    exact: true,
  });
  const prior = history.getByRole("region", {
    name: "Выбранная версия",
    exact: true,
  });
  await expect(current).toContainText("ЛИЧНАЯ_ВЕРСИЯ_7");
  await expect(current).toContainText("ЛИЧНЫЙ_ПУНКТ_7");
  await expect(prior).toContainText("ЛИЧНАЯ_ВЕРСИЯ_6");
  await history.getByRole("button", { name: "Версия 4", exact: true }).click();
  await expect(prior).toContainText("ЛИЧНЫЕ_ПОДРОБНОСТИ_4");
  await history
    .getByRole("button", { name: "Более ранние версии", exact: true })
    .click();
  await expect(prior).toContainText("ЛИЧНАЯ_ВЕРСИЯ_2");
  await expect(current).toContainText("ЛИЧНАЯ_ВЕРСИЯ_7");
  await expect(history).toContainText(
    "Более ранние изменения не восстанавливались",
  );
  expect(
    await history.evaluate((element) =>
      element.classList.contains("ym-hide-content"),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain("ЛИЧНАЯ");
  expect(page.url()).not.toContain(row.id);
  expect(page.url()).not.toContain("ЛИЧНАЯ");
  await history.screenshot({
    path: info.outputPath("plan-history-comparison.png"),
  });
  const previousCompletions = state.listCompletions;
  state.holdList = true;
  await history
    .getByRole("button", { name: "← В мой план", exact: true })
    .click();
  await expect(planPanel(page)).toHaveAttribute("aria-busy", "true");
  await expect(trigger).toBeDisabled();
  await expect(trigger).not.toBeFocused();
  expect(state.listCompletions).toBe(previousCompletions);
  state.releaseList();
  await expect(trigger).toBeEnabled();
  await expect(trigger).toBeFocused();
  expect(state.listCompletions).toBe(previousCompletions + 1);
  expect(reads[0]).toBe(null);
  expect(reads.filter((value) => value !== null)).toEqual(["3"]);
  expect(state.posts).toEqual([]);
  expect(state.updates).toEqual([]);
  expect(state.removes).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.forbidden).toEqual([]);
});

test("a foreign history receipt clears the private view instead of showing another account's versions", async ({
  page,
  context,
}) => {
  const row = { ...item(), source: null };
  await fixture(context, [row]);
  await page.route("**/api/v1/personal-plan/*/history*", async (route) =>
    route.fulfill({
      json: {
        userId: "202",
        itemId: row.id,
        currentRevision: 1,
        entries: [
          {
            revision: 1,
            title: "FOREIGN_PRIVATE_HISTORY",
            details: "",
            status: "pending",
            checklist: [],
            initialSnapshot: false,
            recordedAt: stamp,
          },
        ],
        nextBefore: null,
      },
    }),
  );
  await page.goto("/");
  await openPlan(page);
  await page
    .getByRole("button", { name: "Что изменилось", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "История изменений шага", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("FOREIGN_PRIVATE_HISTORY", { exact: true }),
  ).toHaveCount(0);
});
const planPanel = (page: Page) =>
  page.getByRole("region", { name: "Мой план переезда", exact: true });
async function openPlan(page: Page) {
  await page.getByRole("button", { name: "Мой план", exact: true }).click();
  await expect(planPanel(page).getByRole("heading", { level: 1 })).toHaveText(
    "Ваш переезд — понятными шагами",
  );
}
async function chooseMessage(page: Page, index = 1) {
  await page
    .getByRole("log")
    .getByRole("button", { name: "Добавить шаг в план", exact: true })
    .nth(index)
    .click();
  return page.getByRole("region", {
    name: "Добавление шага в план",
    exact: true,
  });
}

/** Synthetic transport only. This fixture rejects external traffic and counts forbidden side effects. */
async function fixture(
  context: BrowserContext,
  initial: PersonalPlanItem[] = [],
) {
  const state = {
    owner: "101",
    authenticated: true,
    items: initial,
    responseOwner: null as string | null,
    reads: [] as (string | null)[],
    statusReads: [] as (string | null)[],
    searchReads: [] as (string | null)[],
    summaryReads: 0,
    listCompletions: 0,
    failSummary: false,
    sourceHistory: null as Message[] | null,
    sourceMissing: false,
    posts: [] as CreatePersonalPlanItem[],
    updates: [] as UpdatePersonalPlanItem[],
    removes: [] as { expectedRevision: number }[],
    sourceReads: [] as string[],
    external: 0,
    forbidden: [] as string[],
    lostCreateReceipt: false,
    conflictNext: false,
    holdList: false,
    holdCreate: false,
    releaseList: () => {},
    releaseCreate: () => {},
  };
  const listGate = new Promise<void>((resolve) => {
    state.releaseList = resolve;
  });
  const createGate = new Promise<void>((resolve) => {
    state.releaseCreate = resolve;
  });
  const thread = (owner: string) => ({
    id: owner === "101" ? "10" : "20",
    agentKey: "support" as const,
    assistantKey: null,
    closed: false,
    messages: [
      {
        id: owner === "101" ? "10" : "20",
        role: "user" as const,
        agentKey: "support" as const,
        status: "complete" as const,
        content:
          owner === "101" ? "Мой вопрос о районах" : "ВОПРОС_НОВОГО_ВЛАДЕЛЬЦА",
      },
      {
        id: owner === "101" ? "11" : "21",
        role: "assistant" as const,
        agentKey: "support" as const,
        status: "complete" as const,
        content:
          owner === "101"
            ? "Сравните районы по времени в пути"
            : "ОТВЕТ_НОВОГО_ВЛАДЕЛЬЦА",
      },
    ],
  });
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: "owner-" + state.owner + "@example.test",
      role: "user",
      mustChangePassword: false,
    },
    profile: null,
    quests: [],
    xp: 0,
    thread: thread(state.owner),
    provider: "unconfigured",
    aiAccess: { granted: false, dailyLimit: 0, policy: null },
  });
  await context.route("https://**", (route) => {
    state.external++;
    return route.abort();
  });
  await context.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
    if (
      route.request().method() === "GET" &&
      new URL(route.request().url()).origin === "http://localhost:3000" &&
      new URL(route.request().url()).pathname ===
        "/api/v1/auth/registration-policy"
    )
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (path === "/api/v1/auth/logout") {
      state.authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (!state.authenticated)
      return route.fulfill({ status: 401, json: { error: "Signed out" } });
    if (path === "/api/v1/dashboard") return route.fulfill({ json: board() });
    const sourceContext = path.match(
      /^\/api\/v1\/conversations\/(10|20)\/messages\/(\d+)\/context$/,
    );
    if (sourceContext && request.method() === "GET") {
      state.sourceReads.push(path);
      if (state.sourceMissing)
        return route.fulfill({
          status: 404,
          json: { error: "Source unavailable" },
        });
      return route.fulfill({
        json: {
          userId: state.owner,
          threadId: sourceContext[1],
          messages:
            state.sourceHistory ??
            thread(state.owner).messages.filter(
              (message) => BigInt(message.id) <= BigInt(sourceContext[2]!),
            ),
          nextCursor: null,
        },
      });
    }
    if (
      path === "/api/v1/conversations/10" ||
      path === "/api/v1/conversations/20"
    ) {
      state.sourceReads.push(path.split("/").at(-1)!);
      return route.fulfill({
        json: { userId: state.owner, thread: thread(state.owner) },
      });
    }
    if (
      path === "/api/v1/personal-plan/summary" &&
      request.method() === "GET"
    ) {
      state.summaryReads++;
      if (state.failSummary)
        return route.fulfill({
          status: 503,
          json: { error: "Summary unavailable" },
        });
      const rows = state.owner === "101" ? state.items : [];
      return route.fulfill({
        json: {
          userId: state.responseOwner ?? state.owner,
          total: rows.length,
          pending: rows.filter((row) => row.status === "pending").length,
          completed: rows.filter((row) => row.status === "completed").length,
        },
      });
    }
    if (path === "/api/v1/personal-plan" && request.method() === "GET") {
      const owner = state.owner,
        before = url.searchParams.get("before"),
        status = url.searchParams.get("status");
      state.reads.push(before);
      state.statusReads.push(status);
      const search = url.searchParams.get("search");
      state.searchReads.push(search);
      const rows =
        owner === "101"
          ? state.items.filter(
              (row) =>
                (!before || BigInt(row.id) < BigInt(before)) &&
                (!status || row.status === status) &&
                (!search ||
                  (row.title + "\n" + row.details)
                    .toLowerCase()
                    .includes(search.toLowerCase())),
            )
          : [];
      const page = {
        userId: state.responseOwner ?? owner,
        items: rows.slice(0, 20),
        nextBefore: rows.length > 20 ? rows[19]!.id : null,
      };
      if (state.holdList && owner === "101" && status === null) await listGate;
      try {
        await route.fulfill({ json: page });
      } catch {
        /* Invalidated view. */
      } finally {
        state.listCompletions++;
      }
      return;
    }
    if (path === "/api/v1/personal-plan" && request.method() === "POST") {
      const input = request.postDataJSON() as CreatePersonalPlanItem;
      state.posts.push(input);
      const saved = state.items.find((row) => row.title === input.title) ?? {
        ...item("9007199254741031", input.title),
        details: input.details,
        source:
          input.sourceMessageId === null
            ? null
            : {
                messageId: input.sourceMessageId,
                threadId: "10",
                role:
                  input.sourceMessageId === "10"
                    ? ("user" as const)
                    : ("assistant" as const),
              },
      };
      if (!state.items.some((row) => row.id === saved.id))
        state.items.unshift(saved);
      const receipt = {
        userId: state.responseOwner ?? state.owner,
        item: saved,
      };
      if (state.holdCreate) await createGate;
      if (state.lostCreateReceipt && state.posts.length === 1)
        return route.abort("failed");
      try {
        await route.fulfill({ json: receipt });
      } catch {
        /* Invalidated session. */
      }
      return;
    }
    const mutation = path.match(/^\/api\/v1\/personal-plan\/(\d+)$/);
    if (mutation && request.method() === "PATCH") {
      const input = request.postDataJSON() as UpdatePersonalPlanItem;
      state.updates.push(input);
      const row = state.items.find((value) => value.id === mutation[1])!;
      if (state.conflictNext) {
        state.conflictNext = false;
        row.revision++;
        row.title = "Изменено в другом окне";
        return route.fulfill({
          status: 409,
          json: {
            error: "Conflict",
            code: "REVISION_CONFLICT",
            currentVersion: row.revision,
          },
        });
      }
      expect(input.expectedRevision).toBe(row.revision);
      Object.assign(row, {
        title: input.title,
        details: input.details,
        status: input.status,
        revision: row.revision + 1,
      });
      return route.fulfill({ json: { userId: state.owner, item: row } });
    }
    if (mutation && request.method() === "DELETE") {
      const input = request.postDataJSON() as { expectedRevision: number };
      state.removes.push(input);
      expect(input.expectedRevision).toBe(
        state.items.find((value) => value.id === mutation[1])!.revision,
      );
      state.items = state.items.filter((value) => value.id !== mutation[1]);
      return route.fulfill({
        json: { userId: state.owner, itemId: mutation[1], removed: true },
      });
    }
    state.forbidden.push(request.method() + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected fixture request" },
    });
  });
  return state;
}

test("explicit message preview, CRUD revisions, source and reload preserve a personal step", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  await page.goto("/");
  await openPlan(page);
  await expect(planPanel(page)).toContainText("Начнём с того, что важно вам");
  await planPanel(page)
    .getByRole("button", { name: "Открыть диалог", exact: true })
    .click();
  const form = await chooseMessage(page);
  expect(state.posts).toEqual([]);
  await form
    .getByLabel("Название шага", { exact: true })
    .fill("Проверить дорогу до работы");
  await form
    .getByLabel("Описание шага", { exact: true })
    .fill("Сравнить три района и время в пути.");
  await form
    .getByRole("button", { name: "Подтвердить добавление", exact: true })
    .click();
  const panel = planPanel(page);
  await expect(panel).toContainText("Проверить дорогу до работы");
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]?.sourceMessageId).toBe("11");
  const entry = panel.getByRole("article").first();
  await entry.getByRole("button", { name: "Изменить", exact: true }).click();
  await entry
    .getByLabel("Название шага", { exact: true })
    .fill("Сравнить три района");
  await entry
    .getByRole("button", { name: "Сохранить изменения", exact: true })
    .click();
  await expect(
    entry.getByRole("heading", { name: "Сравнить три района", exact: true }),
  ).toBeVisible();
  await entry
    .getByRole("button", { name: "Отметить выполненным", exact: true })
    .click();
  await expect(entry).toContainText("ВЫПОЛНЕНО");
  await entry
    .getByRole("button", { name: "Вернуть в работу", exact: true })
    .click();
  expect(state.updates.map((value) => value.expectedRevision)).toEqual([
    1, 2, 3,
  ]);
  await panel.screenshot({
    path: info.outputPath("personal-plan-populated.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await entry
    .getByRole("button", { name: "Открыть исходное сообщение", exact: true })
    .click();
  await expect(page.getByRole("log")).toContainText("Сравните районы");
  expect(state.sourceReads).toContain(
    "/api/v1/conversations/10/messages/11/context",
  );
  await page.reload();
  await openPlan(page);
  await expect(entry).toContainText("Сравнить три района");
  await entry.getByRole("button", { name: "Удалить", exact: true }).click();
  expect(state.removes).toHaveLength(0);
  await entry
    .getByRole("button", { name: "Подтвердить удаление", exact: true })
    .click();
  await expect(panel).toContainText("Начнём с того, что важно вам");
  expect(state.removes).toEqual([{ expectedRevision: 4 }]);
  expect(state.external).toBe(0);
  expect(state.forbidden).toEqual([]);
});

test("own user message can become a step, with frozen idempotent retry after a lost receipt", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.lostCreateReceipt = true;
  await page.goto("/");
  const form = await chooseMessage(page, 0);
  await form
    .getByLabel("Название шага", { exact: true })
    .fill("Мой выбранный шаг");
  await form
    .getByRole("button", { name: "Подтвердить добавление", exact: true })
    .click();
  await expect(form.getByRole("alert")).toContainText("уже мог сохраниться");
  await expect(
    form.getByLabel("Название шага", { exact: true }),
  ).toBeDisabled();
  await expect(
    form.getByLabel("Описание шага", { exact: true }),
  ).toBeDisabled();
  await form
    .getByRole("button", { name: "Повторить тот же запрос", exact: true })
    .click();
  await expect(planPanel(page)).toContainText("Мой выбранный шаг");
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1]).toEqual(state.posts[0]);
  expect(state.items).toHaveLength(1);
  expect(state.posts[0]?.sourceMessageId).toBe("10");
  expect(state.external).toBe(0);
  expect(state.forbidden).toEqual([]);
});

for (const lostReceipt of [false, true]) {
  test(`an already open plan reloads after ${lostReceipt ? "closing an uncertain create" : "a confirmed create"}`, async ({
    page,
    context,
  }) => {
    const state = await fixture(context);
    state.lostCreateReceipt = lostReceipt;
    await page.goto("/");
    const form = await chooseMessage(page);
    const title = lostReceipt
      ? "Сохранённый шаг без квитанции"
      : "Шаг после открытия плана";
    await form.getByLabel("Название шага", { exact: true }).fill(title);
    // The composer persists while this first, still-empty plan page loads.
    await openPlan(page);
    await expect(planPanel(page)).toContainText("Начнём с того, что важно вам");
    expect(state.reads).toEqual([null]);
    await form
      .getByRole("button", { name: "Подтвердить добавление", exact: true })
      .click();
    if (lostReceipt) {
      await expect(form.getByRole("alert")).toContainText(
        "уже мог сохраниться",
      );
      await expect(planPanel(page).getByRole("article")).toHaveCount(0);
      await form
        .getByRole("button", { name: "Закрыть и проверить план", exact: true })
        .click();
    }
    await expect(form).toHaveCount(0);
    await expect(planPanel(page).getByRole("article")).toContainText(title);
    expect(state.reads).toEqual([null, null]);
    expect(state.posts).toHaveLength(1);
    expect(state.items).toHaveLength(1);
    expect(state.external).toBe(0);
    expect(state.forbidden).toEqual([]);
  });
}

test("a revision conflict blocks mutations until explicit refresh and never silently overwrites", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [item()]);
  state.conflictNext = true;
  await page.goto("/");
  await openPlan(page);
  const panel = planPanel(page),
    entry = panel.getByRole("article").first();
  await entry
    .getByRole("button", { name: "Отметить выполненным", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("Шаг уже изменён");
  await expect(
    entry.getByRole("button", { name: "Отметить выполненным", exact: true }),
  ).toBeDisabled();
  expect(state.updates).toHaveLength(1);
  await panel
    .getByRole("button", { name: "Обновить список", exact: true })
    .click();
  await expect(entry).toContainText("Изменено в другом окне");
  await entry
    .getByRole("button", { name: "Отметить выполненным", exact: true })
    .click();
  await expect(entry).toContainText("ВЫПОЛНЕНО");
  expect(state.updates.map((value) => value.expectedRevision)).toEqual([1, 2]);
});

test("plan pagination retains exact bigint IDs and no horizontal overflow", async ({
  page,
  context,
}, info) => {
  const rows = Array.from({ length: 21 }, (_, index) =>
    item((9007199254741030n - BigInt(index)).toString(), "Шаг " + (index + 1)),
  );
  const state = await fixture(context, rows);
  await page.goto("/");
  await openPlan(page);
  const panel = planPanel(page);
  await expect(panel.getByRole("article")).toHaveCount(20);
  await panel
    .getByRole("button", { name: "Показать ещё шаги", exact: true })
    .click();
  await expect(panel.getByRole("article")).toHaveCount(21);
  expect(state.reads).toEqual([null, rows[19]!.id]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("personal-plan-full-page.png"),
    fullPage: true,
  });
});

test("whole-plan progress and status pagination find steps beyond the first twenty with keyboard controls", async ({
  page,
  context,
}, info) => {
  if (info.project.name === "mobile-web")
    await page.setViewportSize({ width: 375, height: 812 });
  const rows = Array.from({ length: 45 }, (_, index) => ({
    ...item(String(9007199254741200n - BigInt(index)), "Шаг " + (index + 1)),
    status: index < 23 ? ("completed" as const) : ("pending" as const),
  }));
  const state = await fixture(context, rows);
  await page.goto("/");
  await openPlan(page);
  const panel = planPanel(page),
    filters = panel.getByRole("navigation", { name: "Статус шагов плана" });
  await expect(
    panel.getByRole("progressbar", { name: "Выполнено 23 из 45", exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("article")).toHaveCount(20);
  const pending = filters.getByRole("button", { name: /^В работе\s+22$/ });
  await pending.focus();
  await pending.press("Space");
  await expect(pending).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("article")).toHaveCount(20);
  await expect(
    panel.getByRole("heading", { name: "Шаг 24", exact: true }),
  ).toBeVisible();
  expect(state.statusReads.at(-1)).toBe("pending");
  await panel
    .getByRole("progressbar", { name: "Выполнено 23 из 45", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath(`plan-progress-${info.project.name}.png`),
  });
  await panel
    .getByRole("button", { name: "Показать ещё шаги", exact: true })
    .click();
  await expect(panel.getByRole("article")).toHaveCount(22);
  expect(state.reads.at(-1)).toBe(rows[42]!.id);
  expect(state.statusReads.at(-1)).toBe("pending");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(state.posts).toEqual([]);
  expect(state.updates).toEqual([]);
  expect(state.removes).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.forbidden).toEqual([]);
});

test("completing and reopening a step refresh the selected filter and all summary counts", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [
    item("30", "Первый шаг"),
    item("29", "Второй шаг"),
  ]);
  await page.goto("/");
  await openPlan(page);
  const panel = planPanel(page),
    filters = panel.getByRole("navigation", { name: "Статус шагов плана" });
  await filters.getByRole("button", { name: /^В работе\s+2$/ }).click();
  await panel
    .getByRole("article")
    .first()
    .getByRole("button", { name: "Отметить выполненным", exact: true })
    .click();
  await expect(panel.getByRole("article")).toHaveCount(1);
  await expect(
    panel.getByRole("progressbar", { name: "Выполнено 1 из 2", exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("article")
    .first()
    .getByRole("button", { name: "Отметить выполненным", exact: true })
    .click();
  await expect(panel).toContainText("Нет шагов в работе");
  await expect(panel).not.toContainText("Начнём с того, что важно вам");
  await filters.getByRole("button", { name: /^Выполнено\s+2$/ }).click();
  await expect(panel.getByRole("article")).toHaveCount(2);
  await panel
    .getByRole("article")
    .first()
    .getByRole("button", { name: "Вернуть в работу", exact: true })
    .click();
  await expect(panel.getByRole("article")).toHaveCount(1);
  await expect(
    panel.getByRole("progressbar", { name: "Выполнено 1 из 2", exact: true }),
  ).toBeVisible();
  expect(state.statusReads.at(-1)).toBe("completed");
  expect(state.summaryReads).toBeGreaterThanOrEqual(6);
  expect(state.external).toBe(0);
  expect(state.forbidden).toEqual([]);
});

test("deleting the last completed step refreshes progress without losing a pending step", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [
    { ...item("30", "Готовый шаг"), status: "completed" },
    item("29", "В работе"),
  ]);
  await page.goto("/");
  await openPlan(page);
  const panel = planPanel(page);
  await panel
    .getByRole("navigation", { name: "Статус шагов плана" })
    .getByRole("button", { name: /^Выполнено\s+1$/ })
    .click();
  const entry = panel.getByRole("article").first();
  await entry.getByRole("button", { name: "Удалить", exact: true }).click();
  await entry
    .getByRole("button", { name: "Подтвердить удаление", exact: true })
    .click();
  await expect(panel).toContainText("Выполненных шагов пока нет");
  await expect(
    panel.getByRole("progressbar", { name: "Выполнено 0 из 1", exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Показать все шаги", exact: true })
    .click();
  await expect(panel.getByRole("article")).toHaveCount(1);
  await expect(
    panel.getByRole("heading", { name: "В работе", exact: true }),
  ).toBeVisible();
  expect(state.items).toHaveLength(1);
  expect(state.removes).toEqual([{ expectedRevision: 1 }]);
  expect(state.forbidden).toEqual([]);
});

test("a filter change cancels the old page and a summary failure requires an explicit retry", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [
    { ...item("30", "OLD_COMPLETED_PAGE"), status: "completed" },
    item("29", "Текущий шаг"),
  ]);
  state.holdList = true;
  try {
    await page.goto("/");
    await openPlan(page);
    const panel = planPanel(page);
    await expect.poll(() => state.reads.length).toBe(1);
    await panel
      .getByRole("navigation", { name: "Статус шагов плана" })
      .getByRole("button", { name: /^В работе/ })
      .click();
    await expect(
      panel.getByRole("heading", { name: "Текущий шаг", exact: true }),
    ).toBeVisible();
    state.releaseList();
    await expect.poll(() => state.listCompletions).toBeGreaterThanOrEqual(2);
    await expect(
      panel.getByText("OLD_COMPLETED_PAGE", { exact: true }),
    ).toHaveCount(0);
    state.failSummary = true;
    await panel
      .getByRole("button", { name: "Обновить план", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toContainText(
      "Не удалось загрузить план",
    );
    await expect(
      panel.getByRole("button", { name: "Отметить выполненным", exact: true }),
    ).toBeDisabled();
    state.failSummary = false;
    await panel
      .getByRole("button", { name: "Обновить список", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Отметить выполненным", exact: true }),
    ).toBeEnabled();
    expect(state.statusReads.at(-1)).toBe("pending");
    expect(state.forbidden).toEqual([]);
  } finally {
    state.releaseList();
  }
});

test("a step opens its exact older non-favorite source and returns to the same filtered plan", async ({
  page,
  context,
}) => {
  const saved = {
    ...item("30", "Шаг из старого ответа"),
    status: "completed" as const,
    source: { messageId: "5", threadId: "10", role: "assistant" as const },
  };
  const state = await fixture(context, [saved]);
  state.sourceHistory = [
    {
      id: "4",
      role: "user",
      agentKey: "support",
      status: "complete",
      content: "Старый вопрос",
      favorite: false,
    },
    {
      id: "5",
      role: "assistant",
      agentKey: "support",
      status: "complete",
      content: "ТОЧНЫЙ_СТАРЫЙ_ИСТОЧНИК",
      favorite: false,
    },
  ];
  await page.goto("/");
  await openPlan(page);
  await planPanel(page)
    .getByRole("navigation", { name: "Статус шагов плана" })
    .getByRole("button", { name: /^Выполнено\s+1$/ })
    .click();
  await planPanel(page)
    .getByRole("button", { name: "Открыть исходное сообщение", exact: true })
    .click();
  const source = page.getByRole("region", {
    name: "Исходный диалог",
    exact: true,
  });
  await expect(source.locator('[data-source-message="5"]')).toBeFocused();
  await expect(
    source.getByRole("article", {
      name: "Исходное сообщение шага",
      exact: true,
    }),
  ).toContainText("ТОЧНЫЙ_СТАРЫЙ_ИСТОЧНИК");
  await expect(source).not.toContainText("Сравните районы по времени в пути");
  expect(state.sourceReads).toEqual([
    "/api/v1/conversations/10/messages/5/context",
  ]);
  await source
    .getByRole("button", { name: "← В мой план", exact: true })
    .click();
  await expect(
    planPanel(page)
      .getByRole("navigation", { name: "Статус шагов плана" })
      .getByRole("button", { name: /^Выполнено\s+1$/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    planPanel(page).getByRole("button", {
      name: "Открыть исходное сообщение",
      exact: true,
    }),
  ).toBeFocused();
  expect(state.posts).toEqual([]);
  expect(state.updates).toEqual([]);
  expect(state.forbidden).toEqual([]);
  expect(state.external).toBe(0);
});

test("an unavailable step source has a plan-specific retry and never substitutes the latest conversation", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [item()]);
  state.sourceMissing = true;
  await page.goto("/");
  await openPlan(page);
  await planPanel(page)
    .getByRole("button", { name: "Открыть исходное сообщение", exact: true })
    .click();
  const source = page.getByRole("region", {
    name: "Исходный диалог",
    exact: true,
  });
  await expect(source.getByRole("alert")).toContainText("Вернитесь к плану");
  await expect(source.getByRole("article")).toHaveCount(0);
  expect(state.sourceReads).toHaveLength(1);
  await source
    .getByRole("button", { name: "Повторить загрузку", exact: true })
    .click();
  await expect.poll(() => state.sourceReads.length).toBe(2);
  await source
    .getByRole("button", { name: "← В мой план", exact: true })
    .click();
  await expect(planPanel(page).getByRole("article")).toHaveCount(1);
  expect(state.sourceReads.every((path) => path.endsWith("/context"))).toBe(
    true,
  );
  expect(state.forbidden).toEqual([]);
});

test("another owner's list is never rendered", async ({ page, context }) => {
  const state = await fixture(context, [item("90", "FOREIGN_PRIVATE_PLAN")]);
  state.responseOwner = "303";
  await page.goto("/");
  await page.getByRole("button", { name: "Мой план", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeVisible();
  await expect(planPanel(page)).toHaveCount(0);
  await expect(page.getByText("FOREIGN_PRIVATE_PLAN")).toHaveCount(0);
});

test("a create receipt for another owner invalidates the current account", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.responseOwner = "303";
  await page.goto("/");
  const form = await chooseMessage(page);
  await form
    .getByRole("button", { name: "Подтвердить добавление", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeVisible();
  await expect(form).toHaveCount(0);
  await expect(planPanel(page)).toHaveCount(0);
});

test("late plan list cannot enter a new account after focus changes the server owner", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [item("90", "LATE_PRIVATE_PLAN_A")]);
  state.holdList = true;
  try {
    await page.goto("/");
    await openPlan(page);
    await expect.poll(() => state.reads.length).toBe(1);
    state.owner = "202";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("log")).toContainText(
      "ВОПРОС_НОВОГО_ВЛАДЕЛЬЦА",
    );
    await openPlan(page);
    await expect(planPanel(page)).toContainText("Начнём с того, что важно вам");
    state.releaseList();
    await expect(page.getByText("LATE_PRIVATE_PLAN_A")).toHaveCount(0);
  } finally {
    state.releaseList();
  }
});

test("late create receipt cannot switch the new account into the previous owner's plan", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.holdCreate = true;
  try {
    await page.goto("/");
    const form = await chooseMessage(page);
    await form
      .getByLabel("Название шага", { exact: true })
      .fill("LATE_PRIVATE_CREATE_A");
    await form
      .getByRole("button", { name: "Подтвердить добавление", exact: true })
      .click();
    await expect.poll(() => state.posts.length).toBe(1);
    state.owner = "202";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("log")).toContainText(
      "ВОПРОС_НОВОГО_ВЛАДЕЛЬЦА",
    );
    state.releaseCreate();
    await expect(form).toHaveCount(0);
    await expect(page.getByText("LATE_PRIVATE_CREATE_A")).toHaveCount(0);
    await expect(planPanel(page)).toHaveCount(0);
  } finally {
    state.releaseCreate();
  }
});

test("real local API persists chosen messages and CAS changes without spending or quest completion", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill("plan-" + crypto.randomUUID() + "@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill("123456");
  await page.locator("input[name=personalDataConsent]").check();
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Начать диалог", exact: true })
    .click();
  await page
    .getByLabel("Сообщение помощнику")
    .fill("Синтетический вопрос для локального плана");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Тестовый ответ");
  const form = await chooseMessage(page, 0);
  await form
    .getByLabel("Название шага", { exact: true })
    .fill("Реальный локальный шаг");
  await form
    .getByRole("button", { name: "Подтвердить добавление", exact: true })
    .click();
  const entry = planPanel(page).getByRole("article").first();
  await expect(entry).toContainText("Реальный локальный шаг");
  await entry
    .getByRole("button", { name: "Отметить выполненным", exact: true })
    .click();
  await expect(entry).toContainText("ВЫПОЛНЕНО");
  await page.reload();
  await openPlan(page);
  await expect(entry).toContainText("ВЫПОЛНЕНО");
  await entry
    .getByRole("button", { name: "Открыть исходное сообщение", exact: true })
    .click();
  await expect(page.getByRole("log")).toContainText(
    "Синтетический вопрос для локального плана",
  );
});

test("standalone plan creation survives reload, shows its own origin and exposes no invented message source", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  await openPlan(page);
  await planPanel(page)
    .getByRole("button", { name: "Добавить шаг", exact: true })
    .click();
  const form = page.getByRole("region", {
    name: "Добавление шага в план",
    exact: true,
  });
  await expect(form.getByLabel("Название шага", { exact: true })).toHaveValue(
    "",
  );
  await form
    .getByLabel("Название шага", { exact: true })
    .fill("Собрать коробки");
  await form
    .getByLabel("Описание шага", { exact: true })
    .fill("Мой список вещей");
  await form
    .getByRole("button", { name: "Подтвердить добавление", exact: true })
    .click();
  const entry = planPanel(page)
    .getByRole("article")
    .filter({ hasText: "Собрать коробки" });
  await expect(entry).toContainText("Ваш шаг");
  await expect(
    entry.getByRole("button", {
      name: "Открыть исходное сообщение",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]?.sourceMessageId).toBeNull();
  await page.reload();
  await openPlan(page);
  await expect(entry).toContainText("Мой список вещей");
  expect(state.sourceReads).toEqual([]);
  expect(state.forbidden).toEqual([]);
  expect(state.external).toBe(0);
});

test("plan literal search reaches older pages, combines status and resets applied and unsubmitted conditions", async ({
  page,
  context,
}) => {
  const rows = Array.from({ length: 47 }, (_, n) => ({
    ...item(
      String(9007199254741200n - BigInt(n)),
      n < 22 ? `Иное ${n}` : `Район %_\\ ${n}`,
    ),
    status: n === 46 ? ("completed" as const) : ("pending" as const),
  }));
  const state = await fixture(context, rows);
  await page.goto("/");
  await openPlan(page);
  const panel = planPanel(page),
    search = panel.getByRole("search", { name: "Поиск в моём плане" });
  await search.getByLabel("Найти шаг", { exact: true }).fill("  район %_\\  ");
  await search.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(panel.getByRole("article")).toHaveCount(20);
  expect(state.searchReads.at(-1)).toBe("район %_\\");
  await expect(search).toHaveClass(/ym-hide-content/);
  await expect(search.getByLabel("Найти шаг", { exact: true })).toHaveClass(
    /ym-disable-keys/,
  );
  await page.screenshot({ path: test.info().outputPath("plan-search.png") });
  await panel
    .getByRole("button", { name: "Показать ещё шаги", exact: true })
    .click();
  await expect(panel.getByRole("article")).toHaveCount(25);
  await panel.getByRole("button", { name: /^Выполнено 1$/ }).click();
  await expect(panel.getByRole("article")).toHaveCount(1);
  await search.getByLabel("Найти шаг", { exact: true }).fill("не применено");
  await search.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(search.getByLabel("Найти шаг", { exact: true })).toHaveValue("");
  await expect(panel.getByRole("article")).toHaveCount(20);
  expect(state.searchReads.at(-1)).toBeNull();
  expect(state.statusReads.at(-1)).toBeNull();
  expect(state.posts).toEqual([]);
  expect(state.updates).toEqual([]);
  expect(state.removes).toEqual([]);
  expect(state.forbidden).toEqual([]);
  expect(state.external).toBe(0);
});

test("switching status cancels an older plan search response without restoring its rows", async ({
  page,
  context,
}) => {
  const rows = [
    ...Array.from({ length: 25 }, (_, n) => ({
      ...item(String(9007199254741200n - BigInt(n)), `Район ${n}`),
      status: n === 24 ? ("completed" as const) : ("pending" as const),
    })),
    item("2", "Иное"),
  ];
  const state = await fixture(context, rows);
  await page.goto("/");
  await openPlan(page);
  const panel = planPanel(page),
    search = panel.getByRole("search", { name: "Поиск в моём плане" });
  state.holdList = true;
  await search.getByLabel("Найти шаг", { exact: true }).fill("район");
  await search.getByRole("button", { name: "Найти", exact: true }).click();
  await expect.poll(() => state.searchReads.at(-1)).toBe("район");
  await panel.getByRole("button", { name: /^В работе / }).click();
  await expect(panel.getByRole("article")).toHaveCount(20);
  expect(state.statusReads.at(-1)).toBe("pending");
  state.releaseList();
  await expect.poll(() => state.listCompletions).toBeGreaterThanOrEqual(3);
  await expect(
    panel.getByRole("button", { name: /^В работе / }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("article")).toHaveCount(20);
  expect(state.forbidden).toEqual([]);
  expect(state.external).toBe(0);
});

test("unfinished step edits and removal choices block search reset and status changes until explicit cancellation", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [item("30", "Первоначальный шаг")]);
  await page.goto("/");
  await openPlan(page);
  const plan = planPanel(page),
    search = plan.getByRole("search", { name: "Поиск в моём плане" }),
    row = plan.getByRole("article").first();
  await search
    .getByLabel("Найти шаг", { exact: true })
    .fill("не применённый поиск");
  await row.getByRole("button", { name: "Изменить", exact: true }).click();
  const title = row.getByLabel("Название шага", { exact: true });
  await title.fill("Мой несохранённый шаг");
  await row
    .getByLabel("Описание шага", { exact: true })
    .fill("Не терять мои подробности");
  const before = state.reads.length;
  await expect(
    search.getByRole("button", { name: "Найти", exact: true }),
  ).toBeDisabled();
  await expect(
    search.getByRole("button", { name: "Сбросить", exact: true }),
  ).toBeDisabled();
  await expect(plan.getByRole("button", { name: /^В работе / })).toBeDisabled();
  await search.evaluate((form) =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  await search
    .getByRole("button", { name: "Сбросить", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(title).toHaveValue("Мой несохранённый шаг");
  await expect(row.getByLabel("Описание шага", { exact: true })).toHaveValue(
    "Не терять мои подробности",
  );
  expect(state.reads.length).toBe(before);
  expect(state.updates).toEqual([]);
  await row
    .getByRole("button", { name: "Отмена редактирования", exact: true })
    .click();
  await expect(
    search.getByRole("button", { name: "Найти", exact: true }),
  ).toBeEnabled();
  await row.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(
    search.getByRole("button", { name: "Сбросить", exact: true }),
  ).toBeDisabled();
  await search.evaluate((form) =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  await expect(
    row.getByRole("button", { name: "Подтвердить удаление", exact: true }),
  ).toBeVisible();
  expect(state.reads.length).toBe(before);
  expect(state.removes).toEqual([]);
  await row
    .getByRole("button", { name: "Отмена удаления", exact: true })
    .click();
  await search.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(search.getByLabel("Найти шаг", { exact: true })).toHaveValue("");
  await expect(
    search.getByRole("button", { name: "Найти", exact: true }),
  ).toBeEnabled();
  expect(state.forbidden).toEqual([]);
  expect(state.external).toBe(0);
});

test("whole plan download includes hidden pages and checklists after explicit click only", async ({
  page,
  context,
}, info) => {
  const rows = Array.from({ length: 25 }, (_, n) => ({
    ...item(String(9007199254741030n - BigInt(n)), "Экспорт шаг " + n),
    status: n === 24 ? ("completed" as const) : ("pending" as const),
  }));
  const state = await fixture(context, rows);
  let exports = 0;
  await context.route("**/api/v1/personal-plan/export", (route) => {
    exports++;
    expect(route.request().method()).toBe("GET");
    expect(new URL(route.request().url()).search).toBe("");
    return route.fulfill({
      json: {
        userId: state.owner,
        generatedAt: stamp,
        items: rows.map((r, n) => ({
          ...r,
          checklist:
            n === 24
              ? [
                  {
                    id: "11111111-1111-4111-8111-111111111111",
                    title: "Последний пункт",
                    details: "ВЕСЬ_ТЕКСТ_ЧЕКЛИСТА",
                    completed: true,
                  },
                ]
              : [],
        })),
      },
    });
  });
  await page.goto("/");
  await openPlan(page);
  const panel = planPanel(page);
  await expect(panel.getByRole("article")).toHaveCount(20);
  expect(exports).toBe(0);
  await panel.getByLabel("Найти шаг", { exact: true }).fill("Экспорт шаг 24");
  await panel.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(panel.getByRole("article")).toHaveCount(1);
  const saved = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "Скачать весь план", exact: true })
    .click();
  const download = await saved;
  expect(download.suggestedFilename()).toBe("citygo-plan.txt");
  const text = await readFile((await download.path())!, "utf8");
  expect(text).toContain("1. [ ] Экспорт шаг 0");
  expect(text).toContain("25. [x] Экспорт шаг 24");
  expect(text).toContain("[x] Последний пункт");
  expect(text).toContain("ВЕСЬ_ТЕКСТ_ЧЕКЛИСТА");
  expect(text).not.toContain(rows[0]!.id);
  expect(exports).toBe(1);
  expect(state.posts).toEqual([]);
  expect(state.updates).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.forbidden).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await panel.screenshot({ path: info.outputPath("whole-plan-export.png") });
});

test("cancelled plan export cannot download a delayed successful response", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [item()]);
  let release!: () => void;
  let calls = 0,
    downloads = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await context.route("**/api/v1/personal-plan/export", async (route) => {
    calls++;
    await gate;
    try {
      await route.fulfill({
        json: {
          userId: state.owner,
          generatedAt: stamp,
          items: [{ ...item(), checklist: [] }],
        },
      });
    } catch {
      /* Cancelled local request. */
    }
  });
  page.on("download", () => downloads++);
  await page.goto("/");
  await openPlan(page);
  const panel = planPanel(page);
  await panel
    .getByRole("button", { name: "Скачать весь план", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Отменить скачивание", exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Отменить скачивание", exact: true })
    .click();
  release();
  await expect(
    panel.getByRole("button", { name: "Скачать весь план", exact: true }),
  ).toBeEnabled();
  await page.waitForTimeout(100);
  expect(downloads).toBe(0);
  expect(calls).toBe(1);
  expect(state.forbidden).toEqual([]);
});

test("restoring the displayed saved plan version requires confirmation, sends once and survives returning and reload", async ({
  page,
  context,
}, info) => {
  const row = {
    ...item(),
    source: null,
    revision: 3,
    title: "Текущий шаг",
    details: "Текущие подробности",
  };
  const state = await fixture(context, [row]);
  let writes = 0,
    currentRevision = 3;
  const saved = (revision: number) => ({
    revision,
    title: revision === 3 ? "Текущий шаг" : "Выбранный шаг",
    details:
      revision === 3 ? "Текущие подробности" : "Точные старые подробности",
    status: revision === 3 ? ("completed" as const) : ("pending" as const),
    checklist: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Сохранённый пункт",
        details: "Деталь пункта",
        completed: true,
      },
    ],
    initialSnapshot: false,
    recordedAt: stamp,
  });
  await context.route("**/api/v1/personal-plan/*/history**", async (route) => {
    if (route.request().method() === "POST") {
      writes++;
      expect(route.request().postDataJSON()).toEqual({
        revision: 2,
        expectedRevision: 3,
      });
      currentRevision = 4;
      const entry = { ...saved(2), revision: 4 };
      state.items = [
        {
          ...row,
          title: entry.title,
          details: entry.details,
          status: entry.status,
          revision: 4,
        },
      ];
      return route.fulfill({
        json: {
          userId: state.owner,
          itemId: row.id,
          restoredRevision: 2,
          entry,
        },
      });
    }
    return route.fulfill({
      json: {
        userId: state.owner,
        itemId: row.id,
        currentRevision,
        entries:
          currentRevision === 3
            ? [saved(3), saved(2), saved(1)]
            : [{ ...saved(2), revision: 4 }, saved(3), saved(2), saved(1)],
        nextBefore: null,
      },
    });
  });
  await page.goto("/");
  await openPlan(page);
  await page
    .getByRole("button", { name: "Что изменилось", exact: true })
    .click();
  const history = page.getByRole("region", {
    name: "История изменений шага",
    exact: true,
  });
  const trigger = history.getByRole("button", {
    name: "Восстановить выбранную версию",
    exact: true,
  });
  await trigger.click();
  let dialog = page.getByRole("dialog", {
    name: "Восстановить версию 2?",
    exact: true,
  });
  await expect(dialog).toContainText("Точные старые подробности");
  await expect(dialog).toContainText("Сохранённый пункт");
  await expect(
    dialog.getByRole("button", { name: "Отмена", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(writes).toBe(0);
  await trigger.click();
  dialog = page.getByRole("dialog", {
    name: "Восстановить версию 2?",
    exact: true,
  });
  expect(
    await dialog.evaluate((x) => x.classList.contains("ym-hide-content")),
  ).toBe(true);
  await dialog.screenshot({
    path: info.outputPath("restore-confirmation.png"),
  });
  await dialog
    .getByRole("button", { name: "Подтвердить восстановление", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(history.getByRole("status")).toContainText(
    "Версия восстановлена",
  );
  await expect(
    history.getByRole("region", { name: "Текущая версия", exact: true }),
  ).toContainText("Выбранный шаг");
  expect(writes).toBe(1);
  await history
    .getByRole("button", { name: "← В мой план", exact: true })
    .click();
  await expect(
    planPanel(page).getByRole("heading", {
      name: "Выбранный шаг",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await openPlan(page);
  await expect(
    planPanel(page).getByRole("heading", {
      name: "Выбранный шаг",
      exact: true,
    }),
  ).toBeVisible();
  expect(writes).toBe(1);
  expect(state.posts).toEqual([]);
  expect(state.updates).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.forbidden).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("a stale restore confirmation clears old comparisons and requires a fresh history instead of a repeat write", async ({
  page,
  context,
}) => {
  const row = { ...item(), source: null, revision: 2 };
  const state = await fixture(context, [row]);
  let writes = 0;
  await context.route("**/api/v1/personal-plan/*/history**", async (route) => {
    if (route.request().method() === "POST") {
      writes++;
      return route.fulfill({
        status: 409,
        json: {
          error: "Шаг изменился",
          code: "REVISION_CONFLICT",
          currentRevision: 3,
        },
      });
    }
    return route.fulfill({
      json: {
        userId: state.owner,
        itemId: row.id,
        currentRevision: 2,
        entries: [2, 1].map((revision) => ({
          revision,
          title: "Личная версия " + revision,
          details: "",
          status: "pending",
          checklist: [],
          initialSnapshot: false,
          recordedAt: stamp,
        })),
        nextBefore: null,
      },
    });
  });
  await page.goto("/");
  await openPlan(page);
  await page
    .getByRole("button", { name: "Что изменилось", exact: true })
    .click();
  const history = page.getByRole("region", {
    name: "История изменений шага",
    exact: true,
  });
  await history
    .getByRole("button", { name: "Восстановить выбранную версию", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Подтвердить восстановление", exact: true })
    .click();
  await expect(history.getByRole("alert")).toContainText("Шаг изменился");
  await expect(
    history.getByRole("button", { name: "Обновить историю", exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole("region", { name: "Выбранная версия", exact: true }),
  ).toHaveCount(0);
  expect(writes).toBe(1);
  expect(state.forbidden).toEqual([]);
  expect(state.external).toBe(0);
});
