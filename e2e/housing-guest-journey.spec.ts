import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { PersonalPlanPage } from "@citygo/contracts";
import {
  analyticsOrigin,
  enabledCollector,
  type CollectorCommand,
} from "./product-analytics-collector";

const localOrigin = "http://localhost:3000";
const planTitle = "Стартовый план поиска жилья";
const password = "synthetic-housing-password";
const privateCriteria =
  "ул. Тестовая 1, guest-contact@example.test, +79995554433";

async function localHousingBrowser(context: BrowserContext, clientIp: string) {
  const outside: string[] = [];
  const mutations: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    if (target.href === "https://mc.yandex.ru/metrika/tag.js")
      return route.fulfill({
        contentType: "application/javascript",
        body: `window.ym=(...args)=>{
          const key="__housing_e2e_commands";
          const commands=JSON.parse(sessionStorage.getItem(key)||"[]");
          commands.push(args);
          sessionStorage.setItem(key,JSON.stringify(commands));
        }`,
      });
    if (target.origin !== analyticsOrigin) {
      outside.push(target.origin);
      return route.abort();
    }
    const method = request.method();
    if (target.pathname.startsWith("/api/v1/") && method !== "GET")
      mutations.push(method + " " + target.pathname);
    const browserHeaders = await request.allHeaders();
    const headers: Record<string, string> = {
      "x-forwarded-for": clientIp,
    };
    for (const name of ["accept", "content-type", "cookie", "dnt", "sec-gpc"])
      if (browserHeaders[name]) headers[name] = browserHeaders[name];
    if (browserHeaders.origin) headers.origin = localOrigin;
    const response = await context.request.fetch(
      localOrigin + target.pathname + target.search,
      {
        method,
        headers,
        data: request.postDataBuffer() ?? undefined,
        maxRedirects: 0,
      },
    );
    if (target.pathname === "/landing/start") {
      expect(response.status()).toBe(303);
      const location = response.headers().location;
      expect(location).toBe("/#citygo-housing-preview");
      // Browser redirects following a fulfilled route can escape interception.
      // Use the exact local bridge target for a second intercepted navigation.
      return route.fulfill({
        contentType: "text/html",
        headers: {
          "set-cookie": response.headers()["set-cookie"] ?? "",
          "referrer-policy": "no-referrer",
        },
        body: '<meta http-equiv="refresh" content="0; url=' + location + '">',
      });
    }
    return route.fulfill({ response });
  });
  return { outside, mutations };
}

function planCard(page: Page) {
  return page
    .getByRole("region", { name: "Мой план переезда", exact: true })
    .getByRole("article")
    .filter({ hasText: planTitle });
}

async function readPlan(page: Page): Promise<PersonalPlanPage> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/personal-plan");
    if (!response.ok) throw new Error("Could not read the saved plan");
    return response.json();
  });
}

async function goals(page: Page) {
  const commands = await page.evaluate(
    () =>
      JSON.parse(
        sessionStorage.getItem("__housing_e2e_commands") ?? "[]",
      ) as CollectorCommand[],
  );
  return commands
    .filter(([, method]) => method === "reachGoal")
    .map(([, , name, params]) => [name, params]);
}

test("a guest housing result survives registration, reload and a new login with one conversion", async ({
  page,
  context,
  browser,
}, info) => {
  test.setTimeout(60_000);
  const ipSegment = info.project.name === "desktop" ? 215 : 216;
  const initial = await localHousingBrowser(
    context,
    "198.19." + ipSegment + ".1",
  );
  const email = "housing-guest-" + crypto.randomUUID() + "@example.test";

  await page.goto(analyticsOrigin + "/landing/v1");
  if (enabledCollector())
    await expect
      .poll(async () => (await goals(page)).map(([name]) => name))
      .toContain("citygo_landing_viewed");
  await page.getByRole("link", { name: "Обсудить жильё", exact: true }).click();
  await expect(page).toHaveURL(analyticsOrigin + "/");
  await expect(
    page.getByLabel("Электронная почта", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Есть ориентир по работе", exact: true })
    .click();
  await page
    .getByLabel("Ориентир для регулярных поездок", { exact: true })
    .fill(privateCriteria);
  await page
    .getByRole("button", { name: "Открыть план поиска", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Ваш стартовый план поиска",
    exact: true,
  });
  await expect(preview).toContainText("Бюджет пока открыт");
  await expect(preview).toContainText("Сравнивать по одинаковым критериям");
  await expect(preview).toContainText(privateCriteria);
  expect(initial.mutations).toEqual([]);
  if (enabledCollector())
    await expect
      .poll(() => goals(page))
      .toContainEqual([
        "citygo_plan_opened",
        { surface: "plan", assistant: "housing" },
      ]);

  await preview
    .getByRole("button", { name: "Сохранить ориентир", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Уже есть аккаунт? Войти", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Впервые здесь? Создать аккаунт",
      exact: true,
    })
    .click();
  await page.getByLabel("Электронная почта", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.locator("input[name=personalDataConsent]").check();
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  const composer = page.getByRole("region", {
    name: "Добавление шага в план",
    exact: true,
  });
  await expect(
    composer.getByLabel("Название шага", { exact: true }),
  ).toHaveValue(planTitle);
  const details = composer.getByLabel("Описание шага", { exact: true });
  await expect(details).toHaveValue(/Сравните дорогу/);
  expect(await details.inputValue()).toContain(privateCriteria);
  expect((await readPlan(page)).items).toEqual([]);

  await composer
    .getByRole("button", { name: "Подтвердить добавление", exact: true })
    .click();
  await expect(planCard(page)).toContainText(privateCriteria);
  const saved = await readPlan(page);
  expect(saved.items).toHaveLength(1);
  expect(saved.items[0]).toMatchObject({
    title: planTitle,
    revision: 1,
    source: null,
  });
  if (enabledCollector())
    await expect
      .poll(() => goals(page))
      .toContainEqual(["citygo_plan_step_saved", { surface: "plan" }]);

  await page.reload();
  await page.getByRole("button", { name: "Мой план", exact: true }).click();
  await expect(planCard(page)).toContainText(privateCriteria);
  expect(await readPlan(page)).toEqual(saved);

  const returningContext = await browser.newContext();
  try {
    const returning = await localHousingBrowser(
      returningContext,
      "198.19." + ipSegment + ".2",
    );
    const secondPage = await returningContext.newPage();
    await secondPage.goto(analyticsOrigin + "/");
    await secondPage
      .getByRole("button", { name: "Войти", exact: true })
      .click();
    await secondPage
      .getByLabel("Логин или электронная почта", { exact: true })
      .fill(email);
    await secondPage.getByLabel("Пароль", { exact: true }).fill(password);
    await secondPage
      .getByRole("main")
      .getByRole("button", { name: "Войти", exact: true })
      .click();
    await secondPage
      .getByRole("button", { name: "Мой план", exact: true })
      .click();
    await expect(planCard(secondPage)).toContainText(privateCriteria);
    expect(await readPlan(secondPage)).toEqual(saved);
    expect(returning.mutations).not.toContain("POST /api/v1/personal-plan");
    expect(returning.mutations).not.toContain(
      "POST /api/v1/conversations/start",
    );
    expect(returning.outside).toEqual([]);
    if (enabledCollector()) {
      await expect
        .poll(() => goals(secondPage))
        .toContainEqual(["citygo_plan_opened", { surface: "plan" }]);
      const captured = [...(await goals(page)), ...(await goals(secondPage))];
      const milestones = [
        "citygo_landing_cta_clicked",
        "citygo_assistant_opened",
        "citygo_plan_step_saved",
      ];
      for (const milestone of milestones)
        expect(captured.filter(([name]) => name === milestone)).toHaveLength(1);
      expect(captured).toContainEqual([
        "citygo_assistant_opened",
        { surface: "chat", assistant: "housing" },
      ]);
      const payload = JSON.stringify(captured);
      for (const secret of [
        email,
        password,
        "ул. Тестовая",
        "guest-contact@example.test",
        "+79995554433",
        "Сравните дорогу",
      ])
        expect(payload).not.toContain(secret);
    }
  } finally {
    await returningContext.close();
  }
  expect(
    initial.mutations.filter(
      (mutation) => mutation === "POST /api/v1/personal-plan",
    ),
  ).toHaveLength(1);
  expect(
    initial.mutations.filter((mutation) =>
      /^POST \/api\/v1\/(?:chat|phone|payments)\b/.test(mutation),
    ),
  ).toEqual([]);
  expect(initial.outside).toEqual([]);
});
