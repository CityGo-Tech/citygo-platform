import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";

const hosts = [
  {
    provider: "telegram",
    fragment: "tgWebAppData",
    script: "https://telegram.org/js/telegram-web-app.js?65",
    bridge: "window.Telegram = { WebApp: sdk };",
  },
  {
    provider: "max",
    fragment: "WebAppData",
    script: "https://st.max.ru/js/max-web-app.js",
    bridge: "window.WebApp = sdk;",
  },
] as const;

// These cookies exist only in the public in-memory API fixture.
async function useTestAccount(
  context: BrowserContext,
  account: "other" | "admin",
  ip: string,
) {
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": ip });
  await context.addCookies([
    {
      name: "citygo",
      value: createHash("sha256")
        .update("citygo-public-observability-test-session-v1:" + account)
        .digest("hex"),
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.route("https://**", (route) => route.abort());
}

async function openProfile(page: Page, host: (typeof hosts)[number]) {
  await page.goto(`/mini/${host.provider}#${host.fragment}=test-launch`);
  await page
    .getByRole("button", { name: "Войти в CityGo", exact: true })
    .click();
  await page.getByRole("button", { name: "Не сейчас", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Личный кабинет CityGo" })
    .getByRole("button", { name: "Профиль", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Электронная почта", exact: true })
      .getByText("observability-other@example.test", { exact: true }),
  ).toBeVisible();
}

for (const [hostIndex, host] of hosts.entries()) {
  test(`${host.provider} support saves a single request after a lost receipt and reads the actual reply`, async ({
    browser,
    context,
    page,
  }, info) => {
    test.setTimeout(60_000);
    const origin = info.project.use.baseURL!;
    const project = info.config.projects.findIndex(
      (candidate) => candidate.name === info.project.name,
    );
    const ip = (slot: number) =>
      `198.19.${51 + project}.${hostIndex * 16 + info.retry * 4 + slot}`;
    await useTestAccount(context, "other", ip(1));
    await page.route(host.script, (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `const sdk = { initData: 'test-launch', openLink() { throw new Error('Unexpected external navigation'); } }; ${host.bridge}`,
      }),
    );
    const sensitiveCalls: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        /(?:^|\.)mc\.yandex\./.test(url.hostname) ||
        /\/analytics\//.test(url.pathname) ||
        (request.method() !== "GET" &&
          url.pathname.startsWith("/api/v1/") &&
          !url.pathname.startsWith("/api/v1/support-requests"))
      )
        sensitiveCalls.push(url.pathname);
    });

    const sends: string[] = [];
    let savedId: string | undefined;
    await page.route("**/api/v1/support-requests", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sends.push(route.request().postDataJSON().operationId as string);
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const { request } = await response.json();
      if (sends.length === 1) {
        savedId = request.id;
        return route.abort();
      }
      expect(request.id).toBe(savedId);
      return route.fulfill({ response });
    });

    const openSupport = () =>
      page
        .getByRole("button", { name: "Помощь человека", exact: true })
        .click();
    const question = `Как после обновления найти сохранённый чек-лист? ${randomUUID()}`;
    await page.setViewportSize({ width: 320, height: 720 });
    await openProfile(page, host);
    await openSupport();
    const panel = page.getByRole("region", { name: "Помощь человека" });
    await expect(panel).toHaveClass(/ym-hide-content/);
    await expect(panel).toHaveClass(/ym-disable-keys/);
    const editor = panel.getByRole("textbox", { name: "Ваш вопрос" });
    const send = panel.getByRole("button", { name: "Отправить обращение" });
    await expect(send).toBeDisabled();
    await editor.fill(question);
    await expect(editor).toHaveValue(question);
    await send.click();
    await expect(panel.getByRole("alert")).toContainText(
      "Сохранение не подтверждено",
    );
    await panel
      .getByRole("button", { name: "Повторить сохранение того же вопроса" })
      .click();
    const receipt = page.getByRole("region", { name: "Обращение сохранено" });
    await expect(
      receipt.getByRole("status").filter({ hasText: "Статус: Открыто" }),
    ).toBeVisible();
    expect(sends).toEqual([sends[0], sends[0]]);
    expect(savedId).toBeDefined();

    const reply = "Откройте «Мой план» и выберите раздел «Результаты».";
    const admin = await browser.newContext({ baseURL: origin });
    try {
      await useTestAccount(admin, "admin", ip(2));
      const response = await admin.request.post(
        `/api/v1/admin/support-requests/${savedId}/replies`,
        {
          headers: { origin, "X-Forwarded-For": ip(2) },
          data: { operationId: randomUUID(), expectedRevision: 1, body: reply },
        },
      );
      expect(response.status()).toBe(200);
      const { request } = await response.json();
      const closed = await admin.request.patch(
        `/api/v1/admin/support-requests/${savedId}`,
        {
          headers: { origin, "X-Forwarded-For": ip(2) },
          data: { expectedRevision: request.revision, status: "closed" },
        },
      );
      expect(closed.status()).toBe(200);
    } finally {
      await admin.close();
    }

    await receipt.getByRole("button", { name: "Открыть обращение" }).click();
    const thread = page.locator(`#human-support-thread-${savedId}`);
    await expect(thread).toBeFocused();
    await expect(thread.getByText(reply, { exact: true })).toBeVisible();
    await expect(
      receipt.getByRole("status").filter({ hasText: "Статус: Закрыто" }),
    ).toBeVisible();
    await receipt.getByRole("button", { name: "К профилю" }).click();
    await expect(
      page.getByRole("heading", { name: "Профиль", exact: true }),
    ).toBeVisible();

    // A fresh mini app launch reads the same real request and reply.
    await page.goto("about:blank");
    await openProfile(page, host);
    await openSupport();
    await expect(thread.getByText(question, { exact: true })).toBeVisible();
    await expect(thread).toContainText(`Обращение №${savedId} · Закрыто`);
    await thread
      .getByRole("button", { name: `Ответы на обращение №${savedId}` })
      .click();
    await expect(thread.getByText(reply, { exact: true })).toBeVisible();
    await thread
      .getByRole("button", {
        name: "Отметить ответы прочитанными",
        exact: true,
      })
      .click();
    await expect(
      thread.getByRole("button", { name: "Ответы прочитаны", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    expect(sensitiveCalls).toEqual([]);
  });
}
