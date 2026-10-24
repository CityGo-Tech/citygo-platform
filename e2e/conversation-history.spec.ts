import { expect, test, type Page } from "@playwright/test";
import type { Dashboard, Message } from "@citygo/contracts";

const rows = (first: number, count: number): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    id: String(first + index),
    role: (first + index) % 2 ? "user" : "assistant",
    agentKey: "support",
    status: "complete",
    favorite: false,
    content: `Сохранённое сообщение ${first + index}. Только вымышленные данные проверки истории.`,
  }));
async function install(page: Page, total = 350, legacy = false) {
  const threads = new Map([
    ["20", rows(1, total)],
    ["21", rows(2001, 20)],
    ["30", rows(3001, 20)],
  ]);
  const state = {
    owner: "10",
    closed: false,
    reads: [] as string[],
    details: [] as string[],
    dashboardReads: 0,
    failDashboardOnce: false,
    aiPosts: [] as { text: string; creditReservationMode: string }[],
    paymentPosts: 0,
    external: 0,
    unexpected: [] as string[],
    failNext: false,
    badOwner: false,
    unauthorized: false,
    delay: false,
    release: () => {},
    delivered: Promise.resolve(),
  };
  const gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  let delivered = () => {};
  state.delivered = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const thread = (id: string) => ({
    id,
    agentKey: "support" as const,
    assistantKey: legacy ? null : ("support" as const),
    closed: state.closed,
    messages: threads.get(id)!.slice(-100),
  });
  const dashboard = (): Dashboard => ({
    user: {
      id: state.owner,
      email: `history-${state.owner}@example.test`,
      role: "user",
    },
    profile: legacy
      ? {
          originCity: "Казань",
          targetCity: "Москва",
          monthlyBudget: 50000,
          moveTargetDate: "2099-01-01",
          household: "solo",
          aiConsent: true,
        }
      : null,
    quests: [],
    xp: 0,
    thread: thread(state.owner === "10" ? "20" : "30"),
    provider: "routerai",
    aiAccess: {
      granted: true,
      dailyLimit: 100,
      policy: {
        id: "a".repeat(64),
        version: "synthetic",
        provider: "routerai",
        model: "test/model",
        recipient: "Synthetic only",
        routing: "No provider",
        data: "Fictional only",
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
  // No database, real AI, checkout or provider is reachable from these tests.
  await page.route("https://**", (route) => {
    state.external++;
    return route.abort();
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (path === "/api/v1/dashboard") {
      state.dashboardReads++;
      if (state.failDashboardOnce) {
        state.failDashboardOnce = false;
        return route.fulfill({
          status: 500,
          json: { error: "Synthetic dashboard refresh failed" },
        });
      }
      return route.fulfill({ json: dashboard() });
    }
    const older = path.match(/^\/api\/v1\/conversations\/(\d+)\/messages$/);
    if (older && request.method() === "GET") {
      const before = url.searchParams.get("before");
      state.reads.push(`${older[1]}:${before}`);
      if (state.unauthorized)
        return route.fulfill({
          status: 401,
          json: { error: "Synthetic expired session" },
        });
      if (state.failNext) {
        state.failNext = false;
        return route.fulfill({
          status: 500,
          json: { error: "SYNTHETIC_PRIVATE_DETAIL" },
        });
      }
      const all = threads
          .get(older[1]!)!
          .filter(
            (message) => before === null || BigInt(message.id) < BigInt(before),
          ),
        messages = all.slice(-100);
      const result = {
        userId: state.badOwner ? "99" : state.owner,
        threadId: older[1],
        messages,
        nextCursor: all.length > 100 ? messages[0]!.id : null,
      };
      if (state.delay) await gate;
      try {
        return await route.fulfill({ json: result });
      } catch {
        /* Expected lifetime cancellation. */
      } finally {
        delivered();
      }
      return;
    }
    if (path === "/api/v1/conversations" && request.method() === "GET")
      return route.fulfill({
        json: {
          userId: state.owner,
          conversations: ["21", "20"].map((id) => ({
            id,
            agentKey: "support",
            assistantKey: "support",
            closed: false,
            updatedAt: "2026-10-24T00:00:00Z",
            preview: `Проверочный диалог ${id}`,
          })),
          nextCursor: null,
        },
      });
    const detail = path.match(/^\/api\/v1\/conversations\/(\d+)$/);
    if (detail) {
      state.details.push(detail[1]!);
      return route.fulfill({
        json: { userId: state.owner, thread: thread(detail[1]!) },
      });
    }
    const favorite = path.match(/^\/api\/v1\/messages\/(\d+)\/favorite$/);
    if (favorite) {
      const { saved } = request.postDataJSON();
      const message = [...threads.values()]
        .flat()
        .find((row) => row.id === favorite[1]);
      expect(message).toBeTruthy();
      message!.favorite = saved;
      return route.fulfill({ json: { messageId: favorite[1], saved } });
    }
    const send = path.match(/^\/api\/v1\/threads\/(\d+)\/messages$/);
    if (send && request.method() === "POST") {
      const input = request.postDataJSON();
      state.aiPosts.push(input);
      const all = threads.get(send[1]!)!,
        next = Number(all.at(-1)!.id) + 1;
      all.push(
        { ...rows(next, 1)[0]!, role: "user", content: input.text },
        {
          ...rows(next + 1, 1)[0]!,
          role: "assistant",
          content: "Ответ на последний проверочный вопрос",
        },
      );
      return route.fulfill({
        contentType: "text/event-stream; charset=utf-8",
        body: `data: ${JSON.stringify({ type: "delta", text: "Ответ на последний проверочный вопрос" })}\n\ndata: ${JSON.stringify({ type: "done", messageId: String(next + 1) })}\n\n`,
      });
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
const log = (page: Page) => page.getByRole("log");
const articles = (page: Page) => log(page).locator("[data-history-message]");
const loadButton = (page: Page) =>
  page.getByRole("button", { name: "Загрузить ранние сообщения", exact: true });
async function count(page: Page, expected: number) {
  await expect(articles(page)).toHaveCount(expected);
}
async function prepend(page: Page, expected: number) {
  await log(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  const before = await log(page).evaluate((element) => {
    const row = element.querySelector<HTMLElement>("[data-history-message]")!;
    return {
      id: row.dataset.historyMessage!,
      top:
        row.getBoundingClientRect().top - element.getBoundingClientRect().top,
    };
  });
  await loadButton(page).click();
  await count(page, expected);
  await expect
    .poll(async () =>
      Math.abs(
        (await log(page).evaluate((element, id) => {
          const row = [
            ...element.querySelectorAll<HTMLElement>("[data-history-message]"),
          ].find((item) => item.dataset.historyMessage === id)!;
          return (
            row.getBoundingClientRect().top -
            element.getBoundingClientRect().top
          );
        }, before.id)) - before.top,
      ),
    )
    .toBeLessThan(2);
}

test("three older pages preserve scroll/order, survive refresh, patch old favorites and keep the last question last", async ({
  page,
}, info) => {
  const { state } = await install(page);
  await page.goto("/");
  await count(page, 100);
  expect(state.reads).toEqual([]);
  await prepend(page, 200);
  await prepend(page, 300);
  await prepend(page, 350);
  expect(state.reads).toEqual(["20:251", "20:151", "20:51"]);
  await expect(loadButton(page)).toHaveCount(0);
  expect(
    await articles(page).evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-history-message")),
    ),
  ).toEqual(Array.from({ length: 350 }, (_, i) => String(i + 1)));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(1);
  await count(page, 350);
  state.failDashboardOnce = true;
  const latestFavorite = log(page).locator('[data-history-message="350"]');
  await latestFavorite
    .getByRole("button", { name: "В избранное", exact: true })
    .click();
  await expect(page.locator(".alert[role=alert]")).toContainText(
    "Synthetic dashboard refresh failed",
  );
  await expect(
    latestFavorite.getByRole("button", { name: "В избранном", exact: true }),
  ).toBeVisible();
  const old = log(page).locator('[data-history-message="1"]');
  await old.getByRole("button", { name: "В избранное", exact: true }).click();
  await expect(
    old.getByRole("button", { name: "В избранном", exact: true }),
  ).toBeVisible();
  await count(page, 350);
  await page.screenshot({
    path: info.outputPath("conversation-older-history.png"),
    fullPage: true,
  });
  await page
    .getByLabel("Сообщение помощнику", { exact: true })
    .fill("ПОСЛЕДНИЙ КОНТРОЛЬНЫЙ ВОПРОС");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await count(page, 352);
  await expect(articles(page).nth(350)).toContainText(
    "ПОСЛЕДНИЙ КОНТРОЛЬНЫЙ ВОПРОС",
  );
  await expect(articles(page).last()).toContainText(
    "Ответ на последний проверочный вопрос",
  );
  expect(state.aiPosts).toHaveLength(1);
  expect(state.aiPosts[0]!.creditReservationMode).toBe("fixed5_overdraft");
  expect(state.paymentPosts).toBe(0);
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
  const persisted = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(persisted).not.toContain("Сохранённое сообщение");
  await page.reload();
  await count(page, 100);
  await expect(articles(page).first()).toHaveAttribute(
    "data-history-message",
    "253",
  );
  await loadButton(page).click();
  await count(page, 200);
  expect(state.reads.at(-1)).toBe("20:253");
});

test("closed conversations and exactly100-message histories remain readable without a model request", async ({
  page,
}) => {
  const { state } = await install(page, 100);
  state.closed = true;
  await page.goto("/");
  await count(page, 100);
  await loadButton(page).click();
  await expect(loadButton(page)).toHaveCount(0);
  await count(page, 100);
  expect(state.reads).toEqual(["20:1"]);
  await expect(
    page.getByLabel("Сообщение помощнику", { exact: true }),
  ).toHaveCount(0);
  expect(state.aiPosts).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("legacy journey scrolling also preserves the visible row when older messages are prepended", async ({
  page,
}) => {
  const { state } = await install(page, 250, true);
  await page.goto("/#chat");
  await count(page, 100);
  await prepend(page, 200);
  await prepend(page, 250);
  expect(state.reads).toEqual(["20:151", "20:51"]);
  expect(state.aiPosts).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("errors retry only explicitly and a wrong-owner page never contaminates authorized history", async ({
  page,
}) => {
  const { state } = await install(page);
  state.failNext = true;
  await page.goto("/");
  await count(page, 100);
  await loadButton(page).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Не удалось загрузить ранние сообщения" }),
  ).toBeVisible();
  await count(page, 100);
  expect(state.reads).toHaveLength(1);
  await page
    .getByRole("button", { name: "Повторить загрузку ранних сообщений" })
    .click();
  await count(page, 200);
  state.badOwner = true;
  await loadButton(page).click();
  await expect(
    page.getByRole("button", { name: "Повторить загрузку ранних сообщений" }),
  ).toBeVisible();
  await count(page, 200);
  state.badOwner = false;
  await page
    .getByRole("button", { name: "Повторить загрузку ранних сообщений" })
    .click();
  await count(page, 300);
  expect(state.aiPosts).toEqual([]);
  expect(state.paymentPosts).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("a delayed page cannot leak into a newly selected thread", async ({
  page,
}) => {
  const { state } = await install(page);
  state.delay = true;
  await page.goto("/");
  await count(page, 100);
  await loadButton(page).click();
  await expect.poll(() => state.reads.length).toBe(1);
  await page.getByRole("button", { name: "Все диалоги", exact: true }).click();
  await page
    .getByRole("article")
    .filter({ hasText: "Проверочный диалог 21" })
    .getByRole("button", { name: "Открыть разговор", exact: true })
    .click();
  await count(page, 20);
  state.release();
  await state.delivered;
  await count(page, 20);
  await expect(articles(page).first()).toHaveAttribute(
    "data-history-message",
    "2001",
  );
  expect(state.aiPosts).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("session replacement cancels a delayed page and a current401 returns to login", async ({
  page,
}) => {
  const { state } = await install(page);
  state.delay = true;
  await page.goto("/");
  await count(page, 100);
  await loadButton(page).click();
  await expect.poll(() => state.reads.length).toBe(1);
  state.owner = "11";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await count(page, 20);
  state.release();
  await state.delivered;
  await expect(articles(page).first()).toHaveAttribute(
    "data-history-message",
    "3001",
  );
  state.owner = "10";
  state.delay = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await count(page, 100);
  state.unauthorized = true;
  await loadButton(page).click();
  await expect(
    page.getByRole("heading", { name: "Сохраните свой путь", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("log")).toHaveCount(0);
  expect(state.aiPosts).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("a bounded historical window reaches the beginning and disables sending until latest is restored without losing a draft", async ({
  page,
}) => {
  const { state, threads } = await install(page, 1250);
  await page.goto("/");
  await count(page, 100);
  await page
    .getByLabel("Сообщение помощнику", { exact: true })
    .fill("НЕОТПРАВЛЕННЫЙ ЧЕРНОВИК");
  for (let index = 1; index <= 9; index++) {
    await loadButton(page).click();
    await count(page, (index + 1) * 100);
  }
  await loadButton(page).click();
  await expect(
    page.getByRole("button", { name: "К последним сообщениям", exact: true }),
  ).toBeVisible();
  await count(page, 1000);
  await expect(
    page.getByLabel("Сообщение помощнику", { exact: true }),
  ).toBeDisabled();
  await loadButton(page).click();
  await expect(articles(page).first()).toHaveAttribute(
    "data-history-message",
    "51",
  );
  await loadButton(page).click();
  await expect(articles(page).first()).toHaveAttribute(
    "data-history-message",
    "1",
  );
  await expect(loadButton(page)).toHaveCount(0);
  await count(page, 1000);
  threads.get("20")!.push(...rows(1251, 2));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(1);
  await expect(log(page).locator('[data-history-message="1252"]')).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "К последним сообщениям", exact: true })
    .click();
  await count(page, 100);
  await expect(articles(page).last()).toHaveAttribute(
    "data-history-message",
    "1252",
  );
  await expect(
    page.getByLabel("Сообщение помощнику", { exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByLabel("Сообщение помощнику", { exact: true }),
  ).toHaveValue("НЕОТПРАВЛЕННЫЙ ЧЕРНОВИК");
  expect(state.aiPosts).toEqual([]);
  expect(state.paymentPosts).toBe(0);
  expect(state.unexpected).toEqual([]);
});
