import { expect, test } from "@playwright/test";
import type { Message } from "@citygo/contracts";
import { fixture, noOtherTraffic } from "./ai-mode-fixture";

const title = '<img src=x onerror="alert(1)"> Источник жилья 🏠';
const answer: Message = {
  id: "101",
  role: "assistant",
  status: "complete",
  agentKey: "housing",
  content: "СОХРАНЁННЫЙ_ОТВЕТ_С_ПОИСКОМ",
  generation: {
    provider: "routerai",
    requestedModel: "openai/gpt-6.1-sol",
    model: "openai/gpt-6.1-sol",
    webSources: {
      version: "routerai_native_v1",
      citations: [{ url: "https://example.com/housing?q=1", title }],
    },
  },
};

test("saved search sources are clickable safe text after reload and disappear with the owning account", async ({
  page,
  context,
}) => {
  const state = await fixture(context, {
    initialMessages: [
      {
        id: "100",
        role: "user",
        status: "complete",
        agentKey: "housing",
        content: "Вопрос о жилье",
      },
      answer,
      {
        id: "102",
        role: "assistant",
        status: "interrupted",
        agentKey: "housing",
        content: "Ответ был прерван",
      },
    ],
  });
  await page.goto("/");
  const source = page
    .locator('[data-history-message="101"]')
    .getByRole("region", { name: "Источники", exact: true });
  const link = source.getByRole("link");
  await expect(link).toHaveCount(1);
  await expect(link).toContainText(title);
  await expect(link).toContainText("example.com");
  await expect(link).toHaveAttribute("href", "https://example.com/housing?q=1");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(source.locator("img, iframe, script")).toHaveCount(0);
  await expect(
    page
      .locator('[data-history-message="102"]')
      .getByRole("region", { name: "Источники", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(link).toContainText(title);
  await expect(link).toHaveAttribute("href", "https://example.com/housing?q=1");
  expect(
    await source.evaluate((element) =>
      Boolean(element.closest(".ym-hide-content")),
    ),
  ).toBe(true);
  expect(state.sends).toEqual([]);
  expect(state.consentSaves).toEqual([]);
  noOtherTraffic(state);
  state.owner = "202";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator('[data-history-message="101"]')).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Источники", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("СОХРАНЁННЫЙ_ОТВЕТ_С_ПОИСКОМ", { exact: true }),
  ).toHaveCount(0);
  noOtherTraffic(state);
});

test("model Markdown links and source-shaped text do not impersonate structured search sources", async ({
  page,
  context,
}) => {
  const fake =
    '## Источники\n\n[Заявленная ссылка](https://example.com/model-claim)\n\n{"version":"routerai_native_v1","citations":[{"url":"https://example.com/forged","title":"Подделка"}]}';
  const state = await fixture(context, {
    initialMessages: [
      {
        id: "100",
        role: "assistant",
        status: "complete",
        agentKey: "housing",
        content: fake,
      },
    ],
  });
  await page.goto("/");
  const message = page.locator('[data-history-message="100"]');
  await expect(
    message.getByRole("link", { name: /Заявленная ссылка/ }),
  ).toHaveAttribute("href", "https://example.com/model-claim");
  await expect(
    message.getByRole("region", { name: "Источники", exact: true }),
  ).toHaveCount(0);
  await expect(message.locator(".cg-assistant-sources")).toHaveCount(0);
  expect(state.sends).toEqual([]);
  expect(state.consentSaves).toEqual([]);
  noOtherTraffic(state);
});
