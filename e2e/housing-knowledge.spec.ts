import { expect, test, type Page } from "@playwright/test";
import type { KnowledgeLookupResult } from "@citygo/contracts";
import { syntheticProduct } from "./marketing-landing-fixture";

const lookupPath = "/api/v1/knowledge/lookup";
const lookup = {
  factKey: "housing.rent.first_payment",
  scope: { kind: "global" },
  limit: 1,
};
const sourceUrl = "https://source.example.com/housing/first-payment";
const sourceTitle = "Синтетическая памятка об аренде";
const publisher = "Синтетический издатель";
const statement =
  "Синтетический факт: сравнивайте, что входит в первый платёж.";
const reviewedAt = "2030-06-18T10:15:00.000Z";
const validUntil = "2030-06-19T10:15:00.000Z";

const freshResult = {
  status: "hit",
  researchNeeded: false,
  matches: [
    {
      fact: { id: "synthetic-housing-fact", revision: 2 },
      factKey: lookup.factKey,
      scope: { kind: "global" },
      statement,
      reviewedAt,
      validUntil,
      evidence: [
        {
          source: { id: "synthetic-housing-source", revision: 3 },
          url: sourceUrl,
          title: sourceTitle,
          publisher,
          reviewedAt,
          validUntil,
          quote: "Уточните состав первого платежа.",
        },
      ],
    },
  ],
} satisfies KnowledgeLookupResult;

const cases = [
  {
    name: "fresh",
    message: null,
    result: freshResult,
  },
  {
    name: "stale",
    message: "Срок проверки источника истёк",
    result: { status: "stale", researchNeeded: true, reason: "expired" },
  },
  {
    name: "missing",
    message: "Подтверждённого источника пока нет",
    result: { status: "miss", researchNeeded: true, reason: "not_found" },
  },
  {
    name: "conflicting",
    message: "Источники противоречат друг другу",
    result: {
      status: "conflict",
      researchNeeded: false,
      reason: "ambiguous_claims",
    },
  },
] satisfies {
  name: string;
  message: string | null;
  result: KnowledgeLookupResult;
}[];

async function startHousingPlan(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Помощники", exact: true }).click();
  await page
    .getByRole("article", { name: "Помощник по жилью", exact: true })
    .getByRole("button", { name: "Начать разговор", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Составить план поиска жилья", exact: true })
    .click();
}

for (const scenario of cases) {
  test(`housing recommendation keeps its guidance with a ${scenario.name} source`, async ({
    page,
  }) => {
    const state = await syntheticProduct(page);
    state.authenticated = true;
    await page.setViewportSize({ width: 320, height: 780 });
    await page.clock.setFixedTime(new Date("2030-06-18T11:00:00.000Z"));

    const lookups: unknown[] = [];
    const writes: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (
        pathname.startsWith("/api/v1/") &&
        !["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
        ![
          "/api/v1/conversations/start",
          "/api/v1/analytics/events",
          lookupPath,
        ].includes(pathname)
      )
        writes.push(request.method() + " " + pathname);
    });
    await page.route("**" + lookupPath, async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(new URL(request.url()).search).toBe("");
      lookups.push(request.postDataJSON());
      await route.fulfill({ json: scenario.result });
    });

    await startHousingPlan(page);
    await page
      .getByRole("button", { name: "Есть ориентир по работе", exact: true })
      .click();
    const commute = "Синтетический личный адрес 42";
    const budget = "125000";
    const commuteInput = page.getByLabel("Ориентир для регулярных поездок", {
      exact: true,
    });
    const budgetInput = page.getByLabel("Бюджет на жильё в месяц, ₽", {
      exact: true,
    });
    await commuteInput.fill(commute);
    await budgetInput.fill(budget);
    await page
      .getByRole("button", { name: "Открыть план поиска", exact: true })
      .click();

    const plan = page.getByRole("region", {
      name: "Ваш стартовый план поиска",
      exact: true,
    });
    await expect(plan).toContainText("Полный расход");
    await expect(plan).toContainText(scenario.message ?? statement);
    const openSources = plan.getByRole("button", {
      name: "Основания рекомендации",
      exact: true,
    });
    await openSources.click();
    const sources = page.getByRole("region", {
      name: "На что опирается рекомендация",
      exact: true,
    });
    await expect(
      sources.getByRole("heading", {
        name: "На что опирается рекомендация",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      sources.getByRole("heading", { name: "Ваш контекст", exact: true }),
    ).toBeVisible();
    const assessment = sources.getByRole("heading", {
      name: "Оценка помощника",
      exact: true,
    });
    await expect(assessment).toBeVisible();
    await expect(assessment.locator("..")).toContainText(
      "Отдельно сравните первый месяц, залог",
    );
    await expect(
      sources.getByRole("heading", {
        name: "Внешние источники",
        exact: true,
      }),
    ).toBeVisible();
    await expect(sources).toContainText(commute);
    await expect(sources).toContainText(/125[\s\u00a0\u202f]+000/u);
    await expect(sources).toContainText(
      "Цены аренды и доступность жилья проверяйте по актуальному объявлению и у арендодателя.",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);

    if (scenario.message === null) {
      await expect(sources).toContainText("Проверенный внешний факт");
      await expect(sources).toContainText(statement);
      const link = sources.getByRole("link", { name: new RegExp(publisher) });
      await expect(link).toContainText(sourceTitle);
      await expect(link).toHaveAttribute("href", sourceUrl);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
      const time = sources.locator(`time[datetime="${reviewedAt}"]`);
      await expect(time).toContainText("18 июня 2030");
      await expect(sources).toContainText("Дата проверки");
    } else {
      await expect(sources).toContainText(scenario.message);
      await expect(sources.getByText(statement, { exact: true })).toHaveCount(
        0,
      );
      await expect(
        sources.getByRole("link", { name: new RegExp(publisher) }),
      ).toHaveCount(0);
      await expect(
        sources.getByText("Проверенный внешний факт", { exact: true }),
      ).toHaveCount(0);
    }
    expect(lookups).toEqual([lookup, lookup]);

    await sources
      .getByRole("button", { name: "Вернуться к плану", exact: true })
      .click();
    await expect(plan).toBeVisible();
    await openSources.click();
    await sources
      .getByRole("button", { name: "Исправить контекст", exact: true })
      .click();
    await expect(commuteInput).toHaveValue(commute);
    await expect(budgetInput).toHaveValue(budget);
    for (const request of lookups) expect(request).toEqual(lookup);
    expect(state.starts).toEqual(["housing"]);
    expect(state.chatPosts).toBe(0);
    expect(state.outside).toEqual([]);
    expect(writes).toEqual([]);
  });
}

test("housing evidence expires in an open plan without a new lookup", async ({
  page,
}) => {
  const state = await syntheticProduct(page);
  state.authenticated = true;
  await page.clock.install({ time: new Date("2030-06-18T11:00:00.000Z") });
  let lookupCount = 0;
  await page.route("**" + lookupPath, async (route) => {
    lookupCount += 1;
    await route.fulfill({
      json: {
        ...freshResult,
        matches: freshResult.matches.map((match) => ({
          ...match,
          evidence: match.evidence.map((source) => ({
            ...source,
            validUntil: "2030-06-18T11:01:00.000Z",
          })),
        })),
      },
    });
  });

  await startHousingPlan(page);
  await page
    .getByRole("button", {
      name: "Сразу покажите стартовый план",
      exact: true,
    })
    .click();
  const plan = page.getByRole("region", {
    name: "Ваш стартовый план поиска",
    exact: true,
  });
  const link = plan.getByRole("link", { name: new RegExp(publisher) });
  await expect(link).toHaveAttribute("href", sourceUrl);
  await expect(plan).toContainText(statement);

  await page.clock.fastForward("02:00");
  await expect(plan).toContainText("Срок проверки источника истёк");
  await expect(plan).toContainText("Полный расход — не только аренда");
  await expect(plan.getByText(statement, { exact: true })).toHaveCount(0);
  await expect(link).toHaveCount(0);
  expect(lookupCount).toBe(1);
  expect(state.chatPosts).toBe(0);
  expect(state.outside).toEqual([]);
});
