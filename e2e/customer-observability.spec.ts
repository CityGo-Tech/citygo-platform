import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";
import {
  adminCustomerAccountsResponseSchema,
  adminCustomerConversationsResponseSchema,
} from "../packages/contracts/src/admin-customer-observability";

// Seeded only by the isolated NODE_ENV=test, in-memory API test entrypoint.
// Public synthetic sessions are seeded directly into the test memory DB.
// This suite does not consume the production-shaped login rate limit needed by
// the separate real password/login flow. Every request still authenticates its
// actual current DB session and role; no production data or providers are used.
const fixture = {
  owner: "observability-owner@example.test",
  controller: "observability-controller@example.test",
  admin: "observability-admin@example.test",
  customer: "observability-customer@example.test",
  other: "observability-other@example.test",
  firstMessage: "Первый вопрос тестового пользователя",
  lastMessage:
    '<img src=x onerror="window.__unexpectedPrivateHtml=true"> Только текст ответа',
  planTitle: "Найти жильё для переезда",
};
const origin = "http://localhost:3000";
const headers = { Origin: origin, "X-CityGo-Contract-Version": "1" };
const syntheticSessionCookie = (name: string) => ({
  name: "citygo",
  value: createHash("sha256")
    .update("citygo-public-observability-test-session-v1:" + name)
    .digest("hex"),
  domain: "localhost",
  path: "/",
  expires: Math.floor(Date.now() / 1000) + 86400,
  httpOnly: true,
  secure: false,
  sameSite: "Lax" as const,
});
let owner: APIRequestContext;
let controller: APIRequestContext;
let ordinaryAdmin: APIRequestContext;
let customer: APIRequestContext;
let anonymous: APIRequestContext;
let ownerCookies: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let roleLossViewers: Map<string, string>;
let customerId: string;
let otherId: string;
let conversationId: string;

test.beforeAll(async ({ playwright }) => {
  const session = async (name: string) =>
    playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: headers,
      storageState: { cookies: [syntheticSessionCookie(name)], origins: [] },
    });
  owner = await session("owner");
  controller = await session("controller");
  ordinaryAdmin = await session("admin");
  customer = await session("customer");
  anonymous = await playwright.request.newContext({
    baseURL: origin,
    extraHTTPHeaders: headers,
  });
  ownerCookies = await owner.storageState();
  const accounts = adminCustomerAccountsResponseSchema.parse(
    await (await owner.get("/api/v1/admin/customer-accounts")).json(),
  ).accounts;
  expect(accounts.some((account) => account.email === fixture.owner)).toBe(
    true,
  );
  roleLossViewers = new Map(
    accounts.map((account) => [account.email, account.userId]),
  );
  customerId = accounts.find(
    (account) => account.email === fixture.customer,
  )!.userId;
  otherId = accounts.find((account) => account.email === fixture.other)!.userId;
  const conversations = adminCustomerConversationsResponseSchema.parse(
    await (
      await owner.get(
        `/api/v1/admin/customer-accounts/${customerId}/conversations`,
      )
    ).json(),
  );
  conversationId = conversations.conversations[0]!.id;
});

test.afterAll(async () => {
  for (const api of [owner, controller, ordinaryAdmin, customer, anonymous])
    await api?.dispose();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(ownerCookies.cookies);
});

async function openExplorer(page: Page) {
  await page.goto("/admin");
  await page
    .getByRole("button", { name: "Обновить сводку", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Пользователи и воронка", exact: true }),
  ).toBeVisible();
  return page.locator("[data-private-customer-view]");
}

async function searchAccount(explorer: Locator, email: string) {
  await explorer.getByLabel("Найти пользователя", { exact: true }).fill(email);
  await explorer
    .getByRole("button", {
      name: /^(Показать|Обновить) пользователей и показатели$/,
    })
    .click();
  const row = explorer.getByRole("row").filter({ hasText: email });
  await expect(row).toBeVisible();
  return row;
}

async function openCustomer(page: Page) {
  const explorer = await openExplorer(page);
  const row = await searchAccount(explorer, fixture.customer);
  await row
    .getByRole("button", { name: "Открыть кабинет", exact: true })
    .click();
  const cabinet = explorer.getByRole("region", {
    name: `Кабинет пользователя ${customerId}`,
    exact: true,
  });
  await expect(cabinet).toBeVisible();
  return { explorer, cabinet };
}

test("super admin reads the real customer snapshot, plan, favorites, activity and cohort metrics without changing the account", async ({
  page,
}) => {
  const writes: string[] = [];
  const trackers: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET")
      writes.push(new URL(request.url()).pathname);
    if (/^https:\/\/(?:mc\.|mc\.webvisor\.|metrika\.)/.test(request.url()))
      trackers.push(request.url());
  });
  const { explorer, cabinet } = await openCustomer(page);
  await expect(cabinet).toContainText("Режим просмотра");
  await expect(cabinet.getByText("Казань", { exact: true })).toBeVisible();
  await expect(cabinet.getByText("Москва", { exact: true })).toBeVisible();
  await expect(cabinet.getByText("492 ₽", { exact: true })).toBeVisible();
  await expect(cabinet.getByText("128", { exact: true })).toBeVisible();
  await expect(cabinet.locator("textarea")).toHaveCount(0);
  await cabinet.screenshot({
    path: test.info().outputPath("customer-account.png"),
  });
  await expect(explorer).toHaveClass(/ym-hide-content/);
  await expect(page.locator("main")).toHaveClass(/ym-hide-content/);
  const funnel = explorer.getByRole("region", { name: "Показатели воронки" });
  await expect(funnel.getByText("Регистрация", { exact: true })).toBeVisible();
  await funnel.getByText("Активность по дням", { exact: true }).click();
  await expect(
    funnel.getByRole("columnheader", { name: "Сообщения пользователей" }),
  ).toBeVisible();

  await cabinet.getByRole("button", { name: "План", exact: true }).click();
  await expect(
    cabinet.getByText(fixture.planTitle, { exact: true }),
  ).toBeVisible();
  await cabinet.getByRole("button", { name: "Избранное", exact: true }).click();
  await expect(
    cabinet.getByText(fixture.lastMessage, { exact: true }),
  ).toBeVisible();
  await expect(cabinet.locator("article img")).toHaveCount(0);
  await cabinet.getByRole("button", { name: "Действия", exact: true }).click();
  const actions = cabinet.getByRole("list", { name: "Действия пользователя" });
  await expect(
    actions.getByText("Открыл баланс", { exact: true }),
  ).toBeVisible();
  await expect(
    actions.getByText("Открыл личный план", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
  expect(trackers).toEqual([]);
  await expect(
    page.locator('script[src*="mc.yandex"], script[src*="webvisor"]'),
  ).toHaveCount(0);
});

test("the real closed conversation preserves all 128 messages across older and newer pages and renders message markup as text", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { cabinet } = await openCustomer(page);
  await cabinet.getByRole("button", { name: "Диалоги", exact: true }).click();
  await expect(
    cabinet.getByText("128 сообщений", { exact: false }),
  ).toBeVisible();
  await cabinet
    .getByRole("button", { name: "Прочитать диалог", exact: true })
    .click();
  const history = cabinet.getByRole("region", {
    name: `Сообщения диалога ${conversationId}`,
    exact: true,
  });
  await expect(history.getByRole("article")).toHaveCount(25);
  await expect(
    history.getByText(fixture.lastMessage, { exact: true }),
  ).toBeVisible();
  await expect(history.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => "__unexpectedPrivateHtml" in window)).toBe(
    false,
  );
  await cabinet.screenshot({
    path: test.info().outputPath("customer-conversation.png"),
  });
  const messageIds: string[] = [];
  let pages = 0;
  for (;;) {
    const ids = await history
      .getByRole("article")
      .locator("small")
      .allTextContents();
    const currentIds = ids.map((text) => text.match(/ID (\d+)$/)![1]!);
    expect(currentIds.length).toBeGreaterThan(0);
    expect(currentIds).toEqual(
      [...currentIds].sort((left, right) =>
        BigInt(left) < BigInt(right) ? -1 : 1,
      ),
    );
    messageIds.unshift(...currentIds);
    pages++;
    const older = history.getByRole("button", {
      name: "Более ранние сообщения",
    });
    if (!(await older.count())) break;
    expect(pages).toBeLessThan(7);
    await older.click();
    await expect(history).toBeVisible();
  }
  expect(pages).toBe(6);
  expect(messageIds).toHaveLength(128);
  expect(new Set(messageIds).size).toBe(128);
  await expect(
    history.getByText(fixture.firstMessage, { exact: true }),
  ).toBeVisible();
  await history
    .getByRole("button", { name: "Более поздние сообщения" })
    .click();
  await expect(history.getByRole("article")).toHaveCount(25);
  await expect(
    history.getByText(fixture.firstMessage, { exact: true }),
  ).toHaveCount(0);
  await history.getByRole("button", { name: "Последние сообщения" }).click();
  await expect(
    history.getByText(fixture.lastMessage, { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("region", { name: /^Кабинет пользователя / }),
  ).toHaveCount(0);
  await expect(
    page.getByText(fixture.lastMessage, { exact: true }),
  ).toHaveCount(0);
});

test("a delayed real account response cannot repaint private data after hiding it and selecting another account", async ({
  page,
}) => {
  const explorer = await openExplorer(page);
  const row = await searchAccount(explorer, fixture.customer);
  let release = () => {};
  let received = () => {};
  let delivered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetched = new Promise<void>((resolve) => {
    received = resolve;
  });
  const deliveryFinished = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  await page.route(
    `**/api/v1/admin/customer-accounts/${customerId}`,
    async (route) => {
      // The response really comes from the isolated API; only delivery is delayed.
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response }).catch(() => {});
      delivered();
    },
    { times: 1 },
  );
  try {
    await row
      .getByRole("button", { name: "Открыть кабинет", exact: true })
      .click();
    await fetched;
    await explorer
      .getByRole("button", { name: "Скрыть данные", exact: true })
      .click();
    const other = await searchAccount(explorer, fixture.other);
    await other
      .getByRole("button", { name: "Открыть кабинет", exact: true })
      .click();
    const otherCabinet = explorer.getByRole("region", {
      name: `Кабинет пользователя ${otherId}`,
      exact: true,
    });
    await expect(otherCabinet).toBeVisible();
    release();
    await deliveryFinished;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(
      explorer.getByRole("region", {
        name: `Кабинет пользователя ${customerId}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(otherCabinet).toBeVisible();
    await expect(explorer.getByText("Казань", { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
});

test("a real super admin role loss clears the already displayed cabinet before another privileged read", async ({
  page,
}, testInfo) => {
  expect(["desktop", "mobile-web"]).toContain(testInfo.project.name);
  expect(testInfo.retry).toBeLessThanOrEqual(1);
  const name = `role-loss-${testInfo.project.name}-${testInfo.retry}`;
  const viewerId = roleLossViewers.get(`observability-${name}@example.test`)!;
  expect(viewerId).toBeTruthy();
  await page.context().clearCookies();
  await page.context().addCookies([syntheticSessionCookie(name)]);
  const { cabinet } = await openCustomer(page);
  const setRole = (role: "admin" | "super_admin") =>
    controller.post("/api/v1/admin/accounts/role", {
      data: { userId: viewerId, role },
    });
  try {
    expect((await setRole("admin")).status()).toBe(200);
    await cabinet
      .getByRole("button", { name: "Избранное", exact: true })
      .click();
    await expect(page.locator("[data-private-customer-view]")).toHaveCount(0);
    await expect(page.getByText("Казань", { exact: true })).toHaveCount(0);
    await expect(page.locator("main").getByRole("alert")).toContainText(
      "Доступ к просмотру пользователей изменился",
    );
    const response = await page.request.get(
      `/api/v1/admin/customer-accounts/${customerId}`,
    );
    // Privilege changes revoke the existing session as well as changing its role.
    expect(response.status()).toBe(401);
    expect(await response.text()).not.toContain(fixture.customer);
  } finally {
    expect((await setRole("super_admin")).status()).toBe(200);
  }
});

test("real anonymous, user and ordinary admin sessions cannot read private account endpoints or a foreign conversation", async () => {
  const base = `/api/v1/admin/customer-accounts/${customerId}`;
  // The full endpoint/role matrix is covered by actual API integration tests.
  // Browser coverage samples each privilege boundary without exhausting the
  // unchanged application rate limit shared by all browser tests.
  for (const [api, path, status] of [
    [anonymous, base, 401],
    [customer, `${base}/conversations/${conversationId}/messages`, 403],
    [ordinaryAdmin, base, 403],
  ] as const) {
    const response = await api.get(path);
    expect(response.status(), path).toBe(status);
    const body = await response.text();
    expect(body).not.toContain(fixture.customer);
    expect(body).not.toContain(fixture.firstMessage);
    expect(body).not.toContain("availableMicros");
  }
  const foreign = await controller.get(
    `/api/v1/admin/customer-accounts/${otherId}/conversations/${conversationId}/messages`,
  );
  expect(foreign.status()).toBe(404);
  expect(await foreign.text()).not.toContain(fixture.lastMessage);
});
