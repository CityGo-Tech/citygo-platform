import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type {
  CreatePersonalMemoryItem,
  Dashboard,
  PersonalMemoryItem,
  UpdatePersonalMemoryItem,
} from "@citygo/contracts";
import { syntheticConsentPolicy } from "./service-consent-fixture";

const stamp = "2026-10-25T08:00:00.000Z";
const item = (
  label = "Работа",
  value = "Ищу работу в центре",
): PersonalMemoryItem => ({
  id: "9007199254741030",
  label,
  value,
  revision: 1,
  source: { messageId: "11", threadId: "10", role: "assistant" },
  createdAt: stamp,
  updatedAt: stamp,
});
const memoryPanel = (page: Page) =>
  page.getByRole("region", { name: "Память разговора", exact: true });
async function openMemory(page: Page) {
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  await page
    .getByRole("button", { name: "Память разговора", exact: true })
    .click();
  await expect(memoryPanel(page).getByRole("heading", { level: 1 })).toHaveText(
    "Память разговора",
  );
}
async function chooseMessage(page: Page, index = 1) {
  await page
    .getByRole("log")
    .getByRole("button", { name: "Запомнить", exact: true })
    .nth(index)
    .click();
  return page.getByRole("region", { name: "Сохранение в память", exact: true });
}

/** No SMS, AI or payment calls: every permitted request has a synthetic response. */
async function fixture(
  context: BrowserContext,
  initial: PersonalMemoryItem[] = [],
) {
  const state = {
    owner: "101",
    responseOwner: null as string | null,
    authenticated: true,
    threadPresent: true,
    assistantInterrupted: false,
    items: initial,
    reads: 0,
    posts: [] as CreatePersonalMemoryItem[],
    updates: [] as UpdatePersonalMemoryItem[],
    removes: [] as { expectedRevision: number }[],
    sourceReads: [] as string[],
    forbidden: [] as string[],
    external: 0,
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
          owner === "101"
            ? "Хочу жить рядом с работой"
            : "ВОПРОС_НОВОГО_ВЛАДЕЛЬЦА",
      },
      {
        id: owner === "101" ? "11" : "21",
        role: "assistant" as const,
        agentKey: "support" as const,
        status: state.assistantInterrupted
          ? ("interrupted" as const)
          : ("complete" as const),
        content:
          owner === "101"
            ? "Можно сравнить районы по времени в пути"
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
    thread: state.threadPresent ? thread(state.owner) : null,
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
    if (
      path === "/api/v1/auth/registration-policy" &&
      request.method() === "GET"
    )
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/auth/logout") {
      state.authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (!state.authenticated)
      return route.fulfill({ status: 401, json: { error: "Signed out" } });
    if (path === "/api/v1/dashboard") return route.fulfill({ json: board() });
    if (
      ["/api/v1/conversations/10", "/api/v1/conversations/20"].includes(path)
    ) {
      state.sourceReads.push(path.split("/").at(-1)!);
      return route.fulfill({
        json: { userId: state.owner, thread: thread(state.owner) },
      });
    }
    if (path === "/api/v1/personal-memory" && request.method() === "GET") {
      state.reads++;
      const owner = state.owner,
        page = {
          userId: state.responseOwner ?? owner,
          items: owner === "101" ? structuredClone(state.items) : [],
        };
      if (state.holdList && owner === "101") await listGate;
      try {
        await route.fulfill({ json: page });
      } catch {
        /* A detached session cannot receive this page. */
      }
      return;
    }
    if (path === "/api/v1/personal-memory" && request.method() === "POST") {
      const input = request.postDataJSON() as CreatePersonalMemoryItem;
      state.posts.push(input);
      expect(input.confirmed).toBe(true);
      const saved = state.items.find((row) => row.label === input.label) ?? {
        ...item(input.label, input.value),
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
        item: structuredClone(saved),
      };
      if (state.holdCreate) await createGate;
      if (state.lostCreateReceipt && state.posts.length === 1)
        return route.abort("failed");
      try {
        await route.fulfill({ json: receipt });
      } catch {
        /* A detached session cannot receive this receipt. */
      }
      return;
    }
    const mutation = path.match(/^\/api\/v1\/personal-memory\/(\d+)$/);
    if (mutation && request.method() === "PATCH") {
      const input = request.postDataJSON() as UpdatePersonalMemoryItem;
      state.updates.push(input);
      expect(input.confirmed).toBe(true);
      const row = state.items.find((value) => value.id === mutation[1])!;
      if (state.conflictNext) {
        state.conflictNext = false;
        row.revision++;
        row.value = "Исправлено в другом окне";
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
        label: input.label,
        value: input.value,
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

test("memory requires explicit confirmation, persists across reload and supports correction, source and removal", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  await page.goto("/");
  await openMemory(page);
  await expect(memoryPanel(page)).toContainText("Пока ничего не сохранено");
  await memoryPanel(page)
    .getByRole("button", { name: "Открыть диалог", exact: true })
    .click();
  const form = await chooseMessage(page);
  expect(state.posts).toEqual([]);
  await form.getByLabel("О чём это", { exact: true }).fill("Место работы");
  await form
    .getByLabel("Что запомнить", { exact: true })
    .fill("Буду работать у метро Тульская.");
  await form
    .getByRole("button", { name: "Подтвердить и сохранить", exact: true })
    .click();
  const panel = memoryPanel(page),
    entry = panel.getByRole("article").first();
  await expect(entry).toContainText("Буду работать у метро Тульская.");
  await expect(entry).toContainText("ПОДТВЕРЖДЕНО ВАМИ");
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]?.sourceMessageId).toBe("11");
  await entry.getByRole("button", { name: "Исправить", exact: true }).click();
  await entry
    .getByLabel("Что запомнить", { exact: true })
    .fill("Буду работать удалённо.");
  await entry
    .getByRole("button", { name: "Подтвердить исправление", exact: true })
    .click();
  await expect(entry).toContainText("Буду работать удалённо.");
  expect(state.updates[0]?.expectedRevision).toBe(1);
  await panel.screenshot({
    path: info.outputPath("personal-memory-populated.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await entry
    .getByRole("button", { name: "Открыть исходный диалог", exact: true })
    .click();
  await expect(page.getByRole("log")).toContainText("Можно сравнить районы");
  expect(state.sourceReads).toContain("10");
  await page.reload();
  await openMemory(page);
  await expect(entry).toContainText("Буду работать удалённо.");
  await entry.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(entry).toContainText("Исходное сообщение и диалог останутся");
  expect(state.removes).toHaveLength(0);
  await entry
    .getByRole("button", { name: "Подтвердить удаление", exact: true })
    .click();
  await expect(panel).toContainText("Пока ничего не сохранено");
  expect(state.removes).toEqual([{ expectedRevision: 2 }]);
  expect(state.external).toBe(0);
  expect(state.forbidden).toEqual([]);
});

test("a lost create receipt freezes the exact confirmed payload for an idempotent retry", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.lostCreateReceipt = true;
  await page.goto("/");
  const form = await chooseMessage(page, 0);
  await form.getByLabel("О чём это", { exact: true }).fill("Моё пожелание");
  await form
    .getByRole("button", { name: "Подтвердить и сохранить", exact: true })
    .click();
  await expect(form.getByRole("alert")).toContainText("уже могла сохраниться");
  await expect(form.getByLabel("О чём это", { exact: true })).toBeDisabled();
  await expect(
    form.getByLabel("Что запомнить", { exact: true }),
  ).toBeDisabled();
  await form
    .getByRole("button", { name: "Повторить тот же запрос", exact: true })
    .click();
  await expect(memoryPanel(page)).toContainText("Моё пожелание");
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1]).toEqual(state.posts[0]);
  expect(state.posts[0]?.sourceMessageId).toBe("10");
  expect(state.items).toHaveLength(1);
  expect(state.forbidden).toEqual([]);
});

test("a revision conflict requires a fresh read before another correction", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [item()]);
  state.conflictNext = true;
  await page.goto("/");
  await openMemory(page);
  const panel = memoryPanel(page),
    entry = panel.getByRole("article").first();
  await entry.getByRole("button", { name: "Исправить", exact: true }).click();
  await entry
    .getByLabel("Что запомнить", { exact: true })
    .fill("Мой новый текст");
  await entry
    .getByRole("button", { name: "Подтвердить исправление", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("Запись уже изменена");
  await expect(
    entry.getByRole("button", { name: "Подтвердить исправление", exact: true }),
  ).toBeDisabled();
  expect(state.updates).toHaveLength(1);
  await panel
    .getByRole("button", { name: "Обновить список", exact: true })
    .click();
  await expect(entry).toContainText("Исправлено в другом окне");
  await entry.getByRole("button", { name: "Исправить", exact: true }).click();
  await entry
    .getByLabel("Что запомнить", { exact: true })
    .fill("Проверенный мной текст");
  await entry
    .getByRole("button", { name: "Подтвердить исправление", exact: true })
    .click();
  await expect(entry).toContainText("Проверенный мной текст");
  expect(state.updates.map((value) => value.expectedRevision)).toEqual([1, 2]);
});

test("memory is reachable before a first dialogue and does not invent unknown budget or date", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.threadPresent = false;
  await page.goto("/");
  await openMemory(page);
  await expect(memoryPanel(page)).toContainText(
    "Бюджет и срок могут оставаться неизвестными",
  );
  await expect(memoryPanel(page).getByRole("article")).toHaveCount(0);
  expect(state.posts).toEqual([]);
  expect(state.forbidden).toEqual([]);
});

test("an interrupted assistant answer is not offered as a confirmed memory source", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.assistantInterrupted = true;
  await page.goto("/");
  await expect(
    page
      .getByRole("log")
      .getByRole("button", { name: "Запомнить", exact: true }),
  ).toHaveCount(1);
  expect(state.posts).toEqual([]);
});

for (const operation of ["read", "create"] as const) {
  test(`another owner's ${operation} receipt never renders private memory`, async ({
    page,
    context,
  }) => {
    const state = await fixture(
      context,
      operation === "read" ? [item("FOREIGN_PRIVATE_MEMORY")] : [],
    );
    state.responseOwner = "303";
    await page.goto("/");
    if (operation === "read") {
      await page.getByRole("button", { name: "Профиль", exact: true }).click();
      await page
        .getByRole("button", { name: "Память разговора", exact: true })
        .click();
    } else {
      const form = await chooseMessage(page);
      await form
        .getByRole("button", { name: "Подтвердить и сохранить", exact: true })
        .click();
    }
    await expect(
      page.getByRole("button", { name: "Создать аккаунт", exact: true }),
    ).toBeVisible();
    await expect(memoryPanel(page)).toHaveCount(0);
    await expect(page.getByText("FOREIGN_PRIVATE_MEMORY")).toHaveCount(0);
  });
}

for (const operation of ["read", "create"] as const) {
  test(`a delayed ${operation} cannot enter memory after the authenticated account changes`, async ({
    page,
    context,
  }) => {
    const state = await fixture(
      context,
      operation === "read" ? [item("LATE_PRIVATE_MEMORY_A")] : [],
    );
    state.holdList = operation === "read";
    state.holdCreate = operation === "create";
    try {
      await page.goto("/");
      if (operation === "read") {
        await openMemory(page);
        await expect.poll(() => state.reads).toBe(1);
      } else {
        const form = await chooseMessage(page);
        await form
          .getByLabel("О чём это", { exact: true })
          .fill("LATE_PRIVATE_MEMORY_A");
        await form
          .getByRole("button", { name: "Подтвердить и сохранить", exact: true })
          .click();
        await expect.poll(() => state.posts.length).toBe(1);
      }
      state.owner = "202";
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByRole("log")).toContainText(
        "ВОПРОС_НОВОГО_ВЛАДЕЛЬЦА",
      );
      state.releaseList();
      state.releaseCreate();
      await expect(page.getByText("LATE_PRIVATE_MEMORY_A")).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Сохранение в память", exact: true }),
      ).toHaveCount(0);
      await openMemory(page);
      await expect(memoryPanel(page)).toContainText("Пока ничего не сохранено");
    } finally {
      state.releaseList();
      state.releaseCreate();
    }
  });
}
