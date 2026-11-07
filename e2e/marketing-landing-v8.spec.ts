import { expect, test } from "@playwright/test";
import {
  syntheticProduct,
  submitRegistration,
} from "./marketing-landing-fixture";

test("V8 gives a result before mobile arithmetic, five complete examples and a keyboard return", async ({
  page,
}, info) => {
  const state = await syntheticProduct(page);
  await page.setViewportSize(
    info.project.name === "desktop"
      ? { width: 1440, height: 1000 }
      : { width: 390, height: 844 },
  );
  await page.goto("/landing/v8");
  await expect(page.locator("[data-landing-cta=hero]")).toHaveAttribute(
    "href",
    /landing=v8/,
  );
  const exampleLinks = page.locator('a[href^="/landing/v8/examples/"]');
  const hrefs = [
    ...new Set(
      await exampleLinks.evaluateAll((links) =>
        links.map((link) => link.getAttribute("href")),
      ),
    ),
  ];
  expect(hrefs.sort()).toEqual(
    ["cost", "decision", "family", "income", "plan"]
      .map((key) => "/landing/v8/examples/" + key)
      .sort(),
  );
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const result = page.locator('[data-landing-result="decision"]');
    if (width < 768) {
      expect(await result.boundingBox()).not.toBeNull();
      await expect(result).toContainText("на 7 000 ₽/мес меньше");
      expect(
        await result.evaluate(
          (element) =>
            element.getBoundingClientRect().bottom <=
            element.nextElementSibling!.getBoundingClientRect().top,
        ),
      ).toBe(true);
    }
  }
  for (const href of hrefs) {
    await page.goto(href!);
    await expect(
      page.getByRole("heading", { name: "Полный вопрос" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: href!.endsWith("/plan")
          ? "Полный ответ, из которого выбран шаг"
          : "Полный ответ CityGo",
      }),
    ).toBeVisible();
    expect(
      (await page.locator("article").textContent())!.length,
    ).toBeGreaterThan(900);
    const back = page.getByRole("link", { name: "← К CityGo", exact: true });
    await back.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/landing\/v8$/);
  }
  const unknown = await page.goto("/landing/v8/examples/unknown");
  expect(unknown?.status()).toBe(404);
  expect(state.outside).toEqual([]);
});

test("V8 preserves a safe campaign through an example, reload, return and confirmed registration", async ({
  page,
}) => {
  const state = await syntheticProduct(page);
  await page.goto(
    "/landing/v8?utm_source=avito&utm_medium=cpc&utm_campaign=family-v8&utm_content=portrait&email=private%40example.test",
  );
  await expect(page).toHaveURL(/\/landing\/v8$/);
  await page.locator('a[href="/landing/v8/examples/family"]').click();
  await expect(page).toHaveURL(/\/examples\/family$/);
  await page.reload();
  await page.getByRole("link", { name: "← К CityGo", exact: true }).click();
  await expect(page.locator("[data-landing-cta=hero]")).toHaveAttribute(
    "href",
    /utm_campaign=family-v8/,
  );
  await page.locator("[data-landing-cta=hero]").click();
  await expect(page).toHaveURL("http://localhost:3000/");
  await submitRegistration(page);
  expect(state.begin[0]?.landingAttribution).toEqual({
    landingVersion: "v8",
    source: "avito",
    medium: "cpc",
    campaignId: "family-v8",
    content: "portrait",
  });
  await page.getByLabel("Код из письма", { exact: true }).fill("654321");
  await page.getByRole("button", { name: "Подтвердить email" }).click();
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  expect(state.confirm).toBe(1);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("citygo.landing.touch.v1"),
    ),
  ).toBeNull();
  expect(state.outside).toEqual([]);
});

test("refusing analytics clears a stored example touch without blocking the V8 CTA", async ({
  page,
}) => {
  const state = await syntheticProduct(page);
  await page.goto("/landing/v8?utm_source=vk&utm_campaign=work-v8");
  await expect(page).toHaveURL(/\/landing\/v8$/);
  await page.evaluate(() =>
    localStorage.setItem("citygo.analytics.optout", "1"),
  );
  await page.reload();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("citygo.landing.touch.v1"),
    ),
  ).toBeNull();
  await page.locator("[data-landing-cta=hero]").click();
  await submitRegistration(page);
  expect(state.begin[0]?.landingAttribution).toBeUndefined();
  expect(state.outside).toEqual([]);
});

test("expired campaign data disappears from the actual link before copy or new-tab navigation", async ({
  page,
}) => {
  await syntheticProduct(page);
  await page.clock.install();
  await page.goto("/landing/v8?utm_source=vk&utm_campaign=expiry-v8");
  const cta = page.locator("[data-landing-cta=hero]");
  await expect(cta).toHaveAttribute("href", /utm_campaign=expiry-v8/);
  await page.clock.fastForward(30 * 60 * 1000 + 50);
  await expect(cta).toHaveAttribute("href", /landing=v8/);
  await expect(cta).not.toHaveAttribute("href", /utm_/);
  await cta.dispatchEvent("contextmenu");
  await expect(cta).not.toHaveAttribute("href", /utm_/);
  await cta.dispatchEvent("pointerdown", { button: 1 });
  await expect(cta).not.toHaveAttribute("href", /utm_/);
});
