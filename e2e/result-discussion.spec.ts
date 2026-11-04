import { openResults as openResultsView } from "./navigation-helper";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type {
  Dashboard,
  FavoriteMessage,
  PersonalPlanItem,
} from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";

const stamp = "2026-10-28T10:00:00Z";
function steps(count = 3): PersonalPlanItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(9007199254741100n - BigInt(index)),
    title:
      [
        "Подготовить список районов",
        "Сравнить дорогу до работы",
        "Уточнить бюджет на переезд",
      ][index % 3]! + (index > 2 ? " " + index : ""),
    details:
      "Мой сохранённый текст шага: сравнить дорогу, стоимость жилья и ежедневные расходы.",
    status: index % 2 ? "completed" : "pending",
    revision: 1,
    source: { messageId: "11", threadId: "10", role: "assistant" },
    createdAt: stamp,
    updatedAt: stamp,
  }));
}
function messages(count = 3): FavoriteMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(9007199254741300n - BigInt(index)),
    threadId: "10",
    role: index % 2 ? "user" : "assistant",
    agentKey: "support",
    status: index === 0 ? "interrupted" : "complete",
    content:
      "Сохранённое сообщение " +
      index +
      "\nПроверить районы и время в дороге. Точный текст из моего разговора.",
  }));
}
const results = (page: Page) =>
  page.getByRole("region", { name: "Полезное из разговоров", exact: true });
async function openResults(page: Page) {
  await openResultsView(page);
  await expect(results(page).getByRole("heading", { level: 1 })).toHaveText(
    "Полезное из разговоров",
  );
}

/** Fictional local responses only; every non-GET request and external call is counted. */
async function fixture(
  context: BrowserContext,
  plan = steps(),
  favorites = messages(),
) {
  const pageGates = new Map<string, Promise<void>>();
  const state = {
    owner: "101",
    authenticated: true,
    responseOwner: null as string | null,
    plan,
    favorites,
    reads: [] as string[],
    pageReplies: [] as string[],
    holdPage(path: string) {
      let release!: () => void;
      pageGates.set(
        path,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        pageGates.delete(path);
        release();
      };
    },
    writes: [] as string[],
    unexpected: [] as string[],
    external: 0,
    sourceMissing: false,
    discussionRevision: 1,
    discussionText: "ТОЧНЫЙ_РЕЗУЛЬТАТ 🧳",
    discussionOwner: "101",
    discussionMissing: false,
    discussionDenied: false,
    discussionReads: 0,
    failStart: false,
    failFavorites: false,
    holdPlan: false,
    releasePlan: () => {},
  };
  const gate = new Promise<void>((resolve) => {
    state.releasePlan = resolve;
  });
  const thread = () => ({
    id: "10",
    agentKey: "support" as const,
    assistantKey: "support" as const,
    closed: false,
    messages: [
      {
        id: "12",
        role: "user" as const,
        agentKey: "support" as const,
        status: "complete" as const,
        content:
          state.owner === "101"
            ? "Последний вопрос"
            : "ВОПРОС_НОВОГО_ВЛАДЕЛЬЦА",
      },
    ],
  });
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: "results-" + state.owner + "@example.test",
      role: "user",
    },
    profile: null,
    quests: [],
    xp: 0,
    thread: thread(),
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
  });
  await context.route("https://**", (route) => {
    state.external++;
    return route.abort();
  });
  await context.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (request.method() !== "GET") state.writes.push(path);
    if (path === "/api/v1/auth/registration-policy")
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
    if (path === "/api/v1/account/profile")
      return route.fulfill({
        json: {
          userId: state.owner,
          email: board().user.email,
          emailVerified: true,
          phoneVerified: false,
          giftStatus: "available",
          emailConfirmation: "available",
        },
      });
    if (path === "/api/v1/personal-plan/summary") {
      const rows = state.owner === "101" ? state.plan : [];
      return route.fulfill({
        json: {
          userId: state.responseOwner ?? state.owner,
          total: rows.length,
          pending: rows.filter((item) => item.status === "pending").length,
          completed: rows.filter((item) => item.status === "completed").length,
        },
      });
    }
    if (path === "/api/v1/personal-plan") {
      state.reads.push(path + url.search);
      const owner = state.owner,
        before = url.searchParams.get("before");
      const rows =
        owner === "101"
          ? state.plan.filter(
              (item) =>
                (!before || BigInt(item.id) < BigInt(before)) &&
                (!url.searchParams.get("search") ||
                  (item.title + "\n" + item.details)
                    .toLocaleLowerCase()
                    .includes(
                      url.searchParams.get("search")!.toLocaleLowerCase(),
                    )) &&
                (!url.searchParams.get("status") ||
                  item.status === url.searchParams.get("status")),
            )
          : [];
      const json = {
        userId: state.responseOwner ?? owner,
        items: rows.slice(0, 20),
        nextBefore: rows.length > 20 ? rows[19]!.id : null,
      };
      if (state.holdPlan) await gate;
      await pageGates.get(path + url.search);
      try {
        return await route.fulfill({ json });
      } catch {
        return;
      } finally {
        state.pageReplies.push(path + url.search);
      }
    }
    if (path === "/api/v1/messages/favorites") {
      state.reads.push(path + url.search);
      if (state.failFavorites)
        return route.fulfill({
          status: 503,
          json: { error: "PRIVATE_DETAILS" },
        });
      const before = url.searchParams.get("before");
      const rows =
        state.owner === "101"
          ? state.favorites.filter(
              (item) =>
                (!before || BigInt(item.id) < BigInt(before)) &&
                (!url.searchParams.get("search") ||
                  item.content
                    .toLocaleLowerCase()
                    .includes(
                      url.searchParams.get("search")!.toLocaleLowerCase(),
                    )) &&
                (!url.searchParams.get("role") ||
                  item.role === url.searchParams.get("role")) &&
                (!url.searchParams.get("assistantKey") ||
                  item.agentKey === url.searchParams.get("assistantKey")),
            )
          : [];
      await pageGates.get(path + url.search);
      try {
        return await route.fulfill({
          json: {
            userId: state.responseOwner ?? state.owner,
            messages: rows.slice(0, 20),
            nextBefore: rows.length > 20 ? rows[19]!.id : null,
          },
        });
      } catch {
        return;
      } finally {
        state.pageReplies.push(path + url.search);
      }
    }
    if (
      /^\/api\/v1\/results\/(plan|favorites)\/\d+\/discussion-source$/.test(
        path,
      )
    ) {
      state.discussionReads++;
      if (state.discussionDenied)
        return route.fulfill({ status: 401, json: { error: "PRIVATE" } });
      if (state.discussionMissing)
        return route.fulfill({ status: 404, json: { error: "PRIVATE" } });
      const bits = path.split("/");
      return route.fulfill({
        json: {
          userId: state.discussionOwner,
          kind: bits[4],
          id: bits[5],
          revision: bits[4] === "plan" ? state.discussionRevision : null,
          title: "Результат",
          text: state.discussionText,
          assistantKey: "support",
          interrupted: false,
        },
      });
    }
    if (path === "/api/v1/conversations")
      return route.fulfill({
        json: {
          userId: state.owner,
          conversations: [
            {
              id: "10",
              agentKey: "support",
              assistantKey: "support",
              closed: false,
              updatedAt: stamp,
              preview: "Последний вопрос",
            },
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/v1/conversations/start") {
      if (state.failStart)
        return route.fulfill({ status: 503, json: { error: "PRIVATE" } });
      return route.fulfill({
        json: {
          id: "10",
          agentKey: "support",
          assistantKey: "support",
          closed: false,
        },
      });
    }
    const match = path.match(
      /^\/api\/v1\/conversations\/10\/messages\/(\d+)\/context$/,
    );
    if (match) {
      state.reads.push(path);
      if (state.sourceMissing)
        return route.fulfill({
          status: 404,
          json: { error: "PRIVATE_DETAILS" },
        });
      const favorite = state.favorites.find((item) => item.id === match[1]);
      return route.fulfill({
        json: {
          userId: state.owner,
          threadId: "10",
          messages: [
            favorite
              ? {
                  id: favorite.id,
                  role: favorite.role,
                  content: favorite.content,
                  agentKey: favorite.agentKey,
                  status: favorite.status,
                  favorite: true,
                }
              : {
                  id: match[1],
                  role: "assistant",
                  agentKey: "support",
                  status: "complete",
                  content: "ТОЧНЫЙ_СТАРЫЙ_ИСТОЧНИК_ШАГА",
                },
          ],
          nextCursor: null,
        },
      });
    }
    if (path === "/api/v1/conversations/10")
      return route.fulfill({ json: { userId: state.owner, thread: thread() } });
    state.unexpected.push(request.method() + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected local request" },
    });
  });
  return state;
}

const discussion = (page: Page) =>
  page.getByRole("dialog", { name: "Обсудить с помощником" });
async function startDiscussion(page: Page) {
  await openResults(page);
  await results(page)
    .getByRole("article")
    .first()
    .getByRole("button", { name: "Обсудить", exact: true })
    .click();
  await expect(
    discussion(page).getByLabel("Текст для обсуждения"),
  ).toContainText("ТОЧНЫЙ_РЕЗУЛЬТАТ");
}
test("discussion previews fresh private result and cancel preserves the original draft without a send", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  await page.goto("/");
  await page
    .getByLabel("Сообщение помощнику", { exact: true })
    .fill("ПРЕЖНИЙ_ЧЕРНОВИК");
  await startDiscussion(page);
  await expect(discussion(page).locator(".ym-hide-content")).not.toHaveCount(0);
  const geometry = await discussion(page).evaluate((e) => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    radius: getComputedStyle(e).borderRadius,
    width: e.getBoundingClientRect().width,
  }));
  expect(geometry.overflow).toBe(false);
  expect(geometry.radius).toBe("24px");
  expect(geometry.width).toBeLessThanOrEqual(
    info.project.name === "desktop" ? 816 : 390,
  );
  await page.screenshot({
    path: test.info().outputPath("result-discussion.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(discussion(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Диалоги", exact: true }).click();
  await page
    .getByRole("button", { name: "Открыть разговор", exact: true })
    .click();
  await expect(
    page.getByLabel("Сообщение помощнику", { exact: true }),
  ).toHaveValue("ПРЕЖНИЙ_ЧЕРНОВИК");
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});
test("discussion appends reviewed result once to the selected assistant draft and never sends AI", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  await page
    .getByLabel("Сообщение помощнику", { exact: true })
    .fill("ПРЕЖНИЙ_ЧЕРНОВИК");
  await startDiscussion(page);
  await discussion(page)
    .getByLabel("Текст для обсуждения")
    .fill("ПРОВЕРЕННЫЙ_ФРАГМЕНТ");
  await discussion(page)
    .getByRole("button", { name: "Добавить в черновик" })
    .dblclick();
  await expect(discussion(page)).toHaveCount(0);
  await expect(
    page.getByLabel("Сообщение помощнику", { exact: true }),
  ).toHaveValue("ПРЕЖНИЙ_ЧЕРНОВИК\n\nПРОВЕРЕННЫЙ_ФРАГМЕНТ");
  expect(state.discussionReads).toBe(2);
  expect(state.writes).toEqual(["/api/v1/conversations/start"]);
  expect(state.unexpected).toEqual([]);
});
test("discussion detects concurrent source edit, keeps reviewed fragment and blocks removed source", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  await startDiscussion(page);
  await discussion(page).getByLabel("Текст для обсуждения").fill("МОЯ_ПРАВКА");
  state.discussionText = "ОБНОВЛЁННЫЙ_ИСТОЧНИК";
  state.discussionRevision = 2;
  await discussion(page)
    .getByRole("button", { name: "Добавить в черновик" })
    .click();
  await expect(discussion(page).getByRole("alert")).toContainText(
    "Результат изменился",
  );
  await expect(discussion(page).getByLabel("Текст для обсуждения")).toHaveValue(
    "МОЯ_ПРАВКА",
  );
  await expect(
    discussion(page).getByRole("region", { name: "Исходный текст результата" }),
  ).toHaveText("ОБНОВЛЁННЫЙ_ИСТОЧНИК");
  expect(state.writes).toEqual([]);
  state.discussionMissing = true;
  await discussion(page)
    .getByRole("button", { name: "Добавить в черновик" })
    .click();
  await expect(discussion(page).getByRole("alert")).toContainText(
    "больше недоступен",
  );
  await expect(
    discussion(page).getByRole("region", { name: "Исходный текст результата" }),
  ).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
test("long result remains complete and requires a selected fragment instead of silent truncation", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.discussionText = "ТОЧНЫЙ_РЕЗУЛЬТАТ" + "x".repeat(100_100) + "КОНЕЦ";
  await page.goto("/");
  await openResults(page);
  await results(page)
    .getByRole("article")
    .first()
    .getByRole("button", { name: "Обсудить", exact: true })
    .click();
  await expect(
    discussion(page).getByRole("region", { name: "Исходный текст результата" }),
  ).toHaveText(state.discussionText);
  await expect(discussion(page).getByLabel("Текст для обсуждения")).toHaveValue(
    "",
  );
  await expect(
    discussion(page).getByRole("button", { name: "Добавить в черновик" }),
  ).toBeDisabled();
  expect(state.writes).toEqual([]);
});
test("discussion refuses foreign owner and clears private preview on active access denial", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  await startDiscussion(page);
  state.discussionDenied = true;
  await discussion(page)
    .getByRole("button", { name: "Добавить в черновик" })
    .click();
  await expect(discussion(page)).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Исходный текст результата" }),
  ).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
