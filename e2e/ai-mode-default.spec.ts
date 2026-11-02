import { modeSelector, chooseMode } from "./ai-mode-navigation";
import { expect, test } from "@playwright/test";
import {
  fixture,
  noOtherTraffic,
  catalogId,
  policyId,
} from "./ai-mode-fixture";
import {
  analyticsOrigin,
  enabledCollector,
} from "./product-analytics-collector";

// Finish page-owned local asset forwards before Playwright closes request fixtures.
// Waiting keeps real route failures visible instead of ignoring late errors.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("a fresh Web owner starts at Maximum, sends only explicitly and preserves a later choice through refresh", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  const selector = modeSelector(page);
  await expect(selector).toHaveAttribute("data-ai-mode", "maximum");
  expect(state.sends).toEqual([]);
  expect(state.consentReads).toBe(0);
  await page
    .getByLabel("Сообщение помощнику", { exact: true })
    .fill("ЯВНЫЙ_ВОПРОС");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(1);
  expect(state.sends[0]).toMatchObject({
    aiMode: "maximum",
    aiModeCatalogId: catalogId,
  });
  await expect(selector).toBeEnabled();
  await chooseMode(page, "balanced");
  const reads = state.dashboardReads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(reads);
  await expect(selector).toHaveAttribute("data-ai-mode", "balanced");
  expect(state.sends).toHaveLength(1);
  noOtherTraffic(state);
});

test("initial Maximum requires an explicit confirmation and never grants, sends or falls back on its own", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  await page.goto("/");
  const selector = modeSelector(page);
  await expect(selector).toHaveAttribute("data-ai-mode", "maximum");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Отправить", exact: true }),
  ).toBeDisabled();
  expect(state.consentReads).toBe(0);
  await chooseMode(page, "maximum");
  const dialog = page.getByRole("dialog", { name: "Новые режимы ответа" });
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(selector).toHaveAttribute("data-ai-mode", "maximum");
  expect(state.consentSaves).toEqual([]);
  expect(state.sends).toEqual([]);
  await chooseMode(page, "balanced");
  await expect(
    page.getByLabel("Сообщение помощнику", { exact: true }),
  ).toBeEnabled();
  noOtherTraffic(state);
});

test("unavailable initial Maximum stays selected and cannot silently use Balanced", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { maximumAvailable: false });
  await page.goto("/");
  await expect(modeSelector(page)).toHaveAttribute("data-ai-mode", "maximum");
  await expect(
    page.getByRole("button", { name: "Отправить", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Сообщение помощнику", { exact: true }),
  ).toBeDisabled();
  expect(state.sends).toEqual([]);
  expect(state.consentSaves).toEqual([]);
  noOtherTraffic(state);
});

for (const outcome of ["complete", "failed"] as const)
  test(`legacy requests and their ${outcome} outcome keep Balanced analytics attribution`, async ({
    page,
    context,
  }) => {
    const state = await fixture(context, { legacy: true });
    state.failNextSend = outcome === "failed";
    let sdkRequests = 0;
    // Exercise the actual local build under its allowed origin. Page API routes
    // fall through to the existing synthetic fixture; no real origin is used.
    await page.route(analyticsOrigin + "/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/")) return route.fallback();
      expect(request.method()).toBe("GET");
      const response = await page.request.get(
        "http://localhost:3000" + url.pathname + url.search,
        { maxRedirects: 0 },
      );
      await route.fulfill({ response });
    });
    await page.route("**/api/v1/analytics/identity", (route) =>
      route.fulfill({ json: { analyticsUserId: "cga_" + "a".repeat(64) } }),
    );
    await page.route("https://mc.yandex.ru/metrika/tag.js", async (route) => {
      sdkRequests++;
      await route.fulfill({
        contentType: "application/javascript",
        body: `(() => {
          const pending=window.ym&&window.ym.a||[];
          window.__citygoLegacyModeGoals=[];
          window.ym=(counter,method,...args)=>{
            if(method==='reachGoal') window.__citygoLegacyModeGoals.push({event:args[0],params:args[1]});
          };
          pending.forEach(args=>window.ym(...args));
        })();`,
      });
    });
    const goals = () =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __citygoLegacyModeGoals?: {
                event: string;
                params: { mode?: string };
              }[];
            }
          ).__citygoLegacyModeGoals ?? [],
      );
    await page.goto(analyticsOrigin + "/");
    const composer = page.getByLabel("Сообщение помощнику", { exact: true });
    await expect(composer).toBeVisible();
    await expect(page.getByLabel("Режим работы", { exact: true })).toHaveCount(
      0,
    );
    if (enabledCollector()) await expect.poll(() => sdkRequests).toBe(1);
    await composer.fill("ВОПРОС_БЕЗ_КАТАЛОГА_РЕЖИМОВ");
    await page.getByRole("button", { name: "Отправить", exact: true }).click();
    await expect.poll(() => state.sends.length).toBe(1);
    await expect(composer).toBeEnabled();
    expect(state.sends[0]).toEqual({
      text: "ВОПРОС_БЕЗ_КАТАЛОГА_РЕЖИМОВ",
      requestId: expect.any(String),
      policyId,
      creditReservationMode: "fixed5_overdraft",
    });
    if (enabledCollector()) {
      const terminal =
        outcome === "complete"
          ? "citygo_ai_response_completed"
          : "citygo_ai_response_failed";
      await expect
        .poll(async () =>
          (await goals()).filter(
            (row) =>
              row.event === "citygo_ai_request_submitted" ||
              row.event === terminal,
          ),
        )
        .toEqual([
          {
            event: "citygo_ai_request_submitted",
            params: { surface: "chat", mode: "balanced", assistant: "support" },
          },
          {
            event: terminal,
            params: { surface: "chat", mode: "balanced", assistant: "support" },
          },
        ]);
    } else {
      expect(sdkRequests).toBe(0);
      expect(await goals()).toEqual([]);
    }
    noOtherTraffic(state);
  });
