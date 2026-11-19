import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  conversationDetailResponseSchema,
  dashboardResponseSchema,
} from "../packages/contracts/dist/index.js";
import type {
  AgentKey,
  AiModeId,
  AssistantContextInput,
  Dashboard,
  Message,
  PersonalPlanItem,
} from "@citygo/contracts";
import { resolve } from "node:path";
import { openMessageActions } from "./navigation-helper";

const hosts = {
  telegram: {
    fragment: "tgWebAppData",
    script: "https://telegram.org/js/telegram-web-app.js?65",
    setup: "window.Telegram = { WebApp: sdk }",
  },
  max: {
    fragment: "WebAppData",
    script: "https://st.max.ru/js/max-web-app.js",
    setup: "window.WebApp = sdk",
  },
};
type Host = keyof typeof hosts;
type Thread = NonNullable<Dashboard["thread"]>;
type Send = {
  text: string;
  requestId: string;
  aiMode: AiModeId;
  aiModeCatalogId: string;
};
type Attempt = "missing" | "running" | "complete" | "interrupted";

const owner = "101";
const threadId = "20";
const answerId = "101";
const date = "2026-11-19T00:00:00Z";
const catalogId = "b".repeat(64);
const policyId = "a".repeat(64);
const question = "Как сравнить варианты переезда?";
const reply = "Запишите маршрут и сравните условия.";
const reviewed = "Только мой проверенный фрагмент для резюме";
const earlier = "Сохранённое раннее сообщение";
const modeLabels = [
  ["maximum", "Максимум"],
  ["balanced", "Баланс"],
  ["minimum", "Минимум"],
] as const;

const input = (page: Page) =>
  page.getByLabel("Сообщение помощнику", { exact: true });
const sendButton = (page: Page) =>
  page.getByRole("button", { name: "Отправить", exact: true });
const nav = (page: Page) =>
  page.getByRole("navigation", { name: "Личный кабинет CityGo" });
const chatLog = (page: Page) =>
  page.getByRole("log", { name: "История диалога" });

async function setupConversation(
  context: BrowserContext,
  host: Host,
  available = true,
) {
  const botProof = `synthetic-${host}-conversation`;
  const prefix = `/api/v1/mini-apps/${host}`;
  const user = {
    id: owner,
    email: "mini-chat@example.test",
    role: "user",
  } as const;
  const threads = new Map<string, Thread>([
    [
      threadId,
      {
        id: threadId,
        assistantKey: "support",
        agentKey: "support",
        closed: false,
        messagesNextCursor: "100",
        messages: [
          {
            id: "100",
            role: "user",
            agentKey: "support",
            status: "complete",
            content: question,
          },
          {
            id: answerId,
            role: "assistant",
            agentKey: "support",
            status: "complete",
            content: reply,
            generation: {
              provider: "routerai",
              requestedModel: "openai/gpt-6.1-sol",
              model: "openai/gpt-6.1-sol",
              webSources: {
                version: "routerai_native_v1",
                citations: [
                  {
                    url: "https://example.com/transport",
                    title: "Проверочный источник",
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  ]);
  const plan: PersonalPlanItem[] = [];
  const state = {
    external: [] as string[],
    unexpected: [] as string[],
    starts: [] as AgentKey[],
    reads: [] as string[],
    statusReads: [] as string[],
    previews: [] as AssistantContextInput[],
    sends: [] as Send[],
    accepted: new Map<string, Attempt>(),
    stream: "complete" as "complete" | "lost-before" | "lost-after" | "stop",
    finish: () => {},
    favorites: [] as Array<{ messageId: string; saved: boolean }>,
    plan,
    capabilities: 0,
  };
  let nextId = 200;
  const board = (): Dashboard =>
    dashboardResponseSchema.parse({
      user,
      profile: null,
      quests: [],
      xp: 0,
      provider: "routerai",
      thread: threads.get(threadId)!,
      assistantContextAvailable: true,
      aiAccess: {
        policy: {
          id: policyId,
          version: "synthetic",
          provider: "routerai",
          model: "synthetic/example",
          recipient: "Synthetic",
          routing: "Synthetic",
          data: "Synthetic",
        },
        granted: true,
        dailyLimit: 20,
        modes: {
          catalogId,
          defaultMode: "balanced",
          options: modeLabels.map(([id, label]) => ({
            id,
            label,
            available: true,
            consentRequired: false,
          })),
        },
      },
    });
  board();
  await context.route("https://**", (route) => {
    state.external.push(route.request().url());
    return route.abort();
  });
  await context.route(hosts[host].script, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `const sdk = {initData:${JSON.stringify(botProof)},openLink(){throw new Error('Unexpected external handoff')}}; ${hosts[host].setup};`,
    }),
  );
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === prefix + "/funnel" && method === "POST")
      return route.fulfill({ status: 204 });
    if (path === prefix + "/chat" && method === "GET") {
      state.capabilities++;
      return route.fulfill({ json: { available } });
    }
    if (path === "/api/v1/dashboard" && method === "GET")
      return route.fulfill({ json: board() });
    if (path === "/api/v1/account/messenger-links" && method === "GET")
      return route.fulfill({ json: { providers: [] } });
    if (path === "/api/v1/conversations" && method === "GET") {
      return route.fulfill({
        json: {
          userId: owner,
          conversations: Array.from(
            threads.values(),
            ({ id, agentKey, assistantKey, closed, messages }) => ({
              id,
              agentKey,
              assistantKey,
              closed,
              updatedAt: date,
              preview: messages.at(-1)?.content ?? "",
            }),
          ),
          nextCursor: null,
        },
      });
    }
    if (path === "/api/v1/conversations/start" && method === "POST") {
      const { agentKey } = request.postDataJSON() as { agentKey: AgentKey };
      state.starts.push(agentKey);
      const id = String(20 + state.starts.length);
      const thread = {
        id,
        agentKey,
        assistantKey: agentKey,
        closed: false,
        messages: [],
      };
      threads.set(id, thread);
      return route.fulfill({
        json: { id, agentKey, assistantKey: agentKey, closed: false },
      });
    }
    const detail = path.match(/^\/api\/v1\/conversations\/(\d+)$/);
    if (detail && method === "GET") {
      const thread = threads.get(detail[1]!);
      expect(thread).toBeDefined();
      state.reads.push(path);
      return route.fulfill({
        json: conversationDetailResponseSchema.parse({ userId: owner, thread }),
      });
    }
    if (
      path === `/api/v1/conversations/${threadId}/messages` &&
      method === "GET"
    ) {
      expect(url.searchParams.get("before")).toBe("100");
      state.reads.push(path);
      return route.fulfill({
        json: {
          userId: owner,
          threadId,
          messages: [
            {
              id: "99",
              role: "assistant",
              agentKey: "support",
              status: "complete",
              content: earlier,
            },
          ],
          nextCursor: null,
        },
      });
    }
    if (path === "/api/v1/ai/context-preview" && method === "POST") {
      const payload = request.postDataJSON() as AssistantContextInput;
      state.previews.push(payload);
      return route.fulfill({
        json: {
          userId: owner,
          threadId: payload.threadId,
          generatedAt: date,
          profile: {
            targetCity: null,
            monthlyBudget: null,
            moveTargetDate: null,
            household: null,
          },
          agentKey: "support",
          closed: false,
          draftIncluded: Boolean(payload.draft.trim()),
          messages: [
            { role: "user", content: question },
            { role: "assistant", content: reply },
          ],
        },
      });
    }
    if (path === `/api/v1/messages/${answerId}/favorite` && method === "POST") {
      const { saved } = request.postDataJSON() as { saved: boolean };
      threads.get(threadId)!.messages[1]!.favorite = saved;
      const change = { messageId: answerId, saved };
      state.favorites.push(change);
      return route.fulfill({ json: change });
    }
    if (path === "/api/v1/personal-plan" && method === "POST") {
      const { sourceMessageId, title, details } = request.postDataJSON() as {
        sourceMessageId: string;
        title: string;
        details: string;
      };
      expect(sourceMessageId).toBe(answerId);
      const item: PersonalPlanItem = {
        id: "301",
        title,
        details,
        status: "pending",
        revision: 1,
        source: { threadId, messageId: sourceMessageId, role: "assistant" },
        createdAt: date,
        updatedAt: date,
      };
      plan.push(item);
      return route.fulfill({ json: { userId: owner, item } });
    }
    if (path === "/api/v1/personal-plan" && method === "GET")
      return route.fulfill({
        json: { userId: owner, items: plan, nextBefore: null },
      });
    if (path === "/api/v1/personal-plan/summary" && method === "GET")
      return route.fulfill({
        json: {
          userId: owner,
          total: plan.length,
          pending: plan.length,
          completed: 0,
        },
      });
    if (
      path.startsWith(prefix + `/threads/${threadId}/messages/`) &&
      method === "GET"
    ) {
      const id = path.split("/").at(-1)!;
      state.statusReads.push(id);
      return route.fulfill({
        json: { status: state.accepted.get(id) ?? "missing" },
      });
    }
    if (
      path === prefix + `/threads/${threadId}/messages` &&
      method === "POST"
    ) {
      expect(available).toBe(true);
      const payload = request.postDataJSON() as Send;
      expect(payload.aiModeCatalogId).toBe(catalogId);
      state.sends.push(payload);
      if (state.stream === "lost-before") {
        state.stream = "complete";
        return route.abort("connectionreset");
      }
      expect(state.accepted.has(payload.requestId)).toBe(false);
      const messages = threads.get(threadId)!.messages;
      const userMessage: Message = {
        id: String(nextId++),
        role: "user",
        agentKey: "support",
        status: "complete",
        content: payload.text,
      };
      const responseText = `Проверочный ответ (${payload.aiMode}).`;
      const messageId = String(nextId++);
      if (state.stream === "stop") {
        state.accepted.set(payload.requestId, "running");
        messages.push(userMessage);
        await new Promise<void>((done) => {
          state.finish = done;
        });
        state.accepted.set(payload.requestId, "interrupted");
        messages.push({
          id: messageId,
          role: "assistant",
          agentKey: "support",
          status: "interrupted",
          content: "Частичный тестовый ответ",
        });
        return route.abort("aborted");
      }
      messages.push(userMessage, {
        id: messageId,
        role: "assistant",
        agentKey: "support",
        status: "complete",
        content: responseText,
      });
      state.accepted.set(payload.requestId, "complete");
      if (state.stream === "lost-after") {
        state.stream = "complete";
        return route.abort("connectionreset");
      }
      return route.fulfill({
        contentType: "text/event-stream; charset=utf-8",
        body: [
          { type: "delta", text: responseText },
          { type: "done", messageId },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      });
    }
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected mini-app test request" },
    });
  });
  return state;
}

async function openChat(page: Page, host: Host) {
  await page.goto(
    `/mini/${host}#${hosts[host].fragment}=synthetic-${host}-conversation`,
  );
  await expect(page).toHaveURL(new RegExp(`/mini/${host}$`));
  await page
    .getByRole("button", { name: "Войти в CityGo", exact: true })
    .click();
  await page.getByRole("button", { name: "Не сейчас", exact: true }).click();
  await nav(page).getByRole("button", { name: "Диалоги", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Открыть разговор: Координатор переезда",
      exact: true,
    })
    .click();
  await expect(input(page)).toBeVisible();
}

async function chooseMode(page: Page, label: string) {
  await page.getByRole("button", { name: "Режим работы", exact: true }).click();
  await page.getByRole("button", { name: label, exact: true }).click();
}

function expectIsolated(state: Awaited<ReturnType<typeof setupConversation>>) {
  expect(state.external).toEqual([]);
  expect(state.unexpected).toEqual([]);
}

for (const host of ["telegram", "max"] as const) {
  test(`${host}: paid chat stays closed while the account can use history, sources, context and the catalog`, async ({
    page,
    context,
  }) => {
    const state = await setupConversation(context, host, false);
    await openChat(page, host);
    await expect.poll(() => state.capabilities).toBeGreaterThan(0);
    await input(page).fill("Мой черновик остаётся в этом разговоре");
    await expect(sendButton(page)).toBeDisabled();
    await page
      .getByRole("button", { name: "Загрузить ранние сообщения", exact: true })
      .click();
    await expect(chatLog(page)).toContainText(earlier);
    const source = chatLog(page).locator(
      `article[data-history-message="${answerId}"]`,
    );
    await source
      .getByRole("button", { name: "Источники ответа", exact: true })
      .click();
    const citation = page.getByRole("link", { name: /Проверочный источник/ });
    await expect(citation).toHaveAttribute(
      "href",
      "https://example.com/transport",
    );
    await expect(citation).toHaveAttribute("rel", /noopener.*noreferrer/);
    await page
      .getByRole("banner")
      .getByRole("button", { name: "Назад", exact: true })
      .click();
    await expect(citation).toHaveCount(0);

    await chooseMode(page, "Минимум");
    await page
      .getByRole("button", { name: "Что помощники знают", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Что помощники знают", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => state.previews)
      .toMatchObject([
        {
          threadId,
          aiMode: "minimum",
          draft: "Мой черновик остаётся в этом разговоре",
        },
      ]);
    await page
      .getByRole("button", { name: "Вернуться назад", exact: true })
      .click();
    await expect(input(page)).toHaveValue(
      "Мой черновик остаётся в этом разговоре",
    );

    await source
      .getByRole("button", { name: "В избранное", exact: true })
      .click();
    await expect(
      source.getByRole("button", { name: "В избранном", exact: true }),
    ).toBeVisible();
    expect(state.favorites).toEqual([{ messageId: answerId, saved: true }]);
    await source
      .getByRole("button", { name: "Сохранить в план", exact: true })
      .click();
    await page
      .getByLabel("Название шага", { exact: true })
      .fill("Сравнить два маршрута");
    expect(state.plan).toEqual([]);
    await page
      .getByRole("button", { name: "Подтвердить добавление", exact: true })
      .click();
    await expect(
      page.getByText("Сравнить два маршрута", { exact: true }),
    ).toBeVisible();
    expect(state.plan).toMatchObject([
      { source: { threadId, messageId: answerId } },
    ]);

    await nav(page)
      .getByRole("button", { name: "Диалоги", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Открыть разговор: Координатор переезда",
        exact: true,
      })
      .click();
    await openMessageActions(source);
    await source
      .getByRole("button", { name: "Другому помощнику", exact: true })
      .click();
    await page
      .getByLabel("Кому передать фрагмент", { exact: true })
      .selectOption("resume-builder");
    await page.getByLabel("Что передаём", { exact: true }).fill(reviewed);
    expect(state.starts).toEqual([]);
    await page
      .getByRole("button", { name: "Подготовить разговор", exact: true })
      .click();
    await expect(input(page)).toHaveValue(reviewed);
    expect(state.starts).toEqual(["resume-builder"]);
    await expect(sendButton(page)).toBeDisabled();

    await nav(page)
      .getByRole("button", { name: "Диалоги", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Новый диалог", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Каталог помощников", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Помощник по работе", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Помощник по работе", exact: true }),
    ).toBeVisible();
    await expect(input(page)).toHaveValue("");
    expect(state.starts).toEqual(["resume-builder", "job-search"]);
    expect(state.sends).toEqual([]);
    expectIsolated(state);
  });
}

test("local PDF and TXT preview, removal and format error keep a long editor reachable over the keyboard", async ({
  page,
  context,
}) => {
  const state = await setupConversation(context, "telegram", false);
  await page.setViewportSize({ width: 320, height: 680 });
  await openChat(page, "telegram");
  const longText = "🧳".repeat(100_000);
  await input(page).fill(longText);
  expect(await input(page).inputValue()).toBe(longText);
  await input(page).fill(question);
  await input(page).focus();
  await page.setViewportSize({ width: 320, height: 390 });
  await expect(page.locator('[data-mini-keyboard="open"]')).toBeVisible();
  await expect
    .poll(() =>
      input(page).evaluate(
        (element) =>
          element.getBoundingClientRect().bottom <=
          (window.visualViewport?.height ?? window.innerHeight) + 1,
      ),
    )
    .toBe(true);
  await input(page).blur();
  await page.setViewportSize({ width: 320, height: 680 });

  const startAttachment = () =>
    page
      .getByRole("button", { name: "Прикрепить PDF или TXT", exact: true })
      .click();
  const upload = page.getByLabel(
    "TXT до 1 МБ или PDF с текстом до 8 МБ и 50 страниц",
    { exact: true },
  );
  await startAttachment();
  await upload.setInputFiles({
    name: "unknown.png",
    mimeType: "image/png",
    buffer: Buffer.from("Synthetic unsupported file"),
  });
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Поддерживаются TXT-файлы",
  );
  await upload.setInputFiles(
    resolve(process.cwd(), "e2e/fixtures/pdf/long-text.pdf"),
  );
  await expect(
    page.getByLabel("Текст из PDF-файла", { exact: true }),
  ).toHaveValue(/Строка 000:[\s\S]*Строка 089:/);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Удалить вложение", exact: true })
    .click();
  await expect(
    page.getByLabel("Текст из PDF-файла", { exact: true }),
  ).toHaveCount(0);
  if (!(await upload.count())) await startAttachment();
  await upload.setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Синтетическая заметка"),
  });
  await expect(
    page.getByLabel("Текст из TXT-файла", { exact: true }),
  ).toHaveValue("Синтетическая заметка");
  await page
    .getByRole("button", { name: "Добавить в сообщение", exact: true })
    .click();
  await expect(page.getByText("note.txt", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Удалить вложение", exact: true })
    .click();
  await expect(page.getByText("note.txt", { exact: true })).toHaveCount(0);
  await expect(input(page)).toHaveValue(question);
  expect(state.sends).toEqual([]);
  expectIsolated(state);
});

test("three modes send once each and render persisted deterministic answers", async ({
  page,
  context,
}) => {
  const state = await setupConversation(context, "max");
  await openChat(page, "max");
  for (const [mode, label] of modeLabels) {
    await chooseMode(page, label);
    const text =
      mode === "maximum"
        ? "🧳".repeat(100_000)
        : `Синтетический вопрос, режим ${label}`;
    await input(page).fill(text);
    await sendButton(page).click();
    await expect(
      chatLog(page).locator("article[data-history-message]"),
    ).toContainText([new RegExp(`Проверочный ответ \\(${mode}\\)\\.`)]);
  }
  expect(state.sends[0]?.text).toBe("🧳".repeat(100_000));
  expect(state.sends.map(({ aiMode }) => aiMode)).toEqual(
    modeLabels.map(([mode]) => mode),
  );
  expect(state.accepted.size).toBe(3);
  expectIsolated(state);
});

const verifyRecovery = (page: Page) =>
  page.getByRole("button", { name: "Проверить диалог", exact: true });
const retry = (page: Page) =>
  page.getByRole("button", { name: "Повторить отправку", exact: true });

test("a lost request needs an authoritative read before retrying the same UUID; a committed reply never replays", async ({
  page,
  context,
}) => {
  const state = await setupConversation(context, "telegram");
  await openChat(page, "telegram");
  state.stream = "lost-before";
  await input(page).fill("Запрос потерян до приёма");
  await sendButton(page).click();
  await expect(verifyRecovery(page)).toBeVisible();
  await expect(retry(page)).toHaveCount(0);
  expect(state.sends).toHaveLength(1);
  await context.setOffline(true);
  await expect(verifyRecovery(page)).toBeDisabled();
  await context.setOffline(false);
  await verifyRecovery(page).click();
  await expect(retry(page)).toBeVisible();
  expect(state.statusReads).toContain(state.sends[0]!.requestId);
  await retry(page).click();
  await expect(
    chatLog(page).getByText("Запрос потерян до приёма", { exact: true }),
  ).toHaveCount(1);
  expect(state.sends).toHaveLength(2);
  expect(state.sends[1]).toEqual(state.sends[0]);
  expect(state.accepted.size).toBe(1);

  state.stream = "lost-after";
  await input(page).fill("Ответ сохранён до обрыва сети");
  await sendButton(page).click();
  await expect(verifyRecovery(page)).toBeVisible();
  await expect(retry(page)).toHaveCount(0);
  await verifyRecovery(page).click();
  const back = page.getByRole("button", {
    name: "Вернуться к диалогу",
    exact: true,
  });
  await expect(back).toBeVisible();
  await expect(retry(page)).toHaveCount(0);
  expect(state.statusReads).toContain(state.sends[2]!.requestId);
  await back.click();
  await expect(
    chatLog(page).getByText("Ответ сохранён до обрыва сети", { exact: true }),
  ).toHaveCount(1);
  expect(state.sends).toHaveLength(3);
  expect(state.accepted.size).toBe(2);
  expectIsolated(state);
});

test("stopping an accepted request recovers the interrupted message without another dispatch", async ({
  page,
  context,
}) => {
  const state = await setupConversation(context, "max");
  await openChat(page, "max");
  state.stream = "stop";
  await input(page).fill("Остановите этот ответ");
  await sendButton(page).click();
  await expect.poll(() => state.sends.length).toBe(1);
  await page
    .getByRole("button", { name: "Остановить ответ", exact: true })
    .click();
  state.finish();
  await verifyRecovery(page).click();
  await expect(
    page.getByRole("button", { name: "Вернуться к диалогу", exact: true }),
  ).toBeVisible();
  await expect(retry(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Вернуться к диалогу", exact: true })
    .click();
  await expect(chatLog(page)).toContainText("Частичный тестовый ответ");
  await expect(chatLog(page)).toContainText("Ответ прерван");
  expect(state.sends).toHaveLength(1);
  expect(state.statusReads).toContain(state.sends[0]!.requestId);
  expectIsolated(state);
});
