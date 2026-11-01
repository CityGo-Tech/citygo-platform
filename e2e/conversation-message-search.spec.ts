import { openConversationTools } from "./navigation-helper";
import { expect, test, type Page } from "@playwright/test";
import type { Dashboard, Message } from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
const term = "Москва 50%_\\route";
const row = (id: string, content = term): Message => ({
  id,
  role: BigInt(id) % 2n ? "user" : "assistant",
  agentKey: "support",
  status: "complete",
  favorite: false,
  content,
});
async function install(page: Page) {
  const messages = [
    row("7", "Давнее совпадение " + term),
    ...Array.from({ length: 24 }, (_, i) =>
      row(
        String(9007199254740993n + BigInt(i)),
        "Совпадение " + i + " " + term,
      ),
    ),
  ];
  const state = {
    owner: "10",
    reads: [] as URL[],
    context: [] as string[],
    mutations: 0,
    unexpected: [] as string[],
    dashboardReads: 0,
    foreign: false,
    fail: false,
    delayed: false,
    release: () => {},
    delivered: Promise.resolve(),
  };
  const gate = new Promise<void>((r) => {
    state.release = r;
  });
  let delivered = () => {};
  state.delivered = new Promise<void>((r) => {
    delivered = r;
  });
  const dashboard = (): Dashboard => ({
    user: {
      id: state.owner,
      email: "synthetic-owner@example.test",
      role: "user",
    },
    profile: null,
    quests: [],
    xp: 0,
    thread: {
      id: state.owner === "10" ? "20" : "30",
      agentKey: "support",
      assistantKey: "support",
      closed: false,
      messages: messages.slice(-3),
    },
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
        data: "Fictional",
      },
      credit: {
        currency: "RUB",
        bonusGranted: false,
        grantedMicros: 100000000,
        heldMicros: 0,
        spentMicros: 0,
        availableMicros: 100000000,
        chargingStatus: "routerai_citygo_10x",
        reservationMode: "fixed5_overdraft",
        minimumRequestBalanceMicros: 5000000,
        outstandingDebtMicros: 0,
        topUpAvailable: true,
        history: [],
      },
    },
  });
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (route.request().method() !== "GET") state.mutations++;
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/dashboard") {
      state.dashboardReads++;
      return route.fulfill({ json: dashboard() });
    }
    if (/^\/api\/v1\/conversations\/\d+\/messages\/search$/.test(path)) {
      state.reads.push(url);
      const search = url.searchParams.get("search")!,
        before = url.searchParams.get("before");
      if (state.fail) {
        state.fail = false;
        return route.fulfill({
          status: 500,
          json: { error: "PRIVATE_INTERNAL_ERROR" },
        });
      }
      const selected = messages
        .filter(
          (m) =>
            (!before || BigInt(m.id) < BigInt(before)) &&
            m.content.toLowerCase().includes(search.toLowerCase()),
        )
        .reverse();
      const matches = selected.slice(0, 20).map((m) => ({
        messageId: m.id,
        role: m.role,
        agentKey: m.agentKey,
        status: m.status,
        snippet: m.content,
      }));
      const result = {
        userId: state.foreign ? "99" : state.owner,
        threadId: state.owner === "10" ? "20" : "30",
        search,
        matches,
        nextCursor: selected.length > 20 ? matches.at(-1)!.messageId : null,
      };
      if (state.delayed) {
        await gate;
        try {
          await route.fulfill({ json: result });
        } catch {
          /* Expected aborted transport. */
        } finally {
          delivered();
        }
        return;
      }
      return route.fulfill({ json: result });
    }
    const context = path.match(
      /^\/api\/v1\/conversations\/(\d+)\/messages\/(\d+)\/context$/,
    );
    if (context) {
      state.context.push(context[2]!);
      return route.fulfill({
        json: {
          userId: state.owner,
          threadId: context[1],
          messages: [
            row("6", "Предшествующий вопрос"),
            messages.find((m) => m.id === context[2])!,
          ],
          nextCursor: null,
        },
      });
    }
    state.unexpected.push(route.request().method() + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  return state;
}
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Найти в диалоге", exact: true });
async function open(page: Page) {
  await openConversationTools(page);
  await page
    .getByRole("button", { name: "Найти в диалоге", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
}
async function search(page: Page, value = term) {
  await dialog(page).getByLabel("Текст сообщения", { exact: true }).fill(value);
  await dialog(page)
    .getByRole("button", { name: "Найти сообщения", exact: true })
    .click();
}
test("in-thread search opens exact older bigint matches and preserves the current draft without sending", async ({
  page,
}, info) => {
  const state = await install(page);
  await page.goto("/");
  const draft = page.getByLabel("Сообщение помощнику", { exact: true });
  await draft.fill("НЕОТПРАВЛЕННЫЙ ЧЕРНОВИК");
  await open(page);
  await search(page);
  await expect(dialog(page).getByRole("article")).toHaveCount(20);
  expect(state.reads[0]!.searchParams.get("search")).toBe(term);
  await dialog(page)
    .getByRole("button", { name: "Показать ещё совпадения", exact: true })
    .click();
  await expect(dialog(page).getByRole("article")).toHaveCount(25);
  expect(state.reads[1]!.searchParams.get("before")).toBe("9007199254740997");
  await expect(dialog(page)).toHaveClass(/ym-hide-content/);
  await expect(dialog(page).getByLabel("Текст сообщения")).toHaveClass(
    /ym-disable-keys/,
  );
  expect(
    await dialog(page).evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  await dialog(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  await dialog(page).screenshot({
    path: info.outputPath("message-search-results.png"),
  });
  await dialog(page)
    .getByRole("article")
    .last()
    .getByRole("button", { name: "Открыть сообщение", exact: true })
    .click();
  const source = dialog(page).getByRole("article", {
    name: "Найденное сообщение в диалоге",
    exact: true,
  });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute("data-source-message", "7");
  await expect(source).toBeFocused();
  expect(state.context).toEqual(["7"]);
  await dialog(page).screenshot({
    path: info.outputPath("message-search-context.png"),
  });
  await dialog(page)
    .getByRole("button", { name: "← К результатам поиска", exact: true })
    .click();
  await expect(dialog(page).getByLabel("Текст сообщения")).toHaveValue(term);
  await expect(dialog(page).getByRole("article")).toHaveCount(25);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(draft).toHaveValue("НЕОТПРАВЛЕННЫЙ ЧЕРНОВИК");
  await expect(
    page.getByRole("button", { name: "Найти в диалоге", exact: true }),
  ).toBeFocused();
  await open(page);
  await expect(dialog(page).getByLabel("Текст сообщения")).toHaveValue("");
  await expect(dialog(page).getByRole("article")).toHaveCount(0);
  const stored = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(stored).not.toContain(term);
  expect(new URL(page.url()).search).toBe("");
  expect(state.mutations).toBe(0);
  expect(state.unexpected).toEqual([]);
});
test("in-thread search handles failed and empty queries and discards a response after closing", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/");
  await open(page);
  state.fail = true;
  await search(page);
  await expect(dialog(page).getByRole("alert")).toHaveText(
    "Не удалось выполнить поиск. Попробуйте ещё раз.",
  );
  await expect(page.getByText("PRIVATE_INTERNAL_ERROR")).toHaveCount(0);
  await search(page, "Нет совпадений");
  await expect(dialog(page).getByRole("status")).toHaveText(
    "Сообщений с таким текстом нет.",
  );
  state.delayed = true;
  await search(page);
  await expect.poll(() => state.reads.length).toBe(3);
  await dialog(page)
    .getByRole("button", { name: "Вернуться к диалогу", exact: true })
    .click();
  state.release();
  await state.delivered;
  await open(page);
  await expect(dialog(page).getByRole("article")).toHaveCount(0);
  await expect(dialog(page).getByLabel("Текст сообщения")).toHaveValue("");
  expect(state.mutations).toBe(0);
  expect(state.unexpected).toEqual([]);
});
test("in-thread search clears private results when the active account changes during a request", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/");
  await open(page);
  state.delayed = true;
  await search(page);
  await expect.poll(() => state.reads.length).toBe(1);
  state.owner = "11";
  const prior = state.dashboardReads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(prior);
  await expect(dialog(page)).toHaveCount(0);
  state.release();
  await state.delivered;
  await open(page);
  await expect(dialog(page).getByRole("article")).toHaveCount(0);
  await expect(dialog(page).getByLabel("Текст сообщения")).toHaveValue("");
  expect(state.mutations).toBe(0);
  expect(state.unexpected).toEqual([]);
});
