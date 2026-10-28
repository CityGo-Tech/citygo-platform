import { expect, test, type Page } from "@playwright/test";
import {
  customerInteractionInputSchema,
  type CustomerInteractionName,
} from "../packages/contracts/src/admin-customer-observability";
import type { Dashboard } from "@citygo/contracts";
import { syntheticConsentPolicy } from "./service-consent-fixture";

/** All app data are synthetic; every outside destination is rejected. */
async function install(page: Page, role: "user" | "admin" = "user") {
  const state = {
    events: [] as CustomerInteractionName[],
    unexpected: [] as string[],
    outside: [] as string[],
    authenticated: true,
    identityReads: 0,
    holdIdentity: false,
    releaseIdentity: () => {},
  };
  const board: Dashboard = {
    user: {
      id: "101",
      email: "private-contact@example.test",
      role,
      mustChangePassword: false,
      serviceConsentRequired: false,
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
        bonusGranted: false,
        grantedMicros: 0,
        availableMicros: 0,
        heldMicros: 0,
        spentMicros: 0,
        reservationMode: "fixed5_overdraft",
        minimumRequestBalanceMicros: 5_000_000,
        outstandingDebtMicros: 0,
        chargingStatus: "routerai_citygo_10x",
        topUpAvailable: true,
        history: [],
      },
    },
  };
  await page.context().route("https://**", (route) => {
    state.outside.push(route.request().url());
    return route.abort();
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/analytics/events" && request.method() === "POST") {
      const value = customerInteractionInputSchema.parse(
        request.postDataJSON(),
      );
      state.events.push(value.event);
      return route.fulfill({ json: { recorded: true } });
    }
    if (path === "/api/v1/dashboard" && request.method() === "GET")
      return route.fulfill(
        state.authenticated
          ? { json: board }
          : { status: 401, json: { error: "Synthetic signed-out session" } },
      );
    if (path === "/api/v1/analytics/identity" && request.method() === "GET") {
      state.identityReads++;
      if (state.holdIdentity)
        await new Promise<void>((resolve) => {
          state.releaseIdentity = resolve;
        });
      try {
        await route.fulfill({
          json: { analyticsUserId: "cga_" + "a".repeat(64) },
        });
      } catch {
        // The owning Home lifetime may have been canceled while identity waits.
      }
      return;
    }
    if (path === "/api/v1/auth/logout" && request.method() === "POST") {
      state.authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (
      path === "/api/v1/auth/registration-policy" &&
      request.method() === "GET"
    )
      return route.fulfill({
        json: {
          emailVerification: "required",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/account/profile" && request.method() === "GET")
      return route.fulfill({
        json: {
          userId: board.user.id,
          email: board.user.email,
          emailVerified: true,
          phoneVerified: false,
          giftStatus: "available",
          emailConfirmation: "available",
        },
      });
    if (
      path === "/api/v1/phone-verification/policy" &&
      request.method() === "GET"
    )
      return route.fulfill({
        json: {
          phoneVerification: "required",
          giftAmountMicros: 500_000_000,
          giftStatus: "eligible",
          deliveryProvider: "prosto_sms",
        },
      });
    state.unexpected.push(request.method() + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic analytics request" },
    });
  });
  return state;
}
const toolbar = (page: Page) =>
  page.getByRole("region", { name: "Баланс и телефон", exact: true });

test("SSR masks private app data while first-party milestones contain only an allowlisted event", async ({
  page,
}) => {
  const state = await install(page);
  const response = await page.goto("/");
  expect(await response!.text()).toContain("data-citygo-analytics-private");
  await expect(page.locator("main[data-citygo-analytics-private]")).toHaveClass(
    "ym-hide-content",
  );
  await page
    .getByRole("navigation", { name: "Личный кабинет CityGo" })
    .getByRole("button", { name: "Профиль", exact: true })
    .click();
  await expect(
    page.getByText("private-contact@example.test", { exact: true }).first(),
  ).toBeVisible();
  expect(
    await page
      .getByText("private-contact@example.test", { exact: true })
      .first()
      .evaluate((element) => !!element.closest(".ym-hide-content")),
  ).toBe(true);

  await toolbar(page)
    .getByRole("button", { name: "Пополнить баланс", exact: true })
    .click();
  await expect(page.getByLabel("Email для чека")).toHaveClass(
    "ym-disable-keys",
  );
  await page.getByLabel("Email для чека").fill("private-receipt@example.test");
  await expect
    .poll(() => state.events)
    .toEqual(["profile_opened", "wallet_opened"]);
  await page
    .getByRole("button", { name: "Вернуться в приложение", exact: true })
    .click();
  await toolbar(page)
    .getByRole("button", { name: "Телефон и подарок", exact: true })
    .click();
  await expect(page.getByLabel("Российский мобильный номер")).toHaveClass(
    "ym-disable-keys",
  );
  await page.getByLabel("Российский мобильный номер").fill("+7 999 000-00-00");
  await expect
    .poll(() => state.events)
    .toEqual(["profile_opened", "wallet_opened", "phone_opened"]);
  expect(
    (await page.locator(".ym-show-content").allTextContents()).join(" "),
  ).not.toContain("private-contact@example.test");
  expect(state.outside).toEqual([]);
  expect(state.unexpected).toEqual([]);
  await expect(
    page.locator('script[src*="mc.yandex.ru"],script[src*="mc.yandex.com"]'),
  ).toHaveCount(0);
});

test("a local opt-out stops optional UI events without blocking the phone form", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/legal/analytics");
  await page
    .getByRole("button", { name: "Отключить аналитику", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("отключена");
  expect(
    await page.evaluate(() => localStorage.getItem("citygo.analytics.optout")),
  ).toBe("1");
  await page.goto("/");
  await toolbar(page)
    .getByRole("button", { name: "Телефон и подарок", exact: true })
    .click();
  await expect(page.getByLabel("Российский мобильный номер")).toBeVisible();
  expect(state.events).toEqual([]);
  expect(state.outside).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("admin account activity never initializes a visitor recorder or emits user UI analytics", async ({
  page,
}) => {
  const state = await install(page, "admin");
  await page.goto("/");
  await toolbar(page)
    .getByRole("button", { name: "Телефон и подарок", exact: true })
    .click();
  await expect(page.getByLabel("Российский мобильный номер")).toBeVisible();
  expect(state.events).toEqual([]);
  expect(state.outside).toEqual([]);
  expect(state.unexpected).toEqual([]);
  await expect(
    page.locator('script[src*="mc.yandex.ru"],script[src*="mc.yandex.com"]'),
  ).toHaveCount(0);
});

test("trusted-origin collector respects build flags, masks, late identity, opt-out, logout and admin navigation", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const expected = process.env.CITYGO_METRIKA_E2E_ENABLED;
  expect([undefined, "disabled", "enabled"]).toContain(expected);
  const enabled = expected === "enabled";
  const origin = "https://pilot.xn--c1ajazlh.xn--p1ai";
  const state = await install(page);
  state.holdIdentity = true;
  let sdkRequests = 0;
  // These browser HTTPS requests are fulfilled only from the local test build.
  // API requests remain handled by the stricter page fixture above.
  await page.context().route(origin + "/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(url.origin).toBe(origin);
    expect(request.method()).toBe("GET");
    const response = await page.request.get(
      "http://localhost:3000" + url.pathname + url.search,
      {
        maxRedirects: 0,
      },
    );
    await route.fulfill({ response });
  });
  await page
    .context()
    .route("https://mc.yandex.ru/metrika/tag.js", async (route) => {
      sdkRequests++;
      expect(route.request().method()).toBe("GET");
      await route.fulfill({
        contentType: "application/javascript",
        body: `(() => {
      const pending = window.ym && window.ym.a || [];
      const read = (key) => JSON.parse(localStorage.getItem(key) || '[]');
      window.ym = (...args) => {
        const commands = read('__citygo_fake_metrika_commands');
        commands.push(args);
        localStorage.setItem('__citygo_fake_metrika_commands', JSON.stringify(commands));
        if (args[1] === 'init') {
          const masks = read('__citygo_fake_metrika_masks');
          masks.push({
            rootMasked: !!document.querySelector('main[data-citygo-analytics-private].ym-hide-content'),
            fieldsMasked: [...document.querySelectorAll('input,textarea,select')].every(el =>
              el.closest('.ym-hide-content') || el.classList.contains('ym-disable-keys')),
            privateVisible: [...document.querySelectorAll('.ym-show-content')].some(el =>
              /private-contact|private-receipt|79990000000/.test(el.textContent || ''))
          });
          localStorage.setItem('__citygo_fake_metrika_masks', JSON.stringify(masks));
        }
      };
      pending.forEach(args => window.ym(...args));
    })();`,
      });
    });
  type Command = [number, string, ...unknown[]];
  const commands = () =>
    page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem("__citygo_fake_metrika_commands") ?? "[]",
        ) as Command[],
    );
  await page.goto(origin + "/", { referer: "" });
  await expect(toolbar(page)).toBeVisible();
  if (!enabled) {
    expect(state.identityReads).toBe(0);
    expect(sdkRequests).toBe(0);
    expect(await commands()).toEqual([]);
    expect(state.outside).toEqual([]);
    expect(state.unexpected).toEqual([]);
    return;
  }

  await expect.poll(() => state.identityReads).toBe(1);
  expect(sdkRequests).toBe(0);
  // Cancel Home while its own opaque identity response is still unresolved.
  await page.goto(origin + "/admin", { referer: "" });
  state.holdIdentity = false;
  state.releaseIdentity();
  await expect(page.locator("main")).toHaveClass(/ym-hide-content/);
  expect(sdkRequests).toBe(0);
  expect(await commands()).toEqual([]);

  await page.goto(origin + "/", { referer: "" });
  await expect.poll(() => sdkRequests).toBe(1);
  await expect
    .poll(async () => (await commands()).some((row) => row[1] === "setUserID"))
    .toBe(true);
  let rows = await commands();
  expect(rows.find((row) => row[1] === "init")).toEqual([
    105736701,
    "init",
    expect.objectContaining({
      defer: true,
      webvisor: true,
      sendTitle: false,
      trackLinks: false,
      trackHash: false,
      childIframe: false,
      ecommerce: false,
      disableYtm: true,
    }),
  ]);
  expect(rows.find((row) => row[1] === "setUserID")).toEqual([
    105736701,
    "setUserID",
    "cga_" + "a".repeat(64),
  ]);
  await toolbar(page)
    .getByRole("button", { name: "Телефон и подарок", exact: true })
    .click();
  await page.getByLabel("Российский мобильный номер").fill("+7 999 000-00-00");
  await expect(page.getByLabel("Российский мобильный номер")).toHaveClass(
    "ym-disable-keys",
  );
  await expect
    .poll(async () =>
      (await commands()).some(
        (row) => row[1] === "reachGoal" && row[2] === "citygo_phone_opened",
      ),
    )
    .toBe(true);
  rows = await commands();
  expect(
    rows
      .filter((row) => row[1] === "hit")
      .every(
        (row) =>
          row[2] === origin + "/" &&
          (row[3] as { title: string; referer: string }).title === "CityGo" &&
          (row[3] as { referer: string }).referer === "",
      ),
  ).toBe(true);
  expect(JSON.stringify(rows)).not.toMatch(
    /private-contact|private-receipt|79990000000|"101"/,
  );
  expect(
    rows
      .filter((row) => row[1] === "reachGoal")
      .every(
        (row) =>
          String(row[2]).startsWith("citygo_") &&
          Object.keys(row[3] as object).every((key) =>
            ["surface", "mode", "assistant"].includes(key),
          ),
      ),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("__citygo_fake_metrika_masks") ?? "[]"),
    ),
  ).toEqual([{ rootMasked: true, fieldsMasked: true, privateVisible: false }]);

  // Use the real public preference UI in a second tab; storage revocation must
  // synchronously stop the already-running recorder in the first tab.
  const preference = await page.context().newPage();
  await preference.goto(origin + "/legal/analytics", { referer: "" });
  await preference
    .getByRole("button", { name: "Отключить аналитику", exact: true })
    .click();
  await expect
    .poll(async () => (await commands()).at(-1)?.[1])
    .toBe("destruct");
  const stoppedAt = (await commands()).length;
  await toolbar(page)
    .getByRole("button", { name: "Баланс и пополнение", exact: true })
    .click();
  await expect(page.getByLabel("Email для чека")).toBeVisible();
  expect((await commands()).length).toBe(stoppedAt);
  expect(state.events).toEqual(["phone_opened"]);
  await preference
    .getByRole("button", { name: "Разрешить аналитику", exact: true })
    .click();
  await preference.close();
  await page.goto(origin + "/", { referer: "" });
  await expect.poll(() => sdkRequests).toBe(2);
  await expect
    .poll(
      async () =>
        (await commands()).filter((row) => row[1] === "setUserID").length,
    )
    .toBe(2);
  const beforeLogout = (await commands()).length;
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await commands())
        .slice(beforeLogout)
        .some((row) => row[1] === "destruct"),
    )
    .toBe(true);
  expect(
    (await commands())
      .slice(beforeLogout)
      .some((row) => row[1] === "setUserID"),
  ).toBe(false);
  const sdkBeforeAdmin = sdkRequests;
  await page.goto(origin + "/admin", { referer: "" });
  await expect(page.locator("main")).toHaveClass(/ym-hide-content/);
  expect(sdkRequests).toBe(sdkBeforeAdmin);
  await expect(
    page.locator('script[src*="mc.yandex.ru"],script[src*="mc.yandex.com"]'),
  ).toHaveCount(0);
  expect(state.outside).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
