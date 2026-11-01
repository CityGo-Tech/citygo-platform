import { expect, test, type BrowserContext } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";

// Public deterministic sessions seeded solely by NODE_ENV=test in-memory API.
const cookie = (name: string) => ({
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
async function session(context: BrowserContext, name: string) {
  await context.addCookies([cookie(name)]);
  await context.route("https://**", (route) => route.abort());
}
test("an explicit human question is saved without AI or payment and the real admin can close it", async ({
  page,
  context,
  browser,
}, info) => {
  test.setTimeout(90_000);
  await session(context, "other");
  const forbidden: string[] = [];
  page.on("request", (req) => {
    if (
      /\/threads\/\d+\/messages|\/payments\//.test(req.url()) &&
      req.method() !== "GET"
    )
      forbidden.push(req.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  await page
    .getByRole("button", { name: "Помощь человека", exact: true })
    .last()
    .click();
  const panel = page.getByRole("region", {
    name: "Можно обратиться к человеку",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(
    "Оставьте вопрос владельцу CityGo. Обращение бесплатно.",
  );
  await panel
    .getByRole("textbox", { name: "Ваш вопрос" })
    .fill("😀".repeat(10));
  await expect(
    panel.getByRole("button", { name: "Отправить обращение", exact: true }),
  ).toBeDisabled();
  await expect(panel).toContainText("Сейчас 10");
  const question = `Помогите выбрать первый шаг переезда. ${info.project.name} ${randomUUID()}`;
  await expect(panel.getByRole("textbox", { name: "Ваш вопрос" })).toHaveClass(
    /ym-hide-content/,
  );
  await panel.getByRole("textbox", { name: "Ваш вопрос" }).fill(question);
  await panel.screenshot({ path: info.outputPath("human-support-form.png") });
  await panel
    .getByRole("button", { name: "Отправить обращение", exact: true })
    .click();
  const saved = page.getByRole("region", {
    name: "Обращение сохранено",
    exact: true,
  });
  await expect(saved).toBeVisible();
  await expect(saved.getByRole("status")).toContainText(
    /Обращение №\d+ сохранено/,
  );
  await expect(saved.getByRole("status").locator("time")).toHaveAttribute(
    "datetime",
    /^\d{4}-/,
  );
  await expect(saved.getByRole("textbox")).toHaveCount(0);
  const list = await (
    await context.request.get("/api/v1/support-requests")
  ).json();
  const record = list.requests.find(
    (r: { body: string }) => r.body === question,
  );
  expect(record).toBeTruthy();
  await saved.screenshot({ path: info.outputPath("human-support-saved.png") });
  const adminContext = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  await session(adminContext, "admin");
  const admin = await adminContext.newPage();
  try {
    await admin.goto("/admin");
    await admin
      .getByRole("button", { name: "Обновить сводку", exact: true })
      .click();
    const inbox = admin.getByRole("region", {
      name: "Обращения к человеку",
      exact: true,
    });
    await expect(inbox).toBeVisible();
    await inbox
      .getByRole("button", {
        name: "Обновить обращения пользователей",
        exact: true,
      })
      .click();
    await expect(inbox).toContainText(question);
    await expect(inbox).toHaveClass(/ym-hide-content/);
    await inbox
      .getByRole("button", {
        name: `Открыть обращение №${record.id}`,
        exact: true,
      })
      .click();
    const detail = inbox.getByRole("region", {
      name: `Карточка обращения №${record.id}`,
      exact: true,
    });
    await expect(detail).toContainText(question);
    await detail
      .getByRole("button", { name: "Закрыть обращение", exact: true })
      .click();
    await expect(detail).toContainText("Статус: Закрыто");
  } finally {
    await adminContext.close();
  }
  await saved
    .getByRole("button", { name: "Обновить обращения", exact: true })
    .click();
  await expect(saved.getByRole("status")).toContainText("Закрыто");
  await expect(
    saved.getByRole("list").getByText(`Обращение №${record.id} · Закрыто`, {
      exact: true,
    }),
  ).toBeVisible();
  expect(forbidden).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
