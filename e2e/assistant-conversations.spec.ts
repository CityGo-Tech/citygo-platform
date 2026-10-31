import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { AgentKey, Dashboard, Message } from "@citygo/contracts";

type Thread = NonNullable<Dashboard["thread"]> & {
  assistantKey: AgentKey | null;
  closed: boolean;
};
const names: Record<AgentKey, string> = {
  support: "Координатор переезда",
  housing: "Помощник по жилью",
  "job-search": "Помощник по работе",
  "resume-builder": "Помощник по резюме",
  "digital-mentor": "Гид по городской жизни",
};
const ids: Record<AgentKey, string> = {
  support: "20",
  housing: "21",
  "job-search": "22",
  "resume-builder": "23",
  "digital-mentor": "24",
};
const pair = (agentKey: AgentKey, base: number, marker: string): Message[] => [
  {
    id: String(base),
    role: "user",
    agentKey,
    status: "complete",
    content: "Вопрос " + marker,
  },
  {
    id: String(base + 1),
    role: "assistant",
    agentKey,
    status: "complete",
    content: "Ответ " + marker,
  },
];

async function install(context: BrowserContext, withProfile = false) {
  const threads = new Map<string, Thread>([
    [
      "10",
      {
        id: "10",
        agentKey: "support",
        assistantKey: null,
        closed: false,
        messages: pair("support", 100, "ОБЩИЙ_СОХРАНЁН"),
      },
    ],
  ]);
  const state = {
    owner: "101",
    responseOwner: null as string | null,
    authenticated: true,
    nextMessage: 1000,
    messages: 0,
    paymentPosts: 0,
    external: 0,
    starts: [] as (AgentKey | undefined)[],
    reads: [] as { owner: string; id: string }[],
    listQueries: [] as string[],
    failingReads: new Set<string>(),
    unexpected: [] as string[],
    waitForStream: false,
    releaseStream: () => {},
  };
  let release = () => {};
  const streamGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.releaseStream = release;
  const threadFor = (id: string) =>
    state.owner === "101"
      ? threads.get(id)
      : id === "110"
        ? {
            id: "110",
            agentKey: "support" as const,
            assistantKey: null,
            closed: false,
            messages: pair("support", 1100, "НОВЫЙ_ВЛАДЕЛЕЦ"),
          }
        : undefined;
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: "owner-" + state.owner + "@example.test",
      role: "user",
      mustChangePassword: false,
    },
    profile: withProfile
      ? {
          originCity: "Казань",
          targetCity: "Москва",
          monthlyBudget: 50000,
          moveTargetDate: "2099-01-01",
          household: "solo",
          aiConsent: true,
        }
      : null,
    xp: 0,
    quests: [],
    provider: "routerai",
    thread: threadFor(state.owner === "101" ? "10" : "110")!,
    aiAccess: {
      granted: true,
      dailyLimit: 100,
      policy: {
        id: "a".repeat(64),
        version: "synthetic",
        provider: "routerai",
        model: "test/model",
        recipient: "Synthetic only",
        routing: "No external transport",
        data: "Fictional fixture only",
      },
      credit: {
        currency: "RUB",
        bonusGranted: false,
        grantedMicros: 100_000_000,
        heldMicros: 0,
        spentMicros: 0,
        availableMicros: 100_000_000,
        chargingStatus: "routerai_citygo_10x",
        reservationMode: "fixed5_overdraft",
        minimumRequestBalanceMicros: 5_000_000,
        outstandingDebtMicros: 0,
        topUpAvailable: true,
        history: [],
      },
    },
  });
  // All application traffic is intercepted, with external HTTPS explicitly denied.
  // No database, actual model, checkout page or payment API is reachable here.
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
      return route.fulfill({
        status: 401,
        json: { error: "Synthetic signed out" },
      });
    if (path === "/api/v1/dashboard") return route.fulfill({ json: board() });
    if (path === "/api/v1/personal-plan/summary" && request.method() === "GET")
      return route.fulfill({
        json: { userId: state.owner, total: 0, pending: 0, completed: 0 },
      });
    if (path === "/api/v1/personal-plan" && request.method() === "GET")
      return route.fulfill({
        json: { userId: state.owner, items: [], nextBefore: null },
      });
    if (path === "/api/v1/conversations" && request.method() === "GET") {
      state.listQueries.push(url.search);
      const rows = (
        state.owner === "101" ? [...threads.values()] : [threadFor("110")!]
      )
        .filter(
          (thread) =>
            (!url.searchParams.has("assistantKey") ||
              thread.assistantKey === url.searchParams.get("assistantKey")) &&
            (!url.searchParams.has("status") ||
              thread.closed ===
                (url.searchParams.get("status") === "closed")) &&
            (!url.searchParams.has("search") ||
              thread.messages.some(
                (message) =>
                  ["user", "assistant"].includes(message.role) &&
                  message.content
                    .toLowerCase()
                    .includes(url.searchParams.get("search")!.toLowerCase()),
              )),
        )
        .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
      return route.fulfill({
        json: {
          userId: state.responseOwner ?? state.owner,
          conversations: rows.map(
            ({ id, agentKey, assistantKey, closed, messages }) => ({
              id,
              agentKey,
              assistantKey,
              closed,
              updatedAt: "2026-10-22T00:00:00.000Z",
              preview: messages.at(-1)?.content ?? "",
            }),
          ),
          nextCursor: null,
        },
      });
    }
    if (path === "/api/v1/conversations/start" && request.method() === "POST") {
      const input = request.postDataJSON() as { agentKey?: AgentKey };
      state.starts.push(input.agentKey);
      const id = input.agentKey ? ids[input.agentKey] : "10";
      if (!threads.has(id))
        threads.set(id, {
          id,
          agentKey: input.agentKey!,
          assistantKey: input.agentKey!,
          closed: false,
          messages: [],
        });
      return route.fulfill({
        json: {
          id,
          agentKey: threads.get(id)!.agentKey,
          assistantKey: threads.get(id)!.assistantKey,
          closed: false,
        },
      });
    }
    const read = path.match(/^\/api\/v1\/conversations\/(\d+)$/);
    if (read && request.method() === "GET") {
      state.reads.push({ owner: state.owner, id: read[1]! });
      if (state.failingReads.has(read[1]!))
        return route.fulfill({
          status: 500,
          json: { error: "Synthetic history unavailable" },
        });
      const thread = threadFor(read[1]!);
      return route.fulfill(
        thread
          ? { json: { userId: state.responseOwner ?? state.owner, thread } }
          : {
              status: 404,
              json: { error: "Synthetic conversation not found" },
            },
      );
    }
    const send = path.match(/^\/api\/v1\/threads\/(\d+)\/messages$/);
    if (send && request.method() === "POST") {
      state.messages++;
      const thread = threadFor(send[1]!)!;
      const payload = request.postDataJSON() as {
        text: string;
        creditReservationMode?: string;
      };
      expect(payload.creditReservationMode).toBe("fixed5_overdraft");
      if (state.waitForStream) await streamGate;
      const content = "ПОЗДНИЙ_ОТВЕТ_ТОЛЬКО_ДЛЯ_ЖИЛЬЯ";
      thread.messages.push(
        {
          id: String(state.nextMessage++),
          role: "user",
          agentKey: thread.agentKey,
          status: "complete",
          content: payload.text,
        },
        {
          id: String(state.nextMessage++),
          role: "assistant",
          agentKey: thread.agentKey,
          status: "complete",
          content,
        },
      );
      try {
        await route.fulfill({
          contentType: "text/event-stream; charset=utf-8",
          body:
            "data: " +
            JSON.stringify({ type: "delta", text: content }) +
            "\n\n" +
            "data: " +
            JSON.stringify({
              type: "done",
              messageId: thread.messages.at(-1)!.id,
            }) +
            "\n\n",
        });
      } catch {
        /* An invalidated session may abort its old synthetic response. */
      }
      return;
    }
    if (path === "/api/v1/messages/favorites" && request.method() === "GET") {
      // Match the real MessageFavorites query: original numeric message ID
      // descending across every thread, never thread insertion order.
      const saved = [...threads.values()]
        .flatMap((thread) =>
          thread.messages
            .filter((message) => message.favorite)
            .map((message) => ({ ...message, threadId: thread.id })),
        )
        .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
      return route.fulfill({
        json: {
          userId: state.owner,
          messages: state.owner === "101" ? saved : [],
          nextBefore: null,
        },
      });
    }
    const favorite = path.match(/^\/api\/v1\/messages\/(\d+)\/favorite$/);
    if (favorite && request.method() === "POST") {
      const { saved } = request.postDataJSON() as { saved: boolean };
      const message = [...threads.values()]
        .flatMap((thread) => thread.messages)
        .find((value) => value.id === favorite[1]);
      expect(message).toBeTruthy();
      message!.favorite = saved;
      return route.fulfill({ json: { messageId: favorite[1], saved } });
    }
    if (path.startsWith("/api/v1/payments/") && request.method() === "POST")
      state.paymentPosts++;
    state.unexpected.push(request.method() + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  return { state, threads };
}

async function allConversations(page: Page) {
  const back = page.getByRole("button", { name: "Все диалоги", exact: true });
  if (await back.isVisible()) await back.click();
  else await page.getByRole("button", { name: "Диалоги", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ваши разговоры", exact: true }),
  ).toBeVisible();
}
async function begin(page: Page, agentKey: AgentKey) {
  await page.getByRole("button", { name: "Помощники", exact: true }).click();
  await page
    .getByRole("article", { name: names[agentKey], exact: true })
    .getByRole("button", { name: "Начать разговор", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: names[agentKey], exact: true }),
  ).toBeVisible();
}

test("each helper opens an independent conversation without auto-send; history and cross-conversation favorites survive reload", async ({
  page,
  context,
}, testInfo) => {
  const f = await install(context);
  await page.goto("/");
  await allConversations(page);
  await expect(
    page.getByRole("article", { name: "Общий диалог", exact: true }),
  ).toContainText("ОБЩИЙ_СОХРАНЁН");
  await begin(page, "housing");
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("");
  await expect(
    page.getByRole("log", { name: "История диалога", exact: true }),
  ).toContainText("Здравствуйте!");
  expect(f.state.messages).toBe(0);
  expect(f.state.starts).toEqual(["housing"]);
  // Seed earlier completed history in the mock server; opening/selecting is not
  // permission to generate a message, and the fixture never invokes a provider.
  f.threads.get(ids.housing)!.messages = pair("housing", 200, "ТОЛЬКО_ЖИЛЬЁ");
  await page.reload();
  const log = page.getByRole("log", { name: "История диалога", exact: true });
  await expect(log).toContainText("ТОЛЬКО_ЖИЛЬЁ");
  await log
    .getByRole("button", { name: "В избранное", exact: true })
    .last()
    .click();
  await begin(page, "job-search");
  await expect(log).not.toContainText("ТОЛЬКО_ЖИЛЬЁ");
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("");
  f.threads.get(ids["job-search"])!.messages = pair(
    "job-search",
    300,
    "ТОЛЬКО_РАБОТА",
  );
  await page.reload();
  await expect(log).toContainText("ТОЛЬКО_РАБОТА");
  await expect(log).not.toContainText("ТОЛЬКО_ЖИЛЬЁ");
  await log
    .getByRole("button", { name: "В избранное", exact: true })
    .last()
    .click();
  await allConversations(page);
  await page.screenshot({
    path: testInfo.outputPath("conversation-list.png"),
    fullPage: true,
  });
  await page
    .getByRole("article", { name: "Диалог: " + names.housing, exact: true })
    .getByRole("button", { name: "Открыть разговор", exact: true })
    .click();
  await expect(log).toContainText("ТОЛЬКО_ЖИЛЬЁ");
  await expect(log).not.toContainText("ТОЛЬКО_РАБОТА");
  await page.getByRole("button", { name: "Избранное", exact: true }).click();
  const favorites = page.getByRole("region", {
    name: "Избранные сообщения",
    exact: true,
  });
  await expect(favorites).toContainText("ТОЛЬКО_ЖИЛЬЁ");
  await expect(favorites).toContainText("ТОЛЬКО_РАБОТА");
  await expect(favorites.getByRole("article")).toHaveCount(2);
  await expect(favorites.getByRole("article").first()).toHaveAttribute(
    "aria-label",
    "Сохранённое сообщение 301",
  );
  await expect(favorites.getByRole("article").last()).toHaveAttribute(
    "aria-label",
    "Сохранённое сообщение 201",
  );
  await favorites
    .getByRole("button", { name: "← В приложение", exact: true })
    .click();
  await allConversations(page);
  await page
    .getByRole("article", { name: "Общий диалог", exact: true })
    .getByRole("button", { name: "Открыть разговор", exact: true })
    .click();
  await expect(log).toContainText("ОБЩИЙ_СОХРАНЁН");
  for (const key of ["support", "resume-builder", "digital-mentor"] as const)
    await begin(page, key);
  await page.getByRole("button", { name: "Помощники", exact: true }).click();
  await expect(
    page
      .getByRole("article", { name: "Bubble", exact: true })
      .getByRole("button", { name: "Bubble · скоро", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("assistant-catalog.png"),
    fullPage: true,
  });
  expect(f.state.starts).toEqual([
    "housing",
    "job-search",
    "support",
    "resume-builder",
    "digital-mentor",
  ]);
  expect(f.state.messages).toBe(0);
  expect(f.state.paymentPosts).toBe(0);
  expect(f.state.external).toBe(0);
  expect(f.state.unexpected).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("a pending stream cannot switch threads or leak late content after multi-tab logout and a different owner reload", async ({
  page,
  context,
}) => {
  const f = await install(context);
  await page.goto("/");
  await begin(page, "housing");
  f.state.waitForStream = true;
  try {
    await page
      .getByLabel("Сообщение помощнику")
      .fill("Синтетический единственный вопрос о жилье");
    await page.getByRole("button", { name: "Отправить", exact: true }).click();
    await expect.poll(() => f.state.messages).toBe(1);
    await expect(
      page.getByRole("button", { name: "Все диалоги", exact: true }),
    ).toBeDisabled();
    const second = await context.newPage();
    await second.goto("/");
    await begin(second, "job-search");
    await second.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Создать аккаунт", exact: true }),
    ).toBeVisible();
    f.state.owner = "202";
    f.state.authenticated = true;
    f.state.releaseStream();
    await page.reload();
    await expect(page.getByText("ПОЗДНИЙ_ОТВЕТ_ТОЛЬКО_ДЛЯ_ЖИЛЬЯ")).toHaveCount(
      0,
    );
    await expect(
      page.getByText("Синтетический единственный вопрос о жилье"),
    ).toHaveCount(0);
    await allConversations(page);
    await page
      .getByRole("article", { name: "Общий диалог", exact: true })
      .getByRole("button", { name: "Открыть разговор", exact: true })
      .click();
    await expect(page.getByRole("log")).toContainText("НОВЫЙ_ВЛАДЕЛЕЦ");
    expect(
      f.state.reads.filter(
        ({ owner, id }) => owner === "202" && id === ids.housing,
      ),
    ).toEqual([]);
    expect(f.state.messages).toBe(1);
    expect(f.state.paymentPosts).toBe(0);
    expect(f.state.external).toBe(0);
    expect(f.state.unexpected).toEqual([]);
  } finally {
    f.state.releaseStream();
  }
});

test("legacy profiles can open assistants; missing saved selection falls back, closed history stays read-only and drafts belong to their conversation", async ({
  page,
  context,
}) => {
  const f = await install(context, true);
  f.threads.set("30", {
    id: "30",
    agentKey: "housing",
    assistantKey: "housing",
    closed: true,
    messages: pair("housing", 400, "ЗАВЕРШЁННАЯ_ИСТОРИЯ"),
  });
  await page.addInitScript(() => {
    localStorage.setItem("citygo:conversation:101", "999");
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Ваш план переезда", exact: true }),
  ).toBeVisible();
  expect(f.state.reads).toContainEqual({ owner: "101", id: "999" });
  expect(
    await page.evaluate(() => localStorage.getItem("citygo:conversation:101")),
  ).toBeNull();
  await page
    .getByRole("button", { name: "Диалоги и помощники", exact: true })
    .click();
  await allConversations(page);
  const closed = page
    .getByRole("article", { name: "Диалог: " + names.housing, exact: true })
    .filter({ hasText: "ЗАВЕРШЁННАЯ_ИСТОРИЯ" });
  await expect(closed).toContainText("ИСТОРИЯ");
  await closed
    .getByRole("button", { name: "Открыть разговор", exact: true })
    .click();
  const log = page.getByRole("log", { name: "История диалога", exact: true });
  await expect(log).toContainText("ЗАВЕРШЁННАЯ_ИСТОРИЯ");
  await expect(page.getByLabel("Сообщение помощнику")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Отправить", exact: true }),
  ).toHaveCount(0);
  await log
    .getByRole("button", { name: "В избранное", exact: true })
    .last()
    .click();
  await begin(page, "housing");
  const composer = page.getByLabel("Сообщение помощнику");
  await expect(composer).toHaveValue("");
  await composer.fill("ЧЕРНОВИК_ЖИЛЬЯ_НЕ_ОТПРАВЛЕН");
  await begin(page, "job-search");
  await expect(composer).toHaveValue("");
  await composer.fill("ЧЕРНОВИК_РАБОТЫ_НЕ_ОТПРАВЛЕН");
  await allConversations(page);
  await page
    .getByRole("article", { name: "Диалог: " + names.housing, exact: true })
    .filter({ hasNotText: "ЗАВЕРШЁННАЯ_ИСТОРИЯ" })
    .getByRole("button", { name: "Открыть разговор", exact: true })
    .click();
  await expect(composer).toHaveValue("ЧЕРНОВИК_ЖИЛЬЯ_НЕ_ОТПРАВЛЕН");
  await expect(log).not.toContainText("ЧЕРНОВИК_РАБОТЫ_НЕ_ОТПРАВЛЕН");
  await allConversations(page);
  await page
    .getByRole("article", {
      name: "Диалог: " + names["job-search"],
      exact: true,
    })
    .getByRole("button", { name: "Открыть разговор", exact: true })
    .click();
  await expect(composer).toHaveValue("ЧЕРНОВИК_РАБОТЫ_НЕ_ОТПРАВЛЕН");
  await expect(log).not.toContainText("ЧЕРНОВИК_ЖИЛЬЯ_НЕ_ОТПРАВЛЕН");
  await page.getByRole("button", { name: "Избранное", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Избранные сообщения", exact: true }),
  ).toContainText("ЗАВЕРШЁННАЯ_ИСТОРИЯ");
  expect(f.state.starts).toEqual(["housing", "job-search"]);
  expect(f.state.messages).toBe(0);
  expect(f.state.paymentPosts).toBe(0);
  expect(f.state.external).toBe(0);
  expect(f.state.unexpected).toEqual([]);
});

test("failed history read after a successful start never commits the new selection or routes the previous draft there on focus", async ({
  page,
  context,
}) => {
  const f = await install(context);
  await page.goto("/");
  await begin(page, "housing");
  await page
    .getByLabel("Сообщение помощнику")
    .fill("ЖИЛЬЁ_ЧЕРНОВИК_СОХРАНЁН_ПРИ_ОШИБКЕ");
  f.state.failingReads.add(ids["job-search"]);
  await page.getByRole("button", { name: "Помощники", exact: true }).click();
  await page
    .getByRole("article", { name: names["job-search"], exact: true })
    .getByRole("button", { name: "Начать разговор", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Synthetic history unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Помощники", exact: true }),
  ).toBeEnabled();
  expect(f.state.starts).toEqual(["housing", "job-search"]);
  expect(
    await page.evaluate(() => localStorage.getItem("citygo:conversation:101")),
  ).toBe(ids.housing);
  const readsBefore = f.state.reads.length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => f.state.reads.length).toBeGreaterThan(readsBefore);
  expect(f.state.reads.at(-1)).toEqual({ owner: "101", id: ids.housing });
  await page.getByRole("button", { name: "Мой план", exact: true }).click();
  await page
    .getByRole("button", { name: "Продолжить разговор", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: names.housing, exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(
    "ЖИЛЬЁ_ЧЕРНОВИК_СОХРАНЁН_ПРИ_ОШИБКЕ",
  );
  expect(f.state.messages).toBe(0);
  expect(f.state.paymentPosts).toBe(0);
  expect(f.state.external).toBe(0);
  expect(f.state.unexpected).toEqual([]);
});

for (const response of ["list", "detail"] as const) {
  test(`an unexpected conversation ${response} owner clears the current account instead of displaying a foreign response`, async ({
    page,
    context,
  }) => {
    const f = await install(context);
    await page.goto("/");
    await begin(page, "housing");
    await page
      .getByLabel("Сообщение помощнику")
      .fill("ЧЕРНОВИК_НЕ_ПОКАЗЫВАТЬ_ДРУГОМУ_АККАУНТУ");
    f.state.responseOwner = "202";
    if (response === "list")
      await page
        .getByRole("button", { name: "Все диалоги", exact: true })
        .click();
    else await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("button", { name: "Создать аккаунт", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("log")).toHaveCount(0);
    await expect(
      page.getByText("ЧЕРНОВИК_НЕ_ПОКАЗЫВАТЬ_ДРУГОМУ_АККАУНТУ"),
    ).toHaveCount(0);
    expect(f.state.messages).toBe(0);
    expect(f.state.paymentPosts).toBe(0);
    expect(f.state.external).toBe(0);
    expect(f.state.unexpected).toEqual([]);
  });
}

test("focus detects a different server owner during an active stream and a late response cannot enter the new account", async ({
  page,
  context,
}) => {
  const f = await install(context);
  await page.goto("/");
  await begin(page, "housing");
  f.state.waitForStream = true;
  try {
    await page
      .getByLabel("Сообщение помощнику")
      .fill("ВОПРОС_ПРЕЖНЕГО_ВЛАДЕЛЬЦА_ВО_ВРЕМЯ_СМЕНЫ_СЕССИИ");
    await page.getByRole("button", { name: "Отправить", exact: true }).click();
    await expect.poll(() => f.state.messages).toBe(1);
    // Simulate a changed HttpOnly session in a separate browser surface without
    // a same-origin logout storage notification. The next dashboard is truth.
    f.state.owner = "202";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("log", { name: "История диалога", exact: true }),
    ).toContainText("НОВЫЙ_ВЛАДЕЛЕЦ");
    f.state.releaseStream();
    await expect(page.getByText("ПОЗДНИЙ_ОТВЕТ_ТОЛЬКО_ДЛЯ_ЖИЛЬЯ")).toHaveCount(
      0,
    );
    await expect(
      page.getByText("ВОПРОС_ПРЕЖНЕГО_ВЛАДЕЛЬЦА_ВО_ВРЕМЯ_СМЕНЫ_СЕССИИ"),
    ).toHaveCount(0);
    await expect(page.getByLabel("Сообщение помощнику")).toHaveValue("");
    expect(
      f.state.reads.filter(
        ({ owner, id }) => owner === "202" && id === ids.housing,
      ),
    ).toEqual([]);
    expect(f.state.messages).toBe(1);
    expect(f.state.paymentPosts).toBe(0);
    expect(f.state.external).toBe(0);
    expect(f.state.unexpected).toEqual([]);
  } finally {
    f.state.releaseStream();
  }
});

test("conversation search filters owned history, resets to all and never sends a model request", async ({
  page,
  context,
}, testInfo) => {
  const f = await install(context);
  f.threads.set("30", {
    id: "30",
    agentKey: "housing",
    assistantKey: "housing",
    closed: true,
    messages: pair("housing", 400, "КВАРТИРА 100%"),
  });
  f.threads.set("31", {
    id: "31",
    agentKey: "job-search",
    assistantKey: "job-search",
    closed: false,
    messages: pair("job-search", 410, "ВАКАНСИЯ"),
  });
  await page.goto("/");
  await allConversations(page);
  await page
    .getByLabel("Найти в переписке", { exact: true })
    .fill("квартира 100%");
  await page
    .getByRole("combobox", { name: "Помощник", exact: true })
    .selectOption("housing");
  await page
    .getByRole("combobox", { name: "Статус", exact: true })
    .selectOption("closed");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(
    page.getByRole("article", {
      name: "Диалог: Помощник по жилью",
      exact: true,
    }),
  ).toContainText("КВАРТИРА 100%");
  await expect(
    page.getByRole("article", {
      name: "Диалог: Помощник по работе",
      exact: true,
    }),
  ).toHaveCount(0);
  const query = new URLSearchParams(f.state.listQueries.at(-1));
  expect(query.get("search")).toBe("квартира 100%");
  expect(query.get("assistantKey")).toBe("housing");
  expect(query.get("status")).toBe("closed");
  await page
    .getByLabel("Найти в переписке", { exact: true })
    .fill("нет совпадения");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(
    page.getByText("По этим условиям разговоров пока нет.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(
    page.getByRole("article", {
      name: "Диалог: Помощник по работе",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Найти в переписке", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "Помощник", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "Статус", exact: true }),
  ).toHaveValue("");
  // Reset also clears local, unapplied edits when server filters are already empty.
  const queriesBeforeEdits = f.state.listQueries.length;
  await page
    .getByLabel("Найти в переписке", { exact: true })
    .fill("неотправленный поиск");
  await page
    .getByRole("combobox", { name: "Помощник", exact: true })
    .selectOption("housing");
  await page
    .getByRole("combobox", { name: "Статус", exact: true })
    .selectOption("closed");
  expect(f.state.listQueries).toHaveLength(queriesBeforeEdits);
  await page.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(
    page.getByLabel("Найти в переписке", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "Помощник", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "Статус", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("article", {
      name: "Диалог: Помощник по работе",
      exact: true,
    }),
  ).toBeVisible();
  expect(f.state.listQueries.at(-1)).toBe("");
  const form = page.locator(".conversation-directory-filters");
  await form.scrollIntoViewIfNeeded();
  const height = (await form.boundingBox())!.height;
  expect(height).toBeLessThan(420);
  for (const control of [
    page.getByRole("searchbox", { name: "Найти в переписке" }),
    page.getByRole("combobox", { name: "Помощник", exact: true }),
    page.getByRole("combobox", { name: "Статус", exact: true }),
  ])
    expect((await control.boundingBox())!.height).toBeLessThan(80);
  await page.screenshot({
    path: testInfo.outputPath("conversation-filters.png"),
  });
  expect(f.state.messages).toBe(0);
  expect(f.state.paymentPosts).toBe(0);
  expect(f.state.external).toBe(0);
  expect(f.state.unexpected).toEqual([]);
});
