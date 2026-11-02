import { clickAccountAction } from "./navigation-helper";
import {
  modeSelector as selector,
  openModePicker,
  chooseMode,
} from "./ai-mode-navigation";
import { expect, test, type Page } from "@playwright/test";
import {
  fixture,
  noOtherTraffic,
  catalogId,
  policyId,
} from "./ai-mode-fixture";
const composer = (page: Page) =>
  page.getByLabel("Сообщение помощнику", { exact: true });

test("mode switches affect only the next explicit question and remain frozen through stream and history refresh", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context, { minimumPrice: true });
  state.holdStream = true;
  state.holdRefresh = true;
  await page.goto("/");
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "maximum");
  const picker = await openModePicker(page);
  for (const label of ["Минимум", "Максимум", "Баланс"]) {
    await expect(
      picker.getByRole("button", { name: label, exact: true }),
    ).toContainText(label);
  }
  await chooseMode(page, "maximum");
  expect(state.sends).toEqual([]);
  await composer(page).fill("ПЕРВЫЙ_КОНТРОЛЬНЫЙ_ВОПРОС");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(1);
  await expect(selector(page)).toBeDisabled();
  expect(state.sends[0]).toEqual({
    text: "ПЕРВЫЙ_КОНТРОЛЬНЫЙ_ВОПРОС",
    requestId: expect.any(String),
    policyId,
    creditReservationMode: "fixed5_overdraft",
    aiMode: "maximum",
    aiModeCatalogId: catalogId,
  });
  state.releaseStream();
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(1);
  await expect(selector(page)).toBeDisabled();
  state.releaseRefresh();
  await expect(selector(page)).toBeEnabled();
  await expect(
    page.getByRole("log", { name: "История диалога" }),
  ).toContainText("ОТВЕТ_НА_ПЕРВЫЙ_КОНТРОЛЬНЫЙ_ВОПРОС");
  await chooseMode(page, "minimum");
  expect(state.sends).toHaveLength(1);
  await composer(page).fill("ПОСЛЕДНИЙ_КОНТРОЛЬНЫЙ_ВОПРОС");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(selector(page)).toBeEnabled();
  await expect.poll(() => state.sends.length).toBe(2);
  expect(state.sends[1]).toEqual({
    text: "ПОСЛЕДНИЙ_КОНТРОЛЬНЫЙ_ВОПРОС",
    requestId: expect.any(String),
    policyId,
    creditReservationMode: "fixed5_overdraft",
    aiMode: "minimum",
    aiModeCatalogId: catalogId,
  });
  expect(state.sends[1]!.requestId).not.toBe(state.sends[0]!.requestId);
  const log = page.getByRole("log", { name: "История диалога" });
  await expect(log).toContainText("СОХРАНЁННЫЙ_ОТВЕТ");
  await expect(log).toContainText("ОТВЕТ_НА_ПОСЛЕДНИЙ_КОНТРОЛЬНЫЙ_ВОПРОС");
  await expect(page.locator("body")).not.toContainText("PRIVATE_");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await selector(page).screenshot({
    path: info.outputPath("ai-mode-selector.png"),
  });
  noOtherTraffic(state);
});

test("unavailable modes and a failed request never fall back, retry or carry selection to another account", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { minimumAvailable: false });
  state.failNextSend = true;
  await page.goto("/");
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "maximum");
  const picker = await openModePicker(page);
  await expect(
    picker.getByRole("button", { name: "Минимум", exact: true }),
  ).toBeDisabled();
  await expect(
    picker.getByRole("button", { name: "Минимум", exact: true }),
  ).not.toContainText("за запрос");
  await chooseMode(page, "maximum");
  await composer(page).fill("СОХРАНИТЬ_ПРИ_ОШИБКЕ");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(composer(page)).toHaveValue("СОХРАНИТЬ_ПРИ_ОШИБКЕ");
  await expect(selector(page)).toBeEnabled();
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "maximum");
  expect(state.sends).toHaveLength(1);
  expect(state.sends[0]!.aiMode).toBe("maximum");
  await clickAccountAction(page, "Выйти");
  await page
    .getByRole("dialog", { name: "Выйти из аккаунта?", exact: true })
    .getByRole("button", { name: "Выйти", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Уже есть аккаунт? Войти", exact: true })
    .click();
  await page
    .getByLabel("Логин или электронная почта", { exact: true })
    .fill("second@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill("abcdef");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "maximum");
  await expect(composer(page)).toHaveValue("");
  expect(state.sends).toHaveLength(1);
  noOtherTraffic(state);
});

test("a legacy dashboard does not advertise modes or add an unsupported mode to its stream", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { legacy: true });
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  await expect(selector(page)).toHaveCount(0);
  await composer(page).fill("ВОПРОС_СТАРОМУ_СЕРВЕРУ");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(1);
  await expect(composer(page)).toBeEnabled();
  expect(state.sends[0]).toEqual({
    text: "ВОПРОС_СТАРОМУ_СЕРВЕРУ",
    requestId: expect.any(String),
    policyId,
    creditReservationMode: "fixed5_overdraft",
  });
  await expect(selector(page)).toHaveCount(0);
  noOtherTraffic(state);
});

test("legacy Balance keeps the chat; a cancelled first new-mode choice preserves draft, history and balance", async ({
  page,
  context,
}, testInfo) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  await page.goto("/");
  await chooseMode(page, "balanced");
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "balanced");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.consentReads).toBe(0);
  await composer(page).fill("ЧЕРНОВИК_БЕЗ_ОТПРАВКИ");
  await chooseMode(page, "maximum");
  const dialog = page.getByRole("dialog", { name: "Новые режимы ответа" });
  await expect(dialog).toBeVisible();
  const checkbox = dialog.getByRole("checkbox");
  await expect(checkbox).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Подтвердить и выбрать" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("link", { name: "Условия обработки персональных данных" }),
  ).toHaveAttribute("href", "/legal/personal-data-consent");
  await expect(
    dialog.getByText(/Полные условия новых режимов/),
  ).not.toBeVisible();
  await dialog.screenshot({
    path: testInfo.outputPath("new-mode-consent.png"),
  });
  await dialog.getByText("Прочитать условия здесь", { exact: true }).click();
  await expect(dialog.getByText(/Полные условия новых режимов/)).toBeVisible();
  await expect(dialog).not.toContainText("рекламу");
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "balanced");
  await expect(composer(page)).toHaveValue("ЧЕРНОВИК_БЕЗ_ОТПРАВКИ");
  await expect(
    page
      .getByLabel("Баланс и телефон", { exact: true })
      .getByRole("button", { name: "Баланс и пополнение", exact: true }),
  ).toHaveText("100 ₽");
  await expect(
    page.getByRole("log", { name: "История диалога" }),
  ).toContainText("СОХРАНЁННЫЙ_ОТВЕТ");
  expect(state.sends).toEqual([]);
  expect(state.consentSaves).toEqual([]);
  expect(state.consentOwners.size).toBe(0);
  noOtherTraffic(state);
});

test("current registration consent allows every mode without an extra dialog", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  state.consentOwners.add("101");
  await page.goto("/");
  await chooseMode(page, "balanced");
  await expect(composer(page)).toBeVisible();
  await chooseMode(page, "maximum");
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "maximum");
  await chooseMode(page, "minimum");
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "minimum");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.consentReads).toBe(0);
  expect(state.consentSaves).toEqual([]);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});

test("first explicit new-mode consent selects only after persistence and dashboard refresh; later choices need no extra checkbox", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  await page.goto("/");
  await chooseMode(page, "balanced");
  await composer(page).fill("СОХРАНИТЬ_ЧЕРНОВИК");
  await chooseMode(page, "maximum");
  const dialog = page.getByRole("dialog", { name: "Новые режимы ответа" });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Подтвердить и выбрать" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "maximum");
  await expect(composer(page)).toHaveValue("СОХРАНИТЬ_ЧЕРНОВИК");
  expect(state.consentSaves).toHaveLength(1);
  expect(state.consentOwners.has("101")).toBe(true);
  expect(state.dashboardReads).toBeGreaterThanOrEqual(3);
  await chooseMode(page, "minimum");
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "minimum");
  await expect(dialog).toHaveCount(0);
  expect(state.consentReads).toBe(1);
  expect(state.consentSaves).toHaveLength(1);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});

test("a failed consent fetch leaves the old mode and draft intact; retry starts with an unchecked choice", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  state.failConsentRead = true;
  await page.goto("/");
  await chooseMode(page, "balanced");
  await composer(page).fill("НЕ_ТЕРЯТЬ_ТЕКСТ");
  await chooseMode(page, "minimum");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(state.consentSaves).toEqual([]);
  await dialog.getByRole("button", { name: "Загрузить условия" }).click();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "balanced");
  await expect(composer(page)).toHaveValue("НЕ_ТЕРЯТЬ_ТЕКСТ");
  expect(state.consentReads).toBe(2);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});

test("cancelled late loads cannot reopen or replace a later mode choice", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  state.holdConsentRead = true;
  await page.goto("/");
  await chooseMode(page, "balanced");
  await chooseMode(page, "maximum");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toBeVisible();
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await chooseMode(page, "minimum");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  state.releaseConsentRead();
  await expect(dialog).toContainText("«Минимум»");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "balanced");
  expect(state.consentSaves).toEqual([]);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});

test("an account switch during consent persistence cannot select a mode for the new account", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  state.holdConsentSave = true;
  await page.goto("/");
  await chooseMode(page, "balanced");
  await chooseMode(page, "maximum");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Подтвердить и выбрать" }).click();
  await expect.poll(() => state.consentSaves.length).toBe(1);
  state.owner = "202";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog).toHaveCount(0);
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "maximum");
  state.releaseConsentSave();
  await expect(composer(page)).toHaveValue("");
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "maximum");
  expect(state.consentOwners.has("202")).toBe(false);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});

test("cancelling after persistence but before dashboard refresh never selects the pending mode", async ({
  page,
  context,
}) => {
  const state = await fixture(context, { firstChoiceConsent: true });
  state.holdConsentRefresh = true;
  await page.goto("/");
  await chooseMode(page, "balanced");
  await composer(page).fill("ОСТАВИТЬ_ЧЕРНОВИК");
  await chooseMode(page, "maximum");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Подтвердить и выбрать" }).click();
  await expect.poll(() => state.dashboardReads).toBeGreaterThanOrEqual(3);
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  state.releaseRefresh();
  await expect(dialog).toHaveCount(0);
  await expect(selector(page)).toHaveAttribute("data-ai-mode", "balanced");
  await expect(composer(page)).toHaveValue("ОСТАВИТЬ_ЧЕРНОВИК");
  expect(state.consentSaves).toHaveLength(1);
  expect(state.sends).toEqual([]);
  noOtherTraffic(state);
});
