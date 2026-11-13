import { expect, test } from "@playwright/test";
import {
  analyticsOrigin,
  enabledCollector,
} from "./product-analytics-collector";
import {
  syntheticProduct,
  submitRegistration,
} from "./marketing-landing-fixture";

test("a live privacy change removes attribution from copied and non-primary CTA links", async ({
  page,
}) => {
  await syntheticProduct(page);
  await page.goto("/landing/v1?utm_source=vk&utm_campaign=privacy-v1");
  const cta = page.locator("[data-landing-cta=hero]");
  await expect(cta).toHaveAttribute("href", /utm_campaign=privacy-v1/);
  await page.evaluate(() => {
    localStorage.setItem("citygo.analytics.optout", "1");
    dispatchEvent(new Event("citygo:analytics-preference"));
  });
  await expect(cta).toHaveAttribute(
    "href",
    "https://pilot.xn--c1ajazlh.xn--p1ai/",
  );
  await cta.dispatchEvent("contextmenu");
  await expect(cta).not.toHaveAttribute("href", /utm_/);
  await cta.dispatchEvent("pointerdown", { button: 1 });
  await expect(cta).not.toHaveAttribute("href", /utm_/);
});

test("V1 renders its real assets, responsive content, anchors and user-started video", async ({
  page,
}, info) => {
  const state = await syntheticProduct(page);
  await page.setViewportSize(
    info.project.name === "desktop"
      ? { width: 1440, height: 1000 }
      : { width: 390, height: 844 },
  );
  await page.goto("/landing/v1");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Мечта о Москве.План — подвашу жизнь.",
  );
  await expect(page.locator("[data-landing-cta=hero]")).toHaveAttribute(
    "href",
    /landing\/start\?landing=v1/,
  );
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 600) {
      scrollTo({ top: y, behavior: "instant" });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    scrollTo({ top: 0, behavior: "instant" });
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.images)
          .filter((im) => im.getBoundingClientRect().width > 0)
          .every((im) => im.complete && im.naturalWidth > 0),
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("landing-v1.png"),
    fullPage: true,
  });
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(page.locator("video")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Смотреть демонстрацию CityGo — 42 секунды" })
    .click();
  await expect(page.locator("video")).toHaveAttribute("controls", "");
  await expect(page.locator("video source")).toHaveAttribute(
    "src",
    "/landing/citygo-demo.mp4",
  );
  expect(state.outside).toEqual([]);
});

test("campaign CTA reaches query-free registration and freezes its safe version through email confirmation", async ({
  page,
}) => {
  const state = await syntheticProduct(page);
  await page.goto(
    analyticsOrigin +
      "/landing/v1?utm_source=vk&utm_medium=cpc&utm_campaign=family-123&utm_content=private%40example.test&email=never-store%40example.test",
  );
  await expect(page).toHaveURL(analyticsOrigin + "/landing/v1");
  await expect(page.locator("[data-landing-cta=hero]")).toHaveAttribute(
    "href",
    /utm_campaign=family-123/,
  );
  await page.locator("[data-landing-cta=hero]").click();
  await expect(page).toHaveURL("http://localhost:3000/");
  await submitRegistration(page);
  expect(state.begin[0]?.landingAttribution).toEqual({
    landingVersion: "v1",
    source: "vk",
    medium: "cpc",
    campaignId: "family-123",
  });
  await page.evaluate(() => {
    document.cookie =
      "citygo_landing_attribution=" +
      encodeURIComponent(JSON.stringify({ landingVersion: "v8" })) +
      "; Path=/; SameSite=Lax";
  });
  await page.getByLabel("Код из письма", { exact: true }).fill("654321");
  await page.getByRole("button", { name: "Подтвердить email" }).click();
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  expect(state.confirm).toBe(1);
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "citygo_landing_attribution",
  );
  expect(state.outside).toEqual([]);
});

test("the registration goal keeps the originally submitted version and excludes campaign and private fields", async ({
  page,
}) => {
  test.skip(!enabledCollector(), "Requires the explicit fake-collector build");
  const state = await syntheticProduct(page);
  await page.context().addCookies([
    {
      name: "citygo_landing_attribution",
      value: encodeURIComponent(
        JSON.stringify({
          landingVersion: "v1",
          source: "vk",
          campaignId: "family-123",
        }),
      ),
      url: analyticsOrigin,
    },
  ]);
  await page.goto(analyticsOrigin + "/");
  await submitRegistration(page);
  await page.evaluate(() => {
    document.cookie =
      "citygo_landing_attribution=" +
      encodeURIComponent(JSON.stringify({ landingVersion: "v8" })) +
      "; Path=/; SameSite=Lax";
  });
  await page.getByLabel("Код из письма", { exact: true }).fill("654321");
  await page.getByRole("button", { name: "Подтвердить email" }).click();
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("__landing_calls") || "[]").filter(
            (x: unknown[]) =>
              x[1] === "reachGoal" && x[2] === "citygo_registration_completed",
          ).length,
      ),
    )
    .toBe(1);
  const commands = await page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem("__landing_calls") || "[]",
      ) as unknown[][],
  );
  expect(
    commands.find((x) => x[2] === "citygo_registration_completed")?.[3],
  ).toEqual({ surface: "register", landingVersion: "v1" });
  const serialized = JSON.stringify(commands);
  expect(serialized).not.toContain("private@example.test");
  expect(serialized).not.toContain("never-store");
  expect(serialized).not.toContain("synthetic-password");
  expect(serialized).not.toContain("654321");
  expect(serialized).not.toContain("family-123");
  expect(state.outside).toEqual([]);
  // Settle the real local image proxy before its request context is disposed.
  await page.waitForLoadState("networkidle");
});

test("campaign visits report validated source labels while the address and private query stay clean", async ({
  page,
}) => {
  test.skip(!enabledCollector(), "Requires the explicit fake-collector build");
  const state = await syntheticProduct(page);
  for (const source of ["vk", "avito"]) {
    await page.goto(
      analyticsOrigin +
        `/landing/v1?utm_source=${source}&utm_medium=cpc&utm_campaign=family-123&utm_content=family-01&email=never-store%40example.test&rb_clickid=never-export-click`,
    );
    await expect(page).toHaveURL(analyticsOrigin + "/landing/v1");
    await expect
      .poll(() =>
        page.evaluate((expectedSource) => {
          const calls = JSON.parse(
            localStorage.getItem("__landing_calls") || "[]",
          ) as unknown[][];
          return calls.some(
            (row) =>
              row[1] === "hit" &&
              String(row[2]).includes("utm_source=" + expectedSource),
          );
        }, source),
      )
      .toBe(true);
    await expect(page.locator("[data-landing-cta=hero]")).toHaveAttribute(
      "href",
      new RegExp("utm_source=" + source),
    );
  }
  const calls = await page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem("__landing_calls") || "[]",
      ) as unknown[][],
  );
  const hits = calls.filter((row) => row[1] === "hit");
  expect(
    hits.map((row) => new URL(String(row[2])).searchParams.get("utm_source")),
  ).toEqual(["vk", "avito"]);
  const serialized = JSON.stringify(calls);
  expect(serialized).not.toContain("never-store");
  expect(serialized).not.toContain("never-export-click");
  expect(serialized).not.toContain("rb_clickid");
  expect(state.outside).toEqual([]);
  await page.waitForLoadState("networkidle");
});

for (const [version, source] of [
  ["v1", "vk"],
  ["v8", "avito-ads"],
] as const) {
  test(`fast ${version} CTA preserves the first tagged hit through confirmed registration`, async ({
    page,
  }) => {
    test.skip(
      !enabledCollector(),
      "Requires the explicit fake-collector build",
    );
    const state = await syntheticProduct(page, { fastLandingCta: true });
    const landing = analyticsOrigin + "/landing/" + version;
    const tags = `?utm_source=${source}&utm_medium=cpc&utm_campaign=qa_${version}`;
    await page.goto(landing + tags + "&email=never-store%40example.test");
    const cta = page.locator("[data-landing-cta=hero]");
    await expect(cta).toHaveAttribute("href", /utm_campaign=qa_/);
    await cta.click();
    await expect(page).toHaveURL(analyticsOrigin + "/");
    await submitRegistration(page);
    await page.getByLabel("Код из письма", { exact: true }).fill("654321");
    await page.getByRole("button", { name: "Подтвердить email" }).click();
    const commands = () =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("__landing_calls") || "[]",
          ) as unknown[][],
      );
    await expect
      .poll(
        async () =>
          (await commands()).filter(
            (row) => row[2] === "citygo_registration_completed",
          ).length,
      )
      .toBe(1);
    const captured = await commands();
    expect(captured.find((row) => row[1] === "hit")?.[2]).toBe(landing + tags);
    expect(
      captured.filter((row) => row[1] === "hit" && row[2] === landing + tags),
    ).toHaveLength(1);
    expect(
      captured.find((row) => row[2] === "citygo_registration_completed")?.[3],
    ).toEqual({
      surface: "register",
      landingVersion: version,
    });
    expect(JSON.stringify(captured)).not.toContain("never-store");
    expect(state.outside).toEqual([]);
    await page.waitForLoadState("networkidle");
  });
}

test("opt-out preserves registration without attribution; the header still opens the login form", async ({
  page,
}) => {
  const state = await syntheticProduct(page);
  await page.addInitScript(() =>
    localStorage.setItem("citygo.analytics.optout", "1"),
  );
  await page.goto(analyticsOrigin + "/landing/v1?utm_source=vk");
  await page.locator("[data-landing-cta=header]").click();
  await expect(page).toHaveURL("http://localhost:3000/");
  await expect(page.locator("input[name=personalDataConsent]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Войти", exact: true }),
  ).toBeVisible();
  await page.goto(analyticsOrigin + "/landing/v1");
  await page.locator("[data-landing-cta=hero]").click();
  await submitRegistration(page);
  expect(state.begin[0]?.landingAttribution).toBeUndefined();
  expect(
    await page.evaluate(() => localStorage.getItem("__landing_calls")),
  ).toBeNull();
});

test("the acquisition endpoint cannot redirect outside the product or persist private query parameters", async ({
  request,
}) => {
  const response = await request.get(
    "/landing/start?landing=v1&utm_source=vk&email=private%40example.test&utm_campaign=https%3A%2F%2Fevil.test&next=https%3A%2F%2Fevil.test",
    { maxRedirects: 0 },
  );
  expect(response.status()).toBe(303);
  expect(response.headers().location).toBe("/");
  expect(response.headers()["cache-control"]).toContain("no-store");
  const headers = decodeURIComponent(response.headers()["set-cookie"] || "");
  expect(headers).toContain('"landingVersion":"v1"');
  expect(headers).toContain('"source":"vk"');
  expect(headers).not.toContain("private@example.test");
  expect(headers).not.toContain("evil.test");
});

test("public logo navigation keeps tracking alive and a cross-tab admin switch stops the old visitor recorder", async ({
  page,
}) => {
  test.skip(!enabledCollector(), "Requires the explicit fake-collector build");
  const state = await syntheticProduct(page);
  await page.goto(analyticsOrigin + "/landing/v1");
  const goals = () =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem("__landing_calls") || "[]").filter(
        (x: unknown[]) => x[1] === "reachGoal",
      ),
    );
  await expect.poll(async () => (await goals()).length).toBe(1);
  await page.getByRole("link", { name: "CityGo — начало страницы" }).click();
  await page
    .locator("[data-landing-cta=hero]")
    .evaluate((a: HTMLAnchorElement) => {
      a.addEventListener("click", (event) => event.preventDefault(), {
        once: true,
      });
      a.click();
    });
  await expect.poll(async () => (await goals()).length).toBe(2);
  state.authenticated = true;
  state.role = "admin";
  await page.evaluate(() =>
    window.dispatchEvent(new Event("citygo-session-changed")),
  );
  await expect.poll(() => state.dashboardReads).toBeGreaterThanOrEqual(2);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("__landing_calls") || "[]").filter(
            (x: unknown[]) => x[1] === "destruct",
          ).length,
      ),
    )
    .toBe(1);
  await page
    .locator("[data-landing-cta=hero]")
    .evaluate((a: HTMLAnchorElement) => {
      a.addEventListener("click", (event) => event.preventDefault(), {
        once: true,
      });
      a.click();
    });
  expect((await goals()).length).toBe(2);
  expect(state.outside).toEqual([]);
});

test("an existing acquisition cookie is cleared on product entry when optional analytics was already refused", async ({
  page,
  request,
}) => {
  const state = await syntheticProduct(page);
  await page.addInitScript(() =>
    localStorage.setItem("citygo.analytics.optout", "1"),
  );
  await page.context().addCookies([
    {
      name: "citygo_landing_attribution",
      value: encodeURIComponent(JSON.stringify({ landingVersion: "v1" })),
      url: analyticsOrigin,
    },
  ]);
  await page.goto(analyticsOrigin + "/");
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.cookie.includes("citygo_landing_attribution"),
      ),
    )
    .toBe(false);
  await submitRegistration(page);
  expect(state.begin[0]?.landingAttribution).toBeUndefined();
  const response = await request.get("/landing/start?landing=v1", {
    maxRedirects: 0,
    headers: { DNT: "1" },
  });
  expect(response.headers()["set-cookie"]).toMatch(
    /citygo_landing_attribution=;[^\n]*Max-Age=0/,
  );
});
