import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type {
  CreatePersonalPlanItem,
  Dashboard,
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
    if (
      path === "/api/v1/conversations/10" ||
      path === "/api/v1/conversations/20"
    ) {
      state.sourceReads.push(path.split("/").at(-1)!);
      return route.fulfill({
        json: { userId: state.owner, thread: thread(state.owner) },
      });
    }
    if (path === "/api/v1/personal-plan" && request.method() === "GET") {
      const owner = state.owner,
        before = url.searchParams.get("before");
      state.reads.push(before);
      const rows =
        owner === "101"
          ? state.items.filter(
              (row) => !before || BigInt(row.id) < BigInt(before),
            )
          : [];
      const page = {
        userId: state.responseOwner ?? owner,
        items: rows.slice(0, 20),
        nextBefore: rows.length > 20 ? rows[19]!.id : null,
      };
      if (state.holdList && owner === "101") await listGate;
      try {
        await route.fulfill({ json: page });
      } catch {
        /* Invalidated view. */
      }
      return;
    }
    if (path === "/api/v1/personal-plan" && request.method() === "POST") {
      const input = request.postDataJSON() as CreatePersonalPlanItem;
      state.posts.push(input);
      const saved = state.items.find((row) => row.title === input.title) ?? {
        ...item("9007199254741031", input.title),
        details: input.details,
        source: {
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
    .getByRole("button", { name: "Открыть исходный диалог", exact: true })
    .click();
  await expect(page.getByRole("log")).toContainText("Сравните районы");
  expect(state.sourceReads).toContain("10");
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
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Начать диалог", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Разрешаю передачу указанных данных этому получателю для рекомендаций.",
    })
    .check();
  await page.getByRole("button", { name: "Подтвердить получателя AI" }).click();
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
    .getByRole("button", { name: "Открыть исходный диалог", exact: true })
    .click();
  await expect(page.getByRole("log")).toContainText(
    "Синтетический вопрос для локального плана",
  );
});
