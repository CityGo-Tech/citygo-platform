import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { AccountProfile, Dashboard } from "@citygo/contracts";
import { syntheticConsentPolicy } from "./service-consent-fixture";

const challengeId = "e87ee322-c594-4dda-aedf-ce454d2f0001";
const proof = "ab".repeat(32);
const panel = (page: Page) =>
  page.getByRole("region", { name: "Личный кабинет", exact: true });
async function openProfile(page: Page) {
  await page
    .getByRole("navigation", { name: "Личный кабинет CityGo" })
    .getByRole("button", { name: "Профиль", exact: true })
    .click();
  await expect(panel(page)).toBeVisible();
}

/** Every request is synthetic, with external destinations and side effects rejected. */
async function fixture(context: BrowserContext) {
  const state = {
    owner: "101",
    authenticated: true,
    verified: false,
    phoneVerified: false,
    giftStatus: "available" as AccountProfile["giftStatus"],
    email: "legacy@example.test" as string | null,
    emailConfirmation: "available" as AccountProfile["emailConfirmation"],
    consentRequired: false,
    reads: 0,
    requests: 0,
    resends: [] as unknown[],
    confirmations: [] as unknown[],
    profileFailure: 0,
    holdRead: false,
    holdRequest: false,
    holdConfirm: false,
    loseConfirmationReceipt: false,
    rejectUsedCode: false,
    releaseRead: () => {},
    releaseRequest: () => {},
    releaseConfirm: () => {},
    external: 0,
    unexpected: [] as string[],
    now: Date.now(),
  };
  const readGate = new Promise<void>((resolve) => {
    state.releaseRead = resolve;
  });
  const requestGate = new Promise<void>((resolve) => {
    state.releaseRequest = resolve;
  });
  const confirmGate = new Promise<void>((resolve) => {
    state.releaseConfirm = resolve;
  });
  const challenge = () => ({
    challengeId,
    proof,
    expiresAt: new Date(state.now + 1_200_000).toISOString(),
    resendAfterSeconds: 60,
  });
  const profile = (): AccountProfile => ({
    userId: state.owner,
    email: state.email,
    emailVerified: state.verified,
    phoneVerified: state.phoneVerified,
    giftStatus: state.giftStatus,
    emailConfirmation: state.emailConfirmation,
  });
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: state.email ?? "admin@citygo.invalid",
      username: state.email ? null : "admin",
      role: "user",
      mustChangePassword: false,
      serviceConsentRequired: state.consentRequired,
    },
    profile: null,
    quests: [],
    xp: 0,
    thread: null,
    provider: "unconfigured",
    aiAccess: {
      policy: null,
      granted: false,
      dailyLimit: 0,
      credit: {
        currency: "RUB",
        bonusGranted: true,
        grantedMicros: 500_000_000,
        availableMicros: 123_000_000,
        heldMicros: 0,
        spentMicros: 377_000_000,
        reservationMode: "fixed5_overdraft",
        minimumRequestBalanceMicros: 5_000_000,
        outstandingDebtMicros: 0,
        chargingStatus: "routerai_citygo_10x",
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
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    if (path === "/api/v1/auth/registration-policy" && method === "GET")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/auth/logout" && method === "POST") {
      state.authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/v1/auth/login" && method === "POST") {
      state.authenticated = true;
      state.owner = "202";
      state.email = "second@example.test";
      state.verified = true;
      return route.fulfill({ json: { user: board().user } });
    }
    if (!state.authenticated)
      return route.fulfill({
        status: 401,
        json: { error: "Synthetic signed-out session" },
      });
    if (path === "/api/v1/dashboard" && method === "GET")
      return route.fulfill({ json: board() });
    if (path === "/api/v1/account/consents" && method === "GET")
      return route.fulfill({
        json: {
          policy: syntheticConsentPolicy,
          personalDataGranted: !state.consentRequired,
          marketingGranted: false,
          serviceConsentRequired: state.consentRequired,
        },
      });
    if (path === "/api/v1/account/profile" && method === "GET") {
      state.reads++;
      const captured = profile();
      if (state.profileFailure) {
        const status = state.profileFailure;
        state.profileFailure = 0;
        return route.fulfill({
          status,
          json: { error: "PRIVATE provider or consent diagnostics" },
        });
      }
      if (state.holdRead && captured.userId === "101") await readGate;
      try {
        await route.fulfill({ json: captured });
      } catch {
        /* request aborted on account lifetime change */
      }
      return;
    }
    if (path === "/api/v1/account/email/verification" && method === "POST") {
      state.requests++;
      expect(request.postDataJSON()).toEqual({});
      if (state.holdRequest) await requestGate;
      try {
        await route.fulfill({ json: challenge() });
      } catch {
        /* view closed */
      }
      return;
    }
    if (
      path === "/api/v1/account/email/verification/resend" &&
      method === "POST"
    ) {
      const value = request.postDataJSON();
      state.resends.push(value);
      expect(value).toEqual({ challengeId, proof });
      return route.fulfill({ json: challenge() });
    }
    if (
      path === "/api/v1/account/email/verification/confirm" &&
      method === "POST"
    ) {
      const value = request.postDataJSON() as { code: string };
      state.confirmations.push(value);
      const owner = state.owner;
      if (value.code !== "123456")
        return route.fulfill({
          status: 400,
          json: { error: "PRIVATE code or mail delivery details" },
        });
      if (state.rejectUsedCode && state.verified)
        return route.fulfill({
          status: 400,
          json: { error: "Synthetic already consumed code" },
        });
      if (state.holdConfirm) await confirmGate;
      if (state.owner === owner && state.authenticated) state.verified = true;
      if (state.loseConfirmationReceipt) {
        state.loseConfirmationReceipt = false;
        state.rejectUsedCode = true;
        return route.fulfill({
          status: 502,
          json: {
            error: "Synthetic receipt lost after committed confirmation",
          },
        });
      }
      try {
        await route.fulfill({ json: { userId: owner, emailVerified: true } });
      } catch {
        /* stale confirmation is aborted */
      }
      return;
    }
    if (path === "/api/v1/phone-verification/policy" && method === "GET")
      return route.fulfill({
        json: {
          phoneVerification: "required",
          giftAmountMicros: 500_000_000,
          giftStatus: "eligible",
          deliveryProvider: "prosto_sms",
        },
      });
    if (path === "/api/v1/messages/favorites" && method === "GET")
      return route.fulfill({
        json: { userId: state.owner, messages: [], nextBefore: null },
      });
    state.unexpected.push(method + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic profile request" },
    });
  });
  return state;
}

test("profile shows true contact status and balance, with no automatic emails or provider details", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  state.giftStatus = "claimed";
  await page.goto("/");
  await openProfile(page);
  await expect(panel(page)).toContainText("legacy@example.test");
  await expect(panel(page)).toContainText("Email не подтверждён");
  await expect(panel(page)).toContainText("Телефон не подтверждён");
  await expect(panel(page)).toContainText("Подарок 500 ₽ CityGo уже начислен");
  await expect(
    panel(page).getByRole("heading", { name: "123 ₽", exact: true }),
  ).toBeVisible();
  expect(state.requests).toBe(0);
  expect(state.reads).toBe(1);
  await expect(panel(page)).not.toContainText(
    /RouterAI|DeepSeek|ЮKassa|ProstoSMS|резерв|×10|модель/,
  );
  await panel(page).screenshot({
    path: info.outputPath("account-profile-status.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await panel(page)
    .getByRole("button", { name: "Баланс и пополнение", exact: true })
    .click();
  await expect(page.getByLabel("Сумма пополнения")).toBeVisible();
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("explicit email code handles wrong code, resend cooldown and confirmation after reload", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  await page.clock.install({ time: new Date(state.now) });
  await page.goto("/");
  await openProfile(page);
  await panel(page)
    .getByRole("button", { name: "Подтвердить email", exact: true })
    .click();
  await expect(
    panel(page).getByLabel("Код из письма", { exact: true }),
  ).toBeVisible();
  expect(state.requests).toBe(1);
  const resend = panel(page).getByRole("button", {
    name: /Отправить повторно через/,
  });
  await expect(resend).toBeDisabled();
  await panel(page).getByLabel("Код из письма", { exact: true }).fill("000000");
  await panel(page)
    .getByRole("button", { name: "Подтвердить email", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText("Код не подошёл");
  await expect(panel(page)).not.toContainText("PRIVATE");
  await expect(
    panel(page).getByLabel("Код из письма", { exact: true }),
  ).toHaveValue("");
  await page.clock.fastForward(61_000);
  await panel(page)
    .getByRole("button", { name: "Отправить код повторно", exact: true })
    .click();
  await expect.poll(() => state.resends.length).toBe(1);
  expect(state.resends).toEqual([{ challengeId, proof }]);
  await panel(page).getByLabel("Код из письма", { exact: true }).fill("123456");
  await panel(page)
    .getByRole("button", { name: "Подтвердить email", exact: true })
    .click();
  await expect(panel(page)).toContainText("Email подтверждён");
  await expect(
    panel(page).getByLabel("Код из письма", { exact: true }),
  ).toHaveCount(0);
  await panel(page).screenshot({
    path: info.outputPath("account-profile-confirmed.png"),
  });
  await page.reload();
  await openProfile(page);
  await expect(panel(page)).toContainText("Email подтверждён");
  expect(state.requests).toBe(1);
  expect(state.confirmations).toHaveLength(2);
  expect(
    await page.evaluate(
      () =>
        JSON.stringify({ ...localStorage }) +
        JSON.stringify({ ...sessionStorage }),
    ),
  ).not.toContain(proof);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
});

test("lost committed confirmation recovers by reading status without another letter", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.loseConfirmationReceipt = true;
  await page.goto("/");
  await openProfile(page);
  await panel(page)
    .getByRole("button", { name: "Подтвердить email", exact: true })
    .click();
  await panel(page).getByLabel("Код из письма", { exact: true }).fill("123456");
  await panel(page)
    .getByRole("button", { name: "Подтвердить email", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "Не удалось подтвердить email",
  );
  await panel(page).getByLabel("Код из письма", { exact: true }).fill("123456");
  await panel(page)
    .getByRole("button", { name: "Подтвердить email", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText("Код не подошёл");
  await panel(page)
    .getByRole("button", { name: "Обновить статус профиля", exact: true })
    .click();
  await expect(panel(page)).toContainText("Email подтверждён");
  await expect(
    panel(page).getByLabel("Код из письма", { exact: true }),
  ).toHaveCount(0);
  expect(state.requests).toBe(1);
  expect(state.resends).toEqual([]);
  expect(state.confirmations).toHaveLength(2);
  expect(state.reads).toBe(2);
  expect(state.unexpected).toEqual([]);
});

test("nullable bootstrap contact shows no fake email or verification action", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.email = null;
  state.emailConfirmation = "unavailable";
  state.giftStatus = "unavailable";
  await page.goto("/");
  await openProfile(page);
  await expect(panel(page)).toContainText("Почта не указана");
  await expect(panel(page)).not.toContainText("admin@citygo.invalid");
  await expect(
    panel(page).getByRole("button", { name: "Подтвердить email", exact: true }),
  ).toHaveCount(0);
  expect(state.requests).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("profile read failure is retryable and consent/access denial closes private profile", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.profileFailure = 503;
  await page.goto("/");
  await openProfile(page);
  await expect(panel(page).getByRole("alert")).toContainText(
    "Не удалось загрузить профиль",
  );
  await expect(panel(page)).not.toContainText("PRIVATE");
  await panel(page)
    .getByRole("button", { name: "Обновить статус профиля", exact: true })
    .click();
  await expect(panel(page)).toContainText("legacy@example.test");
  state.profileFailure = 403;
  await page.getByRole("button", { name: "Диалоги", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Личный кабинет CityGo" })
    .getByRole("button", { name: "Профиль", exact: true })
    .click();
  await expect(panel(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeVisible();
  expect(state.requests).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("late profile read cannot expose old contacts after logout or overwrite another account", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.holdRead = true;
  await page.goto("/");
  await openProfile(page);
  await expect.poll(() => state.reads).toBe(1);
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await page
    .getByRole("button", { name: "Уже есть аккаунт? Войти", exact: true })
    .click();
  await page
    .getByLabel("Логин или электронная почта", { exact: true })
    .fill("second@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await openProfile(page);
  await expect(panel(page)).toContainText("second@example.test");
  state.releaseRead();
  await expect(panel(page)).not.toContainText("legacy@example.test");
  await expect(panel(page)).toContainText("Email подтверждён");
  expect(state.requests).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("late confirmation is discarded after logout and never creates an authenticated view", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.holdConfirm = true;
  await page.goto("/");
  await openProfile(page);
  await panel(page)
    .getByRole("button", { name: "Подтвердить email", exact: true })
    .click();
  await panel(page).getByLabel("Код из письма", { exact: true }).fill("123456");
  await panel(page)
    .getByRole("button", { name: "Подтвердить email", exact: true })
    .click();
  await expect.poll(() => state.confirmations.length).toBe(1);
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  state.releaseConfirm();
  await expect(panel(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeVisible();
  expect(state.reads).toBe(1);
  expect(state.unexpected).toEqual([]);
});

test("current required consent gate blocks profile and every email operation", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.consentRequired = true;
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Согласие для работы сервиса",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Профиль", exact: true }),
  ).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  expect(state.reads).toBe(0);
  expect(state.requests).toBe(0);
  expect(state.confirmations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
