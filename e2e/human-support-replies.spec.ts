import { expect, test, type BrowserContext } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";

// Only the public NODE_ENV=test fixture creates these deterministic sessions.
async function session(
  context: BrowserContext,
  name: string,
  clientIp: string,
) {
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": clientIp });
  await context.addCookies([
    {
      name: "citygo",
      value: createHash("sha256")
        .update("citygo-public-observability-test-session-v1:" + name)
        .digest("hex"),
      domain: "localhost",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 86400,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await context.route("https://**", (route) => route.abort());
}

test("a human owner reply reaches only its requesting account and survives reload without AI or payment", async ({
  page,
  context,
  browser,
}, info) => {
  test.setTimeout(90_000);
  const projectIndex = info.config.projects.findIndex(
    (project) => project.name === info.project.name,
  );
  expect(projectIndex).toBeGreaterThanOrEqual(0);
  expect(projectIndex).toBeLessThan(254);
  const clientIp = (slot: number) => {
    const host = info.retry * 16 + slot;
    expect(host).toBeLessThan(255);
    return `198.18.${projectIndex + 1}.${host}`;
  };
  const userIp = clientIp(1),
    adminIp = clientIp(2),
    anonymousIp = clientIp(3);
  await session(context, "other", userIp);
  // This new context has a fresh real limiter bucket, still capped at 120/min.
  const health = await context.request.get("/api/health", {
    headers: { "X-Forwarded-For": userIp },
  });
  expect(health.status()).toBe(200);
  expect(health.headers()["x-ratelimit-limit"]).toBe("120");
  expect(health.headers()["x-ratelimit-remaining"]).toBe("119");
  const question = `Помогите выбрать первые действия после переезда. ${randomUUID()}`;
  const created = await context.request.post("/api/v1/support-requests", {
    data: { operationId: randomUUID(), body: question },
    headers: {
      origin: String(info.project.use.baseURL),
      "X-Forwarded-For": userIp,
    },
  });
  expect(created.status()).toBe(200);
  const { request } = await created.json();
  const reply = `Начните со списка районов и транспорта. ${info.project.name} ${randomUUID()}`;
  const forbidden: string[] = [];
  const track = (p: typeof page) =>
    p.on("request", (req) => {
      if (
        req.method() !== "GET" &&
        /\/threads\/\d+\/messages|\/payments\//.test(req.url())
      )
        forbidden.push(req.url());
    });
  track(page);
  const adminContext = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
  await session(adminContext, "admin", adminIp);
  const admin = await adminContext.newPage();
  track(admin);
  try {
    await admin.goto("/admin");
    await admin
      .getByRole("button", { name: "Обновить сводку", exact: true })
      .click();
    const inbox = admin.getByRole("region", {
      name: "Обращения к человеку",
      exact: true,
    });
    await inbox
      .getByRole("button", {
        name: "Обновить обращения пользователей",
        exact: true,
      })
      .click();
    await inbox
      .getByRole("button", {
        name: `Открыть обращение №${request.id}`,
        exact: true,
      })
      .click();
    const detail = inbox.getByRole("region", {
      name: `Карточка обращения №${request.id}`,
      exact: true,
    });
    await detail
      .getByRole("textbox", { name: "Ответ пользователю", exact: true })
      .fill(reply);
    await detail
      .getByRole("button", { name: "Сохранить ответ", exact: true })
      .click();
    await expect(detail.getByText(reply, { exact: true })).toBeVisible();
    await expect(
      detail.getByRole("textbox", { name: "Ответ пользователю", exact: true }),
    ).toHaveValue("");
    await detail.screenshot({
      path: info.outputPath("human-support-owner-reply.png"),
    });
  } finally {
    await adminContext.close();
  }
  const openOwnReply = async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Профиль", exact: true }).click();
    await page
      .getByRole("button", { name: "Помощь человека", exact: true })
      .last()
      .click();
    await page
      .getByRole("button", {
        name: `Ответы на обращение №${request.id}`,
        exact: true,
      })
      .click();
    const replies = page.getByRole("region", {
      name: `Ответы на обращение №${request.id}`,
      exact: true,
    });
    await expect(replies.getByText(reply, { exact: true })).toBeVisible();
    await expect(replies).toHaveClass(/ym-hide-content/);
    await expect(replies.getByRole("textbox")).toHaveCount(0);
    return replies;
  };
  await openOwnReply();
  const replies = await openOwnReply();
  await replies.screenshot({
    path: info.outputPath("human-support-own-reply.png"),
  });
  const stranger = await browser.newContext({
    baseURL: info.project.use.baseURL,
    extraHTTPHeaders: { "X-Forwarded-For": anonymousIp },
  });
  try {
    expect(
      (
        await stranger.request.get(
          `/api/v1/support-requests/${request.id}/replies`,
          { headers: { "X-Forwarded-For": anonymousIp } },
        )
      ).status(),
    ).toBe(401);
  } finally {
    await stranger.close();
  }
  expect(forbidden).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
