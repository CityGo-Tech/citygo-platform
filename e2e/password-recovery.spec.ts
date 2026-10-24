import { expect, test, type Page } from "@playwright/test";
import type { Dashboard, PasswordRecoveryChallenge } from "@citygo/contracts";
const user = { id: "synthetic-new-owner", email: "new-owner@example.test" };
const board: Dashboard = {
  user,
  profile: null,
  quests: [],
  xp: 0,
  thread: null,
  provider: "unconfigured",
  aiAccess: { policy: null, granted: false, dailyLimit: 0 },
};
async function install(page: Page) {
  const state = {
    policy: "available" as "available" | "unavailable",
    ttl: 600_000,
    expiresAt: "",
    authenticated: false,
    code: "654321",
    requests: [] as unknown[],
    resends: [] as unknown[],
    confirms: [] as unknown[],
    unexpected: [] as string[],
    delay: "" as "" | "begin" | "confirm",
    release: () => {},
  };
  const gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  const challenge = (): PasswordRecoveryChallenge => ({
    challengeId: "123e4567-e89b-42d3-a456-426614174001",
    proof: "1".repeat(64),
    expiresAt: state.expiresAt,
    resendAfterSeconds: 60,
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/dashboard")
      return route.fulfill({
        status: state.authenticated ? 200 : 401,
        json: state.authenticated ? board : { error: "Войдите в аккаунт" },
      });
    if (path === "/api/v1/auth/password-recovery-policy")
      return route.fulfill({ json: { passwordRecovery: state.policy } });
    if (path === "/api/v1/auth/password-recovery/request") {
      state.requests.push(route.request().postDataJSON());
      state.expiresAt = new Date(Date.now() + state.ttl).toISOString();
      if (state.delay === "begin") await gate;
      try {
        return await route.fulfill({ json: challenge() });
      } catch {
        return;
      }
    }
    if (path === "/api/v1/auth/password-recovery/resend") {
      state.resends.push(route.request().postDataJSON());
      state.code = "012345";
      return route.fulfill({ json: challenge() });
    }
    if (path === "/api/v1/auth/password-recovery/confirm") {
      const data = route.request().postDataJSON();
      state.confirms.push(data);
      if (state.delay === "confirm") await gate;
      try {
        return await route.fulfill({
          status: data.code === state.code ? 200 : 400,
          json:
            data.code === state.code
              ? { passwordReset: true, sessionsRevoked: true }
              : { error: "Код не подошёл" },
        });
      } catch {
        return;
      }
    }
    if (path === "/api/v1/auth/login") {
      state.authenticated = true;
      return route.fulfill({ json: { user } });
    }
    state.unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  return state;
}
async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Не помню пароль", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Восстановить доступ" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Отправить код", exact: true }),
  ).toBeEnabled();
}
async function begin(page: Page, email = "verified@example.test") {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "Отправить код", exact: true })
    .click();
  await expect(page.getByLabel("Код из письма", { exact: true })).toBeVisible();
}
async function fillConfirm(page: Page, code: string, password = " аа!  ") {
  await page.getByLabel("Код из письма", { exact: true }).fill(code);
  await page.getByLabel("Новый пароль", { exact: true }).fill(password);
  await page
    .getByLabel("Повторите новый пароль", { exact: true })
    .fill(password);
}
test("Figma recovery uses generic confirmation,60s resend, opaque passwords and returns to login without automatic session", async ({
  page,
}, info) => {
  await page.clock.install();
  const state = await install(page);
  await open(page);
  const geometry = await page.evaluate(() => {
    const symbol = document.querySelector(".citygo-brand-symbol")!;
    const wordmark = document.querySelector(".citygo-brand-wordmark")!;
    const heading = document.querySelector("#recovery-heading")!;
    const card = heading.closest("section")!;
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    return {
      symbol: rect(symbol),
      wordmark: rect(wordmark),
      card: rect(card),
      symbolAsset: getComputedStyle(symbol).backgroundImage,
      wordmarkAsset: getComputedStyle(wordmark).backgroundImage,
      heading: {
        ...rect(heading),
        fontSize: getComputedStyle(heading).fontSize,
      },
      headerHeight: document.querySelector(".topbar")!.getBoundingClientRect()
        .height,
      fieldLabelSize: getComputedStyle(
        document.querySelector("label.cg-field")!,
      ).fontSize,
    };
  });
  expect(geometry.symbol.width).toBeCloseTo(52, 1);
  expect(geometry.symbol.height).toBeCloseTo(36.63, 1);
  expect(geometry.wordmark.width).toBeCloseTo(128.65, 1);
  expect(geometry.wordmark.height).toBeCloseTo(40, 1);
  expect(geometry.symbolAsset).toContain("/figma/citygo-original-logo.png");
  expect(geometry.wordmarkAsset).toContain("/figma/citygo-original-logo.png");
  expect(geometry.fieldLabelSize).toBe("12px");
  const logoResponse = await page.request.get(
    "/figma/citygo-original-logo.png",
  );
  expect(logoResponse.ok()).toBe(true);
  expect((await logoResponse.body()).length).toBeGreaterThan(0);
  if (info.project.name === "desktop") {
    expect(geometry.card.width).toBeCloseTo(816, 0);
    expect(geometry.headerHeight).toBe(80);
    expect(geometry.heading.fontSize).toBe("32px");
  } else {
    expect(geometry.headerHeight).toBe(72);
    expect(geometry.heading.x).toBeCloseTo(16, 0);
    expect(geometry.heading.fontSize).toBe("28px");
  }
  await page.screenshot({
    path: info.outputPath("figma-password-recovery.png"),
    fullPage: true,
  });
  await begin(page);
  expect(state.requests).toEqual([{ email: "verified@example.test" }]);
  await expect(
    page
      .getByText(/Если аккаунт с этой подтверждённой почтой существует/)
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Отправить повторно через/ }),
  ).toBeDisabled();
  await page.clock.fastForward(60_000);
  await page
    .getByRole("button", { name: "Отправить код повторно", exact: true })
    .click();
  expect(state.resends).toEqual([
    {
      challengeId: "123e4567-e89b-42d3-a456-426614174001",
      proof: "1".repeat(64),
    },
  ]);
  await fillConfirm(page, "654321");
  await page.getByRole("button", { name: "Сохранить новый пароль" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Не удалось изменить пароль",
  );
  await expect(page.getByLabel("Новый пароль", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("Код из письма", { exact: true })).toHaveValue(
    "",
  );
  await fillConfirm(page, "012345");
  await page.screenshot({
    path: info.outputPath("figma-password-recovery-confirm.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Сохранить новый пароль" }).click();
  await expect(
    page.getByRole("heading", { name: "С возвращением", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Все прежние сессии завершены",
  );
  expect(state.authenticated).toBe(false);
  expect(state.confirms.at(-1)).toEqual({
    challengeId: "123e4567-e89b-42d3-a456-426614174001",
    proof: "1".repeat(64),
    code: "012345",
    newPassword: " аа!  ",
  });
  const stored = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(stored).not.toContain("1".repeat(64));
  expect(stored).not.toContain(" аа!  ");
  expect(stored).not.toContain("012345");
  expect(state.unexpected).toEqual([]);
});
test("unavailable recovery fails closed; no legacy registration or email request", async ({
  page,
}) => {
  const state = await install(page);
  state.policy = "unavailable";
  await page.goto("/");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: "Не помню пароль" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Восстановление временно недоступно",
  );
  await expect(
    page.getByRole("button", { name: "Отправить код", exact: true }),
  ).toBeDisabled();
  expect(state.requests).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
test("expiry and cross-tab invalidation discard code, password and pending proof", async ({
  page,
}) => {
  await page.clock.install();
  const state = await install(page);
  state.ttl = 1_000;
  await open(page);
  await begin(page);
  await fillConfirm(page, "654321");
  await page.clock.fastForward(2_000);
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Срок кода истёк");
  await expect(page.getByLabel("Код из письма", { exact: true })).toHaveCount(
    0,
  );
  state.ttl = 600_000;
  await begin(page);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("citygo-session-changed")),
  );
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Новый пароль", { exact: true })).toHaveCount(0);
  expect(state.confirms).toEqual([]);
});
test("late begin cannot restore a proof after leaving recovery", async ({
  page,
}) => {
  const state = await install(page);
  state.delay = "begin";
  await open(page);
  await page.getByLabel("Email", { exact: true }).fill("unknown@example.test");
  await page
    .getByRole("button", { name: "Отправить код", exact: true })
    .click();
  await expect.poll(() => state.requests.length).toBe(1);
  await page.getByRole("button", { name: "← Назад", exact: true }).click();
  state.release();
  await expect(
    page.getByRole("heading", { name: "С возвращением", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Код из письма", { exact: true })).toHaveCount(
    0,
  );
  expect(state.confirms).toEqual([]);
});
test("late confirm cannot clear a different newly signed-in owner", async ({
  page,
}) => {
  const state = await install(page);
  state.delay = "confirm";
  await open(page);
  await begin(page);
  await fillConfirm(page, "654321");
  await page.getByRole("button", { name: "Сохранить новый пароль" }).click();
  await expect.poll(() => state.confirms.length).toBe(1);
  await page.getByRole("button", { name: "← Назад", exact: true }).click();
  await page
    .getByLabel("Логин или электронная почта", { exact: true })
    .fill(user.email);
  await page.getByLabel("Пароль", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  state.release();
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Пароль изменён. Все прежние сессии завершены. Войдите с новым паролем.",
    ),
  ).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
});
