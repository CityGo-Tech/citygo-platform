import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type {
  AssistantContextPreview,
  Dashboard,
  Message,
} from "@citygo/contracts";
import { fixture, noOtherTraffic } from "./ai-mode-fixture";

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
  const preview = {
    requests: [] as {
      owner: string;
      input: { threadId: string | null; draft: string };
    }[],
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
    const input = request.postDataJSON() as {
      threadId: string | null;
      draft: string;
    };
    const owner = state.owner;
    expect(Object.keys(input).sort()).toEqual(["draft", "threadId"]);
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
  if (page.viewportSize()!.width > 1000)
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
    view.getByRole("heading", { name: "Вы пока не рассказывали", exact: true }),
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
    { owner: "101", input: { threadId: "20", draft } },
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
    view.getByRole("heading", { name: "Вы пока не рассказывали", exact: true }),
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
    { owner: "101", input: { threadId: "20", draft: "" } },
    { owner: "101", input: { threadId: "20", draft: "" } },
    { owner: "101", input: { threadId: "20", draft: "" } },
  ]);
  noWrites(state);
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
          input: { threadId: "30", draft: "" },
        });
      } finally {
        preview.release();
      }
      noWrites(state);
    },
  );
}
