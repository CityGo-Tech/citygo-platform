import { clickAccountAction } from "./navigation-helper";
import { test, expect } from "@playwright/test";
import type { Dashboard, FavoriteMessage } from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";

test("favorite search combines literal text, assistant and author; reset clears drafts and paging", async ({
  page,
}, testInfo) => {
  const reads: URL[] = [];
  let mutations = 0;
  const messages: FavoriteMessage[] = Array.from(
    { length: 26 },
    (_, index) => ({
      id: (9007199254741100n - BigInt(index)).toString(),
      threadId: "1",
      role: index % 2 ? "user" : "assistant",
      agentKey: index % 3 ? "support" : "housing",
      status: "complete",
      content: "Москва 50%_\\route saved " + index,
    }),
  );
  const dashboard: Dashboard = {
    user: { id: "1", email: "owner@example.test" },
    profile: null,
    quests: [],
    xp: 0,
    thread: null,
    provider: "unconfigured",
    aiAccess: { policy: null, granted: false, dailyLimit: 0 },
  };
  await page.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") mutations++;
    if (url.pathname === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (url.pathname === "/api/v1/dashboard")
      return route.fulfill({ json: dashboard });
    if (url.pathname === "/api/v1/messages/favorites") {
      reads.push(url);
      const before = url.searchParams.get("before");
      const search = url.searchParams.get("search");
      const assistant = url.searchParams.get("assistantKey");
      const role = url.searchParams.get("role");
      const rows = messages.filter(
        (m) =>
          (!before || BigInt(m.id) < BigInt(before)) &&
          (!search || m.content.toLowerCase().includes(search.toLowerCase())) &&
          (!assistant || m.agentKey === assistant) &&
          (!role || m.role === role),
      );
      const selected = rows.slice(0, 20);
      return route.fulfill({
        json: {
          userId: "1",
          messages: selected,
          nextBefore: rows.length > 20 ? selected.at(-1)!.id : null,
        },
      });
    }
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  await page.goto("/");
  await clickAccountAction(page, "Избранное");
  const panel = page.getByRole("region", {
    name: "Избранные сообщения",
    exact: true,
  });
  await expect(panel.getByRole("article")).toHaveCount(20);
  await panel
    .getByRole("button", { name: "Показать ещё", exact: true })
    .click();
  await expect(panel.getByRole("article")).toHaveCount(26);
  await panel.getByLabel("Поиск по тексту избранного").fill("50%_\\route");
  await panel.getByLabel("Помощник в избранном").selectOption("support");
  await panel.getByLabel("Автор сообщения").selectOption("assistant");
  await panel
    .getByRole("button", { name: "Найти в избранном", exact: true })
    .click();
  await expect(panel.getByRole("article")).toHaveCount(8);
  expect(Object.fromEntries(reads.at(-1)!.searchParams)).toEqual({
    search: "50%_\\route",
    assistantKey: "support",
    role: "assistant",
  });
  await expect(
    panel.getByRole("form", { name: "Поиск в избранном" }),
  ).toHaveClass(/ym-hide-content/);
  await expect(panel.getByRole("article").first()).toHaveClass(
    /ym-hide-content/,
  );
  await panel.screenshot({
    path: testInfo.outputPath("favorites-filtered.png"),
  });
  await expect(panel).toHaveCSS("min-width", "0px");
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await panel.getByLabel("Поиск по тексту избранного").fill("not found");
  await panel
    .getByRole("button", { name: "Найти в избранном", exact: true })
    .click();
  await expect(
    panel.getByText("Ничего не найдено", { exact: true }),
  ).toBeVisible();
  await panel
    .getByLabel("Поиск по тексту избранного")
    .fill("UNAPPLIED PRIVATE DRAFT");
  await panel
    .getByRole("button", { name: "Сбросить поиск", exact: true })
    .click();
  await expect(panel.getByLabel("Поиск по тексту избранного")).toHaveValue("");
  await expect(panel.getByLabel("Помощник в избранном")).toHaveValue("");
  await expect(panel.getByLabel("Автор сообщения")).toHaveValue("");
  await expect(panel.getByRole("article")).toHaveCount(20);
  expect(reads.at(-1)!.search).toBe("");
  expect(mutations).toBe(0);
});
