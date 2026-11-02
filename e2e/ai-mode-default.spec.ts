import { expect, test } from "@playwright/test";
import { fixture, noOtherTraffic, catalogId } from "./ai-mode-fixture";

test("a fresh Web owner starts at Maximum, sends only explicitly and preserves a later choice through refresh", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  const selector = page.getByLabel("Режим работы", { exact: true });
  await expect(selector).toHaveValue("maximum");
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
  await selector.selectOption("balanced");
  const reads = state.dashboardReads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(reads);
  await expect(selector).toHaveValue("balanced");
  expect(state.sends).toHaveLength(1);
  noOtherTraffic(state);
});

test("initial Maximum requires an explicit confirmation and never grants, sends or falls back on its own", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  await page.goto("/");
  const selector = page.getByLabel("Режим работы", { exact: true });
  await expect(selector).toHaveValue("maximum");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Отправить", exact: true }),
  ).toBeDisabled();
  expect(state.consentReads).toBe(0);
  await page
    .getByRole("button", { name: "Подтвердить выбор", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Новые режимы ответа" });
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(selector).toHaveValue("maximum");
  expect(state.consentSaves).toEqual([]);
  expect(state.sends).toEqual([]);
  await selector.selectOption("balanced");
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
  await expect(page.getByLabel("Режим работы", { exact: true })).toHaveValue(
    "maximum",
  );
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
