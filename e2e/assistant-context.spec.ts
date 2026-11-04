import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type {
  AiModeId,
  AssistantContextInput,
  AssistantContextPreview,
  Dashboard,
  Message,
} from "@citygo/contracts";
import { catalogId, fixture, noOtherTraffic } from "./ai-mode-fixture";

const contextName = "Что помощники знают";
const opener = (page: Page) =>
  page
    .getByRole("button", { name: contextName, exact: true })
    .filter({ visible: true });
const heading = (page: Page) =>
  page.getByRole("heading", { name: contextName, exact: true });
const panel = (page: Page) => heading(page).locator("..");
const composer = (page: Page) =>
  page.getByLabel("Сообщение помощнику", { exact: true });
function previewInput(
  threadId: string | null,
  draft: string,
  aiMode: AiModeId = "maximum",
  aiModeCatalogId = catalogId,
): AssistantContextInput {
  return {
    threadId,
    draft,
    contextVersion: "model_window_memory_v1",
    aiMode,
    aiModeCatalogId,
  };
}
function contextBudget(
  mode: AiModeId = "maximum",
  needsProviderCheck = true,
): NonNullable<AssistantContextPreview["contextBudget"]> {
  return {
    strategy: "model_window_memory_v1",
    mode,
    contextWindowTokens: 1_000_000,
    maxInputTokens: 991_808,
    maxOutputTokens: 4096,
    framingReserve: 4096,
    inputTextTokens: 1200,
    verification: needsProviderCheck ? "conservative_utf8" : "provider_text",
    needsProviderCheck,
    mandatoryFits: true,
  };
}
function memoryQuote(
  content: string,
  complete = false,
): NonNullable<AssistantContextPreview["memory"]> {
  return {
    fragments: [
      {
        messageId: "9007199254740993",
        content,
        start: 7,
        end: 7 + [...content].length,
        sourceSha256: "a".repeat(64),
      },
    ],
    complete,
    indexComplete: complete,
    indexedMessages: 3,
  };
}
const knownProfile: NonNullable<Dashboard["profile"]> = {
  originCity: "Пермь",
  targetCity: "Казань",
  monthlyBudget: 70_000,
  moveTargetDate: "2027-03-21",
  household: "family",
  aiConsent: true,
};
function history(): Message[] {
  const result: Message[] = [];
  for (let number = 1; number <= 10; number++)
    result.push(
      {
        id: String(100 + number * 2),
        role: "user",
        agentKey: "support",
        status: "complete",
        content: "ЗАВЕРШЁННЫЙ_ВОПРОС_" + number,
      },
      {
        id: String(101 + number * 2),
        role: "assistant",
        agentKey: "support",
        status: "complete",
        content:
          "ЗАВЕРШЁННЫЙ_ОТВЕТ_" +
          number +
          (number === 10
            ? " — Предполагаю, что ваш город Сочи и бюджет 999 999 ₽"
            : ""),
      },
    );
  result.push(
    {
      id: "122",
      role: "user",
      agentKey: "support",
      status: "complete",
      content: "НЕЗАВЕРШЁННЫЙ_ВОПРОС",
    },
    {
      id: "123",
      role: "assistant",
      agentKey: "support",
      status: "interrupted",
      content: "ПРЕРВАННЫЙ_ОТВЕТ",
    },
  );
  return result;
}
async function contextFixture(
  context: BrowserContext,
  profile: Dashboard["profile"] = null,
) {
  const messages = history();
  const state = await fixture(context, {
    assistantContextAvailable: true,
    profile,
    initialMessages: messages,
  });
  const preview: {
    requests: {
      owner: string;
      input: AssistantContextInput;
    }[];
    memory?: AssistantContextPreview["memory"];
    contextBudget?: AssistantContextPreview["contextBudget"];
    hold: boolean;
    status: number;
    revokeOnRead: boolean;
    release: () => void;
  } = {
    requests: [],
    hold: false,
    status: 200,
    revokeOnRead: false,
    release: () => {},
  };
  const gate = new Promise<void>((resolve) => {
    preview.release = resolve;
  });
  const selected = messages
    .slice(2, 20)
    .map(({ role, content }) => ({ role, content }));
  await context.route("**/api/v1/ai/context-preview", async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(new URL(request.url()).search).toBe("");
    const input = request.postDataJSON() as AssistantContextInput;
    const owner = state.owner;
    expect(Object.keys(input).sort()).toEqual([
      "aiMode",
      "aiModeCatalogId",
      "contextVersion",
      "draft",
      "threadId",
    ]);
    expect(input.contextVersion).toBe("model_window_memory_v1");
    expect(input.aiModeCatalogId).toBe(state.catalogId);
    expect(["maximum", "balanced", "minimum"]).toContain(input.aiMode);
    expect(input.threadId).toBe(owner === "101" ? "20" : "30");
    const response: AssistantContextPreview = {
      userId: owner,
      threadId: input.threadId,
      generatedAt: "2026-11-02T02:00:00Z",
      profile: {
        targetCity: owner === "101" ? (profile?.targetCity ?? null) : null,
        monthlyBudget:
          owner === "101" ? (profile?.monthlyBudget ?? null) : null,
        moveTargetDate:
          owner === "101" ? (profile?.moveTargetDate ?? null) : null,
        household: owner === "101" ? (profile?.household ?? null) : null,
      },
      agentKey: "support",
      closed: false,
      draftIncluded: Boolean(input.draft.trim()),
      messages: owner === "101" ? selected : [],
      ...(owner === "101" && preview.memory ? { memory: preview.memory } : {}),
      ...(preview.contextBudget
        ? { contextBudget: { ...preview.contextBudget, mode: input.aiMode! } }
        : {}),
    };
    const status = preview.status;
    if (preview.revokeOnRead) state.authenticated = false;
    preview.requests.push({ owner, input });
    if (preview.hold) {
      preview.hold = false;
      await gate;
    }
    await route.fulfill({
      status,
      headers: { "Cache-Control": "no-store" },
      json: status === 200 ? response : { error: "Войдите в аккаунт заново" },
    });
  });
  return { state, preview, selected };
}
function noWrites(state: Awaited<ReturnType<typeof fixture>>) {
  expect(state.sends).toEqual([]);
  expect(state.consentSaves).toEqual([]);
  noOtherTraffic(state);
}

test("explicit context preview shows saved facts and the last complete pairs, keeps the draft private and corrects only in the same conversation", async ({
  page,
  context,
}, info) => {
  const { state, preview, selected } = await contextFixture(
    context,
    knownProfile,
  );
  await page.goto("/");
  const draft = "ЛИЧНЫЙ_НЕОТПРАВЛЕННЫЙ_ВОПРОС_ДЛЯ_РАСЧЁТА_КОНТЕКСТА";
  await composer(page).fill(draft);
  await expect(opener(page)).toHaveCount(1);
  expect(preview.requests).toEqual([]);
  if (page.viewportSize()!.width > 1100)
    await expect(
      page
        .locator(".conversation-context")
        .filter({ visible: true })
        .getByRole("button", { name: contextName, exact: true }),
    ).toBeVisible();
  else
    await expect(
      page.locator(".conversation-context").filter({ visible: true }),
    ).toHaveCount(0);
  await opener(page).click();
  const view = panel(page);
  await expect(
    view.getByRole("region", { name: "Сохранённые сведения" }),
  ).toContainText("Казань");
  await expect(view.locator("dd")).toHaveText([
    "Казань",
    /70\s000 ₽/,
    "2027-03-21",
    "Семья",
  ]);
  await expect(
    view.getByRole("heading", { name: "Не заполнено в профиле", exact: true }),
  ).toHaveCount(0);
  await expect(view.locator("ol li p")).toHaveText(
    selected.map((message) => message.content),
  );
  await expect(
    view.getByText("ЗАВЕРШЁННЫЙ_ВОПРОС_1", { exact: true }),
  ).toHaveCount(0);
  await expect(view.getByText("ПРЕРВАННЫЙ_ОТВЕТ", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    view.getByText("НЕЗАВЕРШЁННЫЙ_ВОПРОС", { exact: true }),
  ).toHaveCount(0);
  await expect(view.getByText(draft, { exact: true })).toHaveCount(0);
  await expect(view.getByText("Следующий вопрос", { exact: true })).toHaveCount(
    0,
  );
  await expect(view).toHaveClass(/ym-hide-content/);
  await expect(view).toHaveClass(/ym-disable-keys/);
  expect(
    await view.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await heading(page).focus();
  await page.screenshot({
    path: info.outputPath("assistant-context-known.png"),
    fullPage: true,
  });
  expect(preview.requests).toEqual([
    { owner: "101", input: previewInput("20", draft) },
  ]);
  noWrites(state);
  await view
    .getByRole("button", { name: "Исправить в разговоре", exact: true })
    .click();
  await expect(heading(page)).toHaveCount(0);
  await expect(composer(page)).toHaveValue(draft);
  await expect(composer(page)).toBeFocused();
  await expect(
    page.getByRole("log", { name: "История диалога", exact: true }),
  ).toContainText("ЗАВЕРШЁННЫЙ_ОТВЕТ_10");
  expect(preview.requests).toHaveLength(1);
  noWrites(state);
});

test("unknown relocation facts remain unknown; Back restores opener focus and empty-draft correction only prepares editable text", async ({
  page,
  context,
}, info) => {
  const { state, preview } = await contextFixture(context);
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  expect(preview.requests).toEqual([]);
  await opener(page).click();
  const view = panel(page);
  await expect(
    view.getByRole("region", { name: "Сохранённые сведения" }),
  ).toContainText("Отдельных сведений о переезде пока нет");
  await expect(view.locator("dd")).toHaveCount(0);
  await expect(
    view.getByRole("region", { name: "Сохранённые сведения" }),
  ).not.toContainText("Сочи");
  await expect(view.locator("ol")).toContainText(
    "Предполагаю, что ваш город Сочи",
  );
  await expect(
    view.getByRole("heading", { name: "Не заполнено в профиле", exact: true }),
  ).toBeVisible();
  await expect(view).toContainText(
    "Город назначения, Бюджет в месяц, Дата переезда, Состав семьи",
  );
  await expect(view).toContainText("Следующий вопрос ещё не написан");
  await heading(page).focus();
  await page.screenshot({
    path: info.outputPath("assistant-context-unknown.png"),
    fullPage: true,
  });
  await view
    .getByRole("button", { name: "Вернуться назад", exact: true })
    .click();
  await expect(heading(page)).toHaveCount(0);
  await expect(opener(page)).toBeFocused();
  await expect(composer(page)).toHaveValue("");
  const helpersTab = page
    .getByRole("navigation", { name: "Личный кабинет CityGo", exact: true })
    .getByRole("button", { name: "Помощники", exact: true });
  await helpersTab.click();
  await expect(helpersTab).toHaveAttribute("aria-pressed", "true");
  await opener(page).click();
  await expect(
    panel(page).getByRole("region", { name: "Сохранённые сведения" }),
  ).toBeVisible();
  await opener(page).click();
  expect(preview.requests).toHaveLength(2);
  await panel(page)
    .getByRole("button", { name: "Вернуться назад", exact: true })
    .click();
  await expect(helpersTab).toHaveAttribute("aria-pressed", "true");
  await expect(opener(page)).toBeFocused();
  await opener(page).click();
  await panel(page)
    .getByRole("button", { name: "Исправить в разговоре", exact: true })
    .click();
  await expect(composer(page)).toHaveValue(
    "Хочу уточнить сведения о переезде: ",
  );
  await expect(composer(page)).toBeFocused();
  expect(preview.requests).toEqual([
    { owner: "101", input: previewInput("20", "") },
    { owner: "101", input: previewInput("20", "") },
    { owner: "101", input: previewInput("20", "") },
  ]);
  noWrites(state);
});

for (const complete of [false, true])
  test(`source memory preserves exact user quotes and ${complete ? "complete" : "partial"} coverage without treating missing profile fields as missing history`, async ({
    page,
    context,
  }) => {
    const { state, preview } = await contextFixture(context);
    const quote =
      'Работаю у станции Тестовая; переезжаю с семьёй 🧳. <img src=x onerror="alert(1)">';
    preview.memory = memoryQuote(quote, complete);
    preview.contextBudget = contextBudget("maximum", !complete);
    await page.goto("/");
    await composer(page).fill("Что учитывать при выборе района?");
    await opener(page).click();
    const view = panel(page);
    const memory = view.getByRole("region", {
      name: "Память диалога",
      exact: true,
    });
    await expect(memory.locator("ol li p")).toHaveText([quote]);
    await expect(memory.locator("ol li strong")).toHaveText([
      "Ваше сообщение №9007199254740993",
    ]);
    await expect(memory.locator("img")).toHaveCount(0);
    await expect(memory).toContainText(
      "Новые уточнения важнее прежних сведений.",
    );
    await expect(
      view.getByRole("heading", {
        name: "Не заполнено в профиле",
        exact: true,
      }),
    ).toBeVisible();
    await expect(view).toContainText("Эти сведения могут быть в переписке.");
    await expect(
      view.getByRole("region", { name: "Сохранённые сведения", exact: true }),
    ).not.toContainText(quote);
    const partial = memory.getByText(
      "Показаны выбранные фрагменты. Полная переписка сохраняется в диалоге.",
      { exact: true },
    );
    const providerCheck = memory.getByText(
      "Размер и состав контекста уточняются при отправке сообщения.",
      { exact: true },
    );
    if (complete) {
      await expect(partial).toHaveCount(0);
      await expect(providerCheck).toHaveCount(0);
    } else {
      await expect(partial).toBeVisible();
      await expect(providerCheck).toBeVisible();
    }
    expect(preview.requests).toEqual([
      {
        owner: "101",
        input: previewInput("20", "Что учитывать при выборе района?"),
      },
    ]);
    await expect(view).toHaveClass(/ym-hide-content/);
    await expect(view).toHaveClass(/ym-disable-keys/);
    noWrites(state);
  });

test("an empty memory selection does not claim the complete conversation was forgotten", async ({
  page,
  context,
}) => {
  const { state, preview } = await contextFixture(context);
  preview.memory = {
    fragments: [],
    complete: false,
    indexComplete: true,
    indexedMessages: 22,
  };
  preview.contextBudget = contextBudget();
  await page.goto("/");
  await opener(page).click();
  const memory = panel(page).getByRole("region", {
    name: "Память диалога",
    exact: true,
  });
  await expect(memory).toContainText(
    "Сохранённых фрагментов для этого вопроса пока нет.",
  );
  await expect(memory).toContainText("Полная переписка сохраняется в диалоге.");
  await expect(memory.locator("li")).toHaveCount(0);
  await expect(
    panel(page).getByText("ЗАВЕРШЁННЫЙ_ВОПРОС_10", { exact: true }),
  ).toBeVisible();
  noWrites(state);
});

for (const change of ["mode", "catalog"] as const)
  for (const status of [200, 401])
    test(`a ${change} replacement reads fresh memory and ignores a delayed ${status} from the previous scope`, async ({
      page,
      context,
    }) => {
      // The right rail exposes mode selection while the context view is open.
      await page.setViewportSize({ width: 1280, height: 900 });
      const { state, preview } = await contextFixture(context);
      const previousQuote = "СТАРЫЙ_КОНТЕКСТ_ДРУГОГО_РЕЖИМА_ИЛИ_КАТАЛОГА";
      const currentQuote = "АКТУАЛЬНАЯ_ЦИТАТА_ПОСЛЕ_СМЕНЫ_РЕЖИМА_ИЛИ_КАТАЛОГА";
      preview.memory = memoryQuote(previousQuote);
      preview.contextBudget = contextBudget();
      preview.hold = true;
      preview.status = status;
      await page.goto("/");
      const draft = "НЕОТПРАВЛЕННЫЙ_ВОПРОС_ПРИ_СМЕНЕ_РЕЖИМА";
      await composer(page).fill(draft);
      await opener(page).click();
      await expect.poll(() => preview.requests.length).toBe(1);
      await expect(panel(page).getByRole("status")).toContainText(
        "Загружаем контекст",
      );
      try {
        // The handler already captured the old response/status. The replacement
        // must read a new scope, even if aborting the old transport races delivery.
        preview.memory = memoryQuote(currentQuote);
        preview.status = 200;
        if (change === "mode") {
          const rail = page
            .locator(".conversation-context")
            .filter({ visible: true });
          await rail
            .getByRole("button", { name: "Режим работы", exact: true })
            .click();
          await rail
            .getByRole("dialog", { name: "Режим работы", exact: true })
            .getByRole("button", { name: "Баланс", exact: true })
            .click();
        } else {
          const before = state.dashboardReads;
          state.catalogId = "c".repeat(64);
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await expect.poll(() => state.dashboardReads).toBeGreaterThan(before);
        }
        await expect.poll(() => preview.requests.length).toBe(2);
        const memory = panel(page).getByRole("region", {
          name: "Память диалога",
          exact: true,
        });
        await expect(memory.locator("ol li p")).toHaveText([currentQuote]);
        expect(preview.requests).toEqual([
          { owner: "101", input: previewInput("20", draft) },
          {
            owner: "101",
            input: previewInput(
              "20",
              draft,
              change === "mode" ? "balanced" : "maximum",
              change === "catalog" ? "c".repeat(64) : catalogId,
            ),
          },
        ]);
        preview.release();
        await expect(memory.locator("ol li p")).toHaveText([currentQuote]);
        await expect(
          page.getByText(previousQuote, { exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByText("Сессия завершилась. Войдите снова.", { exact: true }),
        ).toHaveCount(0);
        await expect(page.getByLabel("Пароль", { exact: true })).toHaveCount(0);
        await panel(page)
          .getByRole("button", { name: "Вернуться назад", exact: true })
          .click();
        await expect(composer(page)).toHaveValue(draft);
        noWrites(state);
      } finally {
        preview.release();
      }
    });

test("an older dashboard without context capability never dispatches a preview", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  let reads = 0;
  await context.route("**/api/v1/ai/context-preview", (route) => {
    reads++;
    return route.fulfill({
      status: 500,
      json: { error: "No synthetic capability" },
    });
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  await expect(opener(page)).toBeDisabled();
  await expect(heading(page)).toHaveCount(0);
  expect(reads).toBe(0);
  noWrites(state);
});

test("a current preview 401 clears private context and requires authentication without a write", async ({
  page,
  context,
}) => {
  const { state, preview } = await contextFixture(context, knownProfile);
  await page.goto("/");
  await composer(page).fill("НЕОТПРАВЛЕННЫЙ_ВОПРОС_ДО_401");
  preview.status = 401;
  preview.revokeOnRead = true;
  await opener(page).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Сессия завершилась. Войдите снова." }),
  ).toBeVisible();
  const email = page.getByLabel(
    /^(?:Логин или электронная почта|Электронная почта)$/,
  );
  await expect(email).toBeVisible();
  await expect(email).toHaveValue("");
  await expect(page.getByLabel("Пароль", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Пароль", { exact: true })).toHaveValue("");
  await expect(heading(page)).toHaveCount(0);
  await expect(
    page.getByText("Казань", { exact: true }).filter({ visible: true }),
  ).toHaveCount(0);
  await expect(composer(page)).toHaveCount(0);
  expect(preview.requests).toHaveLength(1);
  noWrites(state);
});

test("closing a pending preview restores the same draft and never renders a late successful private response", async ({
  page,
  context,
}) => {
  const { state, preview } = await contextFixture(context, knownProfile);
  await page.goto("/");
  await composer(page).fill("МОЙ_ЧЕРНОВИК_ПОСЛЕ_ЗАКРЫТИЯ");
  preview.hold = true;
  await opener(page).click();
  await expect.poll(() => preview.requests.length).toBe(1);
  await expect(panel(page).getByRole("status")).toContainText(
    "Загружаем контекст",
  );
  try {
    await panel(page)
      .getByRole("button", { name: "Вернуться назад", exact: true })
      .click();
    await expect(opener(page)).toBeFocused();
    preview.release();
    await expect(composer(page)).toHaveValue("МОЙ_ЧЕРНОВИК_ПОСЛЕ_ЗАКРЫТИЯ");
    await expect(heading(page)).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Сохранённые сведения" }),
    ).toHaveCount(0);
  } finally {
    preview.release();
  }
  noWrites(state);
});

for (const status of [200, 401]) {
  test(
    "a delayed preview " +
      status +
      " cannot show the previous owner's facts or invalidate the replacement session",
    async ({ page, context }) => {
      const { state, preview } = await contextFixture(context, knownProfile);
      await page.goto("/");
      await composer(page).fill("ПРИВАТНЫЙ_ЧЕРНОВИК_СТАРОГО_ВЛАДЕЛЬЦА");
      preview.status = status;
      preview.hold = true;
      await opener(page).click();
      await expect.poll(() => preview.requests.length).toBe(1);
      const before = state.dashboardReads;
      try {
        state.owner = "202";
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => state.dashboardReads).toBeGreaterThan(before);
        await expect(composer(page)).toBeVisible();
        await expect(composer(page)).toHaveValue("");
        await expect(heading(page)).toHaveCount(0);
        preview.release();
        preview.status = 200;
        await expect(opener(page)).toBeEnabled();
        await opener(page).click();
        // A fresh explicit read is made under the replacement identity, so neither
        // stale success nor stale auth failure may poison this next session.
        await expect.poll(() => preview.requests.length).toBe(2);
        await expect(
          panel(page).getByRole("region", { name: "Сохранённые сведения" }),
        ).toContainText("Отдельных сведений о переезде пока нет");
        await expect(
          panel(page).getByText("Казань", { exact: true }),
        ).toHaveCount(0);
        await expect(
          panel(page).getByText("ПРИВАТНЫЙ_ЧЕРНОВИК_СТАРОГО_ВЛАДЕЛЬЦА", {
            exact: true,
          }),
        ).toHaveCount(0);
        expect(preview.requests[1]).toEqual({
          owner: "202",
          input: previewInput("30", ""),
        });
      } finally {
        preview.release();
      }
      noWrites(state);
    },
  );
}

for (const width of [1024, 1100, 1101])
  test(`context preview stays reachable at the ${width}px rail boundary`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { state, preview } = await contextFixture(context, knownProfile);
    await page.goto("/");
    const draft = "ЧЕРНОВИК_НА_ГРАНИЦЕ_ПАНЕЛИ";
    await composer(page).fill(draft);
    // The rail is hidden through 1100px inclusive. Exactly one visible opener
    // must remain: the in-column fallback, then the rail from 1101px onward.
    await expect(opener(page)).toHaveCount(1);
    await expect(opener(page)).toBeEnabled();
    const rail = page
      .locator(".conversation-context")
      .filter({ visible: true });
    await expect(rail).toHaveCount(width > 1100 ? 1 : 0);
    if (width > 1100)
      await expect(
        rail.getByRole("button", { name: contextName, exact: true }),
      ).toBeVisible();
    expect(preview.requests).toEqual([]);
    await opener(page).click();
    await expect(
      panel(page).getByRole("region", { name: "Сохранённые сведения" }),
    ).toContainText("Казань");
    expect(preview.requests).toEqual([
      { owner: "101", input: previewInput("20", draft) },
    ]);
    await panel(page)
      .getByRole("button", { name: "Вернуться назад", exact: true })
      .click();
    await expect(opener(page)).toBeFocused();
    await expect(composer(page)).toHaveValue(draft);
    await expect(heading(page)).toHaveCount(0);
    noWrites(state);
  });
