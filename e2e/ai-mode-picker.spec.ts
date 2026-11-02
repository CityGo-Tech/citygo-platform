import { expect, test } from "@playwright/test";
import { fixture, noOtherTraffic } from "./ai-mode-fixture";
import {
  modeSelector,
  modePicker,
  openModePicker,
  chooseMode,
} from "./ai-mode-navigation";

test("mode cards match desktop/mobile composition and reveal only useful task descriptions", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context, { minimumPrice: true });
  await page.goto("/");
  const picker = await openModePicker(page);
  await expect(
    picker.getByText("Сложные вопросы и подробный разбор вариантов.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    picker.getByText("Повседневные вопросы и планирование переезда.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    picker.getByText("Простые вопросы и первые шаги.", { exact: true }),
  ).toBeVisible();
  await expect(picker).not.toContainText(
    /RouterAI|OpenAI|DeepSeek|GigaChat|резерв|×10|за запрос|Базовый/,
  );
  const box = await picker.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.width).toBe(viewport.width <= 600 ? viewport.width : 416);
  if (viewport.width <= 600) {
    expect(Math.round(box!.y + box!.height)).toBe(viewport.height);
  }
  for (const name of ["Максимум", "Баланс", "Минимум", "Закрыть"]) {
    const action = picker.getByRole("button", { name, exact: true });
    expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await picker.screenshot({ path: info.outputPath("mode-picker.png") });
  expect(state.sends).toEqual([]);
  expect(state.consentSaves).toEqual([]);
  noOtherTraffic(state);
});

test("keyboard focus stays in the dialog; Escape and backdrop preserve draft, history and the current mode", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  const composer = page.getByLabel("Сообщение помощнику", { exact: true });
  await composer.fill("ЧЕРНОВИК_БЕЗ_ОТПРАВКИ");
  const trigger = modeSelector(page);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const picker = modePicker(page);
  await expect(
    picker.getByRole("button", { name: "Максимум", exact: true }),
  ).toBeFocused();
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press("Tab");
    expect(
      await picker.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
  }
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await picker.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("data-ai-mode", "maximum");
  await openModePicker(page);
  await page.mouse.click(1, 1);
  await expect(picker).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(composer).toHaveValue("ЧЕРНОВИК_БЕЗ_ОТПРАВКИ");
  await expect(
    page.getByRole("log", { name: "История диалога" }),
  ).toContainText("СОХРАНЁННЫЙ_ОТВЕТ");
  expect(state.sends).toEqual([]);
  expect(state.consentReads).toBe(0);
  noOtherTraffic(state);
});

test("card activation changes only the next mode and retains a draft without creating an AI request", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  const composer = page.getByLabel("Сообщение помощнику", { exact: true });
  await composer.fill("ПРОВЕРИТЬ_РЕЖИМ");
  await chooseMode(page, "minimum");
  await expect(modeSelector(page)).toHaveAttribute("data-ai-mode", "minimum");
  await expect(composer).toHaveValue("ПРОВЕРИТЬ_РЕЖИМ");
  const picker = await openModePicker(page);
  const balanced = picker.getByRole("button", { name: "Баланс", exact: true });
  await balanced.focus();
  await page.keyboard.press("Space");
  await expect(picker).not.toBeVisible();
  await expect(modeSelector(page)).toHaveAttribute("data-ai-mode", "balanced");
  await expect(composer).toHaveValue("ПРОВЕРИТЬ_РЕЖИМ");
  expect(state.sends).toEqual([]);
  expect(state.consentSaves).toEqual([]);
  noOtherTraffic(state);
});
