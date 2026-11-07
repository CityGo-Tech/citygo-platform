import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { Dashboard } from "@citygo/contracts";
import { syntheticConsentPolicy } from "./service-consent-fixture";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { analyticsOrigin } from "./product-analytics-collector";

export async function syntheticProduct(page: Page) {
  const state = {
    authenticated: false,
    role: "user" as "user" | "admin",
    dashboardReads: 0,
    begin: [] as Record<string, unknown>[],
    confirm: 0,
    outside: [] as string[],
  };
  const board: Dashboard = {
    user: { id: "101", email: "landing-user@example.test", role: "user" },
    profile: null,
    quests: [],
    xp: 0,
    thread: null,
    provider: "unconfigured",
    aiAccess: { policy: null, granted: false, dailyLimit: 0 },
  };
  await page.context().route("https://**", (route) => {
    state.outside.push(route.request().url());
    return route.abort();
  });
  await page.context().route(analyticsOrigin + "/**", async (route) => {
    const url = new URL(route.request().url());
    // Redirect chains are not re-routed by Playwright. Keep the real browser
    // bridge on localhost, so no redirect can escape to the live product.
    if (url.pathname === "/landing/start")
      return route.fulfill({
        status: 303,
        headers: {
          location: "http://localhost:3000" + url.pathname + url.search,
        },
      });
    const response = await page.request.get(
      "http://localhost:3000" + url.pathname + url.search,
      { maxRedirects: 0 },
    );
    const headers = { ...response.headers() };
    if (response.status() >= 300 && response.status() < 400)
      throw new Error("Unexpected redirect in the synthetic origin proxy");
    await route.fulfill({ response, headers });
  });
  await page.context().route("https://mc.yandex.ru/metrika/tag.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.ym=(...args)=>{const a=JSON.parse(localStorage.getItem('__landing_calls')||'[]');a.push(args);localStorage.setItem('__landing_calls',JSON.stringify(a))}`,
    }),
  );
  await page.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/analytics/identity")
      return route.fulfill({
        json: { analyticsUserId: "cga_" + "a".repeat(64) },
      });
    if (path === "/api/v1/dashboard") {
      state.dashboardReads++;
      return route.fulfill({
        status: state.authenticated ? 200 : 401,
        json: state.authenticated
          ? { ...board, user: { ...board.user, role: state.role } }
          : { error: "Signed out" },
      });
    }
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "required",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/auth/email/register") {
      state.begin.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          challengeId: "123e4567-e89b-42d3-a456-426614174001",
          proof: "1".repeat(64),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          resendAfterSeconds: 60,
        },
      });
    }
    if (path === "/api/v1/auth/email/confirm") {
      if (route.request().postDataJSON().code !== "654321")
        return route.fulfill({ status: 400, json: { error: "Неверный код" } });
      state.confirm++;
      state.authenticated = true;
      return route.fulfill({ json: { user: board.user } });
    }
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic API" },
    });
  });
  return state;
}

export async function submitRegistration(page: Page) {
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill("landing-user@example.test");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("synthetic-password-123");
  await page.locator("input[name=personalDataConsent]").check();
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Проверьте почту" }),
  ).toBeVisible();
}
