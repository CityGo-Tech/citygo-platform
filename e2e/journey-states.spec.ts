import { test, expect, type Page } from "@playwright/test";
import type { Dashboard } from "@citygo/contracts";

function fixture(): Dashboard {
  return {
    user: { id: "ui-user", email: "ui@example.test" },
    profile: {
      originCity: "Казань",
      targetCity: "Москва",
      monthlyBudget: 65000,
      moveTargetDate: "2099-01-01",
      household: "couple",
      aiConsent: true,
    },
    xp: 0,
    provider: "openai",
    aiAccess: {
      granted: true,
      dailyLimit: 20,
      policy: {
        id: "a".repeat(64),
        version: "test-v1",
        provider: "openai",
        model: "test-model",
        recipient: "OpenAI",
        routing: "Прямое подключение",
        data: "Тестовая анкета и история для рекомендаций",
      },
    },
    quests: [
      {
        id: "housing-first",
        slug: "housing-search",
        title: "Составить план поиска жилья",
        state: "in_progress",
        xpReward: 60,
      },
      {
        id: "housing-next",
        slug: "housing-viewing",
        title: "Подготовиться к просмотру квартиры",
        state: "locked",
        xpReward: 60,
      },
    ],
    thread: { id: "ui-thread", agentKey: "housing", messages: [] },
  };
}
async function dashboard(page: Page, board: Dashboard) {
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({ json: board }),
  );
}

test("changed recipient resets unchecked consent and never resends automatically", async ({
  page,
}) => {
  const board = fixture();
  board.aiAccess.granted = false;
  let confirmations = 0;
  let messages = 0;
  await dashboard(page, board);
  await page.route("**/api/v1/threads/*/messages", (route) => {
    messages++;
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected auto-send" },
    });
  });
  await page.route("**/api/v1/ai/consent", (route) => {
    confirmations++;
    const input = route.request().postDataJSON();
    expect(input.action).toBe("granted");
    if (confirmations === 1) {
      expect(input.policyId).toBe("a".repeat(64));
      board.provider = "routerai";
      board.aiAccess.policy = {
        ...board.aiAccess.policy!,
        id: "b".repeat(64),
        provider: "routerai",
        recipient: "RouterAI",
        model: "test/new-model",
        routing: "Дополнительный получатель: test-upstream",
      };
      return route.fulfill({
        status: 409,
        json: { error: "AI-получатель изменился" },
      });
    }
    expect(input.policyId).toBe("b".repeat(64));
    board.aiAccess.granted = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/#chat");
  const checkbox = page.getByRole("checkbox", {
    name: "Разрешаю передачу указанных данных этому получателю для рекомендаций.",
  });
  const confirm = page.getByRole("button", {
    name: "Подтвердить получателя AI",
  });
  await expect(checkbox).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  await expect(page.getByLabel("Сообщение помощнику")).toBeDisabled();
  await checkbox.check();
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText(
    "AI-получатель изменился",
  );
  await expect(page.getByText(/Получатель: RouterAI/)).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  await checkbox.check();
  await confirm.click();
  await expect(page.getByLabel("Сообщение помощнику")).toBeEnabled();
  expect(confirmations).toBe(2);
  expect(messages).toBe(0);
});

test("plan, chat and completion fit 320px, tablet and desktop; back navigation works", async ({
  page,
}, testInfo) => {
  const board = fixture();
  board.quests[0].state = "completed";
  board.quests[1].state = "available";
  board.xp = 60;
  await dashboard(page, board);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ["plan", "chat", "complete/housing-first"]) {
      await page.goto("/#" + view);
      await expect(
        page.locator(
          ".journey-" + (view.startsWith("complete") ? "complete" : view),
        ),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
      if (width === 320)
        await page.screenshot({
          path: testInfo.outputPath(
            "narrow-" + view.replace("/", "-") + ".png",
          ),
          fullPage: true,
        });
    }
  }
  await page.getByRole("button", { name: "Открыть историю чата" }).click();
  await expect(page).toHaveURL(/#chat$/);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Жильё: первый маршрут готов" }),
  ).toBeVisible();
  await page.goto("/#complete/not-a-completed-quest");
  await expect(
    page.getByRole("heading", { name: "Ваш план переезда" }),
  ).toBeVisible();
});

test("unconfigured provider disables chat; server rejection never displays success", async ({
  page,
}) => {
  const board = fixture();
  board.provider = "unconfigured";
  board.aiAccess = { policy: null, granted: false, dailyLimit: 20 };
  await dashboard(page, board);
  await page.route("**/api/v1/quests/*/complete", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "Сначала обсудите квест с Housing Navigator" },
    }),
  );
  await page.goto("/#chat");
  await expect(page.getByRole("note")).toContainText("AI ещё не подключён");
  await expect(page.getByLabel("Сообщение помощнику")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "До 30 минут в пути", exact: true }),
  ).toBeDisabled();
  for (const checkbox of await page
    .locator("#quest")
    .getByRole("checkbox")
    .all())
    await checkbox.check();
  await page.getByRole("button", { name: "Завершить квест · +60 XP" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Сначала обсудите",
  );
  await expect(page).toHaveURL(/#chat$/);
  await expect(page.locator(".account")).toContainText("0 XP");
  await expect(page.locator(".journey-success")).toHaveCount(0);
});

test("chat errors preserve the draft; stopping is possible before the first token", async ({
  page,
}) => {
  await dashboard(page, fixture());
  await page.route("**/api/v1/threads/*/messages", (route) =>
    route.fulfill({ status: 503, json: { error: "Попробуйте позже" } }),
  );
  await page.goto("/#chat");
  await page.getByLabel("Сообщение помощнику").fill("Помоги с квартирой");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Попробуйте позже",
  );
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(
    "Помоги с квартирой",
  );
  await page.unroute("**/api/v1/threads/*/messages");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/threads/*/messages", async (route) => {
    await gate;
    await route.abort().catch(() => {});
  });
  try {
    await page.getByRole("button", { name: "Отправить", exact: true }).click();
    await expect(page.getByRole("log")).toContainText("Готовлю ответ");
    await page.getByRole("button", { name: "Стоп", exact: true }).click();
    await expect(page.getByLabel("Сообщение помощнику")).toBeEnabled();
    await expect(page.getByRole("status")).toContainText("Ответ остановлен");
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  } finally {
    release();
  }
});

test("handoff updates the agent and interrupted history remains readable after reload", async ({
  page,
}) => {
  const board = fixture();
  await dashboard(page, board);
  await page.route("**/api/v1/threads/*/messages", async (route) => {
    board.thread!.agentKey = "job-search";
    board.thread!.messages = [
      {
        id: "ui-message-1",
        role: "user",
        content: "Помоги найти работу",
        agentKey: "job-search",
        status: "complete",
      },
      {
        id: "ui-message-2",
        role: "assistant",
        content: "Обсудим опыт и подходящие вакансии.",
        agentKey: "job-search",
        status: "interrupted",
      },
    ];
    const events = [
      {
        type: "handoff",
        from: "housing",
        to: "job-search",
        reason: "Передаю вопрос помощнику по работе",
      },
      { type: "delta", text: "Обсудим опыт и подходящие вакансии." },
      { type: "error", message: "Соединение прервано" },
    ];
    await route.fulfill({
      contentType: "text/event-stream",
      body: events
        .map((event) => "data: " + JSON.stringify(event) + "\n\n")
        .join(""),
    });
  });
  await page.goto("/#chat");
  await page.getByLabel("Сообщение помощнику").fill("Помоги найти работу");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Job Search Mentor", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Передаю вопрос");
  await expect(page.getByRole("log")).toContainText("Ответ не завершён");
  await page.reload();
  await expect(page.getByRole("log")).toContainText("Обсудим опыт");
  await expect(
    page.getByRole("button", { name: "Вернёмся к поиску квартиры" }),
  ).toBeVisible();
});
