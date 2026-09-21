import { test, expect, type Page } from "@playwright/test";
import type { Dashboard } from "@citygo/contracts";
function board(): Dashboard {
  return {
    user: { id: "synthetic", email: "resilience@example.test" },
    profile: {
      originCity: "Казань",
      targetCity: "Москва",
      monthlyBudget: 50000,
      moveTargetDate: "2099-01-01",
      household: "solo",
      aiConsent: true,
    },
    xp: 0,
    provider: "openai",
    quests: [
      {
        id: "1",
        slug: "housing-search",
        title: "План поиска жилья",
        state: "in_progress",
        xpReward: 60,
      },
    ],
    thread: { id: "1", agentKey: "housing", messages: [] },
    aiAccess: {
      granted: true,
      dailyLimit: 20,
      policy: {
        id: "a".repeat(64),
        version: "synthetic",
        provider: "openai",
        model: "fixture-only",
        recipient: "Тестовый провайдер",
        routing: "Без сетевых вызовов",
        data: "Вымышленные данные",
      },
    },
  };
}
async function install(page: Page) {
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({ json: board() }),
  );
}
const alert = (page: Page) => page.locator(".alert[role=alert]");

for (const response of [
  {
    name: "false done",
    contentType: "text/event-stream",
    body: 'data:{"type":"done"}\n\n',
    error: "некорректное событие",
  },
  {
    name: "HTML instead of SSE",
    contentType: "text/html",
    body: "<b>PRIVATE UPSTREAM DETAIL</b>",
    error: "неподдерживаемого формата",
  },
  {
    name: "oversized SSE frame",
    contentType: "text/event-stream",
    body: ":" + "x".repeat(256 * 1024),
    error: "допустимый размер",
  },
]) {
  test(`${response.name} releases chat busy and preserves draft without auto-replay`, async ({
    page,
  }) => {
    await install(page);
    let calls = 0;
    await page.route("**/api/v1/threads/*/messages", async (route) => {
      calls++;
      await route.fulfill({
        contentType: response.contentType,
        body: response.body,
      });
    });
    await page.goto("/#chat");
    await page.getByLabel("Сообщение помощнику").fill("Синтетический черновик");
    await page.getByRole("button", { name: "Отправить", exact: true }).click();
    await expect(alert(page)).toContainText(response.error);
    await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(
      "Синтетический черновик",
    );
    await expect(
      page.getByRole("button", { name: "Отправить", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Прервать ответ" }),
    ).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(
      "PRIVATE UPSTREAM DETAIL",
    );
    expect(calls).toBe(1);
  });
}
test("invalid dashboard clears loading and reports a safe error", async ({
  page,
}) => {
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({
      json: { user: { id: "wrong" }, secret: "PRIVATE UPSTREAM DETAIL" },
    }),
  );
  await page.goto("/");
  await expect(alert(page)).toContainText(
    "не соответствует ожидаемому формату",
  );
  await expect(page.getByLabel("Электронная почта")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    "PRIVATE UPSTREAM DETAIL",
  );
});
test("JSON deadline releases initial loading without an automatic second request", async ({
  page,
}) => {
  await page.clock.install();
  let started!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route("**/api/v1/dashboard", async (route) => {
    calls++;
    started();
    await held;
    await route.abort().catch(() => {});
  });
  await page.goto("/");
  await seen;
  try {
    await page.clock.fastForward(30001);
    await expect(alert(page)).toContainText("Время ожидания ответа истекло");
    await expect(page.getByLabel("Электронная почта")).toBeVisible();
    expect(calls).toBe(1);
  } finally {
    release();
  }
});
test("chat idle timeout restores draft and releases busy without replaying the message", async ({
  page,
}) => {
  await page.clock.install();
  await install(page);
  let started!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route("**/api/v1/threads/*/messages", async (route) => {
    calls++;
    started();
    await held;
    await route.abort().catch(() => {});
  });
  await page.goto("/#chat");
  await page.getByLabel("Сообщение помощнику").fill("Черновик при зависании");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await seen;
  try {
    await page.clock.fastForward(45001);
    await expect(alert(page)).toContainText("Соединение не передаёт данные");
    await expect(page.getByLabel("Сообщение помощнику")).toHaveValue(
      "Черновик при зависании",
    );
    await expect(
      page.getByRole("button", { name: "Отправить", exact: true }),
    ).toBeEnabled();
    expect(calls).toBe(1);
  } finally {
    release();
  }
});
test("malformed completion does not award XP or navigate to success", async ({
  page,
}) => {
  await install(page);
  let calls = 0;
  await page.route("**/api/v1/quests/*/complete", async (route) => {
    calls++;
    await route.fulfill({ json: { awarded: "60" } });
  });
  await page.goto("/#chat");
  const criteria = page
    .getByRole("group", { name: "Подтвердите результат" })
    .getByRole("checkbox");
  await expect(criteria).toHaveCount(3);
  for (const checkbox of await criteria.all()) await checkbox.check();
  const complete = page.getByRole("button", {
    name: "Завершить квест · +60 XP",
  });
  await complete.click();
  await expect(alert(page)).toContainText(
    "не соответствует ожидаемому формату",
  );
  await expect(complete).toBeEnabled();
  await expect(page.locator(".account")).toContainText("0 XP");
  expect(page.url()).not.toContain("#complete");
  expect(calls).toBe(1);
});
