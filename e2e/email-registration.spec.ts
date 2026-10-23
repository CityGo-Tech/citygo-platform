import { expect, test, type Page } from "@playwright/test";
import type { Dashboard, EmailRegistrationChallenge } from "@citygo/contracts";

const user = {
  id: "42",
  email: "verified@example.test",
  role: "user" as const,
};
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
    policy: "required" as "required" | "disabled" | "unavailable",
    authenticated: false,
    ttl: 600_000,
    resendSeconds: 1,
    code: "654321",
    begin: [] as unknown[],
    resend: [] as unknown[],
    confirm: [] as unknown[],
    legacy: [] as unknown[],
    unexpected: [] as string[],
    delayBegin: false,
    releaseBegin: () => {},
    beginDelivered: Promise.resolve(),
  };
  const gate = new Promise<void>((resolve) => {
    state.releaseBegin = resolve;
  });
  let delivered = () => {};
  state.beginDelivered = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const challenge = (): EmailRegistrationChallenge => ({
    challengeId: "123e4567-e89b-42d3-a456-426614174001",
    proof: "1".repeat(64),
    expiresAt: new Date(Date.now() + state.ttl).toISOString(),
    resendAfterSeconds: state.resendSeconds,
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/dashboard")
      return route.fulfill({
        status: state.authenticated ? 200 : 401,
        json: state.authenticated ? board : { error: "Войдите в аккаунт" },
      });
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({ json: { emailVerification: state.policy } });
    if (path === "/api/v1/auth/email/register") {
      state.begin.push(route.request().postDataJSON());
      if (state.delayBegin) await gate;
      try {
        return await route.fulfill({ json: challenge() });
      } catch {
        // Cancellation is expected when the registration lifetime has ended.
      } finally {
        delivered();
      }
      return;
    }
    if (path === "/api/v1/auth/email/resend") {
      state.resend.push(route.request().postDataJSON());
      // Match the real API: identity/proof stay stable; only OTP/TTL renew.
      state.code = "012345";
      return route.fulfill({ json: challenge() });
    }
    if (path === "/api/v1/auth/email/confirm") {
      const input = route.request().postDataJSON();
      state.confirm.push(input);
      if (input.code !== state.code)
        return route.fulfill({
          status: 400,
          json: { error: "Код не подошёл" },
        });
      state.authenticated = true;
      return route.fulfill({ json: { user } });
    }
    if (path === "/api/v1/auth/register") {
      state.legacy.push(route.request().postDataJSON());
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

async function begin(page: Page, password = "123456") {
  await page.getByLabel("Электронная почта", { exact: true }).fill(user.email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
}

test("real confirmation UI requires a code; resend replaces OTP while preserving challenge identity before creating a session", async ({
  page,
}, info) => {
  const state = await install(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Сохраните свой путь" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("figma-registration.png"),
    fullPage: true,
  });
  await begin(page);
  await expect(
    page.getByRole("heading", { name: "Проверьте почту" }),
  ).toBeVisible();
  await expect(page.getByLabel("Пароль", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Подтвердить email" }),
  ).toBeDisabled();
  expect(state.begin).toEqual([{ email: user.email, password: "123456" }]);
  expect(state.legacy).toEqual([]);
  expect(state.authenticated).toBe(false);
  await page.screenshot({
    path: info.outputPath("figma-email-confirmation.png"),
    fullPage: true,
  });
  await page.getByLabel("Код из письма", { exact: true }).fill("111111");
  await page.getByRole("button", { name: "Подтвердить email" }).click();
  await expect(page.locator(".alert[role=alert]")).toContainText(
    "Код не подошёл",
  );
  await expect(page.getByLabel("Код из письма", { exact: true })).toHaveValue(
    "",
  );
  const resend = page.getByRole("button", {
    name: "Не пришло письмо? Отправить ещё раз",
  });
  await expect(resend).toBeEnabled();
  await resend.click();
  await expect(page.getByRole("status").first()).toContainText(
    "Новый код отправлен",
  );
  expect(state.resend).toEqual([
    {
      challengeId: "123e4567-e89b-42d3-a456-426614174001",
      proof: "1".repeat(64),
    },
  ]);
  const stored = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(stored).not.toContain("1".repeat(64));
  expect(stored).not.toContain("123456");
  await page.getByLabel("Код из письма", { exact: true }).fill("654321");
  await page.getByRole("button", { name: "Подтвердить email" }).click();
  await expect(page.locator(".alert[role=alert]")).toContainText(
    "Код не подошёл",
  );
  expect(state.authenticated).toBe(false);
  await page.getByLabel("Код из письма", { exact: true }).fill("012345");
  await page.getByRole("button", { name: "Подтвердить email" }).click();
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  expect(state.confirm.at(-1)).toEqual({
    challengeId: "123e4567-e89b-42d3-a456-426614174001",
    proof: "1".repeat(64),
    code: "012345",
  });
  expect(state.legacy).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("unavailable email delivery never falls back to legacy registration; disabled mode preserves six opaque characters", async ({
  page,
}) => {
  const state = await install(page);
  state.policy = "unavailable";
  await page.goto("/");
  await begin(page);
  await expect(page.locator(".alert[role=alert]")).toContainText(
    "отправка писем ещё не подключена",
  );
  await expect(page.getByLabel("Пароль", { exact: true })).toHaveValue("");
  expect(state.begin).toEqual([]);
  expect(state.legacy).toEqual([]);
  state.policy = "disabled";
  await begin(page, " аа!  ");
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  expect(state.legacy).toEqual([{ email: user.email, password: " аа!  " }]);
  expect(state.unexpected).toEqual([]);
});

test("switching to login cancels a delayed registration and cannot restore its pending proof", async ({
  page,
}) => {
  const state = await install(page);
  state.delayBegin = true;
  await page.goto("/");
  await begin(page);
  await expect.poll(() => state.begin.length).toBe(1);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "С возвращением", exact: true }),
  ).toBeVisible();
  state.releaseBegin();
  await state.beginDelivered;
  await expect(
    page.getByRole("heading", { name: "Проверьте почту" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Пароль", { exact: true })).toHaveValue("");
  expect(state.confirm).toEqual([]);
  expect(state.legacy).toEqual([]);
});

test("expired code and cross-tab invalidation cannot keep a confirmation form alive", async ({
  page,
}) => {
  const state = await install(page);
  state.ttl = 1000;
  await page.clock.install();
  await page.goto("/");
  await begin(page);
  await expect(
    page.getByRole("heading", { name: "Проверьте почту" }),
  ).toBeVisible();
  await page.clock.fastForward(2000);
  await expect(
    page.getByLabel("Код из письма", { exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toContainText(
    "Срок подтверждения истёк",
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "citygo-session-changed",
        newValue: "synthetic-change",
      }),
    ),
  );
  await expect(
    page.getByRole("heading", { name: "Сохраните свой путь" }),
  ).toBeVisible();
  await expect(page.getByLabel("Пароль", { exact: true })).toHaveValue("");
  expect(state.confirm).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
