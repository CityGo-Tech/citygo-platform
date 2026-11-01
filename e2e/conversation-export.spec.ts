import { expect, test, type BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type {
  ConversationExportSnapshot,
  Dashboard,
  Message,
} from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
const id = "9007199254740993",
  stamp = "2026-11-01T10:00:00Z";
const first = "САМОЕ_СТАРОЕ_ЛИЧНОЕ_СООБЩЕНИЕ😀\n<script>literal only</script>";
const all: ConversationExportSnapshot["messages"] = Array.from(
  { length: 235 },
  (_, n) => ({
    id: (9007199254741993n + BigInt(n)).toString(),
    role: n % 2 ? "assistant" : "user",
    content:
      n === 0
        ? first
        : "Полное сохранённое сообщение " +
          n +
          "\n" +
          "Точная история 😀 ".repeat(20),
    agentKey: "support",
    status: n === 233 ? "interrupted" : "complete",
    failureCode: null,
    createdAt: stamp,
  }),
);
async function fixture(context: BrowserContext) {
  const state = {
    owner: "101",
    closed: false,
    reads: 0,
    fail: 0,
    badOwner: false,
    delay: false,
    release: () => {},
    delivered: Promise.resolve(),
    writes: [] as string[],
    external: 0,
    unexpected: [] as string[],
  };
  const gate = new Promise<void>((resolve) => (state.release = resolve));
  let delivered = () => {};
  state.delivered = new Promise<void>((resolve) => (delivered = resolve));
  const thread = () => ({
    id: state.owner === "101" ? id : "20",
    agentKey: "support" as const,
    assistantKey: "support" as const,
    closed: state.closed,
    messages:
      state.owner === "101"
        ? (all.slice(-3).map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            agentKey: message.agentKey,
            status: message.status,
            failureCode: message.failureCode,
          })) as Message[])
        : [
            {
              id: "21",
              role: "user" as const,
              agentKey: "support" as const,
              status: "complete" as const,
              content: "НОВЫЙ_АККАУНТ",
            },
          ],
  });
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: "synthetic-export@example.test",
      role: "user",
    },
    profile: null,
    xp: 0,
    quests: [],
    thread: thread(),
    provider: "routerai",
    aiAccess: {
      granted: true,
      dailyLimit: 100,
      policy: {
        id: "a".repeat(64),
        version: "synthetic",
        provider: "routerai",
        model: "synthetic",
        recipient: "Synthetic",
        routing: "No provider",
        data: "Fictional only",
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
  await context.route("https://**", (route) => {
    state.external++;
    return route.abort();
  });
  await context.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (request.method() !== "GET") {
      state.writes.push(path);
      return route.fulfill({
        status: 400,
        json: { error: "No writes allowed" },
      });
    }
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/dashboard") return route.fulfill({ json: board() });
    if (path === "/api/v1/conversations/" + id + "/export") {
      state.reads++;
      expect(url.search).toBe("");
      const snapshot = {
        version: 1,
        userId: state.badOwner ? "999" : state.owner,
        generatedAt: stamp,
        thread: {
          id,
          agentKey: "support",
          assistantKey: "support",
          closed: state.closed,
        },
        messages: all,
      };
      if (state.delay) await gate;
      try {
        if (state.fail)
          return await route.fulfill({
            status: state.fail,
            json: { error: "PRIVATE_UPSTREAM_DETAIL" },
          });
        return await route.fulfill({ json: snapshot });
      } catch {
        /* Lifetime cancellation expected. */
      } finally {
        delivered();
      }
      return;
    }
    if (
      path === "/api/v1/conversations/" + id ||
      path === "/api/v1/conversations/20"
    )
      return route.fulfill({ json: { userId: state.owner, thread: thread() } });
    state.unexpected.push(path);
    return route.fulfill({
      status: 404,
      json: { error: "Unexpected synthetic route" },
    });
  });
  return state;
}
const downloadButton = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Скачать весь диалог", exact: true });
test("whole open/closed chat download includes old full texts and interrupted status without analytics/storage or writes", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  state.closed = true;
  await page.goto("/");
  await expect(downloadButton(page)).toBeVisible();
  expect(state.reads).toBe(0);
  await expect(page.getByText(first, { exact: true })).toHaveCount(0);
  const pending = page.waitForEvent("download");
  await downloadButton(page).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("citygo-dialog-" + id + ".txt");
  const text = await readFile((await download.path())!, "utf8");
  expect(text).toContain(first);
  expect(text).toContain(all.at(-1)!.content);
  expect(text).toContain("Ответ прерван.");
  expect(text).toContain("Диалог завершён");
  expect(text.indexOf(first)).toBeLessThan(text.indexOf(all.at(-1)!.content));
  expect(text.match(/ · 2026-11-01T10:00:00Z/g)).toHaveLength(235);
  await expect(
    page.locator('[aria-label="Скачивание диалога"]').getByRole("status"),
  ).toContainText("Скачивание диалога начато");
  expect(state.reads).toBe(1);
  await expect(page.locator('[aria-label="Скачивание диалога"]')).toHaveClass(
    /ym-hide-content/,
  );
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain(first);
  expect(page.url()).not.toContain("export");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.locator('[aria-label="Скачивание диалога"]').screenshot({
    path: info.outputPath("conversation-export-" + info.project.name + ".png"),
  });
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});
test("oversize/error responses remain generic and can be retried only by another explicit click", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.fail = 413;
  await page.goto("/");
  await downloadButton(page).click();
  await expect(
    page.locator('[aria-label="Скачивание диалога"]').getByRole("alert"),
  ).toContainText("слишком большой");
  await expect(page.getByText("PRIVATE_UPSTREAM_DETAIL")).toHaveCount(0);
  expect(state.reads).toBe(1);
  state.fail = 0;
  const pending = page.waitForEvent("download");
  await downloadButton(page).click();
  await pending;
  expect(state.reads).toBe(2);
  expect(state.writes).toEqual([]);
  expect(state.external).toBe(0);
});
test("cancellation or account replacement suppresses a late download and clears old export feedback", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.delay = true;
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.goto("/");
  await downloadButton(page).click();
  await expect.poll(() => state.reads).toBe(1);
  await page
    .getByRole("button", { name: "Отменить скачивание", exact: true })
    .click();
  state.release();
  await state.delivered;
  await expect(downloadButton(page)).toBeEnabled();
  expect(downloads).toBe(0);
  state.delay = false;
  state.badOwner = true;
  await downloadButton(page).click();
  await expect(
    page.getByLabel("Электронная почта", { exact: true }),
  ).toBeVisible();
  expect(downloads).toBe(0);
  expect(state.writes).toEqual([]);
  expect(state.external).toBe(0);
});
