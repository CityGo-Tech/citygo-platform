import { clickWalletAction, openWalletMenu } from "./navigation-helper";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
import { expect, test, type Page } from "@playwright/test";
import type { Dashboard } from "@citygo/contracts";

// All application API traffic is synthetic. No provider, SMS, account or money
// operation from this suite is allowed to reach a real backend.
const phone = "+79990000000";
const proof = "ab".repeat(32);
const challengeId = "a274d301-c0e2-4e4a-b0f4-4bf8a513ff64";
const board: Dashboard = {
  user: { id: "42", email: "phone-test@example.test", role: "user" },
  profile: null,
  quests: [],
  xp: 0,
  thread: null,
  provider: "unconfigured",
  aiAccess: { policy: null, granted: false, dailyLimit: 0 },
};
async function install(page: Page) {
  const state = {
    mode: "required" as "disabled" | "unavailable" | "required",
    status: "eligible" as
      "unavailable" | "email_required" | "eligible" | "granted" | "phone_bound",
    provider: "prosto_sms",
    policies: 0,
    dashboards: 0,
    starts: [] as unknown[],
    resends: [] as unknown[],
    confirms: [] as unknown[],
    unexpected: [] as string[],
    code: "654321",
    ttl: 600_000,
    resendSeconds: 1,
    sendFailure: false,
    invalidReceipt: false,
    confirmConflict: false,
    changeProviderAtStart: false,
    forceStartConflict: false,
    acceptedStarts: 0,
    delayStart: false,
    releaseStart: () => {},
    delivered: Promise.resolve(),
  };
  const gate = new Promise<void>((resolve) => {
    state.releaseStart = resolve;
  });
  let delivered = () => {};
  state.delivered = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const challenge = () => ({
    challengeId,
    proof,
    expiresAt: new Date(Date.now() + state.ttl).toISOString(),
    resendAfterSeconds: state.resendSeconds,
  });
  await page.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
    if (
      route.request().method() === "GET" &&
      new URL(route.request().url()).origin === "http://localhost:3000" &&
      new URL(route.request().url()).pathname ===
        "/api/v1/auth/registration-policy"
    )
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/dashboard") {
      state.dashboards++;
      return route.fulfill({ json: board });
    }
    if (path === "/api/v1/phone-verification/policy") {
      state.policies++;
      return route.fulfill({
        json: {
          phoneVerification: state.mode,
          giftAmountMicros: 500_000_000,
          giftStatus: state.status,
          deliveryProvider: state.mode === "disabled" ? "none" : state.provider,
        },
      });
    }
    if (path === "/api/v1/phone-verification/start") {
      const input = route.request().postDataJSON();
      state.starts.push(input);
      if (state.changeProviderAtStart) {
        state.changeProviderAtStart = false;
        state.provider = "sms_ru";
      }
      if (
        state.forceStartConflict ||
        input.expectedDeliveryProvider !== state.provider
      )
        return route.fulfill({
          status: 409,
          json: { error: "SYNTHETIC_PROVIDER_MISMATCH" },
        });
      state.acceptedStarts++;
      if (state.delayStart) await gate;
      try {
        return await route.fulfill(
          state.sendFailure
            ? { status: 503, json: { error: "SYNTHETIC_PROVIDER_DETAIL" } }
            : { json: challenge() },
        );
      } catch {
        /* Expected for cancelled UI lifetimes. */
      } finally {
        delivered();
      }
      return;
    }
    if (path === "/api/v1/phone-verification/resend") {
      const input = route.request().postDataJSON();
      state.resends.push(input);
      if (input.expectedDeliveryProvider !== state.provider)
        return route.fulfill({
          status: 409,
          json: { error: "SYNTHETIC_PROVIDER_MISMATCH" },
        });
      state.code = "012345";
      return route.fulfill({ json: challenge() });
    }
    if (path === "/api/v1/phone-verification/confirm") {
      const input = route.request().postDataJSON();
      state.confirms.push(input);
      if (state.confirmConflict) {
        state.status = "granted";
        return route.fulfill({
          status: 409,
          json: { error: "SYNTHETIC_CONFLICT" },
        });
      }
      if (input.code !== state.code)
        return route.fulfill({
          status: 400,
          json: { error: "SYNTHETIC_WRONG_CODE" },
        });
      return route.fulfill({
        json: state.invalidReceipt
          ? { accepted: true, mode: "live", simulated: false }
          : {
              operationId: "b274d301-c0e2-4e4a-b0f4-4bf8a513ff64",
              grantedMicros: 500_000_000,
              alreadyGranted: false,
            },
      });
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
  await clickWalletAction(page, "Телефон и подарок");
  await expect(
    page.getByRole("heading", { name: "Подтверждение телефона", exact: true }),
  ).toBeVisible();
}
function panel(page: Page) {
  return page.getByRole("region", {
    name: "Подтверждение телефона",
    exact: true,
  });
}
async function begin(page: Page) {
  await page
    .getByLabel("Российский мобильный номер", { exact: true })
    .fill("8 (999) 000-00-00");
  await page
    .getByRole("checkbox", { name: "Согласен на подтверждение номера по SMS." })
    .check();
  await page
    .getByRole("button", { name: "Получить код по SMS", exact: true })
    .click();
}

test("opening gift checks availability only; disabled mode never sends SMS or invents a bonus", async ({
  page,
}) => {
  const state = await install(page);
  state.mode = "disabled";
  state.status = "unavailable";
  await page.goto("/");
  await openWalletMenu(page);
  await expect(
    page
      .getByRole("region", { name: "Баланс и телефон", exact: true })
      .getByRole("button", { name: "Телефон и подарок", exact: true }),
  ).toBeVisible();
  expect(state.policies).toBe(0);
  await open(page);
  await expect(page.getByRole("status")).toContainText("пока недоступно");
  await expect(
    page.getByLabel("Российский мобильный номер", { exact: true }),
  ).toHaveCount(0);
  expect(state.starts).toEqual([]);
  expect(state.confirms).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("an actively bound phone with a used number gift is a read-only status without SMS or a bonus refresh", async ({
  page,
}, info) => {
  const state = await install(page);
  state.status = "phone_bound";
  await page.goto("/");
  await open(page);
  await expect(panel(page).getByRole("status")).toHaveText(
    "Телефон привязан. Подарок по этому номеру уже использован.",
  );
  await expect(
    panel(page).getByLabel("Российский мобильный номер", { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel(page).getByLabel("Код из SMS", { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel(page).getByRole("button", {
      name: "Получить код по SMS",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(panel(page)).not.toContainText("500");
  await expect(panel(page)).not.toContainText("Начислено");
  await expect(panel(page)).not.toContainText(phone);
  const dashboards = state.dashboards,
    policies = state.policies;
  await panel(page)
    .getByRole("button", { name: "Обновить статус", exact: true })
    .click();
  await expect.poll(() => state.policies).toBe(policies + 1);
  await expect(panel(page).getByRole("status")).toContainText(
    "Телефон привязан",
  );
  expect(state.dashboards).toBe(dashboards);
  expect(state.starts).toEqual([]);
  expect(state.resends).toEqual([]);
  expect(state.confirms).toEqual([]);
  expect(state.unexpected).toEqual([]);
  await panel(page).screenshot({
    path: info.outputPath("phone-contact-bound.png"),
  });
});

test("refresh after an operator contact change removes the old code form without reissuing SMS or claiming a gift", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/");
  await open(page);
  await begin(page);
  await expect(
    panel(page).getByLabel("Код из SMS", { exact: true }),
  ).toBeVisible();
  state.status = "phone_bound";
  const dashboards = state.dashboards;
  await panel(page)
    .getByRole("button", { name: "Обновить статус подарка", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Телефон привязан",
  );
  await expect(
    panel(page).getByLabel("Код из SMS", { exact: true }),
  ).toHaveCount(0);
  await expect(panel(page)).not.toContainText("Начислено");
  expect(state.starts).toHaveLength(1);
  expect(state.resends).toEqual([]);
  expect(state.confirms).toEqual([]);
  expect(state.dashboards).toBe(dashboards);
  expect(state.unexpected).toEqual([]);
});

test("unavailable, email-required and already-granted states offer no SMS or pretend new gift", async ({
  page,
}) => {
  const state = await install(page);
  state.mode = "unavailable";
  state.status = "unavailable";
  await page.goto("/");
  await open(page);
  await expect(page.getByRole("status")).toContainText(
    "Не удалось загрузить подтверждение",
  );
  state.mode = "required";
  state.status = "email_required";
  await page.getByRole("button", { name: "Обновить статус подарка" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Сначала подтвердите электронную почту",
  );
  state.status = "granted";
  await page.getByRole("button", { name: "Обновить статус подарка" }).click();
  await expect(page.getByRole("status")).toContainText("Подарок уже получен");
  await expect(
    page.getByRole("button", { name: "Получить код по SMS" }),
  ).toHaveCount(0);
  expect(state.starts).toEqual([]);
  expect(state.confirms).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("explicit SMS consent, normalization, masked number and strict OTP receipt control the 500-ruble gift", async ({
  page,
}, info) => {
  const state = await install(page);
  await page.clock.install();
  await page.goto("/");
  await open(page);
  const submit = page.getByRole("button", {
    name: "Получить код по SMS",
    exact: true,
  });
  await page
    .getByLabel("Российский мобильный номер", { exact: true })
    .fill("+77010000000");
  await expect(submit).toBeDisabled();
  await page
    .getByLabel("Российский мобильный номер", { exact: true })
    .fill("8 (999) 000-00-00");
  await expect(submit).toBeDisabled();
  expect(state.starts).toEqual([]);
  expect(await panel(page).innerText()).not.toMatch(
    /ProstoSMS|SMS\.ru|×10|резерв/i,
  );
  await panel(page).getByText("Условия подтверждения", { exact: true }).click();
  await expect(panel(page)).toContainText(
    "Для доставки SMS номер и код передаются сервису ProstoSMS",
  );
  await expect(panel(page)).not.toContainText("SMS.ru");
  await panel(page).getByText("Условия подтверждения", { exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Согласен на подтверждение номера по SMS." })
    .check();
  await page.screenshot({
    path: info.outputPath("phone-gift-consent.png"),
    fullPage: true,
  });
  await submit.click();
  await expect(page.getByLabel("Код из SMS", { exact: true })).toBeVisible();
  expect(state.starts).toEqual([
    { phone, expectedDeliveryProvider: "prosto_sms" },
  ]);
  await expect(
    page.getByText("+7 ••• •••-00-00", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Начислено 500 ₽ CityGo.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Подтвердить телефон и получить подарок",
    }),
  ).toBeDisabled();
  await page.getByLabel("Код из SMS", { exact: true }).fill("111111");
  await page
    .getByRole("button", { name: "Подтвердить телефон и получить подарок" })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText("Код не подошёл");
  await expect(page.getByLabel("Код из SMS", { exact: true })).toHaveValue("");
  await page.clock.fastForward(2000);
  expect(state.resends).toEqual([]);
  await page
    .getByRole("button", { name: "Отправить SMS ещё раз", exact: true })
    .click();
  await expect
    .poll(() => state.resends)
    .toEqual([
      { challengeId, proof, phone, expectedDeliveryProvider: "prosto_sms" },
    ]);
  await page.getByLabel("Код из SMS", { exact: true }).fill("012345");
  await page.screenshot({
    path: info.outputPath("phone-gift-otp.png"),
    fullPage: true,
  });
  const dom = await page.locator("body").innerHTML();
  expect(dom).not.toContain(proof);
  expect(dom).not.toContain(challengeId);
  expect(dom).not.toContain(phone);
  const stored = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      url: location.href,
    }),
  );
  expect(stored).not.toContain(proof);
  expect(stored).not.toContain(phone);
  expect(stored).not.toContain("012345");
  await page
    .getByRole("button", { name: "Подтвердить телефон и получить подарок" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Телефон подтверждён. Начислено 500 ₽ CityGo.",
  );
  expect(state.confirms.at(-1)).toEqual({
    challengeId,
    proof,
    phone,
    code: "012345",
  });
  await expect.poll(() => state.dashboards).toBe(2);
  await expect(page.getByLabel("Код из SMS", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("phone-gift-confirmed.png"),
    fullPage: true,
  });
  expect(state.unexpected).toEqual([]);
});

test("a provider delivery acknowledgment is not a gift receipt", async ({
  page,
}) => {
  const state = await install(page);
  state.invalidReceipt = true;
  await page.goto("/");
  await open(page);
  await begin(page);
  await page.getByLabel("Код из SMS", { exact: true }).fill(state.code);
  await page
    .getByRole("button", { name: "Подтвердить телефон и получить подарок" })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "Не удалось подтвердить телефон",
  );
  await expect(
    page.getByText("Начислено 500 ₽ CityGo.", { exact: false }),
  ).toHaveCount(0);
  expect(state.dashboards).toBe(1);
  expect(state.unexpected).toEqual([]);
});

test("expired OTP cannot confirm or resend and reload discards the capability without SMS", async ({
  page,
}) => {
  const state = await install(page);
  state.ttl = 1000;
  await page.clock.install();
  await page.goto("/");
  await open(page);
  await begin(page);
  await expect(page.getByLabel("Код из SMS", { exact: true })).toBeVisible();
  await page.clock.fastForward(2000);
  await expect(page.getByLabel("Код из SMS", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Отправить SMS ещё раз" }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Срок кода истёк");
  await page.reload();
  await open(page);
  await expect(
    page.getByLabel("Российский мобильный номер", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("checkbox", {
      name: "Согласен на подтверждение номера по SMS.",
    }),
  ).not.toBeChecked();
  await expect(page.getByLabel("Код из SMS", { exact: true })).toHaveCount(0);
  expect(state.starts).toHaveLength(1);
  expect(state.resends).toEqual([]);
  expect(state.confirms).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("confirmation conflict enables explicit status refresh and reload without another SMS", async ({
  page,
}) => {
  const state = await install(page);
  state.confirmConflict = true;
  await page.goto("/");
  await open(page);
  await begin(page);
  await page.getByLabel("Код из SMS", { exact: true }).fill(state.code);
  await page
    .getByRole("button", { name: "Подтвердить телефон и получить подарок" })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText("Обновите статус");
  await expect(page.getByLabel("Код из SMS", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Обновить статус подарка" }).click();
  await expect(page.getByRole("status")).toContainText("Подарок уже получен");
  await page.reload();
  await open(page);
  await expect(page.getByRole("status")).toContainText("Подарок уже получен");
  expect(state.starts).toHaveLength(1);
  expect(state.confirms).toHaveLength(1);
  expect(state.resends).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("unknown send failure never automatically retries or displays a grant", async ({
  page,
}) => {
  const state = await install(page);
  state.sendFailure = true;
  await page.clock.install();
  await page.goto("/");
  await open(page);
  await begin(page);
  await expect(panel(page).getByRole("alert")).toContainText(
    "Не удалось подтвердить отправку",
  );
  await expect(panel(page).getByRole("alert")).not.toContainText(
    "SYNTHETIC_PROVIDER_DETAIL",
  );
  await page.clock.fastForward(120_000);
  expect(state.starts).toHaveLength(1);
  expect(state.resends).toEqual([]);
  expect(state.confirms).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Получить код по SMS", exact: true }),
  ).toBeEnabled();
  expect(state.unexpected).toEqual([]);
});

test("cross-tab session invalidation prevents a delayed challenge from restoring phone or OTP", async ({
  page,
}) => {
  const state = await install(page);
  state.delayStart = true;
  await page.goto("/");
  await open(page);
  await begin(page);
  await expect.poll(() => state.starts.length).toBe(1);
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
  state.releaseStart();
  await state.delivered;
  await expect(page.getByLabel("Код из SMS", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Подтверждение телефона" }),
  ).toHaveCount(0);
  expect(state.resends).toEqual([]);
  expect(state.confirms).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("server-selected provider changes reset consent and challenge before any further phone write", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/");
  await open(page);
  await page
    .getByLabel("Российский мобильный номер", { exact: true })
    .fill(phone);
  await page
    .getByRole("checkbox", { name: "Согласен на подтверждение номера по SMS." })
    .check();
  state.provider = "sms_ru";
  await page
    .getByRole("button", { name: "Получить код по SMS", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "Условия подтверждения изменились",
  );
  await expect(
    page.getByRole("checkbox", {
      name: "Согласен на подтверждение номера по SMS.",
    }),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Российский мобильный номер", { exact: true }),
  ).toHaveValue("");
  expect(state.starts).toEqual([]);
  await panel(page).getByText("Условия подтверждения", { exact: true }).click();
  await expect(panel(page)).toContainText("сервису SMS.ru");
  await expect(panel(page)).not.toContainText("ProstoSMS");
  await panel(page).getByText("Условия подтверждения", { exact: true }).click();
  await page
    .getByLabel("Российский мобильный номер", { exact: true })
    .fill(phone);
  await page
    .getByRole("checkbox", { name: "Согласен на подтверждение номера по SMS." })
    .check();
  await page
    .getByRole("button", { name: "Получить код по SMS", exact: true })
    .click();
  await expect(page.getByLabel("Код из SMS", { exact: true })).toBeVisible();
  state.provider = "prosto_sms";
  await page.getByLabel("Код из SMS", { exact: true }).fill(state.code);
  await page
    .getByRole("button", { name: "Подтвердить телефон и получить подарок" })
    .click();
  await expect(page.getByLabel("Код из SMS", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", {
      name: "Согласен на подтверждение номера по SMS.",
    }),
  ).not.toBeChecked();
  await panel(page).getByText("Условия подтверждения", { exact: true }).click();
  await expect(panel(page)).toContainText("сервису ProstoSMS");
  await expect(panel(page)).not.toContainText("SMS.ru");
  expect(state.starts).toEqual([{ phone, expectedDeliveryProvider: "sms_ru" }]);
  expect(state.resends).toEqual([]);
  expect(state.confirms).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("missing or unsupported delivery binding cannot offer consent or SMS", async ({
  page,
}) => {
  const state = await install(page);
  state.provider = "none";
  await page.goto("/");
  await open(page);
  for (const provider of ["none", "unsupported"]) {
    state.provider = provider;
    await page.getByRole("button", { name: "Обновить статус подарка" }).click();
    await expect(panel(page).getByRole("alert")).toContainText(
      "Не удалось подтвердить телефон",
    );
    await expect(panel(page).getByRole("checkbox")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Получить код по SMS", exact: true }),
    ).toHaveCount(0);
  }
  expect(state.starts).toEqual([]);
  expect(state.resends).toEqual([]);
  expect(state.confirms).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("a server mismatch after the policy read rejects the send and reconciles only by explicit status refresh", async ({
  page,
}) => {
  const state = await install(page);
  state.changeProviderAtStart = true;
  await page.goto("/");
  await open(page);
  await begin(page);
  await expect(panel(page).getByRole("alert")).toContainText("Обновите статус");
  expect(state.starts).toEqual([
    { phone, expectedDeliveryProvider: "prosto_sms" },
  ]);
  expect(state.acceptedStarts).toBe(0);
  await expect(panel(page).getByRole("alert")).not.toContainText("использован");
  await expect(page.getByLabel("Код из SMS", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Обновить статус подарка" }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "Согласен на подтверждение номера по SMS.",
    }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Получить код по SMS", exact: true }),
  ).toBeDisabled();
  expect(state.starts).toHaveLength(1);
  await panel(page).getByText("Условия подтверждения", { exact: true }).click();
  await expect(panel(page)).toContainText("сервису SMS.ru");
  await expect(panel(page)).not.toContainText("ProstoSMS");
  await panel(page).getByText("Условия подтверждения", { exact: true }).click();
  state.forceStartConflict = true;
  await page
    .getByLabel("Российский мобильный номер", { exact: true })
    .fill(phone);
  await page
    .getByRole("checkbox", { name: "Согласен на подтверждение номера по SMS." })
    .check();
  await page
    .getByRole("button", { name: "Получить код по SMS", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "Условия подтверждения изменились",
  );
  await expect(panel(page).getByRole("alert")).not.toContainText("использован");
  await page.getByRole("button", { name: "Обновить статус подарка" }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "Согласен на подтверждение номера по SMS.",
    }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Получить код по SMS", exact: true }),
  ).toBeDisabled();
  expect(state.starts).toEqual([
    { phone, expectedDeliveryProvider: "prosto_sms" },
    { phone, expectedDeliveryProvider: "sms_ru" },
  ]);
  expect(state.acceptedStarts).toBe(0);
  expect(state.resends).toEqual([]);
  expect(state.confirms).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
