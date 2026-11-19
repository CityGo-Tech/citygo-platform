import { expect, test, type Page } from "@playwright/test";
import type { BalanceHistoryEntry, Dashboard } from "@citygo/contracts";
import { syntheticProduct } from "./marketing-landing-fixture";

const telegram = {
  provider: "telegram",
  name: "Telegram",
  fragment: "tgWebAppData",
  script: "https://telegram.org/js/telegram-web-app.js?65",
} as const;
const max = {
  provider: "max",
  name: "MAX",
  fragment: "WebAppData",
  script: "https://st.max.ru/js/max-web-app.js",
} as const;
type Host = typeof telegram | typeof max;

const user = {
  id: "101",
  email: "mini-profile@example.test",
  role: "user",
} as const;
const phone = "+79990000000";
const proof = "ab".repeat(32);
const code = "654321";
const challengeId = "a274d301-c0e2-4e4a-b0f4-4bf8a513ff64";
const giftAmount = 500_000_000;
const gift: BalanceHistoryEntry = {
  id: "credit:1",
  kind: "gift",
  direction: "credit",
  amountMicros: giftAmount,
  createdAt: "2026-11-01T09:00:00.000000Z",
};

function accountFixture() {
  return {
    phoneVerified: false,
    entries: [] as BalanceHistoryEntry[],
    confirms: [] as unknown[],
    sends: [] as { endpoint: string; body: unknown }[],
    unexpectedWrites: [] as string[],
    profileReads: 0,
    ttl: 600_000,
    resendAfterSeconds: 60,
    occupiedAt: null as "start" | "confirm" | null,
    loseConfirmResponse: false,
  };
}

async function openProfile(
  page: Page,
  account: ReturnType<typeof accountFixture>,
  host?: Host,
) {
  const state = await syntheticProduct(page);
  const mutations: string[] = [];
  const analytics: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v1/") && request.method() !== "GET")
      mutations.push(url.pathname);
    if (
      url.hostname === "mc.yandex.ru" ||
      url.pathname.startsWith("/api/v1/analytics/")
    )
      analytics.push(request.url() + (request.postData() ?? ""));
  });

  const phonePath = host
    ? "/api/v1/mini-apps/" + host.provider + "/phone-verification/"
    : "/api/v1/phone-verification/";
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    if (pathname.startsWith("/api/v1/analytics/")) return route.fallback();
    if (!state.authenticated) return route.fallback();
    const claimed = account.entries.some((entry) => entry.kind === "gift");
    if (request.method() === "GET") {
      if (pathname === "/api/v1/dashboard") {
        const availableMicros = claimed ? giftAmount : 0;
        const dashboard: Dashboard = {
          user,
          profile: null,
          quests: [],
          xp: 0,
          thread: null,
          provider: "routerai",
          aiAccess: {
            policy: null,
            granted: true,
            dailyLimit: 10,
            credit: {
              currency: "RUB",
              bonusGranted: claimed,
              grantedMicros: availableMicros,
              availableMicros,
              heldMicros: 0,
              spentMicros: 0,
              billingPolicy: "postpay_actual_v1",
              chargingStatus: "routerai_citygo_10x",
              topUpAvailable: true,
              history: [],
            },
          },
        };
        return route.fulfill({ json: dashboard });
      }
      if (pathname === "/api/v1/account/profile") {
        account.profileReads++;
        return route.fulfill({
          json: {
            userId: user.id,
            email: user.email,
            emailVerified: true,
            phoneVerified: account.phoneVerified,
            giftStatus: claimed ? "claimed" : "available",
            emailConfirmation: "available",
          },
        });
      }
      if (pathname === "/api/v1/ai/credit/history")
        return route.fulfill({
          json: {
            userId: user.id,
            filter: url.searchParams.get("filter") ?? "all",
            entries: account.entries,
            nextCursor: null,
          },
        });
      if (pathname === "/api/v1/personal-plan/summary")
        return route.fulfill({
          json: { userId: user.id, total: 0, pending: 0, completed: 0 },
        });
      if (pathname === "/api/v1/personal-plan")
        return route.fulfill({
          json: { userId: user.id, items: [], nextBefore: null },
        });
      if (pathname === phonePath + "policy") {
        const disabled = host?.provider === "max";
        return route.fulfill({
          json: {
            phoneVerification: disabled ? "disabled" : "required",
            deliveryProvider: disabled ? "none" : "prosto_sms",
            giftAmountMicros: giftAmount,
            giftStatus: disabled
              ? "unavailable"
              : claimed
                ? "granted"
                : "eligible",
          },
        });
      }
      return route.fallback();
    }
    if (pathname === phonePath + "start" || pathname === phonePath + "resend") {
      account.sends.push({ endpoint: pathname, body: request.postDataJSON() });
      if (account.occupiedAt === "start")
        return route.fulfill({
          status: 409,
          json: { error: "SYNTHETIC_PRIVATE_OWNER" },
        });
      return route.fulfill({
        json: {
          challengeId,
          proof,
          expiresAt: new Date(Date.now() + account.ttl).toISOString(),
          resendAfterSeconds: account.resendAfterSeconds,
        },
      });
    }
    if (pathname === phonePath + "confirm") {
      const input = request.postDataJSON();
      account.confirms.push(input);
      if (input.code !== code)
        return route.fulfill({
          status: 400,
          json: { error: "SYNTHETIC_WRONG_CODE" },
        });
      if (account.occupiedAt === "confirm")
        return route.fulfill({
          status: 409,
          json: { error: "SYNTHETIC_PRIVATE_OWNER" },
        });
      account.phoneVerified = true;
      if (!claimed) account.entries.push(gift);
      if (account.loseConfirmResponse) return route.abort("connectionreset");
      return route.fulfill({
        json: {
          operationId: "b274d301-c0e2-4e4a-b0f4-4bf8a513ff64",
          grantedMicros: giftAmount,
          alreadyGranted: claimed,
        },
      });
    }
    account.unexpectedWrites.push(pathname);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected test write" },
    });
  });

  if (!host) {
    state.authenticated = true;
    await page.goto("/");
  } else {
    const initData = "synthetic-" + host.provider + "-profile-proof";
    await page.route(host.script, (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `
          const sdk = {
            initData: ${JSON.stringify(initData)},
            openLink() { throw new Error("Unexpected external navigation"); },
          };
          ${host.provider === "telegram" ? "window.Telegram = { WebApp: sdk };" : "window.WebApp = sdk;"}
        `,
      }),
    );
    await page.route(
      "**/api/v1/mini-apps/" + host.provider + "/sign-in",
      (route) => {
        expect(route.request().postDataJSON()).toEqual({ initData });
        state.authenticated = true;
        return route.fulfill({
          json: { user: { id: user.id, email: user.email }, purpose: "guest" },
        });
      },
    );
    await page.goto(
      "/mini/" + host.provider + "#" + host.fragment + "=" + initData,
    );
    await expect(page).toHaveURL(new RegExp("/mini/" + host.provider + "$"));
    await page.getByRole("button", { name: "Войти в CityGo" }).click();
    await page
      .getByRole("button", { name: "Войти через " + host.name })
      .click();
  }
  await page
    .getByRole("navigation", { name: "Личный кабинет CityGo" })
    .getByRole("button", { name: "Профиль", exact: true })
    .click();
  await expect(page.getByText(user.email, { exact: true })).toBeVisible();
  return { mutations, analytics };
}

async function requestCode(page: Page) {
  await page
    .getByRole("button", { name: "Подтвердить телефон", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Подтвердить телефон" }),
  ).toBeVisible();
  const send = page.getByRole("button", { name: "Получить код по SMS" });
  await page.getByLabel("Номер телефона").fill("8 (999) 000-00-00");
  await expect(send).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "Согласен на подтверждение номера по SMS." })
    .check();
  await send.click();
}

async function startPhoneVerification(page: Page) {
  await requestCode(page);
  await expect(page.getByLabel("Код подтверждения")).toBeVisible();
}

const confirm = (page: Page) =>
  page.getByRole("button", { name: "Подтвердить номер", exact: true });

async function checkGiftHistory(page: Page, host?: Host) {
  await expect(
    page.getByText("Телефон подтверждён", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "500 ₽", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("button", {
      name: host ? "Баланс и история операций" : "Баланс и пополнение",
      exact: true,
    })
    .click();
  if (!host)
    await page
      .getByRole("button", { name: "История баланса", exact: true })
      .click();
  const ledger = page.getByRole("region", { name: "История баланса" });
  await expect(ledger.getByText("+500 ₽", { exact: true })).toHaveCount(1);
}

test("Telegram checks a lost confirmation against the shared account used by Web and MAX", async ({
  page,
  browser,
  baseURL,
}) => {
  const account = accountFixture();
  account.loseConfirmResponse = true;
  const { analytics, mutations } = await openProfile(page, account, telegram);
  await expect(
    page.getByText("Телефон не подтверждён", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Правовые документы" }),
  ).toHaveAttribute("href", "/legal");
  await expect(account.sends).toEqual([]);
  await startPhoneVerification(page);
  await expect(
    page.getByRole("button", { name: /^Отправить SMS повторно через/ }),
  ).toBeDisabled();
  await page.getByLabel("Код подтверждения").fill(code);
  await confirm(page).click();
  await expect(
    page.getByRole("button", { name: "Проверить подтверждение" }),
  ).toBeVisible();
  const readsBefore = account.profileReads;
  await page.getByRole("button", { name: "Проверить подтверждение" }).click();
  await expect(
    page.getByText("Телефон подтверждён. Подарок уже был начислен."),
  ).toBeVisible();
  expect(account.profileReads).toBeGreaterThan(readsBefore);
  await page.getByRole("button", { name: "Вернуться в приложение" }).click();
  await checkGiftHistory(page, telegram);

  for (const host of [undefined, max]) {
    const context = await browser.newContext({ baseURL });
    try {
      const otherPage = await context.newPage();
      await openProfile(otherPage, account, host);
      if (host) {
        await expect(
          otherPage.getByRole("button", {
            name: "Подтвердить телефон",
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(otherPage.getByText(/подарок 500 ₽/i)).toHaveCount(0);
      } else {
        await expect(
          otherPage.getByText("Подарок 500 ₽ CityGo уже начислен."),
        ).toBeVisible();
        await otherPage
          .getByRole("button", { name: "Телефон и подарок", exact: true })
          .click();
        await expect(otherPage.getByText("Подарок уже получен.")).toBeVisible();
        await expect(
          otherPage.getByRole("button", { name: "Получить код по SMS" }),
        ).toHaveCount(0);
        await otherPage
          .getByRole("button", { name: "Вернуться в приложение" })
          .click();
      }
      await checkGiftHistory(otherPage, host);
    } finally {
      await context.close();
    }
  }
  expect(account.entries).toEqual([gift]);
  expect(account.sends).toEqual([
    {
      endpoint: "/api/v1/mini-apps/telegram/phone-verification/start",
      body: { phone, expectedDeliveryProvider: "prosto_sms" },
    },
  ]);
  expect(account.confirms).toEqual([{ phone, challengeId, proof, code }]);
  expect(account.unexpectedWrites).toEqual([]);
  expect(mutations).toEqual([
    "/api/v1/mini-apps/telegram/sign-in",
    "/api/v1/mini-apps/telegram/phone-verification/start",
    "/api/v1/mini-apps/telegram/phone-verification/confirm",
  ]);
  expect(analytics.join("\n")).not.toMatch(
    new RegExp(phone.slice(1) + "|" + code),
  );
});

test("Telegram rejects a wrong code and does not submit an expired code", async ({
  page,
}) => {
  const account = accountFixture();
  account.ttl = 10_000;
  await page.clock.install();
  await openProfile(page, account, telegram);
  await startPhoneVerification(page);
  await page.getByLabel("Код подтверждения").fill("123456");
  await confirm(page).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Код не подошёл",
  );
  await page.clock.fastForward(11_000);
  await expect(
    page.getByRole("status").filter({ hasText: "Срок кода истёк" }),
  ).toBeVisible();
  await expect(confirm(page)).toBeDisabled();
  expect(account.sends).toHaveLength(1);
  expect(account.confirms).toEqual([
    { phone, challengeId, proof, code: "123456" },
  ]);
  expect(account.entries).toEqual([]);
  expect(account.phoneVerified).toBe(false);
});

test("a Telegram phone conflict never exposes another account or grants a gift", async ({
  page,
}) => {
  const account = accountFixture();
  account.occupiedAt = "confirm";
  await openProfile(page, account, telegram);
  await startPhoneVerification(page);
  await page.getByLabel("Код подтверждения").fill(code);
  await confirm(page).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    /не удалось подтвердить/i,
  );
  await expect(page.getByText("SYNTHETIC_PRIVATE_OWNER")).toHaveCount(0);
  await page.getByRole("button", { name: "Вернуться в приложение" }).click();
  await expect(
    page.getByText("Телефон не подтверждён", { exact: true }),
  ).toBeVisible();
  expect(account.confirms).toHaveLength(1);
  expect(account.entries).toEqual([]);
  expect(account.phoneVerified).toBe(false);
});

test("an occupied Telegram phone is refused before the code step", async ({
  page,
}) => {
  const account = accountFixture();
  account.occupiedAt = "start";
  await openProfile(page, account, telegram);
  await requestCode(page);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    /не удалось привязать номер/i,
  );
  await expect(page.getByLabel("Код подтверждения")).toHaveCount(0);
  await expect(page.getByText("SYNTHETIC_PRIVATE_OWNER")).toHaveCount(0);
  expect(account.confirms).toEqual([]);
  expect(account.entries).toEqual([]);
  expect(account.phoneVerified).toBe(false);
});

test("MAX shows the account status and a read-only balance while the gift is pending approval", async ({
  page,
}) => {
  const account = accountFixture();
  const { mutations, analytics } = await openProfile(page, account, max);
  await expect(
    page.getByText("Телефон не подтверждён", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/в подарок|подарок 500 ₽/i)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Подтвердить телефон", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Баланс и история операций" }).click();
  await expect(
    page.getByRole("heading", { name: "Баланс CityGo" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "История баланса" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /пополнить|оплатить/i }),
  ).toHaveCount(0);
  expect(account.sends).toEqual([]);
  expect(mutations).toEqual(["/api/v1/mini-apps/max/sign-in"]);
  expect(analytics).toEqual([]);
});
