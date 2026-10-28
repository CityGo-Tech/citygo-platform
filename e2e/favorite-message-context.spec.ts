import { expect, test, type Page } from "@playwright/test";
import type { Dashboard, Message } from "@citygo/contracts";
import { syntheticConsentPolicy } from "./service-consent-fixture";

// Every response is local and fictional. No provider, payment, email or SMS call.
async function install(page: Page) {
  const messages: Message[] = Array.from({ length: 350 }, (_, index) => ({
    id: String(index + 1),
    role: index % 2 ? "assistant" : "user",
    agentKey: "housing",
    status: index === 119 ? "interrupted" : "complete",
    content: `Сообщение из исходного диалога ${index + 1}`,
    favorite: index === 119,
  }));
  const state = {
    reads: [] as string[],
    posts: [] as string[],
    unexpected: [] as string[],
    delay: false,
    fail: false,
    badOwner: false,
    badTarget: false,
    release: () => {},
  };
  const gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  const thread = (id: string) => ({
    id,
    agentKey: id === "21" ? ("housing" as const) : ("support" as const),
    assistantKey: id === "21" ? ("housing" as const) : ("support" as const),
    closed: false,
    messages: id === "21" ? messages.slice(-100) : [],
  });
  const dashboard: Dashboard = {
    user: { id: "10", email: "favorites-source@example.test", role: "user" },
    profile: null,
    quests: [],
    xp: 0,
    thread: thread("20"),
    provider: "routerai",
    aiAccess: {
      granted: true,
      dailyLimit: 100,
      policy: {
        id: "a".repeat(64),
        version: "synthetic",
        provider: "routerai",
        model: "synthetic/model",
        recipient: "Synthetic",
        routing: "No provider",
        data: "Fictional only",
      },
    },
  };
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (req.method() !== "GET") state.posts.push(path);
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/dashboard") return route.fulfill({ json: dashboard });
    if (path === "/api/v1/account/profile")
      return route.fulfill({
        json: {
          userId: "10",
          email: "favorites-source@example.test",
          emailVerified: true,
          phoneVerified: false,
          giftStatus: "unavailable",
          emailConfirmation: "unavailable",
        },
      });
    if (path === "/api/v1/messages/favorites")
      return route.fulfill({
        json: {
          userId: "10",
          messages: [{ ...messages[119], threadId: "21" }],
          nextBefore: null,
        },
      });
    if (path === "/api/v1/conversations/21/messages/120/context") {
      state.reads.push(path);
      if (state.delay) await gate;
      try {
        return await route.fulfill(
          state.fail
            ? { status: 404, json: { error: "PRIVATE_DETAILS" } }
            : {
                json: {
                  userId: state.badOwner ? "99" : "10",
                  threadId: "21",
                  messages: messages.slice(
                    state.badTarget ? 21 : 20,
                    state.badTarget ? 121 : 120,
                  ),
                  nextCursor: state.badTarget ? "22" : "21",
                },
              },
        );
      } catch {
        /* Expected when the owner/session has already changed. */
      }
      return;
    }
    if (path === "/api/v1/conversations/21/messages") {
      state.reads.push(url.pathname + url.search);
      const before = url.searchParams.get("before");
      const all = before
        ? messages.filter((row) => BigInt(row.id) < BigInt(before))
        : messages;
      const rows = all.slice(-100);
      return route.fulfill({
        json: {
          userId: "10",
          threadId: "21",
          messages: rows,
          nextCursor: all.length > 100 ? rows[0]!.id : null,
        },
      });
    }
    const detail = path.match(/^\/api\/v1\/conversations\/(20|21)$/);
    if (detail)
      return route.fulfill({
        json: { userId: "10", thread: thread(detail[1]!) },
      });
    if (path === "/api/v1/auth/logout")
      return route.fulfill({ json: { ok: true } });
    state.unexpected.push(req.method() + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  return state;
}
const favorites = (page: Page) =>
  page.getByRole("region", { name: "Избранные сообщения", exact: true });
const source = (page: Page) =>
  page.getByRole("region", { name: "Исходный диалог", exact: true });
async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Избранное", exact: true }).click();
  await favorites(page)
    .getByRole("button", { name: "Открыть в диалоге", exact: true })
    .click();
}

test("old saved reply opens at its exact source, older history and return keep the draft and incur no requests", async ({
  page,
}, info) => {
  const state = await install(page);
  await page.goto("/");
  await page
    .getByLabel("Сообщение помощнику")
    .fill("Мой несохранённый вопрос координатору");
  await page.getByRole("button", { name: "Избранное", exact: true }).click();
  await favorites(page)
    .getByRole("button", { name: "Открыть в диалоге", exact: true })
    .click();
  await expect(source(page)).toContainText(
    "Сообщение из исходного диалога 120",
  );
  await expect(source(page)).toContainText("Ответ прерван");
  await expect(
    source(page).locator('[data-source-message="120"]'),
  ).toBeVisible();
  const sourceLabelAndAuthorDoNotOverlap = await source(page)
    .locator('[data-source-message="120"]')
    .evaluate((element) => {
      const label = element.querySelector("small")!.getBoundingClientRect();
      const author = element.querySelector("strong")!.getBoundingClientRect();
      return label.bottom <= author.top + 1;
    });
  expect(sourceLabelAndAuthorDoNotOverlap).toBe(true);
  await source(page).screenshot({
    path: info.outputPath("favorite-source.png"),
  });
  await source(page)
    .getByRole("button", { name: "Загрузить ранние сообщения", exact: true })
    .click();
  await expect(source(page)).toContainText("Сообщение из исходного диалога 1");
  await source(page)
    .getByRole("button", { name: "← В избранное", exact: true })
    .click();
  await expect(favorites(page)).toContainText(
    "Сообщение из исходного диалога 120",
  );
  await favorites(page)
    .getByRole("button", { name: "← В приложение", exact: true })
    .click();
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(
    "Мой несохранённый вопрос координатору",
  );
  expect(state.reads).toEqual([
    "/api/v1/conversations/21/messages/120/context",
    "/api/v1/conversations/21/messages?before=21",
  ]);
  expect(state.posts).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("source can open the full original thread from Profile without sending a message", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  await page
    .getByRole("button", { name: "Избранное", exact: true })
    .first()
    .click();
  await favorites(page)
    .getByRole("button", { name: "Открыть в диалоге", exact: true })
    .click();
  await expect(source(page)).toContainText(
    "Сообщение из исходного диалога 120",
  );
  await source(page)
    .getByRole("button", { name: "Открыть весь диалог", exact: true })
    .click();
  await expect(source(page)).toHaveCount(0);
  await expect(page.getByRole("log")).toContainText(
    "Сообщение из исходного диалога 350",
  );
  await expect(page.getByLabel("Сообщение помощнику")).toBeVisible();
  expect(state.posts).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("late source data cannot reappear after logout", async ({ page }) => {
  const state = await install(page);
  state.delay = true;
  await open(page);
  await expect.poll(() => state.reads.length).toBe(1);
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  state.release();
  await expect(source(page)).toHaveCount(0);
  await expect(
    page.getByText("Сообщение из исходного диалога 120"),
  ).toHaveCount(0);
  expect(state.posts).toEqual(["/api/v1/auth/logout"]);
});

for (const fault of ["fail", "badOwner", "badTarget"] as const) {
  test(`source rejects ${fault} without leaking private response details`, async ({
    page,
  }) => {
    const state = await install(page);
    state[fault] = true;
    await open(page);
    await expect(source(page).getByRole("alert")).toBeVisible();
    await expect(source(page).locator("[data-source-message]")).toHaveCount(0);
    await expect(page.getByText("PRIVATE_DETAILS")).toHaveCount(0);
    expect(state.reads).toHaveLength(1);
    expect(state.posts).toEqual([]);
  });
}
