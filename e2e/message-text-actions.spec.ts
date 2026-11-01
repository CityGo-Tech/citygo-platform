import { openMessageActions } from "./navigation-helper";
import { test, expect, type BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Dashboard, Message } from "@citygo/contracts";
import { syntheticConsentPolicy } from "./service-consent-fixture";
import { fulfillProductAnalytics } from "./product-analytics-fixture";

const exactText =
  "**Точный ответ** 😀\nПервая строка\n<script>literal only</script>\n" +
  "Полный текст. ".repeat(150);
async function fixture(context: BrowserContext, denied = false) {
  const state = {
    owner: "101",
    writes: [] as string[],
    external: 0,
    unexpected: [] as string[],
  };
  await context.addInitScript(
    ({ denied }) => {
      const box = window as unknown as { citygoCopied: string[] };
      box.citygoCopied = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            if (denied) throw new Error("Synthetic unavailable");
            box.citygoCopied.push(text);
          },
        },
      });
    },
    { denied },
  );
  const thread = () => ({
    id: state.owner === "101" ? "10" : "20",
    agentKey: "support" as const,
    assistantKey: "support" as const,
    closed: false,
    messages:
      state.owner === "101"
        ? ([
            {
              id: "11",
              role: "user",
              agentKey: "support",
              status: "complete",
              content: "Мой законченный вопрос",
            },
            {
              id: "12",
              role: "assistant",
              agentKey: "support",
              status: "complete",
              content: exactText,
            },
            {
              id: "13",
              role: "assistant",
              agentKey: "support",
              status: "interrupted",
              content: "ПРЕРВАННЫЙ_ФРАГМЕНТ",
            },
          ] as Message[])
        : ([
            {
              id: "21",
              role: "user",
              agentKey: "support",
              status: "complete",
              content: "НОВЫЙ_ВЛАДЕЛЕЦ",
            },
          ] as Message[]),
  });
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: "synthetic@example.test",
      role: "user",
      mustChangePassword: false,
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
        routing: "No transport",
        data: "Fixture",
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
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      state.writes.push(path);
      return route.fulfill({
        status: 400,
        json: { error: "No mutations in this fixture" },
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
    if (/^\/api\/v1\/conversations\/(10|20)$/.test(path))
      return route.fulfill({ json: { userId: state.owner, thread: thread() } });
    if (path === "/api/v1/personal-plan/summary")
      return route.fulfill({
        json: { userId: state.owner, total: 0, pending: 0, completed: 0 },
      });
    if (path === "/api/v1/personal-plan")
      return route.fulfill({
        json: { userId: state.owner, items: [], nextBefore: null },
      });
    state.unexpected.push(path);
    return route.fulfill({
      status: 404,
      json: { error: "Unexpected synthetic route" },
    });
  });
  return state;
}

test("finished message copies and downloads exact full text locally on desktop/mobile", async ({
  context,
  page,
}, testInfo) => {
  const state = await fixture(context);
  await page.goto("/");
  const log = page.getByRole("log", { name: "История диалога", exact: true });
  const answer = log.locator('[data-history-message="12"]');
  await openMessageActions(log.locator('[data-history-message="11"]'));
  await openMessageActions(answer);
  const actions = answer.getByRole("group", {
    name: "Сохранить текст сообщения",
  });
  await expect(
    log.getByRole("group", { name: "Сохранить текст сообщения" }),
  ).toHaveCount(2);
  const interrupted = log.locator('[data-history-message="13"]');
  await expect(
    interrupted.getByRole("group", {
      name: "Сохранить текст сообщения",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await expect(
    interrupted.getByRole("button", {
      name: /^(Копировать текст|Скачать \.txt)$/,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await actions
    .getByRole("button", { name: "Копировать текст", exact: true })
    .click();
  await expect(actions.getByRole("status")).toHaveText("Текст скопирован");
  expect(
    await page.evaluate(
      () => (window as unknown as { citygoCopied: string[] }).citygoCopied,
    ),
  ).toEqual([exactText]);
  const saved = page.waitForEvent("download");
  await actions
    .getByRole("button", { name: "Скачать .txt", exact: true })
    .click();
  const download = await saved;
  expect(download.suggestedFilename()).toBe("citygo-message-12.txt");
  expect(await readFile((await download.path())!, "utf8")).toBe(exactText);
  await expect(actions).toHaveClass(/ym-hide-content/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await actions.screenshot({
    path: testInfo.outputPath(
      "message-actions-" + testInfo.project.name + ".png",
    ),
  });
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("clipboard denial offers selected readonly private text and still permits download", async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
  await page.goto("/");
  const answer = page.locator('[data-history-message="12"]');
  await openMessageActions(answer);
  await answer
    .getByRole("button", { name: "Копировать текст", exact: true })
    .click();
  const manual = answer.getByLabel("Текст для копирования", { exact: true });
  await expect(manual).toBeVisible();
  await expect(manual).toHaveValue(exactText);
  expect(
    await manual.evaluate((element: HTMLTextAreaElement) => ({
      selected: element.selectionEnd - element.selectionStart,
      readOnly: element.readOnly,
      masked: element.classList.contains("ym-disable-keys"),
    })),
  ).toEqual({ selected: exactText.length, readOnly: true, masked: true });
  const download = page.waitForEvent("download");
  await answer
    .getByRole("button", { name: "Скачать .txt", exact: true })
    .click();
  expect(await readFile((await (await download).path())!, "utf8")).toBe(
    exactText,
  );
  expect(state.writes).toEqual([]);
  expect(state.external).toBe(0);
});

test("owner replacement clears old message text and its action feedback", async ({
  context,
  page,
}) => {
  const state = await fixture(context, true);
  await page.goto("/");
  await openMessageActions(page.locator('[data-history-message="12"]'));
  await page
    .locator('[data-history-message="12"]')
    .getByRole("button", { name: "Копировать текст", exact: true })
    .click();
  await expect(
    page.getByLabel("Текст для копирования", { exact: true }),
  ).toBeVisible();
  state.owner = "102";
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await expect(
    page.getByRole("log", { name: "История диалога", exact: true }),
  ).toContainText("НОВЫЙ_ВЛАДЕЛЕЦ");
  await expect(page.locator('[data-history-message="12"]')).toHaveCount(0);
  await expect(
    page.getByLabel("Текст для копирования", { exact: true }),
  ).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.external).toBe(0);
});
