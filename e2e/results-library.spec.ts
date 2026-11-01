import { openResults as openResultsView } from "./navigation-helper";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
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
const source = (page: Page) =>
  page.getByRole("region", { name: "Исходный диалог", exact: true });
const categories = (page: Page) =>
  results(page).getByRole("navigation", { name: "Категории результатов" });
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

test("results match the three-column shell and expose only actual saved plan steps", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  if (info.project.name === "desktop")
    await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await openResults(page);
  await expect(results(page).getByRole("article")).toHaveCount(3);
  await expect(results(page)).toContainText("Выполнено 1 из 3");
  await expect(results(page)).not.toContainText("Первый маршрут переезда");
  await expect(results(page)).not.toContainText("Bubble");
  await expect(results(page).locator("article.ym-hide-content")).toHaveCount(3);
  const geometry = await results(page).evaluate((element) => {
    const card = element.querySelector("article")!,
      title = element.querySelector("h1")!;
    const rect = card.getBoundingClientRect();
    return {
      radius: getComputedStyle(card).borderRadius,
      padding: getComputedStyle(card).padding,
      titleFont: getComputedStyle(title).fontFamily,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      width: rect.width,
    };
  });
  expect(geometry.radius).toBe("24px");
  expect(geometry.padding).toBe("24px");
  expect(geometry.titleFont).toContain("Manrope");
  expect(geometry.overflow).toBe(false);
  expect(geometry.width).toBeGreaterThan(200);
  if (info.project.name === "desktop") {
    const portraits = await page
      .locator(
        ".conversation-home .conversation-topics img, .conversation-home .conversation-context img",
      )
      .evaluateAll((images) =>
        images.map((element) => ({
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          loaded:
            (element as HTMLImageElement).complete &&
            (element as HTMLImageElement).naturalWidth > 0,
          path: (element as HTMLImageElement).getAttribute("src"),
        })),
      );
    expect(
      portraits.map(({ width, height, loaded }) => ({ width, height, loaded })),
    ).toEqual([
      { width: 64, height: 64, loaded: true },
      { width: 240, height: 240, loaded: true },
    ]);
    expect(
      portraits.every((portrait) =>
        portrait.path?.includes("support-assistant.png"),
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: info.outputPath("results-library.png"),
    fullPage: true,
  });
  await results(page)
    .getByRole("button", { name: "Открыть мой план", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Мой план переезда", exact: true }),
  ).toContainText(state.plan[0]!.title);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("each category pages beyond twenty, opens the exact source and returns to its loaded list and focus", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context, steps(45), messages(29));
  await page.goto("/");
  await page.getByLabel("Сообщение помощнику").fill("Несохранённый вопрос");
  await openResults(page);
  await expect(results(page).getByRole("article")).toHaveCount(20);
  await results(page)
    .getByRole("button", { name: "Показать ещё", exact: true })
    .click();
  await expect(results(page).getByRole("article")).toHaveCount(40);
  await categories(page)
    .getByRole("button", { name: "Избранные сообщения", exact: true })
    .click();
  await expect(results(page).getByRole("article")).toHaveCount(20);
  await results(page)
    .getByRole("button", { name: "Показать ещё", exact: true })
    .click();
  await expect(results(page).getByRole("article")).toHaveCount(29);
  const last = results(page).getByRole("article").last();
  const button = last.getByRole("button", {
    name: "Открыть источник",
    exact: true,
  });
  await button.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  await button.click();
  await expect(
    source(page).locator('[data-source-message="9007199254741272"]'),
  ).toBeFocused();
  await expect(source(page)).toContainText(state.favorites[28]!.content);
  await source(page).screenshot({
    path: info.outputPath("results-source.png"),
  });
  await source(page)
    .getByRole("button", { name: "← В результаты", exact: true })
    .click();
  await expect(
    categories(page).getByRole("button", {
      name: "Избранные сообщения",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(results(page).getByRole("article")).toHaveCount(29);
  await expect(button).toBeFocused();
  expect(
    Math.abs((await page.evaluate(() => window.scrollY)) - scroll),
  ).toBeLessThan(5);
  await categories(page)
    .getByRole("button", { name: /^Шаги плана/ })
    .click();
  await expect(results(page).getByRole("article")).toHaveCount(40);
  await results(page)
    .getByRole("button", { name: "Открыть источник", exact: true })
    .first()
    .click();
  await expect(source(page)).toContainText("ТОЧНЫЙ_СТАРЫЙ_ИСТОЧНИК_ШАГА");
  await expect(source(page)).not.toContainText("Мой сохранённый текст шага");
  await source(page)
    .getByRole("button", { name: "← В результаты", exact: true })
    .click();
  await results(page)
    .getByRole("button", { name: "Открыть диалоги", exact: true })
    .click();
  await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(
    "Несохранённый вопрос",
  );
  expect(state.reads.filter((path) => path.includes("?before="))).toEqual([
    "/api/v1/personal-plan?before=9007199254741081",
    "/api/v1/messages/favorites?before=9007199254741281",
  ]);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("cancelled pagination keeps forty saved results in both categories and retries only the retained cursor", async ({
  page,
  context,
}) => {
  const state = await fixture(context, steps(45), messages(45));
  await page.goto("/");
  await openResults(page);
  for (const category of ["plan", "favorites"] as const) {
    const current = categories(page).getByRole("button", {
      name: category === "plan" ? /^Шаги плана/ : "Избранные сообщения",
    });
    const other = categories(page).getByRole("button", {
      name: category === "plan" ? "Избранные сообщения" : /^Шаги плана/,
    });
    await current.click();
    await expect(results(page).getByRole("article")).toHaveCount(20);
    await results(page)
      .getByRole("button", { name: "Показать ещё", exact: true })
      .click();
    await expect(results(page).getByRole("article")).toHaveCount(40);
    const path =
      category === "plan"
        ? "/api/v1/personal-plan"
        : "/api/v1/messages/favorites";
    const rows = category === "plan" ? state.plan : state.favorites;
    const pendingPath = path + "?before=" + rows[39]!.id;
    const release = state.holdPage(pendingPath);
    try {
      await results(page)
        .getByRole("button", { name: "Показать ещё", exact: true })
        .click();
      await expect
        .poll(() => state.reads.filter((read) => read === pendingPath).length)
        .toBe(1);
      await expect(results(page)).toHaveAttribute("aria-busy", "true");
      await other.click();
      await expect(results(page)).toHaveAttribute("aria-busy", "false");
      const readsBeforeReturn = state.reads.length;
      await current.click();
      await expect(results(page).getByRole("article")).toHaveCount(40);
      await expect(results(page)).toHaveAttribute("aria-busy", "false");
      expect(state.reads.length).toBe(readsBeforeReturn);
      release();
      await expect
        .poll(
          () => state.pageReplies.filter((read) => read === pendingPath).length,
        )
        .toBe(1);
      await expect(results(page).getByRole("article")).toHaveCount(40);
      await results(page)
        .getByRole("button", { name: "Показать ещё", exact: true })
        .click();
      await expect(results(page).getByRole("article")).toHaveCount(45);
      expect(state.reads.filter((read) => read === pendingPath)).toHaveLength(
        2,
      );
      expect(state.reads.filter((read) => read === path)).toHaveLength(1);
    } finally {
      release();
    }
  }
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});
test("a one-megabyte message has a bounded plain-text preview, exact source and an explicit exact local download", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const saved = messages(1);
  const prefix =
    '<img src="https://invalid.example/tracker" onerror="window.XSS=true">\n';
  const tail = "КОНЕЦ_ТОЧНОГО_ТЕКСТА";
  saved[0]!.content =
    prefix +
    "Точный сохранённый текст строки.\n"
      .repeat(40000)
      .slice(0, 1024 * 1024 - prefix.length - tail.length) +
    tail;
  const state = await fixture(context, [], saved);
  await page.goto("/");
  await openResults(page);
  await categories(page)
    .getByRole("button", { name: "Избранные сообщения", exact: true })
    .click();
  const article = results(page).getByRole("article");
  await expect(article).toContainText("Ответ прерван");
  expect((await article.innerText()).length).toBeLessThan(700);
  expect(await page.evaluate(() => "XSS" in window)).toBe(false);
  expect(await article.locator("img").count()).toBe(0);
  const downloadPromise = page.waitForEvent("download");
  await article
    .getByRole("button", { name: "Скачать .txt", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "citygo-message-9007199254741300.txt",
  );
  expect(await readFile((await download.path())!, "utf8")).toBe(
    saved[0]!.content,
  );
  await article
    .getByRole("button", { name: "Открыть источник", exact: true })
    .click();
  await expect(source(page).locator("[data-source-message]")).toContainText(
    "КОНЕЦ_ТОЧНОГО_ТЕКСТА",
  );
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("empty categories, retry and separate favorites management use the existing data only", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [], []);
  await page.goto("/");
  await openResults(page);
  await expect(results(page)).toContainText("Сохраните первый шаг");
  state.failFavorites = true;
  await categories(page)
    .getByRole("button", { name: "Избранные сообщения", exact: true })
    .click();
  await expect(results(page).getByRole("alert")).toContainText(
    "Попробуйте ещё раз",
  );
  await expect(page.getByText("PRIVATE_DETAILS")).toHaveCount(0);
  state.failFavorites = false;
  await results(page)
    .getByRole("button", { name: "Повторить загрузку", exact: true })
    .click();
  await expect(results(page)).toContainText("Сохраните важное сообщение");
  await results(page)
    .getByRole("button", { name: "Управлять избранным", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Избранные сообщения", exact: true }),
  ).toContainText("Пока здесь пусто");
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("an unavailable source returns to the selected category without substituting the latest conversation", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.sourceMissing = true;
  await page.goto("/");
  await openResults(page);
  await results(page)
    .getByRole("button", { name: "Открыть источник", exact: true })
    .first()
    .click();
  await expect(source(page).getByRole("alert")).toContainText(
    "Вернитесь к результатам",
  );
  await expect(source(page).locator("[data-source-message]")).toHaveCount(0);
  await source(page)
    .getByRole("button", { name: "← В результаты", exact: true })
    .click();
  await expect(results(page).getByRole("article")).toHaveCount(3);
  expect(state.reads.filter((path) => path.includes("/context"))).toEqual([
    "/api/v1/conversations/10/messages/11/context",
  ]);
  expect(state.writes).toEqual([]);
});

test("a foreign owner response never renders saved titles", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [
    { ...steps(1)[0]!, title: "FOREIGN_PRIVATE_RESULT" },
  ]);
  state.responseOwner = "202";
  await page.goto("/");
  // This receipt must close the session before a successful results heading can appear.
  await openResultsView(page);
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("FOREIGN_PRIVATE_RESULT")).toHaveCount(0);
  await expect(results(page)).toHaveCount(0);
  await expect(page.locator(".notice[role=status]")).toHaveText(
    "Сессия завершилась. Войдите снова.",
  );
  await expect(
    page.getByRole("navigation", {
      name: "Личный кабинет CityGo",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Сообщение помощнику", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Войти", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("switching category aborts a late read and never mixes it with favorites", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [
    { ...steps(1)[0]!, title: "LATE_PLAN_TITLE" },
  ]);
  state.holdPlan = true;
  try {
    await page.goto("/");
    await openResults(page);
    await expect.poll(() => state.reads.length).toBe(1);
    await categories(page)
      .getByRole("button", { name: "Избранные сообщения", exact: true })
      .click();
    await expect(results(page).getByRole("article")).toHaveCount(3);
    state.releasePlan();
    await expect(results(page)).not.toContainText("LATE_PLAN_TITLE");
    await expect(
      categories(page).getByRole("button", {
        name: "Избранные сообщения",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(state.writes).toEqual([]);
  } finally {
    state.releasePlan();
  }
});

test("a late previous-owner page cannot reappear after focus changes the account", async ({
  page,
  context,
}) => {
  const state = await fixture(context, [
    { ...steps(1)[0]!, title: "LATE_PRIVATE_OWNER_A" },
  ]);
  state.holdPlan = true;
  try {
    await page.goto("/");
    await openResults(page);
    await expect.poll(() => state.reads.length).toBe(1);
    state.owner = "202";
    state.holdPlan = false;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("log")).toContainText(
      "ВОПРОС_НОВОГО_ВЛАДЕЛЬЦА",
    );
    await openResults(page);
    await expect(results(page)).toContainText("Сохраните первый шаг");
    state.releasePlan();
    await expect(page.getByText("LATE_PRIVATE_OWNER_A")).toHaveCount(0);
  } finally {
    state.releasePlan();
  }
});

test("results search finds older server pages, preserves category filters and resets without writes", async ({
  page,
  context,
}, info) => {
  const plan = steps(45),
    saved = messages(29);
  plan[44]!.title = "Район %_\\ — дальний шаг";
  plan[44]!.status = "completed";
  saved[28]!.content = "КОНТРОЛЬ_РЕЗУЛЬТАТА %_\\";
  const state = await fixture(context, plan, saved);
  await page.goto("/");
  await openResults(page);
  const form = results(page).getByRole("form", { name: "Поиск результатов" });
  await form.getByLabel("Поиск в результатах").fill("Район %_\\");
  await form.getByLabel("Статус шага").selectOption("completed");
  await form.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(results(page).getByRole("article")).toHaveCount(1);
  await expect(results(page).getByRole("article")).toContainText(
    plan[44]!.title,
  );
  await results(page).screenshot({
    path: info.outputPath("results-search-filtered.png"),
  });
  const query = new URL("http://local" + state.reads.at(-1)!);
  expect(query.searchParams.get("search")).toBe("Район %_\\");
  expect(query.searchParams.get("status")).toBe("completed");
  expect(query.searchParams.has("before")).toBe(false);
  await categories(page)
    .getByRole("button", { name: "Избранные сообщения", exact: true })
    .click();
  await form.getByLabel("Поиск в результатах").fill("КОНТРОЛЬ_РЕЗУЛЬТАТА %_\\");
  await form.getByLabel("Автор сообщения").selectOption("assistant");
  await form.getByLabel("Помощник", { exact: true }).selectOption("support");
  await form.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(results(page).getByRole("article")).toHaveCount(1);
  await expect(results(page)).toContainText(saved[28]!.content);
  await categories(page)
    .getByRole("button", { name: /^Шаги плана/ })
    .click();
  await expect(form.getByLabel("Поиск в результатах")).toHaveValue(
    "Район %_\\",
  );
  await expect(form.getByLabel("Статус шага")).toHaveValue("completed");
  await expect(results(page).getByRole("article")).toHaveCount(1);
  await form.getByLabel("Поиск в результатах").fill("НЕСУЩЕСТВУЮЩИЙ_ШАГ");
  await form.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(results(page)).toContainText("Ничего не найдено");
  await form
    .getByRole("button", { name: "Сбросить фильтры", exact: true })
    .click();
  await expect(results(page).getByRole("article")).toHaveCount(20);
  expect(new URL("http://local" + state.reads.at(-1)!).search).toBe("");
  expect(
    await form.evaluate((element) =>
      element.classList.contains("ym-hide-content"),
    ),
  ).toBe(true);
  await expect(form.getByLabel("Поиск в результатах")).toHaveClass(
    /ym-disable-keys/,
  );
  expect(await page.evaluate(() => location.search)).toBe("");
  const storage = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  expect(storage).not.toContain("КОНТРОЛЬ_РЕЗУЛЬТАТА");
  expect(storage).not.toContain("НЕСУЩЕСТВУЮЩИЙ_ШАГ");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: info.outputPath("results-search.png"),
    fullPage: false,
  });
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("full result preview renders exact manual steps and long favorites safely, then restores list focus", async ({
  page,
  context,
}, info) => {
  const plan = [
    {
      ...steps(1)[0]!,
      source: null,
      details: "ПОЛНЫЙ_РУЧНОЙ_ШАГ\n" + "Подробности. ".repeat(280),
    },
  ];
  const saved = messages(1);
  saved[0]!.content =
    "<img src=x onerror=window.XSS=true>\n" +
    "я".repeat(16000) +
    "\nКОНЕЦ_ПОЛНОГО_РЕЗУЛЬТАТА";
  const state = await fixture(context, plan, saved);
  await page.goto("/");
  await openResults(page);
  let open = results(page).getByRole("button", {
    name: "Открыть полностью",
    exact: true,
  });
  await open.click();
  const full = page.getByRole("region", {
    name: "Полный результат",
    exact: true,
  });
  await expect(full.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(
    full.getByRole("region", { name: "Полный текст результата", exact: true }),
  ).toHaveText(plan[0]!.details);
  await full
    .getByRole("button", { name: "← В результаты", exact: true })
    .click();
  await expect(open).toBeFocused();
  await categories(page)
    .getByRole("button", { name: "Избранные сообщения", exact: true })
    .click();
  open = results(page).getByRole("button", {
    name: "Открыть полностью",
    exact: true,
  });
  await open.click();
  await expect(
    full.getByRole("region", { name: "Полный текст результата", exact: true }),
  ).toHaveText(saved[0]!.content);
  expect(await full.locator("img").count()).toBe(0);
  expect(await page.evaluate(() => "XSS" in window)).toBe(false);
  expect(
    await full.evaluate((element) =>
      element.classList.contains("ym-hide-content"),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await full.screenshot({ path: info.outputPath("results-full-text.png") });
  await full
    .getByRole("button", { name: "← В результаты", exact: true })
    .click();
  await expect(open).toBeFocused();
  expect(state.reads.filter((path) => path.includes("/context"))).toEqual([]);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("changing result filters aborts an earlier query and never repaints its late private data", async ({
  page,
  context,
}) => {
  const state = await fixture(context, steps(1));
  await page.goto("/");
  await openResults(page);
  const form = results(page).getByRole("form", { name: "Поиск результатов" });
  const held = "/api/v1/personal-plan?search=OLDER_PRIVATE_QUERY";
  const release = state.holdPage(held);
  try {
    await form.getByLabel("Поиск в результатах").fill("OLDER_PRIVATE_QUERY");
    await form.getByRole("button", { name: "Найти", exact: true }).click();
    await expect.poll(() => state.reads.includes(held)).toBe(true);
    await form.getByLabel("Поиск в результатах").fill("Подготовить");
    await form.getByRole("button", { name: "Найти", exact: true }).click();
    await expect(results(page).getByRole("article")).toHaveCount(1);
    release();
    await expect.poll(() => state.pageReplies.includes(held)).toBe(true);
    await expect(results(page).getByRole("article")).toHaveCount(1);
    await expect(form.getByLabel("Поиск в результатах")).toHaveValue(
      "Подготовить",
    );
    expect(state.writes).toEqual([]);
    expect(state.unexpected).toEqual([]);
  } finally {
    release();
  }
});
